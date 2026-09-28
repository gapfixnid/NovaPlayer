/**
 * 자막 파서: SRT / WebVTT / ASS·SSA / MicroDVD / JSON
 *
 * 모두 공통 형식으로 정규화한다.
 *   cue = {
 *     index, start, end,            // 초
 *     text,                          // 표시 문자열 (\n = 줄바꿈)
 *     style: {name, color, font, size, bold, italic, outline, shadow, align, pos},
 *     karaoke: [{ text, start, end }] | null
 *   }
 */

const TIME_RE = /(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/;
const TIME_SHORT_RE = /(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/;

/**
 * 타임스탬프 → 초.
 *  "00:01:02,500" / "00:01:02.500" / "1:02.5" / "02:05" 모두 처리한다.
 *
 * @param {string} str
 * @param {boolean} [strict] true 면 형식이 맞지 않을 때 NaN 을 반환
 *   (SRT/VTT 파싱에서 깨진 타임스탬프를 걸러내는 데 사용)
 */
export function parseTime(str, strict = false) {
  if (!str) return strict ? NaN : 0;
  const text = str.trim();

  // 3성분(HH:MM:SS[.mmm]) 을 먼저 시도
  const full = TIME_RE.exec(text);
  let h = 0;
  let m;
  let s;
  let ms;
  if (full) {
    h = Number(full[1]);
    m = Number(full[2]);
    s = Number(full[3]);
    ms = full[4];
  } else {
    // 2성분(MM:SS[.mmm]) — "00:01.000" 같은 VTT 타임스탬프
    const short = TIME_SHORT_RE.exec(text);
    if (!short) return strict ? NaN : 0;
    h = 0;
    m = Number(short[1]);
    s = Number(short[2]);
    ms = short[3];
  }

  // 분이 59 를 넘으면 시로 올림 (일부 파일이 00:75:00 처럼 쓰기도 함)
  const extraMinutes = Math.floor(m / 60);
  h += extraMinutes;
  m -= extraMinutes * 60;

  return (
    h * 3600 +
    m * 60 +
    s +
    (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0)
  );
}

function splitLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

// ─────────────────────────────────────────────────────────────
// 포맷 판별
// ─────────────────────────────────────────────────────────────
export function detectFormat(text) {
  const head = text.slice(0, 2048);
  if (/^\s*WEBVTT/i.test(head)) return 'vtt';
  if (/^\s*\{\s*[\s\S]*"events"/i.test(head) || /^\s*\{\s*"cues"/i.test(head)) return 'json';
  if (/^\s*\[Script Info\]/im.test(head) || /^\s*Dialogue\s*:/im.test(head) || /^\s*\[V4\+? Styles\]/im.test(head)) return 'ass';
  if (/^\s*\{\d+\}\{\d+\}/m.test(text.slice(0, 4096))) return 'microdvd';
  return 'srt';
}

// ─────────────────────────────────────────────────────────────
// SRT
// ─────────────────────────────────────────────────────────────
function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n\n').split('\n\n');

  for (const block of blocks) {
    const lines = splitLines(block.trim()).filter((l) => l.length);
    if (!lines.length) continue;

    let i = 0;
    let index = cues.length + 1;
    // 첫 줄이 순번이면 소비
    if (/^\d+$/.test(lines[0]) && lines.length > 1) {
      index = Number(lines[0]);
      i = 1;
    }

    const timeLine = lines[i];
    if (!timeLine || !timeLine.includes('-->')) continue;
    i += 1;
    // strict 로 파싱해 형식이 잘못된 구간은 버린다.
    // (start=0/end=0 인 무효 cue 가 렌더러에 찍히는 것을 막는다)
    const [rawStart, rest] = timeLine.split('-->');
    const start = parseTime(rawStart, true);
    // 뒤쪽에 VTT 스타일 지정이 붙을 수 있다
    const end = parseTime((rest ?? '').trim().split(/\s+/)[0], true);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const body = lines.slice(i).join('\n');
    if (!body.trim()) continue;

    cues.push(makeCue({ index, start, end, text: cleanBasicTags(body) }));
  }
  return cues;
}

/** SSA 태그 {..} 제거 (기본 SRT/VTT) */
function cleanBasicTags(s) {
  return s.replace(/\{[^}]*\}/g, '').replace(/<[^>]+>/g, (m) => (
    /<\/?(b|i|u|c|font|ruby|rt|v)(\.[^>]*)?>/i.test(m) ? '' : m
  )).trim();
}

// ─────────────────────────────────────────────────────────────
// WebVTT
// ─────────────────────────────────────────────────────────────
function parseVtt(text) {
  const cues = [];
  const body = text.replace(/^﻿/, '').replace(/^WEBVTT[^\n]*\n/i, '');
  const blocks = body.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n\n').split('\n\n');

  for (const block of blocks) {
    const lines = splitLines(block.trim()).filter((l) => l.length);
    if (!lines.length) continue;

    let i = 0;
    let id = null;
    if (!lines[0].includes('-->')) { id = lines[0]; i = 1; }

    const timeLine = lines[i];
    if (!timeLine || !timeLine.includes('-->')) continue;
    i += 1;

    const [rawStart, rest] = timeLine.split('-->');
    const start = parseTime(rawStart, true);
    // 시각 뒤쪽에 cue 설정(line/position/align/size ...)이 붙는다
    const settingsStr = (rest ?? '').trim();
    const end = parseTime(settingsStr.split(/\s+/)[0], true);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const content = lines.slice(i).join('\n');
    if (!content.trim()) continue;

    const cue = makeCue({ index: cues.length + 1, start, end, text: content });

    // 인라인 태그 + 시각 줄의 cue 설정 을 함께 반영
    applyVttTags(cue, content, settingsStr);
    cues.push(cue);
  }
  return cues;
}

const CSS_COLORS = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', silver: '#c0c0c0',
  gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000', navy: '#000080',
  purple: '#800080', teal: '#008080', orange: '#ffa500', aqua: '#00ffff', fuchsia: '#ff00ff',
};

function resolveVttColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (CSS_COLORS[v]) return CSS_COLORS[v].toUpperCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
    // VTT 는 #RRGGBBAA (CSS 와 순서가 반대) 를 허용한다
    const hex = v.slice(1);
    if (hex.length === 6) return `#${hex.toUpperCase()}`;
    const [r, g, b] = [hex[0], hex[1], hex[2]];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

/**
 * WebVTT 태그/설정 적용.
 * @param {object} cue
 * @param {string} content cue 본문 (인라인 태그 포함)
 * @param {string} [settingsStr] 시각 뒤에 붙는 cue 설정 문자열
 *   예: "00:03.500 line:90% position:10% align:start size:80%"
 */
function applyVttTags(cue, content, settingsStr = '') {
  const bold = /<b(\s[^>]*)?>/i.test(content);
  const italic = /<i(\s[^>]*)?>/i.test(content);
  const underline = /<u(\s[^>]*)?>/i.test(content);
  if (bold || italic || underline) {
    cue.style.bold = cue.style.bold || bold;
    cue.style.italic = cue.style.italic || italic;
    cue.style.underline = cue.style.underline || underline;
  }

  // <c.classname> 또는 <c.color> 태그에서 색 추출
  const colorTag = /<c(?:\.[^>]*)?>/i.exec(content);
  if (colorTag) {
    const attrs = /color\s*:\s*([^;>]+)/i.exec(colorTag[0]);
    const named = /<c\.([^>]+)>/i.exec(content);
    const resolved = resolveVttColor(attrs?.[1]) ?? resolveVttColor(named?.[1]);
    if (resolved) cue.style.color = resolved;
  }

  // ── cue 설정 (시각 줄에 붙는 속성) ──
  if (settingsStr) {
    const line = /line\s*:\s*(-?[\d.]+)%/.exec(settingsStr);
    if (line) cue.style.vAlignPct = Math.abs(Number(line[1]));

    const pos = /position\s*:\s*([\d.]+)%/.exec(settingsStr);
    if (pos) cue.style.hAlignPct = Number(pos[1]);

    const size = /size\s*:\s*([\d.]+)%/.exec(settingsStr);
    if (size) cue.style.sizePct = Number(size[1]);

    const align = /align\s*:\s*(start|center|end|left|right)/i.exec(settingsStr);
    if (align) {
      const a = align[1].toLowerCase();
      cue.style.align = a === 'left' ? 'left' : a === 'right' ? 'right' : 'center';
    }
  }

  // 인라인 <size> 태그
  const inlineSize = /<(\d{2,3}(?:\.\d+)?)%>/.exec(content);
  if (inlineSize && cue.style.sizePct === undefined) cue.style.sizePct = Number(inlineSize[1]);

  // 남은 태그 제거
  cue.text = cue.text.replace(/<[^>]+>/g, '').trim();
}

// ─────────────────────────────────────────────────────────────
// ASS / SSA
// ─────────────────────────────────────────────────────────────
function parseAss(text) {
  const lines = splitLines(text);
  const styles = new Map();
  const cues = [];
  let inEvents = false;
  let fmt = null;
  let version = 'v4';

  // 두 번째 패스용 인덱스
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^\[(Script Info|Events|V4 Styles|V4\+ Styles|Fonts|Aegisub Project Garbage)/i.test(line)) {
      inEvents = /^\[Events\]/i.test(line);
      if (/^\[V4\+? Styles\]/i.test(line)) version = /^\[V4\+/i.test(line) ? 'v4+' : 'v4';
      continue;
    }
    if (line.startsWith(';')) continue;   // 주석

    if (/^Format\s*:/i.test(line)) {
      const parts = line.slice(line.indexOf(':') + 1).split(',').map((s) => s.trim());
      if (inEvents) fmt = parts;
      continue;
    }

    if (/^Style\s*:/i.test(line) && !inEvents) {
      const parts = splitAssFields(line.slice(line.indexOf(':') + 1));
      const name = parts[0]?.trim() ?? 'Default';
      styles.set(name.toLowerCase(), {
        name,
        font: parts[1]?.trim() || 'Arial',
        size: Number(parts[2]) || 20,
        primary: parts[3]?.trim() || '&H00FFFFFF',
        secondary: parts[4]?.trim() || '&H000000FF',
        outlineColor: parts[5]?.trim() || '&H00000000',
        backColor: parts[6]?.trim() || '&H00000000',
        bold: Number(parts[7]) || 0,
        italic: Number(parts[8]) || 0,
        underline: Number(parts[9]) || 0,
        strikeout: Number(parts[10]) || 0,
        scaleX: Number(parts[11]) || 100,
        scaleY: Number(parts[12]) || 100,
        spacing: Number(parts[13]) || 0,
        angle: Number(parts[14]) || 0,
        align: Number(parts[15]) || 2,
        marginL: Number(parts[16]) || 10,
        marginR: Number(parts[17]) || 10,
        marginV: Number(parts[18]) || 10,
        alpha: Number(parts[19]) || 0,
        encoding: Number(parts[21]) || 0,
      });
      continue;
    }

    if (/^Dialogue\s*:/i.test(line)) {
      const payload = line.slice(line.indexOf(':') + 1);
      // Text 필드는 쉼표가 포함될 수 있으므로 나머지를 통째로
      const head = fmt ?? ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
      const textIdx = head.indexOf('Text');
      const parts = splitAssFields(payload, textIdx);
      const get = (name, def = '') => {
        const i = head.indexOf(name);
        return i >= 0 ? (parts[i] ?? def) : def;
      };

      const start = parseTime(get('Start'));
      const end = parseTime(get('End'));
      const styleName = (get('Style') || 'Default').trim();
      const style = styles.get(styleName.toLowerCase()) ?? null;
      const rawText = textIdx >= 0 ? (parts.slice(textIdx).join(',') ?? '') : (parts[9] ?? '');

      const cue = buildAssCue({
        index: cues.length + 1,
        start, end, rawText, style, version,
        marginL: Number(get('MarginL', 0)) || 0,
        marginR: Number(get('MarginR', 0)) || 0,
        marginV: Number(get('MarginV', 0)) || 0,
      });
      cues.push(cue);
    }
  }
  return cues;
}

/** 쉼표 구분 필드 분리 (limit 만큼만 잘라 나머지는 유지) */
function splitAssFields(payload, limit = 9) {
  const out = [];
  let rest = payload;
  for (let i = 0; i < limit; i++) {
    const i2 = rest.indexOf(',');
    if (i2 < 0) { out.push(rest.trim()); return out; }
    out.push(rest.slice(0, i2).trim());
    rest = rest.slice(i2 + 1);
  }
  out.push(rest);
  return out;
}

/** ASS 색상(&HAABBGGRR) → #RRGGBB + alpha(0~1) */
export function assColorToCss(colorStr, fallback = '#ffffff') {
  if (!colorStr) return { color: fallback, alpha: 1 };
  const m = /&H([0-9a-f]{1,8})/i.exec(colorStr);
  if (!m) return { color: fallback, alpha: 1 };
  const hex = m[1].padStart(8, '0');
  const aa = parseInt(hex.slice(0, 2), 16);
  const bb = hex.slice(2, 4);
  const gg = hex.slice(4, 6);
  const rr = hex.slice(6, 8);
  return {
    color: `#${rr}${gg}${bb}`.toUpperCase(),
    alpha: 1 - aa / 255,
  };
}

const ASS_ALIGN_MAP = { 1: 'left', 2: 'center', 3: 'right', 4: 'left', 5: 'center', 6: 'right', 7: 'left', 8: 'center', 9: 'right' };

function buildAssCue({ index, start, end, rawText, style, version, marginL, marginR, marginV }) {
  const cue = makeCue({ index, start, end, text: '' });
  const segs = parseAssText(rawText, { start, end });
  cue.karaoke = segs.karaoke;

  // karaoke 는 태그를 제거한 순수 텍스트로 표시
  const plain = segs.parts.map((p) => p.text).join('');
  cue.text = plain;

  const primary = assColorToCss(style?.primary, '#ffffff');
  const outline = assColorToCss(style?.outlineColor, '#000000');
  const back = assColorToCss(style?.backColor, '#000000');

  cue.style = {
    name: style?.name ?? 'Default',
    color: primary.color,
    opacity: primary.alpha,
    outlineColor: outline.color,
    outlineOpacity: outline.alpha,
    shadowColor: back.color,
    shadowOpacity: back.alpha,
    font: style?.font,
    size: style?.size,
    bold: !!style?.bold,
    italic: !!style?.italic,
    underline: !!style?.underline,
    strikeout: !!style?.strikeout,
    scaleX: (style?.scaleX ?? 100) / 100,
    scaleY: (style?.scaleY ?? 100) / 100,
    spacing: style?.spacing,
    align: ASS_ALIGN_MAP[style?.align] ?? 'center',
    assAlignNum: style?.align ?? 2,
    marginL, marginR, marginV,
    isAss: true,
    // SSA(v4) 는 \pos 미지원 → 무시하고 정렬만 사용
    allowPos: version !== 'v4',
  };

  // \pos / \an 태그로 위치/정렬 덮어쓰기
  const posM = /\\pos\(([\d.]+),([\d.]+)\)/i.exec(rawText);
  if (posM && cue.style.allowPos) {
    cue.style.pos = { x: Number(posM[1]), y: Number(posM[2]) };
  }
  const anM = /\\an([1-9])/i.exec(rawText);
  if (anM) cue.style.alignNum = Number(anM[1]);
  const fadM = /\\fad\((\d+),(\d+)\)/i.exec(rawText) ?? /\\fade\((\d+),(\d+),(\d+),(\d+)\)/i.exec(rawText);
  if (fadM) {
    const a = Number(fadM[1]);
    const b = Number(fadM[2]);
    cue.style.fadeIn = a / 1000;
    cue.style.fadeOut = b / 1000;
  }
  const fsM = /\\fs([\d.]+)/i.exec(rawText);
  if (fsM) cue.style.size = Number(fsM[1]);
  const fnM = /\\fn([^\\}]+)/i.exec(rawText);
  if (fnM) cue.style.font = fnM[1].trim();
  const bM = /\\b1/i.test(rawText);
  const iM = /\\i1/i.test(rawText);
  if (bM) cue.style.bold = true;
  if (iM) cue.style.italic = true;

  return cue;
}

/**
 * ASS 텍스트를 세그먼트로 분해.
 * \N \n \h 줄바꿈/공백, {\k..} \kf.. \ko \kt 카라오케 태그 처리.
 */
export function parseAssText(raw, cueRange) {
  const parts = [];
  const karaoke = [];
  let i = 0;
  let currentStyle = {};

  // 카라오케 타이밍은 cue 절대 시각을 기준으로 한다.
  // {\k} 태그 값은 centisecond(1/100초) 단위 상대 길이이므로 누적한다.
  let kTime = Number.isFinite(cueRange?.start) ? cueRange.start : 0;

  const push = (text, karaokeTimes) => {
    if (!text) return;
    parts.push({ text, style: { ...currentStyle }, karaoke: karaokeTimes });
    if (karaokeTimes) {
      karaoke.push({
        text,
        start: karaokeTimes.start,
        end: karaokeTimes.end,
        style: { ...currentStyle },
      });
    }
  };

  while (i < raw.length) {
    const ch = raw[i];

    // 태그 블록
    if (ch === '{') {
      const end = raw.indexOf('}', i);
      if (end < 0) { i += 1; continue; }
      const tag = raw.slice(i + 1, end);
      i = end + 1;
      if (tag.startsWith('\\')) {
        const kMatch = /^\\k(?:f|o|t)?(\d+(?:\.\d+)?)/i.exec(tag);
        if (kMatch) {
          // \k = 100분의 1초 단위, \kf = 앞부분 채우기, \ko = 뒷부분만
          const dur = Number(kMatch[1]) / 100;
          const start = kTime;
          kTime = start + dur;
          // 다음 텍스트 조각에 이 타이밍을 붙인다
          currentStyle = { ...currentStyle, __karaoke: { start, end: kTime } };
          continue;
        }
        const override = parseAssOverride(tag, currentStyle);
        currentStyle = { ...currentStyle, ...override };
      }
      continue;
    }

    // 줄바꿈
    if (ch === '\\' && (raw[i + 1] === 'N' || raw[i + 1] === 'n')) {
      push('\n', null);
      i += 2;
      continue;
    }
    if (ch === '\\' && raw[i + 1] === 'h') {
      push(' ', null);
      i += 2;
      continue;
    }

    // 일반 문자
    const karaoke = currentStyle.__karaoke ?? null;
    const last = parts.at(-1);
    if (last && !last.karaoke && !karaoke && JSON.stringify(last.style) === JSON.stringify(currentStyle)) {
      last.text += ch;
    } else {
      push(ch, karaoke);
    }
    i += 1;
  }

  // 빈 카라오케 세그먼트 정리
  const cleaned = karaoke.filter((k) => k.text.length > 0);
  return { parts, karaoke: cleaned.length ? cleaned : null };
}

function parseAssOverride(tag, current) {
  const out = {};
  const c = /\\1?c&H([0-9a-f]+)&?/i.exec(tag);
  if (c) {
    const { color } = assColorToCss(`&H${c[1].padStart(8, '0').slice(-8)}&`);
    out.color = color;
  }
  if (/\\b1/i.test(tag)) out.bold = true;
  if (/\\b0/i.test(tag)) out.bold = false;
  if (/\\i1/i.test(tag)) out.italic = true;
  if (/\\i0/i.test(tag)) out.italic = false;
  if (/\\u1/i.test(tag)) out.underline = true;
  if (/\\u0/i.test(tag)) out.underline = false;
  if (/\\s1/i.test(tag)) out.strikeout = true;
  if (/\\s0/i.test(tag)) out.strikeout = false;
  const a = /\\alpha&H([0-9a-f]{2})/i.exec(tag);
  if (a) out.opacity = 1 - parseInt(a[1], 16) / 255;
  const fs = /\\fs([\d.]+)/i.exec(tag);
  if (fs) out.size = Number(fs[1]);
  return out;
}

// ─────────────────────────────────────────────────────────────
// MicroDVD ({1}{25}text) —(frame, fps) 필요
// ─────────────────────────────────────────────────────────────
function parseMicroDvd(text, fps = 25) {
  const cues = [];
  const re = /\{(\d+)\}\{(\d+)\}([^\n]*)/g;
  let m;
  let index = 0;
  while ((m = re.exec(text)) !== null) {
    const start = Number(m[1]) / fps;
    const end = Number(m[2]) / fps;
    const body = m[3]
      .replace(/\|\s*\{[yi]\}/g, '')
      .replace(/\{[ybBWI]:([^}]*)\}/g, '<i>$1</i>')
      .replace(/\{y:i\}/g, '<i>')
      .replace(/\{\\}/g, '');
    if (!body.trim()) continue;
    index += 1;
    const cue = makeCue({ index, start, end, text: body.replace(/<br\s*\/?>/gi, '\n') });
    cues.push(cue);
  }
  return cues;
}

// ─────────────────────────────────────────────────────────────
// JSON (자체 내보내기 형식 등)
// ─────────────────────────────────────────────────────────────
function parseJsonSub(text) {
  const data = JSON.parse(text);
  const list = data.cues ?? data.events ?? (Array.isArray(data) ? data : []);
  return list.map((c, i) => {
    const cue = makeCue({
      index: i + 1,
      start: c.start ?? c.from ?? 0,
      end: c.end ?? c.to ?? (c.start ?? 0) + 3,
      text: c.text ?? c.body ?? '',
    });
    if (c.style) Object.assign(cue.style, c.style);
    return cue;
  });
}

// ─────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────
function makeCue({ index, start, end, text }) {
  return {
    index,
    start: Math.max(0, start),
    end: Math.max(start + 0.001, end),
    text: String(text ?? '').trim(),
    style: {},
    karaoke: null,
  };
}

function sortCues(cues) {
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/**
 * 진입점.
 * @param {string} text 자막 원문
 * @param {object} [opts] { format, fps }
 * @returns {{format:string, cues:Array}}
 */
export function parseSubtitles(text, opts = {}) {
  const format = opts.format ?? detectFormat(text);
  let cues;
  switch (format) {
    case 'vtt': cues = parseVtt(text); break;
    case 'ass': cues = parseAss(text); break;
    case 'microdvd': cues = parseMicroDvd(text, opts.fps ?? 25); break;
    case 'json': cues = parseJsonSub(text); break;
    default: cues = parseSrt(text);
  }
  return { format, cues: sortCues(cues.filter((c) => c.text)) };
}

/**
 * 겹치는 cue 를 하나로 병합 (ASS 는 의도적으로 겹칠 수 있으므로 옵션).
 * SRT/VTT 는 겹침이 버그이므로 병합해 읽기 좋게 만든다.
 */
export function mergeOverlaps(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out.at(-1);
    if (prev && cue.start < prev.end - 0.05) {
      const dur = Math.max(prev.end, cue.end) - prev.start;
      if (dur < 20) {
        prev.end = Math.max(prev.end, cue.end);
        prev.text = `${prev.text}\n${cue.text}`;
        continue;
      }
    }
    out.push({ ...cue });
  }
  return out;
}

/**
 * 시각에 활성화된 cue 목록을 찾는다.
 *
 * cues 는 start 오름차순으로 정렬되어 있으므로,
 * 탐색 커서(hint)를 두고 앞으로만 스캔하면 프레임마다 O(1)에 가깝다.
 * 되감기/큰 점프 시 hint 가 무효가 되므로 뒤에서부터 훑어 다시 맞춘다.
 *
 * @param {Array} cues 정렬된 cue 배열
 * @param {number} time 현재 시각(초)
 * @param {number} hint 이전 호출에서 돌려준 커서
 * @returns {{ active: Array, hint: number }}
 */
export function findActiveCues(cues, time, hint = 0) {
  const n = cues.length;
  if (!n) return { active: [], hint: 0 };

  // 커서 보정: 현재 시각보다 뒤에 있으면 되감긴 것이므로 뒤에서부터 재탐색
  let i = Number.isInteger(hint) ? Math.min(Math.max(0, hint), n) : 0;
  if (i < n && cues[i].start > time) {
    // 앞으로 갈 수 있는 최대 인덱스를 이진 탐색으로 구한 뒤 거기서 역방향 스캔
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    i = lo - 1;
  }

  // 활성화될 수 있는 마지막 인덱스에서 뒤로 이동.
  // end <= time 인 cue 를 만나면 그보다 앞선 cue 도 대부분 종료되지만,
  // 극단적으로 긴 cue 가 있는 ASS 를 위해 창(window)으로 제한한다.
  let back = 0;
  while (i > 0 && back < 200) {
    const prev = cues[i - 1];
    if (prev.end <= time && back > 0) break;
    i -= 1;
    back += 1;
    if (cues[i].end <= time) break;
  }

  const active = [];
  let j = i;
  while (j < n && cues[j].start <= time) {
    if (cues[j].end > time) active.push(cues[j]);
    j += 1;
  }
  return { active, hint: j };
}
