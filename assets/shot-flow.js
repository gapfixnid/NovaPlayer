/** 개발용: 특정 UI 흐름 실행 후 스크린샷. node assets/shot-flow.js <about|fileinfo|help> [out.png] */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const electron = require('electron');
const flow = process.argv[2] || 'about';
const outArg = process.argv[3] || `shot-flow-${flow}.png`;
const out = path.isAbsolute(outArg) ? outArg : path.join(__dirname, outArg);

const FLOWS = {
  // 도움말 → Nova Player 정보 (설정 about 탭)
  about: `(async () => {
    const helpBtn = document.querySelector('.menu-btn[data-menu="help"]');
    if (!helpBtn) return 'no help btn';
    helpBtn.click();
    await new Promise((r) => setTimeout(r, 300));
    const items = [...document.querySelectorAll('#menu-popup .ctx-item')];
    const target = items.find((b) => (b.textContent || '').includes('Nova Player 정보'));
    if (!target) return 'no item, have: ' + items.map((b) => (b.textContent || '').trim()).join('|');
    target.click();
    await new Promise((r) => setTimeout(r, 800));
    const modal = document.querySelector('#modal-root .modal');
    const activePane = document.querySelector('.set-pane.active');
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent);
    return JSON.stringify({
      modal: !!modal,
      activeTab: activePane?.dataset.tab ?? null,
      paneChildren: activePane?.childElementCount ?? -1,
      paneText: (activePane?.textContent || '').slice(0, 120),
      toasts,
    });
  })()`,
  // 하단 컨트롤의 정보 버튼 (파일 정보)
  fileinfo: `(async () => {
    const btn = document.querySelector('#btn-info');
    if (!btn) return 'no btn-info';
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const modal = document.querySelector('#modal-root .modal');
    const toasts = [...document.querySelectorAll('.toast')].map((t) => t.textContent);
    return JSON.stringify({ modal: !!modal, modalText: (modal?.textContent || '').slice(0, 120), toasts });
  })()`,
  // 전체화면 진입 후 캡처 (영상전용 UI 검증)
  fullscreen: `(async () => {
    await window.nova.window.fullscreen();
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.stringify({
      isFullscreen: document.body.classList.contains('is-fullscreen'),
      menubarHidden: getComputedStyle(document.querySelector('.menubar')).display === 'none',
      playlistHidden: document.querySelector('#playlist-panel').hidden,
    });
  })()`,
};

const HARNESS = `const ROOT = ${JSON.stringify(root)};
const OUT = ${JSON.stringify(out)};
const FLOW_SRC = ${JSON.stringify(FLOWS[flow] ?? FLOWS.about)};
const FLOW = ${JSON.stringify(flow)};
const { app, BrowserWindow } = require('electron');
require(ROOT + '/src/main/index.js');
app.whenReady().then(async () => {
  const deadline = Date.now() + 25000;
  let win = null;
  while (Date.now() < deadline) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length) { win = wins[0]; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!win) { console.error('no window'); app.exit(1); return; }
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const probe = await win.webContents.executeJavaScript(FLOW_SRC);
    console.log('probe[' + FLOW + ']: ' + probe);
  } catch (e) { console.error('flow failed: ' + e.message); }
  await new Promise((r) => setTimeout(r, 400));
  try {
    const img = await win.webContents.capturePage();
    require('node:fs').writeFileSync(OUT, img.toPNG());
    console.log('saved ' + OUT);
  } catch (e) { console.error('capture failed: ' + e.message); app.exit(1); return; }
  app.exit(0);
});
app.on('window-all-closed', () => {});
`;

const harnessFile = path.join(__dirname, '.shot-flow-harness.cjs');
fs.writeFileSync(harnessFile, HARNESS, 'utf8');
const profileDir = path.join(require('node:os').tmpdir(), 'nova-shot-flow-profile');
const child = spawn(electron, [harnessFile, '--no-sandbox', `--user-data-dir=${profileDir}`], { cwd: root, stdio: 'inherit' });
child.on('close', (code) => {
  try { fs.unlinkSync(harnessFile); } catch { /* noop */ }
  process.exit(code ?? 1);
});
