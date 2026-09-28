'use strict';
/**
 * 설정 스키마 / 기본값.
 * 사용자가 모르는 키를 넣어도 안전하도록 store.js 가 화이트리스트로 걸러준다.
 */

const DEFAULT_HOTKEYS = {
  // ── 재생 제어 ───────────────────────────────────────────
  playPause: ['Space', 'MediaPlayPause'],
  stop: ['MediaStop'],
  nextFile: ['N', 'MediaNextTrack'],
  prevFile: ['P', 'MediaPrevTrack'],
  faster: ['+', 'Add', 'BracketRight'],
  slower: ['-', 'Subtract', 'BracketLeft'],
  normalSpeed: ['Backslash'],
  stepBackward: ['Comma'],
  stepForward: ['Period'],

  // ── 탐색 ────────────────────────────────────────────────
  seekBack5: ['ArrowLeft'],
  seekForward5: ['ArrowRight'],
  seekBack30: ['Shift+ArrowLeft'],
  seekForward30: ['Shift+ArrowRight'],
  seekBack60: ['Control+ArrowLeft'],
  seekForward60: ['Control+ArrowRight'],
  seekBack10: ['PageUp'],
  seekForward10: ['PageDown'],
  seekBack300: ['Alt+PageUp'],
  seekForward300: ['Alt+PageDown'],
  relativeSeek1s: ['Control+Alt+ArrowLeft'],
  relativeSeekForward1s: ['Control+Alt+ArrowRight'],

  // ── 볼륨 ────────────────────────────────────────────────
  volumeUp: ['ArrowUp'],
  volumeDown: ['ArrowDown'],
  volumeMute: ['M', 'AudioVolumeMute'],
  volumeReset: ['0'],

  // ── 화면 ────────────────────────────────────────────────
  fullscreen: ['F', 'Enter'],
  windowedFullscreen: ['Alt+Enter'],
  minimize: ['Alt+Down'],
  zoomNormal: ['Alt+1'],
  zoomFit: ['Alt+2'],
  zoomAuto: ['Alt+3'],
  zoomDouble: ['Alt+4'],
  rotateClockwise: ['Alt+BracketRight'],
  rotateCounter: ['Alt+BracketLeft'],
  flipHorizontal: ['Alt+H'],
  flipVertical: ['Alt+V'],
  alwaysOnTop: ['Control+Alt+T'],

  // ── 자막 / 영상효과 ──────────────────────────────────────
  subtitleToggle: ['B'],
  subtitleDelayMinus: ['Control+Alt+ArrowDown'],
  subtitleDelayPlus: ['Control+Alt+ArrowUp'],
  subtitleSpeedUp: ['Shift+Alt+Period'],
  subtitleSpeedDown: ['Shift+Alt+Comma'],
  subtitleNextLang: ['Shift+S'],
  subtitlePrevLang: ['Shift+D'],
  aspectRatioNext: ['Control+Alt+A'],
  aspectRatioReset: ['Control+Alt+R'],
  colorCycle: ['Control+Alt+C'],

  // ── 기능 ────────────────────────────────────────────────
  snapshot: ['S'],
  snapshotContinuous: ['Control+S'],
  abLoop: ['Control+Alt+L'],
  abLoopClear: ['Control+Alt+Shift+L'],
  playlistToggle: ['Control+L'],
  infoPanel: ['I', 'F1'],
  settings: ['Control+P'],
  osd: ['Control+O'],
  sleepTimer: ['Control+Alt+K'],
  recentMenu: ['Shift+R'],
  playAndPause: ['Control+Space'],
  fileOpen: ['Control+O'],
  fileInfo: ['Shift+F1'],
  close: ['Alt+F4'],
  seekBarFocus: ['Alt+Left'],
};

const DEFAULT_SETTINGS = {
  ui: {
    language: 'ko',            // ko | en
    theme: 'dark',              // dark | light | midnight | system
    accent: '#3b82f6',
    fontScale: 1.0,
    showMenubar: true,
    showControlsOnHover: true,
    hideControlsDelay: 2800,
    pauseOnMinimize: false,
    minimizeToTray: true,
    closeToTray: false,
    startInFullscreen: false,
    windowState: null,          // {x,y,width,height,maximized,fullscreen}
    seekbarShowRemaining: true,
    osdStyle: 'bottom',         // bottom | top | center
  },

  playback: {
    resumePlayback: true,       // 마지막 재생 위치 이어보기
    rememberPositionPerFile: true,
    autoPlayNext: true,
    autoPlayNextDelay: 0,       // ms
    loopPlaylist: false,
    loopOne: false,
    shufflePlaylist: false,
    playAndExit: false,
    rewindOnLoad: 5,            // 재개 시 앞으로 건너뛸 초
    speed: 1.0,
    preservePitch: true,
    sleepTimerMinutes: 0,
    fastSeekMultiplier: 5,
    seekStepSmall: 5,
    seekStepMedium: 30,
    seekStepLarge: 60,
    smartSeekEdge: true,        // 마우스 위치가 트랙 가장자리면 빨리 감기/감속
  },

  video: {
    brightness: 0,              // -100 ~ 100
    contrast: 0,
    saturation: 0,              // -100 ~ 100
    hue: 0,                     // -180 ~ 180
    gamma: 100,                 // 10 ~ 300
    zoomMode: 'fit',            // fit | fill | 1:1 | 2:1 | custom
    zoomCustom: 100,
    aspectMode: 'auto',         // auto | 1:1 | 4:3 | 16:9 | 21:9 | 16:10
    rotation: 0,                // 0/90/180/270
    flipH: false,
    flipV: false,
    deinterlace: 'auto',        // auto | on | off
    hwDecodeNote: true,
  },

  audio: {
    volume: 80,
    muted: false,
    equalizerEnabled: false,
    equalizerPreset: 'flat',
    equalizerBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // 60,170,310,600,1k,3k,6k,12k,14k,16k
    bassBoost: 0,               // 0 ~ 20 dB
    bassFreq: 100,              // Hz
    superBass: 0,               // -15 ~ 15 dB
    vocalBoost: 0,              // -15 ~ 15 dB
    treble: 0,                  // -15 ~ 15 dB
    normalizer: false,          // 음량 자동 정규화
    normalizerTarget: -18,      // dB
    surround: false,            // 3D 서라운드
    surroundDepth: 50,
    balance: 0,                 // -100 ~ 100
    replayGainMode: 'off',      // off | track | album
    channelMode: 'auto',        // auto | stereo | left | right | mono
    audioDelay: 0,              // ms
    crossfade: 0,               // 초
    outputDevice: 'default',
  },

  subtitle: {
    enabled: true,
    fontFamily: 'Malgun Gothic',
    fontSize: 24,
    fontColor: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 2,
    shadow: 1,
    bold: false,
    italic: false,
    opacity: 100,
    backgroundOpacity: 0,
    backgroundColor: '#000000',
    marginVertical: 42,         // 화면 하단 여백(px, 1080 기준)
    marginHorizontal: 60,
    alignment: 'bottom',        // bottom | top | middle
    readingMode: 'default',     // default | top | lrtb
    delay: 0,                   // ms
    speed: 1.0,
    autoDetect: true,
    preferredLanguages: ['ko', 'kor', 'korean', 'en', 'eng'],
    fontScaleFollowVideo: true,
    keepAspect: true,
    useSubtitleStyle: true,     // ASS 스타일 존중
  },

  hotkeys: {
    enabled: true,
    globalVolume: false,        // 앱 창 밖에서도 볼륨 조작
    globalPlayPause: false,
    globalNextPrev: false,
    map: structuredClone(DEFAULT_HOTKEYS),
  },

  /**
   * UI 상태 (렌더러가 자주 바꾸는 값)
   * - windowState : 창 위치/크기
   */
  uiState: {},

  playlist: {
    autoSave: true,
    autoSaveLimit: 200,
    showPanel: false,
    sort: 'none',              // none | name | size | date
    sortAsc: true,
    doubleClickAction: 'play', // play | enqueue | external
  },

  snapshot: {
    folder: '',                // 비우면 Pictures/Nova Player
    format: 'png',             // png | jpg
    quality: 95,
    filenamePattern: '{name}_{time}{index}',
    hideVideo: true,
    flash: true,
    sequential: true,
    includeTimestamp: true,
  },

  ffmpeg: {
    enabled: true,
    customPath: '',
    useForThumbnails: true,
    useForFrameStep: true,
    remuxFallback: true,       // 재생 실패 시 컨테이너 재 mux
    transcodeFallback: true,   // 그래도 실패 시 실시간 변환
    transcodeQuality: 'fast',  // fast | balanced | quality
    maxCacheMB: 2048,
    ffprobeEnabled: true,
  },

  privacy: {
    telemetry: false,          // 항상 false 유지 (코드에서 강제)
    checkUpdates: false,
    sendCrashReports: false,
    noNetwork: true,           // 재생 외 아웃바운드 통신 전면 차단
    historyMax: 50,
  },
};

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock: [5, 4, 2, -1, -2, 1, 4, 6, 6, 6],
  pop: [-1, 0, 2, 4, 3, 0, -1, -1, 0, 1],
  classical: [0, 0, 0, 0, 0, 0, -4, -4, -4, -5],
  club: [0, 0, 3, 4, 4, 4, 2, 0, 0, 0],
  dance: [6, 5, 2, 0, 1, 3, 4, 4, 3, 0],
  fullbass: [8, 8, 8, 5, 2, 0, -3, -5, -6, -7],
  fulltreble: [-6, -6, -6, -3, 1, 5, 8, 9, 9, 9],
  live: [-3, 0, 2, 3, 3, 3, 2, 1, 1, 1],
  party: [5, 5, 0, 3, 3, 3, 0, -2, -3, -3],
  pop2: [2, 4, 5, 4, 2, 0, -1, -1, 0, 1],
  soft: [3, 1, 0, -2, -3, -3, -2, 0, 2, 4],
  bassboost: [7, 6, 4, 1, 0, 0, 0, 0, 0, 0],
  karaoke: [0, 0, 0, -2, 4, 6, 6, 5, 0, 0],
};

module.exports = { DEFAULT_SETTINGS, DEFAULT_HOTKEYS, EQ_PRESETS };
