/**
 * 오디오 DSP 체인
 *
 *   <video> ── MediaElementSource
 *      └─ 10밴 이퀄라이저 (peaking biquad × 10)
 *         └─ 베이스 부스트 (lowshelf + peaking)
 *            └─ 래빗 제거용 보컬 컷/부스트
 *               └─ 트레블 (highshelf)
 *                  └─ 정규화 (DynamicsCompressor)
 *                     └─ 3D 서라운드 (헤이스 효과 크로스피드)
 *                        └─ 밸런스 (StereoPanner)
 *                           └─ 채널 라우팅 (stereo / L / R / mono)
 *                              └─ ReplayGain + 볼륨 (GainNode)
 *                                 └─ destination
 *
 * 그래프 생성에 실패하면 네이티브 볼륨으로 자동 폴백한다.
 */
import { clamp } from './util.js';

const EQ_FREQUENCIES = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ_GAIN_RANGE = 12;      // ±12 dB

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.video = null;
    this.ready = false;
    this.failed = false;

    this.nodes = {};
    this.eqBands = [];
    this.surroundNodes = null;

    this.baseGain = 0;          // 유저 볼륨
    this.replayGainDb = 0;      // 정규화 보정값
    this.measuredRms = null;
    this.analysisStarted = 0;
  }

  /** 지연 초기화 (첫 사용자 제스처 이후) */
  attach(video) {
    this.video = video;
    // AudioContext 는 제스처가 있어야 동작하므로 첫 재생 시점에 ensure()
  }

  ensure() {
    if (this.ready || this.failed || !this.video) return this.ready;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio 미지원');

      const ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx = ctx;

      const source = ctx.createMediaElementSource(this.video);
      this.nodes.source = source;

      // ── 10밴 이퀄라이저 ──
      // 주의: map 콜백 안에서는 this.eqBands 가 아직 교체 전이므로
      // 체이닝을 콜백 안에서 하면 안 된다. 먼저 전부 만든 뒤 연결한다.
      this.eqBands = EQ_FREQUENCIES.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = freq;
        f.Q.value = i === 0 || i === EQ_FREQUENCIES.length - 1 ? 0.7 : 1.1;
        f.gain.value = 0;
        return f;
      });
      source.connect(this.eqBands[0]);
      for (let i = 1; i < this.eqBands.length; i++) {
        this.eqBands[i - 1].connect(this.eqBands[i]);
      }
      this.nodes.eqIn = source;
      this.nodes.eqOut = this.eqBands.at(-1);

      // ── 베이스 / 보컬 / 트레블 ──
      const bassShelf = ctx.createBiquadFilter();
      bassShelf.type = 'lowshelf';
      bassShelf.frequency.value = 100;
      bassShelf.gain.value = 0;

      const superBass = ctx.createBiquadFilter();
      superBass.type = 'peaking';
      superBass.frequency.value = 62;
      superBass.Q.value = 0.9;
      superBass.gain.value = 0;

      const vocal = ctx.createBiquadFilter();
      vocal.type = 'peaking';
      vocal.frequency.value = 2200;
      vocal.Q.value = 1.1;
      vocal.gain.value = 0;

      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 8000;
      treble.gain.value = 0;

      this.nodes.bassShelf = bassShelf;
      this.nodes.superBass = superBass;
      this.nodes.vocal = vocal;
      this.nodes.treble = treble;

      this.nodes.eqOut
        .connect(superBass)
        .connect(bassShelf)
        .connect(vocal)
        .connect(treble);

      // ── 정규화 ──
      const normalizer = ctx.createDynamicsCompressor();
      normalizer.threshold.value = -60;
      normalizer.knee.value = 0;
      normalizer.ratio.value = 1;      // 기본 통과 (설정 시 변경)
      normalizer.attack.value = 0.004;
      normalizer.release.value = 0.25;
      this.nodes.normalizer = normalizer;
      treble.connect(normalizer);

      // ── 3D 서라운드 (헤이스 효과: 우측 지연을 좌측에 섞어 음장 확장) ──
      const split = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const dryL = ctx.createGain();
      const dryR = ctx.createGain();
      const delayL = ctx.createDelay(0.05);
      const delayR = ctx.createDelay(0.05);
      delayL.delayTime.value = 0.013;   // 좌 → 우 지연
      delayR.delayTime.value = 0.019;   // 우 → 좌 지연
      const crossL = ctx.createGain();  // 우측 지연 신호를 좌측 출력에 혼합
      const crossR = ctx.createGain();
      crossL.gain.value = 0;
      crossR.gain.value = 0;

      normalizer.connect(split);
      split.connect(dryL, 0);
      split.connect(dryR, 1);
      split.connect(delayL, 0);
      split.connect(delayR, 1);
      delayL.connect(crossR);   // L 지연 → 우 출력
      delayR.connect(crossL);   // R 지연 → 좌 출력

      dryL.connect(merger, 0, 0);
      crossL.connect(merger, 0, 0);
      dryR.connect(merger, 0, 1);
      crossR.connect(merger, 0, 1);

      this.surroundNodes = { split, dryL, dryR, delayL, delayR, crossL, crossR, merger };
      this.nodes.surroundOut = merger;

      // ── 밸런스 ──
      const panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      merger.connect(panner);
      this.nodes.panner = panner;

      // ── 채널 라우팅 ──
      // splitter → (aL/aR/bL/bR) → merger.in0 / merger.in1
      // 채널 모드는 네 게인값만 바꾸면 되도록 구성
      const routeSplit = ctx.createChannelSplitter(2);
      const mixIn = ctx.createGain();
      panner.connect(routeSplit);

      const aL = ctx.createGain();   // 좌 신호 → 병합 입력 0
      const aR = ctx.createGain();   // 우 신호 → 병합 입력 0
      const bL = ctx.createGain();   // 좌 신호 → 병합 입력 1
      const bR = ctx.createGain();   // 우 신호 → 병합 입력 1
      routeSplit.connect(aL, 0);
      routeSplit.connect(bL, 0);
      routeSplit.connect(aR, 1);
      routeSplit.connect(bR, 1);
      // mixIn 은 라우팅 게인과 무관하게 항상 L+R 합을 만든다.
      // (aL/aR 뒤가 아니라 routeSplit 에서 직접 가져와야
      //  게인 조작과 상관없이 합성 신호가 유지된다)
      mixIn.gain.value = 0;
      routeSplit.connect(mixIn, 0);
      routeSplit.connect(mixIn, 1);

      const outMerger = ctx.createChannelMerger(2);
      mixIn.connect(outMerger, 0, 0);
      mixIn.connect(outMerger, 0, 1);
      aL.connect(outMerger, 0, 0);
      bL.connect(outMerger, 0, 1);
      aR.connect(outMerger, 0, 0);
      bR.connect(outMerger, 0, 1);
      this.nodes.outMerger = outMerger;
      this.routeGains = { aL, aR, bL, bR, mixIn };

      // ── ReplayGain + 볼륨 ──
      const gain = ctx.createGain();
      gain.gain.value = 0;
      // ── 음성 지연 (입모양 싱크 보정, 최대 2초) ──
      const delayNode = ctx.createDelay(2.0);
      delayNode.delayTime.value = 0;
      outMerger.connect(delayNode);
      delayNode.connect(gain);
      this.nodes.delayNode = delayNode;
      gain.connect(ctx.destination);
      this.nodes.gain = gain;

      // 분석용 (ReplayGain 추정)
      // 반드시 볼륨 게인 이전(outMerger)에서 탭한다.
      // 게인 이후를 재면 볼륨 위치에 따라 측정이 왜곡돼 과보정된다.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      outMerger.connect(analyser);
      this.nodes.analyser = analyser;
      this.analyserBuf = new Float32Array(analyser.fftSize);

      this.ready = true;

      // 이 시점부터 video.volume 은 무시되므로 1 로 유지
      this.video.volume = 1;
      this.video.muted = false;
      return true;
    } catch (err) {
      console.warn('[audio] DSP 초기화 실패, 네이티브 오디오로 폴백:', err.message);
      this.failed = true;
      this.ready = false;
      return false;
    }
  }

  async resume() {
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* noop */ }
    }
    return this.ctx?.state === 'running';
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 0; }

  // ─────────────────────────────────────────────────────────
  // 설정 적용
  // ─────────────────────────────────────────────────────────

  apply(settings) {
    if (!this.ensure()) return;
    const now = this.ctx.currentTime;
    const ramp = (param, value) => {
      try { param.setTargetAtTime(value, now, 0.02); } catch { param.value = value; }
    };

    // 볼륨 / 음소거
    const vol = this.muted ? 0 : (this.baseGain / 100) ** 1.35;
    ramp(this.nodes.gain.gain, clamp(vol, 0, 1) * 10 ** (this.replayGainDb / 20));

    // 이퀄라이저
    const eqOn = !!settings.equalizerEnabled;
    const bands = settings.equalizerBands ?? [];
    this.eqBands.forEach((f, i) => {
      const db = eqOn ? clamp(bands[i] ?? 0, -EQ_GAIN_RANGE, EQ_GAIN_RANGE) : 0;
      ramp(f.gain, db);
    });

    // 베이스 (UI 표기 dB 그대로 적용)
    ramp(this.nodes.bassShelf.gain, clamp(settings.bassBoost ?? 0, 0, 20));
    this.nodes.bassShelf.frequency.value = clamp(settings.bassFreq ?? 100, 40, 400);
    ramp(this.nodes.superBass.gain, clamp(settings.superBass ?? 0, -15, 15));
    ramp(this.nodes.vocal.gain, clamp(settings.vocalBoost ?? 0, -15, 15));
    ramp(this.nodes.treble.gain, clamp(settings.treble ?? 0, -15, 15));

    // 정규화
    // OFF 여도 안전 리미터로 동작시켜 EQ 스택 폭주를 막는다.
    // 임계 -1dB라 평상시 피크에는 투명하고, 클리핑 직전만 잡는다.
    const norm = !!settings.normalizer;
    ramp(this.nodes.normalizer.ratio, norm ? 14 : 20);
    ramp(this.nodes.normalizer.threshold, norm ? (settings.normalizerTarget ?? -18) : -1);

    // 3D 서라운드
    // cross 부스트분만큼 dry를 낮춰 합산 피크를 보상한다 (클리핑 방지)
    const depth = settings.surround ? clamp((settings.surroundDepth ?? 50) / 100, 0, 1) * 0.75 : 0;
    const dry = 1 - depth * 0.5;
    this.surroundNodes.crossL.gain.value = depth;
    this.surroundNodes.crossR.gain.value = depth;
    this.surroundNodes.dryL.gain.value = dry;
    this.surroundNodes.dryR.gain.value = dry;

    // 밸런스
    ramp(this.nodes.panner.pan, clamp((settings.balance ?? 0) / 100, -1, 1));

    // 음성 지연 (음수·비수치는 0으로, 상한 2초)
    if (this.nodes.delayNode) {
      const ms = Number(settings.audioDelay ?? 0);
      ramp(this.nodes.delayNode.delayTime, Number.isFinite(ms) ? clamp(ms, 0, 2000) / 1000 : 0);
    }

    // 채널 모드
    this.applyChannelMode(settings.channelMode ?? 'auto');
  }

  /**
   * 채널 라우팅.
   *  auto/stereo : 원본 그대로 (L→좌, R→우)
   *  left/right  : 해당 채널만 양쪽 출력에 내보냄
   *  mono        : 0.5·(L+R) 합성 후 양쪽에 내보냄
   *
   * aL/aR = merger 입력 0(좌 출력)으로 들어가는 좌/우 신호 크기
   * bL/bR = merger 입력 1(우 출력)으로 들어가는 좌/우 신호 크기
   * mixIn = L+R 합성 신호 (mono 모드에서만 0.5 로 켠다)
   *
   * 주의: mixIn 은 두 출력에 공통 feeding 되므로 auto/stereo 에서는
   * 반드시 0 이어야 한다. 켜 두면 채널이 서로 새어 들어가고
   * 중앙이 +3.5dB 부스트된다.
   */
  applyChannelMode(mode) {
    if (!this.ready || !this.routeGains) return;
    const { aL, aR, bL, bR, mixIn } = this.routeGains;
    const now = this.ctx.currentTime;
    const on = (g, v) => {
      try { g.gain.setTargetAtTime(v, now, 0.01); } catch { g.gain.value = v; }
    };

    switch (mode) {
      case 'left':
        on(mixIn, 0);
        on(aL, 1); on(bL, 1); on(aR, 0); on(bR, 0);
        break;
      case 'right':
        on(mixIn, 0);
        on(aL, 0); on(bL, 0); on(aR, 1); on(bR, 1);
        break;
      case 'mono':
        on(mixIn, 0.5);
        on(aL, 0); on(aR, 0); on(bL, 0); on(bR, 0);
        break;
      case 'stereo':
      case 'auto':
      default:
        on(mixIn, 0);
        on(aL, 1); on(bL, 0); on(aR, 0); on(bR, 1);
        break;
    }
  }

  setVolume(v) {
    this.baseGain = clamp(Math.round(v), 0, 100);
    if (this.ready) {
      const vol = this.muted ? 0 : (this.baseGain / 100) ** 1.35;
      const target = clamp(vol, 0, 1) * 10 ** (this.replayGainDb / 20);
      const now = this.ctx.currentTime;
      this.nodes.gain.gain.setTargetAtTime(target, now, 0.015);
    } else if (this.video) {
      this.video.volume = this.muted ? 0 : this.baseGain / 100;
    }
  }

  setMuted(m) {
    this.muted = !!m;
    this.setVolume(this.baseGain);
    if (!this.ready && this.video) this.video.muted = this.muted;
  }

  /** 현재 출력 레벨 (dBFS 근사) */
  measureLevel() {
    if (!this.ready || !this.nodes.analyser) return null;
    const buf = this.analyserBuf;
    this.nodes.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / buf.length);
    return { rms, peak, db: rms > 0 ? 20 * Math.log10(rms) : -100, peakDb: peak > 0 ? 20 * Math.log10(peak) : -100 };
  }

  /**
   * 트랙 럴타임 레벨 추정 → ReplayGain 보정값 계산.
   * 재생 시작 후 지정 시간만큼 샘플링한 뒤 1회 확정.
   */
  startReplayGainAnalysis(albumMode) {
    this.measuredRms = albumMode ? (this.measuredRms ?? []) : [];
    this.analysisStarted = performance.now();
    this.albumMode = albumMode;
  }

  /** 분석 완료 후 호출 → 보정 dB 반환 */
  finishReplayGainAnalysis(targetDb = -18) {
    if (!this.ready || !this.measuredRms || this.measuredRms.length === 0) {
      this.replayGainDb = 0;
      return 0;
    }
    // 상위 10% 프레임 평균 (피크성 프레임 제외) — perceptual loudness 근사
    const sorted = [...this.measuredRms].sort((a, b) => b - a);
    const take = sorted.slice(0, Math.max(1, Math.round(sorted.length * 0.1)));
    const avg = take.reduce((s, v) => s + v, 0) / take.length;
    const measuredDb = 20 * Math.log10(Math.max(avg, 1e-6));

    let delta = targetDb - measuredDb;
    // 과도한 증폭(디지털 클리핑) 방지
    delta = clamp(delta, -18, 12);
    this.replayGainDb = delta;
    return delta;
  }

  reset() {
    this.replayGainDb = 0;
    this.measuredRms = null;
    this.analysisStarted = 0;
  }
}

export const audio = new AudioEngine();
export { EQ_FREQUENCIES, EQ_GAIN_RANGE };
