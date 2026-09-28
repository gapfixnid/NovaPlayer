/** 개발용: 메뉴 열린 상태 스크린샷. node assets/shot-menu.js [menuId] [out.png] */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const electron = require('electron');
const menuId = process.argv[2] || 'file';
const outArg = process.argv[3] || 'shot-menu.png';
const out = path.isAbsolute(outArg) ? outArg : path.join(__dirname, outArg);

const HARNESS = `const ROOT = ${JSON.stringify(root)};
const OUT = ${JSON.stringify(out)};
const MENU = ${JSON.stringify(menuId)};
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
  const sel = '.menu-btn[data-menu="' + MENU + '"]';
  const clicked = await win.webContents.executeJavaScript(
    '(() => { const b = document.querySelector(' + JSON.stringify(sel) + '); if (b) b.click(); return !!b; })()'
  ).catch((e) => 'ERR:' + e.message);
  console.log('menu clicked: ' + clicked);
  await new Promise((r) => setTimeout(r, 500));
  try {
    const img = await win.webContents.capturePage();
    require('node:fs').writeFileSync(OUT, img.toPNG());
    console.log('saved ' + OUT);
  } catch (e) { console.error('capture failed: ' + e.message); app.exit(1); return; }
  app.exit(0);
});
app.on('window-all-closed', () => {});
`;

const harnessFile = path.join(__dirname, '.shot-menu-harness.cjs');
fs.writeFileSync(harnessFile, HARNESS, 'utf8');
// 테스트 전용 격리 프로필 (실제 사용자 설정과 충돌 방지 + 결정적 초기 상태)
const profileDir = path.join(require('node:os').tmpdir(), 'nova-shot-menu-profile');
const child = spawn(electron, [harnessFile, '--no-sandbox', `--user-data-dir=${profileDir}`], { cwd: root, stdio: 'inherit' });
child.on('close', (code) => {
  try { fs.unlinkSync(harnessFile); } catch { /* noop */ }
  process.exit(code ?? 1);
});
