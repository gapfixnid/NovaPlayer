/**
 * 파일 정보 / 재생 정보 패널
 */
import { el, formatTime, formatSize, formatBitrate, baseName, dirName } from '../util.js';
import { openModal } from './modal.js';
import { toastOk } from './toast.js';

const CODEC_LABELS = {
  h264: 'H.264 / AVC', hevc: 'HEVC / H.265', h265: 'HEVC / H.265', av1: 'AV1',
  vp9: 'VP9', vp8: 'VP8', avc1: 'H.264 / AVC', mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', vc1: 'VC-1', wmv3: 'WMV',
  theora: 'Theora', mjpeg: 'MJPEG', prores: 'ProRes', dvvideo: 'DV',
  ffv1: 'FFV1', utvideo: 'UT Video', cfhd: 'CineForm', dnxhd: 'DNxHD',
  aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis',
  ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus', dts: 'DTS',
  truehd: 'Dolby TrueHD', pcm_s16le: 'PCM (S16)', pcm_s24le: 'PCM (S24)',
  mp2: 'MP2', wavpack: 'WavPack', alac: 'Apple Lossless', tta: 'TTA',
  subrip: 'SubRip', ass: 'ASS/SSA', webvtt: 'WebVTT', mov_text: 'MOV Text',
  srt: 'SubRip', microdvd: 'MicroDVD', pgs: 'PGS', dvd_subtitle: 'VobSub',
};

const codecLabel = (c) => (c ? CODEC_LABELS[c.toLowerCase()] ?? c.toUpperCase() : '-');

/** 파일 정보 모달 */
export function showFileInfo(info, { path: filePath, onReveal, onOpenFolder } = {}) {
  const body = el('div');

  if (!info) {
    body.append(el('div', { class: 'note note-warn', text: '미디어 정보를 읽지 못했습니다. ffprobe 가 필요합니다 (설정 > 코덱/도구).' }));
  }

  if (filePath) {
    body.append(el('div', { class: 'info-section', text: '파일' }));
    body.append(el('dl', { class: 'info-grid' }, [
      el('dt', { text: '이름' }), el('dd', { text: baseName(filePath) }),
      el('dt', { text: '위치' }), el('dd', { class: 'mono', text: dirName(filePath) }),
      el('dt', { text: '전체 경로' }), el('dd', { class: 'mono', style: { fontSize: '.86em' }, text: filePath }),
    ]));
  }

  if (info) {
    body.append(el('div', { class: 'info-section', text: '컨테이너' }));
    body.append(el('dl', { class: 'info-grid' }, [
      el('dt', { text: '형식' }), el('dd', { text: info.formatName || '-' }),
      el('dt', { text: '길이' }), el('dd', { text: formatTime(info.duration, { hours: true }) }),
      el('dt', { text: '크기' }), el('dd', { text: `${formatSize(info.size)} (${info.size.toLocaleString()} bytes)` }),
      el('dt', { text: '전체 비트레이트' }), el('dd', { text: formatBitrate(info.bitrate) }),
      el('dt', { text: '스트림 수' }), el('dd', { text: `${info.streams.length}개 (영상 ${info.streams.filter((s) => s.type === 'video').length}, 음성 ${info.streams.filter((s) => s.type === 'audio').length}, 자막 ${info.subtitles.length})` }),
    ]));

    info.streams.filter((s) => s.type === 'video').forEach((s, i) => {
      const ratio = s.aspectRatio ?? (s.width && s.height ? (s.width / s.height).toFixed(3) : '-');
      body.append(el('div', { class: 'info-section', text: `비디오 스트림 #${i + 1}` }));
      body.append(el('dl', { class: 'info-grid' }, [
        el('dt', { text: '코덱' }), el('dd', {}, [
          codecLabel(s.codec),
          s.profile ? el('span', { class: 'tag', style: { marginLeft: '8px' }, text: String(s.profile).replace(/\(.*\)/, '').trim() }) : null,
        ]),
        el('dt', { text: '해상도' }), el('dd', { text: `${s.width} × ${s.height}${s.width >= 3800 ? ' (4K 이상)' : ''}` }),
        el('dt', { text: '화면비' }), el('dd', { text: `${ratio}${ratio !== '-' ? ` (${s.width}:${s.height})` : ''}` }),
        el('dt', { text: '프레임레이트' }), el('dd', { text: s.frameRate ? `${s.frameRate.toFixed(3)} fps` : '-' }),
        el('dt', { text: '비트레이트' }), el('dd', { text: formatBitrate(s.bitrate) }),
        el('dt', { text: '픽셀 포맷' }), el('dd', { text: s.pixFmt ?? '-' }),
        el('dt', { text: '색 공간' }), el('dd', { text: s.colorSpace ?? '-' }),
        s.videoRotation ? el('dt', { text: '회전 메타' }) : null,
        s.videoRotation ? el('dd', { text: `${s.videoRotation}°` }) : null,
        el('dt', { text: '언어' }), el('dd', { text: s.language ?? 'und (지정 안 함)' }),
      ]));
    });

    info.streams.filter((s) => s.type === 'audio').forEach((s, i) => {
      body.append(el('div', { class: 'info-section', text: `음성 스트림 #${i + 1}` }));
      body.append(el('dl', { class: 'info-grid' }, [
        el('dt', { text: '코덱' }), el('dd', { text: codecLabel(s.codec) }),
        el('dt', { text: '채널' }), el('dd', { text: `${s.channels ?? '?'}ch${s.channelLayout ? ` (${s.channelLayout})` : ''}` }),
        el('dt', { text: '샘플레이트' }), el('dd', { text: s.sampleRate ? `${(s.sampleRate / 1000).toFixed(1)} kHz` : '-' }),
        el('dt', { text: '비트레이트' }), el('dd', { text: formatBitrate(s.bitrate) }),
        el('dt', { text: '언어' }), el('dd', { text: s.language ?? 'und (지정 안 함)' }),
      ]));
    });

    if (info.subtitles.length) {
      body.append(el('div', { class: 'info-section', text: `내장 자막 (${info.subtitles.length})` }));
      body.append(el('dl', { class: 'info-grid' }, info.subtitles.flatMap((s, i) => [
        el('dt', { text: `#${i + 1}` }),
        el('dd', {}, [
          `${codecLabel(s.codec)} · ${s.language ?? 'und'}`,
          s.isForced ? el('span', { class: 'tag tag-accent', style: { marginLeft: '6px' }, text: 'forced' }) : null,
          s.isDefault ? el('span', { class: 'tag', style: { marginLeft: '6px' }, text: 'default' }) : null,
        ]),
      ])));
    }

    if (info.chapters?.length) {
      body.append(el('div', { class: 'info-section', text: `챕터 (${info.chapters.length})` }));
      const table = el('table', { class: 'hk-table' }, [el('tbody')]);
      const tbody = table.querySelector('tbody');
      for (const c of info.chapters.slice(0, 300)) {
        tbody.append(el('tr', {}, [
          el('td', { class: 'mono', style: { width: '100px' }, text: formatTime(c.start, { hours: true }) }),
          el('td', { text: c.title || '(제목 없음)' }),
        ]));
      }
      body.append(table);
    }

    if (Object.keys(info.tags ?? {}).length) {
      body.append(el('div', { class: 'info-section', text: '메타데이터 태그' }));
      const grid = el('dl', { class: 'info-grid' });
      for (const [k, v] of Object.entries(info.tags)) {
        grid.append(el('dt', { text: k }), el('dd', { text: String(v) }));
      }
      body.append(grid);
    }
  }

  const footer = [];
  if (filePath) {
    footer.push(el('button', { class: 'btn btn-sm', type: 'button', text: '위치 표시', onClick: () => onReveal?.(filePath) }));
    footer.push(el('button', { class: 'btn btn-sm', type: 'button', text: '폴더 열기', onClick: () => onOpenFolder?.(filePath) }));
    footer.push(el('div', { class: 'spacer' }));
  }
  footer.push(el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '닫기' }));

  const modal = openModal({ title: '파일 정보', body, footer, width: 640 });
  footer.forEach((f) => f.addEventListener?.('click', () => modal.close()));
  return modal;
}

/** 실시간 재생 정보 (I 키) */
export function showPlaybackInfo({ video, player, videoCtl, audioEngine, playlist }) {
  const body = el('div');
  const update = () => {
    const v = video;
    const q = player.getQuality?.();
    const rows = [
      ['재생 상태', v.paused ? '일시정지' : '재생 중'],
      ['현재 위치', `${formatTime(v.currentTime, { hours: true, ms: true })} / ${formatTime(v.duration, { hours: true })}`],
      ['버퍼링', formatTime(player._bufferedEnd?.() ?? 0, { hours: true })],
      ['재생 속도', `${v.playbackRate.toFixed(3)}x${v.preservesPitch ? ' (음높이 유지)' : ''}`],
      ['볼륨', `${Math.round(audioEngine?.baseGain ?? 0)}%${audioEngine?.muted ? ' (음소거)' : ''}`],
      ['해상도', v.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : '-'],
      ['버퍼 상태', v.readyState >= 4 ? '충분' : v.readyState === 3 ? '부족' : '데이터 대기'],
      ['네트워크 상태', v.networkState === 2 ? '로딩 중' : v.networkState === 1 ? '활성' : '대기'],
      ['복구 단계', ({ none: '없음 (네이티브)', native: '네이티브', remux: '재 mux', transcode: '변환' })[player.fallbackStage] ?? player.fallbackStage],
      ['재생 모드', videoCtl.frameStep.active ? `정지 (프레임 ${Math.round(videoCtl.frameStep.time * (videoCtl.detectFps() || 25))})` : '정상'],
    ];

    if (q) {
      rows.push(['프레임', `총 ${q.total.toLocaleString()} / 드롭 ${q.dropped.toLocaleString()} (${(q.ratio * 100).toFixed(3)}%)`]);
    }
    if (audioEngine?.ready) {
      rows.push(['오디오 경로', `DSP 그래프 @ ${(audioEngine.sampleRate / 1000).toFixed(1)} kHz`]);
      rows.push(['ReplayGain', `${audioEngine.replayGainDb >= 0 ? '+' : ''}${audioEngine.replayGainDb.toFixed(1)} dB`]);
    } else if (audioEngine?.failed) {
      rows.push(['오디오 경로', '네이티브 (DSP 비활성)']);
    }
    if (videoCtl?.describeState()) rows.push(['화면 상태', videoCtl.describeState()]);
    if (playlist) rows.push(['재생목록', `${playlist.items.length}개 항목, 현재 ${playlist.currentIndex + 1}번`]);

    const grid = el('dl', { class: 'info-grid' });
    for (const [k, val] of rows) {
      grid.append(el('dt', { text: k }), el('dd', { text: String(val) }));
    }
    body.replaceChildren(grid);
  };

  update();
  const timer = setInterval(update, 500);

  const modal = openModal({
    title: '재생 정보',
    body,
    footer: [el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '닫기' })],
    width: 480,
    onClose: () => clearInterval(timer),
  });
  modal.node.querySelector('.modal-close')?.addEventListener('click', () => modal.close());
  return modal;
}

export { codecLabel };
