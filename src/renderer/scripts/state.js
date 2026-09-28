/**
 * 앱 전역 상태. 모든 UI 는 이 객체를 읽고, 변경은 이벤트로 알린다.
 */
import { Emitter } from './util.js';

class AppState extends Emitter {
  constructor() {
    super();

    this.settings = {};
    this.appInfo = {};

    // 재생목록 / 현재 항목
    this.playlist = [];
    this.currentIndex = -1;
    this.current = null;          // { path, name, url, isFallback }
    this.fallbackChain = null;    // 현재 재생이 변환본이면 원본 경로

    // ffprobe 결과
    this.info = null;

    // 재생 상태
    this.playing = false;
    this.seeking = false;
    this.duration = 0;
    this.currentTime = 0;
    this.bufferedEnd = 0;
    this.frameRate = null;
    this.hasVideo = false;
    this.hasAudio = true;
    this.waiting = false;

    // 오디오
    this.volume = 80;
    this.muted = false;
    this.speed = 1;

    // 자막
    this.subtitles = {
      enabled: true,
      list: [],          // { path, name, label, fromStream }
      current: -1,
      cues: [],
      delay: 0,          // ms
      speed: 1,
      format: null,
    };

    // A-B 반복
    this.ab = { a: null, b: null, active: false };

    // 화면
    this.fullscreen = false;
    this.zoomMode = 'fit';
    this.aspectMode = 'auto';
    this.rotation = 0;
    this.flipH = false;
    this.flipV = false;

    // 표시 상태
    this.osdVisible = false;
    this.controlsVisible = true;
    this.isDraggingFile = false;

    // 통계
    this.stats = { droppedFrames: 0, fps: 0, decodedFrames: 0 };
  }

  /** 현재 항목 */
  get file() { return this.current?.path ?? null; }
  get fileName() { return this.current?.name ?? ''; }

  /** 재생목록의 현재 파일 (없으면 null) */
  get currentItem() {
    return this.currentIndex >= 0 ? this.playlist[this.currentIndex] : null;
  }

  /** 진행률 0~1 */
  get progress() {
    if (!this.duration || !Number.isFinite(this.duration)) return 0;
    return Math.min(1, Math.max(0, this.currentTime / this.duration));
  }

  set(patch, silent = false) {
    Object.assign(this, patch);
    if (!silent) this.emit('change', this, patch);
  }

  /** 특정 키 변경 알림 */
  touch(key, value) {
    this[key] = value;
    this.emit('change', this, { [key]: value });
    this.emit(`change:${key}`, value);
  }
}

export const state = new AppState();
export default state;
