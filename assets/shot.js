/** 개발용 스크린샷: node assets/shot.js [out.png] */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const electron = require('electron');
const outArg = process.argv[2] || 'shot.png';
// 하네스 CWD 와 무관하게 항상 절대경로로 고정
const out = path.isAbsolute(outArg) ? outArg : path.join(__dirname, outArg);

const HARNESS = `const ROOT = ${JSON.stringify(root)};
const OUT = ${JSON.stringify(out)};
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
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const img = await win.webContents.capturePage();
    require('node:fs').writeFileSync(OUT, img.toPNG());
    console.log('saved ' + OUT + ' ' + img.getSize().width + 'x' + img.getSize().height);
  } catch (e) { console.error('capture failed: ' + e.message); app.exit(1); return; }
  app.exit(0);
});
app.on('window-all-closed', () => {});
`;

const harnessFile = path.join(__dirname, '.shot-harness.cjs');
fs.writeFileSync(harnessFile, HARNESS, 'utf8');
// 테스트 전용 격리 프로필
const profileDir = path.join(require('node:os').tmpdir(), 'nova-shot-profile');
const child = spawn(electron, [harnessFile, '--no-sandbox', `--user-data-dir=${profileDir}`], { cwd: root, stdio: 'inherit' });
child.on('close', (code) => {
  try { fs.unlinkSync(harnessFile); } catch { /* noop */ }
  process.exit(code ?? 1);
});
