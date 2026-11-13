// 其他車的引擎聲：最近的幾台車各有一個輕量引擎音色，經過 PannerNode 擺到車子的位置
// ・聽者 = 追車鏡頭（往車子方向推近一點），每幀更新位置與朝向
// ・距離衰減（120 公尺外聽不到）、遠處高頻變暗、相對速度造成的都卜勒音高（擦身而過的「咻」）
// ・每台車固定一點點音高偏移，一群車在一起時不會相位抵消成一個怪聲
// ・換成別台車時先淡出再淡入，不會有爆音
// 音色是 src/sfx.ts 五種引擎的精簡版（各 2～3 個振盪器、沒有削波與加速層），玩家自己的引擎還是完整版

import type { Kart } from './game/kart';
import type { Race } from './game/race';
import type { EngineStyle } from './sfx';

/** 追車鏡頭（只需要位置與旋轉，不必引入 three） */
export interface ListenerCam {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const ease = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);
const smooth = (a: number, b: number, x: number): number => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/** 超過這個距離完全聽不到；從 FADE 開始淡出 */
const RANGE = 120;
const FADE = 85;
/** 這個距離以內音量不再變大 */
const REF = 7;
/** 都卜勒用的「音速」：比真的 343 m/s 小，車速不快也聽得出擦身而過 */
const SOUND = 200;
/** 聽者放在鏡頭往前幾公尺（鏡頭在車後 8.6 公尺，這樣車子正後方的聲音才會在後面） */
const EAR_AHEAD = 6;

// ---------------------------------------------------------------------------
// 精簡引擎音色
// ---------------------------------------------------------------------------

export interface Lite {
  style: EngineStyle;
  out: GainNode;
  /** rev 轉速、load 油門、boost 加速、pitch 都卜勒×偏音、bright 距離造成的高頻衰減 0..1、tau 平滑（0 = 直接跳到） */
  set(rev: number, load: number, boost: number, pitch: number, bright: number, t: number, tau: number): void;
  stop(t: number): void;
}

/** 一組節點：一起停、停完一起斷開 */
class Nodes {
  private readonly all: AudioNode[] = [];
  private readonly srcs: OscillatorNode[] = [];
  constructor(readonly ctx: BaseAudioContext) {}
  gain(v: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.all.push(g);
    return g;
  }
  filt(type: BiquadFilterType, f: number, q = 0.707): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    this.all.push(b);
    return b;
  }
  osc(w: OscillatorType | PeriodicWave, f: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (w instanceof PeriodicWave) o.setPeriodicWave(w);
    else o.type = w;
    o.frequency.value = f;
    o.start();
    this.all.push(o);
    this.srcs.push(o);
    return o;
  }
  stop(t: number): void {
    const all = this.all;
    let left = this.srcs.length;
    for (const s of this.srcs) {
      s.onended = () => {
        if (--left <= 0) for (const n of all) n.disconnect();
      };
      try { s.stop(t); } catch { /* 已經停了 */ }
    }
  }
}

interface Waves { v8: PeriodicWave; p25: PeriodicWave; tri: PeriodicWave }
const WAVES = new WeakMap<BaseAudioContext, Waves>();

function mkWave(ctx: BaseAudioContext, fn: (p: number) => number, N: number, M: number): PeriodicWave {
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let j = 0; j < M; j++) {
    const p = j / M, x = fn(p);
    for (let h = 1; h < N; h++) {
      const a = 2 * Math.PI * h * p;
      re[h] += (2 * x * Math.cos(a)) / M;
      im[h] += (2 * x * Math.sin(a)) / M;
    }
  }
  return ctx.createPeriodicWave(re, im);
}

function waves(ctx: BaseAudioContext): Waves {
  const hit = WAVES.get(ctx);
  if (hit) return hit;
  // 跟 sfx.ts 的 V8 同一種不等距點火脈衝，諧波少一點（遠處的車不需要那麼細）
  const POS = [0, 0.127, 0.247, 0.381, 0.5, 0.622, 0.753, 0.871];
  const AMP = [1, 0.6, 0.86, 0.52, 0.95, 0.68, 0.8, 0.5];
  const w: Waves = {
    v8: mkWave(ctx, (p) => {
      let x = 0;
      for (let k = 0; k < 8; k++) {
        const d = (p - POS[k] + 1) % 1;
        x += AMP[k] * Math.exp(-d / 0.022) * (1 - Math.exp(-d / 0.004));
      }
      return x;
    }, 96, 512),
    p25: mkWave(ctx, (p) => (p < 0.25 ? 1 : -1), 48, 256),
    tri: mkWave(ctx, (p) => {
      const q = Math.floor(p * 32);
      return (q < 16 ? q : 31 - q) / 7.5 - 1;
    }, 48, 256),
  };
  WAVES.set(ctx, w);
  return w;
}

/** 平滑設定：tau = 0 直接跳到（剛分配給新車時用，避免音高從上一台車滑過來） */
function P(p: AudioParam, v: number, t: number, tau: number): void {
  if (tau <= 0) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  } else p.setTargetAtTime(v, t, tau);
}

/**
 * 各風格的音量修正：精簡版少了削波與部分聲部，響度跟完整版不同。
 * 這些倍數是用 OfflineAudioContext 在 25%／60%／95% 車速、全油門下量 RMS，
 * 對齊 sfx.ts 的完整版（誤差 < 0.3 dB）
 */
const TRIM: Record<EngineStyle, number> = { kart: 0.87, v8: 1.61, sport: 1.55, turbine: 1.04, retro: 1 };

/** 建一個精簡引擎音色（也給量音量、量 CPU 的測試用） */
export function buildLite(ctx: BaseAudioContext, style: EngineStyle): Lite {
  const n = new Nodes(ctx);
  const out = n.gain(0);
  const k = TRIM[style];
  const W = waves(ctx);
  let set: Lite['set'];
  if (style === 'v8') {
    const m = n.osc(W.v8, 10), sub = n.osc('sine', 40);
    const lp = n.filt('lowpass', 500, 0.9);
    m.connect(lp);
    sub.connect(n.gain(0.35)).connect(lp);
    lp.connect(out);
    set = (rev, load, _b, pitch, bright, t, tau) => {
      const fc = ((800 + rev * 5600) / 120) * pitch;
      P(m.frequency, fc, t, tau);
      P(sub.frequency, fc * 4, t, tau);
      P(lp.frequency, (160 + rev * 1100 + load * 500) * (0.4 + 0.6 * bright), t, tau || 0.05);
      P(out.gain, (0.065 + 0.04 * load + 0.025 * rev) * k, t, tau || 0.07);
    };
  } else if (style === 'sport') {
    const a = n.osc('sawtooth', 200), b = n.osc('sawtooth', 400);
    b.detune.value = 7;
    const pk = n.filt('peaking', 1200, 2.2);
    pk.gain.value = 9;
    const lp = n.filt('lowpass', 3000, 0.8);
    a.connect(pk);
    b.connect(n.gain(0.5)).connect(pk);
    pk.connect(lp).connect(out);
    set = (rev, load, _b, pitch, bright, t, tau) => {
      const f = ((1000 + rev * 8200) / 20) * pitch;
      P(a.frequency, f, t, tau || 0.025);
      P(b.frequency, f * 2, t, tau || 0.025);
      P(pk.frequency, f * 3, t, tau || 0.03);
      P(lp.frequency, (1000 + rev * 5000) * (0.55 + 0.45 * load) * bright, t, tau || 0.04);
      P(out.gain, (0.032 + 0.022 * load + 0.012 * rev) * k, t, tau || 0.05);
    };
  } else if (style === 'turbine') {
    const w1 = n.osc('sine', 300), w2 = n.osc('triangle', 600), tw = n.osc('sine', 3000);
    const twg = n.gain(0);
    const lp = n.filt('lowpass', 9000, 0.7);
    w1.connect(n.gain(0.6)).connect(lp);
    w2.connect(n.gain(0.22)).connect(lp);
    tw.connect(twg).connect(lp);
    lp.connect(out);
    set = (rev, load, boost, pitch, bright, t, tau) => {
      const f = (150 + rev * 1250) * (1 + 0.08 * boost) * pitch;
      P(w1.frequency, f, t, tau || 0.06);
      P(w2.frequency, f * 2.02, t, tau || 0.06);
      P(tw.frequency, (1800 + rev * 3800) * pitch, t, tau || 0.1);
      P(twg.gain, 0.006 + 0.012 * load * rev + 0.01 * boost, t, tau || 0.1);
      P(lp.frequency, 9000 * bright, t, tau || 0.1);
      P(out.gain, (0.07 + 0.05 * load + 0.028 * rev) * k, t, tau || 0.08);
    };
  } else if (style === 'retro') {
    const p1 = n.osc(W.p25, 100), tr = n.osc(W.tri, 50);
    const lp = n.filt('lowpass', 6000, 0.5);
    p1.connect(n.gain(0.5)).connect(lp);
    tr.connect(n.gain(0.55)).connect(lp);
    lp.connect(out);
    set = (rev, load, boost, pitch, bright, t, tau) => {
      let f = (62 + rev * 230) * pitch;
      f = 440 * Math.pow(2, Math.round(48 * Math.log2(f / 440)) / 48); // 量化到 1/4 半音（紅白機味）
      p1.frequency.setValueAtTime(f * (boost > 0.5 ? 2 : 1), t);
      tr.frequency.setValueAtTime(f / 2, t);
      P(lp.frequency, 6000 * bright, t, tau || 0.05);
      P(out.gain, (0.1 + 0.05 * load + 0.045 * rev) * k, t, tau || 0.02);
    };
  } else {
    // 卡丁車：鋸齒波＋低八度方波，低通
    const a = n.osc('sawtooth', 80), b = n.osc('square', 40);
    const lp = n.filt('lowpass', 600, 1.1);
    a.connect(lp);
    b.connect(n.gain(0.4)).connect(lp);
    lp.connect(out);
    set = (rev, load, boost, pitch, bright, t, tau) => {
      const f = (50 + rev * 190) * (1 + 0.05 * boost) * pitch;
      P(a.frequency, f, t, tau || 0.04);
      P(b.frequency, f * 0.502, t, tau || 0.04);
      P(lp.frequency, (380 + rev * 1500 + load * 300) * (0.45 + 0.55 * bright), t, tau || 0.05);
      P(out.gain, (0.088 + 0.035 * load + 0.035 * Math.min(1.2, rev)) * k, t, tau || 0.06);
    };
  }
  return { style, out, set, stop: (t) => n.stop(t) };
}

/** 檔位與轉速反應（跟 sfx.ts 的完整引擎一致，遠處的車換檔也聽得出來） */
const SPEC: Record<EngineStyle, { gears: number[]; drop: number; idle: number; up: number; down: number }> = {
  kart: { gears: [], drop: 0, idle: 0.1, up: 0.1, down: 0.22 },
  v8: { gears: [0.24, 0.46, 0.7], drop: 0.55, idle: 0.08, up: 0.14, down: 0.3 },
  sport: { gears: [0.13, 0.27, 0.43, 0.6, 0.79], drop: 0.62, idle: 0.1, up: 0.07, down: 0.18 },
  turbine: { gears: [], drop: 0, idle: 0.08, up: 0.3, down: 0.5 },
  retro: { gears: [], drop: 0, idle: 0.1, up: 0.06, down: 0.12 },
};

// ---------------------------------------------------------------------------
// 聲部分配
// ---------------------------------------------------------------------------

interface Slot {
  kart: Kart | null;
  /** on = 正在發聲；off = 淡出中；idle = 空著（音色保留一下，太久沒用就停掉） */
  state: 'on' | 'off' | 'idle';
  since: number;
  voice: Lite | null;
  fade: GainNode;
  pan: PannerNode;
  rev: number;
  load: number;
  boost: number;
  gear: number;
  pitch: number;
  detune: number;
  lastSpeed: number;
  acc: number;
  dist: number;
  gain: number;
  fresh: boolean;
}

export interface OtherEngineInfo {
  name: string;
  dist: number;
  gain: number;
  pitch: number;
  /** 聲音在聽者座標裡的方向：右 +、前 + */
  right: number;
  front: number;
  state: string;
}

export class OtherEngines {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly slots: Slot[] = [];
  /** 同時發聲的上限（電腦 4、手機 2） */
  readonly max: number;
  private style: EngineStyle = 'kart';
  private race: Race | null = null;
  private lastT = -1;
  /** 聽者位置與朝向（世界座標），單次音效擺左右聲道也用這個 */
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private fx = 0;
  private fz = -1;
  private rx = 1;
  private rz = 0;
  /** 每幀的 JS 花費（毫秒，平滑後），量 CPU 用 */
  costMs = 0;

  private readonly mobile: boolean;

  constructor(ctx: AudioContext, out: AudioNode, mobile: boolean) {
    this.ctx = ctx;
    this.mobile = mobile;
    this.max = mobile ? 2 : 4;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(out);
    for (let i = 0; i <= this.max; i++) {
      const fade = ctx.createGain();
      fade.gain.value = 0;
      const pan = ctx.createPanner();
      // 電腦用 HRTF（前後上下都分得出來）；手機用 equalpower 省 CPU
      pan.panningModel = mobile ? 'equalpower' : 'HRTF';
      // 距離衰減自己算（才能在 120 公尺外完全靜音、平滑地淡出）
      pan.distanceModel = 'inverse';
      pan.refDistance = 1;
      pan.rolloffFactor = 0;
      fade.connect(pan).connect(this.bus);
      this.slots.push({
        kart: null, state: 'idle', since: -99, voice: null, fade, pan,
        rev: 0.1, load: 0, boost: 0, gear: 0, pitch: 1, detune: 1, lastSpeed: 0, acc: 0, dist: 999, gain: 0, fresh: false,
      });
    }
  }

  setStyle(s: EngineStyle): void {
    if (s === this.style) return;
    this.style = s;
    // 正在響的先淡出，下一幀用新音色重新分配
    for (const sl of this.slots) if (sl.state === 'on') this.release(sl, this.ctx.currentTime);
  }

  /** 世界座標 (x, z) 的聲音在左右聲道的位置 -1..1（單次音效用；很近的聲音不要擺太開） */
  panAt(x: number, z: number): number {
    const dx = x - this.lx, dz = z - this.lz;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return 0;
    return clamp(((dx * this.rx + dz * this.rz) / d) * 0.85 * Math.min(1, d / 8), -0.85, 0.85);
  }

  /** 每幀呼叫：on = 比賽中且沒有暫停、設定有開 */
  update(race: Race | null, cam: ListenerCam | null, on: boolean): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dt = this.lastT < 0 ? 1 / 60 : clamp(t - this.lastT, 1 / 240, 0.1);
    this.lastT = t;
    if (race !== this.race) {
      // 換了一場比賽：舊的車全部淡出
      this.race = race;
      for (const sl of this.slots) if (sl.state === 'on') this.release(sl, t);
    }
    const p = race?.player;
    if (!race || !p || !on) {
      for (const sl of this.slots) if (sl.state === 'on') this.release(sl, t);
      this.bus.gain.setTargetAtTime(0, t, 0.08);
      this.housekeep(t);
      this.costMs += (performance.now() - t0 - this.costMs) * 0.05;
      return;
    }
    this.listen(cam, p);

    // ---- 找出最近的幾台（已經在響的車有一點優勢，避免兩台距離差不多時來回換） ----
    const cand: { k: Kart; s: number }[] = [];
    for (const k of race.karts) {
      if (k === p || k.dead || k.out) continue;
      const d = Math.hypot(k.x - this.lx, k.y - this.ly, k.z - this.lz);
      if (d > RANGE) continue;
      const playing = this.slots.some((sl) => sl.state === 'on' && sl.kart === k);
      cand.push({ k, s: playing ? d * 0.8 - 4 : d });
    }
    cand.sort((a, b) => a.s - b.s);
    const want = cand.slice(0, this.max).map((c) => c.k);
    for (const sl of this.slots) if (sl.state === 'on' && !want.includes(sl.kart!)) this.release(sl, t);
    for (const k of want) {
      if (this.slots.some((sl) => sl.state === 'on' && sl.kart === k)) continue;
      // 找一個空著的聲部（淡出中的還不能用）；優先用音色還在、風格相同的
      let best: Slot | null = null;
      for (const sl of this.slots) {
        if (sl.state !== 'idle') continue;
        if (!best || (sl.voice?.style === this.style && best.voice?.style !== this.style)) best = sl;
      }
      if (best) this.assign(best, k, t);
    }

    // ---- 更新每個聲部 ----
    let sum = 0;
    for (const sl of this.slots) {
      if (sl.state === 'on' && sl.kart) {
        this.drive(sl, sl.kart, p, t, dt);
        sum += sl.gain;
      }
    }
    this.housekeep(t);
    // 一群車擠在一起時不要蓋過玩家自己的引擎：總音量照總和的平方根壓下來
    this.bus.gain.setTargetAtTime(0.55 / Math.max(1, Math.sqrt(sum)), t, 0.15);
    this.costMs += (performance.now() - t0 - this.costMs) * 0.05;
  }

  /** 聽者 = 鏡頭往前推一點，朝向跟鏡頭一樣 */
  private listen(cam: ListenerCam | null, p: Kart): void {
    let px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number;
    if (cam) {
      const q = cam.quaternion;
      // 鏡頭的前方 (0,0,-1) 與上方 (0,1,0) 轉到世界座標
      [fx, fy, fz] = rot(q, 0, 0, -1);
      [ux, uy, uz] = rot(q, 0, 1, 0);
      px = cam.position.x + fx * EAR_AHEAD;
      py = cam.position.y + fy * EAR_AHEAD;
      pz = cam.position.z + fz * EAR_AHEAD;
    } else {
      fx = Math.sin(p.heading); fy = 0; fz = Math.cos(p.heading);
      ux = 0; uy = 1; uz = 0;
      px = p.x - fx * 3; py = p.y + 2; pz = p.z - fz * 3;
    }
    this.lx = px; this.ly = py; this.lz = pz;
    const fl = Math.hypot(fx, fz) || 1;
    this.fx = fx / fl; this.fz = fz / fl;
    // 右方 = 前方 × 上方（只取水平分量）
    this.rx = -this.fz; this.rz = this.fx;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      // 舊版 Firefox／Safari
      const old = L as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      old.setPosition(px, py, pz);
      old.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  private assign(sl: Slot, k: Kart, t: number): void {
    if (sl.voice && sl.voice.style !== this.style) {
      sl.voice.stop(t + 0.02);
      sl.voice = null;
    }
    if (!sl.voice) {
      sl.voice = buildLite(this.ctx, this.style);
      sl.voice.out.connect(sl.fade);
    }
    sl.kart = k;
    sl.state = 'on';
    sl.since = t;
    sl.fresh = true;
    const spec = SPEC[this.style];
    const s = clamp(Math.abs(k.speed) / k.topSpeed, 0, 1.4);
    sl.gear = 0;
    sl.rev = Math.max(spec.idle, s);
    sl.load = Math.max(0, k.gas);
    sl.boost = k.boostT > 0 ? 1 : 0;
    sl.pitch = 1;
    sl.lastSpeed = k.speed;
    sl.acc = 0;
    // 每台車固定的音高偏移（±18 cents），一群車不會疊成同一個音
    const h = ((k.id * 2654435761) >>> 0) % 1000;
    sl.detune = Math.pow(2, ((h / 1000 - 0.5) * 36) / 1200);
  }

  private release(sl: Slot, t: number): void {
    sl.state = 'off';
    sl.since = t;
    sl.kart = null;
    sl.fade.gain.setTargetAtTime(0, t, 0.07);
  }

  /** 淡出完的聲部變成空著；空太久就停掉振盪器省 CPU */
  private housekeep(t: number): void {
    for (const sl of this.slots) {
      if (sl.state === 'off' && t - sl.since > 0.45) {
        sl.state = 'idle';
        sl.since = t;
      }
      if (sl.state === 'idle' && sl.voice && t - sl.since > 1.5) {
        sl.voice.stop(t + 0.02);
        sl.voice = null;
      }
    }
  }

  private drive(sl: Slot, k: Kart, p: Kart, t: number, dt: number): void {
    const voice = sl.voice!;
    const spec = SPEC[this.style];
    // ---- 轉速：車速比＋檔位（跟玩家的引擎同一套） ----
    const s = clamp(Math.abs(k.speed) / k.topSpeed, 0, 1.4);
    const gs = spec.gears;
    let g = Math.min(sl.gear, gs.length);
    while (g < gs.length && s > gs[g]) g++;
    while (g > 0 && s < gs[g - 1] - 0.05) g--;
    sl.gear = g;
    const lo = g > 0 ? gs[g - 1] : 0, hi = g < gs.length ? gs[g] : 1;
    const base = g > 0 ? spec.drop : spec.idle;
    let rev = base + ((1 - base) * (s - lo)) / (hi - lo);
    if (rev > 1) rev = 1 + (rev - 1) * 0.35;
    // 油門：本機跑的車（電腦車手）直接讀；連線的遠端車沒有傳油門，用車速變化估
    let thr: number;
    if (k.remote) {
      sl.acc += ((k.speed - sl.lastSpeed) / dt - sl.acc) * ease(dt, 0.15);
      thr = k.boostT > 0 ? 1 : Math.abs(k.speed) < 0.5 ? 0 : sl.acc > -3 ? 1 : 0.15;
    } else thr = Math.max(0, k.gas);
    sl.lastSpeed = k.speed;
    const air = k.air > 0.4;
    if (air) rev += 0.18 + 0.22 * thr;
    rev = clamp(rev * (k.drifting ? 0.94 : 1), spec.idle, 1.22);
    sl.rev += (rev - sl.rev) * ease(dt, rev > sl.rev ? spec.up : spec.down);
    sl.load += ((air ? 0.25 : 1) * thr - sl.load) * ease(dt, 0.1);
    sl.boost += ((k.boostT > 0 ? 1 : 0) - sl.boost) * ease(dt, 0.2);

    // ---- 位置、距離、都卜勒 ----
    const x = k.x, y = k.y + 0.6, z = k.z;
    const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
    const d = Math.max(0.5, Math.hypot(dx, dy, dz));
    // 相對速度沿視線的分量：正 = 遠離 → 音高變低
    const away = ((k.vx - p.vx) * dx + (k.vz - p.vz) * dz) / d;
    const dop = clamp(SOUND / (SOUND + away), 0.8, 1.25);
    sl.pitch += (dop - sl.pitch) * (sl.fresh ? 1 : ease(dt, 0.06));
    const gain = (REF / (REF + Math.max(0, d - REF))) * (1 - smooth(FADE, RANGE, d));
    const bright = clamp(1 - d / 150, 0.3, 1);
    sl.dist = d;
    sl.gain = gain;

    const pan = sl.pan;
    if (pan.positionX) {
      if (this.mobile && !sl.fresh) {
        // equalpower 每幀跳一次位置，近距離擦身時左右音量會一格一格跳（細碎的「喀喀」）：用很短的平滑
        pan.positionX.setTargetAtTime(x, t, 0.02);
        pan.positionY.setTargetAtTime(y, t, 0.02);
        pan.positionZ.setTargetAtTime(z, t, 0.02);
      } else {
        // HRTF 自己會在換角度時交叉淡化；直接設值走比較省的路徑
        if (sl.fresh) for (const q of [pan.positionX, pan.positionY, pan.positionZ]) q.cancelScheduledValues(t);
        pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z;
      }
    } else (pan as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    voice.set(sl.rev, sl.load, sl.boost, sl.pitch * sl.detune, bright, t, sl.fresh ? 0 : 0.04);
    // 剛分配：從 0 淡入；之後跟著距離平滑變化
    sl.fade.gain.setTargetAtTime(gain, t, sl.fresh ? 0.12 : 0.05);
    sl.fresh = false;
  }

  /** 除錯／驗證用：目前每個聲部在聽什麼 */
  info(): OtherEngineInfo[] {
    return this.slots.map((sl) => {
      const k = sl.kart;
      if (!k) return { name: '', dist: 0, gain: 0, pitch: 1, right: 0, front: 0, state: sl.state };
      const dx = k.x - this.lx, dz = k.z - this.lz;
      return {
        name: k.name, dist: +sl.dist.toFixed(1), gain: +sl.gain.toFixed(3), pitch: +sl.pitch.toFixed(3),
        right: +(dx * this.rx + dz * this.rz).toFixed(1), front: +(dx * this.fx + dz * this.fz).toFixed(1), state: sl.state,
      };
    });
  }
}

/** 向量 (x,y,z) 用四元數 q 旋轉 */
function rot(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): [number, number, number] {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}
