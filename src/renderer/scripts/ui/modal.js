/** 범용 모달 대화상자 */
import { el } from '../util.js';

let openCount = 0;
let lastFocused = null;

/**
 * @param {object} opts
 *   title, body(Node), footer(Node[]), width, closable, onClose
 * @returns {{ close: Function, node: HTMLElement, setFooter: Function }}
 */
export function openModal({
  title = '',
  body = null,
  footer = [],
  width = null,
  closable = true,
  onClose = null,
  className = '',
} = {}) {
  const root = document.getElementById('modal-root');
  if (!root) return { close() {}, node: null, setFooter() {} };

  if (openCount === 0) {
    lastFocused = document.activeElement;
    root.replaceChildren();
    root.hidden = false;
  }
  openCount += 1;

  const closeBtn = el('button', {
    class: 'modal-close', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)',
    html: '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
  });

  const footerNode = el('div', { class: 'modal-foot' });
  for (const f of footer) {
    footerNode.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  const bodyNode = el('div', { class: 'modal-body' }, body ? [body] : []);

  const modal = el('div', {
    class: `modal ${className}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    style: width ? { '--modal-w': typeof width === 'number' ? `${width}px` : width } : null,
  }, [
    el('div', { class: 'modal-head' }, [
      el('div', { class: 'modal-title', text: title }),
      closable ? closeBtn : null,
    ]),
    bodyNode,
    footerNode,
  ]);

  root.append(modal);

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    if (bgHandler) root.removeEventListener('pointerdown', bgHandler);
    openCount = Math.max(0, openCount - 1);
    modal.remove();
    if (openCount === 0) {
      root.hidden = true;
      root.replaceChildren();
      lastFocused?.focus?.();
    }
    document.removeEventListener('keydown', onKey, true);
    onClose?.(result);
  };

  const onKey = (e) => {
    if (!closable) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      trapFocus(e, modal);
    }
  };

  closeBtn.addEventListener('click', () => close());

  // 배경 클릭 시 닫기. once가 아니라 명시 제거로 관리한다:
  // once는 내부 클릭에도 소모되어 이후 배경 클릭이 영구 불발되고,
  // 중첩 모달에서는 최상위만 닫혀야 한다.
  let bgHandler = null;
  if (closable) {
    bgHandler = (e) => {
      if (e.target === root && root.lastElementChild === modal) close();
    };
    root.addEventListener('pointerdown', bgHandler);
  }

  document.addEventListener('keydown', onKey, true);

  // 첫 입력 요소에 포커스
  requestAnimationFrame(() => {
    const first = modal.querySelector('input, select, textarea, button:not(.modal-close)');
    first?.focus();
  });

  return {
    close,
    node: modal,
    body: bodyNode,
    setFooter(nodes) {
      footerNode.replaceChildren(...nodes);
    },
  };
}

function trapFocus(e, container) {
  const focusables = [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((n) => n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function anyModalOpen() {
  return openCount > 0;
}

export function closeTopModal() {
  const root = document.getElementById('modal-root');
  const last = root?.lastElementChild;
  last?.querySelector('.modal-close')?.click();
}
