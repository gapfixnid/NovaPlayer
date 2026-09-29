/**
 * 자막 렌더러
 *
 * - 활성화된 cue 를 레이어에 그린다
 * - 사용자 설정(글꼴/크기/색/테두리/여백/정렬/투명도)을 실시간 반영
 * - ASS 스타일은 설정에서 "ASS 스타일 사용" 이 켜져 있을 때만 존중
 * - 카라오케(\k) 는 겹친 span 으로 채워지는 색으로 표현
 * - 페이드 인/아웃, \pos 위치 지정 지원
 * - 재생 속도/지연은 main.js 에서 time 변환 시 반영
 */
import { el, clamp, withAlpha } from '../util.js';
import { findActiveCues } from './parser.js';

const MAX_ACTIVE = 6;

class SubtitleRenderer {
  constructor(layer, settings) {
    this.layer = layer;
    this.settings = settings;
    this.cues = [];
    this.hint = 0;
    this.cacheKey = '';
    this.lastActive = [];
    this.readingMode = 'default';
  }

  setCues(cues) {
    this.cues = cues ?? [];
    this.hint = 0;
    this.lastActive = [];
    this.layer.innerHTML = '';
    this.cacheKey = '';
  }

  setSettings(settings) {
    this.settings = settings;
    this.cacheKey = '';   // 스타일 강제 갱신
  }

  setReadingMode(mode) {
    this.readingMode = mode;
    this.cacheKey = '';
  }

  clear() {
    this.cues = [];
    this.hint = 0;
    this.lastActive = [];
    this.layer.innerHTML = '';
  }

  /** video 크기에 맞춰 자막 크기 배율 계산 */
  scaleFactor() {
    const s = this.settings;
    if (s.fontScaleFollowVideo === false) return 1;
    const stage = this.layer.getBoundingClientRect();
    const h = stage.height || 1080;
    // 1080p 기준 24px 를 기준으로 선형 스케일 (축소 화면에서 과도하게 크지 않게 sqrt 보정)
    return clamp((h / 1080) ** 0.75, 0.6, 3);
  }

  /** 현재 시각에 맞는 cue 를 그린다. 매 프레임 호출. */
  update(time) {
    if (!this.settings.enabled || !this.cues.length) {
      if (this.lastActive.length) {
        this.layer.innerHTML = '';
        this.lastActive = [];
        this.cacheKey = '';
      }
      return;
    }

    const { active, hint } = findActiveCues(this.cues, time, this.hint);
    this.hint = hint;

    const limited = active.slice(0, MAX_ACTIVE);
    const key = limited.map((c) => c.index).join(',') + '|' + this.cacheKey;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.layer.innerHTML = '';
    if (!limited.length) {
      this.lastActive = [];
      return;
    }

    const scale = this.scaleFactor();
    const frag = document.createDocumentFragment();
    for (const cue of limited) {
      frag.append(this.buildCueElement(cue, time, scale));
    }
    this.layer.append(frag);
    this.lastActive = limited;
  }

  buildCueElement(cue, time, scale) {
    const s = this.settings;
    const useAss = s.useSubtitleStyle !== false && cue.style?.isAss;

    // ── 텍스트 ──
    const text = cue.text;
    const lines = this.readingMode === 'top'
      ? text.split('\n').reverse()          // 가장 위 줄을 아래로 (읽기 모드: 위줄 먼저)
      : text.split('\n');

    const node = el('div', { class: `sub-line${useAss ? ' is-ass' : ''}` });

    // ── 위치/정렬 ──
    const stageW = this.layer.clientWidth;
    const stageH = this.layer.clientHeight;

    let align = s.alignment ?? 'bottom';
    let vAlignPct = 100;
    if (useAss && cue.style.alignNum) {
      const n = cue.style.alignNum;
      vAlignPct = n >= 7 ? 0 : n >= 4 ? 50 : 100;
      align = cue.style.align === 'left' ? 'left' : cue.style.align === 'right' ? 'right' : 'center';
    }
    if (useAss && cue.style.vAlignPct !== undefined) vAlignPct = cue.style.vAlignPct;

    node.style.alignSelf = vAlignPct <= 0 ? 'start' : vAlignPct >= 100 ? 'end' : 'center';
    node.style.justifySelf = align === 'left' ? 'start' : align === 'right' ? 'end' : 'center';
    node.style.textAlign = align;

    // ── 여백 ──
    const marginScale = (stageH / 1080) ** 0.85;
    const mv = clamp((s.marginVertical ?? 42) * marginScale, 0, stageH * 0.7);
    const mh = clamp((s.marginHorizontal ?? 60) * marginScale, 0, stageW * 0.45);

    if (useAss && cue.style.pos) {
      // \pos 좌표는 스크립트 해상도(기본 384x288) 기준 → 비율로 변환
      const px = (cue.style.pos.x / 384) * stageW;
      const py = (cue.style.pos.y / 288) * stageH;
      node.style.position = 'absolute';
      node.style.left = `${clamp(px, 0, stageW)}px`;
      node.style.top = `${clamp(py, 0, stageH)}px`;
      node.style.transform = 'translate(-50%, -50%)';
    } else {
      node.style.marginBottom = `${mv}px`;
      if (align === 'center') node.style.maxWidth = `${stageW - mh * 2}px`;
      else if (align === 'left') node.style.marginLeft = `${mh}px`;
      else node.style.marginRight = `${mh}px`;
    }

    // ── 글꼴/크기 ──
    const baseSize = useAss && cue.style.size
      ? cue.style.size * 1.9                        // ASS PlayResY(288) → 1080 스케일 보정
      : (s.fontSize ?? 24);
    const fontSize = clamp(baseSize * scale, 8, 240);

    node.style.fontFamily = `"${useAss && cue.style.font ? cue.style.font : (s.fontFamily ?? 'Malgun Gothic')}", ${s.fontFamily ?? 'Malgun Gothic'}, sans-serif`;
    node.style.fontSize = `${fontSize}px`;
    node.style.fontWeight = (useAss ? cue.style.bold : s.bold) ? '700' : '400';
    node.style.fontStyle = (useAss ? cue.style.italic : s.italic) ? 'italic' : 'normal';
    const decorations = [];
    if (useAss && cue.style.underline) decorations.push('underline');
    if (useAss && cue.style.strikeout) decorations.push('line-through');
    node.style.textDecoration = decorations.length ? decorations.join(' ') : 'none';

    if (useAss && cue.style.scaleX && cue.style.scaleX !== 1) {
      node.style.transform = `${node.style.transform || ''} scaleX(${cue.style.scaleX})`.trim();
    }

    // ── 색상/테두리 ──
    const color = useAss && cue.style.color ? cue.style.color : (s.fontColor ?? '#ffffff');
    let opacity = clamp(s.opacity ?? 100, 0, 100) / 100;
    if (useAss && cue.style.opacity !== undefined) opacity *= cue.style.opacity;

    node.style.color = color;
    node.style.opacity = String(opacity);

    if (useAss) {
      // ASS 스타일은 자체 외곽선/그림자 색을 사용
      const ow = fontSize * 0.055;
      const oc = withAlpha(cue.style.outlineColor ?? '#000000', (cue.style.outlineOpacity ?? 1) * opacity);
      const sc = withAlpha(cue.style.shadowColor ?? '#000000', (cue.style.shadowOpacity ?? 1) * 0.8 * opacity);
      node.style.webkitTextStroke = `${ow.toFixed(2)}px ${oc}`;
      node.style.paintOrder = 'stroke fill';
      node.style.textShadow = `${(ow * 0.9).toFixed(1)}px ${(ow * 0.9).toFixed(1)}px 0 ${sc}`;
    } else {
      const ow = clamp(s.outlineWidth ?? 2, 0, 10) * (scale ** 0.5);
      if (ow > 0) {
        node.style.webkitTextStroke = `${ow.toFixed(2)}px ${withAlpha(s.outlineColor ?? '#000000', opacity)}`;
        node.style.paintOrder = 'stroke fill';
      }
      const sh = clamp(s.shadow ?? 1, 0, 8);
      node.style.textShadow = sh > 0
        ? `${sh}px ${sh}px ${sh * 1.5}px ${withAlpha('#000000', 0.85 * opacity)}`
        : 'none';
    }

    // 배경
    const bgA = clamp(s.backgroundOpacity ?? 0, 0, 100) / 100;
    if (bgA > 0) {
      node.style.background = withAlpha(s.backgroundColor ?? '#000000', bgA);
      node.style.borderRadius = '3px';
    }

    // ── 페이드 ──
    let fadeAlpha = opacity;
    if (useAss && cue.style.fadeIn) {
      const t = time - cue.start;
      if (t < cue.style.fadeIn) fadeAlpha *= clamp(t / cue.style.fadeIn, 0, 1);
    }
    if (useAss && cue.style.fadeOut) {
      const t = cue.end - time;
      if (t < cue.style.fadeOut) fadeAlpha *= clamp(t / cue.style.fadeOut, 0, 1);
    }
    node.style.opacity = String(fadeAlpha);

    // ── 본문 ──
    if (cue.karaoke && useAss) {
      node.append(this.buildKaraoke(cue, time, color));
    } else {
      node.textContent = lines.join('\n');
    }
    if (!useAss && lines.length > 1) {
      node.style.whiteSpace = 'pre-wrap';
    }

    return node;
  }

  /** 카라오케: 각 세그먼트를 겹친 span 으로 렌더하고 채워진 부분만 색을 바꾼다 */
  buildKaraoke(cue, time, baseColor) {
    const wrap = document.createDocumentFragment();
    const segs = cue.karaoke;

    for (const seg of segs) {
      const outer = el('span', { class: 'sub-karaoke' });
      outer.append(document.createTextNode(seg.text));

      // 이미 지나간 부분: 채워진 색
      const done = time >= seg.end;
      if (done) {
        outer.style.color = '#ffd94a';
      } else if (time > seg.start) {
        const p = (time - seg.start) / Math.max(0.001, seg.end - seg.start);
        const fill = el('span', { class: 'sub-karaoke-fill' });
        fill.style.color = '#ffd94a';
        fill.style.width = `${(p * 100).toFixed(2)}%`;
        // 잘라 보일 본문을 복제해야 wipe 효과가 렌더된다
        fill.append(document.createTextNode(seg.text));
        outer.append(fill);
        outer.style.color = baseColor;
      }
      // 완료 하이라이트는 유지하고, 그 외에만 세그먼트 고유색 적용
      if (!done && seg.style?.color) outer.style.color = seg.style.color;
      wrap.append(outer);
    }
    return wrap;
  }

  /** 현재 화면에 표시 중인 cue 텍스트 (OCR/검색용) */
  currentText() {
    return this.lastActive.map((c) => c.text).join('\n');
  }
}

export { SubtitleRenderer };
