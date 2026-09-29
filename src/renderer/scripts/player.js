/**
 * 재생 엔진
 *
 * 재생 실패 복구 체인
 *   1) 네이티브 재생 (Chromium 코덱)
 *   2) ffmpeg 재 mux        — 컨테이너만 교체, 코덱 그대로 (빠름)
 *   3) ffmpeg 실시간 변환    — H.264/AAC 로 변환 (느리지만 거의 모든 포맷)
 *   4) 실패 → 원인 안내
 *
 * 이 외에 이어보기, A-B 반복, 프레임 이동, 스냅샷, 취침 타이머를 담당한다.
 */
import { clamp, formatTime } from './util.js';
import { audio } from './audio.js';

export const MEDIA_ERRORS = {
  1: '재생이 중단되었습니다 (MEDIA_ERR_ABORTED)',
  2: '네트워크 오류로 재생이 중단되었습니다',
  3: '디코딩 중 오류가 발생했습니다',
  4: '이 컨테이너/코덱을 지원하지 않습니다',
};

class Player extends EventTarget {
  constructor({ video, api }) {
    super();
    this.video = video;
    this.api = api;
    this.currentPath = null;
    this.info = null;
    this.loadToken = 0;          // 비동기 로드 경합 방지
    this.fallbackStage = 'none'; // none | native | remux | transcode
    this.abLoop = { a: null, b: null };
    this.sleepTimer = null;
    this.savedPosition = 0;
    this.lastSaveAt = 0;
    this.onFallbackProgress = null;
    this.onError = null;
    this.onLoaded = null;
    this.onStateChange = null;
    this.frameRate = 0;
    this._boundEvents();
  }

  // ─────────────────────────────────────────────────────────
  // 이벤트 바인딩
  // ─────────────────────────────────────────────────────────
  _boundEvents() {
    const v = this.video;
    this._handlers = {
      loadedmetadata: () => this._onLoadedMetadata(),
      durationchange: () => this._emit('duration', v.duration),
      timeupdate: () => this._onTimeUpdate(),
      progress: () => this._emit('buffer', this._bufferedEnd()),
      play: () => this._emit('play'),
      pause: () => this._emit('pause'),
      ended: () => this._emit('ended'),
      waiting: () => this._emit('waiting', true),
      playing: () => this._emit('waiting', false),
      canplay: () => this._emit('ready'),
      error: () => this._onError(),
      ratechange: () => this._emit('rate', v.playbackRate),
      volumechange: () => this._emit('volume'),
      seeked: () => this._emit('seeked', v.currentTime),
    };
    for (const [type, fn] of Object.entries(this._handlers)) {
      v.addEventListener(type, fn);
    }
  }

  destroy() {
    for (const [type, fn] of Object.entries(this._handlers ?? {})) {
      this.video.removeEventListener(type, fn);
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _bufferedEnd() {
    const b = this.video.buffered;
    const t = this.video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t && b.end(i) >= t) return b.end(i);
    }
    return b.length ? b.end(b.length - 1) : 0;
  }

  // ─────────────────────────────────────────────────────────
  // 로드
  // ─────────────────────────────────────────────────────────

  /**
   * 파일 로드.
   * @param {string} filePath
   * @param {object} opts { autoplay, startTime, resume }
   */
  async load(filePath, opts = {}) {
    const token = ++this.loadToken;
    // 이전 파일의 진행 중 변환이 있으면 중단 요청 (메인 ffmpeg abort).
    // 응답을 기다리지 않는다: 새 로드가 우선이다.
    try { this.api.media.cancelTranscode(); } catch { /* noop */ }
    this.currentPath = filePath;
    this.fallbackStage = 'native';
    this.abLoop = { a: null, b: null };
    this.video.dataset.novaPath = filePath;

    // 위치 기억
    this.savedPosition = 0;
    if (opts.resume) {
      const pos = await this.api.position.get(filePath);
      if (pos && pos.p > 3 && (!pos.d || pos.p < pos.d * 0.97)) {
        this.savedPosition = pos.p;
      }
    }

    const url = await this.api.media.toUrl(filePath);
    if (token !== this.loadToken) return;
    if (!url) {
      this._fail('파일 경로를 읽을 수 없습니다.');
      return;
    }

    this.video.poster = '';
    this.video.removeAttribute('poster');
    this.video.src = url;
    this.video.load();
    this._emit('loadstart', { filePath });
  }

  async _onLoadedMetadata() {
    // 메타데이터 시점의 토큰을 캡처: 느린 probe가 새 파일을 덮지 못하게 한다
    const token = this.loadToken;
    const probedPath = this.currentPath;
    // ffprobe 로 상세 정보 수집 (비동기, 재생에 영향 없음)
    if (this.fallbackStage === 'native' && this.api.media.probe) {
      this.api.media.probe(this.currentPath)
        .then((info) => {
          if (!info || token !== this.loadToken || this.currentPath !== probedPath) return;
          this.info = info;
          if (info.video?.frameRate) this.frameRate = info.video.frameRate;
          if (info.video?.videoRotation) this._emit('rotation', info.video.videoRotation);
          this._emit('info', info);
        })
        .catch(() => { /* 무시 */ });
    }

    // 이어보기
    const startAt = this.savedPosition;
    if (startAt > 0 && startAt < this.video.duration - 5) {
      const rewind = this.api.settings.get('playback.rewindOnLoad') ?? 5;
      this.video.currentTime = Math.max(0, startAt - rewind);
      this._emit('resumed', { position: startAt - rewind, original: startAt });
    }
    this._emit('duration', this.video.duration);
  }

  // ─────────────────────────────────────────────────────────
  // 오류 복구
  // ─────────────────────────────────────────────────────────

  async _onError() {
    const err = this.video.error;
    if (!err) return;

    const token = this.loadToken;
    const code = err.code;
    this._emit('error', { code, message: MEDIA_ERRORS[code] ?? '알 수 없는 재생 오류', path: this.currentPath });

    // 사용자 취소/중단성 오류는 복구 시도하지 않음
    if (code === 1) return;

    if (this.fallbackStage === 'native' && this.api.settings.get('ffmpeg.remuxFallback')) {
      this.fallbackStage = 'remux';
      this._emit('fallback', { stage: 'remux' });
      const out = await this.api.media.remux(this.currentPath);
      if (token !== this.loadToken) return;
      if (out) {
        this._emit('fallback', { stage: 'remux', ok: true, path: out });
        this.fallbackSource = out;
        this.video.src = await this.api.media.toUrl(out);
        this.video.load();
        this._tryPlay();
        return;
      }
    }

    if (this.fallbackStage !== 'transcode' && this.api.settings.get('ffmpeg.transcodeFallback')) {
      this.fallbackStage = 'transcode';
      this._emit('fallback', { stage: 'transcode' });
      const quality = this.api.settings.get('ffmpeg.transcodeQuality') ?? 'fast';
      const result = await this.api.media.transcode(this.currentPath, {
        width: 1920,
        quality: quality === 'quality' ? 2 : quality === 'balanced' ? 1 : 0,
        onProgress: (p, cur, total) => this.onFallbackProgress?.({ progress: p, current: cur, total }),
      }).catch(() => null);

      if (token !== this.loadToken) return;
      if (result?.path) {
        this._emit('fallback', { stage: 'transcode', ok: true, path: result.path });
        this.fallbackSource = result.path;
        this.video.src = await this.api.media.toUrl(result.path);
        this.video.load();
        this._tryPlay();
        return;
      }

      this._fail('이 파일은 변환으로도 재생할 수 없습니다. 다른 코덱으로 다시 인코딩이 필요합니다.');
      return;
    }

    this._fail(MEDIA_ERRORS[code] ?? '재생할 수 없습니다.');
  }

  _fail(message) {
    this._emit('fatal', { message, path: this.currentPath });
    this.onError?.(message, this.currentPath);
  }

  _tryPlay() {
    this.video.play().catch((err) => {
      if (err?.name === 'NotAllowedError') {
        this._emit('autoblocked', {});
      }
    });
  }

  // ─────────────────────────────────────────────────────────
  // 재생 제어
  // ─────────────────────────────────────────────────────────

  async play() {
    await audio.resume();
    try {
      await this.video.play();
    } catch (err) {
      if (err?.name !== 'AbortError') this._emit('playerror', { message: err.message });
    }
  }

  pause() {
    this.video.pause();
  }

  toggle() {
    if (this.video.paused) this.play();
    else this.pause();
  }

  stop() {
    this.video.pause();
    try { this.video.currentTime = 0; } catch { /* noop */ }
    this._emit('stopped', {});
  }

  get playing() { return !this.video.paused && !this.video.ended; }
  get currentTime() { return this.video.currentTime; }
  get duration() { return this.video.duration; }

  seekTo(time, { smooth = false } = {}) {
    if (!Number.isFinite(this.video.duration)) return;
    const target = clamp(time, 0, Math.max(0, this.video.duration - 0.05));
    if (smooth) this.video.currentTime = target;
    else this.video.currentTime = target;
  }

  seekBy(delta) {
    this.seekTo(this.video.currentTime + delta);
  }

  /** 마우스 위치 비율(0~1)로 이동 */
  seekToRatio(ratio) {
    this.seekTo(clamp(ratio, 0, 1) * this.video.duration);
  }

  setSpeed(rate) {
    const r = clamp(rate, 0.0625, 16);
    this.video.playbackRate = r;
    const preserve = this.api.settings.get('playback.preservePitch') !== false;
    this.video.preservesPitch = preserve;
    this.video.mozPreservesPitch = preserve;
    return r;
  }

  // ─────────────────────────────────────────────────────────
  // A-B 반복
  // ─────────────────────────────────────────────────────────

  setAbPointA(time = this.video.currentTime) {
    this.abLoop.a = clamp(time, 0, this.video.duration ?? 0);
    if (this.abLoop.b !== null && this.abLoop.b <= this.abLoop.a) this.abLoop.b = null;
    this._emit('ab', { ...this.abLoop });
  }

  setAbPointB(time = this.video.currentTime) {
    this.abLoop.b = clamp(time, 0, this.video.duration ?? 0);
    if (this.abLoop.a !== null && this.abLoop.b <= this.abLoop.a) {
      this.abLoop.a = null;
    }
    this._emit('ab', { ...this.abLoop });
  }

  clearAb() {
    this.abLoop = { a: null, b: null };
    this._emit('ab', { ...this.abLoop });
  }

  get abActive() {
    return this.abLoop.a !== null && this.abLoop.b !== null && this.abLoop.b > this.abLoop.a;
  }

  // ─────────────────────────────────────────────────────────
  // timeupdate (반복·저장·자막 동기화)
  // ─────────────────────────────────────────────────────────

  _onTimeUpdate() {
    const t = this.video.currentTime;

    // A-B 반복
    if (this.abActive && t >= this.abLoop.b) {
      this.video.currentTime = this.abLoop.a;
      this._emit('abloop', { from: this.abLoop.a, to: this.abLoop.b });
    }

    // 위치 저장 (5초마다)
    if (this.currentPath && Date.now() - this.lastSaveAt > 5000) {
      this.lastSaveAt = Date.now();
      this.api.position.save(this.currentPath, t, this.video.duration);
    }

    this._emit('time', t);
  }

  // ─────────────────────────────────────────────────────────
  // 스냅샷
  // ─────────────────────────────────────────────────────────

  /**
   * 현재 프레임을 이미지로 캡처.
   * 표시 중인 필터(밝기/대비/색상)를 함께 적용하기 위해
   * 캔버스로 한 번 복제한 뒤 ctx.filter 로 보정한다.
   *
   * @param {object} opts
   *   applyFilters: CSS 필터 적용 여부
   *   rotation: 사용자 회전(도, videoCtl.rotation 전달)
   *   flipH/flipV: 사용자 뒤집기
   * @returns {Promise<{blob: Blob, width: number, height: number}>}
   *   (ObjectURL을 만들지 않아 revoke 누수가 없다)
   */
  async captureFrame({ applyFilters = true, rotation = 0, flipH = false, flipV = false } = {}) {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) throw new Error('캡처할 프레임이 없습니다.');

    // 전체 회전(메타+사용자). 90/270도면 캔버스 가로세로를 맞바꿔야 잘리지 않는다
    const metaRot = ((this._metaRotation ?? 0) % 360 + 360) % 360;
    const userRot = ((rotation ?? 0) % 360 + 360) % 360;
    const totalRot = (metaRot + userRot) % 360;
    const swap = totalRot === 90 || totalRot === 270;

    const canvas = document.createElement('canvas');
    canvas.width = swap ? v.videoHeight : v.videoWidth;
    canvas.height = swap ? v.videoWidth : v.videoHeight;
    const ctx = canvas.getContext('2d');

    // 원점 중심 변환으로 회전+뒤집기를 한 번에 적용
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    if (totalRot) ctx.rotate((totalRot * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
    ctx.restore();

    // CSS 필터 중 canvas 가 지원하는 부분만 적용 (url(#gamma) 는 제외).
    // 변환이 끝난 깨끗한 상태에서 수행해야 clearRect 잔상이 남지 않는다.
    if (applyFilters) {
      const css = (v.style.filter || '')
        .replace(/url\([^)]*\)\s*/g, '')
        .trim();
      if (css) {
        try {
          const layer = document.createElement('canvas');
          layer.width = canvas.width;
          layer.height = canvas.height;
          const lctx = layer.getContext('2d');
          lctx.filter = css;
          lctx.drawImage(canvas, 0, 0);
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(layer, 0, 0);
          ctx.restore();
        } catch { /* 필터 미지원 시 원본 그대로 */ }
      }
    }

    const format = this.api.settings.get('snapshot.format') === 'jpg' ? 'image/jpeg' : 'image/png';
    const quality = (this.api.settings.get('snapshot.quality') ?? 95) / 100;

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 생성 실패'))), format, quality);
    });

    return { blob, width: canvas.width, height: canvas.height };
  }

  // ─────────────────────────────────────────────────────────
  // 취침 타이머
  // ─────────────────────────────────────────────────────────

  setSleepTimer(minutes) {
    this.clearSleepTimer();
    if (!minutes || minutes <= 0) {
      this._emit('sleep', null);
      return null;
    }
    const endAt = Date.now() + minutes * 60000;
    this.sleepTimer = setInterval(() => {
      const remain = endAt - Date.now();
      if (remain <= 0) {
        this.clearSleepTimer();
        this.pause();
        this._emit('sleep', { expired: true });
      } else {
        this._emit('sleep', { remainMs: remain, endAt });
      }
    }, 1000);
    this._emit('sleep', { endAt, minutes });
    return this.sleepTimer;
  }

  clearSleepTimer() {
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    this.sleepTimer = null;
  }

  // ─────────────────────────────────────────────────────────
  // 통계
  // ─────────────────────────────────────────────────────────

  getQuality() {
    const q = this.video.getVideoPlaybackQuality?.();
    if (!q) return null;
    return {
      total: q.totalVideoFrames,
      dropped: q.droppedVideoFrames,
      corrupted: q.corruptedVideoFrames,
      ratio: q.totalVideoFrames ? q.droppedVideoFrames / q.totalVideoFrames : 0,
    };
  }

  setMetaRotation(deg) {
    this._metaRotation = deg;
  }
}

export { Player, formatTime };
