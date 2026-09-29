'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/** 앱 전역 경로 상수 (main/index.js 에서 초기화) */
const paths = {
  userData: '',
  logs: '',
  cache: '',
  snapshots: '',
  playlistAutoSave: '',
};

function initPaths(userDataDir) {
  paths.userData = userDataDir;
  paths.logs = path.join(userDataDir, 'logs');
  paths.cache = path.join(userDataDir, 'cache');
  paths.snapshots = path.join(userDataDir, 'snapshots');
  paths.playlistAutoSave = path.join(userDataDir, 'playlists');
  for (const dir of Object.values(paths)) {
    if (!dir) continue;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  }
  return paths;
}

/** 캐시 정리 (용량 초과 시 오래된 파일부터) */
function pruneCache(maxMB) {
  // 비수치·0 이하 입력은 기본값으로 (NaN 비교가 false라 캐시 전삭제되는 사고 방지)
  const mb = Number(maxMB);
  const safeMB = Number.isFinite(mb) && mb > 0 ? mb : 2048;
  const limit = safeMB * 1024 * 1024;
  let entries;
  try { entries = fs.readdirSync(paths.cache); } catch { return 0; }
  const files = [];
  let total = 0;
  for (const name of entries) {
    const full = path.join(paths.cache, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      files.push({ full, mtime: stat.mtimeMs, size: stat.size });
      total += stat.size;
    } catch { /* noop */ }
  }
  if (total <= limit) return 0;
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const f of files) {
    if (total <= limit * 0.8) break;
    try { fs.unlinkSync(f.full); total -= f.size; removed += 1; } catch { /* noop */ }
  }
  return removed;
}

/** 임시 작업 디렉토리 (프레임 추출 등) */
function tempDir() {
  const dir = path.join(paths.cache, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let logLevel = LEVELS[process.env.NOVA_LOG] ?? LEVELS.info;
let logFile = null;

function openLogFile() {
  if (logFile || !paths.logs) return;
  const file = path.join(paths.logs, `nova-${new Date().toISOString().slice(0, 10)}.log`);
  try {
    logFile = fs.createWriteStream(file, { flags: 'a' });
  } catch {
    logFile = null;
  }
}

function fmt(level, args) {
  const msg = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
}

function safeStringify(value) {
  try {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, args) {
  if (LEVELS[level] < logLevel) return;
  const line = fmt(level, args);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  openLogFile();
  logFile?.write(`${line}\n`);
}

const logger = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  setLevel(l) { logLevel = LEVELS[l] ?? logLevel; },
};

module.exports = { paths, initPaths, pruneCache, tempDir, logger, os };
