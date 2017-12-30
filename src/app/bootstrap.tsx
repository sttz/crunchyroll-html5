import { Video, Stream, Subtitle } from './media/video';
import { NextVideo } from './media/nextvideo';
import { Player, IPlayerConfig } from './media/player/Player';
import { importCSS, importCSSByUrl } from './utils/css';
import { h, render } from 'preact';
import { PlaybackState, NextVideoEvent } from './media/player/IPlayerApi';
import { VideoTracker } from './Tracking';
import parse = require('url-parse');
import { EventHandler } from './libs/events/EventHandler';

const css = require('../styles/bootstrap.scss');

export function run() {
  if (Video.validateUrl(location.href)) {
    (new Bootstrap()).run();
  }
}

interface IVideoDetail {
  url: string;
  thumbnailUrl: string;
}

class Bootstrap {
  private _wrapper: Element;
  private _player: Player;
  private _tracking: VideoTracker|undefined = undefined;
  private _handler: EventHandler = new EventHandler(this);

  private _initialVideoDetail: IVideoDetail|undefined = undefined;
  private _currentVideoDetail: IVideoDetail|undefined = undefined;

  constructor() {
    let wrapper = document.querySelector("#showmedia_video_box");
    if (!wrapper) {
      wrapper = document.querySelector("#showmedia_video_box_wide");
    }
    if (!wrapper) throw new Error("Not able to find video wrapper.");
    this._wrapper = wrapper;
    this._wrapper.textContent = "Loading HTML5 player...";

    importCSSByUrl("https://fonts.googleapis.com/css?family=Noto+Sans");
    importCSS(css);
  }

  private _onSizeChange(large: boolean) {
    const showmedia = document.querySelector("#showmedia");
    const showmediaVideo = document.querySelector("#showmedia_video");
    const mainMedia = document.querySelector("#main_content");
    if (!showmedia || !showmediaVideo || !mainMedia) return;

    const api = this._player.getApi();
    var playing = api.getPreferredPlaybackState() === PlaybackState.PLAYING;
    if (large) {
      this._wrapper.setAttribute("id", "showmedia_video_box_wide");
      this._wrapper.classList.remove("xsmall-margin-bottom");
      mainMedia.classList.remove("new_layout");
      showmedia.parentElement!.classList.add("new_layout");
      showmedia.parentElement!.classList.add("new_layout_wide")
      showmedia.parentNode!.insertBefore(showmediaVideo, showmedia);
    } else {
      this._wrapper.setAttribute("id", "showmedia_video_box");
      this._wrapper.classList.add("xsmall-margin-bottom");
      showmedia.parentElement!.classList.remove("new_layout");
      showmedia.parentElement!.classList.remove("new_layout_wide")
      mainMedia.classList.add("new_layout");
      if (mainMedia.childNodes.length === 0) {
        mainMedia.appendChild(showmediaVideo);
      } else {
        mainMedia.insertBefore(showmediaVideo, mainMedia.childNodes[0]);
      }
    }
    if (playing) {
      api.playVideo(true);
    }
  }

  static getVideoThumbnailUrl(id: string): string|undefined {
    const img = document.querySelector("a.link.block-link.block[href$=\"-" + id + "\"] img.mug");
    if (!img) return undefined;

    const url = img.getAttribute("src");
    if (!url) return undefined;

    return url.replace(/_[a-zA-Z]+(\.[a-zA-Z]+)$/, "_full$1");
  }

  async loadVideo(detail: IVideoDetail, useCurrentDocument: boolean = true, startTime: number|undefined = undefined, quality: string|undefined = undefined, showLoadingThumbnail: boolean = true) {
    if (this._tracking) {
      this._tracking.dispose();
      this._tracking = undefined;
    }
    const player = this._player;

    if (useCurrentDocument) {
      this._currentVideoDetail = undefined;
    } else {
      this._currentVideoDetail = detail;
    }

    if (showLoadingThumbnail) {
      player.loadVideoByConfig({
        thumbnailUrl: detail.thumbnailUrl.replace(/_[a-zA-Z]+(\.[a-zA-Z]+)$/, "_full$1")
      });
    }

    let video: Video;

    if (useCurrentDocument) {
      video = await Video.fromDocument(detail.url, document, quality);
    } else {
      video = await Video.fromUrl(detail.url, quality);
    }
    if (video.streams.length === 0) throw new Error("No stream found.");
    const stream = video.streams[0];
    if (typeof startTime === 'undefined') {
      startTime = stream.startTime;
    }
    this._tracking = new VideoTracker(stream, player.getApi());

    const videoConfig: IPlayerConfig = {
      title: video.title,
      url: stream.url,
      duration: stream.duration,
      subtitles: stream.subtitles,
      startTime: startTime
    };
    
    const nextVideo = NextVideo.fromUrlUsingDocument(stream.nextUrl);
    if (nextVideo) {
      videoConfig.nextVideo = {
        title: nextVideo.episodeNumber + ': ' + nextVideo.episodeTitle,
        duration: typeof nextVideo.duration === 'number' ? nextVideo.duration : NaN,
        url: nextVideo.url,
        thumbnailUrl: nextVideo.thumbnailUrl
      };
    }

    player.loadVideoByConfig(videoConfig);
  }

  async bindQualityChange() {
    const qualityChangeButtons = document.querySelectorAll("a[token^=showmedia\\.]");

    const setActiveQuality = (quality: string) => {
      for (let i = 0; i < qualityChangeButtons.length; i++) {
        const btn = qualityChangeButtons[i];
        if (btn.getAttribute("href")!.indexOf("/freetrial") === 0)
          continue;
        const btnQuality = btn.getAttribute('token')!.substring(10);

        if (btnQuality === quality) {
          btn.classList.add('dark-button', 'selected');
          btn.classList.remove('default-button');
        } else {
          btn.classList.add('default-button');
          btn.classList.remove('dark-button', 'selected');
        }
      }
    };

    for (let i = 0; i < qualityChangeButtons.length; i++) {
      const btn = qualityChangeButtons[i];
      if (btn.getAttribute("href")!.indexOf("/freetrial") === 0)
        continue;
      const quality = btn.getAttribute('token')!.substring(10);
      this._handler.listen(btn, 'click', (e: Event) => {
        if (!this._initialVideoDetail) return;
        if (this._currentVideoDetail) return;
        if (!this._player) return;
        const api = this._player.getApi();

        e.preventDefault();

        setActiveQuality(quality);

        this.loadVideo(this._initialVideoDetail, true, api.getCurrentTime(), quality, false);
      }, false);
    }
  }

  async run() {
    this._wrapper.innerHTML = "";

    const preloadConfig: IPlayerConfig = {};

    const { videoId } = Video.parseUrlFragments(location.href);

    const thumbnailUrl = Bootstrap.getVideoThumbnailUrl(videoId);
    if (thumbnailUrl) {
      preloadConfig.thumbnailUrl = thumbnailUrl;
    }

    const loadVideo = async (player: Player) => {
      this._player = player;

      const api = player.getApi();
      api.listen('fullscreenchange', () => {
        if (api.isFullscreen()) return;
        if (!this._currentVideoDetail) return;
        if (this._currentVideoDetail.url === location.href) return;

        const url = parse(this._currentVideoDetail.url, true);
        if (!url.query) {
          url.query = {};
        }
        url.query['t'] = Math.floor(api.getCurrentTime()) + '';

        location.href = url.toString();
      });
      api.listen('nextvideo', (e: NextVideoEvent) => {
        if (!api.isFullscreen()) return;
        e.preventDefault();

        this.loadVideo(e.detail, false);
      }, false);

      // Get current time.
      let startTime: number|undefined = undefined;
      const url = parse(location.href, true);
      if (url.query && url.query.hasOwnProperty('t')) {
        startTime = parseFloat(url.query['t']!);
      }

      this._initialVideoDetail = {
        thumbnailUrl: Bootstrap.getVideoThumbnailUrl(videoId) || '',
        url: location.href
      };

      this.loadVideo(this._initialVideoDetail, true, startTime);
    };
    const large = this._wrapper.id === "showmedia_video_box_wide";
    const onSizeChange = (large: boolean) => this._onSizeChange(large);

    this.bindQualityChange();

    render((
      <Player
        ref={loadVideo}
        config={preloadConfig}
        large={large}
        onSizeChange={onSizeChange}></Player>
    ), this._wrapper);
  }
}