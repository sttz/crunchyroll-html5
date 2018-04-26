import { IMedia } from "crunchyroll-lib/models/IMedia";
import { IMediaMetadata } from "crunchyroll-lib/models/IMediaMetadata";
import { inject, injectable } from "inversify";
import { h, render } from 'preact';
import * as parseUrl from 'url-parse';
import { EventHandler } from "../libs/events/EventHandler";
import { IPlayerApi, PlaybackState, PlaybackStateChangeEvent } from "../media/player/IPlayerApi";
import { importCSS } from '../utils/css';
import { IPlugin } from "./IPlugin";
import TraktApi, { AuthenticationChangeEvent, ITraktApiOptions, ITraktScrobbleData, ITraktError, ITraktMovie, ITraktShow } from './TraktApi';
import { IResponse } from "crunchyroll-lib/models/http/IResponse";

const packageInfo = require('../../../package.json');
const css = require('./TraktScrobblerPlugin.scss');

const EpisodeRegex = /Episode (\d+)/;
const SeasonRegex = /Season (\d+)/;

enum ScrobbleState {
  Idle,
  Loading,
  Started,
  Paused,
  Scrobbled,
  NotFound,
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

  private _connectButton: Element;
  private _statusButton: Element;
  private _state: ScrobbleState = ScrobbleState.Idle;
  private _error?: string;
  private _data?: ITraktScrobbleData;

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

  private get scrobbleState(): ScrobbleState {
    return this._state;
  }

  private set scrobbleState(value: ScrobbleState) {
    this._state = value;
    this._updateStatusButton();
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
    this._media = undefined;
    this._api = undefined;

    this._handler.removeAll();

    this.scrobbleState = ScrobbleState.Idle;
    this._data = undefined;
    this._error = undefined;
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
    classList.add('state-' + ScrobbleState[this.scrobbleState].toLowerCase());

    this._statusButton.setAttribute('title', this._error || ScrobbleState[this.scrobbleState]);
  }

  private _onStatusButtonClick(): void {
    if (!this._data) return;

    let url = 'https://trakt.tv/';
    if (this._data.movie !== undefined) {
      url += `movies/${this._data.movie.ids!.slug}`;
    } else if (this._data.show !== undefined && this._data.episode !== undefined) {
      const show = this._data.show;
      const episode = this._data.episode;
      url += `shows/${show.ids!.slug}/seasons/${episode.season}/episodes/${episode.number}`;
    } else {
      return;
    }

    window.open(url, '_blank');
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
    this._scrobble(e.state);
  }

  private _handleApiError(response: ITraktError): void {
    console.error(`trakt scrobbler: ${response.error}`);
    this._error = response.error;
    this.scrobbleState = ScrobbleState.Error;
  }

  private async _scrobble(playbackState: PlaybackState): Promise<void> {
    if (this.scrobbleState === ScrobbleState.Error 
        || this.scrobbleState === ScrobbleState.NotFound
        || this.scrobbleState === ScrobbleState.Scrobbled
        || this.scrobbleState === ScrobbleState.Loading)
      return;

    if (this.scrobbleState === ScrobbleState.Idle) {
      await this._startScrobble(playbackState);
    } else {
      await this._updateScrobble(playbackState);
    }
  }

  private async _startScrobble(playbackState: PlaybackState): Promise<void> {
    if (playbackState !== PlaybackState.PLAYING)
      return;

    this.scrobbleState = ScrobbleState.Loading;

    // Try to do automatic episode matching
    this._data = this._getScrobbleData(this._media!, this._api!);
    let scrobbleResponse = await this._client.scrobble('start', this._data);
    if (!TraktApi.isError(scrobbleResponse)) {
      this.scrobbleState = ScrobbleState.Started;
      if (scrobbleResponse.movie !== undefined) this._data.movie = scrobbleResponse.movie;
      if (scrobbleResponse.show !== undefined) this._data.show = scrobbleResponse.show;
      if (scrobbleResponse.episode !== undefined) this._data.episode = scrobbleResponse.episode;
      return;
    } else if (scrobbleResponse.status !== 404) {
      this._handleApiError(scrobbleResponse);
      return;
    }

    // Fall back to a manual lookup
    let type, title;
    if (this._data.movie !== undefined) {
      type = 'movie';
      title = this._data.movie.title;
    } else {
      type = 'show';
      title = this._data.show!.title;
    }
    if (!title) {
      console.error('trakt scrobbler: No title set');
      return;
    }
    const searchResponse = await this._client.search(type, title);
    if (TraktApi.isError(searchResponse)) {
      this._handleApiError(searchResponse);
      return;
    }

    let continueWith: ITraktMovie | ITraktShow | undefined;
    const perfectMatches = searchResponse.filter(r => r.score === 1000);
    if (perfectMatches.length === 1) {
      continueWith = perfectMatches[0].movie || perfectMatches[0].show;
    } else {
      console.error('trakt scrobbler: manual lookup produced ambiguous result', searchResponse);
      this.scrobbleState = ScrobbleState.NotFound;
      return;
    }

    if (type === 'movie') {
      // Found movie!
      this._data.movie! = continueWith as ITraktMovie;
    } else {
      // Found show, now searching episode...
      this._data.show = continueWith as ITraktShow;

      const showId = this._data.show!.ids!.trakt!;
      const seasonResponse = await this._client.season(showId, this._data.episode!.season!, true);
      if (TraktApi.isError(seasonResponse)) {
        if (seasonResponse.status === 404) {
          console.error('trakt scrobbler: manual lookup could not find season');
          this.scrobbleState = ScrobbleState.NotFound;
        } else {
          this._handleApiError(seasonResponse);
        }
        return;
      }

      const episodeNumber = this._data.episode!.number!;
      let numberMatch = seasonResponse.filter(e => e.number === episodeNumber);
      if (numberMatch.length > 1) {
        console.error(`trakt scrobbler: got multiple episode #${episodeNumber} in season`, seasonResponse);
        this.scrobbleState = ScrobbleState.Error;
        return;
      } else if (numberMatch.length === 1) {
        // Found episode!
        this._data.episode = numberMatch[0];
      } else {
        numberMatch = seasonResponse.filter(e => e.number_abs === episodeNumber);
        if (numberMatch.length > 1) {
          console.error(`trakt scrobbler: got multiple episode #${episodeNumber} (abs) in season`, seasonResponse);
          this.scrobbleState = ScrobbleState.Error;
          return;
        } else if (numberMatch.length === 1) {
          // Found episode!
          this._data.episode = numberMatch[0];
        } else {
          console.error(`trakt scrobbler: episode not found in season`, seasonResponse);
          this.scrobbleState = ScrobbleState.NotFound;
          return;
        }
      }
    }

    // Retry scrobble
    scrobbleResponse = await this._client.scrobble('start', this._data);
    if (!TraktApi.isError(scrobbleResponse)) {
      this.scrobbleState = ScrobbleState.Started;
    } else if (scrobbleResponse.status === 404) {
      console.error(`trakt scrobbler: ${type} not found even with manual lookup`, this._data);
      this.scrobbleState = ScrobbleState.NotFound;
    } else {
      this._handleApiError(scrobbleResponse);
    }
  }

  private async _updateScrobble(playbackState: PlaybackState): Promise<void> {
    if (!this._data) {
      throw new Error('trakt scrobbler: Scrobble data not set.');
    }

    let action;
    if (playbackState === PlaybackState.PAUSED) {
      if (this.scrobbleState !== ScrobbleState.Paused)
        action = 'pause';
    } else if (playbackState === PlaybackState.PLAYING) {
      if (this.scrobbleState !== ScrobbleState.Started)
        action = 'start';
    } else if (playbackState === PlaybackState.ENDED) {
      action = 'stop';
    }
    if (!action) return;

    const response = await this._client.scrobble(action, this._data);
    if (TraktApi.isError(response)) {
      if (response.status === 409) {
        // Item was just scrobbled
        this.scrobbleState = ScrobbleState.Scrobbled;
      } else {
        this._handleApiError(response);
      }
    } else {
      if (response.action === 'start') {
        this.scrobbleState = ScrobbleState.Started;
      } else if (response.action === 'pause') {
        this.scrobbleState = ScrobbleState.Paused;
      } else if (response.action === 'scrobble') {
        this.scrobbleState = ScrobbleState.Scrobbled;
      } else {
        console.error(`trakt scrobbler: Unknown scrobble action "${response.action}"`);
        this.scrobbleState = ScrobbleState.Error;
      }
    }
  }
}



