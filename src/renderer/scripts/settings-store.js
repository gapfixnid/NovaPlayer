/**
 * 렌더러용 동기 설정 스토어.
 *
 * preload 브리지(api.settings)는 IPC 비동기이지만, 렌더러 UI 100여 곳은
 * 설정을 동기로 읽는다. 여기서 부트스트랩 스냅샷을 들고 있다가
 * 동기 get + 즉시 반영 set 을 제공하고, 저장은 백그라운드 IPC 로 위임한다.
 *
 *   get(path?, fallback)  — 동기 읽기. path 없으면 전체 데이터
 *   set(path | patch, value?) — 로컬 즉시 반영 + change 이벤트 + IPC 저장
 *   patch(obj)             — set(obj)와 동일
 *   reset()                — main 기본값으로 복원 후 스냅샷 교체
 *   refresh()              — main 에서 다시 읽어 스냅샷 교체
 *   export/import()        — main 대화상자 경유, 성공 시 스냅샷 교체
 */
import { Emitter } from './util.js';

function getPath(obj, path) {
  if (path === undefined || path === null || path === '') return obj;
  return String(path).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  node[last] = value;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** patch 를 기존 데이터에 깊은 병합 */
function mergePatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) mergePatch(target[k], v);
    else target[k] = v;
  }
}

export class SettingsStore extends Emitter {
  /**
   * @param {object} bridge preload 브리지의 settings 네임스페이스 (비동기 IPC)
   * @param {object} initial app:bootstrap 으로 받은 설정 스냅샷
   */
  constructor(bridge, initial = {}) {
    super();
    this.bridge = bridge;
    this.data = structuredClone(initial);
  }

  get(path, fallback) {
    if (path === undefined || path === null || path === '') return this.data;
    const v = getPath(this.data, path);
    return v === undefined ? fallback : v;
  }

  /**
   * 로컬에 즉시 반영하고 main 에 저장을 요청한다.
   * IPC 실패 시 다음 refresh() 때 main 값으로 되돌아간다.
   */
  set(pathOrPatch, value) {
    if (isPlainObject(pathOrPatch) && value === undefined) {
      mergePatch(this.data, pathOrPatch);
      this.emit('change', this.data, pathOrPatch);
      this.bridge.patch(pathOrPatch).catch((err) => {
        console.warn('[settings] 저장 실패:', err?.message ?? err);
      });
    } else {
      setPath(this.data, pathOrPatch, value);
      this.emit('change', this.data, { [pathOrPatch]: value });
      this.emit(`change:${pathOrPatch}`, value);
      this.bridge.set(pathOrPatch, value).catch((err) => {
        console.warn('[settings] 저장 실패:', err?.message ?? err);
      });
    }
    return this.data;
  }

  patch(obj) {
    return this.set(obj);
  }

  /** main 기본값으로 복원 */
  async reset() {
    const data = await this.bridge.reset();
    if (data) {
      this.data = data;
      this.emit('change', this.data, null);
      this.emit('reset', this.data);
    }
    return this.data;
  }

  /** main 에서 다시 읽어오기 (가져오기/외부 변경 후) */
  async refresh() {
    const data = await this.bridge.get();
    if (data) {
      this.data = data;
      this.emit('change', this.data, null);
    }
    return this.data;
  }

  async export() {
    return this.bridge.export();
  }

  async import() {
    const data = await this.bridge.import();
    if (data) await this.refresh();
    return this.data;
  }
}
