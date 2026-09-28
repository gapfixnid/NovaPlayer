/** 토스트 알림 */
import { el } from '../util.js';

const root = () => document.getElementById('toast-root');

const ICON = {
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="5.1" r=".95" fill="currentColor"/></svg>',
  success: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8.2l2.1 2.1L11 6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2.2 14.6 13.4H1.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".85" fill="currentColor"/></svg>',
  error: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

let seq = 0;

/**
 * @param {string} message
 * @param {object} opts { type, duration, action:{label,onClick} }
 */
export function toast(message, opts = {}) {
  const { type = 'info', duration = 3200, action = null, silent = false } = opts;
  if (silent) return () => {};

  const host = root();
  if (!host) return () => {};

  const id = ++seq;
  const node = el('div', { class: `toast toast-${type}`, dataset: { id: String(id) } }, [
    el('span', { class: 'toast-icon', html: ICON[type] ?? ICON.info }),
    el('div', { class: 'toast-text', text: message }),
  ]);

  if (action) {
    node.append(el('button', {
      class: 'toast-action',
      type: 'button',
      text: action.label,
      onClick: () => { action.onClick?.(); dismiss(); },
    }));
  }

  host.append(node);

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };

  // 마우스를 올리면 시간 멈춤 (긴 메시지용)
  node.addEventListener('mouseenter', () => { if (timer) clearTimeout(timer); });
  node.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1200); });

  if (duration > 0) timer = setTimeout(dismiss, duration);

  // 동시에 많아지면 오래된 것부터 정리
  const all = [...host.children];
  if (all.length > 5) all.slice(0, all.length - 5).forEach((n) => n.remove());

  return dismiss;
}

export const toastInfo = (m, o) => toast(m, { ...o, type: 'info' });
export const toastOk = (m, o) => toast(m, { ...o, type: 'success' });
export const toastWarn = (m, o) => toast(m, { ...o, type: 'warn' });
export const toastError = (m, o) => toast(m, { ...o, type: 'error', duration: 6000 });
