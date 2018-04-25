import { IMedia } from "crunchyroll-lib/models/IMedia";
import { IMediaMetadata } from "crunchyroll-lib/models/IMediaMetadata";
import { inject, injectable } from "inversify";
import { h, render } from 'preact';
import * as parseUrl from 'url-parse';
import { EventHandler } from "../libs/events/EventHandler";
import { IPlayerApi, PlaybackState, PlaybackStateChangeEvent } from "../media/player/IPlayerApi";
import { importCSS } from '../utils/css';
import { IPlugin } from "./IPlugin";
import TraktApi, { AuthenticationChangeEvent, ITraktApiOptions, ITraktScrobbleData } from './TraktApi';

const packageInfo = require('../../../package.json');
const css = require('./TraktScrobblerPlugin.scss');

const EpisodeRegex = /Episode (\d+)/;
const SeasonRegex = /Season (\d+)/;

enum ScrobbleState {
  Idle,
  Started,
  Paused,
  Scrobbled,
  Error
}

export interface ITraktOptions extends ITraktApiOptions {
  //
}

export const ITraktOptionsSymbols = Symbol.for("ITraktOptions");

@injectable()
export default class TraktScrobblerPlugin implements IPlugin {
  private _handler: EventHandler = new EventHandler(this);

  private _client: TraktApi;

  private _media?: IMedia;
  private _api?: IPlayerApi;

  private _traktButton: Element;
  private _statusIcon: Element;
  private _state: ScrobbleState = ScrobbleState.Idle;

  constructor(@inject(ITraktOptionsSymbols) options: ITraktOptions) {
    this._client = new TraktApi(options);
    this._handler
      .listen(this._client, 'authenticationchange', this._onAuthenticationChange, false);
  }

  private _onAuthenticationChange(e: AuthenticationChangeEvent) {
    if (!e.isAuthenticated) {
      this._client.checkAuthenticationResult(window.location.href);
    }
    this._updateButton();
  }

  // ------ IPlugin ------

  bootstrap(url: string, mediaId: number | undefined): void {
    if (parseUrl(url).hostname.endsWith('crunchyroll.com')) {
      this._bootstrap(url);
    }
  }

  load(media: IMedia, api: IPlayerApi): void {
    if (!this._client.isAuthenticated()) return;

    this._media = media;
    this._api = api;

    this._handler
      .listen(api, 'playbackstatechange', this._onPlaybackStateChange, false);
    
    if (this._statusIcon == null) {
      let player = document.querySelector('.html5-video-player');
      if (player) {
        this._statusIcon = render((
          <div class="html5-video-chrome-trakt">
            <div class="trakt-icon"></div>
            <div class="text"></div>
          </div>
        ), player);
        this._updateStatusIcon();
      }
    }
  }

  unload(): void {
    this._media = undefined;
    this._api = undefined;

    this._handler.removeAll();
  }

  // ------ UI ------

  private async _bootstrap(url: string): Promise<void> {
    importCSS(css);

    let footer = document.querySelector('#social_media');
    if (footer) {
      let onclick = () => {
        if (this._client.isAuthenticated()) {
          this._client.disconnect();
        } else {
          this._client.authenticate();
        }
      };
      this._traktButton = render(
        (<div class="footer-column">
          <div id="trakt-button" onClick={ onclick }>
            <div class="trakt-icon"></div>
            <div class="text"></div>
          </div>
        </div>),
        footer
      );
      this._updateButton();
    }
  }

  private _updateButton(): void {
    if (!this._traktButton) return;
    this._traktButton.getElementsByClassName('text')[0].textContent = !this._client.isAuthenticated() ? 'Connect with Trakt' : 'Disconnect from Trakt';
  }

  private _updateStatusIcon(text?: string): void {
    if (!this._statusIcon) return;
    this._statusIcon.getElementsByClassName('text')[0].textContent = text || ScrobbleState[this._state];
  }

  // ------ Scrobbling ------

  private _isMovie(metadata: IMediaMetadata): boolean {
    return metadata.getEpisodeTitle().toLowerCase().includes('movie');
  }

  private _getProgress(api: IPlayerApi): number {
    const duration = api.getDuration();
    if (duration == 0)
      return 0;
    
    return api.getCurrentTime() / duration * 100;
  }

  private _getScrobbleData(media: IMedia, api: IPlayerApi): ITraktScrobbleData {
    const data: ITraktScrobbleData = {
      progress: this._getProgress(api),
      app_version: packageInfo.version,
      app_date: '2018-01-01'
    };
    
    const metadata = media.getMetadata();

    let showTitle = metadata.getSeriesTitle();
    const titleElement = document.querySelector('#showmedia_about_episode_num a');
    if (titleElement && titleElement.textContent) {
      showTitle = titleElement.textContent;
    }

    let seasonNumber = 1;
    let episodeNumber = parseInt(metadata.getEpisodeNumber());
    const episodeElement = document.querySelector('#showmedia_about_media h4:nth-child(2)');
    if (episodeElement && episodeElement.textContent) {
      const seasonMatch = SeasonRegex.exec(episodeElement.textContent);
      if (seasonMatch) {
        seasonNumber = parseInt(seasonMatch[1]);
      }
      
      const episodeMatch = EpisodeRegex.exec(episodeElement.textContent);
      if (episodeMatch) {
        episodeNumber = parseInt(episodeMatch[1]);
      }
    }

    if (this._isMovie(metadata)) {
      data.movie = {
        title: showTitle
      };
    } else {
      data.show = {
        title: showTitle
      };
      data.episode = {
        season: seasonNumber,
        number: episodeNumber,
        title: metadata.getEpisodeTitle()
      };
    }

    return data;
  }

  private async _onPlaybackStateChange(e: PlaybackStateChangeEvent): Promise<void> {
    if (this._state === ScrobbleState.Error || this._state === ScrobbleState.Scrobbled) return;

    let type = null;
    if (e.state === PlaybackState.PLAYING && this._state !== ScrobbleState.Started) {
      type = 'start';
    } else if (e.state === PlaybackState.PAUSED && this._state !== ScrobbleState.Paused) {
      type = 'pause';
    } else if (e.state === PlaybackState.ENDED) {
      type = 'stop';
    }

    if (!type) return;

    const data = this._getScrobbleData(this._media!, this._api!);
    const response = await this._client.scrobble(type, data);
    if (TraktApi.isError(response)) {
      if (response.status === 409) {
        // Item was just scrobbled
        this._state = ScrobbleState.Scrobbled;
        this._updateStatusIcon();
      } else if (response.status === 404) {
        this._state = ScrobbleState.Error;
        this._updateStatusIcon('Not Found');
      } else {
        this._state = ScrobbleState.Error;
        this._updateStatusIcon();
        console.error('Scrobbling failed with error: ' + response.error);
      }
    } else {
      switch (response.action) {
        case 'start':
          this._state = ScrobbleState.Started;
          break;
        case 'pause':
          this._state = ScrobbleState.Paused;
          break;
        case 'scrobble':
          this._state = ScrobbleState.Scrobbled;
          break;
        default:
          console.error('Default or missing action in scrobble response: ' + response.action);
          break;
      }
      this._updateStatusIcon();
    }
  }
}



