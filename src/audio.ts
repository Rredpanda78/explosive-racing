import { LASER_CHARGE, PRIMARY } from './game/weapons';
import type { Race, RaceEvent } from './game/race';
import { clamp } from './game/util';

import { MusicEngine, type MusicStyle } from './music';
import { OtherEngines, type ListenerCam } from './otherEngines';
import { EngineSound, WeaponSfx, previewEngine, previewWeapons, type EngineStyle, type WeaponPack } from './sfx';
import type { Kart } from './game/kart';

export { MUSIC_STYLES } from './music';
export type { MusicStyle } from './music';
export { ENGINE_STYLES, WEAPON_PACKS } from './sfx';
export type { EngineStyle, WeaponPack } from './sfx';

type MusicMode = 'off' | 'menu' | 'race';

export class GameAudio {
  private ctx?: AudioContext;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private noise!: AudioBuffer;
  /** 可選的引擎聲與武器音效包（src/sfx.ts） */
  private eng?: EngineSound;
  private wpn?: WeaponSfx;
  engineStyle: EngineStyle = 'kart';
  weaponPack: WeaponPack = 'classic';
  private skidGain!: GainNode;
  private boostGain!: GainNode;
  /** 壓路緣的隆隆聲：音量與「一格一格」的節奏（跟車速成正比） */
  private rumbleGain!: GainNode;
  private rumbleLfo!: OscillatorNode;
  muted = false;
  /** 附近其他車的引擎聲（src/otherEngines.ts）；聽者跟著追車鏡頭 */
  private others?: OtherEngines;
  private othersOn = true;
  camera: ListenerCam | null = null;
  /** 這一個單次音效的左右聲道（別台車那裡發生的才會偏，自己的永遠置中） */
  private pan = 0;

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

    // 引擎聲與武器音效：玩家在設定頁選的那一組
    this.eng = new EngineSound(ctx, this.sfx);
    this.eng.setStyle(this.engineStyle);
    // 其他車：電腦最多 4 台、手機 2 台（手機用比較省的 equalpower 擺位）
    this.others = new OtherEngines(ctx, this.sfx, window.matchMedia('(pointer: coarse)').matches);
    this.others.setStyle(this.engineStyle);
    this.wpn = new WeaponSfx(ctx, this.sfx);
    this.wpn.setPack(this.weaponPack);

    this.skidGain = this.loopNoise('bandpass', 1900, 3, 0);
    // 加速帶、小噴的噴射聲（N2O 的聲音由引擎聲自己的加速層負責）
    this.boostGain = this.loopNoise('bandpass', 700, 0.8, 0);
    this.initRumble();
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

  /**
   * 壓路緣的隆隆聲：低頻雜訊加一個低音，用方波調變音量做出「噠噠噠」壓過紅白條紋的節奏。
   * 條紋每格約 2.5 公尺，所以節奏 = 車速 / 2.5（由 frame() 更新）
   */
  private initRumble(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    lp.Q.value = 3;
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.value = 52;
    const bodyG = ctx.createGain();
    bodyG.gain.value = 0.18;
    const mod = ctx.createGain();
    mod.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 10;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(mod.gain);
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(mod);
    body.connect(bodyG).connect(mod);
    mod.connect(g).connect(this.sfx);
    src.start();
    body.start();
    lfo.start();
    this.rumbleGain = g;
    this.rumbleLfo = lfo;
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

  setEngineStyle(s: EngineStyle): void {
    this.engineStyle = s;
    this.eng?.setStyle(s);
    this.others?.setStyle(s);
  }

  /** 設定頁「其他車引擎聲」 */
  setOtherEngines(on: boolean): void {
    this.othersOn = on;
  }

  /** 除錯／驗證用：其他車引擎目前的聲部與每幀花費 */
  get otherEngines(): OtherEngines | undefined {
    return this.others;
  }

  setWeaponPack(p: WeaponPack): void {
    this.weaponPack = p;
    this.wpn?.setPack(p);
  }

  /** 設定頁試聽（要在使用者點擊時呼叫） */
  previewEngine(): void {
    this.init();
    if (this.ctx) previewEngine(this.ctx, this.sfx, this.engineStyle);
  }

  previewWeapons(): void {
    this.init();
    if (this.ctx) previewWeapons(this.ctx, this.sfx, this.weaponPack);
  }

  // ------------------------------------------------------------------
  // 音效
  // ------------------------------------------------------------------

  /** 每幀更新持續性的聲音（引擎、甩尾、噴射、壓路緣）；kerb = 玩家壓在路緣上的強度 0~1 */
  frame(race: Race | null, active: boolean, kerb = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // 其他車的引擎：跟玩家的引擎一樣，暫停與選單時靜音（玩家陣亡時照樣聽得到別人）
    this.others?.update(race, this.camera, active && this.othersOn);
    const p = race?.player;
    const eng = this.eng!, wpn = this.wpn!;
    if (!p || !active || p.dead) {
      eng.update(0, 0, false, false, false, 0);
      wpn.flame(false, 0);
      wpn.freeze(false, 0);
      wpn.laserCharge(0, 0);
      this.skidGain.gain.setTargetAtTime(0, t, 0.05);
      this.boostGain.gain.setTargetAtTime(0, t, 0.05);
      this.rumbleGain.gain.setTargetAtTime(0, t, 0.04);
      return;
    }
    this.rumbleGain.gain.setTargetAtTime(kerb * 0.75, t, kerb > 0 ? 0.02 : 0.06);
    if (kerb > 0) this.rumbleLfo.frequency.setTargetAtTime(clamp(Math.abs(p.speed) / 2.5, 4, 22), t, 0.05);
    const kind = PRIMARY[p.primary].kind;
    wpn.flame(p.firing > 0 && kind === 'flame', 1);
    wpn.freeze(p.firing > 0 && kind === 'freeze', 1);
    // 魚叉拉著繩子：收線的棘輪聲
    wpn.reel(!!p.tether, 1);
    // 雷射蓄力：音高往上爬的充能聲
    wpn.laserCharge(kind === 'laser' ? Math.min(1, p.charge / LASER_CHARGE) : 0, 1);
    // 被導彈鎖定：急促的警告嗶聲（內部限制每 0.2 秒一聲）
    if (p.lockT > 0) wpn.lockWarn(1);
    const boosting = p.boostT > 0;
    eng.update(clamp(Math.abs(p.speed) / p.topSpeed, 0, 1.5), Math.max(0, Math.abs(p.gas)), boosting, p.drifting, p.air > 0.4, 1);
    const skid = p.drifting ? clamp(Math.abs(p.slip) * 1.2, 0, 1) * 0.16 : 0;
    this.skidGain.gain.setTargetAtTime(skid, t, 0.04);
    this.boostGain.gain.setTargetAtTime(boosting ? 0.12 : p.padT > 0 || p.miniT > 0 ? 0.18 : 0, t, 0.06);
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
    src.connect(f).connect(g).connect(this.oneShotOut(dur));
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
    o.connect(g).connect(this.oneShotOut(0.52));
    o.start(t);
    o.stop(t + 0.52);
  }

  /** 單次音效的出口：別台車那裡的聲音經過一個立體聲擺位（播完就拆掉） */
  private oneShotOut(dur: number): AudioNode {
    const ctx = this.ctx!;
    if (Math.abs(this.pan) < 0.05 || !ctx.createStereoPanner) return this.sfx;
    const sp = ctx.createStereoPanner();
    sp.pan.value = this.pan;
    sp.connect(this.sfx);
    setTimeout(() => sp.disconnect(), (dur + 0.3) * 1000);
    return sp;
  }

  /** 事件發生的位置 → 單次音效的左右聲道（自己的事件、沒有位置的事件都置中） */
  private aim(e: RaceEvent, p: Kart): void {
    const o = e as { k?: Kart; a?: Kart; b?: Kart; x?: number; z?: number };
    const mine = o.k === p || o.a === p || o.b === p;
    this.pan = mine || o.x === undefined || o.z === undefined || !this.others ? 0 : this.others.panAt(o.x, o.z);
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
    const wpn = this.wpn;
    if (!this.ctx || !wpn) return;
    const p = race.player;
    this.aim(e, p);
    const near = (x: number, z: number, range: number) => clamp(1 - Math.hypot(x - p.x, z - p.z) / range, 0, 1);
    switch (e.t) {
      case 'shot': {
        const vol = e.k === p ? 1 : near(e.x, e.z, 90) * 0.55;
        wpn.shot(e.k.primary === 'vulcan' ? 'vulcan' : 'mg', vol);
        break;
      }
      case 'rail': {
        // 雷射射出
        const v = e.k === p ? 1 : near(e.x, e.z, 120) * 0.6;
        if (v >= 0.02) wpn.rail(v);
        break;
      }
      case 'zap': {
        // 電弧放電：電到自己也是全音量
        const v = e.k === p || e.chain.includes(p) ? 1 : near(e.x, e.z, 90) * 0.55;
        if (v >= 0.02) wpn.zap(v, e.chain.length);
        break;
      }
      case 'pulse': {
        const v = e.k === p ? 1 : near(e.x, e.z, 80) * 0.6;
        if (v >= 0.02) wpn.pulse(v);
        break;
      }
      case 'hook': {
        const v = e.k === p ? 1 : near(e.x, e.z, 80) * 0.5;
        if (v >= 0.02) wpn.hook(v);
        break;
      }
      case 'tether': {
        const v = e.k === p || e.v === p ? 1 : near(e.v.x, e.v.z, 80) * 0.5;
        if (v < 0.02) break;
        if (e.on) wpn.latch(v);
        else wpn.snap(v, e.why === 'snap');
        break;
      }
      case 'hit': {
        // 火焰、冷凍光束是連續判定，命中聲要稀疏一點；電弧的聲音在放電那一下
        if ((e.w === 'flame' || e.w === 'freeze') && Math.random() > 0.25) break;
        if (e.w === 'arc' && e.k !== p) break;
        if (e.k === p) wpn.hit(1, true);
        else if (e.by === p) wpn.hit(1, false);
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
      case 'street': {
        if (e.kind === 'horn') {
          // 機車喇叭：叭叭兩聲
          const v = near(e.x, e.z, 90) * 0.14;
          if (v > 0.01) { this.beep(415, 0.12, v); setTimeout(() => this.beep(415, 0.16, v), 170); }
        } else {
          // 鞭炮：一連串劈哩啪啦的短促爆裂聲
          const v = near(e.x, e.z, 110);
          if (v > 0.02) for (let i = 0; i < 16; i++) setTimeout(() => this.burst(1600 + Math.random() * 2600, 0.9, 0.035 + Math.random() * 0.03, v * (0.25 + Math.random() * 0.25)), i * 55 + Math.random() * 45);
          if (v > 0.02) this.thump(v * 0.25);
        }
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
        wpn.blast(0.17 + 0.83 * v, e.kart);
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
      case 'shatter': {
        // 護盾碎掉：玻璃碎裂
        const v = e.k === p ? 1 : near(e.k.x, e.k.z, 90) * 0.7;
        if (v >= 0.02) wpn.shatter(v);
        break;
      }
      case 'block': {
        // 護盾擋下：清脆的「叮」
        const v = e.k === p ? 1 : near(e.x, e.z, 70) * 0.6;
        if (v >= 0.02) wpn.block(v);
        break;
      }
      case 'launch': {
        const v = e.k === p ? 1 : near(e.k.x, e.k.z, 80) * 0.55;
        if (v >= 0.02) wpn.launch(e.kind, v);
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
