import libContainer from 'crunchyroll-lib/config';
import { IHttpClient } from "crunchyroll-lib/models/http/IHttpClient";
import { IResponse } from "crunchyroll-lib/models/http/IResponse";
import * as parseUrl from 'url-parse';
import container from "../../config/inversify.config";
import { Event } from '../libs/events/Event';
import { EventTarget } from '../libs/events/EventTarget';
import { IStorage, IStorageSymbol } from "../storage/IStorage";

const TraktTokensKey: string = 'trakt_tokens';

export interface ITraktIDs {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

export interface ITraktMovie {
  title?: string;
  year?: number;
  ids?: ITraktIDs;
}

export interface ITraktShow {
  title?: string;
  year?: number;
  ids?: ITraktIDs;
}

export interface ITraktSeason {
  number?: number;
  ids?: ITraktIDs;
  episodes?: Array<ITraktEpisode>;
}

export interface ITraktEpisode {
  season?: number;
  number?: number;
  title?: string;
  number_abs?: number;
  ids?: ITraktIDs;
}

export interface ITraktSearchResult {
  type: 'movie' | 'show' | 'episode' | 'person' | 'list';
  score: number;
  movie?: ITraktMovie;
  show?: ITraktShow;
  episode?: ITraktEpisode;
}

export interface ITraktScrobbleData {
  movie?: ITraktMovie;
  show?: ITraktShow;
  episode?: ITraktEpisode;
  progress: number;
  app_version: string;
  app_date: string;
}

export interface ITraktScobbleResult {
  id: number;
  action: 'start' | 'pause' | 'scrobble';
  movie?: ITraktMovie;
  show?: ITraktShow;
  episode?: ITraktEpisode;
}

export class AuthenticationChangeEvent extends Event {
  constructor(public isAuthenticated: boolean) {
    super('authenticationchange');
  }
}

export interface ITraktError {
  status: number;
  error: string;
}

const TraktErrorCodes: { [key: number]: ITraktError } = {
  200: { "status": 200, "error": "Success" },
  201: { "status": 201, "error": "Success - new resource created (POST)" },
  204: { "status": 204, "error": "Success - no content to return (DELETE)" },
  400: { "status": 400, "error": "Bad Request - request couldn't be parsed" },
  401: { "status": 401, "error": "Unauthorized - OAuth must be provided" },
  403: { "status": 403, "error": "Forbidden - invalid API key or unapproved app" },
  404: { "status": 404, "error": "Not Found - method exists, but no record found" },
  405: { "status": 405, "error": "Method Not Found - method doesn't exist" },
  409: { "status": 409, "error": "Conflict - resource already created" },
  412: { "status": 412, "error": "Precondition Failed - use application/json content type" },
  422: { "status": 422, "error": "Unprocessible Entity - validation errors" },
  429: { "status": 429, "error": "Rate Limit Exceeded" },
  500: { "status": 500, "error": "Server Error - please open a support issue" },
  503: { "status": 503, "error": "Service Unavailable - server overloaded (try again in 30s)" },
  504: { "status": 504, "error": "Service Unavailable - server overloaded (try again in 30s)" },
  520: { "status": 520, "error": "Service Unavailable - Cloudflare error" },
  521: { "status": 521, "error": "Service Unavailable - Cloudflare error" },
  522: { "status": 522, "error": "Service Unavailable - Cloudflare error" }
};

interface IQueryAuthenticationResult {
  code?: string;
  state?: string;
}

interface ITraktTokens {
  refresh_token?: string;
  access_token?: string;
  expires?: number;
  authentication_state?: string;
}

export interface ITraktApiOptions {
  client_id: string;
  client_secret: string;
  api_url?: string;
}

export default class TraktApi extends EventTarget {
  private _http: IHttpClient;
  private _storage: IStorage;

  private _tokens: ITraktTokens = {};

  private _client_id: string;
  private _client_secret: string;
  private _redirect_uri: string;
  private _endpoint: string;

  constructor(options: ITraktApiOptions) {
    super();

    this._client_id = options.client_id;
    this._client_secret = options.client_secret;
    this._redirect_uri = 'https://www.crunchyroll.com';
    this._endpoint = options.api_url || 'https://api.trakt.tv';

    this._http = libContainer.get<IHttpClient>("IHttpClient");
    this._storage = container.get<IStorage>(IStorageSymbol);

    this._loadTokens();
  }

  static isError(obj: any, code?: number): obj is ITraktError {
    const err = obj as ITraktError;
    return err.status !== undefined && err.error !== undefined
      && (code === undefined || err.status === code);
  }

  // ------ Authentication ------

  private async _loadTokens(): Promise<void> {
    this._tokens = await this._storage.get<ITraktTokens>(TraktTokensKey) || {};

    if (this._tokens.expires && this._tokens.expires < Date.now()) {
      this._tokens = await this._refresh_token();
      await this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);
    }

    this.dispatchEvent(new AuthenticationChangeEvent(this.isAuthenticated()));
  }

  isAuthenticated(): boolean {
    return this._tokens.access_token !== undefined;
  }

  async authenticate(): Promise<void> {
    const state = this._generate_state();
    const url = this._get_url(state);

    // Save authentication state data
    this._tokens.authentication_state = state;
    await this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);

    window.location.href = url;
  }

  async checkAuthenticationResult(url: string): Promise<void> {
    const query = parseUrl(url, true).query as IQueryAuthenticationResult;
    if (!query.code || !query.state) return;

    if (!await this._exchange_code(query.code, query.state)) {
      console.error('Exchanging oauth code failed!');
      return;
    }

    console.log('Trakt authentication successful!');

    this._storage.set<ITraktTokens>(TraktTokensKey, this._tokens);

    window.history.replaceState(null, undefined, window.location.pathname);

    this.dispatchEvent(new AuthenticationChangeEvent(true));
  }

  disconnect(): void {
    this._storage.set<ITraktTokens>(TraktTokensKey, {});
    this.dispatchEvent(new AuthenticationChangeEvent(false));
    this._revoke_token();
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
    return this.isAuthenticated();
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

  private _getError(response: IResponse<string>): ITraktError {
    var error = TraktErrorCodes[response.status];
    if (error) return error;

    return {
      status: response.status,
      error: `Unknown error (${response.statusText})`
    };
  }

  async search(type: string, query: string): Promise<Array<ITraktSearchResult> | ITraktError> {
    try {
      const response = await this._http.get(
        `${this._endpoint}/search/${type}?query=${encodeURIComponent(query)}`,
        { headers: this._trakt_headers() }
      );

      var data = JSON.parse(response.body) as Array<ITraktSearchResult>;
      return data;
    } catch (error) {
      return this._getError(error);
    }
  }

  async seasons(showId: number | string, episodes?: boolean): Promise<Array<ITraktSeason> | ITraktError> {
    try {
      const response = await this._http.get(
        `${this._endpoint}/shows/${showId}/seasons?extended=${episodes ? 'episodes' : ''}`,
        { headers: this._trakt_headers() }
      );

      var data = JSON.parse(response.body) as Array<ITraktSeason>;
      return data;
    } catch (error) {
      return this._getError(error);
    }
  }

  async season(showId: number | string, season: number, extended?: boolean): Promise<Array<ITraktEpisode> | ITraktError> {
    try {
      const response = await this._http.get(
        `${this._endpoint}/shows/${showId}/seasons/${season}?extended=${extended ? 'full' : ''}`,
        { headers: this._trakt_headers() }
      );

      var data = JSON.parse(response.body) as Array<ITraktEpisode>;
      return data;
    } catch (error) {
      return this._getError(error);
    }
  }

  async scrobble(type: string, data: ITraktScrobbleData): Promise<ITraktScobbleResult | ITraktError> {
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
      return this._getError(error);
    }
  }
}