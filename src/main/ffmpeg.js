'use strict';
/**
 * ffmpeg / ffprobe 래퍼.
 *
 * 역할
 *  1) 번들된 ffmpeg·ffprobe 경로 해석 (asar 언팩 대응)
 *  2) ffprobe 로 미디어 정보 조회 (코덱/비트레이트/해상도 …)
 *  3) 재생 실패 시 재 mux(컨테이너만 교체) → 그래도 안 되면 실시간 트랜스코딩
 *  4) 탐색바용 썸네일 / 프레임 단위 이동용 프레임 추출
 *
 * 보안: 모든 인자는 spawn 옵션 배열로 전달되어 셸 해석을 거치지 않는다.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths, tempDir, logger } = require('./paths');

let ffmpegPath = null;
let ffprobePath = null;
let resolved = false;

/** asar 내부 경로 → 언팩된 실제 경로 */
function unasar(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`).replace('app.asar', 'app.asar.unpacked');
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    for (const variant of [c, unasar(c)]) {
      try { if (fs.existsSync(variant) && fs.statSync(variant).isFile()) return variant; } catch { /* noop */ }
    }
  }
  return null;
}

function resolveBinaries(customFfmpeg = '', customFfprobe = '') {
  if (resolved) return { ffmpegPath, ffprobePath };
  resolved = true;

  const isWin = process.platform === 'win32';
  const exe = isWin ? '.exe' : '';

  // 1) 사용자가 직접 지정한 경로 최우선
  ffmpegPath = firstExisting([
    customFfmpeg,
    process.env.NOVA_FFMPEG,
  ]);

  // 2) 번들된 정적 빌드
  if (!ffmpegPath) {
    try {
      const mod = require('ffmpeg-static');
      ffmpegPath = typeof mod === 'string' ? firstExisting([mod]) : null;
    } catch (err) {
      logger.warn(`ffmpeg-static 로드 실패: ${err.message}`);
    }
  }

  if (!ffprobePath) {
    try {
      const mod = require('ffprobe-static');
      ffprobePath = firstExisting([mod?.path]);
    } catch (err) {
      logger.warn(`ffprobe-static 로드 실패: ${err.message}`);
    }
  }

  // 3) 시스템 설치본 (PATH)
  if (!ffmpegPath) ffmpegPath = firstExisting(PATH_LOOKUP('ffmpeg'));
  if (!ffprobePath) ffprobePath = firstExisting(PATH_LOOKUP('ffprobe'));

  // ffprobe 가 없으면 ffmpeg 옆에 붙은 ffprobe 를 시도
  if (!ffprobePath && ffmpegPath) {
    const dir = path.dirname(ffmpegPath);
    const stem = path.basename(ffmpegPath).replace(/ffmpeg(\.exe)?$/i, '');
    ffprobePath = firstExisting([
      path.join(dir, `ffprobe${exe}`),
      path.join(dir, 'bin', `ffprobe${exe}`),
    ]);
  }

  if (ffmpegPath) logger.info(`ffmpeg: ${ffmpegPath}`);
  else logger.warn('ffmpeg 를 찾지 못했습니다 (네이티브 코덱만 사용합니다).');
  if (ffprobePath) logger.info(`ffprobe: ${ffprobePath}`);
  else logger.info('ffprobe 없음 - 미디어 정보 표시가 제한됩니다.');

  return { ffmpegPath, ffprobePath };
}

function PATH_LOOKUP(bin) {
  const isWin = process.platform === 'win32';
  const exe = isWin ? '.exe' : '';
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const extra = [
    'C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin',
    '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin',
  ];
  return [...extra, ...dirs].map((d) => path.join(d, bin + exe));
}

function reset() { resolved = false; ffmpegPath = null; ffprobePath = null; }

function hasFfmpeg() { return !!ffmpegPath; }
function hasFfprobe() { return !!ffprobePath; }

/**
 * 자식 프로세스 실행.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(bin, args, { timeout = 0, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('실행할 바이너리가 없습니다.'));
    let child;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 재생 중 사용자 입력을 가로채지 않도록 콘솔 숨김
        detached: false,
      });
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    let timer = null;
    let killedByTimeout = false;

    if (timeout > 0) {
      timer = setTimeout(() => { killedByTimeout = true; child.kill('SIGKILL'); }, timeout);
    }

    child.stdout.on('data', (d) => { if (stdout.length < 8 * 1024 * 1024) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      if (stderr.length < 4 * 1024 * 1024) stderr += s;
      onStderr?.(s);
    });

    const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* noop */ } };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => {
      cleanup();
      if (killedByTimeout) return reject(new Error('시간 초과로 종료되었습니다.'));
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// ffprobe
// ─────────────────────────────────────────────────────────────

/**
 * 미디어 상세 정보 조회.
 * @returns {Promise<object|null>}
 */
async function probe(filePath, { signal } = {}) {
  if (!ffprobePath) return null;
  try {
    const { code, stdout } = await run(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      filePath,
    ], { timeout: 45000, signal });

    if (code !== 0) return null;
    return normalizeProbe(JSON.parse(stdout));
  } catch (err) {
    logger.warn(`ffprobe 실패 (${path.basename(filePath)}): ${err.message}`);
    return null;
  }
}

function normalizeProbe(json) {
  const fmt = json.format ?? {};
  const streams = (json.streams ?? []).map((s) => ({
    index: s.index,
    type: s.codec_type,
    codec: s.codec_name,
    profile: s.profile,
    codecLongName: s.codec_long_name,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
    bitrate: Number(s.bit_rate ?? 0) || null,
    duration: Number(s.duration ?? 0) || null,
    channels: s.channels ?? null,
    channelLayout: s.channel_layout ?? null,
    sampleRate: Number(s.sample_rate ?? 0) || null,
    width: s.width ?? null,
    height: s.height ?? null,
    aspectRatio: s.display_aspect_ratio ?? null,
    frameRate: parseFrameRate(s.avg_frame_rate ?? s.r_frame_rate),
    pixFmt: s.pix_fmt ?? null,
    colorSpace: s.color_space ?? null,
    colorPrimaries: s.color_primaries ?? null,
    colorTransfer: s.color_transfer ?? null,
    videoRotation: extractRotation(s),
    isDefault: s.disposition?.default === 1,
    isForced: s.disposition?.forced === 1,
  }));

  const video = streams.find((s) => s.type === 'video' && s.codec !== 'mjpeg') ?? streams.find((s) => s.type === 'video') ?? null;
  const audio = streams.find((s) => s.type === 'audio') ?? null;
  const subs = streams.filter((s) => s.type === 'subtitle');

  const chapters = (json.chapters ?? []).map((c) => ({
    start: Number(c.start_time ?? 0),
    end: Number(c.end_time ?? 0),
    title: c.tags?.title ?? '',
  }));

  const duration = Number(fmt.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;

  return {
    duration,
    size: Number(fmt.size ?? 0) || 0,
    bitrate: Number(fmt.bit_rate ?? 0) || 0,
    formatName: fmt.format_long_name ?? fmt.format_name ?? '',
    nbStreams: streams.length,
    streams,
    video,
    audio,
    subtitles: subs,
    chapters,
    tags: fmt.tags ?? {},
  };
}

function parseFrameRate(rate) {
  if (!rate) return null;
  const [n, d] = String(rate).split('/').map(Number);
  if (!d) return n || null;
  const v = n / d;
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

function extractRotation(stream) {
  if (stream.side_data_list) {
    for (const sd of stream.side_data_list) {
      if (typeof sd.rotation === 'number') return Math.round(sd.rotation);
    }
  }
  const tag = stream.tags?.rotate;
  if (tag) return Math.round(Number(tag)) || 0;
  return 0;
}

// ─────────────────────────────────────────────────────────────
// 재생 폴백: 재 mux → 트랜스코딩
// ─────────────────────────────────────────────────────────────

function hashKey(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * 컨테이너만 교체(-c copy). 코덱 지원 문제는 해결 못 하지만
 * "mkv에 opus가 들어간 경우" "flv+h264" 같은 경우를 빠르게 살린다.
 */
async function remux(filePath, { signal } = {}) {
  if (!ffmpegPath) return null;
  const ext = (path.extname(filePath) || '.mkv').toLowerCase();
  const out = path.join(tempDir(), `remux_${hashKey(filePath, fs.statSync(filePath).mtimeMs, 'r')}.mkv`);
  try {
    const { code, stderr } = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', filePath,
      '-map', '0:v?', '-map', '0:a?', '-map', '0:s?',
      '-c', 'copy',
      '-f', 'matroska',
      out,
    ], { timeout: 20 * 60 * 1000, signal });
    if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
      logger.debug(`remux 실패: ${stderr.slice(0, 400)}`);
      return null;
    }
    logger.info(`remux 성공: ${path.basename(filePath)} → ${path.basename(out)}`);
    return out;
  } catch (err) {
    logger.warn(`remux 오류: ${err.message}`);
    return null;
  }
}

/**
 * 실시간 트랜스코딩으로 변환 (H.264 + AAC in MP4).
 * 거의 모든 입력 포맷을 살리는 최후 수단. 프로그레스 콜백 제공.
 * @param {object} opts
 * @param {number} opts.width 최대 폭
 * @param {number} opts.quality 0=fast 1=balanced 2=quality
 * @param {number} opts.audioBitrate
 */
async function transcode(filePath, opts = {}) {
  if (!ffmpegPath) return null;
  const { width = 1920, quality = 0, audioBitrate = '192k', onProgress, signal } = opts;

  const videoArgs = quality === 2
    ? ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '18', '-pix_fmt', 'yuv420p']
    : quality === 1
      ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p'];

  const out = path.join(tempDir(), `tc_${hashKey(filePath, quality, width)}.mp4`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    logger.info(`트랜스코딩 캐시 재사용: ${path.basename(out)}`);
    return { path: out, cached: true };
  }

  // 전체 길이 알아내기 위한 1차 패스 (빠름)
  const info = await probe(filePath, { signal });
  const total = info?.duration || 0;

  const args = [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    '-i', filePath,
    ...videoArgs,
    '-vf', `scale=-2:'min(${width},ih)'`,
    '-c:a', 'aac', '-b:a', audioBitrate, '-ac', '2',
    '-movflags', '+faststart',
    '-sn',
    '-f', 'mp4',
    out,
  ];

  try {
    const { code, stderr } = await run(ffmpegPath, args, {
      signal,
      timeout: 4 * 60 * 60 * 1000,
      onStderr: (chunk) => {
        if (!onProgress || !total) return;
        const m = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
        if (m) {
          const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          onProgress(Math.min(1, t / total), t, total);
        }
      },
    });
    if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
      logger.error(`트랜스코딩 실패: ${stderr.slice(-500)}`);
      return null;
    }
    logger.info(`트랜스코딩 완료: ${path.basename(out)}`);
    return { path: out, cached: false, duration: total };
  } catch (err) {
    logger.error(`트랜스코딩 오류: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 썸네일 / 프레임 추출
// ─────────────────────────────────────────────────────────────

/** 특정 시각의 프레임을 JPEG 로 추출 (프레임 단위 이동, 썸네일 공용) */
async function extractFrame(filePath, timeSec, { width = 480, quality = 4 } = {}) {
  if (!ffmpegPath || !Number.isFinite(timeSec)) return null;
  const out = path.join(tempDir(), `frame_${hashKey(filePath, timeSec.toFixed(3), width)}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  try {
    const { code } = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      // 정확히 지정한 프레임의 근사값: 앞 키프레임으로 빨리 감되 정확 위치에서 디코드
      '-ss', timeSec.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2:flags=fast_bilinear`,
      '-q:v', String(quality),
      '-f', 'image2',
      out,
    ], { timeout: 60000 });
    if (code !== 0 || !fs.existsSync(out)) return null;
    return out;
  } catch (err) {
    logger.debug(`프레임 추출 실패: ${err.message}`);
    return null;
  }
}

/** 탐색바용 스프라이트 시트 (가로 N칸) */
async function thumbnailStrip(filePath, count = 12, opts = {}) {
  if (!ffmpegPath) return null;
  const info = await probe(filePath);
  const duration = info?.duration || 0;
  if (!duration) return null;

  const { tileW = 160, tileH = 90, cols = 6 } = opts;
  const rows = Math.ceil(count / cols);
  const out = path.join(tempDir(), `strip_${hashKey(filePath, count, tileW)}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { file: out, cols, rows, count, duration };

  // 0.5% ~ 99.5% 구간에 균등 배치 (앞/뒤 검은 화면 회피)
  const startPct = 0.005;
  const spanPct = 0.99;

  try {
    const { code, stderr } = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', filePath,
      '-vf', `fps=${count}/(duration*${spanPct}),scale=${tileW}:${tileH},tile=${cols}x${rows}`,
      '-frames:v', '1',
      '-q:v', '5',
      '-f', 'image2',
      out,
    ], { timeout: 180000 });
    if (code !== 0 || !fs.existsSync(out)) {
      logger.debug(`썸네일 생성 실패: ${stderr.slice(0, 300)}`);
      return null;
    }
    return { file: out, cols, rows, count, duration, startPct, spanPct };
  } catch (err) {
    logger.debug(`썸네일 오류: ${err.message}`);
    return null;
  }
}

/** 실행 파일 위치 (진단 화면용) */
function describe() {
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath, available: hasFfmpeg() };
}

module.exports = {
  resolveBinaries, reset, hasFfmpeg, hasFfprobe, describe,
  probe, remux, transcode, extractFrame, thumbnailStrip, run, hashKey,
};
