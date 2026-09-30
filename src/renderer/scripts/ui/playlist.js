/**
 * 재생목록 — 데이터 + UI一体
 *
 * 지원: 다중 선택, 드래그 재정렬, 필터, 정렬, 셔플, 반복 모드,
 *       M3U/PLS 임포트·익스포트, 자동 저장, 총 재생시간.
 */
import { el, clamp, formatTime, baseName, extName, debounce } from '../util.js';
import { toastOk, toastInfo, toastError } from './toast.js';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.wma', '.ogg', '.oga', '.opus', '.ape', '.alac', '.mka', '.ac3', '.dts', '.amr', '.mid', '.midi', '.spx', '.tta', '.dsf', '.dff']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff', '.tif', '.avif']);

export class PlaylistManager {
  constructor({ api, player, onPlay }) {
    this.api = api;
    this.player = player ?? null;
    this.onPlay = onPlay;
    this.items = [];
    this.currentIndex = -1;
    this.selection = new Set();
    this._cursor = -1;            // 키보드 커서 (선택 앵커 겸용)
    this.filter = '';
    this.shuffleMode = false;
    this.shuffleOrder = [];      // 셔플 시 재생을 위한 인덱스 큐
    this.repeatMode = 'off';    // off | all | one
    this.history = [];           // 셔플 재생 이력 (되감기용)

    this.listNode = document.getElementById('pl-list');
    this.countNode = document.getElementById('pl-count');
    this.totalNode = document.getElementById('pl-total');
    this.filterInput = document.getElementById('pl-filter');

    this._bindTools();
    this._bindListEvents();

    this.persist = debounce(() => this._persist(), 900);
  }

  // ─────────────────────────────────────────────────────────
  // 데이터 조작
  // ─────────────────────────────────────────────────────────

  /** 경로 배열을 목록 끝에 추가 (중복 제거 옵션) */
  add(paths, { dedupe = true } = {}) {
    const existing = new Set(this.items.map((i) => i.path.toLowerCase()));
    const added = [];
    const base = Date.now();
    let n = 0;
    for (const p of [].concat(paths)) {
      const key = String(p).toLowerCase();
      if (dedupe && existing.has(key)) continue;
      existing.add(key);
      // addedAt 단조 증가 (date 정렬이 ms 동점이 되지 않게)
      this.items.push({ path: p, name: baseName(p), duration: 0, size: 0, addedAt: base + (n++) });
      added.push(this.items.length - 1);
    }
    this.afterChange();
    return added;
  }

  /** 목록을 비우고 지정 항목으로 교체 (파일 열기 시) */
  replace(paths) {
    const base = Date.now();
    this.items = [].concat(paths).map((p, i) => ({
      path: p, name: baseName(p), duration: 0, size: 0, addedAt: base + i,
    }));
    this.selection.clear();
    this.currentIndex = -1;
    this.shuffleOrder = [];
    this.afterChange();
  }

  removeIndices(indices) {
    const set = new Set(indices);
    const currentPath = this.items[this.currentIndex]?.path;
    this.items = this.items.filter((_, i) => !set.has(i));
    this.currentIndex = currentPath
      ? this.items.findIndex((i) => i.path === currentPath)
      : -1;
    this.selection.clear();
    this.shuffleOrder = [];
    this.afterChange();
  }

  clear() {
    this.items = [];
    this.currentIndex = -1;
    this.selection.clear();
    this.shuffleOrder = [];
    this.afterChange();
  }

  move(fromIndices, toIndex) {
    if (!fromIndices.length) return;
    const sorted = [...fromIndices].sort((a, b) => a - b);
    const moving = sorted.map((i) => this.items[i]);
    const targetItem = this.items[toIndex];
    const currentPath = this.items[this.currentIndex]?.path;

    const rest = this.items.filter((_, i) => !sorted.includes(i));
    let insertAt = targetItem ? rest.indexOf(targetItem) : rest.length;
    if (insertAt < 0) insertAt = rest.length;
    rest.splice(insertAt, 0, ...moving);

    this.items = rest;
    this.currentIndex = currentPath ? this.items.findIndex((i) => i.path === currentPath) : -1;
    this.afterChange();
  }

  moveSelection(delta) {
    if (!this.selection.size) return;
    const indices = [...this.selection].sort((a, b) => a - b);
    const targets = indices.map((i) => i + delta).filter((i, k, arr) => i >= 0 && i < this.items.length && arr.indexOf(i) === k);
    if (!targets.length) return;

    const willRemove = new Set(indices);
    const moving = indices.map((i) => this.items[i]);
    const rest = this.items.filter((_, i) => !willRemove.has(i));
    // 아래로 이동일 경우 삽입 기준점을 먼저 한 칸 보정
    const adjust = delta > 0 ? -1 : 0;
    let insertAt = rest.length;
    for (let k = 0; k < targets.length; k++) {
      insertAt = Math.min(insertAt, Math.max(0, targets[k] + adjust - k));
    }
    rest.splice(insertAt, 0, ...moving);
    this.items = rest;
    this.afterChange();
  }

  setDurationFor(path, duration, size) {
    const item = this.items.find((i) => i.path === path);
    if (!item) return;
    let changed = false;
    if (item.duration !== duration) { item.duration = duration; changed = true; }
    if (size !== undefined && item.size !== size) { item.size = size; changed = true; }
    if (!changed) return;
    // 전체 재렌더 대신 해당 행만 갱신 (대용량 목록 메타 폭풍 방지)
    const idx = this.items.indexOf(item);
    const row = this.listNode.querySelector(`.pl-item[data-index="${idx}"] .pl-dur`);
    if (row) row.textContent = item.duration ? formatTime(item.duration) : '--:--';
    else this.renderList();
    this.updateCounts();
    this.persist();
  }

  // ─────────────────────────────────────────────────────────
  // 재생 순서
  // ─────────────────────────────────────────────────────────

  /** @param {number} dir -1 = 이전, +1 = 다음 */
  nextIndex(dir = 1, { manual = true } = {}) {
    if (!this.items.length) return -1;

    if (this.repeatMode === 'one' && !manual) return this.currentIndex;

    if (this.shuffleOrder.length && this.shuffleMode) {
      const pos = this.shuffleOrder.indexOf(this.currentIndex);
      if (pos >= 0) {
        const nextPos = pos + dir;
        if (nextPos < 0) return this.shuffleOrder[0];
        if (nextPos >= this.shuffleOrder.length) {
          if (this.repeatMode === 'off') return -1;  // 끝
          return this.shuffleOrder[0];
        }
        return this.shuffleOrder[nextPos];
      }
    }

    const next = this.currentIndex + dir;
    if (next < 0) {
      if (this.repeatMode === 'off') return manual ? 0 : -1;
      return this.items.length - 1;
    }
    if (next >= this.items.length) {
      if (this.repeatMode === 'off') return -1;
      return 0;
    }
    return next;
  }

  playAt(index) {
    if (index < 0 || index >= this.items.length) return;
    this.currentIndex = index;
    this.selection.clear();
    this.selection.add(index);
    this._cursor = index;
    this.renderList();
    this.scrollToCurrent();
    this.onPlay?.(this.items[index], index);
    this.persist();
  }

  playItem(item) {
    let idx = this.items.findIndex((i) => i.path === item.path);
    if (idx < 0) {
      this.add([item.path]);
      idx = this.items.length - 1;
    }
    this.playAt(idx);
  }

  next() { const i = this.nextIndex(1); if (i >= 0) this.playAt(i); }
  prev() {
    // 재생 3초 초과면 현재 파일 처음으로, 아니면 이전 파일
    const t = this.player?.video?.currentTime ?? 0;
    if (t > 3) { this.player?.seekTo(0); return; }
    const i = this.nextIndex(-1);
    if (i >= 0) this.playAt(i);
  }

  // ─────────────────────────────────────────────────────────
  // 셔플 / 반복 / 정렬
  // ─────────────────────────────────────────────────────────

  toggleShuffle() {
    this.shuffleMode = !this.shuffleMode;
    document.getElementById('pl-shuffle').setAttribute('aria-pressed', String(this.shuffleMode));
    if (this.shuffleMode) this._buildShuffleOrder();
    else this.shuffleOrder = [];
    this.api.settings.set('playback.shufflePlaylist', this.shuffleMode);
    toastInfo(this.shuffleMode ? '셔플 켜짐' : '셔플 꺼짐');
    this.persist();
  }

  _buildShuffleOrder() {
    const order = this.items.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // 현재 재생 중 항목이 첫 번째가 되도록 이동
    if (this.currentIndex >= 0) {
      const p = order.indexOf(this.currentIndex);
      if (p > 0) { order.splice(p, 1); order.unshift(this.currentIndex); }
    }
    this.shuffleOrder = order;
  }

  cycleRepeat() {
    this.repeatMode = this.repeatMode === 'off' ? 'all' : this.repeatMode === 'all' ? 'one' : 'off';
    const btn = document.getElementById('pl-repeat');
    btn.setAttribute('aria-pressed', String(this.repeatMode !== 'off'));
    btn.textContent = { off: '반복', all: '반복 ∞', one: '반복 1' }[this.repeatMode];
    toastInfo({ off: '반복 꺼짐', all: '목록 전체 반복', one: '현재 파일만 반복' }[this.repeatMode]);
    this.persist();
  }

  sortBy(kind) {
    const dir = this.api.settings.get('playlist.sortAsc') === false ? -1 : 1;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'ko'),
      size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
      date: (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0),
      type: (a, b) => extName(a.path).localeCompare(extName(b.path)) || a.name.localeCompare(b.name, 'ko'),
    }[kind];
    if (!cmp) return;

    const currentPath = this.items[this.currentIndex]?.path;
    this.items.sort((a, b) => cmp(a, b) * dir);
    this.currentIndex = currentPath ? this.items.findIndex((i) => i.path === currentPath) : -1;
    this.shuffleOrder = [];
    this.api.settings.set('playlist.sort', kind);
    this.afterChange();
    this._paintSortButton();
    toastOk(`${({ name: '이름', size: '크기', date: '추가순', type: '형식' })[kind]}으로 정렬`);
  }

  cycleSort() {
    const order = ['none', 'name', 'date', 'type'];
    const current = this.api.settings.get('playlist.sort') ?? 'none';
    const next = order[(order.indexOf(current) + 1) % order.length];
    if (next === 'none') {
      this.api.settings.set('playlist.sort', 'none');
      this.afterChange();
      this._paintSortButton();
      toastInfo('정렬 해제');
    } else this.sortBy(next);
  }

  /** 정렬 버튼 라벨에 종류+방향 표시 (우클릭으로 오름/내림 전환) */
  _paintSortButton() {
    const btn = document.getElementById('pl-sort');
    if (!btn) return;
    const kind = this.api.settings.get('playlist.sort') ?? 'none';
    const asc = this.api.settings.get('playlist.sortAsc') !== false;
    const arrow = asc ? '↑' : '↓';
    btn.textContent = { none: '정렬', name: `이름${arrow}`, date: `추가순${arrow}`, type: `형식${arrow}` }[kind] ?? '정렬';
    btn.title = '왼쪽 클릭: 기준 변경 / 오른쪽 클릭: 오름·내림 전환';
  }

  toggleSortDirection() {
    const asc = this.api.settings.get('playlist.sortAsc') !== false;
    this.api.settings.set('playlist.sortAsc', !asc);
    const kind = this.api.settings.get('playlist.sort') ?? 'none';
    if (kind === 'none') { this._paintSortButton(); return; }
    this.sortBy(kind);
    this._paintSortButton();
    toastInfo(asc ? '내림차순 정렬' : '오름차순 정렬');
  }

  // ─────────────────────────────────────────────────────────
  // 필터
  // ─────────────────────────────────────────────────────────

  setFilter(text) {
    this.filter = (text ?? '').trim().toLowerCase();
    this.renderList();
  }

  visibleItems() {
    if (!this.filter) return this.items.map((_, i) => ({ item: this.items[i], index: i }));
    return this.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.name.toLowerCase().includes(this.filter) || item.path.toLowerCase().includes(this.filter));
  }

  // ─────────────────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────────────────

  afterChange() {
    this.renderList();
    this.updateCounts();
    this.persist();
  }

  updateCounts() {
    this.countNode.textContent = String(this.items.length);
    const total = this.items.reduce((s, i) => s + (i.duration || 0), 0);
    this.totalNode.textContent = total > 0
      ? `${this.items.length}개 · 총 ${formatTime(total)}`
      : `${this.items.length}개`;
  }

  renderList() {
    const frag = document.createDocumentFragment();
    const visible = this.visibleItems();

    if (!visible.length) {
      const empty = el('li', { class: 'pl-empty' });
      if (!this.items.length) {
        empty.append(
          el('div', { text: '재생목록이 비어 있습니다' }),
          el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '.92em' }, text: '파일을 끌어다 놓거나 Ctrl+O 를 누르세요' }),
        );
      } else {
        empty.textContent = '일치하는 항목이 없습니다';
      }
      frag.append(empty);
    } else {
      let displayIndex = 0;
      for (const { item, index } of visible) {
        displayIndex += 1;
        const ext = extName(item.path);
        const isCurrent = index === this.currentIndex;
        const badges = [];
        if (AUDIO_EXT.has(ext)) badges.push(['음', 'pl-badge']);
        else if (IMAGE_EXT.has(ext)) badges.push(['그', 'pl-badge']);

        const node = el('li', {
          class: `pl-item${isCurrent ? ' current' : ''}${this.selection.has(index) ? ' selected' : ''}`,
          dataset: { index: String(index) },
          role: 'option',
          'aria-selected': isCurrent ? 'true' : 'false',
          draggable: 'true',
          title: item.path,
        }, [
          el('span', { class: 'pl-idx', text: this.shuffleMode && this.shuffleOrder.length
            ? String(this.shuffleOrder.indexOf(index) + 1 || displayIndex)
            : String(displayIndex) }),
          el('div', { class: 'pl-main' }, [
            el('div', { class: 'pl-name', text: item.name }),
            el('div', { class: 'pl-meta' }, [
              el('span', { text: ext.replace('.', '').toUpperCase() || '파일' }),
              badges.length ? el('span', { class: 'pl-badges' }, badges.map(([t, c]) => el('span', { class: c, text: t }))) : null,
            ]),
          ]),
          el('span', { class: 'pl-dur', text: item.duration ? formatTime(item.duration) : '--:--' }),
        ]);
        frag.append(node);
      }
    }

    this.listNode.replaceChildren(frag);
  }

  scrollToCurrent() {
    const node = this.listNode.querySelector('.pl-item.current');
    node?.scrollIntoView({ block: 'nearest' });
  }

  scrollToIndex(index) {
    const node = this.listNode.querySelector(`.pl-item[data-index="${index}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }

  /** 키보드 커서 이동 + 단일 선택 (Shift면 확장) */
  moveCursor(next, extend = false) {
    if (!this.items.length) return;
    const n = clamp(next, 0, this.items.length - 1);
    if (extend && this._cursor >= 0) {
      const [a, b] = [Math.min(this._cursor, n), Math.max(this._cursor, n)];
      // 기존 선택 유지 + 범위 추가 (축소는 단순 이동으로)
      for (let i = a; i <= b; i++) this.selection.add(i);
      this._cursor = n;
    } else {
      this._cursor = n;
      this.selection.clear();
      this.selection.add(n);
    }
    this.renderList();
    this.scrollToIndex(n);
  }

  /** 선택 항목 제거 (버튼·Delete 공용) */
  removeSelected() {
    if (!this.selection.size) {
      toastInfo('제거할 항목을 선택하세요');
      return 0;
    }
    const n = this.selection.size;
    this.removeIndices([...this.selection]);
    this._cursor = -1;
    toastOk(`${n}개 항목을 제거했습니다`);
    return n;
  }

  _bindListEvents() {
    const list = this.listNode;

    list.addEventListener('click', (e) => {
      const li = e.target.closest('.pl-item');
      if (!li) return;
      const index = Number(li.dataset.index);
      if (e.ctrlKey || e.metaKey) {
        if (this.selection.has(index)) this.selection.delete(index);
        else this.selection.add(index);
      } else if (e.shiftKey && this.selection.size) {
        const last = [...this.selection].at(-1);
        const [a, b] = [Math.min(last, index), Math.max(last, index)];
        for (let i = a; i <= b; i++) this.selection.add(i);
      } else {
        this.selection.clear();
        this.selection.add(index);
      }
      this._cursor = index;
      this.renderList();
    });

    // 키보드 조작: 방향키 이동(Shift 확장) · Enter 재생 · Delete 제거 · Home/End
    list.addEventListener('keydown', (e) => {
      if (!this.items.length) return;
      const cur = this._cursor >= 0 ? this._cursor : this.currentIndex;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.moveCursor((cur < 0 ? -1 : cur) + 1, e.shiftKey);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.moveCursor((cur < 0 ? this.items.length : cur) - 1, e.shiftKey);
          break;
        case 'Home':
          e.preventDefault();
          this.moveCursor(0, e.shiftKey);
          break;
        case 'End':
          e.preventDefault();
          this.moveCursor(this.items.length - 1, e.shiftKey);
          break;
        case 'Enter':
          e.preventDefault();
          if (cur >= 0) this.playAt(cur);
          else if (this.currentIndex >= 0) this.playAt(this.currentIndex);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          this.removeSelected();
          break;
        default:
          return;
      }
    });

    list.addEventListener('dblclick', (e) => {
      const li = e.target.closest('.pl-item');
      if (!li) return;
      const index = Number(li.dataset.index);
      const mode = this.api.settings.get('playlist.doubleClickAction') ?? 'play';
      if (mode === 'external') {
        const item = this.items[index];
        if (item) this.api.shell.openPath(item.path);
        return;
      }
      if (mode === 'enqueue' && index !== this.currentIndex) {
        // 현재 항목 다음으로 끼워넣고 선택만 이동
        const [item] = this.items.splice(index, 1);
        const at = this.currentIndex >= 0 ? this.currentIndex + 1 : this.items.length;
        this.items.splice(Math.min(at, this.items.length), 0, item);
        this.afterChange();
        toastInfo(`다음에 재생: ${item.name}`);
        return;
      }
      this.playAt(index);
    });

    // ── 드래그 재정렬 ──
    let dragFrom = null;

    list.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.pl-item');
      if (!li) return;
      const index = Number(li.dataset.index);
      if (!this.selection.has(index)) {
        this.selection.clear();
        this.selection.add(index);
        this.renderList();
      }
      dragFrom = [...this.selection];
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragFrom.join(','));
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const li = e.target.closest('.pl-item');
      list.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      li?.classList.add('drag-over');
    });

    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) {
        list.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      }
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const li = e.target.closest('.pl-item');
      list.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
      if (!li || !dragFrom) return;
      this.move(dragFrom, Number(li.dataset.index));
      dragFrom = null;
    });

    list.addEventListener('dragend', () => {
      dragFrom = null;
      list.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
    });

    this.filterInput.addEventListener('input', debounce((e) => this.setFilter(e.target.value), 150));
  }

  _bindTools() {
    document.getElementById('pl-add').addEventListener('click', async () => {
      const files = await this.api.dialog.openFiles('multi');
      if (files.length) {
        this.add(files);
        toastOk(`${files.length}개를 재생목록에 추가했습니다`);
      }
    });

    document.getElementById('pl-remove').addEventListener('click', () => this.removeSelected());

    document.getElementById('pl-clear').addEventListener('click', () => {
      if (!this.items.length) return;
      this.clear();
      toastInfo('재생목록을 비웠습니다');
    });

    document.getElementById('pl-shuffle').addEventListener('click', () => this.toggleShuffle());
    document.getElementById('pl-repeat').addEventListener('click', () => this.cycleRepeat());
    document.getElementById('pl-sort').addEventListener('click', () => this.cycleSort());
    document.getElementById('pl-sort').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.toggleSortDirection();
    });

    document.getElementById('pl-import').addEventListener('click', async () => {
      try {
        const files = await this.api.playlist.import();
        if (!files.length) return toastInfo('가져올 항목을 찾지 못했습니다');
        this.add(files, { dedupe: false });
        toastOk(`${files.length}개를 추가했습니다`);
      } catch (err) {
        toastError(`가져오기 실패: ${err.message}`);
      }
    });

    document.getElementById('pl-export').addEventListener('click', async () => {
      if (!this.items.length) return toastInfo('저장할 항목이 없습니다');
      const file = await this.api.playlist.export(this.items);
      if (file) toastOk(`저장했습니다`, { action: { label: '폴더 열기', onClick: () => this.api.shell.showItemInFolder(file) } });
    });

    document.getElementById('pl-up').addEventListener('click', () => this.moveSelection(-1));
    document.getElementById('pl-down').addEventListener('click', () => this.moveSelection(1));

    document.getElementById('pl-collapse').addEventListener('click', () => {
      document.getElementById('playlist-panel').classList.toggle('collapsed');
    });
    document.getElementById('pl-close').addEventListener('click', () => this.setVisible(false));
  }

  setVisible(visible) {
    const panel = document.getElementById('playlist-panel');
    panel.hidden = !visible;
    this.api.settings.set('playlist.showPanel', visible);
    document.getElementById('btn-playlist')?.setAttribute('aria-pressed', String(visible));
  }

  toggleVisible() {
    this.setVisible(document.getElementById('playlist-panel').hidden);
  }

  // ─────────────────────────────────────────────────────────
  // 영속화
  // ─────────────────────────────────────────────────────────

  async _persist() {
    if (!this.api.settings.get('playlist.autoSave')) return;
    // 자동 저장은 최근 N개만 유지 (목록 자체는 그대로)
    const limit = this.api.settings.get('playlist.autoSaveLimit') ?? 200;
    const snapshot = Number.isFinite(limit) && limit > 0 ? this.items.slice(-Math.floor(limit)) : this.items;
    await this.api.playlist.librarySave(snapshot);
    await this.api.playlist.save(snapshot);
  }

  async load() {
    const saved = await this.api.playlist.library();
    if (saved?.length) {
      this.items = saved;
      this.afterChange();
    } else {
      this.renderList();
      this.updateCounts();
    }
    const sort = this.api.settings.get('playlist.sort') ?? 'none';
    if (sort !== 'none') {
      this.api.settings.set('playlist.sort', 'none');
      this.sortBy(sort);
    }
    this._paintSortButton();
    const repeat = this.api.settings.get('playback.loopPlaylist');
    if (repeat) this.cycleRepeat();
    if (this.api.settings.get('playback.shufflePlaylist')) {
      this.shuffleMode = true;
      document.getElementById('pl-shuffle')?.setAttribute('aria-pressed', 'true');
      this._buildShuffleOrder();
    }
  }
}
