/**
 * 단축키 처리
 *
 * 사용자가 설정한 가속키 문자열을 매핑 테이블로 역변환해
 * 키다운 이벤트 한 번으로 액션을 O(1) 에 찾는다.
 *
 * 처리 순서 (KMPlayer 관례)
 *   1. dialog/입력 필드에 포커스가 있으면 대부분의 단축키를 무시 (Esc 는 닫기)
 *   2. 슬래더 등 연속 입력 요소는 방향키를 요소에 먼저 넘김
 *   3. 나머지는 전역 액션으로 처리
 */
import { normalizeAccel, accelFromEvent } from './util.js';

class HotkeyManager {
  constructor({ api, actions }) {
    this.api = api;
    this.actions = actions;
    this.lookup = new Map();     // 정규화된 accel → action 이름
    this.pressed = new Map();    // action 이름 → 마지막 입력 시각 (Set 아님 주의)
    this.enabled = true;
    this.rebuild();
  }

  /** 설정이 바뀔 때마다 다시 만든다 */
  rebuild() {
    this.lookup.clear();
    if (!this.enabled) return;
    const map = this.api.settings.get('hotkeys.map') ?? {};
    for (const [action, accels] of Object.entries(map)) {
      for (const accel of [].concat(accels ?? [])) {
        if (!accel) continue;
        this.lookup.set(normalizeAccel(accel), action);
      }
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.rebuild();
  }

  /** 이벤트 → 정규화된 accel 문자열 */
  accelFromEvent(e) {
    return normalizeAccel(accelFromEvent(e) ?? '');
  }

  /** 이 이벤트가 가로채야 하는지 판단 */
  shouldHandle(e) {
    const target = e.target;
    const tag = target?.tagName;

    // 텍스트 입력 중: Esc / F5 계열만 통과
    const isTextInput = tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(target.type)
      || tag === 'TEXTAREA'
      || target?.isContentEditable;
    if (isTextInput) {
      const accel = normalizeAccel(accelFromEvent(e) ?? '');
      return ['Escape', 'F5'].includes(accel) || this.lookup.has(accel) && accel.startsWith('F');
    }

    // 슬라이더: 방향키는 요소가 먼저 처리하도록 내버려 둔다 (기본 동작 유지)
    if (tag === 'INPUT' && target.type === 'range' && e.key.startsWith('Arrow')) {
      return false;
    }
    return true;
  }

  handle(e) {
    if (!this.enabled) return false;
    if (!this.shouldHandle(e)) return false;

    const accel = normalizeAccel(accelFromEvent(e) ?? '');
    if (!accel) return false;

    const action = this.lookup.get(accel);
    if (!action) return false;

    // 오토리페이트 방지: 같은 조합이 2회 연속으로 들어오면 무시 (키 반복)
    const prev = e.timeStamp - (this.pressed.get(action) ?? -1e9);
    this.pressed.set(action, e.timeStamp);
    if (prev < 60) return true;

    const fn = this.actions[action];
    if (typeof fn !== 'function') return true;

    e.preventDefault();
    e.stopPropagation();
    try {
      fn(e);
    } catch (err) {
      console.error(`[hotkey:${action}]`, err);
    }
    return true;
  }

  /** 키 반복(repeat)만으로는 재발동하지 않게 하는 헬퍼 (볼륨 등 누적용) */
  isRepeat(action, threshold = 60) {
    const now = performance.now();
    const last = this.pressed.get(action) ?? -1e9;
    return now - last < threshold;
  }
}

export { HotkeyManager };
