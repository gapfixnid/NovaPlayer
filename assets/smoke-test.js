/**
 * 헤드리스 스모크 테스트
 *   node assets/smoke-test.js
 *
 * 검증 항목
 *   1) main 모듈 로드 (문법 + 초기화 오류)
 *   2) 설정 저장/불일치 복원/프로토타입 오염 차단
 *   3) ffmpeg / ffprobe 경로 해석
 *   4) ffprobe 로 샘플 미디어 프로빙
 *   5) 자막 인코딩 디코딩 (UTF-8/EUC-KR 바이트→문자열)
 *   6) M3U 왕복 + 인젝션 차단, 위치 저장 검증
 *   7) 미디어 URL allowlist (발급-검증-미등록 차단)
 *
 * 주의: 자막 파서(SRT/VTT/ASS)와 오디오 DSP는 각각 logic-test.js와
 * gui-test.js에서 검증한다 (브라우저/ESM 의존).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// main 모듈은 app 이 준비돼야 하므로 앱 없이 쓸 수 있는 부분만 검사
const pathsModule = require('../src/main/paths.js');
const { initPaths, logger } = pathsModule;

// library 는 require 시점에 Library 인스턴스를 만들기 때문에
// global.novaPaths 가 먼저 준비되어야 한다.
const tmpEarly = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'nova-smoke-'),
);
initPaths(tmpEarly);
global.novaPaths = pathsModule.paths;
global.novaLog = logger;

const { JsonStore } = require('../src/main/store.js');
const { DEFAULT_SETTINGS } = require('../src/main/settings.js');
const ffmpeg = require('../src/main/ffmpeg.js');
const lib = require('../src/main/library.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name} — ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─────────────────────────────────────────────────────────────
console.log('\n[1] 경로 및 설정');
const tmp = tmpEarly;

check('paths 초기화', () => {
  assert(fs.existsSync(pathsModule.paths.cache), '캐시 디렉터리 미생성');
  return pathsModule.paths.userData === tmp ? '격리된 임시 경로 사용' : pathsModule.paths.userData;
});

check('JsonStore 기본값 병합', () => {
  const store = new JsonStore('smoke-settings.json', DEFAULT_SETTINGS);
  store.set('audio.volume', 55);
  store.set('video.brightness', 20);
  assert(store.get('audio.volume') === 55, '단일 키 저장 실패');

  // set() 은 디바운스되므로 즉시 flush 후 새 인스턴스로 영속성 확인
  store.save();
  const reloaded = new JsonStore('smoke-settings.json', DEFAULT_SETTINGS);
  assert(reloaded.get('audio.volume') === 55, `재로드 후 값 보존 실패 (got ${reloaded.get('audio.volume')})`);
  assert(reloaded.get('video.brightness') === 20, '중첩 키 보존 실패');
  assert(reloaded.get('audio.equalizerBands').length === 10, '배열 기본값 손상');
  return 'vol=55 brightness=20 (중첩 포함)';
});

check('JsonStore 알 수 없는 키 무시', () => {
  const store = new JsonStore('smoke-unknown.json', DEFAULT_SETTINGS);
  store.data.__evil = 'x';
  store.save();
  const reloaded = new JsonStore('smoke-unknown.json', DEFAULT_SETTINGS);
  assert(reloaded.data.__evil === undefined, '화이트리스트를 벗어난 키가 통과됨');
  return '악의 키 차단';
});

check('JsonStore 타입 불일치 무시', () => {
  const store = new JsonStore('smoke-type.json', DEFAULT_SETTINGS);
  store.data.audio.volume = 'not-a-number';
  store.save();
  const reloaded = new JsonStore('smoke-type.json', DEFAULT_SETTINGS);
  assert(typeof reloaded.get('audio.volume') === 'number', '타입 검증 실패');
  return '문자열 → 기본값 유지';
});

check('손상된 JSON 복구', () => {
  const f = path.join(tmp, 'smoke-corrupt.json');
  fs.writeFileSync(f, '{ this is not json', 'utf8');
  const store = new JsonStore('smoke-corrupt.json', { a: 1, b: 2 });
  assert(store.get('a') === 1, '손상 후 기본값 미적용');
  assert(fs.existsSync(`${f}.corrupt`), '손상 파일 보존 안 됨');
  return '.corrupt 로 보존';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[2] ffmpeg / ffprobe');
ffmpeg.resolveBinaries('');

check('ffmpeg 경로 해석', () => {
  assert(ffmpeg.hasFfmpeg(), 'ffmpeg 없음');
  const d = ffmpeg.describe();
  return d.ffmpeg;
});

check('ffprobe 경로 해석', () => {
  assert(ffmpeg.hasFfprobe(), 'ffprobe 없음');
  return ffmpeg.describe().ffprobe;
});

const mediaDir = path.join(__dirname, 'testmedia');
const samples = fs.existsSync(mediaDir)
  ? fs.readdirSync(mediaDir).filter((f) => /\.(mp4|mkv|avi|flv|webm|m4a|flac)$/i.test(f))
  : [];

if (samples.length) {
  console.log(`\n[3] ffprobe 프로빙 (${samples.length}개 샘플)`);
  const { execFileSync } = require('node:child_process');
  for (const f of samples) {
    check(`probe ${f}`, () => {
      const out = execFileSync(ffmpeg.describe().ffprobe, [
        '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', path.join(mediaDir, f),
      ], { encoding: 'utf8', timeout: 30000 });
      const info = ffmpeg.probe ? JSON.parse(out) : null;
      const v = info.streams.find((s) => s.codec_type === 'video');
      const a = info.streams.find((s) => s.codec_type === 'audio');
      const parts = [];
      if (v) parts.push(`${v.codec_name} ${v.width}x${v.height}`);
      if (a) parts.push(`${a.codec_name} ${a.channels}ch`);
      parts.push(`${Number(info.format.duration).toFixed(1)}s`);
      return parts.join(' · ');
    });
  }
} else {
  console.log('\n[3] ffprobe 프로빙 — 샘플 없음 (make-test-media.js 실행 필요), 건너뜀');
}

// ─────────────────────────────────────────────────────────────
console.log('\n[4] 텍스트 디코딩 (자막 인코딩)');
const subDir = path.join(mediaDir, 'subtitles');
if (fs.existsSync(subDir)) {
  check('UTF-8 SRT 디코딩', () => {
    // readTextSmart 는 비동기 — 동기 검증이 필요하므로 decodeSmart 에 직접 넣는다
    const text = lib.decodeSmart(fs.readFileSync(path.join(subDir, 'utf8.srt')));
    assert(typeof text === 'string', '문자열 반환 실패');
    assert(text.includes('한국어'), '한글 손실');
    return `${text.split('\n').length}행`;
  });

  if (fs.existsSync(path.join(subDir, 'euckr.srt'))) {
    check('EUC-KR SRT 디코딩', () => {
      const buf = fs.readFileSync(path.join(subDir, 'euckr.srt'));
      const text = lib.decodeSmart(buf);
      assert(text.includes('한국어'), '한글 손실 (CP949 디코딩 실패)');
      assert(!text.includes('�'), '치환문자(U+FFFD) 발생');
      return 'CP949 정상 복원';
    });
  }
} else {
  console.log('\n[4] 자막 디코딩 — 샘플 없음, 건너뜀');
}

// ─────────────────────────────────────────────────────────────
console.log('\n[5] 파일 분류 / M3U');
check('확장자 분류', () => {
  const cases = [
    ['a.mp4', lib.isVideoFile, true],
    ['a.mkv', lib.isVideoFile, true],
    ['a.mp3', lib.isAudioFile, true],
    ['a.flac', lib.isAudioFile, true],
    ['a.srt', lib.isSubtitleFile, true],
    ['a.ass', lib.isSubtitleFile, true],
    ['a.txt', lib.isMediaFile, false],
    ['a.exe', lib.isMediaFile, false],
  ];
  for (const [name, fn, expected] of cases) {
    assert(fn(name) === expected, `${name} 분류 오류`);
  }
  return `${cases.length}개 케이스`;
});

(async () => {
  try {
    const m3u = path.join(tmp, 'test.m3u');
    const items = [
      { path: path.join(mediaDir, '01-baseline-h264-aac.mp4'), name: 'first.mp4' },
      { path: path.join(mediaDir, '03-mkv-h264-aac.mkv'), name: 'second.mkv' },
    ].filter((i) => fs.existsSync(i.path));
    if (items.length) {
      await lib.writeM3u(m3u, items);
      const back = await lib.parseM3u(m3u);
      assert(back.length === items.length, `왕복 불일치 (${back.length} != ${items.length})`);
      check('M3U 저장→파싱', () => `${back.length}개 항목 왕복 성공`);
    }
  } catch (err) {
    check('M3U 저장→파싱', () => { throw err; });
  }

  // ─────────────────────────────────────────────────────────
  console.log('\n[6] 스냅샷 파일명');
  check('패턴 전개', () => {
    const name = lib.buildSnapshotName('{name}_{time}{index}', {
      name: 'my movie', hours: 9, minutes: 5, seconds: 3,
      year: 2026, month: 8, day: 28, index: 7,
    });
    assert(name === 'my movie_090503_007', `예상치 불일치: ${name}`);
    return name;
  });

  check('특수문자 제거', () => {
    const name = lib.buildSnapshotName('{name}', {
      name: 'a/b\\c:d*e?f"g<h>i|j', hours: 0, minutes: 0, seconds: 0,
      year: 2026, month: 0, day: 1, index: 0,
    });
    assert(!/[\\/:*?"<>|]/.test(name), `금지 문자 잔존: ${name}`);
    return name;
  });

  check('중복 회피 경로', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-snap-'));
    fs.writeFileSync(path.join(dir, 'shot.png'), 'x');
    const p = lib.uniquePath(dir, 'shot', '.png');
    assert(p !== path.join(dir, 'shot.png'), '중복 경로 반환');
    return path.basename(p);
  });

  // ─────────────────────────────────────────────────────────
  console.log('\n[6b] 보안 회귀');
  check('프로토타입 오염 차단 (도트 경로)', () => {
    const store = new JsonStore('smoke-poison.json', DEFAULT_SETTINGS);
    store.set('__proto__.polluted', 1);
    store.set('audio.__proto__.x', 1);
    assert({}.polluted === undefined, 'Object.prototype 오염됨');
    assert(store.get('audio.volume') === DEFAULT_SETTINGS.audio.volume, '정상값 손상');
    return '차단됨';
  });

  check('프로토타입 오염 차단 (패치 병합)', () => {
    const store = new JsonStore('smoke-poison2.json', DEFAULT_SETTINGS);
    store.set(JSON.parse('{"__proto__":{"pwn":1}}'));
    assert({}.pwn === undefined, '병합 경로 오염됨');
    return '차단됨';
  });

  check('위치 저장 비수치 거부', () => {
    lib.library.savePosition('C:\\test\\a.mp4', NaN, 'abc');
    const got = lib.library.getPosition('C:\\test\\a.mp4');
    assert(got === null || got === undefined, `오염 저장됨: ${JSON.stringify(got)}`);
    return '거부됨';
  });

  try {
    const evilM3u = path.join(tmp, 'evil.m3u');
    await lib.writeM3u(evilM3u, [{ path: path.join(tmp, 'a.mp4'), name: 'x\n#EXTINF:666,evil' }]);
    const evilLines = fs.readFileSync(evilM3u, 'utf8').split('\n');
    check('M3U 인젝션 차단', () => {
      assert(!evilLines.some((l) => l.startsWith('#EXTINF:666')), '위조 항목 삽입됨');
      return '개행 제거됨';
    });
  } catch (err) {
    check('M3U 인젝션 차단', () => { throw err; });
  }

  // eslint-disable-next-line global-require
  const protocol = require('../src/main/protocol.js');
  check('미디어 allowlist', () => {
    assert(typeof protocol.isAllowed === 'function', 'isAllowed 미노출');
    const f = path.join(tmp, 'allowed.mp4');
    fs.writeFileSync(f, 'x');
    const url = protocol.toMediaUrl(f);
    assert(protocol.isAllowed(f), '발급 직후 허용돼야 함');
    assert(!protocol.isAllowed(path.join(tmp, 'not-issued.mp4')), '미발급 경로 허용됨');
    assert(typeof url === 'string' && url.startsWith('nova-media://'), 'URL 형식');
    return '발급-검증-차단';
  });

  // ─────────────────────────────────────────────────────────
  console.log('\n[7] 정리');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`결과: 통과 ${pass} / 실패 ${fail}`);
  if (fail) {
    console.log('\n실패 상세:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  console.log('─'.repeat(56));
  process.exit(fail ? 1 : 0);
})();
