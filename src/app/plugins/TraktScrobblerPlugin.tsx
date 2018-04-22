import libContainer from 'crunchyroll-lib/config';
import { IMedia } from "crunchyroll-lib/models/IMedia";
import { IMediaMetadata } from "crunchyroll-lib/models/IMediaMetadata";
import { IHttpClient } from 'crunchyroll-lib/models/http/IHttpClient';
import { inject, injectable } from "inversify";
import * as parseUrl from 'url-parse';
import container from "../../config/inversify.config";
import { EventHandler } from "../libs/events/EventHandler";
import { IPlayerApi, PlaybackState, PlaybackStateChangeEvent } from "../media/player/IPlayerApi";
import { IStorage, IStorageSymbol } from '../storage/IStorage';
import { IPlugin } from "./IPlugin";
import { importCSS } from '../utils/css';
import { h, render } from 'preact';

const packageInfo = require('../../../package.json');
const css = require('./TraktScrobblerPlugin.scss');

const EpisodeRegex = /Episode (\d+)/;
const SeasonRegex = /Season (\d+)/;

const TraktTokensKey: string = 'trakt_tokens';

interface IQueryAuthenticationResult {
  code?: string;
  state?: string;
}

interface ITraktScrobbleData {
  movie?: {
    title: string;
  };
  show?: {
    title: string;
  };
  episode?: {
    season: number;
    number: number;
    tilte: string;
  };
  progress: number;
  app_version: string;
  app_date: string;
}

interface ITraktTokens {
  refresh_token?: string;
  access_token?: string;
  expires?: number;
  authentication_state?: string;
}

enum ScrobbleState {
  Idle,
  Started,
  Paused,
  Scrobbled,
  Error
}

export interface ITraktOptions {
  client_id: string;
  client_secret: string;
  api_url?: string;
}

export const ITraktOptionsSymbols = Symbol.for("ITraktOptions");

@injectable()
export default class TraktScrobblerPlugin implements IPlugin {
  private _handler: EventHandler = new EventHandler(this);

  private _media?: IMedia;
  private _api?: IPlayerApi;
  private _http: IHttpClient;
  private _storage: IStorage;

  private _traktButton: Element;
  private _statusIcon: Element;
  private _tokens: ITraktTokens = {};
  private _state: ScrobbleState = ScrobbleState.Idle;

  private _client_id: string;
  private _client_secret: string;
  private _redirect_uri: string;
  private _endpoint: string;

  constructor(@inject(ITraktOptionsSymbols) options: ITraktOptions) {
    this._client_id = options.client_id;
    this._client_secret = options.client_secret;
    this._redirect_uri = 'https://www.crunchyroll.com';
    this._endpoint = options.api_url || 'https://api.trakt.tv';

    this._http = libContainer.get<IHttpClient>("IHttpClient");
    this._storage = container.get<IStorage>(IStorageSymbol);
  }

  // ------ IPlugin ------

  bootstrap(url: string, mediaId: number | undefined): void {
    if (parseUrl(url).hostname.endsWith('crunchyroll.com')) {
      this._bootstrap(url);
    }
  }

  load(media: IMedia, api: IPlayerApi): void {
    if (!this._isAuthenticated()) return;

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

  private async _bootstrap(url: string): Promise<void> {
    importCSS(css);

    const authenticated = await this._loadTokens();
    if (authenticated) {
      console.log('Loaded saved trakt token.');
    } else {
      this._checkAuthenticationResult(url);
    }

    let footer = document.querySelector('#social_media');
    if (footer) {
      let onclick = () => {
        if (this._isAuthenticated()) {
          this._disconnect();
        } else {
          this._authenticate();
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
    this._traktButton.getElementsByClassName('text')[0].textContent = !this._isAuthenticated() ? 'Connect with Trakt' : 'Disconnect from Trakt';
  }

  private _updateStatusIcon(text?: string): void {
    if (!this._statusIcon) return;
    this._statusIcon.getElementsByClassName('text')[0].textContent = text || ScrobbleState[this._state];
  }

  // ------ Authentication ------

  private async _loadTokens(): Promise<boolean> {
    this._tokens = await this._storage.get<ITraktTokens>(TraktTokensKey) || {};

    if (this._tokens.expires && this._tokens.expires < Date.now()) {
      this._tokens = await this._refresh_token();
      await this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);
    }

    return this._isAuthenticated();
  }

  private _isAuthenticated(): boolean {
    return this._tokens.access_token !== undefined;
  }

  private async _authenticate(): Promise<void> {
    const state = this._generate_state();
    const url = this._get_url(state);

    // Save authentication state data
    this._tokens.authentication_state = state;
    await this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);

    window.location.href = url;
  }

  private async _checkAuthenticationResult(url: string): Promise<void> {
    const query = parseUrl(url, true).query as IQueryAuthenticationResult;
    if (!query.code || !query.state) return;

    if (!await this._exchange_code(query.code, query.state)) {
      console.error('Exchanging oauth code failed!');
      return;
    }

    console.log('Trakt authentication successful!');

    this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);

    window.history.replaceState(null, undefined, window.location.pathname);
    this._updateButton();
  }

  private _disconnect(): void {
    this._storage.set<ITraktTokens>(TraktTokensKey, {});
    this._updateButton();
    this._revoke_token();
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
        tilte: metadata.getEpisodeTitle()
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
    const response = await this._scrobble(type, data);
    if (response.error) {
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

  // ------ API ------

  private async _exchange(body: object): Promise<ITraktTokens> {
    try {
      const response = await this._http.post(
        `${this._endpoint}/oauth/token`, 
        JSON.stringify(body), 
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      const data = JSON.parse(response.body);
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires: (data.created_at + data.expires_in) * 1000
      };
    } catch (error) {
      console.error(error);
      return {};
    }
  }

  private _generate_state(): string {
    let data = new Uint32Array(4);
    crypto.getRandomValues(data);
    let state = '';
    for (let i = 0; i < data.length; i++) {
      state += data[i].toString(16);
    }
    return state;
  }

  private _get_url(state: string): string {
     // Replace 'api' from the api_url to get the top level trakt domain
     const base_url = this._endpoint.replace(/api\W/, '');
     return `${base_url}/oauth/authorize?response_type=code&client_id=${this._client_id}&redirect_uri=${this._redirect_uri}&state=${state}`;
  }

  private async _exchange_code(code: string, state: string): Promise<boolean> {
    if (state !== this._tokens.authentication_state) {
      console.error('Invalid CSRF (State)');
      return false;
    }

    this._tokens = await this._exchange({
      code: code,
      client_id: this._client_id,
      client_secret: this._client_secret,
      redirect_uri: this._redirect_uri,
      grant_type: 'authorization_code'
    });
    return this._isAuthenticated();
  }

  private async _refresh_token(): Promise<ITraktTokens> {
    if (!this._tokens.refresh_token)
      return {};

    return await this._exchange({
      refresh_token: this._tokens.refresh_token,
      client_id: this._client_id,
      client_secret: this._client_secret,
      redirect_uri: this._redirect_uri,
      grant_type: 'refresh_token'
    });
  }

  private _trakt_headers(contentType?: string): { [key: string]: string } {
    return {
      'Content-Type': contentType || 'application/json',
      'Authorization' : `Bearer ${this._tokens.access_token}`,
      'trakt-api-version': '2',
      'trakt-api-key': this._client_id
    };
  }

  private async _revoke_token(): Promise<void> {
    if (!this._tokens.access_token) return;

    await this._http.post(
      `${this._endpoint}/oauth/revoke`, 
      { token: this._tokens.access_token }, 
      { headers: this._trakt_headers('application/x-www-form-urlencoded') }
    );
  }

  private async _scrobble(type: string, data: ITraktScrobbleData): Promise<any> {
    if (!this._tokens.access_token) {
      throw new Error('Acess token required.');
    }

    try {
      const response = await this._http.post(
        `${this._endpoint}/scrobble/${type}`, 
        JSON.stringify(data), 
        { headers: this._trakt_headers() }
      );

      return JSON.parse(response.body);
    } catch (error) {
      if (error.status) {
        return { error: `Server returned status: ${error.status}`, status: error.status };
      } else {
        return { error: `Unknown communication error` }
      }
    }
  }
}



