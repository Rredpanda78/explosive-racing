import type { Race, RaceEvent } from './game/race';
import { clamp } from './game/util';

type MusicMode = 'off' | 'menu' | 'race';

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// ---- 原創配樂：A 小調，8 小節循環 ----
// 每小節的和弦：低音根音（MIDI）與琶音用的和弦音
const CHORDS: { bass: number; tones: number[] }[] = [
  { bass: 45, tones: [57, 60, 64, 69] }, // Am
  { bass: 41, tones: [53, 57, 60, 65] }, // F
  { bass: 48, tones: [55, 60, 64, 67] }, // C
  { bass: 43, tones: [55, 59, 62, 67] }, // G
  { bass: 45, tones: [57, 60, 64, 69] }, // Am
  { bass: 41, tones: [53, 57, 60, 65] }, // F
  { bass: 43, tones: [55, 59, 62, 67] }, // G
  { bass: 40, tones: [56, 59, 64, 68] }, // E
];
// 主旋律：[十六分音符位置, 音高, 長度]
const LEAD: [number, number, number][][] = [
  [[0, 76, 3], [3, 72, 1], [4, 69, 2], [6, 72, 2], [8, 76, 2], [10, 81, 4], [14, 79, 2]],
  [[0, 77, 3], [3, 72, 1], [4, 69, 2], [6, 72, 2], [8, 77, 2], [10, 81, 4], [14, 79, 2]],
  [[0, 79, 3], [3, 76, 1], [4, 72, 2], [6, 76, 2], [8, 79, 2], [10, 84, 4], [14, 83, 2]],
  [[0, 83, 2], [2, 79, 2], [4, 74, 2], [6, 79, 2], [8, 83, 4], [12, 81, 2], [14, 79, 2]],
  [[0, 81, 3], [3, 76, 1], [4, 72, 2], [6, 76, 2], [8, 81, 2], [10, 84, 4], [14, 83, 2]],
  [[0, 84, 3], [3, 81, 1], [4, 77, 2], [6, 81, 2], [8, 84, 2], [10, 88, 4], [14, 86, 2]],
  [[0, 86, 2], [2, 83, 2], [4, 79, 2], [6, 83, 2], [8, 86, 2], [10, 83, 2], [12, 79, 2], [14, 74, 2]],
  [[0, 76, 2], [2, 80, 2], [4, 83, 2], [6, 88, 4], [10, 86, 2], [12, 83, 2], [14, 80, 2]],
];
const BASS_PATTERN = [0, 0, 12, 0, 0, 12, 0, 7]; // 八分音符，相對根音的半音數

/** 音效與配樂全部用 WebAudio 即時合成，不需要任何音檔 */
export class GameAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private skidGain!: GainNode;
  private boostGain!: GainNode;
  private lastShot = 0;
  muted = false;

  private mode: MusicMode = 'off';
  private timer = 0;
  private nextT = 0;
  private step = 0;
  private tempo = 150;
  private tempoMul = 1;

  /** 必須在使用者點擊後呼叫（瀏覽器限制） */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    // 總線：音效與音樂各自一條，再經過壓縮器避免同時發聲時爆音
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(comp);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.6;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.3;
    this.music.connect(this.master);

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
    this.engFilter.connect(this.engGain).connect(this.sfx);
    this.engA.start();
    this.engB.start();

    this.skidGain = this.loopNoise('bandpass', 1900, 3, 0);
    this.boostGain = this.loopNoise('bandpass', 700, 0.8, 0);
    if (this.mode !== 'off') this.startScheduler();
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
    src.connect(f).connect(g).connect(this.sfx);
    src.start();
    return g;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.value = m ? 0 : 0.8;
  }

  // ------------------------------------------------------------------
  // 配樂
  // ------------------------------------------------------------------

  setMusic(mode: MusicMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.step = 0;
    this.tempo = mode === 'menu' ? 112 : 152;
    this.tempoMul = 1;
    if (this.ctx) {
      this.nextT = this.ctx.currentTime + 0.08;
      if (mode === 'off') this.stopScheduler();
      else this.startScheduler();
    }
  }

  /** 最後一圈加快節奏 */
  setMusicRush(on: boolean): void {
    this.tempoMul = on ? 1.12 : 1;
  }

  private startScheduler(): void {
    if (this.timer || !this.ctx) return;
    this.nextT = this.ctx.currentTime + 0.08;
    // 用音訊時鐘排程（提前 150ms 排好），避免畫面卡頓時節奏飄掉
    this.timer = window.setInterval(() => this.schedule(), 30);
  }

  private stopScheduler(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || this.mode === 'off') return;
    if (this.nextT < ctx.currentTime - 0.3) this.nextT = ctx.currentTime + 0.05; // 分頁被暫停後重新對齊
    while (this.nextT < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextT);
      this.nextT += 60 / (this.tempo * this.tempoMul) / 4;
      this.step++;
    }
  }

  private playStep(step: number, t: number): void {
    const s16 = 60 / (this.tempo * this.tempoMul) / 4;
    const s = step % 16;
    const bar = Math.floor(step / 16) % 8;
    const loop = Math.floor(step / 128);
    const ch = CHORDS[bar];
    const race = this.mode === 'race';

    // 鋪底和弦：每小節一次
    if (s === 0) for (const n of ch.tones.slice(0, 3)) this.note('sawtooth', midi(n), t, s16 * 16, race ? 0.035 : 0.05, 0.08, 900, 7);

    if (race) {
      // 鼓組
      if (s % 4 === 0) this.kick(t, 0.9);
      if (s === 10 && bar % 2 === 1) this.kick(t, 0.6);
      if (s === 4 || s === 12) this.snare(t, 0.5);
      if (bar === 7 && s >= 12) this.snare(t, 0.32); // 過門
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.2 : 0.1);
      // 低音：八分音符
      if (s % 2 === 0) this.note('sawtooth', midi(ch.bass - 12 + BASS_PATTERN[s / 2]), t, s16 * 1.7, 0.2, 0.005, 420);
      // 琶音
      this.note('square', midi(ch.tones[[0, 2, 1, 3][s % 4]] + 12), t, s16 * 0.9, 0.035, 0.004, 2600);
      // 主旋律：每三輪休息一輪
      if (loop % 3 !== 0) for (const [at, n, len] of LEAD[bar]) if (at === s) this.note('square', midi(n), t, s16 * len * 0.92, 0.085, 0.01, 3200, 5);
    } else {
      if (s === 0 || s === 8) this.kick(t, 0.5);
      if (s % 4 === 2) this.hat(t, 0.08);
      if (s % 2 === 0) this.note('triangle', midi(ch.tones[[0, 1, 2, 3, 2, 1, 2, 3][s / 2]] + 12), t, s16 * 2.4, 0.09, 0.01, 3000);
      if (s === 0) this.note('triangle', midi(ch.bass - 12), t, s16 * 14, 0.2, 0.02, 500);
    }
  }

  private note(type: OscillatorType, freq: number, t: number, dur: number, vol: number, attack: number, cutoff: number, detune = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + Math.max(attack, dur * 0.7));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.02);
    if (detune) {
      const o2 = ctx.createOscillator();
      o2.type = type;
      o2.frequency.value = freq;
      o2.detune.value = detune * 2;
      o2.connect(f);
      o2.start(t);
      o2.stop(t + dur + 0.02);
    }
  }

  private kick(t: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.22);
  }

  private noiseHit(t: number, dur: number, vol: number, type: BiquadFilterType, freq: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.music);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  private snare(t: number, vol: number): void {
    this.noiseHit(t, 0.14, vol, 'bandpass', 1900);
    this.note('triangle', 190, t, 0.09, vol * 0.5, 0.002, 1200);
  }

  private hat(t: number, vol: number): void {
    this.noiseHit(t, 0.04, vol, 'highpass', 7500);
  }

  // ------------------------------------------------------------------
  // 音效
  // ------------------------------------------------------------------

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
    this.engGain.gain.setTargetAtTime(0.09 + r * 0.05, t, 0.08);
    const skid = p.drifting ? clamp(Math.abs(p.slip) * 1.2, 0, 1) * 0.16 : 0;
    this.skidGain.gain.setTargetAtTime(skid, t, 0.04);
    this.boostGain.gain.setTargetAtTime(p.boostT > 0 ? 0.3 : p.padT > 0 || p.miniT > 0 ? 0.18 : 0, t, 0.06);
  }

  private burst(freq: number, q: number, dur: number, vol: number, type: BiquadFilterType = 'bandpass', sweepTo = 0): void {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.004) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    // 每次播放略微變化音高與音量，避免連發時聽起來像機器重複
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq * (0.92 + Math.random() * 0.16), t);
    if (sweepTo > 0) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * (0.85 + Math.random() * 0.3), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  /** 爆炸的低頻衝擊 */
  private thump(vol: number): void {
    const ctx = this.ctx;
    if (!ctx || vol <= 0.01) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.52);
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
    o.connect(g).connect(this.sfx);
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
      case 'blast': {
        const v = near(e.x, e.z, 150);
        this.burst(900, 0.6, e.kart ? 1.0 : 0.7, 0.15 + v * 0.75, 'lowpass', 60);
        this.thump(v * 0.9);
        break;
      }
      case 'ram': {
        // 撞擊：金屬碰撞聲 + 低頻衝擊，力道越大越響
        const mine = e.a === p || e.b === p;
        const v = (mine ? 1 : near(e.x, e.z, 70)) * Math.min(1, 0.25 + e.power * 0.07);
        this.burst(2600, 1.5, 0.12, v * 0.35);
        this.thump(v * 0.6);
        break;
      }
      case 'start':
        if (e.k === p) { this.burst(500, 0.8, 0.6, 0.45, 'bandpass', 2600); this.beep(1320, 0.18, 0.15); }
        break;
      case 'elim':
        this.beep(330, 0.25, 0.2);
        setTimeout(() => this.beep(247, 0.4, 0.2), 180);
        break;
      case 'launch':
        this.burst(500, 0.8, 0.35, e.k === p ? 0.35 : near(e.k.x, e.k.z, 80) * 0.2, 'bandpass', 1800);
        break;
      case 'kart':
        if (e.k !== p) break;
        if (e.e === 'boost') this.burst(400, 0.7, 0.5, 0.4, 'bandpass', 2400);
        else if (e.e === 'mini') this.burst(700, 0.9, 0.25, 0.3, 'bandpass', 2000);
        else if (e.e === 'pad') { this.burst(600, 0.8, 0.35, 0.35, 'bandpass', 2600); this.beep(1175, 0.1, 0.12); }
        else if (e.e === 'n2o') { this.beep(880, 0.08, 0.15); setTimeout(() => this.beep(1320, 0.12, 0.15), 80); }
        else if (e.e === 'wall') { this.burst(300, 0.8, 0.2, 0.4, 'lowpass'); this.thump(0.3); }
        else if (e.e === 'driftStart') this.burst(2200, 2, 0.12, 0.12);
        else if (e.e === 'jump') this.burst(900, 0.7, 0.45, 0.3, 'bandpass', 300);
        else if (e.e === 'land') { this.thump(0.55); this.burst(400, 0.8, 0.18, 0.3, 'lowpass'); }
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
