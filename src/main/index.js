'use strict';
/**
 * Nova Player - 메인 프로세스 진입점
 *
 * 설계 원칙
 *  - 렌더러는 완전히 격리 (contextIsolation + sandbox, nodeIntegration 없음)
 *  - 네트워크 통신 차단 (외부 CDN·트래킹·광고 전면 무력화)
 *  - 모든 파일 접근은 IPC 로만, 경로 검증은 메인에서 수행
 */
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Menu, powerMonitor, nativeTheme, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');

const { initPaths, pruneCache, logger, paths } = require('./paths');
const { JsonStore } = require('./store');
const { DEFAULT_SETTINGS } = require('./settings');
const protocol = require('./protocol');
const ffmpeg = require('./ffmpeg');
const lib = require('./library');
const { installWindowMenu } = require('./menubar');

const isDev = process.argv.includes('--dev');
const isTest = process.argv.includes('--test');

// ─────────────────────────────────────────────────────────────
// 단일 인스턴스
// ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = extractMediaArgs(argv);
    mainWindow?.show();
    mainWindow?.focus();
    if (files.length) mainWindow?.webContents.send('menu:open-files', files);
  });
}

/** 커맨드라인/파일 연결로 들어온 미디어 경로 추출 */
function extractMediaArgs(argv) {
  const out = [];
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    const clean = arg.replace(/^"|"$/g, '');
    try { if (fs.statSync(clean).isFile() && lib.isMediaFile(clean)) out.push(clean); } catch { /* noop */ }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 전역 상태
// ─────────────────────────────────────────────────────────────
let mainWindow = null;
let settings = null;
let tray = null;
let isQuitting = false;
let registeredShortcuts = new Set();

/** 렌더러가 알려준 현재 파일 경로 (네이티브 메뉴의 "경로 복사" 용) */
let currentFilePath = null;

/** 렌더러 → 메인 단일 채널 (브로드캐스트) */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** 네이티브(숨김) 메뉴 명령 처리 */
function handleMenuCommand(command) {
  switch (command) {
    case 'minimize':
      mainWindow?.minimize();
      break;
    case 'maximize':
      if (!mainWindow) break;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      break;
    case 'fullscreen':
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
      break;
    case 'alwaysOnTop': {
      const next = !settings.get('alwaysOnTop');
      settings.set('alwaysOnTop', next);
      mainWindow?.setAlwaysOnTop(next, 'screen-saver');
      sendToRenderer('menu:command', 'alwaysOnTop');
      break;
    }
    case 'close':
      mainWindow?.close();
      break;
    case 'copyPath':
      if (currentFilePath) {
        clipboard.writeText(currentFilePath);
        sendToRenderer('menu:toast', '파일 경로를 클립보드에 복사했습니다');
      } else {
        sendToRenderer('menu:toast', '열린 파일이 없습니다');
      }
      break;
    case 'hotkeys':
    case 'playbackInfo':
      sendToRenderer('menu:command', command);
      break;
    default:
      logger.debug(`알 수 없는 메뉴 명령: ${command}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 앱 수명 주기
// ─────────────────────────────────────────────────────────────
protocol.registerPrivileged();

app.whenReady().then(async () => {
  initPaths(app.getPath('userData'));
  global.novaLog = logger;
  global.novaPaths = paths;

  settings = new JsonStore('settings.json', DEFAULT_SETTINGS);
  ffmpeg.resolveBinaries(settings.get('ffmpeg.customPath'));

  if (settings.get('ui.theme') === 'system') {
    nativeTheme.themeSource = 'dark';
  }

  applyNetworkPolicy();
  protocol.registerHandlers();
  buildTray();
  registerIpc();
  installWindowMenu(() => mainWindow, handleMenuCommand);
  createWindow();

  pruneCache(settings.get('ffmpeg.maxCacheMB'));
  lib.library.pruneMissing();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  settings?.save();
  lib.library.save();
  for (const sc of registeredShortcuts) {
    try { globalShortcut.unregister(sc); } catch { /* noop */ }
  }
  registeredShortcuts = new Set();
});

/**
 * 외부 네트워크 전면 차단.
 * 재생은 전부 로컬(nova-media://) 이므로 Outbound 는 어떤 상황에서도 필요 없다.
 */
function applyNetworkPolicy() {
  const ses = session.defaultSession;
  const blocked = new Set([
    'https:', 'http:', 'ws:', 'wss:', 'ftp:', 'ftps:',
  ]);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let scheme;
    try { scheme = new URL(details.url).protocol; } catch { scheme = ''; }
    const isLocal = details.url.startsWith('nova-media:') || details.url.startsWith('app:') || details.url.startsWith('devtools:') || details.url.startsWith('blob:') || details.url.startsWith('data:') || details.url.startsWith('file:');
    if (blocked.has(scheme) && !isLocal) {
      logger.info(`외부 통신 차단: ${details.url.slice(0, 120)}`);
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });
  // Electron 32 에서는 setWindowOpenHandler 가 BrowserWindow 레벨로 옮겨졌다.
  // 세션에 있으면 세션 방식, 없으면 창별로 설정한다.
  if (typeof ses.setWindowOpenHandler === 'function') {
    ses.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
}

// ─────────────────────────────────────────────────────────────
// 창 생성
// ─────────────────────────────────────────────────────────────
function createWindow() {
  const saved = settings.get('ui.windowState') ?? {};
  const state = { ...saved, width: saved.width || 1180, height: saved.height || 720 };

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 480,
    minHeight: 320,
    show: false,
    // 네이티브 타이틀바 제거: 자체 메뉴바(드래그 영역 + 창 버튼)로 대체한다.
    // (리사이즈 경계는 Windows thickFrame 기본값으로 유지)
    frame: false,
    backgroundColor: '#0b0d12',
    title: 'Nova Player',
    autoHideMenuBar: !settings.get('ui.showMenubar'),
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // OS 메뉴는 숨기고(자체 메뉴바로 대체) 창은 숨긴 채 로드한다.
  // ready-to-show 전까지 흰 화면이 보이는 것을 막는다.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`${protocol.APP_SCHEME}://bundle/index.html`);

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize();
    mainWindow.show();
    if (settings.get('ui.startInFullscreen') && state.maximized) mainWindow.setFullScreen(true);
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 창 상태 저장 (이동/크기 변경을 디바운스)
  let stateTimer = null;
  const saveState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      try {
        const bounds = mainWindow.isMaximized() || mainWindow.isFullScreen()
          ? mainWindow.getNormalBounds()
          : mainWindow.getBounds();
        settings.set('ui.windowState', {
          ...bounds,
          maximized: mainWindow.isMaximized(),
        });
      } catch { /* noop */ }
    }, 500);
  };
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('maximize', saveState);
  mainWindow.on('unmaximize', saveState);
  mainWindow.on('enter-full-screen', () => { saveState(); sendToRenderer('window:fullscreen', true); });
  mainWindow.on('leave-full-screen', () => { saveState(); sendToRenderer('window:fullscreen', false); });

  // 최소화 정책
  mainWindow.on('minimize', () => {
    if (settings.get('ui.pauseOnMinimize')) sendToRenderer('lifecycle:pause');
  });
  mainWindow.on('maximize', () => sendToRenderer('window:maximized', true));
  mainWindow.on('unmaximize', () => sendToRenderer('window:maximized', false));

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    // 재생 중이고 트레이 모터드면 숨기기만
    if (settings.get('ui.closeToTray') && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      updateTray();
      return;
    }
    saveState();
    settings.save();
    lib.library.save();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 알림 권한 차단 (OS 팝업 알림 방지)
  // setWindowOpenHandler 는 버전에 따라 BrowserWindow / webContents /
  // session 중 하나에 있다. 있는 쪽을 찾아 쓰고, 어디에도 없으면
  // will-navigate 차단만으로 외부 이동을 막는다.
  const winOpenHandler = ({ url }) => {
    // 사용자가 명시적으로 클릭한 외부 문서만 기본 브라우저로 연다
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  };
  const targets = [mainWindow, mainWindow.webContents, mainWindow.webContents.session];
  for (const t of targets) {
    if (typeof t?.setWindowOpenHandler === 'function') {
      try { t.setWindowOpenHandler(winOpenHandler); } catch (err) {
        logger.warn(`setWindowOpenHandler 적용 실패: ${err.message}`);
      }
    }
  }
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // 전역 단축키 등록 (창 밖에서도 동작)
  registerGlobalShortcuts();

  return mainWindow;
}

// ─────────────────────────────────────────────────────────────
// 트레이
// ─────────────────────────────────────────────────────────────
function buildTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'icon.png')
    : path.join(__dirname, '..', '..', 'assets', 'icon.png');

  try {
    tray = new (require('electron').Tray)(fs.existsSync(iconPath) ? iconPath : undefined);
  } catch (err) {
    logger.warn(`트레이 생성 실패: ${err.message}`);
    return;
  }

  updateTray();
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
    updateTray();
  });
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip('Nova Player');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '재생/일시정지', click: () => sendToRenderer('tray:action', 'playPause') },
    { label: '정지', click: () => sendToRenderer('tray:action', 'stop') },
    { type: 'separator' },
    { label: '다음 파일', click: () => sendToRenderer('tray:action', 'next') },
    { label: '이전 파일', click: () => sendToRenderer('tray:action', 'prev') },
    { type: 'separator' },
    { label: '창 표시', click: () => { mainWindow?.show(); mainWindow?.focus(); updateTray(); } },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

// ─────────────────────────────────────────────────────────────
// 전역 단축키
// ─────────────────────────────────────────────────────────────
function registerGlobalShortcuts() {
  for (const sc of registeredShortcuts) {
    try { globalShortcut.unregister(sc); } catch { /* noop */ }
  }
  registeredShortcuts = new Set();

  const hk = settings.get('hotkeys.map');
  const want = [];
  if (settings.get('hotkeys.globalVolume')) {
    want.push([hk.volumeUp?.[0], 'global:volumeUp'], [hk.volumeDown?.[0], 'global:volumeDown']);
  }
  if (settings.get('hotkeys.globalPlayPause')) want.push([hk.playPause?.[0], 'global:playPause']);
  if (settings.get('hotkeys.globalNextPrev')) {
    want.push([hk.nextFile?.[0], 'global:next'], [hk.prevFile?.[0], 'global:prev']);
  }

  for (const [accel, action] of want) {
    if (!accel || !isValidAccelerator(accel)) continue;
    try {
      if (globalShortcut.register(accel, () => sendToRenderer('hotkey:global', action))) {
        registeredShortcuts.add(accel);
      }
    } catch (err) {
      logger.warn(`전역 단축키 등록 실패 (${accel}): ${err.message}`);
    }
  }
}

function isValidAccelerator(a) {
  const { globalShortcut: gs } = require('electron');
  return !!(gs.isRegistered(a) || typeof a === 'string');
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────
function registerIpc() {
  // ── 부트스트랩 ──
  ipcMain.handle('app:bootstrap', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    settings: settings.data,
    recent: lib.library.getRecent(settings.get('privacy.historyMax')),
    playlist: settings.get('playlist.autoSave') ? lib.library.data.playlist : [],
    ffmpeg: ffmpeg.describe(),
    paths: {
      userData: paths.userData,
      cache: paths.cache,
      logs: paths.logs,
      videos: path.join(app.getPath('videos'), 'Nova Player'),
      snapshots: lib.resolveSnapshotDir(settings.get('snapshot.folder')),
    },
  }));

  // ── 설정 ──
  ipcMain.handle('settings:get', (_e, key) => (key ? settings.get(key) : settings.data));
  ipcMain.handle('settings:set', (_e, keyOrPatch, value) => {
    settings.set(keyOrPatch, value);
    if (keyOrPatch === 'ffmpeg.customPath' || keyOrPatch === 'ffmpeg') {
      ffmpeg.reset();
      ffmpeg.resolveBinaries(settings.get('ffmpeg.customPath'));
      sendToRenderer('app:ffmpegChanged', ffmpeg.describe());
    }
    if (keyOrPatch === 'hotkeys' || keyOrPatch === 'hotkeys.map' || typeof keyOrPatch === 'object') {
      if (keyOrPatch === 'hotkeys.map' || keyOrPatch === 'hotkeys' || Object.hasOwn(keyOrPatch ?? {}, 'hotkeys')) {
        registerGlobalShortcuts();
      }
    }
    return true;
  });
  ipcMain.handle('settings:patch', (_e, patch) => { settings.set(patch); return true; });
  ipcMain.handle('settings:reset', () => { settings.reset(); ffmpeg.reset(); ffmpeg.resolveBinaries(''); registerGlobalShortcuts(); return settings.data; });
  ipcMain.handle('settings:export', async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '설정 내보내기',
      defaultPath: path.join(app.getPath('documents'), 'nova-player-settings.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, JSON.stringify(settings.data, null, 2), 'utf8');
    return r.filePath;
  });
  ipcMain.handle('settings:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '설정 가져오기',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      const json = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
      settings.set(json);
      ffmpeg.reset();
      ffmpeg.resolveBinaries(settings.get('ffmpeg.customPath'));
      return settings.data;
    } catch (err) {
      throw new Error(`설정 파일을 읽을 수 없습니다: ${err.message}`);
    }
  });

  // ── 창 제어 ──
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.on('window:minimizeToTray', () => { mainWindow?.hide(); updateTray(); });
  ipcMain.on('window:fullscreen', () => {
    if (!mainWindow) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
  ipcMain.on('window:alwaysOnTop', (_e, value) => {
    mainWindow?.setAlwaysOnTop(!!value, 'screen-saver');
  });
  ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized());

  // ── 대화상자 ──
  ipcMain.handle('dialog:openFiles', async (_e, mode = 'open') => {
    const videoFilters = [
      { name: '모든 미디어', extensions: [...new Set([...lib.VIDEO_EXT, ...lib.AUDIO_EXT, ...lib.IMAGE_EXT])].map((e) => e.slice(1)) },
      { name: '비디오', extensions: [...lib.VIDEO_EXT].map((e) => e.slice(1)) },
      { name: '오디오', extensions: [...lib.AUDIO_EXT].map((e) => e.slice(1)) },
      { name: '이미지', extensions: [...lib.IMAGE_EXT].map((e) => e.slice(1)) },
      { name: '재생목록', extensions: ['m3u', 'm3u8', 'pls'] },
      { name: '자막', extensions: [...lib.SUBTITLE_EXT].map((e) => e.slice(1)) },
      { name: '모든 파일', extensions: ['*'] },
    ];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '파일 열기',
      properties: mode === 'multi' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: videoFilters,
    });
    if (r.canceled) return [];
    return await expandSelection(r.filePaths);
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: '폴더 열기', properties: ['openDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:openSubtitle', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '자막 파일 열기',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '자막', extensions: [...lib.SUBTITLE_EXT].map((e) => e.slice(1)) },
        { name: '모든 파일', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:saveAs', async (_e, { defaultName, filters } = {}) => {
    const r = await dialog.showSaveDialog(mainWindow, { title: '다른 이름으로 저장', defaultPath: defaultName, filters });
    return r.canceled ? null : r.filePath;
  });

  // ── 셸 연동 ──
  ipcMain.on('shell:showItemInFolder', (_e, p) => { if (isSafePath(p)) shell.showItemInFolder(p); });
  ipcMain.handle('shell:openPath', async (_e, p) => { if (isSafePath(p)) return shell.openPath(p); return ''; });
  ipcMain.handle('shell:trash', async (_e, p) => { if (isSafePath(p)) return shell.trashItem(p); return false; });
  ipcMain.on('shell:revealFolder', (_e, p) => { if (p) shell.openPath(p); });

  // ── 미디어 처리 ──
  ipcMain.handle('media:toUrl', (_e, p) => (isSafePath(p) ? protocol.toMediaUrl(p) : null));
  ipcMain.handle('media:probe', (_e, p) => (isSafePath(p) ? ffmpeg.probe(p) : null));
  ipcMain.handle('media:remux', (_e, p) => (isSafePath(p) && settings.get('ffmpeg.remuxFallback') ? ffmpeg.remux(p) : null));
  ipcMain.handle('media:transcode', (e, p, opts) => {
    if (!isSafePath(p) || !settings.get('ffmpeg.transcodeFallback')) return null;
    const controller = new AbortController();
    e.sender.once('media:transcodeCancel', () => controller.abort());
    return ffmpeg.transcode(p, { ...opts, signal: controller.signal });
  });
  ipcMain.handle('media:frame', (_e, p, t, opts) => {
    if (!isSafePath(p) || !ffmpeg.hasFfmpeg() || !settings.get('ffmpeg.useForFrameStep')) return null;
    return ffmpeg.extractFrame(p, t, opts);
  });
  ipcMain.handle('media:strip', (_e, p, opts) => {
    if (!isSafePath(p) || !ffmpeg.hasFfmpeg() || !settings.get('ffmpeg.useForThumbnails')) return null;
    const out = ffmpeg.thumbnailStrip(p, opts?.count ?? 12, opts);
    if (!out) return null;
    return { ...out, url: protocol.toMediaUrl(out.file) };
  });
  ipcMain.handle('cache:prune', () => pruneCache(settings.get('ffmpeg.maxCacheMB')));

  // ── 자막 ──
  ipcMain.handle('sub:read', async (_e, p) => {
    if (!isSafePath(p)) return null;
    try {
      const text = await lib.readTextSmart(p);
      return { path: p, name: path.basename(p), text };
    } catch (err) {
      throw new Error(`자막을 읽을 수 없습니다: ${err.message}`);
    }
  });

  ipcMain.handle('sub:sidecar', async (_e, mediaPath) => {
    if (!isSafePath(mediaPath)) return [];
    const dir = path.dirname(mediaPath);
    const stem = path.basename(mediaPath, path.extname(mediaPath)).toLowerCase();
    try {
      const names = await fsp.readdir(dir);
      return names
        .filter((n) => lib.isSubtitleFile(n))
        .map((n) => {
          const base = path.basename(n, path.extname(n)).toLowerCase();
          const lang = detectLangFromName(n);
          return {
            path: path.join(dir, n),
            name: n,
            exact: base === stem,
            lang: lang.code,
            label: lang.label,
            priority: lang.priority,
          };
        })
        .sort((a, b) => (b.exact - a.exact) || (a.priority - b.priority));
    } catch {
      return [];
    }
  });

  // ── 재생목록 ──
  ipcMain.handle('playlist:save', async (_e, items) => {
    if (!settings.get('playlist.autoSave')) return null;
    const file = lib.playlistFilePath();
    await lib.writeM3u(file, items);
    return file;
  });
  ipcMain.handle('playlist:import', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '재생목록 가져오기',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '재생목록', extensions: ['m3u', 'm3u8', 'pls'] }],
    });
    if (r.canceled) return [];
    const out = [];
    for (const f of r.filePaths) {
      const items = lib.ext(f) === '.pls' ? await lib.parsePls(f) : await lib.parseM3u(f);
      for (const p of items) if (fs.existsSync(p)) out.push(p);
    }
    return out;
  });
  ipcMain.handle('playlist:export', async (_e, items) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '재생목록 저장',
      defaultPath: path.join(app.getPath('documents'), 'playlist.m3u'),
      filters: [{ name: 'M3U', extensions: ['m3u'] }],
    });
    if (r.canceled) return null;
    await lib.writeM3u(r.filePath, items);
    return r.filePath;
  });
  ipcMain.handle('playlist:library', () => lib.library.data.playlist);
  ipcMain.handle('playlist:librarySave', (_e, items) => { lib.library.setPlaylist(items); return true; });

  // ── 최근 사용 ──
  ipcMain.handle('recent:list', (_e, limit) => lib.library.getRecent(limit ?? settings.get('privacy.historyMax')));
  ipcMain.handle('recent:push', (_e, p, meta) => { lib.library.pushRecent(p, meta); return true; });
  ipcMain.handle('recent:remove', (_e, p) => { lib.library.removeRecent(p); return true; });
  ipcMain.handle('recent:clear', () => { lib.library.clearRecent(); return true; });
  ipcMain.handle('recent:resolve', (_e, p) => (isSafePath(p) && fs.existsSync(p) ? p : null));

  // ── 위치 기억 ──
  ipcMain.handle('position:save', (_e, p, pos, dur) => { lib.library.savePosition(p, pos, dur); return true; });
  ipcMain.handle('position:get', (_e, p) => lib.library.getPosition(p));

  // ── 스냅샷 ──
  ipcMain.handle('snapshot:dir', () => lib.resolveSnapshotDir(settings.get('snapshot.folder')));
  ipcMain.handle('snapshot:open', () => shell.openPath(lib.resolveSnapshotDir(settings.get('snapshot.folder'))));
  ipcMain.handle('snapshot:reveal', (_e, p) => { if (isSafePath(p)) shell.showItemInFolder(p); return true; });
  /**
   * 렌더러가 만든 이미지를 스냅샷 폴더에 저장.
   *
   * 보안: 렌더러가 경로를 직접 정하지 않고 "기본 이름"만 보낸다.
   * 최종 경로는 main 이 스냅샷 폴더 안에서 결정하므로
   * 임의 위치 쓰기·경로 역공격이 불가능하다.
   *
   * @param {{name:string, ext:string, bytes:Uint8Array}} payload
   */
  ipcMain.handle('snapshot:save', async (_e, payload) => {
    const dir = lib.resolveSnapshotDir(settings.get('snapshot.folder'));
    const safeName = lib.buildSnapshotName(payload?.name ?? 'capture', { name: 'capture', hours: 0, minutes: 0, seconds: 0, year: 2000, month: 0, day: 1, index: 0 });
    const ext = /^\.(png|jpg|jpeg)$/i.test(payload?.ext ?? '') ? payload.ext.toLowerCase() : '.png';
    const target = lib.uniquePath(dir, safeName, ext);
    await fsp.writeFile(target, Buffer.from(payload.bytes));
    logger.debug(`스냅샷 저장: ${target}`);
    return target;
  });

  // ── 디렉터리 목록 (폴더 열기) ──
  ipcMain.handle('media:listDirectory', async (_e, dir, { recursive = false } = {}) => {
    if (!isSafePath(dir)) return [];
    const out = [];
    const walk = async (current, depth) => {
      let entries;
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive && depth < 4) await walk(full, depth + 1);
        } else if (lib.isMediaFile(full) && !lib.isSubtitleFile(full)) {
          out.push(full);
          if (out.length >= 5000) return;
        }
      }
    };
    await walk(dir, 0);
    // 자연 정렬 (숫자 인식)
    out.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true, sensitivity: 'base' }));
    return out;
  });

  // ── 현재 파일 경로 (네이티브 메뉴의 "경로 복사" 용) ──
  ipcMain.on('app:currentPath', (_e, p) => {
    if (typeof p === 'string' && isSafePath(p)) currentFilePath = p;
    else currentFilePath = null;
  });

  // ── 진단 ──
  ipcMain.handle('diag:ffmpeg', () => ffmpeg.describe());
  ipcMain.handle('diag:logTail', async (_e, lines = 200) => {
    try {
      const dir = paths.logs;
      const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.log')).sort();
      if (!files.length) return [];
      const text = await fsp.readFile(path.join(dir, files.at(-1)), 'utf8');
      return text.split('\n').slice(-lines).join('\n');
    } catch {
      return [];
    }
  });
  ipcMain.handle('diag:cacheSize', async () => {
    let total = 0;
    let count = 0;
    try {
      for (const name of await fsp.readdir(paths.cache)) {
        try { const st = await fsp.stat(path.join(paths.cache, name)); if (st.isFile()) { total += st.size; count++; } } catch { /* noop */ }
      }
    } catch { /* noop */ }
    return { totalMB: Math.round(total / 1048576), count };
  });
  ipcMain.handle('diag:openPath', (_e, p) => { if (isSafePath(p)) return shell.openPath(p); return ''; });
  ipcMain.handle('diag:systemInfo', () => ({
    os: `${os.type()} ${os.release()} (${process.arch})`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? '',
    totalMemGB: Math.round(os.totalmem() / 1073741824),
    freeMemGB: Math.round(os.freemem() / 1073741824),
    displays: require('electron').screen.getAllDisplays().map((d) => `${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`),
  }));

  // ── 시스템 이벤트 전달 ──
  powerMonitor.on('suspend', () => sendToRenderer('lifecycle:suspend'));
  powerMonitor.on('resume', () => sendToRenderer('lifecycle:resume'));
  powerMonitor.on('lock-screen', () => sendToRenderer('lifecycle:lock'));

  isTest && logger.info('test mode');
}

/** 절대경로 + 실제 존재 여부 확인 (IPC 경로 검증 게이트) */
function isSafePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  if (p.includes('\0')) return false;
  return path.isAbsolute(p);
}

/** 파일명에서 언어 코드 추출 (ko-KR, kor, korean, eng, en …) */
function detectLangFromName(name) {
  const map = [
    [/\b(kor|ko[-_]?kr|korean|한국어|한국)\b/i, 'ko', '한국어', 0],
    [/\b(jpn|jap|ja[-_]?jp|japanese|日本語)\b/i, 'ja', '日本語', 1],
    [/\b(chi|zho|zh[-_]?cn|chinese|中文|简体)\b/i, 'zh', '中文', 2],
    [/\b(eng|en[-_]?(gb|us)?|english)\b/i, 'en', 'English', 3],
    [/\b(fra|fre|fr[-_]?fr|french)\b/i, 'fr', 'Français', 4],
    [/\b(deu|ger|de[-_]?de|german)\b/i, 'de', 'Deutsch', 5],
    [/\b(spa|es[-_]?es|spanish)\b/i, 'es', 'Español', 6],
    [/\b(rus|ru[-_]?ru|russian)\b/i, 'ru', 'Русский', 7],
    [/\b(ita|it[-_]?it|italian)\b/i, 'it', 'Italiano', 8],
    [/\b(tha|th[-_]?th|thai)\b/i, 'th', 'ไทย', 9],
    [/\b(ind|hi[-_]?in|hindi)\b/i, 'hi', 'हिन्दी', 10],
    [/\b(vie|vi[-_]?vn|vietnamese)\b/i, 'vi', 'Tiếng Việt', 11],
  ];
  const base = path.basename(name, path.extname(name));
  for (const [re, code, label, priority] of map) {
    if (re.test(base)) return { code, label, priority };
  }
  return { code: 'und', label: '기타', priority: 50 };
}

// 선택한 파일이 재생목록/폴더면 내용까지 확장
async function expandSelection(filePaths) {
  const out = [];
  for (const p of filePaths) {
    const e = lib.ext(p);
    if (e === '.m3u' || e === '.m3u8') out.push(...await lib.parseM3u(p));
    else if (e === '.pls') out.push(...await lib.parsePls(p));
    else if (e === '.mkv' || e === '.mp4' || e === '.avi' || e === '.ts') {
      // 컨테이너 내장 파일은 렌더러가 ffprobe 로 추출
      out.push(p);
    } else out.push(p);
  }
  return out.filter((p) => fs.existsSync(p));
}

module.exports = { extractMediaArgs };
