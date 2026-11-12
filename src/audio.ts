import { PRIMARY } from './game/weapons';
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

/** 比賽配樂的風格 */
export type MusicStyle = 'synth' | 'lofi' | 'hiphop' | 'metal' | 'chip';
export const MUSIC_STYLES: { id: MusicStyle; name: string }[] = [
  { id: 'synth', name: '電子' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'hiphop', name: '嘻哈' },
  { id: 'metal', name: '金屬' },
  { id: 'chip', name: '8-bit' },
];
const STYLE_TEMPO: Record<MusicStyle, number> = { synth: 152, lofi: 80, hiphop: 90, metal: 168, chip: 160 };

// Lo-fi：Dm9 → G13 → Cmaj9 → Am9 的爵士進行
const LOFI: { bass: number; tones: number[] }[] = [
  { bass: 50, tones: [53, 57, 60, 64] },
  { bass: 43, tones: [53, 59, 64, 65] },
  { bass: 48, tones: [52, 55, 59, 62] },
  { bass: 45, tones: [55, 60, 64, 71] },
];
// 嘻哈：Am7 → Fmaj7 → Dm7 → E7
const HIPHOP: { bass: number; tones: number[] }[] = [
  { bass: 45, tones: [57, 60, 64, 67] },
  { bass: 41, tones: [57, 60, 64, 65] },
  { bass: 38, tones: [57, 60, 62, 65] },
  { bass: 40, tones: [56, 59, 62, 64] },
];
// 鐘聲旋律：每小節 16 格，-1 = 休息
const R = -1;
const HIPHOP_BELL: number[][] = [
  [64, R, R, 67, R, R, 69, R, 67, R, 64, R, R, 62, R, R],
  [65, R, R, 64, R, R, 60, R, 64, R, R, R, 57, R, R, R],
  [62, R, R, 65, R, R, 69, R, 72, R, 69, R, 65, R, R, R],
  [64, R, 68, R, 71, R, R, R, 74, R, 71, R, 68, R, 64, R],
];
// 金屬：E 小調，低音弦的根音、悶音節奏（1 = 悶音、2 = 長音）與主奏旋律（八分音符）
const METAL_ROOTS = [40, 40, 43, 41, 40, 40, 45, 43];
const METAL_RIFF = [
  [2, 0, 0, 1, 1, 1, 2, 0, 0, 1, 1, 1, 1, 0, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 0, 1, 2, 0, 1, 1],
];
const METAL_LEAD = [
  [64, 67, 71, 67, 76, 74, 71, 67], [64, 67, 71, 74, 76, 79, 76, 74], [67, 71, 74, 71, 79, 78, 74, 71], [65, 69, 72, 69, 77, 76, 72, 69],
  [64, 67, 71, 67, 76, 74, 71, 67], [76, 74, 71, 74, 79, 76, 74, 71], [69, 72, 76, 72, 81, 79, 76, 72], [71, 74, 78, 74, 83, 81, 79, 78],
];

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
    this.sfx.gain.value = 0.6 * this.sfxVol;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.3 * this.musicVol;
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
    // 火焰發射器的低沉呼嘯與雷射的高頻嗡嗡聲
    this.flameGain = this.loopNoise('lowpass', 520, 0.7, 0);
    const lz = ctx.createOscillator();
    lz.type = 'sawtooth';
    lz.frequency.value = 940;
    const lzf = ctx.createBiquadFilter();
    lzf.type = 'bandpass';
    lzf.frequency.value = 1900;
    lzf.Q.value = 2;
    this.laserGain = ctx.createGain();
    this.laserGain.gain.value = 0;
    lz.connect(lzf).connect(this.laserGain).connect(this.sfx);
    lz.start();
    this.laserOsc = lz;
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
    this.tempo = mode === 'menu' ? 112 : STYLE_TEMPO[this.musicStyle];
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

  /** 比賽配樂的風格 */
  musicStyle: MusicStyle = 'synth';
  private musicVol = 0.8;
  private sfxVol = 0.9;
  private guitarIn?: GainNode;

  setVolumes(music: number, sfx: number): void {
    this.musicVol = music;
    this.sfxVol = sfx;
    if (!this.ctx) return;
    this.music.gain.value = 0.3 * music;
    this.sfx.gain.value = 0.6 * sfx;
  }

  /** 換配樂風格；正在播比賽配樂就從頭開始 */
  setStyle(style: MusicStyle): void {
    this.musicStyle = style;
    this.tempo = this.mode === 'menu' ? 112 : STYLE_TEMPO[style];
    this.step = 0;
  }

  private playStep(step: number, t: number): void {
    const s16 = 60 / (this.tempo * this.tempoMul) / 4;
    const s = step % 16;
    const bar = Math.floor(step / 16) % 8;
    const loop = Math.floor(step / 128);
    if (this.mode !== 'race') return this.menuStep(s, bar, t, s16);
    switch (this.musicStyle) {
      case 'lofi': return this.lofiStep(s, bar, t, s16);
      case 'hiphop': return this.hiphopStep(s, bar, loop, t, s16);
      case 'metal': return this.metalStep(s, bar, loop, t, s16);
      case 'chip': return this.chipStep(s, bar, loop, t, s16);
      default: return this.synthStep(s, bar, loop, t, s16);
    }
  }

  private menuStep(s: number, bar: number, t: number, s16: number): void {
    const ch = CHORDS[bar];
    if (s === 0) for (const n of ch.tones.slice(0, 3)) this.note('sawtooth', midi(n), t, s16 * 16, 0.05, 0.08, 900, 7);
    if (s === 0 || s === 8) this.kick(t, 0.5);
    if (s % 4 === 2) this.hat(t, 0.08);
    if (s % 2 === 0) this.note('triangle', midi(ch.tones[[0, 1, 2, 3, 2, 1, 2, 3][s / 2]] + 12), t, s16 * 2.4, 0.09, 0.01, 3000);
    if (s === 0) this.note('triangle', midi(ch.bass - 12), t, s16 * 14, 0.2, 0.02, 500);
  }

  /** 電子（原本的配樂）：四拍大鼓、八分音符低音、琶音與主旋律 */
  private synthStep(s: number, bar: number, loop: number, t: number, s16: number): void {
    const ch = CHORDS[bar];
    if (s === 0) for (const n of ch.tones.slice(0, 3)) this.note('sawtooth', midi(n), t, s16 * 16, 0.035, 0.08, 900, 7);
    if (s % 4 === 0) this.kick(t, 0.9);
    if (s === 10 && bar % 2 === 1) this.kick(t, 0.6);
    if (s === 4 || s === 12) this.snare(t, 0.5);
    if (bar === 7 && s >= 12) this.snare(t, 0.32);
    if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.2 : 0.1);
    if (s % 2 === 0) this.note('sawtooth', midi(ch.bass - 12 + BASS_PATTERN[s / 2]), t, s16 * 1.7, 0.2, 0.005, 420);
    this.note('square', midi(ch.tones[[0, 2, 1, 3][s % 4]] + 12), t, s16 * 0.9, 0.035, 0.004, 2600);
    if (loop % 3 !== 0) for (const [at, n, len] of LEAD[bar]) if (at === s) this.note('square', midi(n), t, s16 * len * 0.92, 0.085, 0.01, 3200, 5);
  }

  /** Lo-fi：慢速搖擺節奏、爵士七和弦的電鋼琴、悶悶的鼓、黑膠底噪 */
  private lofiStep(s: number, bar: number, t: number, s16: number): void {
    const ch = LOFI[bar % 4];
    const sw = s % 4 === 2 ? s16 * 0.34 : 0; // 搖擺
    const tt = t + sw;
    if (s === 0 || (s === 8 && bar % 2 === 1)) for (const n of ch.tones) this.note('sine', midi(n), t + Math.random() * 0.02, s16 * 7.5, 0.05, 0.03, 1400);
    if (s === 0) for (const n of ch.tones) this.note('triangle', midi(n + 12), t, s16 * 5, 0.012, 0.02, 1800);
    if (s === 0 || s === 7 || s === 10) this.kick(tt, s === 0 ? 0.55 : 0.4);
    if (s === 4 || s === 12) this.noiseHit(t, 0.12, 0.16, 'bandpass', 1300);
    if (s % 2 === 0) this.hat(tt, s % 4 === 0 ? 0.05 : 0.08);
    if (s === 0 || s === 10) this.note('sine', midi(ch.bass - 12), tt, s16 * 5, 0.24, 0.01, 300);
    // 偶爾一小段旋律
    if (bar % 2 === 1 && (s === 2 || s === 6 || s === 11)) this.note('sine', midi(ch.tones[(s >> 2) % ch.tones.length] + 12), tt, s16 * 2.5, 0.05, 0.01, 2200);
    // 黑膠的劈啪聲
    if (Math.random() < 0.35) this.noiseHit(t + Math.random() * s16, 0.015, 0.025 + Math.random() * 0.03, 'highpass', 3500);
  }

  /** 嘻哈：重拍大鼓、拍手小鼓、三連音踩鈸、會滑音的 808 低音與鐘聲旋律 */
  private hiphopStep(s: number, bar: number, loop: number, t: number, s16: number): void {
    const ch = HIPHOP[bar % 4];
    if ([0, 3, 7, 10].includes(s) && !(s === 7 && bar % 2 === 0)) this.kick(t, 1);
    if (s === 4 || s === 12) { this.snare(t, 0.45); this.noiseHit(t + 0.012, 0.09, 0.3, 'bandpass', 1500); }
    // 踩鈸：大部分八分音符，偶爾一串連打
    if (bar % 4 === 3 && s >= 12) { for (let k = 0; k < 3; k++) this.hat(t + (k * s16) / 3, 0.09); }
    else if (s % 2 === 0) this.hat(t, 0.11);
    if (s === 0 || s === 7 || s === 10) this.bass808(midi(ch.bass - 12 + (s === 10 ? 7 : 0)), t, s16 * (s === 0 ? 6 : 3));
    if (s === 0) for (const n of ch.tones) this.note('triangle', midi(n), t, s16 * 3, 0.04, 0.005, 2000);
    if (loop % 2 === 1 && HIPHOP_BELL[bar % 4][s] >= 0) this.note('sine', midi(HIPHOP_BELL[bar % 4][s] + 24), t, s16 * 2.2, 0.06, 0.002, 6000);
  }

  /** 金屬：失真吉他的悶音重複段、雙踏大鼓、鈸、偶爾的主奏吉他 */
  private metalStep(s: number, bar: number, loop: number, t: number, s16: number): void {
    const root = METAL_ROOTS[bar];
    this.kick(t, 0.75); // 雙踏：每個十六分音符都踩
    if (s === 4 || s === 12) this.snare(t, 0.6);
    if (s === 0 && bar % 2 === 0) this.noiseHit(t, 0.9, 0.22, 'highpass', 5000);
    if (s % 2 === 0) this.noiseHit(t, 0.05, 0.07, 'highpass', 9000);
    // 節奏吉他：根音加五度的強力和弦，十六分音符悶音
    const pattern = METAL_RIFF[bar % 2];
    if (pattern[s]) {
      const long = pattern[s] === 2;
      this.guitar(midi(root), t, s16 * (long ? 3.5 : 0.8), long ? 0.16 : 0.12);
      this.guitar(midi(root + 7), t, s16 * (long ? 3.5 : 0.8), long ? 0.1 : 0.07);
    }
    this.note('sawtooth', midi(root - 12), t, s16 * 0.9, 0.12, 0.003, 300);
    if (loop % 2 === 1 && s % 2 === 0) this.guitar(midi(METAL_LEAD[bar][s / 2] + 12), t, s16 * 1.8, 0.07);
  }

  /** 8-bit 晶片：方波主旋律、三角波低音、雜訊鼓 */
  private chipStep(s: number, bar: number, loop: number, t: number, s16: number): void {
    const ch = CHORDS[bar];
    if (s % 4 === 0) this.noiseHit(t, 0.06, 0.35, 'lowpass', 400);
    if (s === 4 || s === 12) this.noiseHit(t, 0.08, 0.28, 'bandpass', 2500);
    if (s % 2 === 1) this.noiseHit(t, 0.02, 0.08, 'highpass', 8000);
    if (s % 2 === 0) this.note('triangle', midi(ch.bass - 12 + BASS_PATTERN[s / 2]), t, s16 * 1.8, 0.3, 0.002, 4000);
    this.note('square', midi(ch.tones[s % 4] + 24), t, s16 * 0.6, 0.025, 0.001, 8000);
    for (const [at, n, len] of LEAD[bar]) if (at === s && loop % 4 !== 0) this.note('square', midi(n + 12), t, s16 * len * 0.85, 0.06, 0.001, 8000);
  }

  /** 808 低音：從高一點滑到目標音、長長的尾音 */
  private bass808(freq: number, t: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * 1.5, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** 失真吉他：兩個略微失諧的鋸齒波，經過共用的失真與音箱濾波 */
  private guitar(freq: number, t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    if (!this.guitarIn) {
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * 9) * 0.9;
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      const cab = ctx.createBiquadFilter();
      cab.type = 'lowpass';
      cab.frequency.value = 3200;
      const low = ctx.createBiquadFilter();
      low.type = 'highpass';
      low.frequency.value = 90;
      const out = ctx.createGain();
      out.gain.value = 0.32;
      this.guitarIn = ctx.createGain();
      this.guitarIn.connect(shaper).connect(low).connect(cab).connect(out).connect(this.music);
    }
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.guitarIn);
      o.start(t);
      o.stop(t + dur + 0.02);
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
      this.flameGain.gain.setTargetAtTime(0, t, 0.05);
      this.laserGain.gain.setTargetAtTime(0, t, 0.03);
      return;
    }
    const kind = PRIMARY[p.primary].kind;
    const firing = p.firing > 0;
    this.flameGain.gain.setTargetAtTime(firing && kind === 'flame' ? 0.34 : 0, t, 0.05);
    this.laserGain.gain.setTargetAtTime(firing && kind === 'laser' ? 0.06 : 0, t, 0.03);
    if (firing && kind === 'laser') this.laserOsc.frequency.setTargetAtTime(p.beamHit ? 1180 : 940, t, 0.03);
    // 被導彈鎖定：急促的警告嗶聲
    if (p.lockT > 0 && t - this.lastLock > 0.2) {
      this.lastLock = t;
      this.beep(1760, 0.06, 0.1);
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

  private flameGain!: GainNode;
  private laserGain!: GainNode;
  private laserOsc!: OscillatorNode;
  private lastLock = 0;

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
      case 'hit': {
        // 火焰與雷射是連續判定，命中聲要稀疏一點
        if (e.w !== 'gun' && Math.random() > 0.25) break;
        if (e.k === p) this.burst(3200, 4, 0.05, 0.18);
        else if (e.by === p) this.burst(4200, 6, 0.04, 0.1);
        break;
      }
      case 'hazard': {
        const v = e.k === p ? 1 : near(e.x, e.z, 80);
        this.thump(v * 0.85);
        this.burst(1800, 1.2, 0.25, v * 0.4);
        break;
      }
      case 'rock': {
        const v = near(e.x, e.z, 120);
        this.burst(350, 0.7, 0.5, v * 0.5, 'lowpass', 90);
        this.thump(v * 0.4);
        break;
      }
      case 'tram': {
        // 平交道的叮噹聲
        const v = near(e.x, e.z, 160) * 0.16;
        if (v > 0.01) for (let i = 0; i < 4; i++) setTimeout(() => this.beep(i % 2 ? 1046 : 1318, 0.18, v), i * 260);
        break;
      }
      case 'lock':
        if (e.k === p) { this.beep(1320, 0.1, 0.18); setTimeout(() => this.beep(1760, 0.14, 0.18), 110); }
        break;
      case 'shortcut':
        if (e.k === p) this.beep(990, 0.08, 0.14);
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
      case 'launch': {
        const v = e.k === p ? 1 : near(e.k.x, e.k.z, 80) * 0.55;
        if (e.kind === 'mine' || e.kind === 'cluster') {
          this.burst(1500, 3, 0.08, v * 0.3);
          this.beep(e.kind === 'mine' ? 330 : 520, 0.06, v * 0.12);
        } else if (e.kind === 'grenade') {
          this.burst(260, 1, 0.22, v * 0.45, 'lowpass');
          this.thump(v * 0.3);
        } else {
          this.burst(500, 0.8, e.kind === 'missile' ? 0.55 : 0.35, v * 0.35, 'bandpass', 1800);
        }
        break;
      }
      case 'kart':
        if (e.k !== p) break;
        if (e.e === 'boost') this.burst(400, 0.7, 0.5, 0.4, 'bandpass', 2400);
        else if (e.e === 'mini') this.burst(700, 0.9, 0.25, 0.3, 'bandpass', 2000);
        else if (e.e === 'pad') { this.burst(600, 0.8, 0.35, 0.35, 'bandpass', 2600); this.beep(1175, 0.1, 0.12); }
        else if (e.e === 'n2o') { this.beep(880, 0.08, 0.15); setTimeout(() => this.beep(1320, 0.12, 0.15), 80); }
        else if (e.e === 'wall') { this.burst(300, 0.8, 0.2, 0.4, 'lowpass'); this.thump(0.3); }
        else if (e.e === 'driftStart') this.burst(2200, 2, 0.12, 0.12);
        else if (e.e === 'combo') { this.beep(1320, 0.07, 0.14); setTimeout(() => this.beep(1760, 0.09, 0.14), 70); }
        else if (e.e === 'chain') this.beep(1046, 0.08, 0.1);
        else if (e.e === 'driftCancel') this.burst(1600, 1.5, 0.1, 0.18);
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
