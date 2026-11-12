import type { Race, RaceEvent } from './game/race';
import { clamp } from './game/util';

/** 全部用 WebAudio 即時合成的音效，不需要任何音檔 */
export class GameAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private skidGain!: GainNode;
  private boostGain!: GainNode;
  private lastShot = 0;
  muted = false;

  /** 必須在使用者點擊後呼叫（瀏覽器限制） */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // 引擎：兩個略為失諧的振盪器
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'square';
    const gb = ctx.createGain();
    gb.gain.value = 0.4;
    this.engA.connect(this.engFilter);
    this.engB.connect(gb).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.engA.start();
    this.engB.start();

    this.skidGain = this.loopNoise('bandpass', 1900, 3, 0);
    this.boostGain = this.loopNoise('bandpass', 700, 0.8, 0);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number, gain: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return g;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.5;
  }

  /** 每幀更新持續性的聲音（引擎、甩尾、噴射） */
  frame(race: Race | null, active: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const p = race?.player;
    if (!p || !active || p.dead) {
      this.engGain.gain.setTargetAtTime(0, t, 0.08);
      this.skidGain.gain.setTargetAtTime(0, t, 0.05);
      this.boostGain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const r = clamp(Math.abs(p.speed) / p.topSpeed, 0, 1.5);
    const f = 55 + r * 150;
    this.engA.frequency.setTargetAtTime(f, t, 0.05);
    this.engB.frequency.setTargetAtTime(f * 0.502, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(400 + r * 1500, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.1 + r * 0.06, t, 0.08);
    const skid = p.drifting ? clamp(Math.abs(p.slip) * 1.2, 0, 1) * 0.16 : 0;
    this.skidGain.gain.setTargetAtTime(skid, t, 0.04);
    this.boostGain.gain.setTargetAtTime(p.boostT > 0 ? 0.3 : p.miniT > 0 ? 0.18 : 0, t, 0.06);
  }

  private burst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType = 'bandpass', sweepTo = 0): void {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.004) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo > 0) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  beep(freq: number, dur: number, vol = 0.25): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  onEvent(e: RaceEvent, race: Race): void {
    if (!this.ctx) return;
    const p = race.player;
    const near = (x: number, z: number, range: number) => clamp(1 - Math.hypot(x - p.x, z - p.z) / range, 0, 1);
    switch (e.t) {
      case 'shot': {
        const now = performance.now();
        if (now - this.lastShot < 45) break;
        this.lastShot = now;
        const mine = e.k === p;
        const vol = mine ? 0.22 : near(e.x, e.z, 90) * 0.12;
        this.burst(e.k.primary === 'vulcan' ? 2400 : 1300, 1.2, 0.07, vol);
        break;
      }
      case 'hit':
        if (e.k === p) this.burst(3200, 4, 0.05, 0.18);
        else if (e.by === p) this.burst(4200, 6, 0.04, 0.1);
        break;
      case 'blast':
        this.burst(900, 0.6, 0.7, 0.2 + near(e.x, e.z, 140) * 0.7, 'lowpass', 60);
        break;
      case 'launch':
        this.burst(500, 0.8, 0.35, e.k === p ? 0.35 : near(e.k.x, e.k.z, 80) * 0.2, 'bandpass', 1800);
        break;
      case 'kart':
        if (e.k !== p) break;
        if (e.e === 'boost') this.burst(400, 0.7, 0.5, 0.4, 'bandpass', 2400);
        else if (e.e === 'mini') this.burst(700, 0.9, 0.25, 0.3, 'bandpass', 2000);
        else if (e.e === 'n2o') { this.beep(880, 0.08, 0.15); setTimeout(() => this.beep(1320, 0.12, 0.15), 80); }
        else if (e.e === 'wall') this.burst(300, 0.8, 0.2, 0.4, 'lowpass');
        break;
      case 'count':
        this.beep(440, 0.15);
        break;
      case 'go':
        this.beep(880, 0.45);
        break;
      case 'lap':
        if (e.k === p) { this.beep(660, 0.1, 0.18); setTimeout(() => this.beep(990, 0.15, 0.18), 110); }
        break;
    }
  }
}
