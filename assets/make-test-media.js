/**
 * 테스트용 미디어 생성 스크립트 (개발 전용, 앱 번들에 포함되지 않음)
 *
 * ffmpeg-static 로 다양한 난이도의 샘플을 만들어 재생 복구 경로를 검증한다.
 *   node assets/make-test-media.js [outDir]
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ffmpeg = require('ffmpeg-static');
const outDir = process.argv[2] || path.join(__dirname, 'testmedia');
fs.mkdirSync(outDir, { recursive: true });

/** 소스 하나를 정의하고 여러 포맷으로 인코딩 */
const VIDEO_IN = [
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=8',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
];

const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-shortest'];

const TARGETS = [
  {
    name: '01-baseline-h264-aac.mp4',
    note: 'Chromium 네이티브 재생 (기준선)',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...AUDIO_ARGS],
    ext: 'mp4',
  },
  {
    name: '02-hevc-hvc1.mp4',
    note: 'HEVC — Windows/Chromium 지원 여부에 따라 네이티브 또는 변환 경로',
    args: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...AUDIO_ARGS],
    ext: 'mp4',
  },
  {
    name: '03-mkv-h264-aac.mkv',
    note: 'MKV 컨테이너 (네이티브 재생 가능)',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...AUDIO_ARGS],
    ext: 'mkv',
  },
  {
    name: '04-mpeg2video-mp2v.avi',
    note: 'MPEG-2 Video + MP2 — 구형 AVI, 변환 경로 검증용',
    args: ['-c:v', 'mpeg2video', '-b:v', '4000k', '-c:a', 'mp2', '-b:a', '192k', '-shortest'],
    ext: 'avi',
  },
  {
    name: '05-flv-h264.mp3.flv',
    note: 'FLV + MP3 — 구형 플래시 영상',
    args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'libmp3lame', '-b:a', '128k', '-shortest'],
    ext: 'flv',
  },
  {
    name: '06-audio-only-aac.m4a',
    note: '오디오 전용 (영상 UI 비활성 경로)',
    args: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
    ext: 'm4a',
    video: false,
  },
  {
    name: '07-audio-only-flac.flac',
    note: 'FLAC 무손실 오디오',
    args: ['-vn', '-c:a', 'flac'],
    ext: 'flac',
    video: false,
  },
  {
    name: '08-webm-vp9-opus.webm',
    note: 'WebM + VP9/Opus (네이티브)',
    args: ['-c:v', 'libvpx-vp9', '-b:v', '900k', '-speed', '8', '-c:a', 'libopus', '-b:a', '96k', '-shortest'],
    ext: 'webm',
  },
  {
    name: '09-10bit-hevc.mkv',
    note: '10bit HEVC — 하드웨어 가속이 없으면 소프트웨어 디코딩',
    args: ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p10le', '-x265-params', 'profile=main10:log-level=none', ...AUDIO_ARGS],
    ext: 'mkv',
  },
  {
    name: '10-interlaced-mpeg2.avi',
    note: '인터레이스 기록 영상 (자동 감지 검증용)',
    // top_field_first=1 로 인터레이스 플래그를 명시한다.
    // yuv420p 로 강제해야 AVI muxer 가 받아들인다.
    args: [
      '-flags', '+ilme+ildct', '-top', '1',
      '-c:v', 'mpeg2video', '-pix_fmt', 'yuv420p', '-b:v', '5000k',
      '-c:a', 'mp2', '-b:a', '192k', '-shortest',
    ],
    ext: 'avi',
  },
];

console.log(`ffmpeg: ${ffmpeg}`);
console.log(`출력: ${outDir}\n`);

let ok = 0;
for (const t of TARGETS) {
  const out = path.join(outDir, t.name);
  const inputs = t.video === false
    ? ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10']
    : VIDEO_IN;

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    ...t.args,
    '-t', '8',
    out,
  ];

  process.stdout.write(`생성 중: ${t.name.padEnd(32)} `);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 180000 });

  if (r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
    const size = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`OK (${size} KB) — ${t.note}`);
    ok += 1;
  } else {
    console.log(`FAILED — ${t.note}`);
    if (r.stderr) console.log('   ' + r.stderr.split('\n').slice(-3).join('\n   '));
  }
}

console.log(`\n완료: ${ok}/${TARGETS.length}개 생성됨`);
if (ok !== TARGETS.length) {
  // CI 실패 전파: 하나라도 실패하면 0이 아닌 종료 코드
  process.exitCode = 1;
}

// 자막 샘플도 함께 만든다 (SRT + ASS, 한국어)
const subs = path.join(outDir, 'subtitles');
fs.mkdirSync(subs, { recursive: true });

fs.writeFileSync(path.join(subs, 'sample.srt'), `1
00:00:00,500 --> 00:00:02,500
Nova Player 자막 테스트

2
00:00:03,000 --> 00:00:05,500
SRT 포맷 정상 표시
줄바꿈도 됩니다

3
00:00:06,000 --> 00:00:08,000
EUC-KR 인코딩 확인용 텍스트
`, 'utf8');

// ASS (스타일/위치/카라오케 태그 포함)
fs.writeFileSync(path.join(subs, 'sample.ass'), `[Script Info]
Title: Nova Player ASS 샘플
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Malgun Gothic,52,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2.4,1.2,2,60,60,44,1
Style: Top,Arial,44,&H0000FFFF,&H000000FF,&H00202020,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,8,60,60,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.30,0:00:02.50,Default,,0,0,0,,ASS 스타일 테스트
Dialogue: 0,0:00:03.00,0:00:05.50,Top,,0,0,0,,{\\pos(640,80)}위치 태그(\\pos)를 사용했습니다
Dialogue: 0,0:00:06.00,0:00:08.50,Default,,0,0,0,,{\\k40}카{\\k40}라{\\k60}오{\\k80}케
`, 'utf8');

// UTF-8 SRT
fs.writeFileSync(path.join(subs, 'utf8.srt'), `1
00:00:01,000 --> 00:00:04,000
한국어 자막이 정상적으로 보입니다

2
00:00:04,500 --> 00:00:07,500
UTF-8 인코딩 자막입니다
`, 'utf8');

// EUC-KR(CP949) SRT — 인코딩 자동 감지 경로 검증용.
// Node 의 Buffer 가 euc-kr 을 지원하지 않으므로 UTF-8 원본을 먼저 쓰고,
// 생성 후 PowerShell(.NET Encoding 949) 로 재인코딩한다.
fs.writeFileSync(path.join(subs, 'euckr.src.srt'), `1
00:00:01,000 --> 00:00:04,000
한국어 자막이 정상적으로 보입니다

2
00:00:04,500 --> 00:00:07,500
CP949 인코딩 자막입니다
`, 'utf8');
console.log(`\n[후처리] euckr.src.srt 를 CP949 로 변환하세요:`);
console.log(`  powershell -c "$e=[Text.Encoding]::GetEncoding(949); $t=[IO.File]::ReadAllText('${path.join(subs, 'euckr.src.srt').replace(/'/g, "''")}',[Text.Encoding]::UTF8); [IO.File]::WriteAllText('${path.join(subs, 'euckr.srt').replace(/'/g, "''")}',$t,$e)"`);

console.log(`자막 샘플: ${subs}`);
console.log('  - sample.srt (UTF-8 SRT)');
console.log('  - sample.ass (ASS, 스타일/위치/카라오케)');
console.log('  - utf8.srt (UTF-8)');
console.log('  - euckr.src.srt → euckr.srt (위 명령으로 CP949 변환)');
console.log('  - sample.vtt (WebVTT, 인라인 태그/cue 설정)');
console.log('  - sample.microdvd.sub (MicroDVD, 프레임 기반)');
console.log('  - sample.json (자체 JSON 형식)');

// WebVTT (2성분 시각 + 인라인 태그 + cue 설정)
fs.writeFileSync(path.join(subs, 'sample.vtt'), `WEBVTT

intro
00:01.000 --> 00:03.500 align:start position:10%
<c.yellow>강조</c> 텍스트

00:01:02.500 --> 00:01:05.000 size:80%
둘째 자막
`, 'utf8');

// MicroDVD ({시작프레임}{끝프레임}텍스트, | 는 줄바꿈, 25fps 기준)
fs.writeFileSync(path.join(subs, 'sample.microdvd.sub'), `{25}{100}첫 줄|둘째 줄
{125}{200}강조 {y:i}기울임{y:i} 끝
`, 'utf8');

// 자체 JSON 형식
fs.writeFileSync(path.join(subs, 'sample.json'), JSON.stringify({
  cues: [
    { start: 1, end: 3.5, text: 'JSON 자막 첫 줄' },
    { start: 62.5, end: 65, text: 'JSON 자막 둘째 줄', style: { bold: true } },
  ],
}, null, 2), 'utf8');
