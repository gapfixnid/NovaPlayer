'use strict';
/**
 * 프리로드 — 렌더러에 노출되는 유일한 브리지.
 *
 * 보안을 위해:
 *  - 어떤 값도 "임의 채널/IPC 호출" 로 확장할 수 없도록 액션별 함수만 노출
 *  - 구독 해제 함수(on/off 쌍)를 항상 함께 제공하여 리스너 누수 방지
 *  - 렌더러에는 Node/FileSystem/child_process 이 전혀 노출되지 않음
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 구독 관리: on() 이 반환한 disposer 로 확실히 해제 가능하게 한다 */
function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  // ── 앱 정보 ────────────────────────────────────────────
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  getVersion: () => process.versions,

  // ── 설정 ───────────────────────────────────────────────
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    patch: (obj) => ipcRenderer.invoke('settings:patch', obj),
    reset: () => ipcRenderer.invoke('settings:reset'),
    export: () => ipcRenderer.invoke('settings:export'),
    import: () => ipcRenderer.invoke('settings:import'),
  },

  // ── 창 제어 ────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    minimizeToTray: () => ipcRenderer.send('window:minimizeToTray'),
    fullscreen: () => ipcRenderer.send('window:fullscreen'),
    alwaysOnTop: (v) => ipcRenderer.send('window:alwaysOnTop', v),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },

  // ── 파일 ───────────────────────────────────────────────
  dialog: {
    openFiles: (mode) => ipcRenderer.invoke('dialog:openFiles', mode),
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openSubtitle: () => ipcRenderer.invoke('dialog:openSubtitle'),
    saveAs: (opts) => ipcRenderer.invoke('dialog:saveAs', opts),
  },

  shell: {
    showItemInFolder: (p) => ipcRenderer.send('shell:showItemInFolder', p),
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    trash: (p) => ipcRenderer.invoke('shell:trash', p),
    revealFolder: (p) => ipcRenderer.send('shell:revealFolder', p),
  },

  /**
   * 드래그&드롭된 File 객체의 실제 경로 추출.
   * (Electron 32 는 webUtils.getPathForFile 로 교체되어 file.path 가 제거됨)
   */
  getDroppedFilePath: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // ── 미디어 ─────────────────────────────────────────────
  media: {
    toUrl: (p) => ipcRenderer.invoke('media:toUrl', p),
    stat: (p) => ipcRenderer.invoke('media:stat', p),
    probe: (p) => ipcRenderer.invoke('media:probe', p),
    remux: (p) => ipcRenderer.invoke('media:remux', p),
    transcode: (p, opts) => ipcRenderer.invoke('media:transcode', p, opts),
    cancelTranscode: () => ipcRenderer.send('media:transcodeCancel'),
    frame: (p, t, opts) => ipcRenderer.invoke('media:frame', p, t, opts),
    strip: (p, opts) => ipcRenderer.invoke('media:strip', p, opts),
    pruneCache: () => ipcRenderer.invoke('cache:prune'),
    /** 폴더 내 미디어 파일 목록 */
    listDirectory: (dir, opts) => ipcRenderer.invoke('media:listDirectory', dir, opts),
  },

  // ── 자막 ───────────────────────────────────────────────
  subtitle: {
    read: (p) => ipcRenderer.invoke('sub:read', p),
    sidecar: (p) => ipcRenderer.invoke('sub:sidecar', p),
  },

  // ── 재생목록 ───────────────────────────────────────────
  playlist: {
    save: (items) => ipcRenderer.invoke('playlist:save', items),
    import: () => ipcRenderer.invoke('playlist:import'),
    export: (items) => ipcRenderer.invoke('playlist:export', items),
    library: () => ipcRenderer.invoke('playlist:library'),
    librarySave: (items) => ipcRenderer.invoke('playlist:librarySave', items),
  },

  // ── 최근 사용 / 위치 ───────────────────────────────────
  recent: {
    list: (limit) => ipcRenderer.invoke('recent:list', limit),
    push: (p, meta) => ipcRenderer.invoke('recent:push', p, meta),
    remove: (p) => ipcRenderer.invoke('recent:remove', p),
    clear: () => ipcRenderer.invoke('recent:clear'),
    resolve: (p) => ipcRenderer.invoke('recent:resolve', p),
  },
  position: {
    save: (p, pos, dur) => ipcRenderer.invoke('position:save', p, pos, dur),
    get: (p) => ipcRenderer.invoke('position:get', p),
  },

  // ── 스냅샷 ─────────────────────────────────────────────
  snapshot: {
    dir: () => ipcRenderer.invoke('snapshot:dir'),
    open: () => ipcRenderer.invoke('snapshot:open'),
    reveal: (p) => ipcRenderer.invoke('snapshot:reveal', p),
    /**
     * 스냅샷 저장. 최종 경로는 main 이 스냅샷 폴더 안에서 결정하므로
     * 렌더러는 "이름"만 보낸다 (임의 경로 쓰기·경로 역공격 차단).
     * @param {{name:string, ext:string, bytes:Uint8Array}} payload
     */
    save: (payload) => ipcRenderer.invoke('snapshot:save', payload),
  },

  // ── 진단 ───────────────────────────────────────────────
  diag: {
    ffmpeg: () => ipcRenderer.invoke('diag:ffmpeg'),
    logTail: (n) => ipcRenderer.invoke('diag:logTail', n),
    cacheSize: () => ipcRenderer.invoke('diag:cacheSize'),
    openPath: (p) => ipcRenderer.invoke('diag:openPath', p),
    systemInfo: () => ipcRenderer.invoke('diag:systemInfo'),
  },

  // ── 이벤트 구독 ────────────────────────────────────────
  on: {
    openFiles: (fn) => subscribe('menu:open-files', fn),
    trayAction: (fn) => subscribe('tray:action', fn),
    globalHotkey: (fn) => subscribe('hotkey:global', fn),
    windowMaximized: (fn) => subscribe('window:maximized', fn),
    fullscreen: (fn) => subscribe('window:fullscreen', fn),
    ffmpegChanged: (fn) => subscribe('app:ffmpegChanged', fn),
    pause: (fn) => subscribe('lifecycle:pause', fn),
    suspend: (fn) => subscribe('lifecycle:suspend', fn),
    resume: (fn) => subscribe('lifecycle:resume', fn),
    lock: (fn) => subscribe('lifecycle:lock', fn),
  },
};

contextBridge.exposeInMainWorld('nova', api);
