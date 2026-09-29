'use strict';
/**
 * 커스텀 프로토콜 등록
 *
 *  app://            렌더러 정적 리소스 (ES 모듈 사용을 위해 file:// 대신 사용)
 *  nova-media://     로컬 미디어 파일 (HTTP Range 지원 → 시킹 정상 동작)
 *
 * 보안
 *  - 경로 역공격(../) 을 정규식으로 차단
 *  - 심볼릭 링크를 realpath 로 해석해 앱 리소스 디렉터리 밖 접근을 거부
 *  - 렌더러에는 Content-Security-Policy 헤더를 함께 내려보냄
 */
const { protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { logger } = require('./paths');

const APP_SCHEME = 'app';
const MEDIA_SCHEME = 'nova-media';
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** app.ready 전에 호출해야 함 */
function registerPrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false },
    },
  ]);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** app.ready 후에 호출 */
function registerHandlers() {
  // ── 렌더러 정적 파일 ──────────────────────────────────────
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const target = path.resolve(RENDERER_ROOT, `.${pathname}`);
    const realRoot = safeRealpath(RENDERER_ROOT);
    const realTarget = safeRealpath(target);

    if (!realTarget || !isInside(realRoot, realTarget)) {
      logger.warn(`app:// 경로 차단: ${pathname}`);
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(realTarget);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': mimeFor(realTarget),
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'content-security-policy': [
            "default-src 'self'",
            "script-src 'self'",
            // 동적 위치/크기 지정에 인라인 style 속성 사용
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: nova-media:",
            "media-src 'self' blob: nova-media:",
            "font-src 'self' data:",
            // 렌더러 → 메인 IPC 만 사용. 외부 통신 금지
            "connect-src 'self' nova-media:",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
          'referrer-policy': 'no-referrer',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  // ── 미디어 파일 (Range 지원) ─────────────────────────────
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    // nova-media://f/<base64url(절대경로)>  ← toMediaUrl() 와 1:1 대응
    const filePath = fromMediaUrl(url.href);
    if (!filePath || !path.isAbsolute(filePath)) {
      return new Response('Bad media request', { status: 400 });
    }
    // allowlist 미등록 경로(직접 조립 URL 등)는 서빙하지 않는다
    if (!isAllowed(filePath)) {
      logger.warn(`nova-media 접근 차단(미등록): ${filePath.slice(0, 120)}`);
      return new Response('Forbidden', { status: 403 });
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not a file', { status: 400 });
    } catch {
      return new Response('File not found', { status: 404 });
    }

    const total = stat.size;
    const type = mimeFor(filePath);
    const range = request.headers.get('range');

    // ── Range 요청 (시킹의 핵심) ──
    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      if (m) {
        let start;
        let end;
        if (m[1] === '') {
          // bytes=-N  → 뒤에서 N바이트
          const suffix = Number(m[2]);
          if (!Number.isFinite(suffix) || suffix <= 0) {
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
          }
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === '' ? total - 1 : Number(m[2]);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
        }
        end = Math.min(end, total - 1);

        const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
        return new Response(stream, {
          status: 206,
          headers: {
            'content-type': type,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${total}`,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
          },
        });
      }
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    }

    // ── 전체 응답 ──
    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(total),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
    });
  });
}

function safeRealpath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/**
 * 미디어 접근 allowlist.
 * toMediaUrl() 발급 시점에만 등록되고, 핸들러는 등록된 실경로만 서빙한다.
 * 렌더러가 base64를 직접 조립해 임의 파일을 읽는 우회를 막는다.
 * (삽입순 유지 Map, 상한 초과 시 가장 오래된 항목부터 제거)
 */
const allowedMedia = new Map();
const ALLOWLIST_LIMIT = 1000;

function allowKey(realPath) {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

function allowFile(filePath) {
  const real = safeRealpath(filePath) ?? path.resolve(filePath);
  allowedMedia.delete(allowKey(real));
  allowedMedia.set(allowKey(real), Date.now());
  while (allowedMedia.size > ALLOWLIST_LIMIT) {
    allowedMedia.delete(allowedMedia.keys().next().value);
  }
  return real;
}

function isAllowed(filePath) {
  const real = safeRealpath(filePath);
  if (!real) return false;
  return allowedMedia.has(allowKey(real));
}

/**
 * filePath → nova-media:// URL
 * Windows 드라이브 문자(콜론)는 base64 로 감춰 URL 파싱 문제를 피한다.
 * 호출과 동시에 allowlist에 등록된다 (서빙 허용의 유일한 경로).
 */
function toMediaUrl(filePath) {
  const normalized = path.resolve(filePath);
  allowFile(normalized);
  const b64 = Buffer.from(normalized, 'utf8').toString('base64url');
  return `${MEDIA_SCHEME}://f/${b64}`;
}

function fromMediaUrl(url) {
  const parsed = new URL(url);
  const b64 = parsed.pathname.replace(/^\//, '');
  if (!b64) return '';
  try {
    const decoded = Buffer.from(b64, 'base64url').toString('utf8');
    return decoded.includes('\0') ? '' : decoded;
  } catch {
    return '';
  }
}

module.exports = { registerPrivileged, registerHandlers, toMediaUrl, fromMediaUrl, isAllowed, allowFile, APP_SCHEME, MEDIA_SCHEME, RENDERER_ROOT };
