/**
 * 상단 메뉴바 + 드롭다운 메뉴 정의
 */
import { el, prettyKey, ICONS } from '../util.js';

export class MenuBar {
  constructor({ actions, api }) {
    this.actions = actions;
    this.api = api;
    this.popup = document.getElementById('menu-popup');
    this.buttons = [...document.querySelectorAll('.menu-btn')];
    this.activeIndex = -1;
    this.openMenuId = null;
    this.items = null;
    this._bind();
  }

  /** 반복 모드 표시 라벨 (메뉴 checked 판정용) */
  get repeatLabel() {
    return this.actions.getRepeatMode?.() !== 'off';
  }

  /** 연속 스냅샷 상태 (메뉴 checked 판정용) */
  get continuous() {
    return !!this.actions.isContinuousSnapshot?.();
  }

  /** 메뉴 항목 정의 (동적 상태 반영을 위해 함수로 조회) */
  buildItems() {
    const A = this.actions;
    const s = (k) => this.api.settings.get(k);
    const on = (k) => !!s(k);
    const k = (action) => {
      const accels = this.api.settings.get(`hotkeys.map.${action}`) ?? [];
      return accels.length ? prettyKey(accels[0]) : '';
    };

    return {
      file: [
        { label: '파일 열기…', key: k('fileOpen'), icon: ICONS.folder, onClick: () => A.openFiles() },
        { label: '폴더 열기…', onClick: () => A.openFolder() },
        { label: '재생목록 가져오기…', onClick: () => A.importPlaylist() },
        { label: '재생목록 내보내기…', onClick: () => A.exportPlaylist() },
        { separator: true },
        { label: '최근 재생', header: true },
        ...this.recentItems(),
        { separator: true },
        { label: '설정 폴더 열기', onClick: () => A.openSettingsFolder() },
        { label: '로그 폴더 열기', onClick: () => A.openLogsFolder() },
        { separator: true },
        { label: '종료', key: 'Alt+F4', onClick: () => A.quit() },
      ],

      play: [
        { label: '재생 / 일시정지', key: k('playPause'), icon: ICONS.play, onClick: () => A.playPause() },
        { label: '정지', key: k('stop'), icon: ICONS.pause, onClick: () => A.stop() },
        { separator: true },
        { label: '이전 파일', key: k('prevFile'), onClick: () => A.prev() },
        { label: '다음 파일', key: k('nextFile'), onClick: () => A.next() },
        { separator: true },
        { label: '빠르게', key: k('faster'), onClick: () => A.faster() },
        { label: '천천히', key: k('slower'), onClick: () => A.slower() },
        { label: '정상 속도', key: k('normalSpeed'), onClick: () => A.normalSpeed() },
        { separator: true },
        { label: '반복 모드 순환', checked: () => this.repeatLabel, onClick: () => A.cycleRepeat() },
        { label: '셔플', checked: () => on('playback.shufflePlaylist'), onClick: () => A.toggleShuffle() },
        { separator: true },
        { label: 'A 지점 설정', onClick: () => A.setAb('a') },
        { label: 'B 지점 설정', onClick: () => A.setAb('b') },
        { label: 'A-B 반복 해제', onClick: () => A.clearAb() },
        { separator: true },
        { label: '취침 타이머…', onClick: () => A.sleepTimer() },
      ],

      video: [
        { label: '전체화면', key: k('fullscreen'), onClick: () => A.fullscreen() },
        { label: '창 전체화면', key: k('windowedFullscreen'), onClick: () => A.windowedFullscreen() },
        { separator: true },
        { label: '확대/축소', header: true },
        { label: '화면에 맞게', checked: () => s('video.zoomMode') === 'fit', onClick: () => A.zoom('fit') },
        { label: '화면 채우기', checked: () => s('video.zoomMode') === 'fill', onClick: () => A.zoom('fill') },
        { label: '100%', checked: () => s('video.zoomMode') === '1:1', onClick: () => A.zoom('1:1') },
        { label: '200%', checked: () => s('video.zoomMode') === '2:1', onClick: () => A.zoom('2:1') },
        { separator: true },
        { label: '화면비', header: true },
        ...[['auto', '원본'], ['4:3', '4:3'], ['16:9', '16:9'], ['16:10', '16:10'], ['21:9', '21:9']]
          .map(([v, label]) => ({
            label, checked: () => s('video.aspectMode') === v, onClick: () => A.aspect(v),
          })),
        { separator: true },
        { label: '회전', header: true },
        { label: '90° 회전', key: k('rotateClockwise'), onClick: () => A.rotate(90) },
        { label: '반대 방향 90°', key: k('rotateCounter'), onClick: () => A.rotate(-90) },
        { label: '좌우 반전', checked: () => on('video.flipH'), onClick: () => A.flipH() },
        { label: '상하 반전', checked: () => on('video.flipV'), onClick: () => A.flipV() },
        { separator: true },
        { label: '영상 효과 초기화', onClick: () => A.resetFilters() },
        { label: '인터레이스 제거', checked: () => s('video.deinterlace') === 'on', onClick: () => A.cycleDeinterlace() },
      ],

      audio: [
        { label: '음소거', key: k('volumeMute'), checked: () => on('audio.muted'), onClick: () => A.toggleMute() },
        { label: '볼륨 올리기', key: k('volumeUp'), onClick: () => A.volumeUp() },
        { label: '볼륨 내리기', key: k('volumeDown'), onClick: () => A.volumeDown() },
        { separator: true },
        { label: '이퀄라이저', checked: () => on('audio.equalizerEnabled'), onClick: () => A.toggleEq() },
        { label: '베이스 부스트', checked: () => (s('audio.bassBoost') ?? 0) > 0, onClick: () => A.cycleBass() },
        { label: '3D 서라운드', checked: () => on('audio.surround'), onClick: () => A.toggleSurround() },
        { label: '음량 정규화', checked: () => on('audio.normalizer'), onClick: () => A.toggleNormalizer() },
        { separator: true },
        { label: '채널', header: true },
        ...[['auto', '자동'], ['stereo', '스테레오'], ['left', '왼쪽만'], ['right', '오른쪽만'], ['mono', '모노']]
          .map(([v, label]) => ({
            label, checked: () => s('audio.channelMode') === v, onClick: () => A.channelMode(v),
          })),
        { separator: true },
        { label: '밸런스 중앙', onClick: () => A.balance(0) },
        { label: '음향 설정 열기', onClick: () => A.openSettings('audio') },
      ],

      subtitle: [
        { label: '자막 켜기/끄기', key: k('subtitleToggle'), checked: () => on('subtitle.enabled'), onClick: () => A.toggleSubtitle() },
        { separator: true },
        { label: '자막 파일 열기…', onClick: () => A.openSubtitle() },
        { label: '자동 감지 다시 시도', onClick: () => A.redetectSubtitle() },
        { separator: true },
        { label: '다음 자막 언어', key: k('subtitleNextLang'), onClick: () => A.cycleSubtitle(1) },
        { label: '이전 자막 언어', key: k('subtitlePrevLang'), onClick: () => A.cycleSubtitle(-1) },
        { label: '자막 끄기', onClick: () => A.closeSubtitle() },
        { separator: true },
        { label: '지연 줄이기', key: k('subtitleDelayMinus'), onClick: () => A.subtitleDelay(-200) },
        { label: '지연 늘리기', key: k('subtitleDelayPlus'), onClick: () => A.subtitleDelay(200) },
        { label: '지연 초기화', onClick: () => A.subtitleDelay(0) },
        { separator: true },
        { label: '자막 설정 열기', onClick: () => A.openSettings('subtitle') },
      ],

      tools: [
        { label: '현재 장면 저장', key: k('snapshot'), icon: ICONS.camera, onClick: () => A.snapshot() },
        { label: '연속 저장 시작/중지', key: k('snapshotContinuous'), checked: () => this.continuous, onClick: () => A.toggleContinuousSnapshot() },
        { label: '스냅샷 폴더 열기', icon: ICONS.folder, onClick: () => A.openSnapshotFolder() },
        { separator: true },
        { label: '설정…', key: k('settings'), icon: ICONS.gear, onClick: () => A.openSettings() },
        { separator: true },
        { label: '1프레임 뒤로', key: k('stepBackward'), onClick: () => A.frameStep(-1) },
        { label: '1프레임 앞으로', key: k('stepForward'), onClick: () => A.frameStep(1) },
        { label: '정지 화면 해제', onClick: () => A.exitFrameStep() },
        { separator: true },
        { label: '캐시 정리', onClick: () => A.pruneCache() },
      ],

      view: [
        { label: '재생목록', key: k('playlistToggle'), checked: () => on('playlist.showPanel'), onClick: () => A.togglePlaylist() },
        { label: '메뉴바 표시', checked: () => on('ui.showMenubar'), onClick: () => A.toggleMenubar() },
        { separator: true },
        { label: '항상 위', key: k('alwaysOnTop'), checked: () => on('alwaysOnTop'), onClick: () => A.toggleAlwaysOnTop() },
        { label: '최소화', key: 'Alt+↓', onClick: () => A.minimize() },
        { separator: true },
        { label: '재생 정보', key: k('infoPanel'), icon: ICONS.info, onClick: () => A.playbackInfo() },
        { label: '파일 정보', key: k('fileInfo'), icon: ICONS.info, onClick: () => A.fileInfo() },
        { separator: true },
        { label: '단축키 도움말', onClick: () => A.showHotkeyHelp() },
      ],

      help: [
        { label: '단축키 목록', onClick: () => A.showHotkeyHelp() },
        { label: '재생 정보', onClick: () => A.playbackInfo() },
        { separator: true },
        { label: 'Nova Player 정보', onClick: () => A.openSettings('about') },
      ],
    };
  }

  recentItems() {
    const recent = this.actions.getRecent?.() ?? [];
    if (!recent.length) return [{ label: '(없음)', disabled: true }];
    return recent.slice(0, 12).map((r) => ({
      label: r.name,
      onClick: () => this.actions.openPath(r.path),
    }));
  }

  _bind() {
    for (const btn of this.buttons) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.menu;
        if (this.openMenuId === id) this.close();
        else this.open(id, btn);
      });
      btn.addEventListener('pointerenter', () => {
        if (this.openMenuId && this.openMenuId !== btn.dataset.menu) this.open(btn.dataset.menu, btn);
      });
    }

    document.addEventListener('click', (e) => {
      if (!this.popup.contains(e.target) && !e.target.closest('.menu-btn')) this.close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.openMenuId) {
        e.stopPropagation();
        this.close();
      }
    }, true);
  }

  open(id, btn) {
    this.items = this.buildItems()[id];
    if (!this.items) return;
    this.openMenuId = id;

    for (const b of this.buttons) b.setAttribute('aria-expanded', String(b === btn));
    btn?.setAttribute('aria-expanded', 'true');

    this.popup.replaceChildren();
    this.menuItems = [];
    for (const item of this.items) {
      if (item.separator) {
        this.popup.append(el('div', { class: 'ctx-sep' }));
        continue;
      }
      if (item.header) {
        this.popup.append(el('div', { class: 'ctx-head', text: item.label }));
        continue;
      }
      const checked = typeof item.checked === 'function' ? item.checked() : item.checked;
      const btnEl = el('button', {
        class: `ctx-item${checked ? ' checked' : ''}`,
        type: 'button',
        'aria-disabled': item.disabled ? 'true' : null,
      }, [
        el('span', { class: 'ctx-icon', html: checked ? ICONS.check : (item.icon ?? '') }),
        el('span', { class: 'ctx-label', text: item.label }),
        item.key ? el('span', { class: 'ctx-key', text: item.key }) : null,
      ]);
      if (!item.disabled) {
        btnEl.addEventListener('click', () => { this.close(); item.onClick?.(); });
      }
      this.menuItems.push(btnEl);
      this.popup.append(btnEl);
    }

    // 팝업은 position:fixed + 뷰포트 좌표로 배치한다.
    // (헤더 안에 들어있어도 버튼 위치 기준으로 열린다)
    this.popup.hidden = false;
    const r = btn.getBoundingClientRect();
    this.popup.style.minWidth = `${Math.max(r.width, 220)}px`;
    // 실측을 위해 일단 원점에 두고 크기를 잰 뒤 화면 안으로 보정
    this.popup.style.left = '0px';
    this.popup.style.top = '0px';
    const pw = this.popup.offsetWidth;
    const ph = this.popup.offsetHeight;
    let left = r.left;
    let top = r.bottom + 4;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  close() {
    this.popup.hidden = true;
    this.openMenuId = null;
    for (const b of this.buttons) b.setAttribute('aria-expanded', 'false');
  }
}
