/**
 * Nova Player — 렌더러 진입점
 *
 * 이 파일은 배선( wiring )만 담당한다.
 * 실제 동작은 각 모듈( player / audio / video / subtitles / ui/* )에 있고,
 * 여기서는 모듈 간 이벤트와 설정을 연결한다.
 */
import { $, el, clamp, formatTime, baseName, debounce, makeContextMenu, ICONS } from './util.js';
import state from './state.js';
import { Player } from './player.js';
import { audio } from './audio.js';
import { VideoController } from './video.js';
import { parseSubtitles, mergeOverlaps } from './subtitles/parser.js';
import { SubtitleRenderer } from './subtitles/renderer.js';
import { osd } from './ui/osd.js';
import { Controls } from './ui/controls.js';
import { PlaylistManager } from './ui/playlist.js';
import { SettingsPanel } from './ui/settings.js';
import { MenuBar } from './ui/menubar.js';
import { showFileInfo, showPlaybackInfo } from './ui/infobar.js';
import { openModal, anyModalOpen } from './ui/modal.js';
import { HotkeyManager } from './hotkeys.js';
import { toast, toastOk, toastInfo, toastWarn, toastError } from './ui/toast.js';
import { HOTKEY_LABELS } from './constants.js';
import { buildSnapshotName } from './util.js';
import { SettingsStore } from './settings-store.js';

const api = window.nova;

/**
 * 동기 설정 스토어 + 래핑된 api.
 * preload 브리지는 비동기 IPC 이므로, 렌더러 모듈들이 동기로 읽을 수 있도록
 * 부트스트랩 스냅샷 기반 스토어로 감싼다. 모듈에는 항상 `app` 을 넘긴다.
 */
let settings = null;
let app = api;

/**
 * 부트스트랩에서 받은 앱 정보.
 * contextBridge 가 노출하는 api 객체는 frozen 이라 확장이 불가능하므로
 * 여기에 별도로 보관한다.
 */
let appVersion = '';
let appPaths = {};

// ─────────────────────────────────────────────────────────────
// 모듈 인스턴스
// ─────────────────────────────────────────────────────────────
const video = $('#video');
const stage = $('#stage');
const videoFit = $('#video-fit');
const frameCanvas = $('#frame-overlay');
const subtitleLayer = $('#subtitle-layer');
const dropzone = $('#dropzone');
const recoveryOverlay = $('#recovery-overlay');

const player = new Player({ video, api });
const videoCtl = new VideoController(video, stage, videoFit, frameCanvas);
// 자막 설정 객체는 부트스트랩 이후에 주입된다 (boot() 참조)
const subRenderer = new SubtitleRenderer(subtitleLayer, null);
audio.attach(video);

let controls;
let playlist;
let settingsPanel;
let menubar;
let hotkeys;

// ─────────────────────────────────────────────────────────────
// 부트스트랩
// ─────────────────────────────────────────────────────────────
async function boot() {
  let boot;
  try {
    boot = await api.bootstrap();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#eef">앱 초기화에 실패했습니다: ${err.message}</div>`;
    return;
  }

  state.appInfo = { electron: boot.electron, chrome: boot.chrome, platform: boot.platform, arch: boot.arch };
  appVersion = boot.version;
  appPaths = boot.paths ?? {};

  // 동기 설정 스토어 생성 + 모듈용 래핑 api.
  // window.nova 는 frozen 이라 직접 교체가 불가능하므로 shallow copy 로 감싼다.
  settings = new SettingsStore(window.nova.settings, boot.settings);
  app = Object.assign({}, api, { settings });
  player.api = app;
  state.settings = settings.get();
  subRenderer.setSettings(settings.get('subtitle'));

  applySettings(settings.get());

  if (!boot.ffmpeg.available) {
    console.warn('[nova] ffmpeg 없음 - 내장 코덱만 사용');
  }

  buildUi();
  bindWindow();
  bindPlayer();
  bindStage();
  bindLifecycle();

  await playlist.load();

  document.body.classList.remove('booting');
  window.addEventListener('resize', debounce(() => videoCtl.applyLayout(), 60));
  videoCtl.applyLayout();

  // 시작할 때 마지막 파일 복원
  const restoreLast = state.settings.playback.resumePlayback !== false;
  if (restoreLast) {
    const last = boot.recent?.[0];
    if (last) {
      const alive = await api.recent.resolve(last.path);
      if (alive) {
        openPaths([alive], { replace: true, autoplay: false, resume: true });
      }
    }
  }

  console.log(`[nova] v${boot.version} · Electron ${boot.electron} · Chromium ${boot.chrome}`);
}

// ─────────────────────────────────────────────────────────────
// UI 구성
// ─────────────────────────────────────────────────────────────
function buildUi() {
  // HotkeyManager 가 actions 를 참조하므로 가장 먼저 구성한다.
  // (actions 는 아래 const 로 선언되지만, 이 시점에는 이미 초기화되어 있다)
  // 모든 모듈에는 동기 설정 스토어가 포함된 래핑 api(app)를 넘긴다.
  hotkeys = new HotkeyManager({ api: app, actions });
  applyHotkeys();

  controls = new Controls({ player, api: app, video, onAction: handleControlAction });
  playlist = new PlaylistManager({ api: app, onPlay: (item) => loadItem(item, { autoplay: true, resume: true }) });
  settingsPanel = new SettingsPanel({
    api: app,
    appVersion,
    appInfo: state.appInfo,
    paths: appPaths,
    onChange: (path, value) => onSettingChanged(path, value),
    onReset: () => applyAllSettings(settings.get()),
  });
  menubar = new MenuBar({ api: app, actions });

  // 창 버튼
  $('#btn-minimize').addEventListener('click', () => api.window.minimize());
  $('#btn-maximize').addEventListener('click', () => api.window.maximize());
  $('#btn-close').addEventListener('click', () => api.window.close());
  // 메뉴바 빈 공간 더블클릭 → 최대화/복원 (네이티브 타이틀바 관례)
  document.getElementById('menubar')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    api.window.maximize();
  });
  // 최대화 상태에 따라 복원 아이콘으로 전환
  const syncMaxIcon = (maxed) => {
    document.body.classList.toggle('is-maximized', !!maxed);
    const max = $('#btn-maximize .ico-max');
    const res = $('#btn-maximize .ico-restore');
    if (max) max.hidden = !!maxed;
    if (res) res.hidden = !maxed;
    $('#btn-maximize')?.setAttribute('aria-label', maxed ? '복원' : '최대화');
  };
  api.on.windowMaximized((maxed) => syncMaxIcon(maxed));
  api.window.isMaximized().then(syncMaxIcon).catch(() => {});

  // 재생목록 패널 표시 상태 복원
  playlist.setVisible(state.settings.playlist.showPanel !== false);
}

// ─────────────────────────────────────────────────────────────
// 설정 적용
// ─────────────────────────────────────────────────────────────
function applySettings(s) {
  const root = document.documentElement;
  root.dataset.theme = s.ui.theme === 'light' ? 'light' : s.ui.theme === 'midnight' ? 'midnight' : 'dark';
  root.style.setProperty('--accent', s.ui.accent);
  root.style.setProperty('--font-scale', String(s.ui.fontScale ?? 1));
  root.style.setProperty('--menubar-h', s.ui.showMenubar ? '34px' : '0px');
  document.body.classList.toggle('no-menubar', !s.ui.showMenubar);
  osd.setPosition(s.ui.osdStyle);
}

function applyAllSettings(s) {
  applySettings(s);

  // 영상
  videoCtl.applyFilters(s.video);
  videoCtl.setZoomMode(s.video.zoomMode, s.video.zoomCustom);
  videoCtl.setAspect(s.video.aspectMode);
  videoCtl.setRotation(s.video.rotation);
  videoCtl.setFlip(s.video.flipH, s.video.flipV);
  videoCtl.setDeinterlace(s.video.deinterlace, state.info);

  // 음성
  audio.setVolume(s.audio.volume);
  audio.setMuted(s.audio.muted);
  audio.apply(s.audio);

  // 자막
  subRenderer.setSettings(s.subtitle);
  subRenderer.setReadingMode(s.subtitle.readingMode);
  state.subtitles.delay = s.subtitle.delay;
  state.subtitles.speed = s.subtitle.speed;

  // 재생
  player.setSpeed(s.playback.speed ?? 1);

  // 상시 위
  api.window.alwaysOnTop(!!s.alwaysOnTop);

  updateBadges();
}

function onSettingChanged(path, value) {
  const s = settings.get();
  state.settings = s;

  if (path.startsWith('ui.')) applySettings(s);
  if (path.startsWith('video.') || path.startsWith('video')) {
    videoCtl.applyFilters(s.video);
    videoCtl.setZoomMode(s.video.zoomMode, s.video.zoomCustom);
    videoCtl.setAspect(s.video.aspectMode);
    videoCtl.setRotation(s.video.rotation);
    videoCtl.setFlip(s.video.flipH, s.video.flipV);
    if (path === 'video.deinterlace') videoCtl.setDeinterlace(s.video.deinterlace, state.info);
    updateBadges();
  }
  if (path.startsWith('audio.')) {
    audio.apply(s.audio);
    if (path === 'audio.volume') controls.setVolume(s.audio.volume);
    if (path === 'audio.muted') controls.setMuted(s.audio.muted);
    updateBadges();
  }
  if (path.startsWith('subtitle.')) {
    subRenderer.setSettings(s.subtitle);
    subRenderer.setReadingMode(s.subtitle.readingMode);
    if (path === 'subtitle.delay') state.subtitles.delay = s.subtitle.delay;
    if (path === 'subtitle.speed') state.subtitles.speed = s.subtitle.speed;
    subRenderer.cacheKey = '';
  }
  if (path.startsWith('hotkeys')) applyHotkeys();
  if (path === 'playback.preservePitch') player.setSpeed(video.playbackRate);
}

/** 현재 적용된 효과/상태 배지 갱신 */
function updateBadges() {
  const s = settings.get();
  controls.setBadge('badge-video-filter', videoCtl.hasActiveFilters());
  controls.setBadge('badge-aspect', s.video.aspectMode !== 'auto' || s.video.rotation !== 0,
    [s.video.aspectMode !== 'auto' ? `화면비 ${s.video.aspectMode}` : '', s.video.rotation ? `${s.video.rotation}°` : ''].filter(Boolean).join(' · '));
  controls.setBadge('badge-audio-filter',
    s.audio.equalizerEnabled || (s.audio.bassBoost ?? 0) > 0 || s.audio.surround || s.audio.normalizer,
    '음향 효과');
}

function applyHotkeys() {
  if (!hotkeys) return;
  hotkeys.setEnabled(settings.get('hotkeys.enabled') !== false);
  hotkeys.rebuild();
}

// ─────────────────────────────────────────────────────────────
// 창 / 시스템 이벤트
// ─────────────────────────────────────────────────────────────
function bindWindow() {
  // 창 드래그 앤 드롭
  let dragDepth = 0;

  const isFileDrag = (e) => e.dataTransfer?.types?.includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-dragging');
  });

  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-dragging');
  });

  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');

    const paths = [];
    for (const file of e.dataTransfer.files) {
      const p = api.getDroppedFilePath(file);
      if (p) paths.push(p);
    }
    if (!paths.length) return;

    const media = paths.filter((p) => /\.(mp4|mkv|webm|avi|mov|ts|mp3|flac|wav|m4a|flv|wmv|m4v|m2ts|3gp|ogv|m4a|opus)$/i.test(p));
    const subs = paths.filter((p) => /\.(srt|vtt|ass|ssa|sub|smi)$/i.test(p));
    const others = paths.filter((p) => !media.includes(p) && !subs.includes(p));

    if (media.length) await openPaths(media, { replace: !settings.get('playlist.appendOnDrop') });
    for (const sub of subs) await loadSubtitleFile(sub);
    if (others.length) {
      playlist.add(others, { dedupe: false });
      toastOk(`재생목록에 ${others.length}개 추가했습니다`);
    }
  });

  // 전역 단축키 (메인 등록분)
  api.on.globalHotkey((action) => {
    const map = {
      'global:volumeUp': () => changeVolume(5),
      'global:volumeDown': () => changeVolume(-5),
      'global:playPause': () => player.toggle(),
      'global:next': () => playlist.next(),
      'global:prev': () => playlist.prev(),
    };
    map[action]?.();
  });

  // 트레이
  api.on.trayAction((action) => {
    ({
      playPause: () => player.toggle(),
      stop: () => player.stop(),
      next: () => playlist.next(),
      prev: () => playlist.prev(),
    })[action]?.();
  });

  // 파일 연결 / 두 번째 인스턴스
  api.on.openFiles((paths) => openPaths(paths, { replace: true }));

  // 네이티브 전체화면 전환 (메인 창 이벤트 → 영상전용 UI 모드)
  api.on.fullscreen((on) => setFullscreenUi(!!on));

  // 최소화 정책
  api.on.pause(() => player.pause());
  api.on.suspend(() => { player.pause(); savePosition(); });
  api.on.resume(() => updateBadges());
  api.on.lock(() => player.pause());
  api.on.ffmpegChanged((info) => {
    if (!info.available) toastWarn('ffmpeg 를 찾지 못했습니다. 변환 기능이 비활성화됩니다.');
  });
}

function bindLifecycle() {
  // 저장되지 않은 위치 즉시 기록
  window.addEventListener('beforeunload', savePosition);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) savePosition();
  });

  // 전역 키 처리
  window.addEventListener('keydown', (e) => {
    if (anyModalOpen()) return;
    hotkeys.handle(e);
  }, true);

  // 컨트롤 자동 숨김 (전체화면 + 재생 중 + 마우스 정지 시)
  let hideTimer = null;
  const scheduleHide = () => {
    if (settings.get('ui.showControlsOnHover') === false) return;
    // 마우스가 움직이면 일단 다시 보여주고 타이머 재시작
    document.body.classList.remove('hide-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (player.playing && state.fullscreen) document.body.classList.add('hide-controls');
    }, settings.get('ui.hideControlsDelay') ?? 2800);
  };
  stage.addEventListener('pointermove', scheduleHide);
  stage.addEventListener('pointerleave', () => {
    clearTimeout(hideTimer);
    if (player.playing && state.fullscreen) document.body.classList.add('hide-controls');
  });
}

function savePosition() {
  if (!player.currentPath) return;
  api.position.save(player.currentPath, video.currentTime, video.duration);
}

// ─────────────────────────────────────────────────────────────
// 스테이지 (비디오 영역) 상호작용
// ─────────────────────────────────────────────────────────────
function bindStage() {
  // 빈 화면의 명시적 열기 버튼 (자동 팝업 대신)
  $('#dz-open')?.addEventListener('click', () => actions.openFiles());

  // 클릭: 재생/일시정지 (더블클릭: 전체화면)
  let clickTimer = null;
  stage.addEventListener('click', (e) => {
    if (e.target.closest('.playlist-panel, .recovery-overlay')) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      // 미디어가 없을 때 빈 화면을 클릭해도 파일 대화상자를 띄우지 않는다.
      // (드롭존의 '파일 열기' 버튼·Ctrl+O 로 명시적으로 연다)
      if (!player.currentPath) return;
      player.toggle();
    }, 220);
  });

  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.playlist-panel')) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    toggleFullscreen();
  });

  // 더블클릭 시 두 번째 클릭의 기본 동작(텍스트 선택) 방지
  stage.addEventListener('mousedown', (e) => {
    if (e.detail > 1) e.preventDefault();
  });

  // 우클릭 컨텍스트 메뉴
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const menu = makeContextMenu([
      { header: player.currentPath ? baseName(player.currentPath) : '재생된 파일 없음' },
      { label: '재생 / 일시정지', key: 'Space', onClick: () => player.toggle() },
      { label: '정지', onClick: () => player.stop() },
      { separator: true },
      { label: '1프레임 뒤로', key: '<', onClick: () => frameStep(-1) },
      { label: '1프레임 앞으로', key: '>', onClick: () => frameStep(1) },
      { separator: true },
      { label: '현재 장면 저장', key: 'S', icon: ICONS.camera, onClick: () => takeSnapshot() },
      { label: 'A 지점', onClick: () => player.setAbPointA() },
      { label: 'B 지점', onClick: () => player.setAbPointB() },
      { separator: true },
      { label: '화면에 맞게', checked: () => settings.get('video.zoomMode') === 'fit', onClick: () => actions.zoom('fit') },
      { label: '화면 채우기', checked: () => settings.get('video.zoomMode') === 'fill', onClick: () => actions.zoom('fill') },
      { label: '100%', checked: () => settings.get('video.zoomMode') === '1:1', onClick: () => actions.zoom('1:1') },
      { separator: true },
      { label: '전체화면', key: 'F', onClick: () => toggleFullscreen() },
      { label: '항상 위', onClick: () => actions.toggleAlwaysOnTop() },
      { separator: true },
      { label: '파일 열기…', key: 'Ctrl+O', icon: ICONS.folder, onClick: () => actions.openFiles() },
    ]);
    menu.showAt(e.clientX, e.clientY);
  });

  // 마우스 휠: 볼륨 (Shift) / 탐색 (Ctrl)
  stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.playlist-panel')) return;
    if (e.ctrlKey) {
      e.preventDefault();
      player.seekBy(Math.sign(e.deltaY) * 10);
    } else if (e.shiftKey) {
      e.preventDefault();
      changeVolume(e.deltaY > 0 ? -5 : 5);
    }
  }, { passive: false });
}

// ─────────────────────────────────────────────────────────────
// 플레이어 이벤트 → UI
// ─────────────────────────────────────────────────────────────
function bindPlayer() {
  player.addEventListener('loadstart', () => {
    dropzone.hidden = true;
    clearTimeout(snapshotTimer);
  });

  player.addEventListener('info', (e) => {
    state.info = e.detail;
    const v = e.detail.video;
    if (v) {
      videoCtl.setFrameRate(v.frameRate);
      player.setMetaRotation(v.videoRotation);
      videoCtl.setVideoRotationMeta(v.videoRotation);
      state.hasVideo = true;
      videoCtl.setDeinterlace(settings.get('video.deinterlace'), e.detail);
    }
    state.hasAudio = !!e.detail.audio;
    playlist.setDurationFor(player.currentPath, e.detail.duration);
    updateBadges();
  });

  player.addEventListener('resumed', (e) => {
    toastInfo(`이어서 재생: ${formatTime(e.detail.original, { hours: true })} 지점`);
  });

  player.addEventListener('duration', (e) => {
    if (Number.isFinite(e.detail)) playlist.setDurationFor(player.currentPath, e.detail);
  });

  player.addEventListener('play', () => {
    state.playing = true;
    dropzone.hidden = true;
    startReplayGainIfNeeded();
    resetSleepTimerOnPlay();
  });

  player.addEventListener('pause', () => {
    state.playing = false;
    // 일시정지하면 컨트롤을 즉시 다시 보여준다
    document.body.classList.remove('hide-controls');
    savePosition();
  });

  player.addEventListener('stopped', () => {
    state.playing = false;
    videoCtl.clearFrameOverlay();
  });

  player.addEventListener('ended', () => onEnded());

  player.addEventListener('error', (e) => {
    console.warn('[player]', e.detail);
  });

  player.addEventListener('fallback', (e) => showRecovery(e.detail));
  player.addEventListener('fatal', (e) => {
    hideRecovery();
    showRecoveryFailed(e.detail.message);
  });

  player.addEventListener('autoblocked', () => {
    toastWarn('브라우저 정책으로 자동 재생을 막았습니다. 재생 버튼을 눌러 주세요');
  });

  player.addEventListener('abloop', () => {
    osd.show({ title: 'A-B 반복', body: `${formatTime(player.abLoop.a, { hours: true })} 로 돌아갑니다`, duration: 900 });
  });

  // 오디오 DSP 는 첫 재생 시점에 초기화 (사용자 제스처 필요)
  video.addEventListener('play', async () => {
    if (audio.ensure()) {
      await audio.resume();
      audio.apply(settings.get('audio'));
    }
  }, { once: true });

  // 프레임마다 자막 갱신
  const renderSubtitles = () => {
    if (!video.paused) {
      const t = subTime(video.currentTime);
      subRenderer.update(t);
    }
    requestAnimationFrame(renderSubtitles);
  };
  requestAnimationFrame(renderSubtitles);
}

/** 자막 시간 = 영상 시간 + 지연, 배속 반영 */
function subTime(mediaTime) {
  const speed = state.subtitles.speed || 1;
  return mediaTime * speed + (state.subtitles.delay || 0) / 1000;
}

// ─────────────────────────────────────────────────────────────
// 파일 열기 / 재생 항목 로드
// ─────────────────────────────────────────────────────────────
async function openPaths(paths, { replace = true, autoplay = true, resume = false } = {}) {
  if (!paths?.length) return;
  if (replace) playlist.replace(paths);
  else playlist.add(paths);
  await loadItem({ path: paths[0] }, { autoplay, resume });
}

async function loadItem(item, { autoplay = true, resume = false } = {}) {
  if (!item?.path) return;

  const resolved = await api.recent.resolve(item.path);
  if (!resolved) {
    toastError('파일을 찾을 수 없습니다 (이동되었거나 삭제됨)');
    playlist.removeIndices([playlist.currentIndex]);
    return;
  }

  // 이전 위치 저장
  savePosition();

  state.current = { path: resolved, name: baseName(resolved), url: null };
  setNowPlaying(baseName(resolved), '');

  // 자막 목록 갱신
  await discoverSubtitles(resolved);

  await player.load(resolved, { resume });
  api.recent.push(resolved, { duration: video.duration || 0 });

  if (autoplay) {
    player.play().catch(() => { /* 사용자가 눌러야 할 수 있음 */ });
  }

  hideRecovery();
  videoCtl.clearFrameOverlay();
  // 1회 표시: 재생목록에 반영
  const idx = playlist.items.findIndex((i) => i.path === resolved);
  if (idx >= 0) { playlist.currentIndex = idx; playlist.renderList(); playlist.scrollToCurrent(); }
}

function setNowPlaying(title, sub) {
  $('#np-title').textContent = title;
  $('#np-sub').textContent = sub ?? '';
  const top = $('#stage-top');
  top.classList.add('show');
  clearTimeout(setNowPlaying.timer);
  setNowPlaying.timer = setTimeout(() => top.classList.remove('show'), 4000);
}

function onEnded() {
  savePosition();
  if (settings.get('playback.loopOne') || playlist.repeatMode === 'one') {
    video.currentTime = 0;
    player.play();
    return;
  }
  const delay = (settings.get('playback.autoPlayNextDelay') ?? 0) * 1000;
  const goNext = () => {
    const idx = playlist.nextIndex(1, { manual: false });
    if (idx < 0) {
      osd.show({ title: '재생 끝', body: '마지막 파일입니다', duration: 1800 });
      if (settings.get('playback.playAndExit')) actions.quit();
      return;
    }
    playlist.playAt(idx);
  };
  if (delay > 0) setTimeout(goNext, delay);
  else goNext();
}

// ─────────────────────────────────────────────────────────────
// 복구(변환) 오버레이
// ─────────────────────────────────────────────────────────────
let recoveryStage = 'none';

function showRecovery({ stage, ok }) {
  const title = $('#recovery-title');
  const desc = $('#recovery-desc');
  const bar = $('#recovery-bar');

  if (stage === 'remux' && !ok) {
    recoveryOverlay.hidden = false;
    title.textContent = '컨테이너를 변환하는 중입니다';
    desc.textContent = '재생이 되지 않는 형식이라 MKV 로 다시 묶고 있습니다. 무손실이므로 화질 저하가 없습니다.';
    bar.style.width = '20%';
    recoveryStage = 'remux';
    return;
  }
  if (stage === 'transcode') {
    recoveryOverlay.hidden = false;
    title.textContent = '이 형식을 변환하는 중입니다';
    desc.textContent = '네이티브로 재생되지 않는 코덱이라 임시 변환을 수행합니다. 파일이 클수록 시간이 걸립니다.';
    bar.style.width = '2%';
    recoveryStage = 'transcode';
  }
}

player.onFallbackProgress = ({ progress, current, total }) => {
  if (recoveryStage !== 'transcode') return;
  const bar = $('#recovery-bar');
  const pct = clamp(progress * 100, 0, 100);
  bar.style.width = `${pct.toFixed(1)}%`;
  $('#recovery-desc').textContent = `변환 중 ${pct.toFixed(0)}% · ${formatTime(current, { hours: true })} / ${formatTime(total, { hours: true })}`;
};

function hideRecovery() {
  recoveryOverlay.hidden = true;
  recoveryStage = 'none';
}

function showRecoveryFailed(message) {
  recoveryOverlay.hidden = false;
  recoveryOverlay.querySelector('.spinner')?.remove();
  $('#recovery-title').textContent = '재생할 수 없습니다';
  $('#recovery-desc').textContent = message;
  $('#recovery-bar').parentElement.hidden = true;
  const cancel = $('#recovery-cancel');
  cancel.textContent = '닫기';
  cancel.onclick = null;
  toastError('이 파일은 현재 환경에서 재생할 수 없습니다');
  setTimeout(hideRecovery, 6000);
}

function resetRecoveryUi() {
  const card = recoveryOverlay.querySelector('.recovery-card');
  if (!card) return;

  // 실패 화면에서 제거했던 스피너를 되살린다
  if (!card.querySelector('.spinner')) {
    $('#recovery-title').before(el('div', { class: 'spinner' }));
  }

  $('#recovery-title').textContent = '이 형식을 변환하는 중입니다';
  $('#recovery-desc').textContent = '플레이어가 이 컨테이너를 직접 재생하지 못해 임시 변환을 수행합니다.';
  $('#recovery-bar').parentElement.hidden = false;
  $('#recovery-bar').style.width = '0%';

  const cancel = $('#recovery-cancel');
  cancel.textContent = '취소';
  cancel.onclick = cancelTranscode;
}

async function cancelTranscode() {
  api.media.cancelTranscode();
  hideRecovery();
  resetRecoveryUi();

  // 취소 후에도 같은 파일을 다시 변환하지 않도록 플레이어 상태를 초기화하고
  // 재생목록의 다음 항목으로 넘어간다
  player.loadToken += 1;
  toastInfo('변환을 취소했습니다');

  const idx = playlist.nextIndex(1, { manual: false });
  if (idx >= 0) playlist.playAt(idx);
}

$('#recovery-cancel').addEventListener('click', (e) => {
  // 실패 화면의 "닫기" 버튼이면 오버레이만 닫고, 진행 중이면 변환을 취소한다
  if ($('#recovery-cancel').textContent === '닫기') {
    hideRecovery();
    resetRecoveryUi();
  } else {
    cancelTranscode();
  }
  void e;
});

// ─────────────────────────────────────────────────────────────
// 자막
// ─────────────────────────────────────────────────────────────
async function discoverSubtitles(mediaPath) {
  state.subtitles.list = [];
  state.subtitles.current = -1;
  subRenderer.clear();

  if (!settings.get('subtitle.autoDetect')) return;

  const found = await api.subtitle.sidecar(mediaPath);
  if (!found?.length) return;

  // 선호 언어 순으로 정렬
  const preferred = settings.get('subtitle.preferredLanguages') ?? [];
  found.sort((a, b) => {
    const pa = preferred.includes(a.lang) ? 0 : 1;
    const pb = preferred.includes(b.lang) ? 0 : 1;
    return (b.exact - a.exact) || (pa - pb) || (a.priority - b.priority);
  });

  state.subtitles.list = found;

  // 1순위 자동 로드
  if (found[0]) {
    await loadSubtitleFile(found[0].path);
    toastInfo(`자막 자동 인식: ${found[0].name}`);
  }
}

async function loadSubtitleFile(subPath) {
  try {
    const data = await api.subtitle.read(subPath);
    if (!data) return false;

    const parsed = parseSubtitles(data.text, { fps: state.info?.video?.frameRate ?? 25 });
    let cues = parsed.cues;
    // SRT/VTT 는 겹침이 버그이므로 병합
    if (parsed.format === 'srt' || parsed.format === 'vtt') cues = mergeOverlaps(cues);

    state.subtitles.cues = cues;
    state.subtitles.format = parsed.format;
    state.subtitles.current = state.subtitles.list.findIndex((s) => s.path === subPath);
    subRenderer.setCues(cues);
    subRenderer.update(subTime(video.currentTime));

    const count = cues.length;
    toastOk(`자막 로드: ${baseName(subPath)} (${count}개)`);
    return true;
  } catch (err) {
    toastError(`자막 로드 실패: ${err.message}`);
    return false;
  }
}

async function cycleSubtitle(dir) {
  const list = state.subtitles.list;
  if (!list.length) {
    toastInfo('사용 가능한 자막이 없습니다 (B 키로 직접 열 수 있습니다)');
    return;
  }
  const next = (state.subtitles.current + dir + list.length) % list.length;
  await loadSubtitleFile(list[next].path);
}

function closeSubtitle() {
  state.subtitles.cues = [];
  state.subtitles.current = -1;
  subRenderer.clear();
  toastInfo('자막을 껐습니다');
}

// ─────────────────────────────────────────────────────────────
// 스냅샷
// ─────────────────────────────────────────────────────────────
let snapshotIndex = 0;
let snapshotTimer = null;
let continuousSnapshot = false;

async function takeSnapshot({ silent = false } = {}) {
  if (!player.currentPath) return;
  try {
    const shot = await player.captureFrame({ applyFilters: true });
    const dir = await api.snapshot.dir();

    const s = settings.get('snapshot');
    const d = new Date();
    const ctx = {
      name: baseName(player.currentPath).replace(/\.[^.]+$/, ''),
      hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds(),
      year: d.getFullYear(), month: d.getMonth(), day: d.getDate(),
      index: s.sequential === false ? 0 : ++snapshotIndex,
    };

    // 파일명 규칙 전개 (중복 회피와 경로 검증은 main 이 수행)
    const extName = s.format === 'jpg' ? '.jpg' : '.png';
    const name = buildSnapshotName(s.filenamePattern ?? '{name}_{time}{index}', ctx);
    const bytes = new Uint8Array(await shot.blob.arrayBuffer());
    const savedPath = await api.snapshot.save({ name, ext: extName, bytes });

    if (!silent) {
      toastOk(`스냅샷 저장됨 (${shot.width}×${shot.height})`, {
        action: { label: '폴더 열기', onClick: () => api.snapshot.open() },
      });
    }

    if (s.flash) flashScreen();

    snapshotIndex = ctx.index;
  } catch (err) {
    toastError(`스냅샷 실패: ${err.message}`);
  }
}

function flashScreen() {
  const flash = el('div', {
    style: {
      position: 'fixed', inset: '0', background: '#fff', zIndex: '9999',
      pointerEvents: 'none', transition: 'opacity .25s', opacity: '0.9',
    },
  });
  document.body.append(flash);
  requestAnimationFrame(() => { flash.style.opacity = '0'; });
  setTimeout(() => flash.remove(), 300);
}

function toggleContinuousSnapshot() {
  continuousSnapshot = !continuousSnapshot;
  if (continuousSnapshot) {
    let lastTime = -1;
    snapshotTimer = setInterval(() => {
      // 1초에 1장, 화면 변화가 있을 때만
      const t = Math.floor(video.currentTime);
      if (t !== lastTime) { lastTime = t; takeSnapshot({ silent: true }); }
    }, 1000);
    toastOk('연속 저장 시작 (1초 간격)');
  } else {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
    toastInfo('연속 저장 중지');
  }
  updateBadges();
}

// ─────────────────────────────────────────────────────────────
// ReplayGain / 취침 타이머
// ─────────────────────────────────────────────────────────────
let rgTimer = null;

function startReplayGainIfNeeded() {
  const mode = settings.get('audio.replayGainMode') ?? 'off';
  if (mode === 'off' || !audio.ready) return;
  audio.startReplayGainAnalysis(mode === 'album');
  clearInterval(rgTimer);
  let samples = 0;
  rgTimer = setInterval(() => {
    const level = audio.measureLevel();
    if (level && level.db > -60) {
      audio.measuredRms.push(level.rms);
      samples += 1;
    }
    if (samples > 30) {   // 약 5초
      clearInterval(rgTimer);
      const delta = audio.finishReplayGainAnalysis(settings.get('audio.normalizerTarget') ?? -18);
      audio.setVolume(audio.baseGain);
      if (Math.abs(delta) > 1) {
        toastInfo(`음량 조정 ${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB`);
      }
    }
  }, 160);
}

function resetSleepTimerOnPlay() {
  if (player.sleepTimer && !video.paused) {
    // 재생 재개 시에는 타이머 유지 (취침 타이머는 사용자가 해제)
  }
}

// ─────────────────────────────────────────────────────────────
// 볼륨
// ─────────────────────────────────────────────────────────────
function changeVolume(delta) {
  const s = settings.get('audio');
  let v = clamp((s.volume ?? 80) + delta, 0, 100);
  settings.set('audio.volume', v);
  if (v > 0 && s.muted) {
    settings.set('audio.muted', false);
    controls.setMuted(false);
  }
  audio.setVolume(v);
  audio.setMuted(false);
  controls.setVolume(v);
  osd.volume(v, false);
}

function toggleMute() {
  const muted = !settings.get('audio.muted');
  settings.set('audio.muted', muted);
  audio.setMuted(muted);
  controls.setMuted(muted);
  osd.volume(settings.get('audio.volume'), muted);
}

// ─────────────────────────────────────────────────────────────
// 전체화면
// ─────────────────────────────────────────────────────────────
function toggleFullscreen() {
  api.window.fullscreen();
}

function setFullscreenUi(on) {
  state.fullscreen = on;
  controls.setFullscreen(on);
  // 전체화면에서는 재생목록 패널도 숨겨 영상만 남긴다 (복귀 시 저장된 상태로)
  const panel = document.getElementById('playlist-panel');
  if (panel) panel.hidden = on ? true : settings.get('playlist.showPanel') === false;
  setTimeout(() => videoCtl.applyLayout(), 120);
}

document.addEventListener('fullscreenchange', () => {
  setFullscreenUi(!!document.fullscreenElement);
});

// ─────────────────────────────────────────────────────────────
// 컨트롤 바 액션 디스패처
// ─────────────────────────────────────────────────────────────
function handleControlAction(action, arg) {
  const A = actions;
  switch (action) {
    case 'playPause': A.playPause(); break;
    case 'stop': A.stop(); break;
    case 'next': A.next(); break;
    case 'prev': A.prev(); break;
    case 'frameBack': frameStep(-1); break;
    case 'frameForward': frameStep(1); break;
    case 'seekBy': A.seekBy(arg); break;
    case 'seekTo': A.seekTo(arg); break;
    case 'abCycle': A.cycleAbPoint(); break;
    case 'snapshot': A.snapshot(); break;
    case 'subtitleMenu': A.openSubtitle(); break;
    case 'fileInfo': A.fileInfo(); break;
    case 'togglePlaylist': A.togglePlaylist(); break;
    case 'fullscreen': A.fullscreen(); break;
    case 'volumeChanged': audio.setVolume(arg); break;
    case 'setSpeed': A.setSpeed(arg); break;
    case 'applyPreservePitch': player.setSpeed(video.playbackRate); break;
    case 'durationChanged': break;
    default: console.warn('[controls] 미처리 액션:', action);
  }
}

// ─────────────────────────────────────────────────────────────
// 프레임 이동
// ─────────────────────────────────────────────────────────────
let frameStepBusy = false;

async function frameStep(direction) {
  if (!player.currentPath || frameStepBusy) return;

  const first = !player.frameStep.active;
  if (first) player.pause();

  frameStepBusy = true;
  try {
    const apiFrame = async (path, t) => {
      const file = await api.media.frame(path, t, { width: 1920, quality: 2 });
      return file ? api.media.toUrl(file) : null;
    };

    // video.js 의 stepFrame 는 ffmpeg 결과를 URL 로 받는 형태
    const ok = await videoCtl.stepFrame(direction, { frame: apiFrame });
    if (!ok) {
      // ffmpeg 없음: 프레임레이트 기반 근사 이동
      const fps = videoCtl.detectFps() || 25;
      const t = clamp(video.currentTime + direction / fps, 0, video.duration - 0.05);
      video.currentTime = t;
      toastInfo(`약 ${(1 / fps * 1000).toFixed(0)}ms 단위로 이동합니다 (정확한 프레임 이동은 ffmpeg 가 필요합니다)`);
    } else {
      const fps = videoCtl.detectFps() || 25;
      const frame = Math.round(player.frameStep.time * fps);
      osd.show({ title: '프레임 이동', body: `${frame}프레임`, sub: `(${formatTime(player.frameStep.time, { ms: true, hours: true })})`, duration: 800 });
    }
  } finally {
    frameStepBusy = false;
  }
}

function exitFrameStep() {
  videoCtl.clearFrameOverlay();
  player._emit('seeked', video.currentTime);
}

// ─────────────────────────────────────────────────────────────
// 액션 테이블 (메뉴/단축키/컨텍스트가 공유)
// ─────────────────────────────────────────────────────────────
const actions = {
  // 재생
  playPause: () => player.toggle(),
  stop: () => player.stop(),
  next: () => playlist.next(),
  prev: () => playlist.prev(),
  faster: () => setSpeed(video.playbackRate * 1.25),
  slower: () => setSpeed(video.playbackRate / 1.25),
  normalSpeed: () => { setSpeed(1); osd.speed(1); },

  setSpeed: (rate) => {
    const r = player.setSpeed(rate);
    settings.set('playback.speed', r);
    controls.setSpeed(r);
    osd.speed(r);
  },

  seekBy: (delta) => {
    if (!player.currentPath) return;
    const from = video.currentTime;
    player.seekBy(delta);
    osd.seekTo(clamp(from + delta, 0, video.duration), from);
  },
  seekTo: (t) => { player.seekTo(t); },

  // 반복
  cycleRepeat: () => playlist.cycleRepeat(),
  getRepeatMode: () => playlist.repeatMode,
  toggleShuffle: () => playlist.toggleShuffle(),

  // A-B
  setAb: (which) => {
    if (which === 'a') { player.setAbPointA(); osd.show({ title: 'A 지점', body: formatTime(player.abLoop.a, { hours: true }), duration: 1000 }); }
    else {
      if (player.abLoop.a === null) { toastInfo('먼저 A 지점을 지정하세요'); return; }
      player.setAbPointB();
      osd.show({ title: 'B 지점', body: formatTime(player.abLoop.b, { hours: true }), duration: 1000 });
    }
  },
  cycleAbPoint: () => {
    if (player.abLoop.a === null) { actions.setAb('a'); return; }
    if (player.abLoop.b === null) { actions.setAb('b'); return; }
    player.clearAb();
    toastInfo('A-B 반복 해제');
  },
  clearAb: () => { player.clearAb(); toastInfo('A-B 반복 해제'); },

  // 볼륨
  volumeUp: () => changeVolume(5),
  volumeDown: () => changeVolume(-5),
  toggleMute,

  // 화면
  fullscreen: toggleFullscreen,
  windowedFullscreen: () => api.window.fullscreen(),
  zoom: (mode) => {
    settings.set('video.zoomMode', mode);
    videoCtl.setZoomMode(mode, settings.get('video.zoomCustom'));
    osd.info('확대/축소', { fit: '화면에 맞게', fill: '화면 채우기', '1:1': '100%', '2:1': '200%', custom: '사용자 지정' }[mode]);
    updateBadges();
  },
  aspect: (mode) => {
    settings.set('video.aspectMode', mode);
    videoCtl.setAspect(mode);
    osd.info('화면비', mode === 'auto' ? '원본' : mode);
    updateBadges();
  },
  cycleAspect: () => {
    const order = ['auto', '4:3', '16:9', '16:10', '21:9'];
    const cur = settings.get('video.aspectMode');
    actions.aspect(order[(order.indexOf(cur) + 1) % order.length]);
  },
  rotate: (deg) => {
    const next = (videoCtl.rotation + deg + 360) % 360;
    settings.set('video.rotation', next);
    videoCtl.setRotation(next);
    osd.info('회전', `${next}°`);
    updateBadges();
  },
  flipH: () => {
    const v = !videoCtl.flipH;
    settings.set('video.flipH', v);
    videoCtl.setFlip(v, videoCtl.flipV);
    updateBadges();
  },
  flipV: () => {
    const v = !videoCtl.flipV;
    settings.set('video.flipV', v);
    videoCtl.setFlip(videoCtl.flipH, v);
    updateBadges();
  },
  resetFilters: () => {
    videoCtl.resetFilters();
    settings.patch({ video: { brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 } });
    osd.info('영상 효과', '초기화');
    updateBadges();
  },
  cycleDeinterlace: () => {
    const order = ['auto', 'on', 'off'];
    const cur = settings.get('video.deinterlace');
    const next = order[(order.indexOf(cur) + 1) % order.length];
    settings.set('video.deinterlace', next);
    const active = videoCtl.setDeinterlace(next, state.info);
    osd.info('인터레이스 제거', { auto: `자동 (${active ? '적용됨' : '대상 아님'})`, on: '켜짐', off: '꺼짐' }[next]);
    updateBadges();
  },

  // 음향
  toggleEq: () => {
    const v = !settings.get('audio.equalizerEnabled');
    settings.set('audio.equalizerEnabled', v);
    audio.apply(settings.get('audio'));
    osd.info('이퀄라이저', v ? '켜짐' : '꺼짐');
    updateBadges();
  },
  cycleBass: () => {
    const levels = [0, 5, 10, 15, 20];
    const cur = settings.get('audio.bassBoost') ?? 0;
    const next = levels[(levels.indexOf(cur) + 1) % levels.length] ?? 5;
    settings.set('audio.bassBoost', next);
    audio.apply(settings.get('audio'));
    osd.info('베이스 부스트', next === 0 ? '끄기' : `+${next} dB`);
    updateBadges();
  },
  toggleSurround: () => {
    const v = !settings.get('audio.surround');
    settings.set('audio.surround', v);
    audio.apply(settings.get('audio'));
    osd.info('3D 서라운드', v ? '켜짐' : '꺼짐');
    updateBadges();
  },
  toggleNormalizer: () => {
    const v = !settings.get('audio.normalizer');
    settings.set('audio.normalizer', v);
    audio.apply(settings.get('audio'));
    osd.info('음량 정규화', v ? '켜짐' : '꺼짐');
    updateBadges();
  },
  channelMode: (mode) => {
    settings.set('audio.channelMode', mode);
    audio.apply(settings.get('audio'));
    osd.info('채널', { auto: '자동', stereo: '스테레오', left: '왼쪽만', right: '오른쪽만', mono: '모노 합성' }[mode]);
  },
  balance: (v) => {
    settings.set('audio.balance', v);
    audio.apply(settings.get('audio'));
    osd.info('밸런스', v === 0 ? '중앙' : v < 0 ? `왼쪽 ${-v}` : `오른쪽 ${v}`);
  },

  // 자막
  toggleSubtitle: () => {
    const v = !settings.get('subtitle.enabled');
    settings.set('subtitle.enabled', v);
    subRenderer.setSettings(settings.get('subtitle'));
    osd.info('자막', v ? '켜짐' : '꺼짐');
  },
  openSubtitle: async () => {
    const files = await api.dialog.openSubtitle();
    if (files.length) {
      if (!state.subtitles.list.length) {
        state.subtitles.list = files.map((p) => ({ path: p, name: baseName(p), label: '외부' }));
      }
      await loadSubtitleFile(files[0]);
    }
  },
  redetectSubtitle: async () => {
    if (!player.currentPath) return;
    await discoverSubtitles(player.currentPath);
  },
  cycleSubtitle,
  closeSubtitle,
  subtitleDelay: (delta) => {
    const cur = state.subtitles.delay || 0;
    const next = clamp(cur + delta, -10000, 10000);
    state.subtitles.delay = next;
    settings.set('subtitle.delay', next);
    osd.show({ title: '자막 지연', body: `${next > 0 ? '+' : ''}${(next / 1000).toFixed(2)}s`, duration: 1000 });
  },

  // 스냅샷
  snapshot: () => takeSnapshot(),
  toggleContinuousSnapshot,
  isContinuousSnapshot: () => continuousSnapshot,
  openSnapshotFolder: () => api.snapshot.open(),

  // 파일
  openFiles: async () => {
    const files = await api.dialog.openFiles('multi');
    if (files.length) await openPaths(files, { replace: true });
  },
  openFolder: async () => {
    const dirs = await api.dialog.openFolder();
    if (!dirs.length) return;
    const files = await api.media.listDirectory(dirs[0], { recursive: false });
    if (!files.length) {
      toastInfo('이 폴더에 재생할 수 있는 미디어가 없습니다');
      return;
    }
    playlist.replace(files);
    await loadItem({ path: files[0] }, { autoplay: true, resume: false });
    toastOk(`폴더에서 ${files.length}개 파일을 불러왔습니다`);
  },
  openPath: async (p) => {
    const alive = await api.recent.resolve(p);
    if (!alive) { toastError('파일이 없습니다'); api.recent.remove(p); return; }
    await openPaths([alive], { replace: true });
  },
  getRecent: () => recentCache,

  // 재생목록
  importPlaylist: async () => {
    const files = await api.playlist.import();
    if (files.length) { playlist.add(files, { dedupe: false }); toastOk(`${files.length}개 추가`); }
  },
  exportPlaylist: async () => {
    const file = await api.playlist.export(playlist.items);
    if (file) toastOk('저장했습니다');
  },
  togglePlaylist: () => playlist.toggleVisible(),

  // 창
  minimize: () => api.window.minimize(),
  toggleMenubar: () => {
    const v = !settings.get('ui.showMenubar');
    settings.set('ui.showMenubar', v);
    applySettings(settings.get());
  },
  toggleAlwaysOnTop: () => {
    const v = !settings.get('alwaysOnTop');
    settings.set('alwaysOnTop', v);
    api.window.alwaysOnTop(v);
    osd.info('항상 위', v ? '켜짐' : '꺼짐');
  },
  quit: () => api.window.close(),

  // 정보
  fileInfo: () => {
    showFileInfo(state.info, {
      path: player.currentPath,
      onReveal: (p) => api.shell.showItemInFolder(p),
      onOpenFolder: (p) => api.shell.revealFolder(dirOf(p)),
    });
  },
  playbackInfo: () => showPlaybackInfo({ video, player, videoCtl, audioEngine: audio, playlist }),

  // 설정
  openSettings: (tab) => settingsPanel.open(tab ?? 'interface'),
  openSettingsFolder: () => api.diag.openPath(appPaths.userData),
  openLogsFolder: () => api.diag.openPath(appPaths.logs),
  pruneCache: async () => {
    const n = await api.media.pruneCache();
    toastOk(`캐시 ${n}개 항목을 정리했습니다`);
  },

  sleepTimer: () => openSleepTimer(),

  // 단축키 도움말
  showHotkeyHelp: () => showHotkeyHelp(),
};

/** 최근 목록 캐시 (메뉴 표시용) */
let recentCache = [];
setInterval(async () => {
  recentCache = await api.recent.list(12);
}, 8000);
api.recent.list(12).then((r) => { recentCache = r ?? []; });

function dirOf(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}

// ─────────────────────────────────────────────────────────────
// 취침 타이머 대화상자
// ─────────────────────────────────────────────────────────────
function openSleepTimer() {
  const current = settings.get('playback.sleepTimerMinutes') ?? 0;
  let selected = current;

  const body = el('div');
  const options = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  const list = el('div', { class: 'preset-grid' });

  for (const min of options) {
    const b = el('button', {
      class: 'preset-btn', type: 'button',
      text: min === 0 ? '없음' : `${min}분`,
      'aria-pressed': String(min === selected),
      onClick: () => {
        selected = min;
        list.querySelectorAll('.preset-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      },
    });
    list.append(b);
  }
  body.append(el('p', { class: 'set-group-desc', text: '설정한 시간이 지나면 재생을 멈춥니다.' }), list);

  const customInput = el('input', { class: 'field', type: 'number', min: '1', max: '600', placeholder: '직접 입력 (분)', style: { marginTop: '12px' } });
  body.append(customInput);

  const status = el('div', { class: 'note', text: player.sleepTimer ? '현재 타이머가 동작 중입니다' : '타이머가 꺼져 있습니다' });
  body.append(status);

  const modal = openModal({
    title: '취침 타이머',
    body,
    width: 420,
    footer: [
      el('button', { class: 'btn btn-sm', type: 'button', text: '지금 해제', onClick: () => { player.clearSleepTimer(); settings.set('playback.sleepTimerMinutes', 0); status.textContent = '타이머를 해제했습니다'; } }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '적용', onClick: () => {
        const custom = Number(customInput.value);
        const min = custom > 0 ? custom : selected;
        settings.set('playback.sleepTimerMinutes', min);
        player.setSleepTimer(min);
        status.textContent = min > 0 ? `${min}분 후 재생을 멈춥니다` : '타이머가 꺼져 있습니다';
        toastOk(min > 0 ? `${min}분 후 정지하도록 설정했습니다` : '타이머를 해제했습니다');
      } }),
    ],
  });
  modal.node.querySelector('.modal-close')?.addEventListener('click', () => modal.close());
}

// ─────────────────────────────────────────────────────────────
// 단축키 도움말
// ─────────────────────────────────────────────────────────────
function showHotkeyHelp() {
  const body = el('div');
  const map = settings.get('hotkeys.map') ?? {};
  const groups = [
    ['재생 제어', ['playPause', 'stop', 'nextFile', 'prevFile', 'faster', 'slower', 'normalSpeed', 'stepBackward', 'stepForward']],
    ['탐색', ['seekBack5', 'seekForward5', 'seekBack30', 'seekForward30', 'seekBack60', 'seekForward60', 'seekBack10', 'seekForward10', 'seekBack300', 'seekForward300']],
    ['음량', ['volumeUp', 'volumeDown', 'volumeMute', 'volumeReset']],
    ['화면', ['fullscreen', 'windowedFullscreen', 'zoomNormal', 'zoomFit', 'zoomAuto', 'zoomDouble', 'rotateClockwise', 'rotateCounter', 'flipHorizontal', 'flipVertical', 'alwaysOnTop']],
    ['자막/영상효과', ['subtitleToggle', 'subtitleDelayMinus', 'subtitleDelayPlus', 'subtitleNextLang', 'subtitlePrevLang', 'aspectRatioNext', 'colorCycle']],
    ['기능', ['snapshot', 'snapshotContinuous', 'abLoop', 'abLoopClear', 'playlistToggle', 'infoPanel', 'settings', 'fileOpen', 'fileInfo', 'sleepTimer']],
  ];

  for (const [title, keys] of groups) {
    body.append(el('div', { class: 'info-section', text: title }));
    const grid = el('dl', { class: 'info-grid' });
    for (const key of keys) {
      const accels = map[key] ?? [];
      grid.append(
        el('dt', { text: HOTKEY_LABELS[key] ?? key }),
        el('dd', { class: 'mono', text: accels.length ? accels.map(prettyKey).join(' / ') : '—' }),
      );
    }
    body.append(grid);
  }

  body.append(el('div', { class: 'note', text: '설정 > 단축키 에서 모두 변경할 수 있습니다.' }));

  const modal = openModal({ title: '단축키 목록', body, width: 520 });
  modal.node.querySelector('.modal-close')?.addEventListener('click', () => modal.close());
  return modal;
}

// ─────────────────────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────────────────────
boot().catch((err) => {
  console.error('[nova] 부트 실패', err);
  document.body.classList.remove('booting');
  toastError(`초기화 실패: ${err.message}`, { duration: 0 });
});
