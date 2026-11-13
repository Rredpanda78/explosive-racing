// 可選的合成音效組：全部用 WebAudio 即時合成，不需要任何音檔
// ・EngineSound：五種引擎聲（每幀由 audio.ts 餵入轉速、油門、加速、甩尾、騰空）
// ・WeaponSfx：五種武器音效包（機槍、火焰、雷射、副武器、爆炸、命中、護盾、鎖定警告）
// ・previewEngine / previewWeapons：設定頁試聽
// 音量基準：各方法的 vol = 1 時，響度約等於原本 audio.ts 對「玩家自己」的音量

export type EngineStyle = 'kart' | 'v8' | 'sport' | 'turbine' | 'retro';
export type WeaponPack = 'classic' | 'punchy' | 'scifi' | 'arcade' | 'heavy';
type Launch = 'rocket' | 'grenade' | 'mine' | 'cluster' | 'missile' | 'shield';

export const ENGINE_STYLES: { id: EngineStyle; name: string; desc: string }[] = [
  { id: 'kart', name: '卡丁車', desc: '小排氣量二行程引擎，輕快又吵的嗡嗡聲' },
  { id: 'v8', name: 'V8 肌肉車', desc: '低沉不規則的轟隆聲，收油時排氣管劈啪回火' },
  { id: 'sport', name: '高轉跑車', desc: '高轉速嘶吼，加速時一檔一檔往上換' },
  { id: 'turbine', name: '渦輪電動', desc: '平順的馬達高頻聲加渦輪哨音，加速時噴射轟鳴' },
  { id: 'retro', name: '8-bit 復古', desc: '紅白機方波引擎聲，像老街機賽車' },
];

export const WEAPON_PACKS: { id: WeaponPack; name: string; desc: string }[] = [
  { id: 'classic', name: '經典', desc: '原本的音效' },
  { id: 'punchy', name: '寫實重擊', desc: '清脆槍響疊上低頻衝擊，短促有力' },
  { id: 'scifi', name: '科幻', desc: '咻咻雷射、合成器掃頻、冒泡般的爆炸' },
  { id: 'arcade', name: '街機', desc: '低位元破碎感的復古電玩音效' },
  { id: 'heavy', name: '電影級重低音', desc: '巨大的低頻爆炸與長長的殘響' },
];

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
/** 一階平滑係數（與幀率無關） */
const ease = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);
const MAX_LIVE = 44; // 同時發聲的單次音效上限（顧及手機效能）

// ---------------------------------------------------------------------------
// 共用素材：每個 AudioContext 只產生一次
// ---------------------------------------------------------------------------

type Curve = Float32Array<ArrayBuffer>;
interface Waves {
  v8: PeriodicWave; // 八缸不等距點火脈衝（一個週期 = 曲軸兩圈）
  p25: PeriodicWave; // 25% 脈衝波
  p12: PeriodicWave; // 12.5% 脈衝波
  tri: PeriodicWave; // 紅白機 4-bit 階梯三角波
}
interface Shared {
  noise: AudioBuffer; // 白噪音
  crush: AudioBuffer; // 低取樣率、低位元的破碎噪音（街機）
  bit: AudioBuffer; // 紅白機 1-bit 移位暫存器雜訊
  soft: Curve; // 軟削波
  hard: Curve; // 硬削波
  stairs: Curve; // 半量化的階梯（位元壓縮）
  w: Waves;
  ir?: AudioBuffer; // 電影級殘響（用到才產生）
}
const SHARED = new WeakMap<BaseAudioContext, Shared>();

function mkBuf(ctx: BaseAudioContext, sec: number, ch: number, fn: (i: number, n: number, c: number) => number): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.max(1, Math.floor(sr * sec)), b = ctx.createBuffer(ch, n, sr);
  for (let c = 0; c < ch; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = fn(i, n, c);
  }
  return b;
}

/** 由取樣波形算出 PeriodicWave */
function mkWave(ctx: BaseAudioContext, fn: (p: number) => number, N = 64, M = 512): PeriodicWave {
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

function mkCurve(fn: (x: number) => number): Curve {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

function shared(ctx: BaseAudioContext): Shared {
  const hit = SHARED.get(ctx);
  if (hit) return hit;
  const noise = mkBuf(ctx, 1, 1, () => Math.random() * 2 - 1);
  // 每 6 個取樣才換值、只有 4 階 → 粗糙的低位元雜訊
  let hold = 0, cur = 0;
  const crush = mkBuf(ctx, 1, 1, () => {
    if (hold-- <= 0) { hold = 5; cur = (Math.floor(Math.random() * 4) - 1.5) / 1.5; }
    return cur;
  });
  // 紅白機雜訊通道（長模式 LFSR）
  let reg = 1, h2 = 0, bv = 0;
  const bit = mkBuf(ctx, 1, 1, () => {
    if (h2-- <= 0) {
      h2 = 3;
      const fb = (reg ^ (reg >> 1)) & 1;
      reg = (reg >> 1) | (fb << 14);
      bv = reg & 1 ? 0.8 : -0.8;
    }
    return bv;
  });
  const tanhC = (k: number) => mkCurve((x) => Math.tanh(x * k) / Math.tanh(k));
  // 八缸：八次點火、間隔與力道略不相等 → 不規則的「轟隆隆」
  const POS = [0, 0.127, 0.247, 0.381, 0.5, 0.622, 0.753, 0.871];
  const AMP = [1, 0.6, 0.86, 0.52, 0.95, 0.68, 0.8, 0.5];
  const v8 = mkWave(ctx, (p) => {
    let x = 0;
    for (let k = 0; k < 8; k++) {
      const d = (p - POS[k] + 1) % 1;
      x += AMP[k] * Math.exp(-d / 0.022) * (1 - Math.exp(-d / 0.004));
    }
    return x;
  }, 160, 1024);
  const s: Shared = {
    noise, crush, bit,
    soft: tanhC(1.2),
    hard: tanhC(4),
    stairs: mkCurve((x) => 0.55 * (Math.round(x * 16) / 16) + 0.45 * x),
    w: {
      v8,
      p25: mkWave(ctx, (p) => (p < 0.25 ? 1 : -1)),
      p12: mkWave(ctx, (p) => (p < 0.125 ? 1 : -1)),
      tri: mkWave(ctx, (p) => {
        const q = Math.floor(p * 32);
        return (q < 16 ? q : 31 - q) / 7.5 - 1;
      }),
    },
  };
  SHARED.set(ctx, s);
  return s;
}

/** 電影級殘響的脈衝響應：預延遲＋越後面越暗的衰減噪音 */
function reverbIR(ctx: BaseAudioContext, sh: Shared): AudioBuffer {
  if (sh.ir) return sh.ir;
  const pre = Math.floor(ctx.sampleRate * 0.018);
  const lp = [0, 0];
  sh.ir = mkBuf(ctx, 2.8, 2, (i, n, c) => {
    if (i < pre) return 0;
    const k = (i - pre) / (n - pre), a = 0.3 + 0.55 * k;
    lp[c] = lp[c] * a + (Math.random() * 2 - 1) * (1 - a);
    return lp[c] * Math.pow(1 - k, 3);
  });
  return sh.ir;
}

type Wv = OscillatorType | 'p25' | 'p12' | 'tri';
const wave = (sh: Shared, w: Wv): OscillatorType | PeriodicWave =>
  w === 'p25' ? sh.w.p25 : w === 'p12' ? sh.w.p12 : w === 'tri' ? sh.w.tri : w;
function setWave(o: OscillatorNode, w: OscillatorType | PeriodicWave): void {
  if (typeof w === 'string') o.type = w as OscillatorType;
  else o.setPeriodicWave(w);
}

/** 一組持續發聲的節點：記錄所有音源，停止時一起停、結束後全部斷開 */
class Graph {
  private readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private stopped = false;
  constructor(private readonly ctx: BaseAudioContext) {}
  private add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  gain(v: number): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }
  filt(type: BiquadFilterType, f: number, q = 0.707): BiquadFilterNode {
    const b = this.add(this.ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }
  shaper(c: Curve): WaveShaperNode {
    const s = this.add(this.ctx.createWaveShaper());
    s.curve = c;
    return s;
  }
  osc(w: OscillatorType | PeriodicWave, f: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    setWave(o, w);
    o.frequency.value = f;
    o.start();
    this.srcs.push(o);
    return o;
  }
  noise(buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, Math.random() * buf.duration * 0.9);
    this.srcs.push(s);
    return s;
  }
  /** 在 t 停止所有音源，全部結束後斷開節點 */
  stop(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const nodes = this.nodes;
    let left = this.srcs.length, fin = false;
    const end = (): void => {
      if (--left > 0 || fin) return;
      fin = true;
      for (const n of nodes) n.disconnect();
    };
    if (!left) { left = 1; end(); return; }
    for (const s of this.srcs) {
      s.onended = end;
      try { s.stop(t); } catch { end(); }
    }
  }
}

const T = (p: AudioParam, v: number, t: number, tau: number): void => {
  p.setTargetAtTime(v, t, tau);
};

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/** 平滑後的引擎狀態（交給各風格的音色） */
interface EngState {
  rev: number; // 引擎轉速 0.08..1.22（已含檔位）
  load: number; // 油門負載 0..1
  boost: number; // 加速 0..1
  drift: number; // 甩尾 0..1
  spd: number; // 車速比 0..1.4
}
interface EngVoice {
  g: Graph;
  out: GainNode; // 切換風格時的淡入淡出
  set(s: EngState, t: number): void;
  lift?(t: number, s: EngState): void; // 收油
  shift?(t: number): void; // 升檔
}
interface EngSpec {
  gears: number[]; // 升檔的車速比門檻（空陣列 = 無段變速）
  drop: number; // 升檔後的轉速
  idle: number;
  up: number; // 轉速上升／下降的平滑時間
  down: number;
  build: (ctx: BaseAudioContext, sh: Shared) => EngVoice;
}

function voiceBase(ctx: BaseAudioContext): { g: Graph; out: GainNode } {
  const g = new Graph(ctx);
  const out = g.gain(0);
  out.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
  return { g, out };
}

/** 卡丁車：二行程鋸齒波＋低八度方波，軟削波後低通 */
function kartVoice(ctx: BaseAudioContext, sh: Shared): EngVoice {
  const { g, out } = voiceBase(ctx);
  const lv = g.gain(0);
  const a = g.osc('sawtooth', 80), b = g.osc('square', 40), c = g.osc('sawtooth', 160);
  const bg = g.gain(0.4), cg = g.gain(0.1), pre = g.gain(0.7);
  const sat = g.shaper(sh.soft), lp = g.filt('lowpass', 600, 1.1);
  a.connect(pre);
  b.connect(bg).connect(pre);
  c.connect(cg).connect(pre);
  pre.connect(sat).connect(lp).connect(lv).connect(out);
  // 加速層：噴氣嘶聲
  const wf = g.filt('bandpass', 1500, 1.2), wg = g.gain(0);
  g.noise(sh.noise).connect(wf).connect(wg).connect(out);
  return {
    g, out,
    set(s, t) {
      const f = (50 + s.rev * 190) * (1 + 0.05 * s.boost);
      a.frequency.setTargetAtTime(f * rnd(0.994, 1.006), t, 0.04); // 二行程的不規則抖動
      b.frequency.setTargetAtTime(f * 0.502, t, 0.04);
      c.frequency.setTargetAtTime(f * 2.01, t, 0.04);
      T(cg.gain, 0.08 + 0.12 * s.boost + 0.05 * s.load, t, 0.05);
      T(lp.frequency, (380 + s.rev * 1500 + s.load * 300) * (1 - 0.15 * s.drift), t, 0.05);
      T(lv.gain, 0.088 + 0.035 * s.load + 0.035 * Math.min(1.2, s.rev), t, 0.06);
      T(wf.frequency, 900 + s.rev * 1600, t, 0.08);
      T(wg.gain, 0.05 * s.boost, t, 0.08);
    },
  };
}

/** V8：不等距點火脈衝波形＋被脈衝調幅的排氣噪音，收油時回火劈啪 */
function v8Voice(ctx: BaseAudioContext, sh: Shared): EngVoice {
  const { g, out } = voiceBase(ctx);
  const lv = g.gain(0);
  const m = g.osc(sh.w.v8, 8); // 頻率 = 曲軸兩圈 = 八次點火
  const sub = g.osc('sine', 32); // 曲軸二階：胸腔共鳴
  const subG = g.gain(0.35), pre = g.gain(1.4);
  const sat = g.shaper(sh.soft), lp = g.filt('lowpass', 400, 0.9);
  m.connect(pre);
  sub.connect(subG).connect(pre);
  pre.connect(sat).connect(lp).connect(lv).connect(out);
  // 排氣噪音跟著點火脈衝起伏
  const nf = g.filt('bandpass', 700, 0.7), am = g.gain(0), ng = g.gain(0.2);
  g.noise(sh.noise).connect(nf).connect(am);
  m.connect(am.gain);
  am.connect(ng).connect(lv);
  // 回火爆響
  const cf = g.filt('bandpass', 1400, 0.9), cg = g.gain(0);
  g.noise(sh.noise).connect(cf).connect(cg).connect(out);
  // 機械增壓器的高頻聲（加速時）
  const sc = g.osc('triangle', 1500), scg = g.gain(0);
  sc.connect(scg).connect(out);
  let popEnd = 0;
  return {
    g, out,
    set(s, t) {
      const fc = (800 + s.rev * 5600) / 120;
      m.frequency.setTargetAtTime(fc, t, 0.04);
      sub.frequency.setTargetAtTime(fc * 4, t, 0.04);
      T(lp.frequency, (160 + s.rev * 1100 + s.load * 500) * (1 - 0.12 * s.drift), t, 0.05);
      T(lv.gain, 0.065 + 0.04 * s.load + 0.025 * s.rev, t, 0.07);
      T(nf.frequency, 500 + s.rev * 1500, t, 0.05);
      T(ng.gain, 0.1 + 0.25 * s.load, t, 0.06);
      T(sc.frequency, 1100 + s.rev * 2600, t, 0.05);
      T(scg.gain, 0.02 * s.boost * (0.5 + 0.5 * s.load), t, 0.08);
    },
    lift(t, s) {
      const n = 4 + Math.floor(s.rev * 7);
      let at = Math.max(t + 0.03, popEnd);
      for (let i = 0; i < n; i++) {
        at += rnd(0.025, 0.11);
        const d = rnd(0.008, 0.028), v = rnd(0.1, 0.3) * (1 - i / (n + 2));
        cf.frequency.setValueAtTime(rnd(900, 2400), at);
        cg.gain.setValueAtTime(0, at);
        cg.gain.linearRampToValueAtTime(v, at + 0.002);
        cg.gain.linearRampToValueAtTime(0, at + 0.002 + d);
        at += d;
      }
      popEnd = at;
    },
  };
}

/** 高轉跑車：三組振盪器硬削波＋進氣共鳴峰，六速換檔時掉轉速並短暫斷油 */
function sportVoice(ctx: BaseAudioContext, sh: Shared): EngVoice {
  const { g, out } = voiceBase(ctx);
  const lv = g.gain(0), dip = g.gain(1);
  const a = g.osc('sawtooth', 200), b = g.osc('sawtooth', 400), c = g.osc('square', 100);
  b.detune.value = 7;
  const bg = g.gain(0.5), cg = g.gain(0.22), pre = g.gain(0.9);
  const sat = g.shaper(sh.hard);
  const pk = g.filt('peaking', 1200, 2.2);
  pk.gain.value = 9; // 進氣共鳴：嘶吼感
  const lp = g.filt('lowpass', 3000, 0.8);
  a.connect(pre);
  b.connect(bg).connect(pre);
  c.connect(cg).connect(pre);
  pre.connect(sat).connect(pk).connect(lp).connect(lv).connect(dip).connect(out);
  // 進氣嘶聲
  const nf = g.filt('bandpass', 2000, 1.5), ng = g.gain(0);
  g.noise(sh.noise).connect(nf).connect(ng).connect(dip);
  // 渦輪哨音與洩壓閥
  const tw = g.osc('sine', 3000), twg = g.gain(0);
  tw.connect(twg).connect(out);
  const bf = g.filt('highpass', 2500, 0.7), bov = g.gain(0);
  g.noise(sh.noise).connect(bf).connect(bov).connect(out);
  return {
    g, out,
    set(s, t) {
      const f = (1000 + s.rev * 8200) / 20; // 水平對臥六缸：每轉點火三次
      a.frequency.setTargetAtTime(f, t, 0.025);
      b.frequency.setTargetAtTime(f * 2, t, 0.025);
      c.frequency.setTargetAtTime(f * 0.5, t, 0.025);
      T(pk.frequency, f * 3, t, 0.03);
      T(lp.frequency, (1000 + s.rev * 5000) * (0.55 + 0.45 * s.load) * (1 - 0.12 * s.drift), t, 0.04);
      T(lv.gain, 0.032 + 0.022 * s.load + 0.012 * s.rev, t, 0.05);
      T(nf.frequency, f * 4, t, 0.04);
      T(ng.gain, 0.04 * s.load * Math.min(1, s.rev), t, 0.06);
      T(tw.frequency, 2200 + s.rev * 4200, t, 0.08);
      T(twg.gain, 0.003 + 0.014 * s.boost + 0.004 * s.load * s.rev, t, 0.1);
    },
    shift(t) {
      T(dip.gain, 0.3, t, 0.012);
      T(dip.gain, 1, t + 0.075, 0.035);
    },
    lift(t, s) {
      if (s.rev < 0.45) return;
      // 洩壓閥「噗嘶」
      bf.frequency.setValueAtTime(5000, t);
      bf.frequency.exponentialRampToValueAtTime(1800, t + 0.3);
      T(bov.gain, 0.05 * Math.min(1, s.rev), t, 0.008);
      T(bov.gain, 0, t + 0.06, 0.08);
    },
  };
}

/** 渦輪電動：正弦／三角波馬達聲、隨車速變亮的氣流、渦輪哨音，加速時後燃器轟鳴 */
function turbineVoice(ctx: BaseAudioContext, sh: Shared): EngVoice {
  const { g, out } = voiceBase(ctx);
  const lv = g.gain(0);
  const w1 = g.osc('sine', 300), w2 = g.osc('triangle', 600), w3 = g.osc('sine', 1050);
  w1.connect(g.gain(0.6)).connect(lv);
  w2.connect(g.gain(0.22)).connect(lv);
  w3.connect(g.gain(0.07)).connect(lv);
  lv.connect(out);
  // 氣流
  const af = g.filt('bandpass', 800, 0.9), ag = g.gain(0);
  g.noise(sh.noise).connect(af).connect(ag).connect(out);
  // 渦輪哨音（兩個略為失諧的正弦 → 緩慢拍頻）
  const tw = g.osc('sine', 3000), tw2 = g.osc('sine', 3020), twg = g.gain(0);
  tw.connect(twg);
  tw2.connect(twg);
  twg.connect(out);
  // 後燃器
  const bl = g.filt('lowpass', 400, 0.8), bg = g.gain(0);
  g.noise(sh.noise).connect(bl).connect(bg).connect(out);
  const rum = g.osc('sine', 42), rg = g.gain(0);
  rum.connect(rg).connect(out);
  return {
    g, out,
    set(s, t) {
      const f = (150 + s.rev * 1250) * (1 + 0.08 * s.boost) * (1 - 0.04 * s.drift);
      w1.frequency.setTargetAtTime(f, t, 0.06);
      w2.frequency.setTargetAtTime(f * 2.02, t, 0.06);
      w3.frequency.setTargetAtTime(f * 3.5, t, 0.06);
      T(lv.gain, 0.07 + 0.05 * s.load + 0.028 * s.rev, t, 0.08);
      T(af.frequency, 400 + s.spd * 2600, t, 0.1);
      T(ag.gain, 0.015 + 0.056 * Math.min(1.2, s.spd), t, 0.1);
      tw.frequency.setTargetAtTime(1800 + s.rev * 3800, t, 0.1);
      tw2.frequency.setTargetAtTime((1800 + s.rev * 3800) * 1.006, t, 0.1);
      T(twg.gain, 0.004 + 0.01 * s.load * s.rev + 0.008 * s.boost, t, 0.1);
      T(bl.frequency, 300 + 500 * s.boost, t, 0.1);
      T(bg.gain, 0.16 * s.boost, t, 0.08);
      T(rg.gain, 0.012 + 0.08 * s.boost, t, 0.08);
    },
  };
}

/** 8-bit：25% 脈衝＋12.5% 脈衝＋紅白機三角波，音高按影格跳動並量化，加速時雜訊通道 */
function retroVoice(ctx: BaseAudioContext, sh: Shared): EngVoice {
  const { g, out } = voiceBase(ctx);
  const lv = g.gain(0);
  const p1 = g.osc(sh.w.p25, 100), p2 = g.osc(sh.w.p12, 100), tr = g.osc(sh.w.tri, 50);
  const g2 = g.gain(0), lp = g.filt('lowpass', 6000, 0.5);
  p1.connect(g.gain(0.5)).connect(lp);
  p2.connect(g2).connect(lp);
  tr.connect(g.gain(0.55)).connect(lp);
  lp.connect(lv).connect(out);
  const nz = g.noise(sh.bit), nzg = g.gain(0);
  nz.connect(nzg).connect(out);
  return {
    g, out,
    set(s, t) {
      // 每 1/30 秒交替的「突突」抖動，低轉速時最明顯
      const flip = Math.floor(t * 30) % 2 === 0;
      let f = 62 + s.rev * 230;
      if (!flip) f *= 1 - 0.04 * clamp(1.1 - s.rev, 0, 1);
      f = 440 * Math.pow(2, Math.round(48 * Math.log2(f / 440)) / 48); // 量化到 1/4 半音
      p1.frequency.setValueAtTime(f, t);
      tr.frequency.setValueAtTime(f / 2, t);
      p2.frequency.setValueAtTime(f * (s.boost > 0.5 ? 2 : 1.006), t); // 加速時第二聲部跳高八度
      T(g2.gain, 0.12 + 0.25 * s.boost, t, 0.01);
      // 音量量化成小階梯（像紅白機的音量暫存器），用極短的平滑避免爆音
      const v = Math.round((0.1 + 0.05 * s.load + 0.045 * s.rev) * 120) / 120;
      T(lv.gain, v, t, 0.004);
      nz.playbackRate.setValueAtTime(0.4 + s.rev * 0.6, t);
      T(nzg.gain, 0.05 * s.boost, t, 0.01);
    },
  };
}

const ENG: Record<EngineStyle, EngSpec> = {
  kart: { gears: [], drop: 0, idle: 0.1, up: 0.1, down: 0.22, build: kartVoice },
  v8: { gears: [0.24, 0.46, 0.7], drop: 0.55, idle: 0.08, up: 0.14, down: 0.3, build: v8Voice },
  sport: { gears: [0.13, 0.27, 0.43, 0.6, 0.79], drop: 0.62, idle: 0.1, up: 0.07, down: 0.18, build: sportVoice },
  turbine: { gears: [], drop: 0, idle: 0.08, up: 0.3, down: 0.5, build: turbineVoice },
  retro: { gears: [], drop: 0, idle: 0.1, up: 0.06, down: 0.12, build: retroVoice },
};

export class EngineSound {
  private readonly ctx: BaseAudioContext;
  private readonly sh: Shared;
  private readonly master: GainNode;
  private style: EngineStyle = 'kart';
  private voice?: EngVoice;
  private readonly st: EngState = { rev: 0.1, load: 0, boost: 0, drift: 0, spd: 0 };
  private lastT = -1;
  private gear = 0;
  private shiftT = -9;
  private liftT = -9;
  private thrHi = 0; // 最近的最大油門（判斷收油）
  private wasAir = false;
  private silentT = -1;
  private disposed = false;

  constructor(ctx: AudioContext | BaseAudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.sh = shared(ctx);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(out);
  }

  /** 換引擎風格：舊音色淡出、新音色在下一次 update 淡入 */
  setStyle(s: EngineStyle): void {
    if (s === this.style || this.disposed) return;
    this.style = s;
    this.dropVoice(0.05);
    this.gear = 0;
  }

  private dropVoice(tau: number): void {
    const v = this.voice;
    if (!v) return;
    const t = this.ctx.currentTime;
    T(v.out.gain, 0, t, tau);
    v.g.stop(t + tau * 6);
    this.voice = undefined;
  }

  /**
   * 每幀呼叫。
   * rpm：車速 / 極速（0..1.4，加速時可超過 1）；throttle：-1..1；airborne：騰空時引擎沒負載、轉速上衝；
   * volume：0..1（0 = 靜音，例如選單或陣亡）
   */
  update(rpm: number, throttle: number, boosting: boolean, drifting: boolean, airborne: boolean, volume: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    const dt = this.lastT < 0 ? 1 / 60 : clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    const vol = clamp(volume, 0, 1);
    T(this.master.gain, vol, t, 0.08);
    // 靜音一段時間就停掉振盪器省 CPU，恢復音量時再重建
    if (vol <= 0.001) {
      if (this.silentT < 0) this.silentT = t;
      if (t - this.silentT > 1.5) this.dropVoice(0.02);
      if (!this.voice) return;
    } else this.silentT = -1;
    const spec = ENG[this.style];
    if (!this.voice) {
      this.voice = spec.build(this.ctx, this.sh);
      this.voice.out.connect(this.master);
    }
    const voice = this.voice, st = this.st;
    const s = clamp(Math.abs(rpm), 0, 1.4), thr = clamp(throttle, -1, 1);

    // 檔位（有遲滯，避免在門檻附近來回跳）
    const gs = spec.gears;
    let g = Math.min(this.gear, gs.length);
    while (g < gs.length && s > gs[g]) g++;
    while (g > 0 && s < gs[g - 1] - 0.05) g--;
    if (g > this.gear && t - this.shiftT > 0.2 && thr > 0.1 && !airborne) {
      this.shiftT = t;
      voice.shift?.(t);
    }
    this.gear = g;
    const lo = g > 0 ? gs[g - 1] : 0, hi = g < gs.length ? gs[g] : 1;
    const base = g > 0 ? spec.drop : spec.idle;
    let rev = base + ((1 - base) * (s - lo)) / (hi - lo);
    if (rev > 1) rev = 1 + (rev - 1) * 0.35; // 加速超過極速：轉速只再往上一點
    // 騰空：沒負載，引擎空轉往上衝
    if (airborne) rev += 0.18 + 0.22 * Math.max(0, thr);
    // 落地：轉速被路面拉下來一下再彈回
    if (this.wasAir && !airborne) st.rev = Math.max(spec.idle, st.rev - 0.12);
    this.wasAir = airborne;

    st.drift += ((drifting ? 1 : 0) - st.drift) * ease(dt, 0.12);
    st.boost += ((boosting ? 1 : 0) - st.boost) * ease(dt, boosting ? 0.1 : 0.35);
    st.load += ((airborne ? 0.25 : 1) * Math.max(0, thr) - st.load) * ease(dt, 0.08);
    rev = clamp(rev * (1 - 0.06 * st.drift), spec.idle, 1.22); // 甩尾：負載變大、轉速略降
    const tc = t - this.shiftT < 0.08 ? 0.03 : rev > st.rev ? (airborne ? 0.07 : spec.up) : spec.down;
    st.rev += (rev - st.rev) * ease(dt, tc);
    st.spd = s;

    // 收油：剛才還踩滿油門、現在放開
    this.thrHi = Math.max(thr, this.thrHi - dt * 2.5);
    if (thr < 0.1 && this.thrHi > 0.6 && st.rev > 0.35 && t - this.liftT > 0.6) {
      this.liftT = t;
      this.thrHi = 0;
      voice.lift?.(t, st);
    }
    voice.set(st, t);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    T(this.master.gain, 0, t, 0.02);
    this.dropVoice(0.02);
    const m = this.master;
    setTimeout(() => m.disconnect(), 250);
  }
}

// ---------------------------------------------------------------------------
// 武器：單次音效的基本零件
// ---------------------------------------------------------------------------

interface NzOpt {
  type?: BiquadFilterType; // 預設帶通
  q?: number;
  to?: number; // 濾波頻率掃到
  a?: number; // 起音秒數
  h?: number; // 持續秒數
  buf?: AudioBuffer;
  rate?: number; // 播放速率
  rto?: number; // 播放速率掃到
}
interface TnOpt {
  to?: number; // 音高掃到
  sd?: number; // 掃頻秒數（預設整段）
  steps?: number; // 階梯式掃頻（街機）
  a?: number;
  h?: number;
  lp?: number; // 低通
  q?: number;
}

class Shots {
  live = 0;
  constructor(private readonly ctx: BaseAudioContext, readonly sh: Shared, public dest: AudioNode) {}

  private env(p: AudioParam, t: number, v: number, a: number, h: number, d: number): void {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(v, t + a);
    if (h > 0) p.setValueAtTime(v, t + a + h);
    p.exponentialRampToValueAtTime(0.0003, t + a + h + d);
  }

  private track(src: AudioScheduledSourceNode, nodes: (AudioNode | undefined)[]): void {
    this.live++;
    src.onended = () => {
      this.live--;
      for (const n of nodes) n?.disconnect();
    };
  }

  private ok(v: number): boolean {
    return v >= 0.002 && (this.live < MAX_LIVE || v > 0.15);
  }

  /** 濾波雜訊脈衝（f = 0 表示不濾波） */
  nz(t: number, f: number, d: number, v: number, o: NzOpt = {}): void {
    if (!this.ok(v)) return;
    const ctx = this.ctx, a = o.a ?? 0.002, h = o.h ?? 0, end = t + a + h + d;
    const buf = o.buf ?? this.sh.noise;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.setValueAtTime((o.rate ?? 1) * rnd(0.92, 1.08), t);
    if (o.rto) s.playbackRate.exponentialRampToValueAtTime(o.rto, end);
    let head: AudioNode = s, fl: BiquadFilterNode | undefined;
    if (f > 0) {
      fl = ctx.createBiquadFilter();
      fl.type = o.type ?? 'bandpass';
      fl.Q.value = o.q ?? 1;
      fl.frequency.setValueAtTime(f * rnd(0.93, 1.07), t);
      if (o.to) fl.frequency.exponentialRampToValueAtTime(o.to, end);
      head = head.connect(fl);
    }
    const g = ctx.createGain();
    this.env(g.gain, t, v * rnd(0.88, 1.1), a, h, d);
    head.connect(g).connect(this.dest);
    s.start(t, Math.random() * buf.duration * 0.9);
    s.stop(end + 0.03);
    this.track(s, [s, fl, g]);
  }

  /** 振盪器音（可掃頻、可階梯掃頻、可低通） */
  tn(t: number, w: Wv, f: number, d: number, v: number, o: TnOpt = {}): void {
    if (!this.ok(v)) return;
    const ctx = this.ctx, a = o.a ?? 0.003, h = o.h ?? 0, end = t + a + h + d;
    const osc = ctx.createOscillator();
    setWave(osc, wave(this.sh, w));
    osc.frequency.setValueAtTime(f, t);
    if (o.to) {
      const sd = o.sd ?? end - t;
      if (o.steps && o.steps > 1) {
        const n = o.steps;
        for (let i = 1; i < n; i++) osc.frequency.setValueAtTime(f * Math.pow(o.to / f, i / (n - 1)), t + (sd * i) / n);
      } else osc.frequency.exponentialRampToValueAtTime(o.to, t + sd);
    }
    let head: AudioNode = osc, fl: BiquadFilterNode | undefined;
    if (o.lp) {
      fl = ctx.createBiquadFilter();
      fl.type = 'lowpass';
      fl.frequency.value = o.lp;
      fl.Q.value = o.q ?? 0.7;
      head = head.connect(fl);
    }
    const g = ctx.createGain();
    this.env(g.gain, t, v, a, h, d);
    head.connect(g).connect(this.dest);
    osc.start(t);
    osc.stop(end + 0.03);
    this.track(osc, [osc, fl, g]);
  }

  /** 低頻衝擊（原本 audio.ts 的 thump） */
  thump(t: number, v: number, f0 = 110, f1 = 30, d = 0.5): void {
    this.tn(t, 'sine', f0, d, v, { to: f1, sd: d * 0.8 });
  }
}

// ---------------------------------------------------------------------------
// 武器音效包
// ---------------------------------------------------------------------------

/** 機槍每一發：雜訊層（必有）＋敲擊層＋音調層，全部用常駐節點重新觸發包絡，不配置新節點 */
interface ShotCfg {
  n: [BiquadFilterType, number, number, number, number]; // 雜訊層：濾波類型、頻率、Q、音量、衰減秒數
  c?: [number, number, number]; // 敲擊層：高通頻率、音量、衰減秒數
  o?: { w: Wv; f: number; to: number; v: number; d: number; lp?: number; step?: boolean }; // 音調層
  rate?: number; // 雜訊播放速率
}
type GunCfg = Record<'mg' | 'vulcan', ShotCfg>;

const SHOT: Record<WeaponPack, GunCfg> = {
  classic: {
    mg: { n: ['bandpass', 1300, 1.2, 0.22, 0.07] },
    vulcan: { n: ['bandpass', 2400, 1.2, 0.22, 0.07] },
  },
  punchy: {
    mg: { n: ['bandpass', 1700, 0.9, 0.15, 0.05], c: [3500, 0.07, 0.012], o: { w: 'sine', f: 150, to: 50, v: 0.055, d: 0.07 } },
    vulcan: { n: ['bandpass', 2600, 0.9, 0.13, 0.032], c: [4500, 0.08, 0.008], o: { w: 'sine', f: 190, to: 70, v: 0.08, d: 0.04 } },
  },
  scifi: {
    mg: { n: ['highpass', 3000, 0.7, 0.026, 0.03], o: { w: 'square', f: 1700, to: 320, v: 0.031, d: 0.09, lp: 3500 } },
    vulcan: { n: ['highpass', 3000, 0.7, 0.045, 0.02], o: { w: 'square', f: 2600, to: 900, v: 0.05, d: 0.045, lp: 4500 } },
  },
  arcade: {
    mg: { n: ['lowpass', 5000, 0.7, 0.05, 0.05], o: { w: 'p25', f: 900, to: 450, v: 0.025, d: 0.04, step: true }, rate: 1 },
    vulcan: { n: ['lowpass', 5000, 0.7, 0.07, 0.03], o: { w: 'p25', f: 1300, to: 650, v: 0.015, d: 0.025, step: true }, rate: 1.6 },
  },
  heavy: {
    mg: { n: ['bandpass', 900, 0.8, 0.13, 0.09], c: [2500, 0.04, 0.015], o: { w: 'sine', f: 110, to: 42, v: 0.05, d: 0.1 } },
    vulcan: { n: ['bandpass', 1500, 0.9, 0.11, 0.05], o: { w: 'sine', f: 130, to: 55, v: 0.09, d: 0.055 } },
  },
};

type Ev = 'rail' | Launch | 'blast' | 'blastBig' | 'hitMe' | 'hitThem' | 'block' | 'shatter' | 'lock' | 'flame' | 'charge';
/**
 * 響度校正（dB）：離線渲染量測 K-weighted 響度（BS.1770），對齊經典包（= 原本 audio.ts 的音量）；
 * 寫實與電影級允許比經典響 1～1.5 dB
 */
const TRIM: Record<WeaponPack, Partial<Record<Ev, number>>> = {
  classic: {},
  punchy: {
    rail: 2.3, rocket: -8.7, missile: -7.8, grenade: 4.6, mine: -0.9, cluster: -3.2, shield: 4.9, blast: 3, blastBig: 2.8,
    hitMe: -12.4, hitThem: -8.1, block: 3, shatter: 3.8, lock: 3, flame: -9.6, charge: 0,
  },
  scifi: {
    rail: 1.4, rocket: 0.5, missile: -0.9, grenade: 5.5, mine: -0.9, cluster: -1.1, shield: -1.5, blast: 0, blastBig: -1.2,
    hitMe: -4.6, hitThem: -14.5, block: 1.2, shatter: 3.3, lock: 0.9, flame: -4.1, charge: -4.6,
  },
  arcade: {
    rail: 3.7, rocket: -11.1, missile: -11.5, grenade: 5.5, mine: 7.7, cluster: 7.3, shield: 10.2, blast: 1.2, blastBig: -0.5,
    hitMe: -13.5, hitThem: -7.4, block: 10.1, shatter: 1.4, lock: 7.7, flame: -15.6, charge: 2.7,
  },
  heavy: {
    rail: -3.1, rocket: -11.5, missile: -11.2, grenade: -0.7, mine: -7.4, cluster: -8.1, shield: -4.9, blast: -0.2, blastBig: -1,
    hitMe: -20.6, hitThem: -17.6, block: 0.4, shatter: 0, lock: 8.9, flame: -1.1, charge: -4.5,
  },
};
const trim = (p: WeaponPack, e: Ev): number => Math.pow(10, (TRIM[p][e] ?? 0) / 20);

interface Gun {
  g: Graph;
  src: AudioBufferSourceNode;
  nf: BiquadFilterNode;
  ng: GainNode;
  cf?: BiquadFilterNode;
  cg?: GainNode;
  o?: OscillatorNode;
  og?: GainNode;
  last: number;
}

/** 常駐包絡的一次觸發：快速起音再指數衰減（setTarget 串接，不需要取消排程，也不會爆音） */
function pulse(p: AudioParam, t: number, v: number, a: number, d: number): void {
  p.setTargetAtTime(v, t, a / 3);
  p.setTargetAtTime(0, t + a, d / 5);
}

/** 持續音（火焰、雷射蓄力） */
interface Loop {
  g: Graph;
  out: GainNode;
  set(x: number, vol: number, t: number): void;
}
type LoopBuild = (ctx: BaseAudioContext, sh: Shared) => Loop;

function loopBase(ctx: BaseAudioContext): { g: Graph; out: GainNode } {
  const g = new Graph(ctx);
  return { g, out: g.gain(0) };
}

const FLAME: Record<WeaponPack, LoopBuild> = {
  classic(ctx, sh) {
    const { g, out } = loopBase(ctx);
    g.noise(sh.noise).connect(g.filt('lowpass', 520, 0.7)).connect(out);
    return { g, out, set: (_x, vol, t) => T(out.gain, 0.34 * vol, t, 0.05) };
  },
  punchy(ctx, sh) {
    // 低沉火舌＋燃燒的劈啪聲
    const { g, out } = loopBase(ctx);
    const n = g.noise(sh.noise);
    n.connect(g.filt('lowpass', 800, 0.5)).connect(g.gain(0.22)).connect(out);
    n.connect(g.filt('bandpass', 170, 0.8)).connect(g.gain(0.55)).connect(out);
    const crk = g.gain(0);
    n.connect(g.filt('highpass', 2800, 0.7)).connect(crk).connect(out);
    return {
      g, out,
      set(_x, vol, t) {
        T(out.gain, vol, t, 0.05);
        T(crk.gain, Math.pow(Math.random(), 3) * 0.3, t, 0.006);
      },
    };
  },
  scifi(ctx, sh) {
    // 電漿噴流：帶通雜訊被 LFO 搖動＋低沉的合成器嗡聲
    const { g, out } = loopBase(ctx);
    const bf = g.filt('bandpass', 1100, 2.5);
    g.noise(sh.noise).connect(bf).connect(g.gain(0.45)).connect(out);
    const lfo = g.osc('sine', 7), lg = g.gain(450);
    lfo.connect(lg).connect(bf.frequency);
    const lp = g.filt('lowpass', 700, 2);
    g.osc('sawtooth', 110).connect(lp);
    g.osc('sawtooth', 165.8).connect(lp);
    lp.connect(g.gain(0.035)).connect(out);
    return { g, out, set: (_x, vol, t) => T(out.gain, vol, t, 0.05) };
  },
  arcade(ctx, sh) {
    // 低速播放的破碎雜訊，音量按影格閃爍
    const { g, out } = loopBase(ctx);
    g.noise(sh.crush, 0.4).connect(g.filt('lowpass', 2600, 0.7)).connect(g.gain(0.3)).connect(out);
    return { g, out, set: (_x, vol, t) => T(out.gain, vol * (Math.floor(t * 20) % 2 ? 1 : 0.65), t, 0.004) };
  },
  heavy(ctx, sh) {
    // 深沉的火焰轟鳴＋超低頻
    const { g, out } = loopBase(ctx);
    const n = g.noise(sh.noise);
    n.connect(g.filt('lowpass', 380, 0.8)).connect(g.gain(0.36)).connect(out);
    n.connect(g.filt('lowpass', 110, 0.7)).connect(g.gain(0.7)).connect(out);
    return { g, out, set: (_x, vol, t) => T(out.gain, vol, t, 0.06) };
  },
};

const CHARGE: Record<WeaponPack, LoopBuild> = {
  classic(ctx) {
    const { g, out } = loopBase(ctx);
    const o = g.osc('sawtooth', 940);
    o.connect(g.filt('bandpass', 1900, 2)).connect(out);
    return {
      g, out,
      set(x, vol, t) {
        T(o.frequency, 320 + 1700 * x, t, 0.02);
        T(out.gain, 0.07 * vol, t, 0.02);
      },
    };
  },
  punchy(ctx, sh) {
    // 電容充電的尖銳哀鳴：正弦＋五度三角波，顫音越充越快
    const { g, out } = loopBase(ctx);
    const trem = g.gain(0.7);
    const o1 = g.osc('sine', 700), o2 = g.osc('triangle', 1050);
    o1.connect(trem);
    o2.connect(g.gain(0.25)).connect(trem);
    const nf = g.filt('bandpass', 700, 6);
    g.noise(sh.noise).connect(nf).connect(g.gain(0.3)).connect(trem);
    const lfo = g.osc('sine', 6);
    lfo.connect(g.gain(0.3)).connect(trem.gain);
    trem.connect(out);
    return {
      g, out,
      set(x, vol, t) {
        const f = 700 + 4200 * Math.pow(x, 1.4);
        T(o1.frequency, f, t, 0.02);
        T(o2.frequency, f * 1.5, t, 0.02);
        T(nf.frequency, f, t, 0.02);
        T(lfo.frequency, 6 + 34 * x, t, 0.05);
        T(out.gain, 0.045 * vol, t, 0.02);
      },
    };
  },
  scifi(ctx) {
    // 兩個失諧鋸齒波＋高 Q 低通往上掃，顫音越來越快
    const { g, out } = loopBase(ctx);
    const a = g.osc('sawtooth', 160), b = g.osc('sawtooth', 160);
    b.detune.value = 14;
    a.detune.value = -14;
    const lp = g.filt('lowpass', 300, 9);
    a.connect(lp);
    b.connect(lp);
    const lfo = g.osc('sine', 4), lg = g.gain(35);
    lfo.connect(lg);
    lg.connect(a.detune);
    lg.connect(b.detune);
    lp.connect(out);
    return {
      g, out,
      set(x, vol, t) {
        const f = 160 + 1300 * x;
        T(a.frequency, f, t, 0.02);
        T(b.frequency, f, t, 0.02);
        T(lp.frequency, 300 + 6500 * Math.pow(x, 1.3), t, 0.02);
        T(lfo.frequency, 4 + 22 * x, t, 0.05);
        T(out.gain, 0.05 * vol, t, 0.02);
      },
    };
  },
  arcade(ctx, sh) {
    // 脈衝波琶音：音高按半音往上爬，每 1/30 秒跳八度
    const { g, out } = loopBase(ctx);
    const o = g.osc(sh.w.p25, 220);
    o.connect(out);
    return {
      g, out,
      set(x, vol, t) {
        const up = Math.floor(t * 30) % 2 ? 2 : 1;
        o.frequency.setValueAtTime(220 * Math.pow(2, Math.round(x * 24) / 12) * up, t);
        T(out.gain, 0.04 * vol, t, 0.005);
      },
    };
  },
  heavy(ctx) {
    // 低沉的能量堆積（根音＋五度）加一條細細的高頻哀鳴
    const { g, out } = loopBase(ctx);
    const a = g.osc('sawtooth', 55), b = g.osc('sawtooth', 82.5);
    const lp = g.filt('lowpass', 200, 3);
    a.connect(lp);
    b.connect(lp);
    lp.connect(out);
    const w = g.osc('sine', 400), wg = g.gain(0.3);
    w.connect(wg).connect(out);
    return {
      g, out,
      set(x, vol, t) {
        const f = 55 + 165 * x;
        T(a.frequency, f, t, 0.03);
        T(b.frequency, f * 1.5, t, 0.03);
        T(lp.frequency, 200 + 2800 * x, t, 0.03);
        T(w.frequency, 400 + 2600 * Math.pow(x, 1.5), t, 0.03);
        T(out.gain, 0.08 * vol, t, 0.03);
      },
    };
  },
};

/** 各音效包的單次音效 */
interface PackFx {
  rail(P: Shots, t: number, v: number): void;
  launch(P: Shots, t: number, k: Launch, v: number): void;
  blast(P: Shots, t: number, v: number, big: boolean): void;
  hit(P: Shots, t: number, v: number, me: boolean): void;
  block(P: Shots, t: number, v: number): void;
  shatter(P: Shots, t: number, v: number): void;
  lock(P: Shots, t: number, v: number, n: number): void;
}

const FX: Record<WeaponPack, PackFx> = {
  // 經典：與原本 audio.ts 相同
  classic: {
    rail(P, t, v) {
      P.tn(t, 'sawtooth', 2600, 0.41, 0.22 * v, { to: 140, sd: 0.38, a: 0.01 });
      P.nz(t, 5200, 0.18, 0.25 * v, { q: 3 });
      P.thump(t, 0.45 * v);
    },
    launch(P, t, k, v) {
      if (k === 'shield') {
        P.tn(t, 'square', 660, 0.08, 0.12 * v);
        P.tn(t + 0.07, 'square', 990, 0.12, 0.1 * v);
        P.nz(t, 1800, 0.3, 0.18 * v, { q: 2 });
      } else if (k === 'mine' || k === 'cluster') {
        P.nz(t, 1500, 0.08, 0.3 * v, { q: 3 });
        P.tn(t, 'square', k === 'mine' ? 330 : 520, 0.06, 0.12 * v);
      } else if (k === 'grenade') {
        P.nz(t, 260, 0.22, 0.45 * v, { type: 'lowpass' });
        P.thump(t, 0.3 * v);
      } else P.nz(t, 500, k === 'missile' ? 0.55 : 0.35, 0.35 * v, { q: 0.8, to: 1800 });
    },
    blast(P, t, v, big) {
      P.nz(t, 900, big ? 1 : 0.7, 0.9 * v, { type: 'lowpass', q: 0.6, to: 60 });
      P.thump(t, 0.9 * v);
    },
    hit(P, t, v, me) {
      if (me) P.nz(t, 3200, 0.05, 0.18 * v, { q: 4 });
      else P.nz(t, 4200, 0.04, 0.1 * v, { q: 6 });
    },
    block(P, t, v) {
      P.tn(t, 'square', rnd(2400, 2800), 0.07, 0.1 * v);
      P.nz(t, 5200, 0.05, 0.12 * v, { q: 5 });
    },
    shatter(P, t, v) {
      P.nz(t, 6500, 0.35, 0.4 * v, { type: 'highpass', q: 1.2, to: 3000 });
      P.thump(t, 0.3 * v);
      [2600, 2100, 1700, 1300].forEach((f, i) => P.tn(t + i * 0.045, 'square', f, 0.06, 0.08 * v));
    },
    lock(P, t, v) {
      P.tn(t, 'square', 1760, 0.06, 0.1 * v);
    },
  },

  // 寫實重擊：敲擊 click ＋ 雜訊爆裂 ＋ 低頻衝擊，尾巴短
  punchy: {
    rail(P, t, v) {
      P.nz(t, 5000, 0.012, 0.28 * v, { type: 'highpass' });
      P.nz(t, 2400, 0.14, 0.3 * v, { q: 0.7, to: 900 });
      P.tn(t, 'sine', 130, 0.28, 0.6 * v, { to: 38 });
      P.tn(t, 'sawtooth', 1900, 0.16, 0.07 * v, { to: 220, lp: 4000 });
      P.nz(t, 7000, 0.35, 0.05 * v, { type: 'highpass', a: 0.01 });
    },
    launch(P, t, k, v) {
      const clank = (at: number, s: number, m: number) => {
        P.nz(at, 4500, 0.01, 0.14 * s, { type: 'highpass' });
        P.tn(at, 'sine', 1380 * m, 0.14, 0.05 * s);
        P.tn(at, 'sine', 2170 * m, 0.1, 0.035 * s);
        P.tn(at, 'sine', 180, 0.05, 0.2 * s, { to: 90 });
      };
      if (k === 'shield') {
        P.nz(t, 4000, 0.01, 0.12 * v, { type: 'highpass' });
        P.tn(t, 'sawtooth', 110, 0.4, 0.08 * v, { to: 220, lp: 1400, a: 0.03 });
        P.nz(t, 3000, 0.3, 0.1 * v, { q: 1.5, to: 6000, a: 0.05 });
      } else if (k === 'mine') clank(t, v, 1);
      else if (k === 'cluster') for (let i = 0; i < 3; i++) clank(t + i * 0.045, v * 0.75, rnd(0.9, 1.15));
      else if (k === 'grenade') {
        P.nz(t, 4000, 0.01, 0.18 * v, { type: 'highpass' });
        P.tn(t, 'sine', 240, 0.09, 0.4 * v, { to: 90 });
        P.nz(t, 700, 0.1, 0.25 * v, { type: 'lowpass' });
      } else {
        const m = k === 'missile';
        P.nz(t, 4000, 0.012, 0.18 * v, { type: 'highpass' });
        P.nz(t, 350, m ? 0.65 : 0.45, 0.38 * v, { q: 0.9, to: 2200, a: 0.02 });
        P.tn(t, 'sine', 95, 0.16, 0.35 * v, { to: 45 });
        if (m) P.tn(t, 'triangle', 600, 0.5, 0.03 * v, { to: 1400 });
      }
    },
    blast(P, t, v, big) {
      P.nz(t, 3000, 0.015, 0.4 * v, { type: 'highpass' });
      P.nz(t, 1300, 0.16, 0.5 * v, { q: 0.6 });
      P.nz(t, 1600, big ? 0.7 : 0.45, 0.65 * v, { type: 'lowpass', q: 0.7, to: 70 });
      P.tn(t, 'sine', 95, big ? 0.5 : 0.35, 0.9 * v, { to: 30 });
      if (big) for (let i = 0; i < 5; i++) P.nz(t + rnd(0.12, 0.5), rnd(2000, 5000), 0.04, 0.07 * v, { q: 2 });
    },
    hit(P, t, v, me) {
      if (me) {
        P.nz(t, 3200, 0.03, 0.2 * v, { q: 2 });
        P.tn(t, 'sine', 2350, 0.09, 0.045 * v);
        P.tn(t, 'sine', 3240, 0.07, 0.03 * v);
        P.tn(t, 'sine', 210, 0.05, 0.2 * v, { to: 80 });
      } else {
        P.nz(t, 4600, 0.025, 0.12 * v, { q: 4 });
        P.tn(t, 'sine', 3400, 0.03, 0.03 * v);
      }
    },
    block(P, t, v) {
      const m = rnd(0.95, 1.06);
      P.nz(t, 5000, 0.01, 0.14 * v, { type: 'highpass' });
      P.tn(t, 'sine', 2900 * m, 0.14, 0.05 * v);
      P.tn(t, 'sine', 4130 * m, 0.1, 0.035 * v);
    },
    shatter(P, t, v) {
      P.nz(t, 5000, 0.28, 0.36 * v, { type: 'highpass', to: 3000 });
      for (let i = 0; i < 6; i++) P.tn(t + rnd(0, 0.25), 'sine', rnd(2500, 6000), 0.06, 0.045 * v);
      P.tn(t, 'sine', 150, 0.2, 0.3 * v, { to: 50 });
    },
    lock(P, t, v) {
      P.tn(t, 'triangle', 1550, 0.05, 0.12 * v);
    },
  },

  // 科幻：咻咻雷射、合成器掃頻、冒泡爆炸
  scifi: {
    rail(P, t, v) {
      P.tn(t, 'sawtooth', 3400, 0.5, 0.13 * v, { to: 60, lp: 7000 });
      P.tn(t, 'square', 1700, 0.42, 0.05 * v, { to: 45, lp: 3000 });
      P.nz(t, 6000, 0.12, 0.15 * v, { q: 2, to: 2000 });
      P.tn(t, 'sine', 80, 0.45, 0.45 * v, { to: 28 });
      P.tn(t + 0.12, 'sine', 1800, 0.18, 0.05 * v, { to: 300 });
      P.tn(t + 0.24, 'sine', 1800, 0.18, 0.025 * v, { to: 300 });
    },
    launch(P, t, k, v) {
      if (k === 'shield') {
        P.tn(t, 'sine', 300, 0.35, 0.13 * v, { to: 1250, a: 0.02 });
        P.tn(t, 'triangle', 2400, 0.4, 0.03 * v, { a: 0.08 });
        P.nz(t, 800, 0.35, 0.1 * v, { q: 3, to: 5000, a: 0.05 });
      } else if (k === 'mine') {
        P.tn(t, 'sine', 440, 0.07, 0.12 * v);
        P.tn(t + 0.07, 'sine', 880, 0.09, 0.1 * v);
      } else if (k === 'cluster') {
        [660, 880, 1100].forEach((f, i) => P.tn(t + i * 0.04, 'sine', f, 0.06, 0.1 * v));
      } else if (k === 'grenade') {
        P.tn(t, 'sine', 620, 0.13, 0.25 * v, { to: 180 });
        P.nz(t, 1200, 0.05, 0.1 * v, { q: 2 });
      } else {
        const d = k === 'missile' ? 0.55 : 0.35;
        P.tn(t, 'sawtooth', 180, d, 0.06 * v, { to: 1300, lp: 3000, a: 0.02 });
        P.nz(t, 300, d + 0.05, 0.25 * v, { q: 1.2, to: 3500, a: 0.03 });
        if (k === 'missile') [0.1, 0.22].forEach((dt) => P.tn(t + dt, 'sine', 1500, 0.06, 0.05 * v, { to: 2200 }));
      }
    },
    blast(P, t, v, big) {
      P.nz(t, 4000, 0.08, 0.15 * v, { q: 1 });
      P.nz(t, 2200, big ? 0.9 : 0.6, 0.6 * v, { type: 'lowpass', q: 7, to: 90 }); // 高 Q 掃頻 → 冒泡感
      P.tn(t, 'sine', 130, big ? 0.6 : 0.45, 0.85 * v, { to: 26 });
      const n = big ? 10 : 6;
      for (let i = 0; i < n; i++) {
        const f = rnd(150, 500);
        P.tn(t + rnd(0.03, big ? 0.6 : 0.4), 'sine', f, rnd(0.05, 0.1), 0.12 * v, { to: f * rnd(1.6, 2.6) });
      }
    },
    hit(P, t, v, me) {
      if (me) {
        P.tn(t, 'sawtooth', 900, 0.09, 0.08 * v, { to: 140, lp: 3000 });
        P.nz(t, 3000, 0.04, 0.1 * v, { q: 2 });
      } else P.tn(t, 'sine', 3100, 0.045, 0.06 * v, { to: 2000 });
    },
    block(P, t, v) {
      P.tn(t, 'sine', 1700, 0.11, 0.09 * v, { to: 2700 });
      P.tn(t, 'triangle', 3600, 0.07, 0.03 * v);
    },
    shatter(P, t, v) {
      [3000, 2400, 1900, 1500, 1200].forEach((f, i) => P.tn(t + i * 0.035, 'sine', f, 0.08, 0.07 * v, { to: f * 0.9 }));
      P.nz(t, 4000, 0.3, 0.25 * v, { type: 'highpass', to: 8000 });
      P.tn(t, 'sine', 120, 0.25, 0.3 * v, { to: 40 });
    },
    lock(P, t, v) {
      P.tn(t, 'sine', 1400, 0.06, 0.12 * v, { to: 2200 });
    },
  },

  // 街機：破碎雜訊＋脈衝波，音高一階一階跳
  arcade: {
    rail(P, t, v) {
      P.tn(t, 'square', 2000, 0.32, 0.06 * v, { to: 110, steps: 12 });
      P.nz(t, 0, 0.22, 0.22 * v, { buf: P.sh.crush, rate: 1.2, rto: 0.3 });
      P.tn(t, 'tri', 220, 0.3, 0.25 * v, { to: 55, steps: 6 });
    },
    launch(P, t, k, v) {
      const cr = P.sh.crush;
      if (k === 'shield') [523, 659, 784, 1047].forEach((f, i) => P.tn(t + i * 0.04, 'p12', f, 0.07, 0.07 * v));
      else if (k === 'mine') {
        P.tn(t, 'p25', 523, 0.06, 0.06 * v);
        P.tn(t + 0.06, 'p25', 392, 0.08, 0.06 * v);
      } else if (k === 'cluster') [523, 659, 784].forEach((f, i) => P.tn(t + i * 0.045, 'p25', f, 0.05, 0.055 * v));
      else if (k === 'grenade') {
        P.tn(t, 'square', 330, 0.12, 0.06 * v, { to: 110, steps: 3 });
        P.nz(t, 0, 0.1, 0.2 * v, { buf: cr, rate: 0.5 });
      } else {
        const m = k === 'missile';
        P.nz(t, 0, m ? 0.55 : 0.35, 0.22 * v, { buf: cr, rate: 0.3, rto: m ? 1.6 : 1.4 });
        P.tn(t, 'p25', m ? 330 : 220, m ? 0.3 : 0.2, 0.045 * v, { to: m ? 1320 : 880, steps: m ? 6 : 4 });
      }
    },
    blast(P, t, v, big) {
      const cr = P.sh.crush;
      P.nz(t, 0, big ? 0.9 : 0.6, 0.6 * v, { buf: cr, rate: 0.5, rto: 0.12 });
      P.tn(t, 'tri', 160, big ? 0.5 : 0.4, 0.5 * v, { to: 40, steps: 8 });
      if (big) P.nz(t + 0.18, 0, 0.5, 0.3 * v, { buf: cr, rate: 0.35, rto: 0.1 });
    },
    hit(P, t, v, me) {
      if (me) {
        P.tn(t, 'square', 160, 0.09, 0.06 * v, { to: 100, steps: 2 });
        P.nz(t, 0, 0.05, 0.14 * v, { buf: P.sh.crush });
      } else P.tn(t, 'p25', 1760, 0.035, 0.045 * v);
    },
    block(P, t, v) {
      P.tn(t, 'p25', 1568, 0.07, 0.06 * v, { to: 2093, steps: 2 });
    },
    shatter(P, t, v) {
      P.nz(t, 0, 0.3, 0.28 * v, { buf: P.sh.crush, rate: 1.6, rto: 0.6 });
      [2093, 1568, 1319, 1047, 784].forEach((f, i) => P.tn(t + i * 0.04, 'p25', f, 0.05, 0.06 * v));
    },
    lock(P, t, v) {
      P.tn(t, 'p25', 1760, 0.06, 0.07 * v, { to: 2349, steps: 2 });
    },
  },

  // 電影級：超低頻、長尾巴，全部經過共用殘響
  heavy: {
    rail(P, t, v) {
      P.tn(t, 'sine', 95, 1.1, 0.65 * v, { to: 24 });
      P.tn(t, 'sawtooth', 2200, 0.65, 0.12 * v, { to: 70, lp: 3500 });
      P.nz(t, 2500, 0.3, 0.28 * v, { q: 0.6, to: 400 });
      P.nz(t, 5000, 0.015, 0.22 * v, { type: 'highpass' });
    },
    launch(P, t, k, v) {
      const clank = (at: number, s: number) => {
        P.nz(at, 4000, 0.012, 0.12 * s, { type: 'highpass' });
        P.tn(at, 'sine', 610, 0.45, 0.07 * s);
        P.tn(at, 'sine', 950, 0.35, 0.05 * s);
        P.tn(at, 'sine', 120, 0.15, 0.3 * s, { to: 55 });
      };
      if (k === 'shield') {
        P.tn(t, 'sawtooth', 60, 0.7, 0.13 * v, { to: 180, lp: 900, a: 0.05 });
        P.tn(t, 'sine', 420, 0.6, 0.05 * v, { to: 840, a: 0.05 });
        P.tn(t, 'sine', 50, 0.5, 0.3 * v, { to: 70, a: 0.03 });
      } else if (k === 'mine') clank(t, v);
      else if (k === 'cluster') for (let i = 0; i < 3; i++) clank(t + i * 0.06, v * 0.7);
      else if (k === 'grenade') {
        P.tn(t, 'sine', 150, 0.25, 0.5 * v, { to: 48 });
        P.nz(t, 500, 0.25, 0.28 * v, { type: 'lowpass' });
      } else {
        const m = k === 'missile';
        P.nz(t, 280, m ? 1 : 0.75, 0.4 * v, { type: 'lowpass', q: 1, to: m ? 2000 : 1800, a: 0.03 });
        P.tn(t, 'sine', 75, m ? 0.4 : 0.35, 0.38 * v, { to: m ? 35 : 38 });
        if (m) P.tn(t, 'sawtooth', 300, 0.8, 0.025 * v, { to: 900, lp: 1500 });
      }
    },
    blast(P, t, v, big) {
      P.tn(t, 'sine', 72, big ? 1.6 : 1.1, 0.9 * v, { to: 20 });
      P.nz(t, 1300, big ? 2 : 1.4, 0.6 * v, { type: 'lowpass', q: 0.6, to: 45 });
      P.nz(t, 2000, 0.1, 0.32 * v, { q: 0.5 });
      P.nz(t + 0.05, 180, big ? 1.6 : 1, 0.35 * v, { type: 'lowpass', q: 1, a: 0.08 });
    },
    hit(P, t, v, me) {
      if (me) {
        P.tn(t, 'sine', 120, 0.18, 0.38 * v, { to: 48 });
        P.nz(t, 1800, 0.07, 0.15 * v, { q: 0.8 });
      } else {
        P.tn(t, 'sine', 160, 0.08, 0.14 * v, { to: 70 });
        P.nz(t, 3500, 0.03, 0.08 * v, { q: 2 });
      }
    },
    block(P, t, v) {
      P.tn(t, 'sine', 420, 0.6, 0.05 * v);
      P.tn(t, 'sine', 1130, 0.45, 0.035 * v);
      P.tn(t, 'sine', 1870, 0.3, 0.025 * v);
      P.nz(t, 4000, 0.012, 0.12 * v, { type: 'highpass' });
    },
    shatter(P, t, v) {
      P.nz(t, 4000, 0.6, 0.3 * v, { type: 'highpass', to: 2000 });
      for (let i = 0; i < 6; i++) P.tn(t + rnd(0, 0.3), 'sine', rnd(1800, 5000), 0.12, 0.04 * v);
      P.tn(t, 'sine', 90, 0.6, 0.45 * v, { to: 30 });
    },
    lock(P, t, v, n) {
      // 低-高交替的警報
      P.tn(t, 'sawtooth', n % 2 ? 880 : 660, 0.08, 0.06 * v, { lp: 2000 });
    },
  },
};

/** 音效包的出口處理：寫實 = 輕微軟削波、街機 = 位元壓縮、電影級 = 共用殘響 */
interface Chain {
  inp: AudioNode;
  nodes: AudioNode[];
}
function mkChain(ctx: BaseAudioContext, sh: Shared, p: WeaponPack, bus: AudioNode): Chain {
  const gain = (v: number): GainNode => {
    const n = ctx.createGain();
    n.gain.value = v;
    return n;
  };
  if (p === 'punchy') {
    const pre = gain(0.8), ws = ctx.createWaveShaper(), post = gain(0.87);
    ws.curve = sh.soft;
    pre.connect(ws).connect(post).connect(bus);
    return { inp: pre, nodes: [pre, ws, post] };
  }
  if (p === 'arcade') {
    const pre = gain(2.4), ws = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), post = gain(0.42);
    ws.curve = sh.stairs;
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    pre.connect(ws).connect(lp).connect(post).connect(bus);
    return { inp: pre, nodes: [pre, ws, lp, post] };
  }
  if (p === 'heavy') {
    const dry = gain(1), hp = ctx.createBiquadFilter(), cv = ctx.createConvolver(), ret = gain(0.6);
    hp.type = 'highpass';
    hp.frequency.value = 220; // 超低頻不進殘響，避免糊成一團
    cv.buffer = reverbIR(ctx, sh);
    dry.connect(bus);
    dry.connect(hp).connect(cv).connect(ret).connect(bus);
    return { inp: dry, nodes: [dry, hp, cv, ret] };
  }
  const n = gain(1);
  n.connect(bus);
  return { inp: n, nodes: [n] };
}

export class WeaponSfx {
  private readonly ctx: BaseAudioContext;
  private readonly sh: Shared;
  private readonly bus: GainNode;
  private readonly P: Shots;
  private pack: WeaponPack = 'classic';
  private chain: Chain;
  private gun?: Gun;
  private flameL?: Loop;
  private chargeL?: Loop;
  private flameOff = -1;
  private chargeOff = -1;
  private readonly shotT = [-9, -9];
  private readonly shotV = [0, 0];
  private readonly hitT = [-9, -9];
  private blockT = -9;
  private shatterT = -9;
  private lockT = -9;
  private lockN = 0;
  private blastT = -9;
  private blastV = 0;
  private disposed = false;

  constructor(ctx: AudioContext | BaseAudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.sh = shared(ctx);
    this.bus = ctx.createGain();
    this.bus.connect(out);
    this.chain = mkChain(ctx, this.sh, 'classic', this.bus);
    this.P = new Shots(ctx, this.sh, this.chain.inp);
  }

  setPack(p: WeaponPack): void {
    if (p === this.pack || this.disposed) return;
    this.pack = p;
    const t = this.ctx.currentTime;
    // 常駐的槍聲、火焰、蓄力淡出後停掉，下次用到時以新音效包重建
    this.gun?.g.stop(t + 0.15);
    this.gun = undefined;
    for (const L of [this.flameL, this.chargeL]) {
      if (!L) continue;
      T(L.out.gain, 0, t, 0.03);
      L.g.stop(t + 0.2);
    }
    this.flameL = this.chargeL = undefined;
    // 舊出口等尾音（殘響）放完再拆
    const old = this.chain;
    setTimeout(() => old.nodes.forEach((n) => n.disconnect()), 3500);
    this.chain = mkChain(this.ctx, this.sh, p, this.bus);
    this.P.dest = this.chain.inp;
  }

  /** 一發子彈（vulcan 約 28 發/秒、mg 約 9 發/秒）；用常駐節點重新觸發，不配置新節點 */
  shot(kind: 'mg' | 'vulcan', vol: number): void {
    if (this.disposed || vol < 0.01) return;
    const t = this.ctx.currentTime, k = kind === 'vulcan' ? 1 : 0;
    const gap = k ? 0.028 : 0.05;
    if (t - this.shotT[k] < gap && vol <= this.shotV[k] * 1.5) return;
    this.shotT[k] = t;
    this.shotV[k] = vol;
    const c = SHOT[this.pack][kind];
    const gun = this.gun ?? (this.gun = this.mkGun());
    gun.last = t;
    const j = vol * rnd(0.85, 1.15);
    T(gun.nf.frequency, c.n[1] * rnd(0.92, 1.08), t, 0.002);
    T(gun.nf.Q, c.n[2], t, 0.002);
    if (c.rate) T(gun.src.playbackRate, c.rate, t, 0.003);
    pulse(gun.ng.gain, t, c.n[3] * j, 0.0015, c.n[4]);
    if (c.c && gun.cf && gun.cg) {
      T(gun.cf.frequency, c.c[0], t, 0.002);
      pulse(gun.cg.gain, t, c.c[1] * j, 0.001, c.c[2]);
    }
    if (c.o && gun.o && gun.og) {
      const o = c.o, fr = gun.o.frequency;
      fr.cancelScheduledValues(t);
      fr.setValueAtTime(o.f * rnd(0.96, 1.04), t);
      if (o.step) fr.setValueAtTime(o.to, t + o.d * 0.45);
      else fr.exponentialRampToValueAtTime(o.to, t + o.d);
      pulse(gun.og.gain, t, o.v * j, 0.002, o.d);
    }
  }

  private mkGun(): Gun {
    const g = new Graph(this.ctx), cfg = SHOT[this.pack], m = cfg.mg, dest = this.chain.inp;
    const src = g.noise(this.pack === 'arcade' ? this.sh.crush : this.sh.noise, m.rate ?? 1);
    const nf = g.filt(m.n[0], m.n[1], m.n[2]), ng = g.gain(0);
    src.connect(nf).connect(ng).connect(dest);
    const gun: Gun = { g, src, nf, ng, last: 0 };
    if (m.c || cfg.vulcan.c) {
      gun.cf = g.filt('highpass', 4000, 0.7);
      gun.cg = g.gain(0);
      src.connect(gun.cf).connect(gun.cg).connect(dest);
    }
    const oc = m.o ?? cfg.vulcan.o;
    if (oc) {
      gun.o = g.osc(wave(this.sh, oc.w), oc.f);
      gun.og = g.gain(0);
      gun.o.connect(g.filt('lowpass', oc.lp ?? 8000, 0.7)).connect(gun.og).connect(dest);
    }
    return gun;
  }

  /** 常駐聲音的維護：太久沒開槍就把槍聲節點停掉 */
  private tick(t: number): void {
    if (this.gun && t - this.gun.last > 2) {
      this.gun.g.stop(t + 0.05);
      this.gun = undefined;
    }
  }

  /** 火焰發射器持續音（每幀呼叫） */
  flame(on: boolean, vol: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    this.tick(t);
    if (on && vol > 0.002) {
      if (!this.flameL) {
        this.flameL = FLAME[this.pack](this.ctx, this.sh);
        this.flameL.out.connect(this.chain.inp);
      }
      this.flameOff = -1;
      this.flameL.set(1, vol * trim(this.pack, 'flame'), t);
    } else if (this.flameL) {
      if (this.flameOff < 0) {
        this.flameOff = t;
        T(this.flameL.out.gain, 0, t, 0.05);
      } else if (t - this.flameOff > 1.2) {
        this.flameL.g.stop(t + 0.02);
        this.flameL = undefined;
      }
    }
  }

  /** 雷射蓄力（每幀呼叫；0 = 沒在蓄力）；充滿時會脈動 */
  laserCharge(charge01: number, vol: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    this.tick(t);
    const x = clamp(charge01, 0, 1);
    if (x > 0 && vol > 0.002) {
      if (!this.chargeL) {
        this.chargeL = CHARGE[this.pack](this.ctx, this.sh);
        this.chargeL.out.connect(this.chain.inp);
      }
      this.chargeOff = -1;
      const v = vol * trim(this.pack, 'charge');
      this.chargeL.set(x, x >= 0.999 && Math.floor(t * 14) % 2 ? v * 0.65 : v, t);
    } else if (this.chargeL) {
      if (this.chargeOff < 0) {
        this.chargeOff = t;
        T(this.chargeL.out.gain, 0, t, 0.025);
      } else if (t - this.chargeOff > 1.2) {
        this.chargeL.g.stop(t + 0.02);
        this.chargeL = undefined;
      }
    }
  }

  /** 雷射射出 */
  rail(vol: number): void {
    if (this.disposed) return;
    FX[this.pack].rail(this.P, this.ctx.currentTime, vol * trim(this.pack, 'rail'));
  }

  /** 副武器發射（含護盾展開） */
  launch(kind: Launch, vol: number): void {
    if (this.disposed) return;
    FX[this.pack].launch(this.P, this.ctx.currentTime, kind, vol * trim(this.pack, kind));
  }

  /** 爆炸（big = 車輛爆炸／大範圍）；vol 已含距離衰減 */
  blast(vol: number, big: boolean): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    // 集束彈一次炸很多顆：50 ms 內只留最響的
    if (t - this.blastT < 0.05 && vol <= this.blastV * 1.3) return;
    this.blastT = t;
    this.blastV = vol;
    FX[this.pack].blast(this.P, t, vol * trim(this.pack, big ? 'blastBig' : 'blast'), big);
  }

  /** 子彈／光束命中（onMe = 玩家被打中，否則是玩家打中別人） */
  hit(vol: number, onMe: boolean): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime, k = onMe ? 1 : 0;
    if (t - this.hitT[k] < 0.04) return;
    this.hitT[k] = t;
    FX[this.pack].hit(this.P, t, vol * trim(this.pack, onMe ? 'hitMe' : 'hitThem'), onMe);
  }

  /** 後方護盾擋下攻擊 */
  block(vol: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    if (t - this.blockT < 0.06) return;
    this.blockT = t;
    FX[this.pack].block(this.P, t, vol * trim(this.pack, 'block'));
  }

  /** 護盾碎裂 */
  shatter(vol: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    if (t - this.shatterT < 0.1) return;
    this.shatterT = t;
    FX[this.pack].shatter(this.P, t, vol * trim(this.pack, 'shatter'));
  }

  /** 被導彈鎖定的警告嗶聲（可每幀呼叫，內部限制在每 0.2 秒一聲） */
  lockWarn(vol: number): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    if (t - this.lockT < 0.2) return;
    this.lockT = t;
    FX[this.pack].lock(this.P, t, vol * trim(this.pack, 'lock'), this.lockN++);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const t = this.ctx.currentTime;
    T(this.bus.gain, 0, t, 0.02);
    this.gun?.g.stop(t + 0.15);
    this.flameL?.g.stop(t + 0.15);
    this.chargeL?.g.stop(t + 0.15);
    this.gun = this.flameL = this.chargeL = undefined;
    const bus = this.bus, nodes = this.chain.nodes;
    setTimeout(() => {
      bus.disconnect();
      nodes.forEach((n) => n.disconnect());
    }, 250);
  }
}

// ---------------------------------------------------------------------------
// 設定頁試聽
// ---------------------------------------------------------------------------

let engDemo: { e: EngineSound; id: number } | undefined;
let wpnDemo: { w: WeaponSfx; id: number } | undefined;

function stopEngDemo(): void {
  if (!engDemo) return;
  clearInterval(engDemo.id);
  engDemo.e.dispose();
  engDemo = undefined;
}
function stopWpnDemo(): void {
  if (!wpnDemo) return;
  clearInterval(wpnDemo.id);
  wpnDemo.w.dispose();
  wpnDemo = undefined;
}

/** 試聽引擎：怠速 → 全油門加速（後段開加速）→ 收油 → 減速，約 2.5 秒 */
export function previewEngine(ctx: AudioContext, out: AudioNode, s: EngineStyle): void {
  stopEngDemo();
  const e = new EngineSound(ctx, out);
  e.setStyle(s);
  const p0 = performance.now();
  const step = (): void => {
    const x = (performance.now() - p0) / 1000;
    if (x > 2.6) {
      if (engDemo?.e === e) stopEngDemo();
      return;
    }
    let rpm = 0, thr = 0;
    if (x >= 0.3 && x < 1.45) {
      const k = (x - 0.3) / 1.15;
      rpm = 1.15 * (1 - (1 - k) * (1 - k));
      thr = 1;
    } else if (x >= 1.45) {
      const k = Math.min(1, (x - 1.45) / 0.9);
      rpm = 1.15 * (1 - k) + 0.08 * k;
    }
    const vol = x > 2.25 ? Math.max(0, 1 - (x - 2.25) / 0.3) : 1;
    e.update(rpm, thr, x > 1.05 && x < 1.45, false, false, vol);
  };
  engDemo = { e, id: window.setInterval(step, 16) };
  step();
}

/** 試聽武器：機槍連發 → 火箭發射＋爆炸 → 雷射蓄力＋射出 */
export function previewWeapons(ctx: AudioContext, out: AudioNode, p: WeaponPack): void {
  stopWpnDemo();
  const w = new WeaponSfx(ctx, out);
  w.setPack(p);
  const p0 = performance.now();
  const ev: [number, () => void][] = [];
  for (let i = 0; i < 7; i++) ev.push([i * 0.111, () => w.shot('mg', 1)]);
  ev.push([0.85, () => w.launch('rocket', 1)]);
  ev.push([1.35, () => w.blast(0.9, false)]);
  ev.push([2.65, () => w.rail(1)]);
  let next = 0;
  const end = p === 'heavy' ? 5.6 : 3.8;
  const step = (): void => {
    const x = (performance.now() - p0) / 1000;
    while (next < ev.length && ev[next][0] <= x) ev[next++][1]();
    w.laserCharge(x >= 2.0 && x < 2.65 ? Math.min(1, (x - 2.0) / 0.6) : 0, 1);
    if (x > end && wpnDemo?.w === w) stopWpnDemo();
  };
  wpnDemo = { w, id: window.setInterval(step, 16) };
  step();
}
