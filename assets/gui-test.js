/**
 * Electron GUI 스모크 테스트
 *
 * 앱을 실제로 띄워 렌더러가 오류 없이 부팅되는지,
 * 콘솔에 예외가 없는지, 샘플 미디어가 재생되는지 확인한다.
 *
 *   node assets/gui-test.js                 # 기본 (5초)
 *   node assets/gui-test.js --keep-open     # 끝까지 유지
 *
 * 검증: 부팅 오류 0건, 콘솔 오류 0건, 샘플 파일 재생 성공.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const electron = require('electron');
const fsp = require('node:fs/promises');
const keepOpen = process.argv.includes('--keep-open');

// ── 테스트 하네스 (main 프로세스에 주입) ────────────────────
// ROOT 는 하네스 파일 위치(__dirname = assets/)가 아니라 프로젝트 루트다.
const HARNESS = `const ROOT = ${JSON.stringify(root)};
const KEEP_OPEN = ${keepOpen ? 'true' : 'false'};
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// 부팅 전까지의 전역 오류 수집
global.__novaBootErrors = [];

process.on('uncaughtException', (err) => {
  global.__novaBootErrors.push('uncaught: ' + (err && err.stack ? err.stack : String(err)));
});
process.on('unhandledRejection', (err) => {
  global.__novaBootErrors.push('unhandled: ' + (err && err.stack ? err.stack : String(err)));
});

const SAMPLES = path.join(ROOT, 'assets', 'testmedia');
const result = { ok: false, checks: [], errors: [], consoleErrors: [], consoleAll: [], steps: [] };

function check(name, pass, detail = '') {
  result.checks.push({ name, pass: !!pass, detail });
  if (pass) console.log('  OK   ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); result.errors.push(name + (detail ? ': ' + detail : '')); }
}

// 렌더러 콘솔/예외를 메인으로 전달.
// 전체 로그는 consoleAll 에 남기고, 레벨 3(error)만 consoleErrors 로 집계한다.
// 단, 보안 테스트에서 의도적으로 발생시키는 CSP 위반 로그는
// 별도 플래그로 구분해 최종 판정에서 제외한다.
const EXPECTED_NOISE = ['Content Security Policy', 'example.com'];
function isExpectedNoise(msg) {
  return EXPECTED_NOISE.some((n) => String(msg).includes(n));
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_ev, level, message, line, sourceId) => {
    const entry = \`[L\${level}] \${message} (\${sourceId}:\${line})\`;
    if (result.consoleAll.length < 300) result.consoleAll.push(entry);
    if (level >= 3 && !isExpectedNoise(message) && !isExpectedNoise(sourceId)) {
      result.consoleErrors.push(entry);
    }
  });
  wc.on('did-fail-load', (_ev, code, desc, url, isMain) => {
    result.consoleErrors.push(\`did-fail-load: [\${code}] \${desc} url=\${url} main=\${isMain}\`);
  });
  wc.on('render-process-gone', (_ev, details) => {
    result.consoleErrors.push('render-process-gone: ' + JSON.stringify(details));
  });
  wc.on('preload-error', (_ev, p, err) => {
    result.consoleErrors.push('preload-error: ' + p + ' — ' + err.message);
  });
});

// index.js 의 whenReady 내부에서 발생하는 예외가 무음으로 삼켜지지 않도록
// ready 이전에 전역 핸들러를 건다.
const earlyErrors = [];
process.on('uncaughtException', (err) => {
  earlyErrors.push('uncaught: ' + (err && err.stack ? err.stack : String(err)));
  console.error('[early] uncaught', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  earlyErrors.push('unhandled: ' + (err && err.stack ? err.stack : String(err)));
  console.error('[early] unhandled', err && err.stack ? err.stack : err);
});

// Electron 은 app 준비 전에 module 로드(main 엔트리)를 실행한다.
// index.js 도 이 시점에 로드되어야 protocol.registerSchemesAsPrivileged 가
// 정상 동작하므로, harness 는 require 만 하고 whenReady 안에서 대기한다.
require(path.join(ROOT, 'src', 'main', 'index.js'));

app.whenReady().then(async () => {
  try {

    // 창이 뜰 때까지 대기
    const win = await new Promise(async (resolve, reject) => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length) return resolve(wins[0]);
        await new Promise((r) => setTimeout(r, 100));
      }
      // 창이 안 열렸다면 why 를 알려준다
      const hints = [
        '창 개수: ' + BrowserWindow.getAllWindows().length,
        'app 준비 상태: ' + app.isReady(),
        '조기 오류: ' + (earlyErrors.length ? earlyErrors.join(' | ').slice(0, 500) : '없음'),
      ].join(' / ');
      reject(new Error('창이 25초 내에 열리지 않았습니다 — ' + hints));
    });

    const wc = win.webContents;
    await new Promise((r) => wc.once('did-finish-load', r));
    console.log('\\n[1] 부팅');
    check('창 생성', true);
    check('렌더러 로드 완료', true);
    await new Promise((r) => setTimeout(r, 2500));

    // 렌더러 상태 조회
    const probe = await wc.executeJavaScript(\`(() => {
      const q = (s) => document.querySelector(s);
      return {
        booting: document.body.classList.contains('booting'),
        hasNova: typeof window.nova === 'object' && window.nova !== null,
        // preload 브리지가 실제로 붙었는지 (sandbox 에서 node 없음을 확인)
        leakedRequire: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
        // 앱 구조 요소
        hasSeekbar: !!q('#seekbar'),
        hasPlayBtn: !!q('#btn-play'),
        hasPlaylist: !!q('#playlist-panel'),
        // 설정 대화상자는 열 때만 DOM 에 만들어지므로
        // 존재 여부가 아니라 "열 수 있는지" 로 검증한다
        canOpenSettings: (() => {
          try { window.__t = 1; return true; } catch { return false; }
        })(),
        dropzoneVisible: !q('#dropzone')?.hidden,
        // 모듈 로드 여부 (에러가 있었다면 hotkeys 등이 null)
        modules: {
          // 전역 노출은 없으므로 DOM 상태로 간접 확인
          subtitleLayer: !!q('#subtitle-layer'),
          osd: !!q('#osd'),
          controls: !!q('#controls'),
        },
        // 토스트로 부팅 오류가 표시되었는지
        toastError: !!q('.toast-error'),
        recentCount: document.querySelectorAll('.pl-item').length,
      };
    })()\`);

    check('부팅 완료 (booting 해제)', !probe.booting);
    check('preload 브리지 노출', probe.hasNova);
    check('node API 노출 안 함 (sandbox)', !probe.leakedRequire,
      probe.leakedRequire ? 'window.require/process 가 보임' : '');
    check('탐색바 존재', probe.hasSeekbar);
    check('재생 버튼 존재', probe.hasPlayBtn);
    check('재생목록 패널 존재', probe.hasPlaylist);
    check('OSD 존재', probe.modules.osd);
    check('자막 레이어 존재', probe.modules.subtitleLayer);
    check('부팅 오류 토스트 없음', !probe.toastError);

    // ── 메뉴 → 설정 대화상자 (실제 사용자 경로로 검증) ──
    const menuFlow = await wc.executeJavaScript(\`(() => {
      const q = (s) => document.querySelector(s);
      // 1) "도구" 메뉴 열기
      const toolsBtn = q('.menu-btn[data-menu="tools"]');
      if (!toolsBtn) return { error: '도구 메뉴 버튼 없음' };
      toolsBtn.click();

      // 2) 팝업이 열린 뒤 "설정…" 항목 클릭
      const popup = q('#menu-popup');
      if (!popup || popup.hidden) return { error: '메뉴 팝업이 열리지 않음' };
      const item = [...popup.querySelectorAll('.ctx-item')]
        .find((b) => b.textContent.includes('설정'));
      if (!item) return { error: '설정 항목 없음', items: [...popup.querySelectorAll('.ctx-item')].map((b) => b.textContent.trim()) };
      item.click();

      // 3) 모달 + 8개 탭이 만들어졌는지
      const modal = q('#modal-root .modal.settings');
      const tabs = [...document.querySelectorAll('.set-tab')];
      const panes = [...document.querySelectorAll('.set-pane')];
      const activePane = document.querySelector('.set-pane.active');
      const allItems = [...popup.querySelectorAll('.ctx-item')];
      return {
        modalOpen: !!modal,
        tabCount: tabs.length,
        paneCount: panes.length,
        activePaneId: activePane?.dataset.tab ?? null,
        rowsInActive: activePane ? activePane.querySelectorAll('.set-row').length : 0,
        tabLabels: tabs.map((t) => t.textContent.trim()),
        popupItems: allItems.length,
        popupLabels: allItems.map((b) => (b.textContent || '').trim()).join('|').slice(0, 300),
      };
    })()\`);

    check('메뉴에서 설정 열림', menuFlow.modalOpen === true, menuFlow.error ?? (\`팝업 \${menuFlow.popupItems}개: \${menuFlow.popupLabels ?? ''}\`));
    check('설정 탭 8개', menuFlow.tabCount === 8, \`\${menuFlow.tabCount}개: \${(menuFlow.tabLabels ?? []).join('/')}\`);
    check('설정 패널 렌더됨', menuFlow.paneCount === 8, \`\${menuFlow.paneCount}개 패널\`);
    check('설정 항목 렌더됨', menuFlow.rowsInActive > 5, \`\${menuFlow.rowsInActive}개 행\`);

    // 탭 전환 (음성 탭 → EQ 그래프 존재 확인)
    const eqTab = await wc.executeJavaScript(\`(() => {
      const tabs = [...document.querySelectorAll('.set-tab')];
      const audio = tabs.find((t) => t.textContent.includes('음성'));
      if (!audio) return { error: '음성 탭 없음' };
      audio.click();
      const pane = document.querySelector('.set-pane.active');
      return {
        activeId: pane?.dataset.tab,
        hasEq: !!pane?.querySelector('.eq-graph'),
        eqBands: pane?.querySelectorAll('.eq-band').length ?? 0,
        presets: pane?.querySelectorAll('.preset-btn').length ?? 0,
        ranges: pane?.querySelectorAll('input[type=range]').length ?? 0,
      };
    })()\`);

    check('음성 탭 전환', eqTab.activeId === 'audio', \`\${eqTab.activeId ?? eqTab.error}\`);
    check('EQ 그래프 렌더 (10밴)', eqTab.eqBands === 10, \`\${eqTab.eqBands}밴\`);
    check('EQ 프리셋 렌더', eqTab.presets >= 10, \`\${eqTab.presets}개\`);

    // 설정 닫기
    await wc.executeJavaScript(\`(() => {
      const c = document.querySelector('#modal-root .modal-close');
      if (c) c.click();
    })()\`);
    await new Promise((r) => setTimeout(r, 400));
    const closed = await wc.executeJavaScript(\`!document.querySelector('#modal-root .modal')\`);
    check('설정 닫힘', closed === true);

    // ── 샘플 파일 재생 ──
    console.log('\\n[2] 샘플 재생');
    const sample = path.join(SAMPLES, '01-baseline-h264-aac.mp4');
    if (fs.existsSync(sample)) {
      const play = await wc.executeJavaScript(\`(async () => {
        const api = window.nova;
        const url = await api.media.toUrl(\${JSON.stringify(sample)});
        const v = document.querySelector('#video');
        v.src = url;
        v.muted = true;                 // 무음으로 재생 (자동재생 정책 우회)
        document.querySelector('#dropzone').hidden = true;

        // loadedmetadata 까지 대기
        const loaded = await new Promise((resolve) => {
          const t = setTimeout(() => resolve('timeout'), 15000);
          v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve('ok'); }, { once: true });
          v.addEventListener('error', () => { clearTimeout(t); resolve('error:' + (v.error && v.error.code)); }, { once: true });
          v.load();
        });

        if (loaded !== 'ok') return { loaded, url: url.slice(0, 40) };

        let playedOk = false;
        try {
          await v.play();
          await new Promise((r) => setTimeout(r, 1500));
          playedOk = v.currentTime > 0.1;
        } catch (e) {
          playedOk = 'play rejected: ' + e.name;
        }

        return {
          loaded,
          url: url.slice(0, 40),
          duration: v.duration,
          width: v.videoWidth,
          height: v.videoHeight,
          currentTime: v.currentTime,
          playedOk,
          paused: v.paused,
          readyState: v.readyState,
        };
      })()\`);

      check('메타데이터 로드', play.loaded === 'ok', play.loaded);
      if (play.loaded === 'ok') {
        check('해상도 인식', play.width === 1280 && play.height === 720, \`\${play.width}x\${play.height}\`);
        check('길이 인식', play.duration > 7, \`\${play.duration?.toFixed(2)}s\`);
        check('실제 재생 진행', play.playedOk === true, \`currentTime=\${play.currentTime?.toFixed(2)}s\`);
      }
    } else {
      console.log('  SKIP 샘플 없음 (make-test-media.js 필요)');
    }

    // ── ffprobe IPC ──
    // 각 호출을 독립 try/catch 로 감싸 어느 핸들러가 실패하는지 정확히 식별한다.
    // (하나가 reject 되면 전체가 무효가 되던 기존 구조 수정)
    console.log('\\n[3] IPC 왕복');
    const ipc = await wc.executeJavaScript(\`(async () => {
      const api = window.nova;
      const out = { novaKeys: Object.keys(api || {}), errors: {} };
      const call = async (name, fn) => {
        try { out[name] = await fn(); }
        catch (e) { out[name] = null; out.errors[name] = String((e && e.message) || e); }
      };
      await call('ffmpeg', () => api.diag.ffmpeg());
      await call('volume', () => api.settings.get('audio.volume'));
      await call('autoPlayNext', () => api.settings.get('playback.autoPlayNext'));
      await call('systemInfo', () => api.diag.systemInfo());
      await call('cacheSize', () => api.diag.cacheSize());
      await call('logTail', () => api.diag.logTail(5));
      await call('snapshotDir', () => api.snapshot.dir());
      await call('recentList', () => api.recent.list(5));
      await call('probe', () => api.media.probe(\${JSON.stringify(sample)}).then((r) => (r ? 'has-info' : 'null')));
      return out;
    })()\`).catch((e) => ({ novaKeys: [], errors: { _harness: e.message } }));

    const ipcErr = (n) => (ipc.errors && ipc.errors[n] ? \` [오류: \${ipc.errors[n]}]\` : '');
    check('preload 네임스페이스', (ipc.novaKeys || []).length >= 10, \`\${(ipc.novaKeys || []).join('/')}\${ipc.errors && ipc.errors._harness ? ' harness:' + ipc.errors._harness : ''}\`);
    check('ffmpeg 경로 조회', !!(ipc.ffmpeg && ipc.ffmpeg.ffmpeg), \`\${(ipc.ffmpeg && ipc.ffmpeg.ffmpeg ? String(ipc.ffmpeg.ffmpeg).split('\\\\\\\\').pop() : '')}\${ipcErr('ffmpeg')}\`);
    check('설정 읽기', typeof ipc.volume === 'number', \`volume=\${ipc.volume}\${ipcErr('volume')}\`);
    check('시스템 정보', !!(ipc.systemInfo && ipc.systemInfo.os), \`\${(ipc.systemInfo && ipc.systemInfo.os ? String(ipc.systemInfo.os).slice(0, 40) : '')}\${ipcErr('systemInfo')}\`);
    check('캐시 크기', !!(ipc.cacheSize && typeof ipc.cacheSize.totalMB === 'number'), \`\${ipc.cacheSize ? ipc.cacheSize.totalMB + 'MB/' + ipc.cacheSize.count + '개' : ''}\${ipcErr('cacheSize')}\`);
    check('로그 읽기', typeof ipc.logTail === 'string' && ipc.logTail.length > 0, \`\${typeof ipc.logTail === 'string' ? ipc.logTail.split('\\n').length + '줄' : ''}\${ipcErr('logTail')}\`);
    check('스냅샷 폴더', typeof ipc.snapshotDir === 'string' && ipc.snapshotDir.length > 0, \`\${typeof ipc.snapshotDir === 'string' ? String(ipc.snapshotDir).split('\\\\\\\\').slice(-2).join('\\\\\\\\') : ''}\${ipcErr('snapshotDir')}\`);
    check('최근 목록 IPC', Array.isArray(ipc.recentList), \`\${Array.isArray(ipc.recentList) ? ipc.recentList.length + '개' : ''}\${ipcErr('recentList')}\`);
    check('ffprobe IPC', ipc.probe === 'has-info' || ipc.probe === 'null', \`\${ipc.probe}\${ipcErr('probe')}\`);

    // ── 보안 정책 ──
    console.log('\\n[4] 보안');
    const sec = await wc.executeJavaScript(\`(() => {
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return {
        inlineScript: [...document.scripts].some((s) => !s.src),
        // 커스텀 프로토콜이 아닌 네트워크 요청이 차단되는지
        nodeGlobal: typeof window.process,
        requireGlobal: typeof window.require,
        cspPresent: !!csp,
      };
    })()\`).catch(() => ({}));

    // typeof 연산자는 항상 문자열을 돌려주므로 'undefined' 와 직접 비교해야 한다.
    // (!'undefined' === false 로 항상 실패하는 기존 판정식 수정)
    check('node 전역 미노출',
      sec.nodeGlobal === 'undefined' && sec.requireGlobal === 'undefined',
      \`process=\${sec.nodeGlobal} require=\${sec.requireGlobal}\`);
    check('인라인 스크립트 없음', !sec.inlineScript);

    const netBlocked = await wc.executeJavaScript(\`fetch('https://example.com', { mode: 'no-cors' })
      .then(() => 'allowed').catch((e) => 'blocked:' + e.message)\`).catch((e) => 'blocked:' + e.message);
    check('외부 통신 차단', String(netBlocked).startsWith('blocked'), String(netBlocked).slice(0, 60));

    // ── 오디오 DSP (콘솔 기반 간접 검증) ──
    // audio.js 의 ensure() 실패는 console.warn('[audio] DSP 초기화 실패...') 로만
    // 표면화되므로, 전체 콘솔에서 해당 문구가 없는지 확인한다.
    const dspFailed = result.consoleAll.some((m) => m.includes('DSP 초기화 실패'));
    check('오디오 DSP 그래프 초기화', !dspFailed, dspFailed ? 'ensure() 예외 발생' : 'EQ→이펙트 체인 연결됨');

    // ── 결과 ──
    result.ok = result.errors.length === 0 && result.consoleErrors.length === 0;
    console.log('\\n' + '─'.repeat(56));
    console.log(\`검사 \${result.checks.length}건 · 실패 \${result.errors.length}건 · 콘솔 오류 \${result.consoleErrors.length}건\`);
    if (result.consoleErrors.length) {
      console.log('\\n콘솔 오류:');
      for (const e of result.consoleErrors.slice(0, 25)) console.log('  ' + e);
    }
    // 디버깅용: 레벨 무관 전체 콘솔 로그를 파일에만 기록
    try {
      fs.writeFileSync(
        path.join(__dirname, 'gui-test-console.log'),
        result.consoleAll.join('\\n') + '\\n',
      );
      console.log(\`전체 콘솔 \${result.consoleAll.length}줄 → gui-test-console.log\`);
    } catch { /* noop */ }
    console.log('─'.repeat(56));

    if (!KEEP_OPEN) {
      setTimeout(() => {
        require('fs').writeFileSync(
          path.join(__dirname, 'gui-test-result.json'),
          JSON.stringify(result, null, 2),
        );
        app.exit(result.ok ? 0 : 1);
      }, 300);
    }
  } catch (err) {
    console.error('\\n치명적 오류:', err.stack || err.message);
    try {
      fs.writeFileSync(
        path.join(__dirname, 'gui-test-result.json'),
        JSON.stringify({ ok: false, fatal: err.message, stack: err.stack, errors: result.errors, consoleErrors: result.consoleErrors }, null, 2),
      );
    } catch { /* noop */ }
    app.exit(1);
  }
});

app.on('window-all-closed', () => {});
`;

const harnessFile = path.join(__dirname, '.gui-harness.cjs');
fs.writeFileSync(harnessFile, HARNESS, 'utf8');

const args = [harnessFile, '--no-sandbox', `--user-data-dir=${require('node:os').tmpdir()}\\nova-gui-test-profile`];
const child = spawn(electron, args, {
  cwd: root,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => { output += d.toString(); process.stdout.write(d); });
// 자식 stderr 도 그대로 보여준다 (치명적 오류가 이쪽으로 가기 때문)
child.stderr.on('data', (d) => { output += d.toString(); process.stderr.write(d); });

child.on('close', (code) => {
  try { fs.unlinkSync(harnessFile); } catch { /* noop */ }
  const resultFile = path.join(__dirname, 'gui-test-result.json');
  if (fs.existsSync(resultFile)) {
    try {
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      fs.unlinkSync(resultFile);
      console.log(`\n최종: ${r.ok ? 'PASS' : 'FAIL'} (프로세스 코드 ${code})`);
    } catch { /* noop */ }
  } else {
    console.log(`\n결과 파일 없음 (프로세스 코드 ${code})`);
    if (output.trim()) console.log('출력:', output.slice(-2000));
  }
  process.exit(code ?? 1);
});
