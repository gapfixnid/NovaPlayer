'use strict';
/**
 * 라이브러리 관리: 재생목록 영속화, 최근 사용 목록, M3U/PLS 임포트·익스포트,
 * 스냅샷 폴더 결정, 위치 기억(이어보기).
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { paths, logger } = require('./paths');
const { JsonStore } = require('./store');

/** Library 인스턴스 (지연 생성 — paths 초기화 후 첫 접근 시점에 만들어진다) */
let instance = null;

const MEDIA_EXT = new Set([
  // 비디오 컨테이너
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.qt', '.wmv', '.asf', '.flv', '.f4v',
  '.mpg', '.mpeg', '.mpe', '.m2v', '.mpv', '.m2ts', '.mts', '.ts', '.vob', '.3gp', '.3g2',
  '.rm', '.rmvb', '.ogv', '.divx', '.dv', '.nsv', '.fli', '.flc', '.mxf', '.roq', '.y4m',
  // 오디오
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.wma', '.ogg', '.oga', '.opus', '.ape',
  '.alac', '.mka', '.ac3', '.dts', '.amr', '.mid', '.midi', '.spx', '.tta', '.dsf', '.dff',
  // 이미지 시퀀스 (이미지 플레이어 지원)
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff', '.tif', '.avif',
  // 자막
  '.srt', '.vtt', '.ass', '.ssa', '.sub', '.smi', '.idx', '.sup', '.lrc',
]);

const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.qt', '.wmv', '.asf', '.flv', '.f4v',
  '.mpg', '.mpeg', '.mpe', '.m2v', '.mpv', '.m2ts', '.mts', '.ts', '.vob', '.3gp', '.3g2',
  '.rm', '.rmvb', '.ogv', '.divx', '.dv', '.nsv', '.fli', '.flc', '.mxf', '.roq', '.y4m',
]);

const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.smi', '.sup', '.idx', '.lrc']);

const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.wma', '.ogg', '.oga', '.opus', '.ape',
  '.alac', '.mka', '.ac3', '.dts', '.amr', '.mid', '.midi', '.spx', '.tta', '.dsf', '.dff',
]);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff', '.tif', '.avif']);

const ext = (p) => path.extname(p || '').toLowerCase();

function isMediaFile(p) { return MEDIA_EXT.has(ext(p)); }
function isVideoFile(p) { return VIDEO_EXT.has(ext(p)); }
function isAudioFile(p) { return AUDIO_EXT.has(ext(p)); }
function isSubtitleFile(p) { return SUBTITLE_EXT.has(ext(p)); }
function isImageFile(p) { return IMAGE_EXT.has(ext(p)); }

class Library extends JsonStore {
  constructor() {
    super('library.json', {
      recent: [],            // [{path, name, at, duration, position}]
      playlist: [],          // [{path, name, addedAt, duration}]
      playbackPositions: {}, // "경로" → {position, duration, at}
      volume: 80,
    });
  }

  // ── 최근 사용 ────────────────────────────────────────────
  pushRecent(filePath, meta = {}) {
    if (!filePath) return;
    const list = this.data.recent.filter((r) => r.path !== filePath);
    list.unshift({
      path: filePath,
      name: path.basename(filePath),
      dir: path.dirname(filePath),
      at: Date.now(),
      duration: meta.duration ?? 0,
    });
    this.data.recent = list.slice(0, 200);
    this.scheduleSave();
  }

  getRecent(limit = 50) { return this.data.recent.slice(0, limit); }

  removeRecent(filePath) {
    this.data.recent = this.data.recent.filter((r) => r.path !== filePath);
    this.scheduleSave();
  }

  clearRecent() {
    this.data.recent = [];
    this.save();
  }

  /** 더 이상 존재하지 않는 항목 제거 (외부 삭제 대응) */
  pruneMissing() {
    const before = this.data.recent.length;
    this.data.recent = this.data.recent.filter((r) => fs.existsSync(r.path));
    if (this.data.recent.length !== before) this.scheduleSave();
  }

  // ── 재생목록 ─────────────────────────────────────────────
  setPlaylist(items) {
    this.data.playlist = items.map((it) => ({
      path: it.path,
      name: it.name ?? path.basename(it.path),
      addedAt: it.addedAt ?? Date.now(),
      duration: it.duration ?? 0,
    }));
    this.scheduleSave();
  }

  addToPlaylist(filePaths) {
    const existing = new Set(this.data.playlist.map((i) => i.path));
    for (const p of filePaths) {
      if (existing.has(p)) continue;
      this.data.playlist.push({ path: p, name: path.basename(p), addedAt: Date.now(), duration: 0 });
      existing.add(p);
    }
    this.scheduleSave();
    return this.data.playlist.length;
  }

  // ── 재생 위치 기억 ────────────────────────────────────────
  savePosition(filePath, position, duration) {
    if (!filePath) return;
    // 비수치(NaN·문자열) 입력은 저장하지 않는다 (JSON null 오염 방지)
    const p = Number(position);
    const d = Number(duration);
    if (!Number.isFinite(p) || p < 0) return;
    const key = filePath.toLowerCase();
    this.data.playbackPositions[key] = {
      p: Math.floor(p),
      d: Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0,
      at: Date.now(),
    };
    this.scheduleSave(1500);
  }

  getPosition(filePath) {
    if (!filePath) return null;
    return this.data.playbackPositions[key(filePath)] ?? null;
  }

  clearPosition(filePath) {
    delete this.data.playbackPositions[key(filePath)];
    this.scheduleSave();
  }
}

function key(p) { return String(p).toLowerCase(); }

// ─────────────────────────────────────────────────────────────
// M3U / PLS 파서
// ─────────────────────────────────────────────────────────────

/** M3U(확장 M3U 포함) 파싱 → 절대경로 배열 */
async function parseM3u(filePath) {
  const text = await readTextSmart(filePath);
  const base = path.dirname(filePath);
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // #EXTINF 앞의 상대경로도 그대로 처리
    const resolved = path.isAbsolute(line) ? line : path.resolve(base, line);
    if (isMediaFile(resolved)) out.push(resolved);
  }
  return out;
}

/** PLS(INI 형태) 파싱 */
async function parsePls(filePath) {
  const text = await readTextSmart(filePath);
  const files = [];
  const re = /^File\d+\s*=\s*(.+)$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    if (v && isMediaFile(v)) files.push(v);
  }
  return files;
}

function playlistFilePath(title = 'Nova Player') {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(paths.playlistAutoSave, `${safe}.m3u`);
}

async function writeM3u(filePath, items) {
  const lines = ['#EXTM3U'];
  const clean = (s) => String(s ?? '').replace(/[\r\n]/g, ' ').slice(0, 1024);
  for (const it of items) {
    if (!it || typeof it.path !== 'string') continue;
    lines.push(`#EXTINF:-1,${clean(it.name ?? path.basename(it.path))}`);
    lines.push(clean(it.path));
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

// ─────────────────────────────────────────────────────────────
// 인코딩 자동 판별 텍스트 읽기 (한국어 자막 EUC-KR/CP949 대응)
// ─────────────────────────────────────────────────────────────

const ENCODING_CANDIDATES = [
  'utf-8', 'euc-kr', 'cp949', 'shift-jis', 'euc-jp', 'gb18030', 'big5', 'windows-1252', 'iso-8859-1',
];

async function readTextSmart(filePath) {
  const buf = await fsp.readFile(filePath);
  return decodeSmart(buf);
}

function decodeSmart(buf) {
  // BOM 확인
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }

  // UTF-8 유효성 검사
  if (isValidUtf8(buf)) return new TextDecoder('utf-8').decode(buf);

  // 한국어 자막 대다수 = CP949/EUC-KR
  for (const enc of ['euc-kr', 'shift-jis', 'gb18030', 'big5', 'windows-1252']) {
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(buf);
      const bad = (text.match(/\ufffd/g) ?? []).length;
      if (bad / Math.max(1, text.length) < 0.005) return text;
    } catch { /* 지원 안 하는 인코딩 */ }
  }
  return new TextDecoder('windows-1252').decode(buf);
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 스냅샷 폴더 / 파일명
// ─────────────────────────────────────────────────────────────

function defaultSnapshotDir() {
  const pictures = path.join(os.homedir(), 'Pictures');
  const dir = path.join(pictures, 'Nova Player');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

function resolveSnapshotDir(configured) {
  if (configured && fs.existsSync(configured)) {
    try { fs.mkdirSync(configured, { recursive: true }); return configured; } catch { /* noop */ }
  }
  return defaultSnapshotDir();
}

/**
 * 파일명 패턴 전개: {name} {time} {index} {date} {ext}
 */
function buildSnapshotName(pattern, ctx) {
  const pad = (n, w = 3) => String(n).padStart(w, '0');
  const hhmmss = `${pad(ctx.hours, 2)}${pad(ctx.minutes, 2)}${pad(ctx.seconds, 2)}`;
  return String(pattern || '{name}_{time}')
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{time\}/g, hhmmss)
    .replace(/\{hh\}/g, pad(ctx.hours, 2))
    .replace(/\{mm\}/g, pad(ctx.minutes, 2))
    .replace(/\{ss\}/g, pad(ctx.seconds, 2))
    .replace(/\{date\}/g, `${ctx.year}${pad(ctx.month + 1, 2)}${pad(ctx.day, 2)}`)
    .replace(/\{index\}/g, ctx.index > 0 ? `_${pad(ctx.index, 3)}` : '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 180);
}

/** 디렉터리 내 유일한 파일 경로 (충돌 시 _1, _2 …) */
function uniquePath(dir, baseName, extName) {
  let candidate = path.join(dir, `${baseName}${extName}`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName}_${n}${extName}`);
    n += 1;
    if (n > 9999) break;
  }
  return candidate;
}

module.exports = {
  Library,
  /**
   * 지연 초기화 싱글턴.
   *
   * JsonStore 는 생성 시점에 userData 경로가 필요하므로
   * 모듈 로드 시점에 인스턴스를 만들면 initPaths() 이전에 터진다.
   * (require 순서와 무관하게 동작하도록 최초 접근 시 생성한다)
   */
  get library() {
    if (!instance) instance = new Library();
    return instance;
  },

  isMediaFile, isVideoFile, isAudioFile, isSubtitleFile, isImageFile, ext,
  MEDIA_EXT, SUBTITLE_EXT, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT,
  parseM3u, parsePls, writeM3u, playlistFilePath,
  readTextSmart, decodeSmart, defaultSnapshotDir, resolveSnapshotDir,
  buildSnapshotName, uniquePath,
};
