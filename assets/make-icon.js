/**
 * 앱 아이콘 생성 (개발용, 외부 에셋 없이 PNG 를 직접 그린다)
 *   node assets/make-icon.js
 * 산출: assets/icon.png (512x512), build/icon.ico (256/128/64/48/32/16)
 *
 * PNG 는 zlib + CRC 를 직접 계산해 최소한의 인코더로 작성한다.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SS = 2;   // 슈퍼샘플링 (계단 현상 제거)

// ── 캔버스 (RGBA) ─────────────────────────────────────────
const W = SIZE * SS;
const H = SIZE * SS;
const buf = new Float32Array(W * H * 4);

function px(x, y, r, g, b, a = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const sa = a;
  buf[i] = buf[i] * (1 - sa) + r * sa;
  buf[i + 1] = buf[i + 1] * (1 - sa) + g * sa;
  buf[i + 2] = buf[i + 2] * (1 - sa) + b * sa;
  buf[i + 3] = buf[i + 3] * (1 - sa) + 255 * sa;
}

/** 안티에일리어스 채우기 (거리장 + 1px Feather) */
function fillPath(sdf, colorFn) {
  const feather = SS * 1.2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = sdf(x + 0.5, y + 0.5);
      if (d > feather) continue;
      const a = d <= -feather ? 1 : (feather - d) / (2 * feather);
      const c = colorFn(x, y);
      px(x, y, c[0], c[1], c[2], a);
    }
  }
}

// ── 도형 유틸 (SDF) ──────────────────────────────────────
const hexLerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * 볼록 다각형 SDF (반평면 교집합).
 *
 * 볼록 도형은 "모든 변의 바깥쪽 거리 중 최댓값" 으로 정확히 표현된다.
 * 각 변을 중심에서 바깥쪽으로 향하는 단위 법선 n 과
 * 중심에서 변까지의 거리 d 로 표현하면
 *
 *     SDF(p) = max_i ( dot(n_i, p - center) - d_i )
 *
 * 가 되며, 음수면 내부, 양수면 외부 거리다.
 * 꼭짓점 라운딩은 fillPath 의 feather 가 담당한다.
 *
 * @param cx,cy 중심
 * @param r 외접원 반지름
 * @param sides 변의 개수
 * @param rotation radians — 0 이면 오른쪽에 꼭짓점(flat), PI/2 면 위쪽에 꼭짓점
 */
function convexSDF(cx, cy, r, sides = 6, rotation = 0) {
  const apothem = r * Math.cos(Math.PI / sides);
  const planes = [];
  for (let i = 0; i < sides; i++) {
    // 변의 바깥쪽 법선 방향: 꼭짓점 방향에서 sides/2 만큼 회전한 위치
    const a = rotation + (i / sides) * Math.PI * 2;
    planes.push({ nx: Math.cos(a), ny: Math.sin(a), d: apothem });
  }
  return (x, y) => {
    const px = x - cx;
    const py = y - cy;
    let m = -Infinity;
    for (const p of planes) {
      const d = px * p.nx + py * p.ny - p.d;
      if (d > m) m = d;
    }
    return m;
  };
}

/** 육각형 (위아래가 꼭짓점) */
function hexSDF(cx, cy, r) {
  return convexSDF(cx, cy, r, 6, 0);
}

/**
 * 삼각형 SDF (Inigo Quilez 의 공식을 JS 로 옮김)
 * 세 변 각각에 대해 가장 가까운 선분까지의 거리를 구하고,
 * 그중 내부/외부를 구분하는 부호까지 함께 비교한다.
 */
function triSDF(ax, ay, bx, by, cx, cy) {
  const e0 = [bx - ax, by - ay];
  const e1 = [cx - bx, cy - by];
  const e2 = [ax - cx, ay - cy];

  // 부호 정규화 계수: 세 변의 정렬 방향이 일관되도록 한 번만 구한다.
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]) || 1;

  return (qx, qy) => {
    const closest = (vx, vy, ex, ey) => {
      const len2 = ex * ex + ey * ey || 1;
      const h = Math.max(0, Math.min(1, (vx * ex + vy * ey) / len2));
      return [vx - ex * h, vy - ey * h];
    };

    // 각 변의 시작점을 기준으로 한 오프셋
    const v0 = [qx - ax, qy - ay];
    const v1 = [qx - bx, qy - by];
    const v2 = [qx - cx, qy - cy];

    const p0 = closest(v0[0], v0[1], e0[0], e0[1]);
    const p1 = closest(v1[0], v1[1], e1[0], e1[1]);
    const p2 = closest(v2[0], v2[1], e2[0], e2[1]);

    // 성분별 최소: x = 거리제곱, y = 부호 있는 외적
    const dx = Math.min(
      p0[0] * p0[0] + p0[1] * p0[1],
      p1[0] * p1[0] + p1[1] * p1[1],
      p2[0] * p2[0] + p2[1] * p2[1],
    );
    const dy = Math.min(
      s * (v0[0] * e0[1] - v0[1] * e0[0]),
      s * (v1[0] * e1[1] - v1[1] * e1[0]),
      s * (v2[0] * e2[1] - v2[1] * e2[0]),
    );

    return -Math.sqrt(dx) * Math.sign(dy);
  };
}

// ── 드로잉 ────────────────────────────────────────────────
const CX = W / 2;
const CY = H / 2;
// 육각형은 꼭짓점이 위/아래를 향하도록 90° 회전한 형태.
// 세로로 긴 배경을 감당하도록 apothem(변까지의 거리)을 기준으로 반지름을 잡는다.
const R = W * 0.315;

// 배경: 둥근 사각형 그라디언트
const bgRounded = (() => {
  const r = W * 0.22;
  return (x, y) => {
    const qx = Math.abs(x - CX) - (W / 2 - r);
    const qy = Math.abs(y - CY) - (H / 2 - r);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  };
})();

fillPath(bgRounded, (x, y) => {
  const t = (y / H) * 0.65 + (x / W) * 0.35;
  return hexLerp([0x1d, 0x4e, 0xd8], [0x7c, 0x3a, 0xed], t);
});

// 육각 테두리 링 (바깥 육각 − 안쪽 육각)
const hexOuter = hexSDF(CX, CY, R);
const hexInner = hexSDF(CX, CY, R * 0.88);
fillPath(hexOuter, () => [0xff, 0xff, 0xff]);
fillPath(hexInner, (x, y) => {
  const t = (y / H) * 0.6 + (x / W) * 0.4;
  return hexLerp([0x25, 0x63, 0xeb], [0x6d, 0x28, 0xd9], t);
});

// 재생 삼각형
const tri = triSDF(
  CX - W * 0.055, CY - W * 0.115,
  CX - W * 0.055, CY + W * 0.115,
  CX + W * 0.125, CY,
);
fillPath(tri, () => [0xff, 0xff, 0xff]);

// ── 축소 (박스 필터) ──────────────────────────────────────
function downscaleTo(size) {
  const factor = W / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * factor);
      const y0 = Math.floor(y * factor);
      const x1 = Math.min(W, Math.ceil((x + 1) * factor));
      const y1 = Math.min(H, Math.ceil((y + 1) * factor));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * W + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ── PNG 인코더 ────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 필터 타입 0 행 단위
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO 인코더 (PNG 압축 이미지 포함 형식) ─────────────────
function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;   // 256 은 0 으로 기록
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;   // 색상 수 (0 = 32bit)
    e[3] = 0;   // 예약
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// ── 출력 ──────────────────────────────────────────────────
const assetsDir = __dirname;
const buildDir = path.join(assetsDir, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const png512 = encodePng(downscaleTo(512), 512);
fs.writeFileSync(path.join(assetsDir, 'icon.png'), png512);
console.log(`assets/icon.png (512x512, ${(png512.length / 1024).toFixed(1)} KB)`);

const icoSizes = [256, 128, 64, 48, 32, 16];
const ico = encodeIco(icoSizes.map((size) => {
  const rgba = downscaleTo(size);
  return { size, png: encodePng(rgba, size) };
}));
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
console.log(`build/icon.ico (${icoSizes.join('/')}, ${(ico.length / 1024).toFixed(1)} KB)`);
