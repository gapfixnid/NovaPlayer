'use strict';
/**
 * 원자적(atomic) JSON 저장소.
 * - 쓰기 실패 시 기존 파일 손상 방지 (임시 파일 → rename)
 * - 외부 편집/손상 복구를 위한 스키마 병합 및 백업
 */
const fs = require('node:fs');
const path = require('node:path');

/** 프로토타입 오염 키 — 설정 경로·병합 어디에서도 허용하지 않는다 */
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isPoisonKey(k) {
  return typeof k === 'string' && POISON_KEYS.has(k);
}

class JsonStore {
  /**
   * @param {string} fileName 저장 파일명
   * @param {object} defaults 기본값 객체
   * @param {object} [opts]
   * @param {boolean} [opts.deep] 기본값과 병합할 때 객체 키까지 병합할지
   */
  constructor(fileName, defaults, opts = {}) {    this.fileName = fileName;
    this.defaults = defaults;
    this.deep = opts.deep !== false;
    this.data = this._load();
    this._writeTimer = null;
  }

  get filePath() {
    return path.join(global.novaPaths.userData, this.fileName);
  }

  _load() {
    const file = this.filePath;
    let parsed = null;
    try {
      if (fs.existsSync(file)) {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      // 손상된 파일은 .corrupt 로 보존
      try {
        fs.renameSync(file, `${file}.corrupt`);
        global.novaLog?.warn(`손상된 설정 파일을 보존했습니다: ${err.message}`);
      } catch { /* noop */ }
      parsed = null;
    }
    return this._merge(structuredClone(this.defaults), parsed);
  }

  _merge(target, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
    for (const [key, val] of Object.entries(patch)) {
      if (isPoisonKey(key)) continue; // 프로토타입 오염 차단
      if (!(key in target)) continue; // 알 수 없는 키는 버림(오타 방지)
      if (
        this.deep &&
        val && typeof val === 'object' && !Array.isArray(val) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      ) {
        this._merge(target[key], val);
      } else if (val !== undefined && (typeof val === typeof target[key] || target[key] === null)) {
        // 배열↔일반객체 혼동 차단 (둘 다 typeof object라 별도 검사 필요)
        if (target[key] !== null && Array.isArray(val) !== Array.isArray(target[key])) {
          global.novaLog?.warn(`타입 불일치로 무시됨: ${key}`);
        } else {
          target[key] = val;
        }
      } else if (val !== undefined) {
        global.novaLog?.warn(`타입 불일치로 무시됨: ${key}`);
      }
    }
    return target;
  }

  get(key, fallback) {
    if (key === undefined) return this.data;
    const parts = String(key).split('.');
    if (parts.some(isPoisonKey)) return fallback;
    return parts.reduce((acc, k) => (acc == null ? acc : acc[k]), this.data) ?? fallback;
  }

  set(keyOrPatch, value) {
    if (typeof keyOrPatch !== 'object' || keyOrPatch === null) {
      // 문자열 경로도 객체 패치로 변환해 동일한 화이트리스트·타입 검증을 탄다
      // (직접 대입 시 스키마 외 키가 영속되는 우회 방지)
      const keys = String(keyOrPatch).split('.');
      if (keys.some(isPoisonKey)) {
        global.novaLog?.warn(`차단된 설정 키: ${keyOrPatch}`);
        return this.data;
      }
      const last = keys.pop();
      const patch = {};
      let node = patch;
      for (const k of keys) node = node[k] = {};
      node[last] = value;
      keyOrPatch = patch;
    }
    this._merge(this.data, keyOrPatch);
    this.scheduleSave();
    return this.data;
  }

  reset() {
    this.data = structuredClone(this.defaults);
    this.save();
  }

  scheduleSave(delay = 400) {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this.save(), delay);
  }

  save() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    const file = this.filePath;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      global.novaLog?.error(`설정 저장 실패: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
      return false;
    }
  }
}

module.exports = { JsonStore };
