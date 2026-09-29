/**
 * 브라우저 렌더러 로직 단위 테스트
 *   node assets/logic-test.js
 *
 * ES 모듈을 그대로 쓰기 위해 동적 import 를 사용한다.
 * DOM 에 의존하지 않는 모듈(파서/유틸/상수)만 검증한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const R = path.join(process.cwd(), 'src', 'renderer', 'scripts');

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
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const util = await import(pathToFileURL(path.join(R, 'util.js')).href);
const parser = await import(pathToFileURL(path.join(R, 'subtitles', 'parser.js')).href);

// ─────────────────────────────────────────────────────────────
console.log('\n[1] 시간/용량 포맷');

check('formatTime 기본 (항상 시까지)', () => {
  // 플레이어 UI 는 시간 표시가 흔들리지 않도록 기본적으로 시까지 표시한다
  const cases = [
    [0, '00:00:00'], [5, '00:00:05'], [59, '00:00:59'],
    [60, '00:01:00'], [3661, '01:01:01'], [36000, '10:00:00'],
    [-5, '00:00:00'], [NaN, '00:00:00'], [Infinity, '00:00:00'],
  ];
  for (const [input, expected] of cases) {
    const got = util.formatTime(input);
    assert(got === expected, `${input} → ${got} (기대 ${expected})`);
  }
  return `${cases.length}개 케이스`;
});

check('formatTime auto (1시간 미만만 MM:SS)', () => {
  assert(util.formatTime(65, { hours: 'auto' }) === '01:05', util.formatTime(65, { hours: 'auto' }));
  assert(util.formatTime(3665, { hours: 'auto' }) === '01:01:05', util.formatTime(3665, { hours: 'auto' }));
  assert(util.formatTime(65, { hours: false }) === '01:05', 'hours:false');
  return 'auto/false 모드';
});

check('formatTime ms', () => {
  const got = util.formatTime(3661.5, { ms: true });
  assert(got === '01:01:01.500', `got ${got}`);
  return got;
});

check('formatBitrate', () => {
  // 반올림으로 정보가 사라지지 않도록 소수점 2자리를 유지한다
  assert(util.formatBitrate(1536) === '1.54 Kbps', util.formatBitrate(1536));
  assert(util.formatBitrate(1_536_000) === '1.54 Mbps', util.formatBitrate(1_536_000));
  assert(util.formatBitrate(999) === '999 bps', util.formatBitrate(999));
  assert(util.formatBitrate(0) === '-', '0 처리');
  assert(util.formatBitrate(-1) === '-', '음수 처리');
  return '반올림 손실 없음';
});

check('formatSize', () => {
  assert(util.formatSize(0) === '0 B', util.formatSize(0));
  assert(util.formatSize(1023) === '1023 B', util.formatSize(1023));
  assert(util.formatSize(1024) === '1.00 KB', util.formatSize(1024));
  assert(util.formatSize(1536 * 1024) === '1.50 MB', util.formatSize(1536 * 1024));
  assert(util.formatSize(2 * 1024 ** 3) === '2.00 GB', util.formatSize(2 * 1024 ** 3));
  return 'B~TB';
});

check('baseName', () => {
  assert(util.baseName('C:\\videos\\a.mp4') === 'a.mp4', util.baseName('C:\\videos\\a.mp4'));
  assert(util.baseName('/home/u/a.mp4') === 'a.mp4', util.baseName('/home/u/a.mp4'));
  assert(util.baseName('C:\\videos\\') === 'videos', '끝 구분자');
  assert(util.baseName('a.mp4') === 'a.mp4', '구분자 없음');
  assert(util.baseName('') === '', '빈 값');
  return 'Win/POSIX 모두 처리';
});

check('dirName', () => {
  assert(util.dirName('C:\\videos\\a.mp4') === 'C:\\videos', util.dirName('C:\\videos\\a.mp4'));
  // 드라이브 루트는 "C:" — 빈 문자열로 두면 파일 탐색기가 엉뚱한 곳을 열게 된다
  assert(util.dirName('C:\\a.mp4') === 'C:', `드라이브 루트: ${util.dirName('C:\\a.mp4')}`);
  assert(util.dirName('/home/u/a.mp4') === '/home/u', util.dirName('/home/u/a.mp4'));
  assert(util.dirName('/a.mp4') === '/', `POSIX 루트: ${util.dirName('/a.mp4')}`);
  assert(util.dirName('a.mp4') === '', '구분자 없음');
  return '드라이브/POSIX 루트 구분';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[2] 단축키 정규화');

check('normalizeAccel 수정자 순서', () => {
  // 수정자는 항상 Control → Alt → Shift → Meta 순으로 정규화되어야
  // 같은 조합이 서로 다른 문자열로 저장되어 충돌 검사를 놓치는 일이 없어야 한다
  assert(util.normalizeAccel('Shift+Control+ArrowLeft') === 'Control+Shift+ArrowLeft', util.normalizeAccel('Shift+Control+ArrowLeft'));
  assert(util.normalizeAccel('Shift+Alt+Control+M') === 'Control+Alt+Shift+m', util.normalizeAccel('Shift+Alt+Control+M'));
  assert(util.normalizeAccel('Meta+Alt') === 'Alt+Meta', util.normalizeAccel('Meta+Alt'));
  return 'Control→Alt→Shift→Meta 순';
});

check('normalizeAccel 대소문자 무시', () => {
  // Shift+A 와 a 는 같은 키다. 정규화 결과가 같아야 충돌 검사가 정확하다
  assert(util.normalizeAccel('A') === util.normalizeAccel('a'), '단일 문자 대소문자 구분됨');
  assert(util.normalizeAccel('Shift+A') === 'Shift+a', util.normalizeAccel('Shift+A'));
  assert(util.normalizeAccel('F1') === util.normalizeAccel('f1'), '키 이름 대소문자 구분됨');
  return 'Shift+A ≡ Shift+a ≡ F1 ≡ f1';
});

check('accelFromEvent', () => {
  const mk = (init) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init });
  assert(util.accelFromEvent(mk({ key: ' ' })) === 'Space', 'Space 매핑');
  assert(util.accelFromEvent(mk({ key: 'a' })) === 'A', '소문자 → 대문자');
  assert(util.accelFromEvent(mk({ key: 'a', ctrlKey: true })) === 'Control+A', 'Ctrl 조합');
  assert(util.accelFromEvent(mk({ key: 'a', ctrlKey: true, altKey: true, shiftKey: true })) === 'Control+Alt+Shift+A', '3+ 조합');
  assert(util.accelFromEvent(mk({ key: 'ArrowLeft' })) === 'ArrowLeft', '특수 키');
  // 수정자만 누른 상태는 무시해야 캡처 UI 가 흔들리지 않는다
  assert(util.accelFromEvent(mk({ key: 'Control', ctrlKey: true })) === null, '수정자 단독');
  assert(util.accelFromEvent(mk({ key: 'Shift', shiftKey: true })) === null, 'Shift 단독');
  return '7개 케이스';
});

check('prettyKey', () => {
  assert(util.prettyKey('ArrowLeft') === '←', util.prettyKey('ArrowLeft'));
  assert(util.prettyKey('Control+Space') === 'Ctrl+Space', util.prettyKey('Control+Space'));
  assert(util.prettyKey('Shift+Period') === 'Shift+.', util.prettyKey('Shift+Period'));
  assert(util.prettyKey('') === '', '빈 값');
  return '사람이 읽는 형태로';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[3] SRT 파서');

const SRT = `1
00:00:01,000 --> 00:00:04,000
첫 번째 자막
두 번째 줄

2
00:00:05,500 --> 00:00:08,250
두 번째 자막
`;

check('SRT 기본 파싱', () => {
  const { cues, format } = parser.parseSubtitles(SRT);
  assert(format === 'srt', `포맷 ${format}`);
  assert(cues.length === 2, `cue 수 ${cues.length}`);
  assert(cues[0].start === 1 && cues[0].end === 4, `구간 ${cues[0].start}-${cues[0].end}`);
  assert(cues[1].end === 8.25, `소수 초 ${cues[1].end}`);
  assert(cues[0].text === '첫 번째 자막\n두 번째 줄', JSON.stringify(cues[0].text));
  return '구간/줄바꿈/소수점 정확';
});

check('SRT 번호 없는 형식', () => {
  const r = parser.parseSubtitles(`00:00:01,000 --> 00:00:02,000
내용`);
  assert(r.cues.length === 1, `cue 수 ${r.cues.length}`);
  assert(r.cues[0].text === '내용', r.cues[0].text);
  return '순번 없는 SRT 허용';
});

check('mergeOverlaps', () => {
  const { cues } = parser.parseSubtitles(`1
00:00:01,000 --> 00:00:05,000
A

2
00:00:03,000 --> 00:00:07,000
B
`);
  assert(cues.length === 2, `원본 ${cues.length}개`);

  const merged = parser.mergeOverlaps(cues);
  assert(merged.length === 1, `병합 결과 ${merged.length}`);
  assert(merged[0].text === 'A\nB', `내용 ${JSON.stringify(merged[0].text)}`);
  // 병합하면 시작은 첫 cue, 종료는 최댓값이어야 한다
  assert(merged[0].start === 1, `시작 ${merged[0].start}`);
  assert(merged[0].end === 7, `종료 ${merged[0].end}`);
  return '겹침 병합 + 구간 보정';
});

check('mergeOverlaps 겹치지 않으면 유지', () => {
  const { cues } = parser.parseSubtitles(`1
00:00:01,000 --> 00:00:03,000
A

2
00:00:05,000 --> 00:00:07,000
B
`);
  const merged = parser.mergeOverlaps(cues);
  assert(merged.length === 2, `병합됨 (${merged.length})`);
  return '정상 gap 유지';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[4] WebVTT 파서');

check('VTT 헤더/타임스탬프', () => {
  const vtt = `WEBVTT

intro
00:01.000 --> 00:03.500 align:start position:10%
<c.yellow>강조</c> 텍스트

2
00:05.000 --> 00:07.000
둘째`;
  const { cues, format } = parser.parseSubtitles(vtt);
  assert(format === 'vtt', format);
  assert(cues.length === 2, `cue 수 ${cues.length}`);
  // VTT 의 2성분 타임스탬프 (MM:SS.mmm) 를 정확히 읽어야 한다
  assert(cues[0].start === 1 && cues[0].end === 3.5, `구간 ${cues[0].start}-${cues[0].end}`);
  // <c.yellow> 의 클래스명이 색상명이면 #FFFF00 으로 해석
  assert(cues[0].style.color === '#FFFF00', `색상 ${cues[0].style.color}`);
  assert(cues[0].text === '강조 텍스트', JSON.stringify(cues[0].text));
  assert(cues[0].style.hAlignPct === 10, `정렬 ${cues[0].style.hAlignPct}`);
  return 'identify/2성분 시각/인라인 태그';
});

check('VTT 3성분 시각 + 정렬', () => {
  // cue 는 항상 start 오름차순으로 정렬되므로
  // 파일 내 순서와 무관하게 시간순으로 온다
  const { cues } = parser.parseSubtitles(`WEBVTT

00:01:02.500 --> 00:01:05.000
셋

00:00:08.000 --> 00:00:09.000
하나
`);
  assert(cues.length === 2, `cue 수 ${cues.length}`);
  assert(cues[0].start === 8, `정렬 후 첫 cue ${cues[0].start}`);
  assert(cues[0].text === '하나', cues[0].text);
  assert(cues[1].start === 62.5, `3성분 시각 ${cues[1].start}`);
  assert(cues[1].end === 65, `종료 ${cues[1].end}`);
  return 'HH:MM:SS 정확 + 시간순 정렬';
});

check('VTT 분 60 초과 올림', () => {
  // 일부 파일이 00:75:00 처럼 잘못된 시각을 쓰기도 한다
  const { cues } = parser.parseSubtitles(`WEBVTT

00:75:00.000 --> 00:76:00.000
과도
`);
  assert(cues[0].start === 4500, `75분 → ${cues[0].start}초 (기대 4500)`);
  return '분→시 자동 올림';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[5] ASS 파서');

const ASS = `[Script Info]
Title: test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Malgun Gothic,48,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,60,60,44,1
Style: Top,Arial,36,&H0000FFFF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,0,8,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,첫 줄
Dialogue: 0,0:00:04.00,0:00:06.00,Top,,0,0,0,,{\\pos(640,80)}위치 지정
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\k40}카{\\k40}라{\\k60}오
`;

check('ASS 스타일/이벤트', () => {
  const { cues, format } = parser.parseSubtitles(ASS);
  assert(format === 'ass', format);
  assert(cues.length === 3, `cue 수 ${cues.length}`);
  assert(cues[0].text === '첫 줄', JSON.stringify(cues[0].text));
  assert(cues[0].style.bold === true, '굵게 미적용');
  assert(cues[0].style.size === 48, `크기 ${cues[0].style.size}`);
  assert(cues[0].style.color === '#FFFFFF', `색상 ${cues[0].style.color}`);
  return '스타일/굵게/크기/색상';
});

check('ASS \\pos 위치', () => {
  const { cues } = parser.parseSubtitles(ASS);
  assert(cues[1].style.pos, '위치 태그 미파싱');
  assert(cues[1].style.pos.x === 640 && cues[1].style.pos.y === 80, JSON.stringify(cues[1].style.pos));
  return 'pos(640,80)';
});

check('ASS \\k 카라오케', () => {
  const { cues } = parser.parseSubtitles(ASS);
  const cue = cues[2];
  assert(cue.karaoke, '카라오케 세그먼트 없음');
  assert(cue.karaoke.length === 3, `세그먼트 ${cue.karaoke?.length}`);
  assert(cue.karaoke.map((k) => k.text).join('') === '카라오', `텍스트 ${cue.karaoke.map((k) => k.text).join('')}`);

  // \k 값은 centisecond 단위. 카 Cue 는 7.00초에 시작하므로
  // 세그먼트 시각은 7.00 → 7.40 → 7.80 → 8.40 이어야 한다.
  const expected = [
    { start: 7.00, end: 7.40 },
    { start: 7.40, end: 7.80 },
    { start: 7.80, end: 8.40 },
  ];
  cue.karaoke.forEach((k, i) => {
    assert(Math.abs(k.start - expected[i].start) < 1e-6, `#${i} start ${k.start} (기대 ${expected[i].start})`);
    assert(Math.abs(k.end - expected[i].end) < 1e-6, `#${i} end ${k.end} (기대 ${expected[i].end})`);
  });

  // 태그는 제거된 순수 텍스트로 남아야 한다
  assert(cue.text === '카라오', JSON.stringify(cue.text));
  return `3개 세그먼트 · 절대 시각 ${expected.map((e) => e.start.toFixed(2)).join('→')}`;
});

check('ASS \\N 줄바꿈', () => {
  const { cues } = parser.parseSubtitles(`[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,위\\N아래
`);
  assert(cues[0].text === '위\n아래', JSON.stringify(cues[0].text));
  return '\\N → 개행';
});

check('assColorToCss', () => {
  const { color, alpha } = parser.assColorToCss('&H00FF8000');
  assert(color === '#0080FF', `색상 ${color}`);
  assert(alpha === 1, `알파 ${alpha}`);
  const t = parser.assColorToCss('&H80000000');
  assert(Math.abs(t.alpha - (1 - 0x80 / 255)) < 1e-6, `반투명 ${t.alpha}`);
  return '&HAABBGGRR → #RRGGBB';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[6] 활성 cue 탐색 (커서 최적화)');

check('findActiveCues 정방향', () => {
  const { cues } = parser.parseSubtitles(SRT);
  let r = parser.findActiveCues(cues, 2, 0);
  assert(r.active.length === 1 && r.active[0].index === 1, `활성 ${r.active.length}`);
  r = parser.findActiveCues(cues, 5, r.hint);
  assert(r.active.length === 0, '구간 밖에서 활성');
  r = parser.findActiveCues(cues, 6, r.hint);
  assert(r.active.length === 1 && r.active[0].index === 2, '두 번째 구간 진입 실패');
  return '커서 유지 탐색';
});

check('findActiveCues 되감기', () => {
  const { cues } = parser.parseSubtitles(SRT);
  // 끝까지 갔던 커서로 되감았을 때도 정확해야 한다 (힌트 무효화 처리 검증)
  let r = parser.findActiveCues(cues, 6, 0);
  r = parser.findActiveCues(cues, 2, r.hint);
  assert(r.active.length === 1 && r.active[0].index === 1, `되감기 실패: ${JSON.stringify(r.active.map((c) => c.index))}`);
  return '커서 역행 보정';
});

check('겹치는 cue 동시 활성화', () => {
  const { cues } = parser.parseSubtitles(`1
00:00:00,000 --> 00:00:10,000
A

2
00:00:05,000 --> 00:00:15,000
B
`);
  const r = parser.findActiveCues(cues, 7, 0);
  assert(r.active.length === 2, `동시 활성 ${r.active.length}`);
  return '겹침 유지';
});

check('빈 배열 안전', () => {
  const r = parser.findActiveCues([], 5, 0);
  assert(r.active.length === 0, '빈 배열에서 예외');
  return '예외 없음';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[7] MicroDVD / 포맷 판별');

check('MicroDVD', () => {
  const src = `{100}{250}첫 줄|{y:i}강조|둘째 줄{250}{400}다음`;
  const { cues, format } = parser.parseSubtitles(src, { fps: 25 });
  assert(format === 'microdvd', format);
  assert(cues[0].start === 4 && cues[0].end === 10, `구간 ${cues[0].start}-${cues[0].end}`);
  return '프레임 → 초 변환';
});

check('포맷 자동 판별', () => {
  assert(parser.detectFormat('WEBVTT\n\n00:00.000 --> 00:01.000\nx') === 'vtt', 'vtt');
  assert(parser.detectFormat('[Script Info]\nx') === 'ass', 'ass');
  assert(parser.detectFormat('1\n00:00:01,000 --> 00:00:02,000\nx') === 'srt', 'srt');
  assert(parser.detectFormat('{"cues":[]}') === 'json', 'json');
  return '4종';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[8] 경계/오류 입력');

check('빈 문자열', () => {
  const r = parser.parseSubtitles('');
  assert(Array.isArray(r.cues), 'cue 배열 아님');
  assert(r.cues.length === 0, '빈 입력에서 cue 발생');
  return '예외 없음';
});

check('깨진 타임스탬프 무시', () => {
  const { cues } = parser.parseSubtitles(`1
노네 --> 노네
내용

2
00:00:05,000 --> 00:00:06,000
정상
`);
  assert(cues.length === 1, `유효 cue ${cues.length}`);
  assert(cues[0].text === '정상', cues[0].text);
  return '비정상 구간 스킵';
});

check('음수/역순 구간', () => {
  const { cues } = parser.parseSubtitles(`1
00:00:10,000 --> 00:00:05,000
역순
`);
  assert(cues[0].end >= cues[0].start, `end<start: ${cues[0].start}-${cues[0].end}`);
  return '자동 보정';
});

check('대용량 처리 (10,000 cue)', () => {
  const parts = [];
  for (let i = 0; i < 10000; i++) {
    const s = i * 2;
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    parts.push(`${i + 1}\n${h}:${m}:${ss},000 --> ${h}:${m}:${String((s + 2) % 60).padStart(2, '0')},000\n자막 ${i}`);
  }
  const t0 = Date.now();
  const { cues } = parser.parseSubtitles(parts.join('\n\n'));
  const parseMs = Date.now() - t0;

  assert(cues.length === 10000, `cue 수 ${cues.length}`);

  // 전 구간을 훑으며 활성 cue 조회
  const t1 = Date.now();
  let hint = 0;
  let found = 0;
  for (let t = 0; t < 20000; t += 0.25) {
    const r = parser.findActiveCues(cues, t, hint);
    hint = r.hint;
    found += r.active.length;
  }
  const scanMs = Date.now() - t1;
  assert(found > 0, '활성 cue 미발견');
  return `파싱 ${parseMs}ms · 80,000회 조회 ${scanMs}ms`;
});

// ─────────────────────────────────────────────────────────────
console.log('\n[9] 단축키-액션 정합성 (회귀 가드)');

check('DEFAULT_HOTKEYS 전 키가 actions에 존재', () => {
  const settingsSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'settings.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(R, 'main.js'), 'utf8');

  // DEFAULT_HOTKEYS 블록 안에서 2칸 들여쓰기 key: 수집
  const hkStart = settingsSrc.indexOf('const DEFAULT_HOTKEYS = {');
  const hkEnd = settingsSrc.indexOf('\n};', hkStart);
  assert(hkStart >= 0 && hkEnd > hkStart, 'DEFAULT_HOTKEYS 블록 미발견');
  const hkBlock = settingsSrc.slice(hkStart, hkEnd);
  const hkKeys = [...hkBlock.matchAll(/^  ([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  assert(hkKeys.length > 40, `단축키 ${hkKeys.length}개 (너무 적음)`);

  // actions 리터럴 + Object.assign 별칭에서 2칸 들여쓰기 key: 수집
  // (들여쓰기가 깊은 중첩 객체 프로퍼티와 구분)
  const actionKeys = new Set(
    [...mainSrc.matchAll(/^  ([A-Za-z0-9_]+):/gm)].map((m) => m[1]),
  );

  const missing = hkKeys.filter((k) => !actionKeys.has(k));
  assert(missing.length === 0, `미구현 액션: ${missing.join(', ')}`);
  return `${hkKeys.length}개 단축키 전부 매핑`;
});

// ─────────────────────────────────────────────────────────────
console.log('\n[10] 자막 시계 (앵커 상대 모델)');

check('기본 매핑 (1x, 지연 없음)', () => {
  const t = util.computeSubTime(10, { anchorMedia: 0, anchorSub: 0, speed: 1, delayMs: 0 });
  assert(t === 10, `got ${t}`);
  return 't 그대로';
});

check('지연은 절대 오프셋', () => {
  const t = util.computeSubTime(10, { anchorMedia: 0, anchorSub: 0, speed: 2, delayMs: 500 });
  // (10-0)*2 + 0.5 = 20.5 — 지연은 배속 밖에 더해진다
  assert(t === 20.5, `got ${t}`);
  return '+0.5s 이동';
});

check('배속 변경 시 연속성 (핵심 회귀)', () => {
  // 10초 지점에서 1x → 2x로 바꿔도 표시 시각이 뛰지 않아야 한다
  const before = { anchorMedia: 0, anchorSub: 0, speed: 1, delayMs: 0 };
  assert(util.computeSubTime(10, before) === 10, '변경 전 10s');
  const after = util.reanchorSubClock(before, 10);
  assert(after.anchorMedia === 10 && after.anchorSub === 10, `앵커 ${after.anchorMedia}/${after.anchorSub}`);
  const clock2x = { ...after, speed: 2 };
  assert(util.computeSubTime(10, clock2x) === 10, '변경 직후도 10s');
  assert(util.computeSubTime(11, clock2x) === 12, '1초 뒤 12s (2x 진행)');
  // 구방식(t*speed)은 10→20으로 뛰었을 것
  return '점프 없음, 이후 2x 진행';
});

check('되감기·점프 후에도 선형 유지', () => {
  const clock = { anchorMedia: 10, anchorSub: 10, speed: 2, delayMs: 0 };
  assert(util.computeSubTime(0, clock) === -10, `0초 → ${util.computeSubTime(0, clock)}`);
  assert(util.computeSubTime(100, clock) === 190, `100초 → ${util.computeSubTime(100, clock)}`);
  return '앵커 기준 선형';
});

check('지연 변경은 즉시 이동 (앵커 유지)', () => {
  const clock = { anchorMedia: 10, anchorSub: 10, speed: 1, delayMs: 0 };
  const shifted = { ...clock, delayMs: 1000 };
  assert(util.computeSubTime(15, clock) === 15, '변경 전');
  assert(util.computeSubTime(15, shifted) === 16, '지연 +1s 즉시 반영');
  return '+1s shift';
});

// ─────────────────────────────────────────────────────────────
console.log('\n[11] 파서 강건성 (회귀 가드)');

check('MicroDVD 파이프 개행', () => {
  const { cues } = parser.parseSubtitles('{25}{100}첫 줄|둘째 줄', { fps: 25 });
  assert(cues.length === 1, `cue 수 ${cues.length}`);
  assert(cues[0].text === '첫 줄\n둘째 줄', JSON.stringify(cues[0].text));
  assert(!cues[0].text.includes('|'), '리터럴 파이프 잔존');
  return '줄바꿈 변환';
});

check('첫 cue 이전 되감기 크래시 없음', () => {
  const { cues } = parser.parseSubtitles(`1
00:00:05,000 --> 00:00:07,000
A

2
00:00:10,000 --> 00:00:12,000
B
`);
  let r = parser.findActiveCues(cues, 11, 0);
  assert(r.active.length === 1, '11초 활성');
  r = parser.findActiveCues(cues, 0, r.hint);
  assert(r.active.length === 0, '0초 비활성');
  return '예외 없이 빈 활성';
});

check('비정상 수치 cue 탈락', () => {
  const { cues } = parser.parseSubtitles('{"cues": [{"start": "abc", "end": null, "text": "x"}]}');
  assert(cues.length === 0, `통과 ${cues.length}개`);
  return 'NaN cue 제거';
});

check('JSON style 프로토타입 차단', () => {
  const evil = '{"cues": [{"start": 1, "end": 2, "text": "x", "style": {"__proto__": {"pwn": 1}}}]}';
  parser.parseSubtitles(evil);
  assert({}.pwn === undefined, '프로토타입 오염됨');
  return '차단됨';
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(56)}`);
console.log(`결과: 통과 ${pass} / 실패 ${fail}`);
if (fail) {
  console.log('\n실패 상세:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
}
console.log('─'.repeat(56));

// 임시 파일 정리 (스모크 테스트 잔여물)
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-logic-'));
  fs.rmSync(tmp, { recursive: true, force: true });
} catch { /* noop */ }

process.exit(fail ? 1 : 0);
