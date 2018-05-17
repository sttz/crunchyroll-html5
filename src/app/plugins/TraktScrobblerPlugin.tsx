import { IMedia } from "crunchyroll-lib/models/IMedia";
import { IMediaMetadata } from "crunchyroll-lib/models/IMediaMetadata";
import { inject, injectable } from "inversify";
import { h, render } from 'preact';
import * as parseUrl from 'url-parse';
import { EventHandler } from "../libs/events/EventHandler";
import { IPlayerApi, PlaybackState, PlaybackStateChangeEvent } from "../media/player/IPlayerApi";
import { importCSS } from '../utils/css';
import { IPlugin } from "./IPlugin";
import TraktApi, { AuthenticationChangeEvent, ITraktApiOptions, ITraktScrobbleData, ITraktError, ITraktMovie, ITraktShow, ITraktEpisode } from './TraktApi';
import { IResponse } from "crunchyroll-lib/models/http/IResponse";
import TraktScrobble, { TraktScrobbleStateChangeEvent, TraktScrobbleState } from "./TraktScrobble";

const packageInfo = require('../../../package.json');
const css = require('./TraktScrobblerPlugin.scss');

const EpisodeRegex = /Episode (\d+)/;
const SeasonRegex = /Season (\d+)/;

export interface ITraktOptions extends ITraktApiOptions {
  //
}

export const ITraktOptionsSymbols = Symbol.for("ITraktOptions");

@injectable()
export default class TraktScrobblerPlugin implements IPlugin {
  private _handler: EventHandler = new EventHandler(this);

  private _client: TraktApi;
  private _scrobble?: TraktScrobble;

  private _media?: IMedia;
  private _api?: IPlayerApi;

  private _connectButton: Element;
  private _statusButton: Element;

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

    this._scrobble = new TraktScrobble(this._client, media.getId(), this._getScrobbleData(media, api));

    this._handler
      .listen(api, 'playbackstatechange', this._onPlaybackStateChange, false)
      .listen(this._scrobble, 'traktscrobblestatechange', this._onScrobbleStatusChanged, false);

    if (this._statusButton == null) {
      let container = document.querySelector('.chrome-controls__right');
      if (container) {
        this._statusButton = render((
          <button class="chrome-button chrome-trakt-button" onClick={ () => this._onStatusButtonClick() }>
            <div class="trakt-icon"/>
          </button>
        ), container);
        this._statusButton.remove();
        container.insertBefore(this._statusButton, container.firstChild);
        this._updateStatusButton();
      }
    }
  }

  unload(): void {
    if (this._scrobble && this._api) {
      this._scrobble.setPlaybackState(PlaybackState.ENDED, this._getProgress(this._api));
    }

    this._media = undefined;
    this._api = undefined;
    this._scrobble = undefined;

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
      this._connectButton = render(
        (<div class="footer-column">
          <div class="trakt-connect-button" onClick={ onclick }>
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
    if (!this._connectButton) return;
    this._connectButton.getElementsByClassName('text')[0].textContent = !this._client.isAuthenticated() ? 'Connect with Trakt' : 'Disconnect from Trakt';
  }

  private _updateStatusButton(): void {
    if (!this._statusButton) return;

    let classList = this._statusButton.classList;
    let toRemove = [];
    for (let i = 0; i < classList.length; i++) {
      let item = classList.item(i)!;
      if (item.startsWith('state-')) toRemove.push(item);
    }
    classList.remove(...toRemove);

    if (!this._scrobble) {
      classList.add('state-error');
      this._statusButton.setAttribute('title', 'No scrobbler instance');
    } else {
      classList.add('state-' + TraktScrobbleState[this._scrobble.state].toLowerCase());
      this._statusButton.setAttribute('title', this._scrobble.error || TraktScrobbleState[this._scrobble.state]);
    }
  }

  private _onScrobbleStatusChanged(e: TraktScrobbleStateChangeEvent): void {
    this._updateStatusButton();
  }

  private _onStatusButtonClick(): void {
    if (!this._scrobble) return;
    window.open(this._scrobble.scrobbleUrl(), '_blank');
  }

  // ------ Scrobbling ------

  private async _onPlaybackStateChange(e: PlaybackStateChangeEvent): Promise<void> {
    if (!this._scrobble || !this._api) return;
    this._scrobble.setPlaybackState(e.state, this._getProgress(this._api));
  }

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
}



