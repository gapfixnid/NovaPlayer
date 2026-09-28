/**
 * 설정 대화상자
 *
 * 모든 항목은 저장 즉시(main 에 IPC) + 즉시 재생에 반영된다.
 * 선언적 스키마로 UI 를 생성해 설정 추가·수정이 한 곳에서 끝나도록 했다.
 */
import { el, clamp, prettyKey, debounce, normalizeAccel, accelFromEvent } from '../util.js';
import { openModal } from './modal.js';
import { toastOk, toastError, toastInfo } from './toast.js';
import { EQ_PRESETS, EQ_PRESET_LABELS, HOTKEY_LABELS } from '../constants.js';

const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

const TABS = [
  { id: 'interface', label: '일반/외관', icon: '⚙' },
  { id: 'playback', label: '재생', icon: '▶' },
  { id: 'video', label: '영상', icon: '▣' },
  { id: 'audio', label: '음성', icon: '♪' },
  { id: 'subtitle', label: '자막', icon: '⌸' },
  { id: 'hotkeys', label: '단축키', icon: '⌨' },
  { id: 'tools', label: '코덱/도구', icon: '⚙' },
  { id: 'about', label: '정보/개인정보', icon: 'ℹ' },
];

// ─────────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────────
const SCHEMA = {
  interface: [
    {
      title: '외관',
      rows: [
        { path: 'ui.theme', type: 'select', label: '테마', options: [['dark', '다크'], ['midnight', '미드나이트'], ['light', '라이트']] },
        { path: 'ui.accent', type: 'color', label: '강조 색상' },
        { path: 'ui.fontScale', type: 'range', label: '글자 크기', min: 0.85, max: 1.4, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
        { path: 'ui.showMenubar', type: 'check', label: '메뉴바 표시' },
        { path: 'ui.showControlsOnHover', type: 'check', label: '마우스 올리면 컨트롤 표시' },
        { path: 'ui.hideControlsDelay', type: 'range', label: '컨트롤 숨김 지연', min: 500, max: 6000, step: 200, unit: 'ms' },
        { path: 'ui.osdStyle', type: 'select', label: 'OSD 위치', options: [['bottom', '하단'], ['top', '상단'], ['center', '가운데']] },
        { path: 'ui.startInFullscreen', type: 'check', label: '시작할 때 전체화면' },
        { path: 'ui.pauseOnMinimize', type: 'check', label: '최소화 시 일시정지' },
        { path: 'ui.minimizeToTray', type: 'check', label: '최소화 시 트레이로' },
        { path: 'ui.closeToTray', type: 'check', label: '닫기 버튼으로 트레이 이동' },
      ],
    },
  ],

  playback: [
    {
      title: '재생 동작',
      rows: [
        { path: 'playback.autoPlayNext', type: 'check', label: '다음 파일 자동 재생' },
        { path: 'playback.autoPlayNextDelay', type: 'range', label: '다음 파일 대기', min: 0, max: 10, step: 0.5, unit: '초' },
        { path: 'playback.loopPlaylist', type: 'check', label: '목록 전체 반복' },
        { path: 'playback.loopOne', type: 'check', label: '현재 파일만 반복' },
        { path: 'playback.shufflePlaylist', type: 'check', label: '셔플 재생' },
        { path: 'playback.playAndExit', type: 'check', label: '재생 후 종료' },
      ],
    },
    {
      title: '이어보기',
      desc: '지난번 보던 위치에서 이어서 재생합니다.',
      rows: [
        { path: 'playback.resumePlayback', type: 'check', label: '마지막 재생 위치 이어보기' },
        { path: 'playback.rewindOnLoad', type: 'range', label: '이어보기 시 되감기', min: 0, max: 30, step: 1, unit: '초', hint: '장면을 확인하기 위해 앞부분을 조금 되감아 재생합니다.' },
      ],
    },
    {
      title: '탐색',
      rows: [
        { path: 'playback.seekStepSmall', type: 'range', label: '← → 탐색 간격', min: 1, max: 60, step: 1, unit: '초' },
        { path: 'playback.seekStepMedium', type: 'range', label: 'Shift+← → 탐색 간격', min: 5, max: 300, step: 5, unit: '초' },
        { path: 'playback.seekStepLarge', type: 'range', label: 'Ctrl+← → 탐색 간격', min: 10, max: 900, step: 10, unit: '초' },
        { path: 'playback.preservePitch', type: 'check', label: '속도 변경 시 음높이 유지' },
        { path: 'playback.sleepTimerMinutes', type: 'select', label: '기본 취침 타이머', options: [[0, '없음'], [5, '5분'], [10, '10분'], [15, '15분'], [30, '30분'], [45, '45분'], [60, '60분'], [90, '90분'], [120, '120분']] },
      ],
    },
  ],

  video: [
    {
      title: '영상 필터',
      desc: 'CPU 를 쓰지 않는 GPU 필터라 고해상도에서도 재생이 끊기지 않습니다.',
      rows: [
        { path: 'video.brightness', type: 'range', label: '밝기', min: -100, max: 100, step: 1, resetable: true },
        { path: 'video.contrast', type: 'range', label: '대비', min: -100, max: 100, step: 1, resetable: true },
        { path: 'video.saturation', type: 'range', label: '채도', min: -100, max: 100, step: 1, resetable: true },
        { path: 'video.hue', type: 'range', label: '색상조절', min: -180, max: 180, step: 1, unit: '°', resetable: true },
        { path: 'video.gamma', type: 'range', label: '감마', min: 10, max: 300, step: 5, unit: '%', resetable: true },
      ],
    },
    {
      title: '화면',
      rows: [
        { path: 'video.zoomMode', type: 'select', label: '확대/축소', options: [['fit', '화면에 맞게'], ['fill', '화면 채우기'], ['1:1', '100%'], ['2:1', '200%'], ['custom', '사용자 지정']] },
        { path: 'video.zoomCustom', type: 'range', label: '사용자 배율', min: 10, max: 400, step: 5, unit: '%' },
        { path: 'video.aspectMode', type: 'select', label: '화면비', options: [['auto', '원본'], ['1:1', '1:1'], ['4:3', '4:3'], ['16:9', '16:9'], ['16:10', '16:10'], ['21:9', '21:9'], ['3:2', '3:2']] },
        { path: 'video.rotation', type: 'select', label: '회전', options: [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']] },
        { path: 'video.flipH', type: 'check', label: '좌우 반전' },
        { path: 'video.flipV', type: 'check', label: '상하 반전' },
        { path: 'video.deinterlace', type: 'select', label: '인터레이스 제거', options: [['auto', '자동 (필드 순서 감지)'], ['on', '항상 켜기'], ['off', '끄기']], hint: '자동 모드는 실제로 인터레이스 기록된 영상에서만 켜집니다.' },
      ],
    },
  ],

  audio: [
    {
      title: '기본',
      rows: [
        { path: 'audio.volume', type: 'range', label: '볼륨', min: 0, max: 100, step: 1, unit: '%' },
        { path: 'audio.muted', type: 'check', label: '음소거' },
        { path: 'audio.channelMode', type: 'select', label: '채널', options: [['auto', '자동'], ['stereo', '스테레오'], ['left', '왼쪽만'], ['right', '오른쪽만'], ['mono', '모노 합성']] },
        { path: 'audio.balance', type: 'range', label: '밸런스', min: -100, max: 100, step: 1 },
        { path: 'audio.audioDelay', type: 'range', label: '음성 지연', min: -2000, max: 2000, step: 10, unit: 'ms' },
        { path: 'audio.crossfade', type: 'range', label: '크로스페이드', min: 0, max: 10, step: 0.5, unit: '초', hint: '다음 파일 전환 시 겹쳐 재생합니다.' },
      ],
    },
    {
      title: '이퀄라이저',
      rows: [
        { path: 'audio.equalizerEnabled', type: 'check', label: '이퀄라이저 사용' },
        { path: 'audio.equalizerPreset', type: 'preset', label: '프리셋' },
        { render: (ctx) => ctx.eq() },
      ],
    },
    {
      title: '음향 효과',
      desc: '실제 오디오 신호를 DSP 그래프로 처리합니다 (무손실, 지연 없음).',
      rows: [
        { path: 'audio.bassBoost', type: 'range', label: '베이스 부스트', min: 0, max: 20, step: 1, unit: ' dB' },
        { path: 'audio.bassFreq', type: 'range', label: '베이스 주파수', min: 40, max: 400, step: 10, unit: ' Hz' },
        { path: 'audio.superBass', type: 'range', label: '슈퍼베이스', min: -15, max: 15, step: 1, unit: ' dB', hint: '62Hz 부근을 보정합니다.' },
        { path: 'audio.vocalBoost', type: 'range', label: '보컬 부스트', min: -15, max: 15, step: 1, unit: ' dB', hint: '음성 대역(2.2kHz) 강조 — 노래에서 보컬을 분리할 때' },
        { path: 'audio.treble', type: 'range', label: '트레블', min: -15, max: 15, step: 1, unit: ' dB' },
        { path: 'audio.surround', type: 'check', label: '3D 서라운드' },
        { path: 'audio.surroundDepth', type: 'range', label: '서라운드 깊이', min: 0, max: 100, step: 5, unit: '%' },
      ],
    },
    {
      title: '음량 정규화',
      rows: [
        { path: 'audio.normalizer', type: 'check', label: '자동 정규화', hint: '소리가 큰 파일은 줄이고 작은 파일은 키워 체감을 맞춥니다.' },
        { path: 'audio.normalizerTarget', type: 'range', label: '목표 음량', min: -30, max: -6, step: 1, unit: ' dB' },
        { path: 'audio.replayGainMode', type: 'select', label: 'ReplayGain', options: [['off', '끄기'], ['track', '트랙별'], ['album', '앨범 전체']], hint: '재생 중 실제 음량을 측정해 파일 간 볼륨 차이를 맞춥니다.' },
      ],
    },
  ],

  subtitle: [
    {
      title: '표시',
      rows: [
        { path: 'subtitle.enabled', type: 'check', label: '자막 표시' },
        { path: 'subtitle.autoDetect', type: 'check', label: '자동 자막 불러오기', hint: '영상과 같은 이름의 자막 파일을 자동으로 찾습니다.' },
        { path: 'subtitle.useSubtitleStyle', type: 'check', label: 'ASS/SSA 스타일 사용', hint: '꺼내면 모든 자막을 아래 설정으로 통일합니다.' },
        { path: 'subtitle.fontFamily', type: 'text', label: '글꼴', hint: '설치된 글꼴 이름을 입력하세요 (예: 맑은 고딕)' },
        { path: 'subtitle.fontSize', type: 'range', label: '글자 크기', min: 10, max: 72, step: 1 },
        { path: 'subtitle.fontScaleFollowVideo', type: 'check', label: '화면 크기에 맞춰 조절' },
        { path: 'subtitle.bold', type: 'check', label: '굵게' },
        { path: 'subtitle.italic', type: 'check', label: '기울임' },
        { path: 'subtitle.fontColor', type: 'color', label: '글자 색' },
        { path: 'subtitle.outlineColor', type: 'color', label: '테두리 색' },
        { path: 'subtitle.outlineWidth', type: 'range', label: '테두리 두께', min: 0, max: 6, step: 0.5 },
        { path: 'subtitle.shadow', type: 'range', label: '그림자', min: 0, max: 5, step: 1 },
        { path: 'subtitle.opacity', type: 'range', label: '투명도', min: 20, max: 100, step: 1, unit: '%' },
        { path: 'subtitle.backgroundOpacity', type: 'range', label: '배경', min: 0, max: 100, step: 5, unit: '%' },
        { path: 'subtitle.backgroundColor', type: 'color', label: '배경 색' },
      ],
    },
    {
      title: '위치',
      rows: [
        { path: 'subtitle.alignment', type: 'select', label: '정렬', options: [['bottom', '아래'], ['top', '위'], ['middle', '가운데']] },
        { path: 'subtitle.marginVertical', type: 'range', label: '세로 여백', min: 0, max: 300, step: 2, unit: 'px' },
        { path: 'subtitle.marginHorizontal', type: 'range', label: '가로 여백', min: 0, max: 300, step: 2, unit: 'px' },
        { path: 'subtitle.readingMode', type: 'select', label: '읽기 모드', options: [['default', '기본'], ['top', '윗줄부터']] },
      ],
    },
    {
      title: '언어 / 보정',
      rows: [
        { path: 'subtitle.preferredLanguages', type: 'list', label: '우선 언어', hint: '쉼표로 구분 (예: ko, en, ja)' },
        { path: 'subtitle.delay', type: 'range', label: '자막 지연', min: -10000, max: 10000, step: 100, unit: 'ms' },
        { path: 'subtitle.speed', type: 'range', label: '자막 속도', min: 0.5, max: 2, step: 0.05, unit: 'x' },
      ],
    },
  ],

  tools: [
    {
      title: 'ffmpeg',
      desc: '번들된 ffmpeg 로 넓은 포맷을 지원합니다. 직접 설치본을 쓰려면 경로를 지정하세요.',
      rows: [
        { path: 'ffmpeg.enabled', type: 'check', label: 'ffmpeg 사용' },
        { path: 'ffmpeg.customPath', type: 'text', label: 'ffmpeg 경로', placeholder: 'C:\\ffmpeg\\bin\\ffmpeg.exe' },
        { path: 'ffmpeg.ffprobeEnabled', type: 'check', label: 'ffprobe 로 미디어 정보 읽기' },
        { render: (ctx) => ctx.ffmpegStatusRow() },
      ],
    },
    {
      title: '자동 복구',
      desc: '직접 재생이 안 되면 순서대로 시도합니다.',
      rows: [
        { path: 'ffmpeg.remuxFallback', type: 'check', label: '1단계: 컨테이너 재 mux', hint: '빠르고 무손실. 코넥터를 MKV 로 바꿔 재생해 봅니다.' },
        { path: 'ffmpeg.transcodeFallback', type: 'check', label: '2단계: 실시간 변환', hint: '느리지만 거의 모든 포맷을 살립니다.' },
        { path: 'ffmpeg.transcodeQuality', type: 'select', label: '변환 품질', options: [['fast', '빠름 (초고속)'], ['balanced', '균형'], ['quality', '높음 (매우 느림)']] },
      ],
    },
    {
      title: '보조 기능',
      rows: [
        { path: 'ffmpeg.useForThumbnails', type: 'check', label: '탐색바 썸네일 생성' },
        { path: 'ffmpeg.useForFrameStep', type: 'check', label: '프레임 단위 이동', hint: '이 기능은 반드시 ffmpeg 가 필요합니다 (HTML 비디오 요소는 프레임 탐색을 지원하지 않습니다).' },
        { path: 'ffmpeg.maxCacheMB', type: 'range', label: '캐시 최대 크기', min: 128, max: 8192, step: 128, unit: 'MB' },
        { render: (ctx) => ctx.cacheRow() },
      ],
    },
  ],

  about: [
    { title: '정보', rows: [{ render: (ctx) => ctx.aboutBlock() }] },
  ],
};

// ─────────────────────────────────────────────────────────────
// 설정 화면
// ─────────────────────────────────────────────────────────────
export class SettingsPanel {
  /**
   * @param {object} opts
   *   api       : preload 브리지
   *   appVersion : 표시할 앱 버전
   *   appInfo   : { electron, chrome, platform, arch }
   *   paths     : { userData, logs, ... }
   *   onChange  : 설정 변경 콜백 (path, value)
   *   onReset   : 설정 초기화 후 콜백
   */
  constructor({ api, appVersion: version, appInfo, paths, onChange, onReset }) {
    this.api = api;
    // contextBridge 객체는 frozen 이므로 정보를 복사해 들인다
    this.api = Object.assign(Object.create(null), api, {
      appVersion: version ?? '-',
      appInfo: appInfo ?? {},
      paths: paths ?? {},
    });
    this.onChange = onChange;
    this.onReset = onReset;
    this.modal = null;
    this.activeTab = 'interface';
    this.panes = new Map();
    this.controlsByPath = new Map();
  }

  open(tab = this.activeTab) {
    this.activeTab = tab;
    this.controlsByPath.clear();

    const tabsNode = el('div', { class: 'set-tabs', role: 'tablist' });
    const panesNode = el('div', { class: 'set-panes' });

    for (const t of TABS) {
      const tabBtn = el('button', {
        class: 'set-tab', type: 'button', role: 'tab',
        'aria-selected': String(t.id === this.activeTab),
        dataset: { tab: t.id },
      }, [
        el('span', { class: 'tab-icon', text: t.icon }),
        el('span', { text: t.label }),
      ]);
      tabBtn.addEventListener('click', () => this.selectTab(t.id));
      tabsNode.append(tabBtn);
    }

    const ctx = this.#context();

    for (const t of TABS) {
      const pane = el('div', {
        class: `set-pane${t.id === this.activeTab ? ' active' : ''}`,
        role: 'tabpanel',
        dataset: { tab: t.id },
      });
      if (t.id === 'hotkeys') {
        pane.append(this.#renderHotkeys());
      } else {
        for (const g of SCHEMA[t.id] ?? []) pane.append(this.#renderGroup(g, ctx));
        if (!pane.childElementCount) pane.append(el('div', { class: 'muted', text: '설정 항목이 없습니다.' }));
      }
      panesNode.append(pane);
      this.panes.set(t.id, pane);
    }

    const body = el('div', { class: 'set-panes-wrap', style: { display: 'flex', flex: '1', minHeight: '0' } }, [tabsNode, panesNode]);

    this.modal = openModal({
      title: '설정',
      className: 'settings',
      body,
      footer: [
        el('button', { class: 'btn btn-sm', type: 'button', text: '가져오기', onClick: () => this.#import() }),
        el('button', { class: 'btn btn-sm', type: 'button', text: '내보내기', onClick: () => this.#export() }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '기본값 복원', onClick: () => this.#reset() }),
        el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '닫기', onClick: () => this.modal.close() }),
      ],
      onClose: () => { this.panes.clear(); this.modal = null; },
    });

    return this.modal;
  }

  selectTab(id) {
    this.activeTab = id;
    for (const [tabId, pane] of this.panes) {
      pane.classList.toggle('active', tabId === id);
    }
    for (const btn of this.modal?.node.querySelectorAll('.set-tab') ?? []) {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === id));
    }
  }

  #renderGroup(group, ctx) {
    const wrap = el('div', { class: 'set-group' });
    if (group.title) wrap.append(el('div', { class: 'set-group-title', text: group.title }));
    if (group.desc) wrap.append(el('p', { class: 'set-group-desc', text: group.desc }));
    for (const row of group.rows ?? []) {
      const node = this.#renderRow(row, ctx);
      if (node) wrap.append(node);
    }
    return wrap;
  }

  #renderRow(row, ctx) {
    if (row.render) return row.render(ctx);
    const getter = () => this.api.settings.get(row.path);
    const setter = (v) => this.#set(row.path, v, row);

    const labelNode = el('div', { class: 'set-label' }, [
      el('span', { text: row.label }),
      row.hint ? el('small', { text: row.hint }) : null,
    ]);

    const control = el('div', { class: 'set-control' });
    let input;
    let valueNode = null;

    switch (row.type) {
      case 'check': {
        input = el('input', { type: 'checkbox' });
        input.checked = !!getter();
        input.addEventListener('change', () => setter(input.checked));
        const line = el('div', { class: 'set-row check' }, [
          el('div', { class: 'set-label' }, [
            input,
            el('div', {}, [
              el('span', { text: row.label }),
              row.hint ? el('small', { text: row.hint }) : null,
            ]),
          ]),
        ]);
        this.controlsByPath.set(row.path, { set: (v) => { input.checked = !!v; } });
        return line;
      }

      case 'range': {
        input = el('input', { type: 'range', min: row.min, max: row.max, step: row.step ?? 1 });
        input.value = String(getter());
        valueNode = el('span', { class: 'set-value' });
        const paint = (v) => {
          valueNode.textContent = row.format ? row.format(v) : `${v}${row.unit ?? ''}`;
        };
        paint(Number(input.value));
        input.addEventListener('input', () => {
          const v = Number(input.value);
          paint(v);
          setter(v);
        });
        control.append(input, valueNode);
        this.controlsByPath.set(row.path, { set: (v) => { input.value = String(v); paint(Number(v)); } });
        break;
      }

      case 'select': {
        input = el('select', { class: 'field' });
        for (const [v, label] of row.options) {
          input.append(el('option', { value: String(v), text: label, selected: String(getter()) === String(v) }));
        }
        input.addEventListener('change', () => {
          const raw = input.value;
          const matched = row.options.find(([v]) => String(v) === raw);
          setter(matched ? matched[0] : raw);
        });
        control.append(input);
        this.controlsByPath.set(row.path, { set: (v) => { input.value = String(v); } });
        break;
      }

      case 'color': {
        input = el('input', { type: 'color' });
        input.value = normalizeHex(getter());
        const text = el('input', { class: 'field', type: 'text', style: { width: '82px' } });
        text.value = input.value;
        input.addEventListener('input', () => { text.value = input.value; setter(input.value); });
        text.addEventListener('change', () => {
          const v = normalizeHex(text.value);
          input.value = v;
          text.value = v;
          setter(v);
        });
        control.append(el('div', { class: 'color-row' }, [input, text]));
        this.controlsByPath.set(row.path, { set: (v) => { input.value = normalizeHex(v); text.value = input.value; } });
        break;
      }

      case 'text': {
        input = el('input', { class: 'field', type: 'text', placeholder: row.placeholder ?? '' });
        input.value = getter() ?? '';
        input.addEventListener('change', () => setter(input.value));
        control.append(input);
        this.controlsByPath.set(row.path, { set: (v) => { input.value = v ?? ''; } });
        break;
      }

      case 'list': {
        input = el('input', { class: 'field', type: 'text' });
        input.value = (getter() ?? []).join(', ');
        input.addEventListener('change', () => {
          setter(input.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        });
        control.append(input);
        this.controlsByPath.set(row.path, { set: (v) => { input.value = (v ?? []).join(', '); } });
        break;
      }

      case 'preset': {
        const wrap = el('div', { class: 'preset-grid' });
        const buttons = [];
        const names = EQ_PRESET_LABELS;
        for (const [key] of Object.entries(EQ_PRESETS)) {
          const b = el('button', {
            class: 'preset-btn', type: 'button', text: names[key] ?? key,
            'aria-pressed': String(getter() === key),
          });
          b.addEventListener('click', () => {
            const bands = EQ_PRESETS[key];
            this.api.settings.set('audio.equalizerBands', [...bands]);
            this.api.settings.set('audio.equalizerPreset', key);
            buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
            this.#refreshEq();
            this.onChange?.('audio.equalizerBands', [...bands]);
            toastOk(`프리셋: ${names[key] ?? key}`);
          });
          buttons.push(b);
          wrap.append(b);
        }
        this.controlsByPath.set(row.path, {
          set: (v) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(EQ_PRESETS)[i] === v))),
        });
        control.append(wrap);
        control.style.justifyContent = 'flex-start';
        // 그리드가 넓으므로 전체 폭 사용
        const line = el('div', { class: 'set-row stack' }, [labelNode, control]);
        return line;
      }

      default:
        return null;
    }

    const line = el('div', { class: 'set-row' }, [labelNode, control]);
    if (row.resetable) {
      const reset = el('button', {
        class: 'icon-btn', type: 'button', title: '초기화',
        html: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 11-1.6-3.7M13 2v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        onClick: () => {
          const defaults = { brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 100 };
          const key = row.path.split('.').pop();
          this.#set(row.path, defaults[key], row);
          this.controlsByPath.get(row.path)?.set(defaults[key]);
        },
      });
      control.append(reset);
    }
    return line;
  }

  /**
   * 단축키 편집 테이블.
   * 두 개의 슬롯(기본/Shift) 을 지원하며, 누르는 즉시 캡처한다.
   * 충돌 검사는 저장 시점에 수행하고 목록에 표시한다.
   */
  #renderHotkeys() {
    const wrap = el('div');
    const map = this.api.settings.get('hotkeys.map') ?? {};
    const conflictBox = el('div');

    wrap.append(el('div', { class: 'set-group' }, [
      el('div', { class: 'set-group-title', text: '전역 단축키' }),
      el('p', { class: 'set-group-desc', text: '앱 창이 뒤에 있거나 최소화되어 있어도 동작하는 단축키입니다. 다른 앱과 충돌할 수 있습니다.' }),
      el('div', { class: 'set-row check' }, [
        el('div', { class: 'set-label' }, [
          el('input', {
            type: 'checkbox',
            checked: !!this.api.settings.get('hotkeys.globalPlayPause'),
            onChange: (e) => { this.#set('hotkeys.globalPlayPause', e.target.checked); },
          }),
          el('div', {}, [el('span', { text: '재생/일시정지 (전역)' })]),
        ]),
      ]),
      el('div', { class: 'set-row check' }, [
        el('div', { class: 'set-label' }, [
          el('input', {
            type: 'checkbox',
            checked: !!this.api.settings.get('hotkeys.globalNextPrev'),
            onChange: (e) => { this.#set('hotkeys.globalNextPrev', e.target.checked); },
          }),
          el('div', {}, [el('span', { text: '이전/다음 파일 (전역)' })]),
        ]),
      ]),
      el('div', { class: 'set-row check' }, [
        el('div', { class: 'set-label' }, [
          el('input', {
            type: 'checkbox',
            checked: !!this.api.settings.get('hotkeys.globalVolume'),
            onChange: (e) => { this.#set('hotkeys.globalVolume', e.target.checked); },
          }),
          el('div', {}, [el('span', { text: '볼륨 (전역)' })]),
        ]),
      ]),
    ]));

    wrap.append(conflictBox);

    const table = el('table', { class: 'hk-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '동작' }),
        el('th', { style: { textAlign: 'right' }, text: '단축키' }),
      ])]),
    ]);
    const tbody = el('tbody');

    const collectConflicts = () => {
      const seen = new Map();
      for (const [action, keys] of Object.entries(map)) {
        for (const k of [].concat(keys ?? [])) {
          if (!k) continue;
          const norm = normalizeAccel(k);
          if (!seen.has(norm)) seen.set(norm, []);
          seen.get(norm).push(action);
        }
      }
      return [...seen.entries()].filter(([, actions]) => actions.length > 1);
    };

    const refreshConflicts = () => {
      const conflicts = collectConflicts();
      conflictBox.replaceChildren();
      if (!conflicts.length) return;
      const list = el('ul', { class: 'privacy-list' });
      for (const [accel, actions] of conflicts) {
        list.append(el('li', {}, [
          el('span', { class: 'ok', style: { color: 'var(--warn)' }, text: '!' }),
          el('div', {}, [
            el('strong', { text: `${prettyKey(accel)} ` }),
            `이 ${accel} 조합이 ${actions.length}개 동작에 중복 지정되어 있습니다: `,
            actions.map((a) => HOTKEY_LABELS[a] ?? a).join(', '),
          ]),
        ]));
      }
      conflictBox.append(el('div', { class: 'set-group-title', text: '충돌' }), list);
    };

    for (const [action, keys] of Object.entries(map)) {
      const tr = el('tr');
      tr.append(el('td', { text: HOTKEY_LABELS[action] ?? action }));

      const keyWrap = el('div', { class: 'hk-keys' });
      const slotButtons = [];

      const renderSlots = () => {
        keyWrap.replaceChildren();
        const list = [].concat(map[action] ?? []);
        list.forEach((accel, slotIndex) => {
          const chip = el('span', { class: 'hk-key' }, [
            el('span', { text: prettyKey(accel) || '없음' }),
            el('button', {
              type: 'button', 'aria-label': '삭제', title: '삭제',
              html: '<svg viewBox="0 0 10 10" width="9" height="9"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
              onClick: () => {
                const next = [].concat(map[action] ?? []).filter((_, i) => i !== slotIndex);
                map[action] = next;
                this.#set('hotkeys.map', { ...map });
                renderSlots();
                refreshConflicts();
              },
            }),
          ]);
          keyWrap.append(chip);
        });
        slotButtons.length = 0;
      };

      const captureBtn = el('button', {
        class: 'hk-capture', type: 'button', text: '키 입력…',
      });

      const onKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stop(); return; }
        const accel = accelFromEvent(e);
        if (!accel) return;
        const next = [].concat(map[action] ?? []);
        next[0] = accel;              // 기본 슬롯을 덮어씀
        while (next.length > 2) next.pop();
        map[action] = next;
        this.#set('hotkeys.map', { ...map });
        stop();
        renderSlots();
        refreshConflicts();
        toastOk(`${HOTKEY_LABELS[action] ?? action}: ${prettyKey(accel)}`);
      };

      const stop = () => {
        captureBtn.classList.remove('capturing');
        captureBtn.textContent = '키 입력…';
        window.removeEventListener('keydown', onKeyDown, true);
      };

      captureBtn.addEventListener('click', () => {
        captureBtn.classList.add('capturing');
        captureBtn.textContent = '키를 누르세요 (Esc 취소)';
        window.addEventListener('keydown', onKeyDown, true);
      });

      renderSlots();

      tr.append(el('td', {}, [el('div', { class: 'hk-action' }, [keyWrap, captureBtn])]));
      tbody.append(tr);
    }

    table.append(tbody);
    wrap.append(table);
    refreshConflicts();

    wrap.append(el('div', { class: 'note', text: 'Alt 조합은 브라우저/윈도우 메뉴와 충돌할 수 있습니다. Esc 를 누르면 입력 취소됩니다.' }));

    return wrap;
  }

  #refreshEq() {
    const bands = this.api.settings.get('audio.equalizerBands') ?? [];
    this.controlsByPath.get('__eq')?.set(bands);
  }

  #set(path, value, row) {
    this.api.settings.set(path, value);
    this.onChange?.(path, value, row);
  }

  // ─────────────────────────────────────────────────────────
  // 특수 행
  // ─────────────────────────────────────────────────────────
  #context() {
    return {
      api: this.api,
      panel: this,

      eq: () => {
        const bands = this.api.settings.get('audio.equalizerBands') ?? EQ_PRESETS.flat;
        const graph = el('div', { class: 'eq-graph' });
        const sliders = [];

        EQ_FREQS.forEach((freq, i) => {
          const s = el('input', { class: 'eq-slider', type: 'range', min: -12, max: 12, step: 0.5, value: String(bands[i] ?? 0) });
          const v = el('span', { class: 'eq-value', text: `${bands[i] > 0 ? '+' : ''}${bands[i] ?? 0}` });
          s.addEventListener('input', () => {
            const val = Number(s.value);
            v.textContent = `${val > 0 ? '+' : ''}${val}`;
            const next = [...(this.api.settings.get('audio.equalizerBands') ?? EQ_PRESETS.flat)];
            next[i] = val;
            this.api.settings.set('audio.equalizerBands', next);
            this.api.settings.set('audio.equalizerPreset', 'custom');
            this.onChange?.('audio.equalizerBands', next);
          });
          graph.append(el('div', { class: 'eq-band' }, [
            s,
            v,
            el('span', { class: 'eq-label', text: freq >= 1000 ? `${freq / 1000}k` : String(freq) }),
          ]));
          sliders.push(s);
        });

        this.controlsByPath.set('__eq', {
          set: (arr) => sliders.forEach((s, i) => {
            s.value = String(arr[i] ?? 0);
            const v = s.parentElement.querySelector('.eq-value');
            if (v) v.textContent = `${arr[i] > 0 ? '+' : ''}${arr[i] ?? 0}`;
          }),
        });

        return el('div', { class: 'eq-panel' }, [graph]);
      },

      ffmpegStatusRow: () => {
        const node = el('div', { class: 'set-row stack' });
        const body = el('div', {});
        node.append(body);
        setTimeout(async () => {
          const info = await this.api.diag.ffmpeg();
          body.replaceChildren(el('div', { class: 'diag-grid' }, [
            diagCard('ffmpeg', info.ffmpeg ? '사용 가능' : '없음', info.ffmpeg ? 'tag-ok' : 'tag-err'),
            diagCard('ffprobe', info.ffprobe ? '사용 가능' : '없음', info.ffprobe ? 'tag-ok' : 'tag-warn'),
          ]));
          if (info.ffmpeg) {
            body.append(el('div', { class: 'note' }, [
              el('span', { class: 'mono', text: info.ffmpeg }),
              el('div', { class: 'muted', style: { marginTop: '4px' }, text: '재생 실패 시 자동 변환에 사용됩니다.' }),
            ]));
          } else {
            body.append(el('div', { class: 'note note-warn', text: 'ffmpeg 를 찾지 못했습니다. 이 경우 Chromium 내장 코덱으로만 재생됩니다. 설정에 직접 설치한 ffmpeg.exe 경로를 지정할 수 있습니다.' }));
          }
        }, 0);
        return node;
      },

      cacheRow: () => {
        const node = el('div', { class: 'set-row stack' });
        const body = el('div', { class: 'muted', text: '캐시 크기 확인 중…' });
        node.append(body);
        setTimeout(async () => {
          const { totalMB, count } = await this.api.diag.cacheSize();
          body.replaceChildren(el('div', { class: 'set-row' }, [
            el('div', { class: 'set-label' }, [
              el('span', { text: '현재 캐시' }),
              el('small', { text: `${count}개 파일` }),
            ]),
            el('div', { class: 'set-control' }, [
              el('span', { class: 'set-value', text: `${totalMB} MB` }),
              el('button', {
                class: 'btn btn-sm', type: 'button', text: '지금 비우기',
                onClick: async () => {
                  await this.api.media.pruneCache();
                  const r = await this.api.diag.cacheSize();
                  body.querySelector('.set-value').textContent = `${r.totalMB} MB`;
                  toastOk('캐시를 정리했습니다');
                },
              }),
            ]),
          ]));
        }, 0);
        return node;
      },

      aboutBlock: () => {
        const wrap = el('div');
        const info = this.api.appInfo ?? {};
        wrap.append(el('div', { class: 'diag-grid' }, [
          diagCard('버전', this.api.appVersion ?? '-'),
          diagCard('Electron', info.electron ?? '-'),
          diagCard('Chromium', info.chrome ?? '-'),
          diagCard('플랫폼', `${info.platform ?? '-'} / ${info.arch ?? '-'}`),
        ]));

        wrap.append(el('div', { class: 'set-group-title', text: '개인정보' }));
        wrap.append(el('ul', { class: 'privacy-list' }, [
          el('li', {}, [el('span', { class: 'ok', text: '✓' }), el('div', {}, [
            el('strong', { text: '광고 없음. ' }),
            '인앱 광고 네트워크를 사용하지 않으며 서드파티 스크립트를 로드하지 않습니다.',
          ])]),
          el('li', {}, [el('span', { class: 'ok', text: '✓' }), el('div', {}, [
            el('strong', { text: '외부 통신 차단. ' }),
            '앱은 재생 중 어떤 서버에도 접속하지 않습니다. 네트워크 계층에서 http/https/ws 요청을 모두 차단합니다.',
          ])]),
          el('li', {}, [el('span', { class: 'ok', text: '✓' }), el('div', {}, [
            el('strong', { text: '사용 통계 수집 없음. ' }),
            '재생 이력은 사용자의 컴퓨터 안에만 저장되며 전송되지 않습니다.',
          ])]),
          el('li', {}, [el('span', { class: 'ok', text: '✓' }), el('div', {}, [
            el('strong', { text: '광범위한 권한 없음. ' }),
            '파일 열기·이미지 저장·외부 실행 정도만 사용합니다. 관리자 권한을 요구하지 않습니다.',
          ])]),
          el('li', {}, [el('span', { class: 'ok', text: '✓' }), el('div', {}, [
            el('strong', { text: '오픈소스. ' }),
            'Chromium 과 ffmpeg 기반이며 모든 설정은 로컬 JSON 파일에 저장됩니다.',
          ])]),
        ]));

        wrap.append(el('div', { class: 'set-group-title', style: { marginTop: '20px' }, text: '문제 진단' }));
        const logBox = el('div', { class: 'log-view', text: '로그를 불러오는 중…' });
        wrap.append(logBox);
        setTimeout(async () => {
          const log = await this.api.diag.logTail(120);
          logBox.textContent = log?.trim() || '로그가 없습니다.';
        }, 0);
        wrap.append(el('div', { style: { marginTop: '10px', display: 'flex', gap: '8px' } }, [
          el('button', {
            class: 'btn btn-sm', type: 'button', text: '로그 복사',
            onClick: async () => {
              await navigator.clipboard.writeText(logBox.textContent);
              toastOk('로그를 클립보드에 복사했습니다');
            },
          }),
          el('button', {
            class: 'btn btn-sm', type: 'button', text: '설정 폴더 열기',
            onClick: () => this.api.diag.openPath(this.api.paths?.userData ?? ''),
          disabled: !this.api.paths?.userData,
          }),
        ]));
        return wrap;
      },
    };
  }

  // ─────────────────────────────────────────────────────────
  // 가져오기 / 내보내기 / 초기화
  // ─────────────────────────────────────────────────────────
  async #export() {
    try {
      const file = await this.api.settings.export();
      if (file) toastOk('설정을 내보냈습니다', { action: { label: '열기', onClick: () => this.api.shell.showItemInFolder(file) } });
    } catch (err) {
      toastError(`내보내기 실패: ${err.message}`);
    }
  }

  async #import() {
    try {
      const data = await this.api.settings.import();
      if (!data) return;
      this.onReset?.();
      toastOk('설정을 불러왔습니다. 창을 다시 열어 적용됩니다.');
    } catch (err) {
      toastError(`가져오기 실패: ${err.message}`);
    }
  }

  async #reset() {
    const data = await this.api.settings.reset();
    this.onReset?.(data);
    toastInfo('설정을 기본값으로 되돌렸습니다');
  }
}

function diagCard(k, v, cls = '') {
  return el('div', { class: 'diag-card' }, [
    el('div', { class: 'k', text: k }),
    el('div', { class: `v ${cls}`, text: v }),
  ]);
}

function normalizeHex(v) {
  if (typeof v !== 'string') return '#ffffff';
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return '#ffffff';
}

export { SCHEMA, TABS, EQ_FREQS };
