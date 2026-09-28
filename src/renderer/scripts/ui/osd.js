/** OSD (화면 위 일시 표시) */
import { clamp } from '../util.js';

class Osd {
  constructor() {
    this.node = document.getElementById('osd');
    this.titleNode = document.getElementById('osd-title');
    this.bodyNode = document.getElementById('osd-body');
    this.bar = document.getElementById('osd-bar');
    this.barFill = document.getElementById('osd-bar-fill');
    this.timer = null;
    this.defaultDuration = 1300;
  }

  setPosition(pos) {
    this.node.dataset.pos = pos ?? 'bottom';
  }

  /**
   * @param {object} opts
   *   title : 상단 라벨
   *   body  : 중앙 값 (HTML 허용하지 않음 — 텍스트만)
   *   sub   : 작은 보조 텍스트
   *   percent : 0~100 progress 표시
   *   duration : 표시 시간(ms)
   */
  show({ title = '', body = '', sub = '', percent = null, duration = this.defaultDuration } = {}) {
    const n = this.node;
    n.hidden = false;
    this.titleNode.textContent = title;
    this.bodyNode.textContent = '';
    if (body) {
      this.bodyNode.append(document.createTextNode(body));
      if (sub) this.bodyNode.append(Object.assign(document.createElement('small'), { textContent: sub }));
    }
    this.titleNode.style.display = title ? '' : 'none';
    this.bodyNode.style.display = body ? '' : 'none';

    if (percent === null) {
      this.bar.classList.add('hidden');
    } else {
      this.bar.classList.remove('hidden');
      this.barFill.style.width = `${clamp(percent, 0, 100).toFixed(1)}%`;
    }

    // 표시 애니메이션을 위해 한 프레임 강제 후 클래스 부여
    requestAnimationFrame(() => n.classList.add('show'));
    this._announce([title, body, sub].filter(Boolean).join(' '));

    if (this.timer) clearTimeout(this.timer);
    if (duration > 0) {
      this.timer = setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    this.node.classList.remove('show');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    setTimeout(() => {
      if (!this.node.classList.contains('show')) this.node.hidden = true;
    }, 220);
  }

  /** 화면 낭독용 (스크린리더) */
  _announce(text) {
    const live = document.getElementById('a11y-live');
    if (!live || !text) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 40);
  }

  // ── 자주 쓰는 프리셋 ──
  volume(value, muted) {
    this.show({
      title: muted ? '음소거' : '볼륨',
      body: muted ? 'Mute' : `${value}`,
      sub: muted ? '' : '%',
      percent: muted ? 0 : value,
      duration: 1100,
    });
  }

  speed(value) {
    this.show({ title: '재생 속도', body: `${value.toFixed(2).replace(/\.?0+$/, '')}x`, duration: 1100 });
  }

  seekTo(target, from) {
    const dir = target > from ? '앞으로' : '뒤로';
    this.show({
      title: dir,
      body: `${(Math.abs(target - from)).toFixed(1)}초`,
      duration: 900,
    });
  }

  info(title, body) {
    this.show({ title, body, duration: 1600 });
  }
}

export const osd = new Osd();
export { Osd };
