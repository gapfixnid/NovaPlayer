/**
 * 하단 컨트롤 바 + 탐색바
 */
import { $, clamp, formatTime, formatSpeed, throttle, debounce, setHidden } from '../util.js';
import { osd } from './osd.js';

class Controls {
  constructor({ player, api, video, onAction }) {
    this.player = player;
    this.api = api;
    this.video = video;
    this.onAction = onAction;

    this.seekbar = $('#seekbar');
    this.seekPlayed = $('#seek-played');
    this.seekBuffer = $('#seek-buffer');
    this.seekKnob = $('#seek-knob');
    this.timeCurrent = $('#time-current');
    this.timeTotal = $('#time-total');
    this.volumeSlider = $('#volume');
    this.btnPlay = $('#btn-play');
    this.speedBtn = $('#btn-speed');
    this.speedMenu = $('#speed-menu');
    this.preview = $('#seek-preview');
    this.previewImg = $('#seek-preview-img');
    this.hoverTime = $('#seek-hover-time');
    this.hoverPos = $('#seek-hover-pos');
    this.abMarkerA = $('#ab-marker-a');
    this.abMarkerB = $('#ab-marker-b');
    this.rangesNode = $('#seek-ranges');

    this.scrubbing = false;
    this.stripCache = null;      // { url, cols, rows, count, duration }
    this.stripRequestAt = 0;

    this._bindButtons();
    this._bindSeekbar();
    this._bindSpeedMenu();
    this._bindVolume();
    this._bindPlayerEvents();
  }

  // ─────────────────────────────────────────────────────────
  // 버튼
  // ─────────────────────────────────────────────────────────
  _bindButtons() {
    $('#btn-play').addEventListener('click', () => this.onAction('playPause'));
    $('#btn-stop').addEventListener('click', () => this.onAction('stop'));
    $('#btn-next').addEventListener('click', () => this.onAction('next'));
    $('#btn-prev').addEventListener('click', () => this.onAction('prev'));
    $('#btn-frame-back').addEventListener('click', () => this.onAction('frameBack'));
    $('#btn-frame-fwd').addEventListener('click', () => this.onAction('frameForward'));
    $('#btn-ab').addEventListener('click', (e) => this.onAction('abCycle', e));
    $('#btn-snapshot').addEventListener('click', (e) => this.onAction('snapshot', e));
    $('#btn-subtitles').addEventListener('click', (e) => this.onAction('subtitleMenu', e));
    $('#btn-info').addEventListener('click', () => this.onAction('fileInfo'));
    $('#btn-playlist').addEventListener('click', () => this.onAction('togglePlaylist'));
    $('#btn-fullscreen').addEventListener('click', () => this.onAction('fullscreen'));
  }

  // ─────────────────────────────────────────────────────────
  // 탐색바
  // ─────────────────────────────────────────────────────────
  _bindSeekbar() {
    const bar = this.seekbar;

    const ratioFromEvent = (e) => {
      const r = bar.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1);
    };

    const updateHover = (e) => {
      const r = bar.getBoundingClientRect();
      const ratio = ratioFromEvent(e);
      const duration = this.player.duration || 0;
      const t = ratio * duration;
      const x = ratio * r.width;

      this.hoverTime.hidden = false;
      this.hoverTime.textContent = formatTime(t, { hours: true });
      this.hoverTime.style.left = `${x}px`;

      this.hoverPos.hidden = false;
      this.hoverPos.style.left = `${x}px`;

      this._showPreview(ratio, t, x);
    };

    bar.addEventListener('pointermove', (e) => {
      updateHover(e);
      if (this.scrubbing) this._scrubTo(ratioFromEvent(e), e);
    });

    bar.addEventListener('pointerleave', () => {
      this.hoverTime.hidden = true;
      this.hoverPos.hidden = true;
      this.preview.classList.remove('show');
    });

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.scrubbing = true;
      bar.classList.add('scrubbing');
      bar.setPointerCapture(e.pointerId);
      this._scrubTo(ratioFromEvent(e), e, { commit: false });
    });

    bar.addEventListener('pointerup', (e) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      bar.classList.remove('scrubbing');
      try { bar.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      this._scrubTo(ratioFromEvent(e), e, { commit: true });
    });

    bar.addEventListener('pointercancel', () => {
      this.scrubbing = false;
      bar.classList.remove('scrubbing');
    });

    // 키보드 탐색 (탭 포커스 시)
    bar.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.onAction('seekBy', -step); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.onAction('seekBy', step); }
      else if (e.key === 'Home') { e.preventDefault(); this.onAction('seekTo', 0); }
      else if (e.key === 'End') { e.preventDefault(); this.onAction('seekTo', this.player.duration); }
    });

    // A/B 마커 우클릭으로 제거
    bar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onAction('clearAb');
    });
  }

  _scrubTo(ratio, e, { commit = false } = {}) {
    const duration = this.player.duration || 0;
    if (!duration) return;
    const target = ratio * duration;
    this.timeCurrent.textContent = formatTime(target, { hours: true });
    this.timeTotal.textContent = formatTime(duration, { hours: true });
    this.setPlayed(ratio);
    if (commit) {
      this.onAction('seekTo', target);
    } else {
      // 드래그 중에는 실제 위치를 바꾸지 않고 표시만 갱신
      this._scrubPreview = target;
    }
  }

  _showPreview(ratio, time, x) {
    if (!this.stripCache) return;
    const { cols, count, startPct = 0.005, spanPct = 0.99 } = this.stripCache;
    // time → 스트립 내 인덱스
    const norm = (time / (this.stripCache.duration || 1) - startPct) / spanPct;
    const idx = clamp(Math.floor(norm * count), 0, count - 1);

    this.previewImg.style.objectPosition = `${(idx % cols) * (100 / cols)}% ${Math.floor(idx / cols) * (100 / Math.ceil(count / cols))}%`;
    this.preview.hidden = false;
    this.preview.style.left = `${x}px`;
    requestAnimationFrame(() => this.preview.classList.add('show'));
  }

  /** 썸네일 스트립 설정 (ffmpeg 로 생성) */
  async setThumbnailStrip(strip) {
    if (!strip) {
      this.stripCache = null;
      return;
    }
    if (this.stripCache?.url === strip.url) return;
    try {
      this.previewImg.src = strip.url;
      this.stripCache = strip;
    } catch { /* noop */ }
  }

  // ─────────────────────────────────────────────────────────
  // 볼륨
  // ─────────────────────────────────────────────────────────
  _bindVolume() {
    this.volumeSlider.addEventListener('input', () => {
      const v = Number(this.volumeSlider.value);
      this.setVolume(v);
      this.onAction('volumeChanged', v);
    });
    // 드래그 중 OSD 는 mousemove 로 표시
    this.volumeSlider.addEventListener('pointerdown', () => { this._volumeDragging = true; });
    window.addEventListener('pointerup', () => { this._volumeDragging = false; });
  }

  setVolume(v) {
    this.volumeSlider.value = String(Math.round(v));
    this.volumeSlider.style.setProperty('--volpct', `${v}%`);
  }

  setMuted(m) {
    document.body.classList.toggle('is-muted', m);
    setHidden($('#btn-mute .ico-vol'), m);
    setHidden($('#btn-mute .ico-mute'), !m);
  }

  // ─────────────────────────────────────────────────────────
  // 속도
  // ─────────────────────────────────────────────────────────
  _bindSpeedMenu() {
    const menu = this.speedMenu;
    const slider = $('#speed-slider');
    const preserve = $('#speed-preserve-pitch');

    this.speedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      if (open) {
        slider.value = String(Math.round(this.player.video.playbackRate * 100));
        this._syncSpeedPresets();
      }
    });

    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== this.speedBtn) menu.hidden = true;
    });

    menu.querySelectorAll('.speed-presets button').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.onAction('setSpeed', Number(btn.dataset.speed));
      });
    });

    slider.addEventListener('input', () => {
      const rate = Number(slider.value) / 100;
      this.onAction('setSpeed', rate);
    });

    preserve.addEventListener('change', () => {
      this.api.settings.set('playback.preservePitch', preserve.checked);
      this.onAction('applyPreservePitch');
    });

    const p = this.api.settings.get('playback.preservePitch');
    preserve.checked = p !== false;
  }

  _syncSpeedPresets() {
    const cur = this.player.video.playbackRate;
    this.speedMenu.querySelectorAll('.speed-presets button').forEach((b) => {
      b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.speed) - cur) < 0.001));
    });
  }

  setSpeed(rate) {
    this.speedBtn.textContent = formatSpeed(rate);
    const slider = $('#speed-slider');
    slider.value = String(Math.round(rate * 100));
    this._syncSpeedPresets();
  }

  toggleSpeedMenu() {
    this.speedMenu.hidden = !this.speedMenu.hidden;
  }

  // ─────────────────────────────────────────────────────────
  // 플레이어 이벤트 → UI 반영
  // ─────────────────────────────────────────────────────────
  _bindPlayerEvents() {
    const p = this.player;

    p.addEventListener('time', (e) => {
      if (this.scrubbing) return;
      this.timeCurrent.textContent = formatTime(e.detail, { hours: true });
      this.setPlayed(p.duration ? e.detail / p.duration : 0);
      this._updateAria();
    });

    p.addEventListener('duration', (e) => {
      const d = e.detail;
      this.timeTotal.textContent = Number.isFinite(d) ? formatTime(d, { hours: true }) : '00:00:00';
      this.seekbar.setAttribute('aria-valuemax', String(Math.round(d || 0)));
      this.onAction('durationChanged', d);
    });

    p.addEventListener('buffer', (e) => {
      const d = p.duration || 0;
      if (d) this.seekBuffer.style.width = `${clamp(e.detail / d, 0, 1) * 100}%`;
    });

    p.addEventListener('play', () => {
      setHidden(this.btnPlay.querySelector('.ico-play'), true);
      setHidden(this.btnPlay.querySelector('.ico-pause'), false);
      this.btnPlay.setAttribute('aria-label', '일시정지');
      document.getElementById('badge-speed')?.classList.toggle('hidden', false);
    });

    p.addEventListener('pause', () => {
      setHidden(this.btnPlay.querySelector('.ico-play'), false);
      setHidden(this.btnPlay.querySelector('.ico-pause'), true);
      this.btnPlay.setAttribute('aria-label', '재생');
    });

    p.addEventListener('rate', (e) => this.setSpeed(e.detail));
    p.addEventListener('volume', () => this.setVolume(p.video.volume * 100));
    p.addEventListener('seeked', (e) => {
      this.timeCurrent.textContent = formatTime(e.detail, { hours: true });
    });

    p.addEventListener('ab', (e) => this.renderAb(e.detail));
  }

  setPlayed(ratio) {
    const pct = clamp(ratio, 0, 1) * 100;
    this.seekPlayed.style.width = `${pct}%`;
  }

  _updateAria() {
    const t = this.player.video.currentTime;
    const d = this.player.duration || 0;
    this.seekbar.setAttribute('aria-valuenow', String(Math.round(t)));
    this.seekbar.setAttribute('aria-valuetext', `${formatTime(t, { hours: true })} / ${formatTime(d, { hours: true })}`);
  }

  // ─────────────────────────────────────────────────────────
  // A-B 반복 표시
  // ─────────────────────────────────────────────────────────
  renderAb({ a, b }) {
    const d = this.player.duration || 0;
    const btn = $('#btn-ab');
    const badge = $('#badge-ab');

    const hasA = a !== null && a !== undefined;
    const hasB = b !== null && b !== undefined;
    const active = hasA && hasB && b > a;

    btn.setAttribute('aria-pressed', String(active || hasA || hasB));
    badge.hidden = !active;
    $('#btn-ab .ico-ab-active')?.remove();

    if (!hasA && !hasB) {
      this.abMarkerA.hidden = true;
      this.abMarkerB.hidden = true;
      this.rangesNode.innerHTML = '';
      btn.title = 'A-B 반복 (Ctrl+Alt+L)';
      return;
    }

    if (d > 0) {
      if (hasA) {
        this.abMarkerA.hidden = false;
        this.abMarkerA.style.left = `${(a / d) * 100}%`;
      } else this.abMarkerA.hidden = true;

      if (hasB) {
        this.abMarkerB.hidden = false;
        this.abMarkerB.style.left = `${(b / d) * 100}%`;
      } else this.abMarkerB.hidden = true;
    }

    if (active) {
      const region = document.createElement('div');
      region.className = 'ab-region';
      region.style.left = `${(a / d) * 100}%`;
      region.style.width = `${((b - a) / d) * 100}%`;
      this.rangesNode.replaceChildren(region);
      btn.title = `A-B 반복 ${formatTime(a)} → ${formatTime(b)} (해제: 우클릭)`;
    } else {
      this.rangesNode.replaceChildren();
      btn.title = hasA ? `A 지점 ${formatTime(a)} — B 지점을 지정하세요` : 'A-B 반복 (Ctrl+Alt+L)';
    }
  }

  // ─────────────────────────────────────────────────────────
  // 전체화면 아이콘
  // ─────────────────────────────────────────────────────────
  setFullscreen(on) {
    setHidden($('#btn-fullscreen .ico-fs'), on);
    setHidden($('#btn-fullscreen .ico-fs-exit'), !on);
    document.body.classList.toggle('is-fullscreen', on);
  }

  setBadge(id, visible, text) {
    const node = document.getElementById(id);
    if (!node) return;
    node.hidden = !visible;
    if (text !== undefined) node.textContent = text;
  }

  /** 썸네일 미리보기를 위한 지연 로드 (탐색바 위 400ms 머문 뒤) */
  requestStrip = debounce(async () => {
    const path = this.player.currentPath;
    if (!path || this.stripCache?.path === path) return;
    const strip = await this.api.media.strip(path, { count: 12, tileW: 160, tileH: 90, cols: 6 });
    if (strip) {
      strip.path = path;
      this.setThumbnailStrip(strip);
    }
  }, 400);
}

export { Controls };
