import { PRIMARY } from './game/weapons';
import type { Race, RaceEvent } from './game/race';
import { clamp } from './game/util';

import { MusicEngine, type MusicStyle } from './music';

export { MUSIC_STYLES } from './music';
export type { MusicStyle } from './music';

type MusicMode = 'off' | 'menu' | 'race';

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
  private lastBlock = 0;
  muted = false;

  private mode: MusicMode = 'off';
  /** 配樂引擎（src/music.ts）與驅動它排程的計時器 */
  private engine?: MusicEngine;
  private timer = 0;
  private rush = false;

  /** 必須在使用者點擊後呼叫（瀏覽器限制） */
  init(): void {
    // iPhone：把音訊類型設成「播放」，靜音開關打開時也聽得到（Safari 16.4 起支援）
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) {
      try { nav.audioSession.type = 'playback'; } catch { /* 不支援就略過 */ }
    }
    if (this.ctx) {
      if (this.ctx.state !== 'running') {
        void this.ctx.resume();
        this.unlockTick();
      }
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
    // 配樂：每 25 毫秒排好接下來 0.15 秒的音符（用音訊時鐘，畫面卡頓也不會亂拍）
    this.engine = new MusicEngine(ctx, this.music);
    this.engine.setStyle(this.musicStyle);
    this.engine.setMode(this.mode);
    this.engine.setRush(this.rush);
    this.timer = window.setInterval(() => this.engine?.tick(), 25);
    this.unlockTick();
  }

  /** 在使用者點擊的當下播一個無聲的音，部分手機要這樣才會真正開始出聲 */
  private unlockTick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
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
    this.rush = false;
    this.engine?.setRush(false);
    this.engine?.setMode(mode);
  }

  /** 最後一圈：加快節奏、升調、加打擊樂 */
  setMusicRush(on: boolean): void {
    if (on === this.rush) return;
    this.rush = on;
    this.engine?.setRush(on);
  }

  /** 比賽配樂的風格 */
  musicStyle: MusicStyle = 'synth';
  private musicVol = 0.8;
  private sfxVol = 0.9;

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
    this.engine?.setStyle(style);
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
    // 雷射蓄力：音高往上爬的充能聲
    const charging = kind === 'laser' && p.charge > 0;
    this.laserGain.gain.setTargetAtTime(charging ? 0.07 : 0, t, 0.02);
    if (charging) this.laserOsc.frequency.setTargetAtTime(320 + 1700 * Math.min(1, p.charge / 0.3), t, 0.02);
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
      case 'rail': {
        // 雷射射出：高頻往下掃的「咻」＋低頻衝擊
        const v = e.k === p ? 1 : near(e.x, e.z, 120) * 0.6;
        if (v < 0.02) break;
        const ctx = this.ctx;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(2600, t);
        o.frequency.exponentialRampToValueAtTime(140, t + 0.38);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22 * v, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
        o.connect(g).connect(this.sfx);
        o.start(t);
        o.stop(t + 0.45);
        this.burst(5200, 3, 0.18, 0.25 * v);
        this.thump(0.45 * v);
        break;
      }
      case 'hit': {
        // 火焰是連續判定，命中聲要稀疏一點
        if (e.w === 'flame' && Math.random() > 0.25) break;
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
      case 'block': {
        // 護盾擋下：清脆的「叮」
        const now = performance.now();
        if (now - this.lastBlock < 60) break;
        this.lastBlock = now;
        const v = e.k === p ? 1 : near(e.x, e.z, 70) * 0.6;
        this.beep(2400 + Math.random() * 400, 0.07, 0.1 * v);
        this.burst(5200, 5, 0.05, 0.12 * v);
        break;
      }
      case 'launch': {
        const v = e.k === p ? 1 : near(e.k.x, e.k.z, 80) * 0.55;
        if (e.kind === 'shield') {
          // 護盾展開：往上掃的嗡聲
          this.beep(660, 0.08, 0.12 * v);
          setTimeout(() => this.beep(990, 0.12, 0.1 * v), 70);
          this.burst(1800, 2, 0.3, 0.18 * v);
          break;
        }
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
        else if (e.e === 'hardDrift') { this.burst(1500, 1.4, 0.3, 0.32); this.thump(0.25); }
        else if (e.e === 'hop') this.burst(700, 0.8, 0.25, 0.12, 'bandpass', 500);
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
