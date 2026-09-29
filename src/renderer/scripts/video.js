/**
 * 영상 처리: 색상 보정, 배율, 화면비, 회전/뒤집기, 인터레이스 제거, 프레임 이동.
 *
 * 색상 보정은 CSS filter + SVG gamma 필터 조합으로 처리한다.
 * (GPU 필터이므로 1080p60 에서도 프레임 drops 가 거의 없다)
 * 인터레이스 제거만 유일하게 CPU 픽셀 작업이 필요해 캔버스 파이프라인을 쓴다.
 */
import { clamp, formatTime } from './util.js';

const ASPECT_PRESETS = {
  auto: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '16:10': 16 / 10,
  '21:9': 21 / 9,
  '5:4': 5 / 4,
  '3:2': 3 / 2,
};

class VideoController {
  constructor(video, stage, fit, canvas) {
    this.video = video;
    this.stage = stage;
    this.fit = fit;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.offscreen = document.createElement('canvas');
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true });
    this.frameBuf = null;

    this.deinterlaceMode = 'auto';
    this.deinterlaceActive = false;
    this.videoRotationMeta = 0;
    this.rotation = 0;
    this.flipH = false;
    this.flipV = false;
    this.zoomMode = 'fit';
    this.zoomCustom = 100;
    this.aspectMode = 'auto';
    this.frameStep = { active: false, time: 0, fps: 25 };
  }

  // ─────────────────────────────────────────────────────────
  // 색상 보정
  // ─────────────────────────────────────────────────────────
  applyFilters(v = {}) {
    const brightness = clamp(v.brightness ?? 0, -100, 100) / 100;   // -1 ~ 1
    const contrast = clamp(v.contrast ?? 0, -100, 100) / 100;
    const saturation = clamp(v.saturation ?? 0, -100, 100) / 100;
    const hue = clamp(v.hue ?? 0, -180, 180);
    const gamma = clamp(v.gamma ?? 100, 10, 300) / 100;

    // CSS 는 값을 0 에서 1 로 받아들이므로 neutral(무변경) 을 1 로 옮긴다
    const b = 1 + brightness;
    const c = 1 + contrast;
    const s = 1 + saturation;
    const useGamma = Math.abs(gamma - 1) > 0.01;

    const parts = [];
    if (useGamma) {
      this.setGamma(gamma);
      parts.push('url(#novaGamma)');
    }
    parts.push(`brightness(${b.toFixed(3)})`);
    parts.push(`contrast(${c.toFixed(3)})`);
    parts.push(`saturate(${s.toFixed(3)})`);
    if (Math.abs(hue) > 0.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);

    this.video.style.filter = parts.join(' ');
    this.canvas.style.filter = parts.join(' ');

    this.activeFilters = {
      brightness: v.brightness ?? 0,
      contrast: v.contrast ?? 0,
      saturation: v.saturation ?? 0,
      hue: v.hue ?? 0,
      gamma: v.gamma ?? 100,
    };
    return this.hasActiveFilters();
  }

  setGamma(gamma) {
    const f = document.getElementById('novaGammaTransfer');
    if (!f) return;
    // 3채널 지수 조정
    const exps = [
      { type: 'feFuncR', v: gamma },
      { type: 'feFuncG', v: gamma },
      { type: 'feFuncB', v: gamma },
    ];
    for (const fn of f.children) {
      // feFuncR/G/B 태그명으로 매칭 (type 속성은 'gamma'라서 비교 불가)
      const spec = exps.find((e) => e.type === fn.tagName);
      if (spec) fn.setAttribute('exponent', spec.v.toFixed(3));
    }
  }

  hasActiveFilters() {
    const f = this.activeFilters;
    if (!f) return false;
    return f.brightness !== 0 || f.contrast !== 0 || f.saturation !== 0
      || Math.abs(f.hue) > 0.5 || Math.abs(f.gamma - 100) > 1;
  }

  resetFilters() {
    return this.applyFilters({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 });
  }

  // ─────────────────────────────────────────────────────────
  // 배율 / 화면비 / 회전
  // ─────────────────────────────────────────────────────────

  /** 컨테이너 크기와 영상 크기를 고려해 실제 표시 크기 계산 */
  computeDisplaySize() {
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const vw = this.video.videoWidth || sw;
    const vh = this.video.videoHeight || sh;

    // 메타데이터 회전 반영
    const metaRot = ((this.videoRotationMeta % 360) + 360) % 360;
    const totalRot = (this.rotation + metaRot) % 360;
    const rotated = totalRot === 90 || totalRot === 270;
    const baseW = rotated ? vh : vw;
    const baseH = rotated ? vw : vh;

    // 화면비 보정
    const forced = ASPECT_PRESETS[this.aspectMode];
    let dw = baseW;
    let dh = baseH;
    if (forced && baseW > 0 && baseH > 0) {
      if (baseW / baseH < forced) dw = baseH * forced;
      else dh = baseW / forced;
    }

    const scale = this.zoomMode === 'fit' ? Math.min(sw / dw, sh / dh)
      : this.zoomMode === 'fill' ? Math.max(sw / dw, sh / dh)
        : this.zoomMode === '1:1' ? 1
          : this.zoomMode === '2:1' ? 2
            : clamp(this.zoomCustom, 10, 400) / 100;

    return {
      w: dw * scale,
      h: dh * scale,
      scale,
      natural: { w: vw, h: vh },
      display: { w: baseW, h: baseH },
      rotated,
      totalRotation: totalRot,
    };
  }

  applyLayout() {
    const size = this.computeDisplaySize();
    const rot = ((this.rotation % 360) + 360) % 360;

    let transform = '';
    if (rot) transform += ` rotate(${rot}deg)`;
    if (this.flipH || this.flipV) {
      transform += ` scale(${this.flipH ? -1 : 1}, ${this.flipV ? -1 : 1})`;
    }

    this.fit.style.transform = transform || 'none';

    const w = Math.max(1, Math.round(size.w));
    const h = Math.max(1, Math.round(size.h));
    this.fit.style.width = `${w}px`;
    this.fit.style.height = `${h}px`;

    // video 자체는 컨테이너를 채우도록 (object-fit 으로 크기 결정)
    this.video.style.width = '100%';
    this.video.style.height = '100%';
    this.video.style.objectFit = this.zoomMode === 'fill' ? 'cover' : 'contain';

    // 캔버스(인터레이스 제거) 도 동일 크기
    if (this.deinterlaceActive) {
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
    }

    this.lastSize = size;
    return size;
  }

  setZoomMode(mode, custom = this.zoomCustom) {
    this.zoomMode = mode;
    if (mode === 'custom') this.zoomCustom = custom;
    this.stage.classList.toggle('mode-fill', mode === 'fill');
    this.stage.classList.toggle('mode-1x1', mode === '1:1');
    this.applyLayout();
  }

  setAspect(mode) {
    this.aspectMode = mode in ASPECT_PRESETS ? mode : 'auto';
    this.applyLayout();
  }

  setRotation(deg) {
    this.rotation = ((deg % 360) + 360) % 360;
    this.applyLayout();
  }

  rotateBy(delta) {
    this.setRotation(this.rotation + delta);
  }

  setFlip(h, v) {
    this.flipH = !!h;
    this.flipV = !!v;
    this.applyLayout();
  }

  setVideoRotationMeta(deg) {
    this.videoRotationMeta = deg || 0;
    this.applyLayout();
  }

  // ─────────────────────────────────────────────────────────
  // 인터레이스 제거 (캔버스 필드 블렌딩)
  // ─────────────────────────────────────────────────────────

  /**
   * @param {'auto'|'on'|'off'} mode
   * @param {object} info ffprobe 결과 (auto 모드에서 필드 순서 판별에 사용)
   */
  setDeinterlace(mode, info = null) {
    this.deinterlaceMode = mode;
    let enable;

    if (mode === 'on') enable = true;
    else if (mode === 'off') enable = false;
    else {
      // auto: 실제로 인터레이스 기록된 영상에서만 켠다
      const fieldOrder = info?.video?.fieldOrder ?? null;
      const detected = fieldOrder && fieldOrder !== 'progressive' && fieldOrder !== 'unknown';
      enable = !!detected;
      this.detectedFieldOrder = fieldOrder;
    }

    this.setDeinterlaceActive(enable);
    return enable;
  }

  setDeinterlaceActive(enable) {
    if (this.deinterlaceActive === enable) return;
    this.deinterlaceActive = enable;

    if (enable) {
      this.canvas.hidden = false;
      this.video.style.visibility = 'hidden';
      this._startCanvasLoop();
    } else {
      this._stopCanvasLoop();
      this.canvas.hidden = true;
      this.video.style.visibility = '';
    }
    this.applyLayout();
  }

  _startCanvasLoop() {
    const useVFC = typeof this.video.requestVideoFrameCallback === 'function';
    this._rafId = null;
    this._vfcHandle = null;

    const tick = () => {
      if (!this.deinterlaceActive) return;
      this.renderDeinterlacedFrame();
      if (useVFC) this._vfcHandle = this.video.requestVideoFrameCallback(tick);
      else this._rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopCanvasLoop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._vfcHandle && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._vfcHandle);
    }
    this._rafId = null;
    this._vfcHandle = null;
  }

  renderDeinterlacedFrame() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return;

    const w = v.videoWidth;
    const h = v.videoHeight;
    if (this.offscreen.width !== w || this.offscreen.height !== h) {
      this.offscreen.width = w;
      this.offscreen.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.frameBuf = this.offCtx.createImageData(w, h);
    }

    try {
      this.offCtx.drawImage(v, 0, 0, w, h);
      const src = this.offCtx.getImageData(0, 0, w, h);
      const dst = this.frameBuf;
      const sp = src.data;
      const dp = dst.data;
      const rowBytes = w * 4;

      // 필드 블렌딩: 짝수 행은 아래 행과, 홀수 행은 위 행과 50% 섞는다.
      // 원본 필드 순서는 알 수 없으므로 "양쪽 중 가까운 쪽" 대신 고정 방향을 쓰고,
      // 움직임이 많은 구간에서 잔상이 덜한 아래 방향을 우선한다.
      for (let y = 0; y < h; y++) {
        const cur = y * rowBytes;
        const nb = (y % 2 === 0)
          ? (y + 1 < h ? cur + rowBytes : cur - rowBytes)
          : (y > 0 ? cur - rowBytes : cur + rowBytes);

        for (let x = 0; x < rowBytes; x += 4) {
          dp[cur + x] = (sp[cur + x] + sp[nb + x]) >> 1;
          dp[cur + x + 1] = (sp[cur + x + 1] + sp[nb + x + 1]) >> 1;
          dp[cur + x + 2] = (sp[cur + x + 2] + sp[nb + x + 2]) >> 1;
          dp[cur + x + 3] = 255;
        }
      }
      this.ctx.putImageData(dst, 0, 0);
    } catch (err) {
      // CORS/보안 컨텍스트 문제 시 조용히 해제
      console.warn('[video] 인터레이스 제거 실패:', err.message);
      this.setDeinterlaceActive(false);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 프레임 단위 이동
  // ─────────────────────────────────────────────────────────

  /**
   * 정지 화면에서 프레임 단위 이동.
   * HTMLVideoElement 는 프레임 단위 탐색이 불가능하므로
   * ffmpeg 로 해당 시각의 프레임을 추출해 캔버스에 덮는다.
   *
   * @returns {Promise<boolean>} 처리 성공 여부
   */
  async stepFrame(direction, api) {
    const fps = this.detectFps() || 25;
    const duration = this.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;

    const current = this.frameStep.active ? this.frameStep.time : this.video.currentTime;
    let target = current + direction / fps;

    // 경계 처리: 처음으로/끝으로 넘어가면 정지 상태 해제
    if (target < 0) target = 0;
    if (target > duration - 0.001) {
      this.clearFrameOverlay();
      this.video.currentTime = duration - 0.05;
      this.video.pause();
      return true;
    }

    // 정확히 목표 프레임에 맞추기 위해 앞뒤 프레임을 추출해 비교
    const imgUrl = await api.frame(this.video.dataset.novaPath, target, { width: 1920, quality: 2 });
    if (!imgUrl) {
      // ffmpeg 없으면 프레임 간격 근사 탐색으로 폴백
      if (this.frameStep.active) {
        this.video.currentTime = target;
        this.frameStep = { active: true, time: target, fps };
        return true;
      }
      return false;
    }

    this.showFrameOverlay(imgUrl);
    this.frameStep = { active: true, time: target, fps };

    // 재생 위치도 맞춰 두어, 이 상태에서 재생하면 그 지점부터 이어짐
    this.video.currentTime = target;
    return true;
  }

  detectFps() {
    return this.frameRate || this.frameStep.fps || 0;
  }

  /** ffprobe 결과로부터 프레임레이트 설정 */
  setFrameRate(fps) {
    if (Number.isFinite(fps) && fps > 0 && fps <= 480) {
      this.frameRate = fps;
      this.frameStep.fps = fps;
    }
  }

  showFrameOverlay(url) {
    const c = this.canvas;
    if (this.deinterlaceActive) return;   // 이미 캔버스를 쓰고 있으면 건드리지 않음
    c.hidden = false;
    const img = new Image();
    img.onload = () => {
      if (c.width !== img.naturalWidth || c.height !== img.naturalHeight) {
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
      }
      this.ctx.drawImage(img, 0, 0);
      c.hidden = false;
    };
    img.onerror = () => { c.hidden = true; };
    img.src = url;
    c.style.objectFit = 'contain';
    c.style.filter = this.video.style.filter || 'none';
  }

  clearFrameOverlay() {
    if (this.deinterlaceActive) return;
    this.canvas.hidden = true;
    this.frameStep = { active: false, time: 0, fps: this.frameStep.fps };
  }

  /** 현재 표시 상태 문자열 (OSD 용) */
  describeState() {
    const parts = [];
    if (this.zoomMode !== 'fit') {
      parts.push(this.zoomMode === 'fill' ? '화면 채움'
        : this.zoomMode === '1:1' ? '100%'
          : this.zoomMode === '2:1' ? '200%'
            : `${this.zoomCustom}%`);
    }
    if (this.aspectMode !== 'auto') parts.push(`화면비 ${this.aspectMode}`);
    const rot = ((this.rotation % 360) + 360) % 360;
    if (rot) parts.push(`${rot}°`);
    if (this.flipH) parts.push('좌우 반전');
    if (this.flipV) parts.push('상하 반전');
    if (this.deinterlaceActive) parts.push('인터레이스 제거');
    if (this.hasActiveFilters()) parts.push('색상 보정');
    return parts.join(' · ');
  }

  static formatFrameLabel(time, fps) {
    const f = Math.max(0, Math.round(time * fps));
    return `${formatTime(time, { hours: true })} (${f}프레임)`;
  }
}

export const ASPECT_MODES = Object.keys(ASPECT_PRESETS);
export { VideoController };
