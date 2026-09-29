/**
 * 공용 유틸 모듈
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  // 자식은 중첩 배열까지 모두 펼쳐 처리한다.
  // ([].concat 은 한 단계만 풀어서, 중첩 배열이 텍스트 노드로
  //  "[object HTMLButtonElement],..." 처럼 찍히는 사고를 막는다)
  const flatChildren = (list) => {
    const out = [];
    for (const c of [].concat(list)) {
      if (Array.isArray(c)) out.push(...flatChildren(c));
      else out.push(c);
    }
    return out;
  };
  for (const c of flatChildren(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** 0 → "00:00:00", 3661 → "01:01:01" */
/**
 * 초 → "HH:MM:SS" (또는 "MM:SS")
 *
 * hours 옵션
 *   true   : 항상 시까지 표시 (K/M/G 최댓값이 안정적이므로 기본값)
 *   false  : 1시간 미만이면 "MM:SS"
 *   'auto' : 1시간 이상일 때만 시 표시
 */
export function formatTime(seconds, { hours = true, ms = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);

  const showHours = hours === true || (hours === 'auto' && h > 0);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const base = showHours
    ? `${String(h).padStart(2, '0')}:${mm}:${ss}`
    : `${mm}:${ss}`;

  if (!ms) return base;

  // 부동소수점 오차로 1000 이 되는 것을 방지
  const frac = Math.min(999, Math.floor((seconds - total) * 1000 + 1e-6));
  return `${base}.${String(frac).padStart(3, '0')}`;
}

/** 남은 시간 ("-01:23") */
export function formatRemaining(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  return `-${formatTime(seconds)}`;
}

/** 1536 → "1.54 Kbps", 1536000 → "1.54 Mbps" */
export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '-';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1000) return `${(bps / 1000).toFixed(2)} Kbps`;
  return `${Math.round(bps)} bps`;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  return `${val.toFixed(i === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatSpeed(x) {
  if (x >= 10) return `${x.toFixed(0)}x`;
  if (x >= 1) return `${x.toFixed(2).replace(/0$/, '')}x`;
  return `${x.toFixed(2)}x`;
}

/**
 * 경로 → 파일명 (렌더러는 path 모듈을 쓸 수 없으므로 직접 처리)
 *   "C:\\videos\\a.mp4" → "a.mp4"
 *   "C:\\videos\\"     → "videos"   (끝 구분자 제거 후)
 */
export function baseName(p) {
  if (!p) return '';
  const norm = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * 경로 → 상위 폴더
 *   "C:\\videos\\a.mp4" → "C:\\videos"
 *   "C:\\a.mp4"        → "C:"       (드라이브 루트는 빈 문자열이 아닌 "C:" 반환)
 *   "/a.mp4"           → ""         (POSIX 루트)
 */
export function dirName(p) {
  if (!p) return '';
  const norm = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 0) return norm.slice(0, 1);          // "/a.mp4" → "/"
  // "C:\a.mp4" → "C:" (드라이브 루트)
  if (i === 2 && /^[a-zA-Z]:[\\/]/.test(norm)) return norm.slice(0, 2);
  return norm.slice(0, i);
}

export function stripExt(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function extName(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

/**
 * 키 이름 캐노니컬라이즈.
 *
 * "ArrowLeft"/"ARROWLEFT"/"arrowleft" 은 모두 같은 키다.
 * KeyboardEvent.key 는 "ArrowLeft" 처럼 정규화된 이름을 주지만
 * 설정 파일이나 accelFromEvent 경로를 거치면 형태가 달라질 수 있어
 * 충돌 검사 전에 반드시 정규화한다.
 */
const KEY_CANONICAL = new Map(
  Object.entries({
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    space: 'Space', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown',
    tab: 'Tab', home: 'Home', end: 'End', insert: 'Insert', ins: 'Insert',
    printscreen: 'PrintScreen', scrolllock: 'ScrollLock', pause: 'Pause', contextmenu: 'ContextMenu',
    mediaplaypause: 'MediaPlayPause', mediastop: 'MediaStop',
    medianexttrack: 'MediaNextTrack', mediaprevioustrack: 'MediaPrevTrack',
    audiovolumemute: 'AudioVolumeMute', audiovolumeup: 'AudioVolumeUp', audiovolumedown: 'AudioVolumeDown',
    numlock: 'NumLock', capslock: 'CapsLock',
  }),
);

function canonicalKey(raw) {
  if (!raw) return '';
  // 단일 문자 키는 소문자로 (A 와 a 를 같은 키로 취급)
  if (raw.length === 1) return raw.toLowerCase();
  // F1~F12 처럼 문자+숫자 형태는 알파벳을 대문자로 (F1 ≡ f1)
  if (/^[a-z]\d+$/i.test(raw)) return raw.toUpperCase();
  // 숫자가 섞인 나머지 키 (Digit1) 는 그대로
  if (/\d/.test(raw)) return raw;
  return KEY_CANONICAL.get(raw.toLowerCase()) ?? raw;
}

/**
 * 단축키 표기 정규화.
 * 수정자 순서를 Control → Alt → Shift → Meta 로 통일하고
 * 키 이름도 정규화해 "ArrowLeft" ≡ "arrowleft" 가 되게 한다.
 */
export function normalizeAccel(accel) {
  if (!accel) return '';
  const parts = String(accel).split('+');
  const order = ['Control', 'Alt', 'Shift', 'Meta'];
  const mods = order.filter((m) => parts.includes(m));
  const rest = parts.filter((p) => !order.includes(p));
  // 키가 없는 수정자만 있는 조합 ("Alt+Meta") 은 구분자 없이 조립한다
  const key = rest.length ? canonicalKey(rest[0]) : '';
  return key ? [...mods, key].join('+') : mods.join('+');
}

/**
 * KeyboardEvent → Electron Accelerator 문자열.
 * 수정자만 누른 상태면 null, 처리 불가 키도 null.
 */
export function accelFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');

  let key = e.key;
  if (key === ' ') key = 'Space';
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null;
  if (key === 'Unidentified' || key === 'Dead' || key === 'Process') return null;

  if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join('+');
}

/** 키를 사람이 읽는 형태로 (ArrowLeft → ←, Control → Ctrl) */
export const KEY_LABELS = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Del',
  PageUp: 'PgUp', PageDown: 'PgDn', Tab: 'Tab', Home: 'Home', End: 'End',
  Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  MediaPlayPause: 'Media ▶❚❚', MediaStop: 'Media ■', MediaNextTrack: 'Media ⏭', MediaPrevTrack: 'Media ⏮',
  AudioVolumeMute: 'Vol 🔇', AudioVolumeUp: 'Vol 🔊', AudioVolumeDown: 'Vol 🔉',
  PrintScreen: 'PrtSc', ScrollLock: 'ScrLk', Pause: 'Pause', Insert: 'Ins',
};

export function prettyKey(accel) {
  if (!accel) return '';
  // modifier 순서를 일관되게
  const order = ['Control', 'Alt', 'Shift', 'Meta'];
  const parts = accel.split('+');
  const mods = parts.filter((p) => order.includes(p));
  const key = parts.find((p) => !order.includes(p)) ?? '';
  const keyLabel = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods.map((m) => KEY_LABELS[m] ?? m), keyLabel].join('+');
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return function throttled(...args) {
    const now = performance.now();
    pendingArgs = args;
    if (now - last >= wait) {
      last = now;
      fn.apply(this, pendingArgs);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        fn.apply(this, pendingArgs);
      }, wait - (now - last));
    }
  };
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** DOM 준비 완료 대기 */
export function domReady() {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 스냅샷 파일명 패턴 전개.
 * 지원 토큰: {name} {time} {hh} {mm} {ss} {date} {index}
 */
export function buildSnapshotName(pattern, ctx) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hhmmss = `${pad(ctx.hours)}${pad(ctx.minutes)}${pad(ctx.seconds)}`;
  return String(pattern || '{name}_{time}')
    .replace(/\{name\}/g, ctx.name ?? 'capture')
    .replace(/\{time\}/g, hhmmss)
    .replace(/\{hh\}/g, pad(ctx.hours))
    .replace(/\{mm\}/g, pad(ctx.minutes))
    .replace(/\{ss\}/g, pad(ctx.seconds))
    .replace(/\{date\}/g, `${ctx.year}${pad(ctx.month + 1)}${pad(ctx.day)}`)
    .replace(/\{index\}/g, ctx.index > 0 ? `_${String(ctx.index).padStart(3, '0')}` : '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 180);
}

/** 간단한 이벤트 버스 */
export class Emitter {
  #map = new Map();
  on(evt, fn) {
    if (!this.#map.has(evt)) this.#map.set(evt, new Set());
    this.#map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this.#map.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    for (const fn of this.#map.get(evt) ?? []) {
      try { fn(...args); } catch (err) { console.error(`[${evt}]`, err); }
    }
    for (const fn of this.#map.get(`*`) ?? []) {
      try { fn(evt, ...args); } catch { /* noop */ }
    }
  }
  clear(evt) { if (evt) this.#map.delete(evt); else this.#map.clear(); }
}

/**
 * 요소 숨김/표시.
 * SVG 요소에는 `hidden` IDL 프로퍼티가 없어 `.hidden = true` 가
 * 속성으로 반영되지 않는다(조용한 no-op). 아이콘 토글이 듣지 않는
 * 원인이므로, 표시 전환은 항상 이 헬퍼로 속성 단위로 처리한다.
 */
export function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

/** 간단한 상태 저장 (renderer 로컬) */
export const localStore = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`nova.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`nova.${key}`, JSON.stringify(value)); } catch { /* noop */ }
  },
  remove(key) {
    try { localStorage.removeItem(`nova.${key}`); } catch { /* noop */ }
  },
};

/** 알림/열림 대화상자를 작게 통일하는 헬퍼 */
export function makeContextMenu(items) {
  const root = document.getElementById('context-menu');
  root.innerHTML = '';
  let focusIndex = -1;
  const buttons = [];

  const close = () => {
    root.hidden = true;
    root.innerHTML = '';
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    focusIndex = -1;
  };

  for (const it of items) {
    if (it === '-' || it.separator) {
      root.append(el('div', { class: 'ctx-sep' }));
      continue;
    }
    if (it.header) {
      root.append(el('div', { class: 'ctx-head', text: it.header }));
      continue;
    }
    const btn = el('button', {
      class: `ctx-item${it.checked ? ' checked' : ''}`,
      type: 'button',
      'aria-disabled': it.disabled ? 'true' : null,
    }, [
      el('span', { class: 'ctx-icon', html: it.checked ? ICONS.check : (it.icon ?? '') }),
      el('span', { class: 'ctx-label', text: it.label }),
      it.key ? el('span', { class: 'ctx-key', text: it.key }) : null,
    ]);
    if (!it.disabled) {
      btn.addEventListener('click', () => { close(); it.onClick?.(); });
    }
    buttons.push(btn);
    root.append(btn);
  }

  const setFocus = (i) => {
    focusIndex = (i + buttons.length) % buttons.length;
    buttons.forEach((b, n) => b.classList.toggle('focused', n === focusIndex));
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(focusIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(focusIndex - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      buttons[focusIndex]?.click();
    }
  };

  const onDocDown = (e) => {
    if (!root.contains(e.target)) close();
  };

  root.hidden = false;
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close, { once: true });

  return {
    showAt(x, y) {
      root.style.left = '0px';
      root.style.top = '0px';
      const r = root.getBoundingClientRect();
      const left = Math.min(x, window.innerWidth - r.width - 6);
      const top = Math.min(y, window.innerHeight - r.height - 6);
      root.style.left = `${Math.max(6, left)}px`;
      root.style.top = `${Math.max(6, top)}px`;
      return close;
    },
    close,
  };
}

/** 자주 쓰는 인라인 SVG 아이콘 */
export const ICONS = {
  check: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M5 3.5v9l7-4.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="4.5" y="3.5" width="2.6" height="9" fill="currentColor"/><rect x="8.9" y="3.5" width="2.6" height="9" fill="currentColor"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 4.5a1 1 0 011-1h3l1.2 1.4H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.2a1 1 0 001 .8h3.8a1 1 0 001-.8l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5" r=".9" fill="currentColor"/></svg>',
  camera: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M6 4.5h4l.8 1.2H14a.8.8 0 01.8.8v6a.8.8 0 01-.8.8H2a.8.8 0 01-.8-.8v-6a.8.8 0 01.8-.8h3.2z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  sub: '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="1.5" y="3.5" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.4 7.2a1.9 1.9 0 100 1.6 1.9 1.9 0 100-1.6zM11.4 7.2a1.9 1.9 0 100 1.6 1.9 1.9 0 100-1.6z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

/** 색상 → rgba() */
export function withAlpha(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
