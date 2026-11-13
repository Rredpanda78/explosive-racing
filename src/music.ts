// 程序化配樂引擎：全部用 WebAudio 即時合成，不需要任何音檔
// 五種比賽風格＋選單主題，各自有不同的調性、速度、律動、音色與曲式（前奏 → A → B → 副歌 → 間奏…）
import { localize } from './i18n';

/** 比賽配樂的風格 */
export type MusicStyle = 'synth' | 'lofi' | 'hiphop' | 'metal' | 'chip';
export const MUSIC_STYLES: { id: MusicStyle; name: string }[] = [
  { id: 'synth', name: '電音' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'hiphop', name: '嘻哈' },
  { id: 'metal', name: '金屬' },
  { id: 'chip', name: '8-bit' },
];
// 英文名稱（Lo-fi、8-bit 兩邊一樣）
const EN_MUSIC: Partial<Record<MusicStyle, string>> = { synth: 'Electro', hiphop: 'Hip-Hop', metal: 'Metal' };
for (const m of MUSIC_STYLES) if (EN_MUSIC[m.id]) localize(m, { name: EN_MUSIC[m.id] });

type Mode = 'off' | 'menu' | 'race';
type Key = MusicStyle | 'menu';
type Sec = 'I' | 'A' | 'B' | 'C' | 'D'; // 前奏、A 段、B 段、副歌、間奏
type Wave = OscillatorType | PeriodicWave;

const LOOK = 0.15; // 預排秒數
const CAP = 48; // 同時發聲的振盪器上限（顧及手機效能）
const R = -99; // 低音表裡的休止

const mod = (a: number, m: number): number => ((a % m) + m) % m;
const mtof = (n: number): number => 440 * Math.pow(2, (n - 69) / 12);
const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const acc = (s?: string): number => (s === '#' ? 1 : s === 'b' ? -1 : 0);

/** 音名轉 MIDI：c#5、bb4、e#5 */
function nn(s: string): number {
  const m = /^([a-g])(#|b)?(\d)$/.exec(s);
  if (!m) throw new Error('音名錯誤：' + s);
  return PC[m[1]] + acc(m[2]) + (Number(m[3]) + 1) * 12;
}

type Note = { n: number; l: number }; // 音高與長度（16 分格）
type Pat = (Note | undefined)[]; // 以段落內 16 分格為索引

/** 旋律字串：每個記號佔 res 個 16 分格；'-' 延長、'.' 休止、'|' 只是小節線 */
function pat(src: string, res = 2): Pat {
  const out: Pat = [];
  let last: Note | undefined;
  for (const tok of src.trim().split(/\s+/)) {
    if (tok === '|') continue;
    const i = out.length;
    for (let k = 0; k < res; k++) out.push(undefined);
    if (tok === '-') { if (last) last.l += res; }
    else if (tok === '.') last = undefined;
    else out[i] = last = { n: nn(tok), l: res };
  }
  return out;
}

type Chord = { r: number; iv: number[] }; // 根音音級＋音程
const QUAL: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], sus: [0, 5, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11],
  m9: [0, 3, 7, 10, 14], M9: [0, 4, 7, 11, 14], '9': [0, 4, 7, 10, 14], '13': [0, 4, 10, 14, 21], '7b9': [0, 4, 7, 10, 13],
};
/** 和弦字串：'F#m D E C#7b9' */
function prog(src: string): Chord[] {
  return src.trim().split(/\s+/).map((tok) => {
    const m = /^([A-G])(#|b)?(.*)$/.exec(tok);
    if (!m || !QUAL[m[3]]) throw new Error('和弦錯誤：' + tok);
    return { r: mod(PC[m[1].toLowerCase()] + acc(m[2]), 12), iv: QUAL[m[3]] };
  });
}
/** 不低於 lo 的根音 */
const rootAt = (c: Chord, lo: number): number => lo + mod(c.r - lo, 12);
/** 和弦排列：四音以上去掉根音、三度堆疊，挑最接近 center 且少小二度的轉位 */
function voice(c: Chord, center: number, rootless = true): number[] {
  const iv = rootless && c.iv.length > 3 ? c.iv.slice(1) : c.iv;
  let best: number[] = [];
  let score = 1e9;
  for (let j = 0; j < iv.length; j++) {
    const out: number[] = [];
    let p = center - 7;
    for (let q = 0; q < iv.length; q++) {
      const pc = mod(c.r + iv[(j + q) % iv.length], 12);
      p = q === 0 ? p + mod(pc - p, 12) : p + 1 + mod(pc - p - 1, 12);
      out.push(p);
    }
    let sc = Math.abs(out.reduce((a, x) => a + x, 0) / out.length - center);
    for (let q = 1; q < out.length; q++) if (out[q] - out[q - 1] === 1) sc += 4;
    if (sc < score) { score = sc; best = out; }
  }
  return best;
}
/** 濾波器掃頻改成每 128 取樣更新一次係數（逐取樣重算很吃 CPU；不支援的瀏覽器維持 a-rate） */
function krate(p: AudioParam): void {
  try { p.automationRate = 'k-rate'; } catch { /* 略過 */ }
}
/** 音階內往下三度（和聲用） */
const third = (n: number, sc: number[]): number => (sc.includes(mod(n - 3, 12)) ? n - 3 : n - 4);
const D_NAT = [2, 4, 5, 7, 9, 10, 0], D_HARM = [2, 4, 5, 7, 9, 10, 1], A_MAJ = [9, 11, 1, 2, 4, 6, 8]; // D 自然／和聲小音階、A 大調

// ---- 節奏表 ----
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
const SYN_STAB = 'x..x..x...x.x...';
// 808：x 根音、5 五度、o 高八度；大寫 = 從上一顆滑過來
const P808 = ['x.....x...x.....', 'x.....x..x...O..', 'x......x..x.5...', 'x.....x...x..O.X', 'x.......O.......'];
// 踩鈸：1 單擊、3 三連音、4 32 分連打
const HATS = ['1.1.1.1.1.1.1.1.', '1.1.1.1.1.1.3.1.', '1.1.1.111.1.1.11', '1.1.3.1.1.1.4.4.', '1111111111113.4.'];
// 金屬節奏吉他：x 低音 D 悶音、m 和弦根音悶音、o 開放強力和弦、- 延長、. 止音
const RIFF: Record<Sec, string[]> = {
  I: ['o---------------', 'o---------------', 'o---------------', 'o-------o---o-o-'],
  A: ['o.xxx.xxx.xxx.xx', 'x.xxx.xxo---o---', 'o.xxx.xxx.xxx.xx', 'x.xxx.xxx.xxo-o-'],
  B: ['mmmmmmmmmmmmmmmm', 'mmmmmmmmo---o---'],
  C: ['o-------o-------', 'o-------o---xxxx'],
  D: ['x..x..x...x.x...', 'x..x..x...x.x...', 'x..x..x.x..x..x.', 'o---------------'],
};
const CHIP_KICK: Record<Sec, string> = { I: 'x.......x.......', A: 'x.....x.x.......', B: 'x.........x.....', C: 'x.....x.x.....x.', D: 'x.......x.......' };
const CHIP_BASS: Record<Sec, number[]> = {
  I: [0, R, 0, R, 0, R, 7, 12],
  A: [0, 12, 0, 12, 0, 12, 0, 12],
  B: [0, R, 7, 0, 12, 0, 7, 0],
  C: [0, 12, 7, 12, 0, 12, 7, 12],
  D: [0, R, R, R, 0, R, R, R],
};

interface Def {
  bpm: number; rushT: number; lift: number; swing: number; // 速度、最後一圈加速倍率與升調、搖擺
  form: [Sec, number][]; loop: number; // 曲式與循環回到的段落
  level: number; rev: number; dly: number; beats: number; fb: number; tone: number; // 混音
  prog: Partial<Record<Sec, Chord[]>>;
  mel: Partial<Record<Sec, Pat>>;
}

const DEFS: Record<Key, Def> = {
  // F# 小調，副歌是 VI–VII–i 的英雄式進行
  synth: {
    bpm: 155, rushT: 1.08, lift: 1, swing: 0, loop: 1,
    form: [['I', 4], ['A', 8], ['B', 8], ['C', 8], ['D', 4], ['B', 8], ['C', 8]],
    level: 0.8, rev: 0.5, dly: 0.45, beats: 0.75, fb: 0.35, tone: 18000,
    prog: { I: prog('F#m F#m D E'), A: prog('F#m D E F#m F#m D E C#'), B: prog('Bm C#m D E Bm C#m D C#'), C: prog('D E F#m A D E C# C#'), D: prog('Bm C#m D E') },
    mel: {
      A: pat(`c#5 - a4 - f#4 - a4 b4 | a4 - d5 - f#5 - e5 d5 | e5 - - b4 - - g#4 b4 | c#5 - - - - - . . |
              c#5 - a4 - f#4 - a4 c#5 | f#5 - - e5 - - d5 - | e5 - - b4 - - e5 g#5 | e#5 - - - g#5 - - -`),
      C: pat(`f#5 - - - a5 - - f#5 | g#5 - - - b5 - - g#5 | a5 - - - c#6 - b5 a5 | e5 - - - - - c#5 e5 |
              f#5 - - - a5 - - d6 | c#6 - - - b5 - - g#5 | g#5 - - - e#5 - - c#5 | g#5 - - - - - . .`),
    },
  },
  // Eb 大調爵士進行（ii–V–I、九和弦、十三和弦）
  lofi: {
    bpm: 76, rushT: 1.1, lift: 2, swing: 0.3, loop: 1,
    form: [['I', 4], ['A', 8], ['C', 8], ['B', 8], ['D', 4], ['C', 8]],
    level: 1.2, rev: 0.6, dly: 0.4, beats: 0.75, fb: 0.3, tone: 3400,
    prog: {
      I: prog('Fm9 Bb13 EbM9 C7b9'), A: prog('Fm9 Bb13 EbM9 Cm9 Fm9 Bb13 EbM9 C7b9'), B: prog('AbM9 Db9 Gm7 C7b9 Fm9 Bb13 EbM9 EbM9'),
      C: prog('AbM9 Bb13 Gm7 Cm9 AbM9 Bb13 EbM9 C7b9'), D: prog('Fm9 Fm9 Bb13 Bb13'),
    },
    mel: {
      A: pat(`. . c5 - eb5 - g5 - | f5 - - - d5 - . . | . . bb4 - d5 - f5 - | eb5 - - - - - . . |
              . . c5 - eb5 - ab5 - | g5 - f5 - d5 - c5 - | bb4 - - - . . g4 bb4 | db5 - - - bb4 - g4 -`),
      C: pat(`eb5 - c5 - g5 - - - | f5 - - - d5 - c5 - | bb4 - d5 - f5 - - - | eb5 - d5 - - - . . |
              c5 - eb5 - bb5 - - - | ab5 - - - g5 - f5 - | g5 - - - - - f5 d5 | e5 - - - db5 - - -`),
    },
  },
  // G 小調（含 bII 的 Ab），140 BPM 半拍感 trap
  hiphop: {
    bpm: 140, rushT: 1.07, lift: 1, swing: 0, loop: 1,
    form: [['I', 4], ['A', 8], ['C', 8], ['B', 8], ['C', 8], ['D', 4]],
    level: 0.9, rev: 0.5, dly: 0.5, beats: 0.75, fb: 0.38, tone: 18000,
    prog: { I: prog('Gm Ab Eb D'), A: prog('Gm Gm Eb D Gm Gm Cm D'), B: prog('Eb Eb Cm Cm Ab Ab D D'), C: prog('Gm Ab Eb D Gm Ab Cm D'), D: prog('Gm Gm Ab D') },
    mel: {
      A: pat(`d5 . . bb4 . . g4 . | a4 . bb4 . . . . . | d5 . . bb4 . . g4 . | f#4 . a4 . . . . . |
              d5 . . bb4 . . g4 . | a4 . bb4 . d5 . . . | eb5 . . c5 . . g4 . | f#4 . a4 . c5 . a4 .`),
      C: pat(`g5 . d5 . bb5 - a5 . | g5 . eb5 . c5 - - . | g5 . d5 . bb5 - c6 . | a5 - - . f#5 - d5 . |
              g5 . d5 . bb5 - a5 . | g5 . eb5 . c6 - bb5 . | g5 . eb5 . c5 - d5 . | f#5 - - - . . . .`),
    },
  },
  // Drop D、D 小調（弗里吉亞的 Eb），副歌主奏三度和聲
  metal: {
    bpm: 184, rushT: 1.08, lift: 1, swing: 0, loop: 1,
    form: [['I', 4], ['A', 8], ['B', 8], ['C', 8], ['D', 4], ['A', 8], ['C', 8]],
    level: 0.75, rev: 0.4, dly: 0.35, beats: 0.5, fb: 0.25, tone: 15000,
    prog: { I: prog('D Bb C A'), A: prog('D D F Eb D D Bb A'), B: prog('Bb C D D Bb C A A'), C: prog('D Bb F C D Bb C A'), D: prog('D D D Eb') },
    mel: {
      C: pat(`d5 - - - f5 - e5 - | d5 - - - bb4 - c5 - | f5 - - - a5 - g5 - | e5 - - - - - c5 - |
              d5 - - - f5 - a5 - | bb5 - - - a5 - f5 - | g5 - - - e5 - c5 - | c#5 - - - e5 - - -`),
    },
  },
  // A 大調，B 段轉同主音小調（A 小調）
  chip: {
    bpm: 160, rushT: 1.12, lift: 2, swing: 0, loop: 1,
    form: [['I', 4], ['A', 8], ['C', 8], ['B', 8], ['C', 8], ['D', 4]],
    level: 0.72, rev: 0.25, dly: 0.35, beats: 0.75, fb: 0.25, tone: 16000,
    prog: { I: prog('A E F#m D'), A: prog('A E F#m D A E D E'), B: prog('Am F G E Am F Dm E'), C: prog('D E C#m F#m D E A A'), D: prog('F#m D E E') },
    mel: {
      A: pat(`e5 - c#5 - a4 - c#5 e5 | g#5 - f#5 - e5 - b4 - | a5 - f#5 - c#5 - f#5 a5 | f#5 - - - e5 - d5 - |
              c#5 - e5 - a5 - g#5 a5 | b5 - g#5 - e5 - g#5 b5 | a5 - f#5 - d5 - f#5 a5 | g#5 - - - b5 - - -`),
      B: pat(`a4 - c5 - e5 - - - | f5 - e5 - c5 - a4 - | b4 - d5 - g5 - - - | g#5 - - - e5 - - - |
              e5 - a5 - c6 - b5 a5 | c6 - - - a5 - f5 - | f5 - a5 - d6 - c6 - | b5 - - - g#5 - e5 -`),
      C: pat(`f#5 - a5 - d6 - c#6 - | b5 - - - g#5 - e5 - | e5 - g#5 - c#6 - b5 - | a5 - - - f#5 - - - |
              f#5 - a5 - d6 - e6 - | e6 - - - d6 - b5 - | c#6 - - - a5 - c#6 - | a5 - - - - - . .`),
    },
  },
  // 選單：F 大調 94 BPM，平靜
  menu: {
    bpm: 94, rushT: 1, lift: 0, swing: 0, loop: 1,
    form: [['I', 4], ['A', 8], ['B', 8]],
    level: 0.85, rev: 0.7, dly: 0.45, beats: 0.75, fb: 0.4, tone: 9000,
    prog: { I: prog('FM7 Am7 BbM7 C'), A: prog('FM7 Am7 BbM7 C FM7 Am7 Gm7 Csus'), B: prog('Dm7 Am7 BbM9 F Dm7 Am7 Gm7 Csus') },
    mel: {
      A: pat(`. . a4 - c5 - e5 - | g5 - - - e5 - - - | f5 - d5 - a4 - - - | g4 - - - . . . . |
              . . a4 - c5 - f5 - | e5 - - - c5 - - - | d5 - bb4 - f5 - - - | f5 - - - e5 - - -`),
      B: pat(`a5 - - - f5 - - - | e5 - - - c5 - - - | d5 - c5 - d5 - f5 - | c5 - - - - - . . |
              a5 - - - c6 - - - | g5 - - - e5 - - - | f5 - d5 - bb4 - d5 - | c5 - - - - - . .`),
    },
  },
};

/** 一次播放（換風格／模式就換一組），結束時整組淡出並斷線 */
interface Sess {
  dry: GainNode; rev: GainNode; dly: GainNode; pump: GainNode;
  ch: Record<string, AudioNode>;
  nodes: AudioNode[];
  srcs: AudioScheduledSourceNode[];
}
/** 音軌設定：送殘響／回音量、聲像、側鏈抽吸、失真、濾波、顫音 */
interface ChOpt { rev?: number; dly?: number; pan?: number; pump?: boolean; drive?: number; out?: number; hp?: number; lp?: number; trem?: number }
/** 合成音的選項 */
interface VO {
  a?: number; r?: number; dec?: number; sus?: number; // 包絡
  cut?: number; q?: number; env?: number; fd?: number; // 低通（env = 起始倍數、fd = 回落時間）
  det?: number[]; // 每個振盪器的失諧（音分）
  from?: number; gl?: number; // 滑音
  vib?: number; vibR?: number; vibD?: number; // 顫音深度（音分）、速度、延遲
  arp?: number[]; ar?: number; // 快速琶音（頻率表、切換間隔）
  wob?: boolean; // 錄音帶抖動
  must?: boolean; // 不受複音上限限制
}
interface FO { ratio: number; i0: number; i1: number; it?: number; a?: number; dec?: number; sus?: number; r?: number; wob?: boolean }
interface NO { buf?: AudioBuffer; rate?: number; a?: number; f2?: number }
/** 每個 16 分格交給風格函式的資訊 */
interface Beat {
  t: number; d: number; s: number; bar: number; i: number; len: number;
  sec: Sec; next: Sec; last: boolean; c: Chord; k: number; rush: boolean; hit: boolean;
}

export class MusicEngine {
  private readonly ctx: AudioContext;
  private readonly mix: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly level: GainNode;
  private readonly verbIn: BiquadFilterNode;
  private readonly verbRet: GainNode;
  private readonly dl: DelayNode;
  private readonly dlFb: GainNode;
  private readonly dlRet: GainNode;
  private readonly shared: AudioNode[];
  private readonly noise: AudioBuffer;
  private readonly nesL: AudioBuffer;
  private readonly nesS: AudioBuffer;
  private readonly dust: AudioBuffer;
  private readonly pw: PeriodicWave[];
  private readonly triW: PeriodicWave;

  private mode: Mode = 'off';
  private style: MusicStyle = 'synth';
  private def: Def = DEFS.synth;
  private S?: Sess;
  private rushWant = false; // 外部要求的最後一圈狀態（下一小節才生效）
  private rush = false;
  private hit = false; // 剛進入最後一圈：敲一下鈸
  private nextT = 0; // 下一個 16 分格的音訊時間
  private si = 0; // 曲式中的段落、段落內小節、小節內 16 分格
  private bar = 0;
  private s = 0;
  private live: number[] = []; // 發聲中振盪器的結束時間
  private lead = { f: 0, end: 0 }; // 上一個主旋律音（滑音用）
  private b8?: { g: GainNode; f: number; rt: number }; // 上一顆 808
  private disposed = false;
  private readonly B: Beat = {
    t: 0, d: 0.1, s: 0, bar: 0, i: 0, len: 1, sec: 'I', next: 'A', last: false, c: { r: 0, iv: [0, 4, 7] }, k: 0, rush: false, hit: false,
  };

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    // 總線：混音 → 風格濾波（lo-fi 用）→ 去超低頻 → 風格音量 → 外部音樂總線
    this.mix = this.gain(1);
    this.tone = this.filt('lowpass', 18000, 0.5);
    krate(this.tone.frequency);
    const hp = this.filt('highpass', 30);
    this.level = this.gain(0.9);
    this.mix.connect(this.tone).connect(hp).connect(this.level).connect(out);
    // 共用殘響：產生的衰減噪音脈衝響應
    this.verbIn = this.filt('highpass', 240);
    const verb = ctx.createConvolver();
    verb.buffer = this.mkBuf(1.8, 2, (i, n) => (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2));
    this.verbRet = this.gain(0.5);
    this.verbIn.connect(verb).connect(this.verbRet).connect(this.mix);
    // 共用回音：與節拍同步，回授逐次變暗
    this.dl = ctx.createDelay(2);
    const dlp = this.filt('lowpass', 2600);
    this.dlFb = this.gain(0.35);
    this.dlRet = this.gain(0.4);
    this.dl.connect(dlp).connect(this.dlFb).connect(this.dl);
    dlp.connect(this.dlRet).connect(this.mix);
    this.shared = [this.mix, this.tone, hp, this.level, this.verbIn, verb, this.verbRet, this.dl, dlp, this.dlFb, this.dlRet];
    // 音源素材：白噪音、NES 雜訊（長／短模式）、黑膠底噪、脈衝波與 4-bit 三角波
    this.noise = this.mkBuf(1, 1, () => Math.random() * 2 - 1);
    this.nesL = this.nes(1);
    this.nesS = this.nes(6);
    let pop = 0;
    this.dust = this.mkBuf(3.7, 1, () => {
      pop = Math.random() < 0.00025 ? (Math.random() - 0.5) * 0.8 : pop * 0.8;
      return pop + (Math.random() * 2 - 1) * 0.02;
    });
    this.pw = [0.125, 0.25, 0.5].map((w) => this.wave((p) => (p < w ? 1 : -1)));
    this.triW = this.wave((p) => {
      const q = Math.floor(p * 32);
      return (q < 16 ? q : 31 - q) / 7.5 - 1;
    });
  }

  /** 'off' 停止；'menu' 選單主題；'race' 播選定的風格 */
  setMode(mode: Mode): void {
    if (mode === this.mode || this.disposed) return;
    this.mode = mode;
    this.restart();
  }

  /** 換風格；比賽中立刻從前奏重新開始（選單只換主旋律音色） */
  setStyle(style: MusicStyle): void {
    if (style === this.style) return;
    this.style = style;
    if (this.mode === 'race') this.restart();
  }

  /** 最後一圈：加速、升調、多一層打擊（從下一小節開始） */
  setRush(on: boolean): void {
    this.rushWant = on;
  }

  /** 定期呼叫（25–30 ms）；以音訊時鐘預排 LOOK 秒 */
  tick(): void {
    if (!this.S || this.disposed) return;
    const now = this.ctx.currentTime;
    if (this.nextT < now - 0.25) this.nextT = now + 0.05; // 分頁暫停後重新對齊
    for (let n = 0; this.nextT < now + LOOK && n < 32; n++) {
      this.play();
      this.nextT += this.stepDur();
      this.advance();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mode = 'off';
    this.teardown();
    this.level.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    const nodes = this.shared;
    setTimeout(() => nodes.forEach((n) => n.disconnect()), 600);
  }

  // ------------------------------------------------------------------
  // 排程
  // ------------------------------------------------------------------

  private stepDur(): number {
    return 60 / (this.def.bpm * (this.rush ? this.def.rushT : 1)) / 4;
  }

  private restart(): void {
    this.teardown();
    if (this.mode === 'off' || this.disposed) return;
    const key: Key = this.mode === 'menu' ? 'menu' : this.style;
    const def = (this.def = DEFS[key]);
    const now = this.ctx.currentTime;
    const g = (): GainNode => this.gain(1);
    const S: Sess = { dry: g(), rev: g(), dly: g(), pump: g(), ch: {}, nodes: [], srcs: [] };
    S.dry.connect(this.mix);
    S.rev.connect(this.verbIn);
    S.dly.connect(this.dl);
    S.pump.connect(S.dry);
    S.nodes.push(S.dry, S.rev, S.dly, S.pump);
    this.S = S;
    this.si = this.bar = this.s = 0;
    this.rush = this.hit = false;
    this.b8 = undefined;
    this.lead = { f: 0, end: 0 };
    this.nextT = now + 0.06;
    const set = (p: AudioParam, v: number): void => {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(v, now, 0.03);
    };
    set(this.tone.frequency, def.tone);
    set(this.level.gain, def.level);
    set(this.verbRet.gain, def.rev);
    set(this.dlRet.gain, def.dly);
    set(this.dlFb.gain, def.fb);
    this.syncDelay(now);
    this.setup(key);
  }

  /** 舊的一組淡出，0.5 秒後停止並斷線（已排好的音符會自己結束） */
  private teardown(): void {
    const S = this.S;
    if (!S) return;
    this.S = undefined;
    const now = this.ctx.currentTime;
    for (const n of [S.dry, S.rev, S.dly]) {
      n.gain.cancelScheduledValues(now);
      n.gain.setTargetAtTime(0, now, 0.04);
    }
    setTimeout(() => {
      for (const s of S.srcs) s.stop(); // 都是已經 start 過的循環音源
      for (const n of S.nodes) n.disconnect();
    }, 500);
  }

  private syncDelay(t: number): void {
    this.dl.delayTime.setTargetAtTime(Math.min(1.9, this.def.beats * 4 * this.stepDur()), t, 0.05);
  }

  private play(): void {
    const def = this.def;
    const [sec, len] = def.form[this.si];
    if (this.s === 0) {
      // 最後一圈的變化只在小節開頭生效
      const want = this.mode === 'race' && this.rushWant;
      if (want !== this.rush) {
        this.rush = want;
        this.hit = want;
        this.syncDelay(this.nextT);
      }
    }
    const b = this.B;
    const d = this.stepDur();
    const list = def.prog[sec] ?? def.prog.A!;
    // 重複使用同一個物件，避免每格配置
    b.d = d; b.s = this.s; b.bar = this.bar; b.i = this.bar * 16 + this.s; b.len = len; b.sec = sec;
    b.next = def.form[this.si + 1 < def.form.length ? this.si + 1 : def.loop][0];
    b.last = this.bar === len - 1; b.c = list[this.bar % list.length];
    b.rush = this.rush; b.k = this.rush ? def.lift : 0; b.hit = this.hit && this.s === 0;
    b.t = this.nextT + (this.s % 2 ? def.swing * d : 0); // 搖擺：奇數格往後推
    this.hit = false;
    switch (this.mode === 'menu' ? 'menu' : this.style) {
      case 'menu': return this.menu(b);
      case 'lofi': return this.lofi(b);
      case 'hiphop': return this.hiphop(b);
      case 'metal': return this.metal(b);
      case 'chip': return this.chip(b);
      default: return this.synth(b);
    }
  }

  private advance(): void {
    if (++this.s < 16) return;
    this.s = 0;
    if (++this.bar < this.def.form[this.si][1]) return;
    this.bar = 0;
    if (++this.si >= this.def.form.length) this.si = this.def.loop;
  }

  private mel(b: Beat): Note | undefined {
    return this.def.mel[b.sec]?.[b.i];
  }

  // ------------------------------------------------------------------
  // 素材與音軌
  // ------------------------------------------------------------------

  private gain(v: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  private filt(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  private mkBuf(sec: number, chans: number, fn: (i: number, n: number) => number): AudioBuffer {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * sec), buf = this.ctx.createBuffer(chans, n, sr);
    for (let c = 0; c < chans; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = fn(i, n); }
    return buf;
  }

  /** NES 雜訊通道的 15 位元移位暫存器（tap 1 = 長模式、6 = 金屬感短模式） */
  private nes(tap: number): AudioBuffer {
    let reg = 1;
    return this.mkBuf(1, 1, () => {
      const fb = (reg ^ (reg >> tap)) & 1;
      reg = (reg >> 1) | (fb << 14);
      return reg & 1 ? 0.7 : -0.7;
    });
  }

  /** 由取樣波形算出 PeriodicWave（脈衝波工作週期、4-bit 三角波） */
  private wave(fn: (p: number) => number): PeriodicWave {
    const N = 64, M = 256, re = new Float32Array(N), im = new Float32Array(N);
    for (let j = 0; j < M; j++) {
      const p = j / M, x = fn(p);
      for (let h = 1; h < N; h++) { re[h] += (2 * x * Math.cos(2 * Math.PI * h * p)) / M; im[h] += (2 * x * Math.sin(2 * Math.PI * h * p)) / M; }
    }
    return this.ctx.createPeriodicWave(re, im);
  }

  /** 失真曲線（tanh 軟削波，k 越大越硬） */
  private curve(k: number) {
    const n = 1024, c = new Float32Array(n), m = Math.tanh(k);
    for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * k) / m;
    return c;
  }

  /** 建一條音軌：輸入 → [失真 → 高通 → 音箱低通 → 輸出量] → [顫音] → [聲像] → 乾聲／抽吸，另有殘響與回音傳送 */
  private mk(name: string, gain: number, o: ChOpt = {}): void {
    const S = this.S!;
    const ctx = this.ctx;
    const inp = this.gain(gain);
    S.nodes.push(inp);
    let tail: AudioNode = inp;
    const add = <T extends AudioNode>(n: T): T => {
      S.nodes.push(n);
      tail = tail.connect(n);
      return n;
    };
    if (o.drive) {
      const sh = add(ctx.createWaveShaper());
      sh.curve = this.curve(o.drive);
      sh.oversample = o.drive > 6 ? '2x' : 'none'; // 只有重失真才需要防混疊
    }
    if (o.hp) add(this.filt('highpass', o.hp));
    if (o.lp) add(this.filt('lowpass', o.lp, 0.9));
    if (o.out !== undefined) add(this.gain(o.out));
    if (o.trem) {
      const tg = add(this.gain(0.85));
      const lfo = ctx.createOscillator();
      const lg = this.gain(0.15);
      lfo.frequency.value = o.trem;
      lfo.connect(lg).connect(tg.gain);
      lfo.start();
      S.srcs.push(lfo);
      S.nodes.push(lfo, lg);
    }
    if (o.pan && ctx.createStereoPanner) add(ctx.createStereoPanner()).pan.value = o.pan;
    tail.connect(o.pump ? S.pump : S.dry);
    for (const [amt, dest] of [[o.rev, S.rev], [o.dly, S.dly]] as [number | undefined, GainNode][]) {
      if (!amt) continue;
      const sg = this.gain(amt);
      tail.connect(sg).connect(dest);
      S.nodes.push(sg);
    }
    S.ch[name] = inp;
  }

  /** 各風格的音軌與底噪 */
  private setup(key: Key): void {
    const m = (n: string, g: number, o?: ChOpt): void => this.mk(n, g, o);
    switch (key) {
      case 'synth':
        m('kick', 1); m('drum', 0.9, { rev: 0.2 }); m('hat', 0.6, { pan: 0.15 }); m('cym', 0.5, { rev: 0.25, pan: -0.2 });
        m('bass', 0.9, { pump: true }); m('pad', 0.9, { pump: true, rev: 0.3 }); m('arp', 0.7, { pan: 0.35, dly: 0.4, rev: 0.15 });
        m('lead', 0.85, { dly: 0.28, rev: 0.25, pan: -0.08 }); m('fx', 0.5, { rev: 0.5 });
        break;
      case 'lofi': {
        m('kick', 1, { lp: 900 }); m('drum', 0.9, { lp: 3000, rev: 0.25 }); m('hat', 0.7, { pan: -0.2 });
        m('keys', 1, { trem: 4.2, rev: 0.35, pan: 0.1 }); m('bass', 0.75); m('lead', 0.8, { rev: 0.35, dly: 0.25, pan: -0.15 });
        m('pluck', 0.8, { pan: 0.35, dly: 0.3, rev: 0.3 }); m('bed', 0.35);
        const src = this.ctx.createBufferSource();
        src.buffer = this.dust;
        src.loop = true;
        src.connect(this.S!.ch.bed);
        src.start(this.nextT);
        this.S!.srcs.push(src);
        this.S!.nodes.push(src);
        break;
      }
      case 'hiphop':
        m('kick', 1); m('808', 1, { drive: 2.5, out: 0.25 }); m('drum', 0.9, { rev: 0.25 }); m('hat', 0.75, { pan: 0.2 });
        m('fx', 0.6, { rev: 0.4 }); m('pad', 0.8, { rev: 0.5 }); m('bell', 0.9, { dly: 0.35, rev: 0.35, pan: -0.15 });
        m('pluck', 0.8, { dly: 0.3, rev: 0.2, pan: 0.3 });
        break;
      case 'metal':
        m('kick', 1); m('drum', 0.9, { rev: 0.22 }); m('hat', 0.5, { pan: 0.25 }); m('cym', 0.55, { rev: 0.15, pan: -0.15 });
        m('gL', 1, { drive: 10, hp: 110, lp: 4200, out: 0.17, pan: -0.6 }); m('gR', 1, { drive: 10, hp: 110, lp: 4200, out: 0.17, pan: 0.6 });
        m('bass', 1, { drive: 2, lp: 900, out: 0.5 });
        m('ldA', 1, { drive: 5, lp: 3800, out: 0.12, pan: -0.25, dly: 0.3, rev: 0.3 }); m('ldB', 1, { drive: 5, lp: 3800, out: 0.11, pan: 0.25, dly: 0.3, rev: 0.3 });
        break;
      case 'chip':
        m('p1', 1, { pan: -0.1, rev: 0.05 }); m('p2', 1, { pan: 0.2, rev: 0.05 }); m('tri', 1); m('noise', 1);
        break;
      default:
        m('pad', 1, { rev: 0.5 }); m('bass', 1); m('kick', 1); m('hat', 0.6, { pan: 0.25 }); m('drum', 0.8, { rev: 0.3 });
        m('lead', 1, { rev: 0.4, dly: 0.3 }); m('spark', 1, { dly: 0.5, rev: 0.5, pan: 0.3 });
    }
  }

  // ------------------------------------------------------------------
  // 樂器
  // ------------------------------------------------------------------

  /** 複音上限：記錄每個振盪器的結束時間，滿了就略過非必要的音 */
  private room(end: number, n: number, must = false): boolean {
    const now = this.ctx.currentTime;
    const L = this.live;
    let j = 0;
    for (let i = 0; i < L.length; i++) if (L[i] > now) L[j++] = L[i];
    L.length = j;
    if (!must && j + n > CAP) return false;
    for (let i = 0; i < n; i++) L.push(end);
    return true;
  }

  /** 包絡：0 → vol（a 秒）→ 以 dec 衰減到 vol*sus → rt 起線性釋放到 end（無爆音） */
  private env(p: AudioParam, t: number, a: number, vol: number, dec: number, sus: number, rt: number, end: number): void {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(vol, t + a);
    let h = vol;
    if (dec > 0) {
      const sv = vol * sus;
      p.setTargetAtTime(sv, t + a, dec);
      h = sv + (vol - sv) * Math.exp(-(rt - t - a) / dec);
    }
    p.setValueAtTime(h, rt);
    p.linearRampToValueAtTime(0, end);
  }

  private osc(w: Wave): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof w === 'string') o.type = w as OscillatorType;
    else o.setPeriodicWave(w);
    return o;
  }

  private out(ch: string): AudioNode {
    return this.S!.ch[ch] ?? this.S!.dry;
  }

  /** 音源結束後把這個音的節點斷開，避免音訊圖越積越大 */
  private done(src: AudioScheduledSourceNode, nodes: (AudioNode | undefined)[]): void {
    src.onended = () => {
      for (const n of nodes) n?.disconnect();
    };
  }

  /** 通用合成音：f 可以是一個和弦（共用同一個濾波器與包絡）；每個音再疊 det 個失諧振盪器 → 低通 → 音量包絡 → 音軌 */
  private v(ch: string, w: Wave, f: number | number[], t: number, dur: number, vol: number, o: VO = {}): void {
    const det = o.det ?? [0];
    const fs = typeof f === 'number' ? [f] : f;
    const a = o.a ?? 0.004;
    const rt = t + Math.max(dur, a);
    const end = rt + (o.r ?? 0.04);
    if (!this.S || !this.room(end, fs.length * det.length + (o.vib ? 1 : 0), o.must)) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g.gain, t, a, vol, o.dec ?? 0, o.sus ?? 0, rt, end);
    g.connect(this.out(ch));
    let head: AudioNode = g;
    let fl: BiquadFilterNode | undefined;
    if (o.cut) {
      fl = this.filt('lowpass', Math.min(o.cut * (o.env ?? 1), 18000), o.q);
      if (o.env) {
        krate(fl.frequency);
        fl.frequency.setTargetAtTime(o.cut, t, o.fd ?? 0.1);
      }
      fl.connect(g);
      head = fl;
    }
    let lg: GainNode | undefined;
    if (o.vib) {
      // 顫音：延遲後才慢慢加深
      const lfo = ctx.createOscillator();
      const vd = t + (o.vibD ?? 0.15);
      lfo.frequency.value = o.vibR ?? 5.5;
      lg = this.gain(0);
      lg.gain.setValueAtTime(0, vd);
      lg.gain.linearRampToValueAtTime(o.vib, vd + 0.2);
      lfo.connect(lg);
      lfo.start(t);
      lfo.stop(end);
    }
    let os: OscillatorNode | undefined;
    for (const fq of fs) {
      for (const dc of det) {
        os = this.osc(w);
        const fr = os.frequency;
        if (o.arp) for (let j = 0, tt = t; tt < end; j++, tt += o.ar ?? 0.033) fr.setValueAtTime(o.arp[j % o.arp.length], tt);
        else if (o.from) { fr.setValueAtTime(o.from, t); fr.exponentialRampToValueAtTime(fq, t + (o.gl ?? 0.06)); }
        else fr.value = fq;
        if (o.wob) this.wobble(os.detune, t, end, dc);
        else os.detune.value = dc;
        if (lg) lg.connect(os.detune);
        os.connect(head);
        os.start(t);
        os.stop(end + 0.01);
      }
    }
    if (os) this.done(os, [g, fl, lg]);
  }

  /** 錄音帶抖動：兩個慢速正弦疊加的音分偏移，寫成音符期間的線性斜坡（不需要額外的 LFO 節點） */
  private wobble(p: AudioParam, t: number, end: number, base = 0): void {
    const w = (x: number): number => base + 11 * Math.sin(x * 1.7) + 5 * Math.sin(x * 4.3 + 1);
    p.setValueAtTime(w(t), t);
    p.linearRampToValueAtTime(w(end), end);
  }

  /** 兩運算子 FM：ratio 1 = 電鋼琴、2 = 柔和撥弦、3.5 = 鐘聲 */
  private fm(ch: string, f: number, t: number, dur: number, vol: number, o: FO): void {
    const a = o.a ?? 0.004;
    const rt = t + Math.max(dur, a);
    const end = rt + (o.r ?? 0.2);
    if (!this.S || !this.room(end, 2)) return;
    const car = this.ctx.createOscillator();
    const md = this.ctx.createOscillator();
    const mg = this.gain(0);
    const g = this.gain(0);
    car.frequency.value = f;
    md.frequency.value = f * o.ratio;
    mg.gain.setValueAtTime(f * o.i0, t);
    mg.gain.setTargetAtTime(f * o.i1, t, o.it ?? 0.2);
    this.env(g.gain, t, a, vol, o.dec ?? 0, o.sus ?? 0, rt, end);
    md.connect(mg).connect(car.frequency);
    car.connect(g).connect(this.out(ch));
    for (const os of [car, md]) {
      if (o.wob) this.wobble(os.detune, t, end);
      os.start(t);
      os.stop(end + 0.01);
    }
    this.done(car, [g, mg]);
  }

  /** 噪音打擊：濾波器（可掃頻）＋包絡；a 較長時是指數上升（噪音上升、反向鈸） */
  private nz(ch: string, t: number, dur: number, vol: number, ft: BiquadFilterType | null, f = 1000, q = 1, o: NO = {}): void {
    const a = o.a ?? 0.001;
    const end = t + a + dur;
    if (!this.S || !this.room(end, 1, true)) return;
    const src = this.ctx.createBufferSource();
    const buf = o.buf ?? this.noise;
    src.buffer = buf;
    src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    const g = this.gain(0);
    const p = g.gain;
    if (a > 0.05) { p.setValueAtTime(vol * 0.003, t); p.exponentialRampToValueAtTime(vol, t + a); }
    else { p.setValueAtTime(0, t); p.linearRampToValueAtTime(vol, t + a); }
    p.exponentialRampToValueAtTime(vol * 0.002, end);
    p.linearRampToValueAtTime(0, end + 0.01);
    let fl: BiquadFilterNode | undefined;
    if (ft) {
      fl = this.filt(ft, f, q);
      if (o.f2) { krate(fl.frequency); fl.frequency.setValueAtTime(f, t); fl.frequency.exponentialRampToValueAtTime(o.f2, end); }
      fl.connect(g);
    }
    g.connect(this.out(ch));
    src.connect(fl ?? g);
    src.start(t, Math.random() * buf.duration * 0.9);
    src.stop(end + 0.02);
    this.done(src, [g, fl]);
  }

  /** 音高下滑的打擊（大鼓、中鼓、小鼓鼓身）；click = 高頻起音 */
  private kick(ch: string, t: number, vol: number, f0: number, f1: number, dec: number, click = 0, w: Wave = 'sine'): void {
    if (!this.S || !this.room(t + dec, 1, true)) return;
    const o = this.osc(w);
    const g = this.gain(0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dec * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(vol * 0.002, t + dec);
    g.gain.linearRampToValueAtTime(0, t + dec + 0.01);
    o.connect(g).connect(this.out(ch));
    o.start(t);
    o.stop(t + dec + 0.02);
    this.done(o, [g]);
    if (click) this.nz(ch, t, 0.012, click, 'highpass', 2500);
  }

  private clap(ch: string, t: number, vol: number, f: number, tail: number): void {
    for (let j = 0; j < 3; j++) this.nz(ch, t + j * 0.01, j < 2 ? 0.01 : tail, vol * (j < 2 ? 0.8 : 1), 'bandpass', f, 1.4);
  }

  /** 側鏈抽吸：大鼓時把 pad／低音壓低再放開 */
  private pump(t: number, depth: number, d: number): void {
    const p = this.S?.pump.gain;
    if (!p) return;
    p.setValueAtTime(1, t);
    p.linearRampToValueAtTime(depth, t + 0.01);
    p.setTargetAtTime(1, t + 0.03, d * 0.7);
  }

  /** 808：單音（新的一顆會切掉舊的）、長尾、可從上一顆滑音 */
  private b808(n: number, t: number, dur: number, glide: boolean): void {
    const end = t + dur + 0.06;
    if (!this.S || !this.room(end, 1, true)) return;
    const f = mtof(n);
    const p = this.b8;
    if (p && p.rt > t) { p.g.gain.cancelScheduledValues(t); p.g.gain.setTargetAtTime(0, t, 0.01); }
    const o = this.ctx.createOscillator();
    const g = this.gain(0);
    o.frequency.setValueAtTime(glide && p ? p.f : f * 2.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t + (glide && p ? 0.1 : 0.04));
    this.env(g.gain, t, 0.003, 0.85, 0.5, 0.35, t + dur, end);
    o.connect(g).connect(this.out('808'));
    o.start(t);
    o.stop(end + 0.01);
    this.done(o, [g]);
    this.b8 = { g, f, rt: t + dur };
  }

  /** 金屬吉他：左右各一軌（雙軌錄音的寬度），強力和弦進失真；悶音 = 失真前先低通 */
  private chug(n: number, t: number, dur: number, open: boolean): void {
    const notes = open ? [n, n + 7, n + 12] : [n, n + 7];
    const fs = notes.map(mtof);
    for (let side = 0; side < 2; side++) {
      this.v(side ? 'gR' : 'gL', 'sawtooth', fs, t + side * 0.006, dur, 0.4, {
        det: [side ? 7 : -7], cut: open ? 3000 : 520, env: open ? 1 : 3, fd: 0.03, q: open ? 0.7 : 2, a: 0.002, r: open ? 0.06 : 0.02, must: true,
      });
    }
    this.v('bass', 'sawtooth', mtof(n - 12), t, dur, 0.3, { cut: open ? 700 : 400, r: 0.03, must: true });
  }

  // ------------------------------------------------------------------
  // 風格
  // ------------------------------------------------------------------

  /** 電音（Eurobeat 風）：F# 小調 155 BPM，四拍大鼓帶抽吸、八度跳低音、超鋸齒和弦、滑音主旋律、副歌前小鼓堆疊＋噪音上升 */
  private synth(b: Beat): void {
    const { t, d, s, sec, bar, c, k, last } = b;
    const build = sec === 'B' && bar >= b.len - 2;
    if (sec === 'I' && bar === 0 && s === 0) { // 前奏：整體低通慢慢打開
      const f = this.tone.frequency;
      f.cancelScheduledValues(t); f.setValueAtTime(500, t); f.exponentialRampToValueAtTime(this.def.tone, t + 60 * d);
    }
    // 鼓：四拍大鼓（同時抽吸）、二四拍小鼓疊拍手；B 段尾巴小鼓由八分加密到 16 分
    if (s % 4 === 0 && sec !== 'D') { this.kick('kick', t, 0.95, 210, 48, 0.3, 0.15); this.pump(t, 0.3, d); }
    if ((s === 4 || s === 12) && sec !== 'I' && sec !== 'D' && !build) {
      this.nz('drum', t, 0.15, 0.32, 'highpass', 1400); this.kick('drum', t, 0.28, 300, 190, 0.07); this.clap('drum', t, 0.26, 1700, 0.13);
    }
    if (build) {
      const n = bar - b.len + 2, u = n * 0.5 + s / 32;
      if (n || s % 2 === 0) this.nz('drum', t, 0.09, 0.1 + u * 0.32, 'bandpass', 1200 + u * 2400, 0.9);
    } else if (last && s >= 12 && sec !== 'I') this.nz('drum', t, 0.09, 0.15 + (s - 12) * 0.06, 'bandpass', 1800, 0.9);
    if (sec !== 'I' || bar >= 2) {
      if (s % 4 === 2) this.nz('hat', t, 0.13, 0.16, 'highpass', 7000);
      else if ((sec === 'C' || b.rush) && s % 2) this.nz('hat', t, 0.025, 0.07, 'highpass', 9500);
    }
    if ((s === 0 && bar === 0 && (sec === 'A' || sec === 'C')) || b.hit) this.nz('cym', t, 1.4, 0.22, 'highpass', 5200, 0.6);
    if (s === 0 && bar === b.len - 2 && sec !== 'A' && sec !== 'C') this.nz('fx', t, 0.08, 0.18, 'bandpass', 300, 2.5, { a: 32 * d, f2: 9000 });
    // 低音：八分音符低高八度交替（間奏改長音）
    const r = rootAt(c, 33) + k;
    if (sec === 'D') {
      if (s === 0) this.v('bass', 'sawtooth', mtof(r), t, 15 * d, 0.2, { cut: 500, a: 0.03, r: 0.1, must: true });
    } else if (s % 2 === 0) this.v('bass', 'sawtooth', mtof(s % 4 ? r + 12 : r), t, d * 1.5, 0.24, { det: [-5, 5], cut: 380, env: 5, fd: 0.05, q: 5, r: 0.03, must: true });
    // 超鋸齒和弦：A 段反拍、B 段切分、副歌與間奏長音（被大鼓抽吸）
    const tri = voice(c, 67 + k).map(mtof);
    const stab = (dur: number, vol: number, a: number): void => this.v('pad', 'sawtooth', tri, t, dur, vol, { det: [-17, -6, 6, 17], cut: 4000, env: 1.8, fd: 0.12, a, r: 0.1 });
    if (sec === 'A' && s % 4 === 2) stab(d * 1.2, 0.045, 0.003);
    else if (sec === 'B' && SYN_STAB[s] === 'x') stab(d * 1.6, 0.045, 0.003);
    else if ((sec === 'C' || sec === 'D') && s === 0) stab(d * 15.5, 0.04, sec === 'D' ? 0.5 : 0.01);
    // 16 分琶音
    if ((sec !== 'A' || b.rush) && (sec !== 'I' || bar >= 2)) {
      const tn = voice(c, 69 + k);
      tn.push(tn[0] + 12);
      this.v('arp', 'square', mtof(tn[ARP[s % 8] % tn.length] + 12), t, d * 0.7, sec === 'D' ? 0.03 : 0.045, { cut: sec === 'D' ? 1800 : 4200, r: 0.02 });
    }
    // 主旋律：雙鋸齒、連音滑音、長音顫音
    const m = this.mel(b);
    if (m) {
      const f = mtof(m.n + k), dur = m.l * d;
      this.v('lead', 'sawtooth', f, t, dur * 0.96, 0.09, {
        det: [-8, 8], from: this.lead.end > t - 0.02 ? this.lead.f : 0, gl: 0.06, vib: dur > 0.3 ? 24 : 0, vibR: 6, vibD: 0.15,
        cut: 5500, env: 1.4, fd: 0.2, a: 0.008, r: 0.07, must: true,
      });
      this.lead = { f, end: t + dur };
    }
  }

  /** Lo-fi：Eb 大調爵士和弦 76 BPM，搖擺 16 分、悶鼓、刷子、FM 電鋼琴（顫音＋錄音帶抖動）、黑膠底噪、整體低通 */
  private lofi(b: Beat): void {
    const { t, d, s, sec, bar, c, k, last } = b;
    const groove = sec !== 'I' && sec !== 'D';
    const tf = this.tone.frequency;
    if (sec === 'D' && bar === 0 && s === 0) tf.setTargetAtTime(1000, t, 0.8);
    if (sec === 'D' && last && s === 8) tf.setTargetAtTime(this.def.tone, t, 0.3);
    if (groove) {
      if (s === 0 || s === 10 || s === (bar % 2 ? 3 : 7)) this.kick('kick', t, s === 0 ? 0.8 : 0.55, 100, 44, 0.36);
      if (s === 4 || s === 12) { this.nz('drum', t, 0.2, 0.32, 'bandpass', 1500, 0.6); this.kick('drum', t, 0.2, 220, 160, 0.08); }
      if (s === 15 && bar % 2) this.nz('drum', t, 0.05, 0.07, 'bandpass', 1700);
      if (last && s === 14) this.nz('drum', t, 0.12, 0.18, 'bandpass', 1300, 0.6);
    }
    // 刷子：慢起音的帶通噪音，力度隨機
    if (sec !== 'I' || bar >= 2) {
      const v = (s % 4 === 0 ? 0.1 : s % 2 ? 0.045 : 0.07) * (0.8 + Math.random() * 0.4);
      if (groove || s % 2 === 0) this.nz('hat', t, s % 8 === 6 ? 0.16 : 0.06, v, 'bandpass', 6200, 0.6, { a: 0.012 });
      if (b.rush && s % 4 === 2) this.nz('hat', t, 0.05, 0.06, 'highpass', 8000, 0.7, { a: 0.03 });
    }
    if (b.hit) this.nz('hat', t, 1.2, 0.1, 'bandpass', 5000, 0.5, { a: 0.2 });
    // 電鋼琴：第一拍長和弦（輕微琶開），反拍再補一下
    const vo = voice(c, 62 + k);
    if (s === 0) vo.forEach((n, j) => this.ep(n, t + j * 0.014, d * (sec === 'B' ? 6 : 9), 0.075));
    if (sec !== 'I' && s === (bar % 2 ? 10 : 7)) vo.forEach((n, j) => this.ep(n, t + j * 0.008, d * 3, 0.05));
    // 次低音（三角波，手機喇叭也聽得到泛音）
    const r = rootAt(c, 31) + k;
    if (s === 0) this.v('bass', 'triangle', mtof(r), t, d * 7, 0.4, { cut: 360, a: 0.012, r: 0.12, must: true });
    if (s === 10 && sec !== 'I') this.v('bass', 'triangle', mtof(r + (bar % 2 ? 7 : 12)), t, d * 4, 0.3, { cut: 360, a: 0.012, r: 0.1, must: true });
    // 旋律：柔和像長笛
    const m = this.mel(b);
    if (m) this.v('lead', 'triangle', mtof(m.n + k), t, m.l * d, 0.13, { a: 0.035, cut: 2400, vib: m.l >= 4 ? 16 : 0, vibR: 4.5, vibD: 0.25, r: 0.15, wob: true, must: true });
    // B 段：輕柔撥弦點綴
    if (sec === 'B' && (s === 2 || s === 6 || s === 11 || s === 14)) this.fm('pluck', mtof(vo[(s + bar) % vo.length] + 12), t, d * 2, 0.06, { ratio: 2, i0: 1.3, i1: 0, it: 0.07, dec: 0.25, r: 0.25, wob: true });
  }

  private ep(n: number, t: number, dur: number, vol: number): void {
    this.fm('keys', mtof(n), t, dur, vol, { ratio: 1, i0: 1.6, i1: 0.3, it: 0.25, a: 0.006, dec: 1.2, sus: 0.25, r: 0.35, wob: true });
  }

  /** 嘻哈（trap）：G 小調 140 BPM 半拍感，滑音 808、三連音／32 分踩鈸連打、拍手疊小鼓、FM 鐘聲旋律、反向噪音 */
  private hiphop(b: Beat): void {
    const { t, d, s, sec, bar, c, k, last } = b;
    const groove = sec !== 'I';
    const tf = this.tone.frequency;
    if (sec === 'I' && bar === 0 && s === 0) { tf.cancelScheduledValues(t); tf.setValueAtTime(3000, t); } // 前奏悶住，最後兩拍打開
    if (sec === 'I' && last && s === 8) tf.setTargetAtTime(this.def.tone, t, 0.3);
    if (groove) {
      // 808：長度到下一顆為止
      const p = P808[sec === 'D' ? 4 : last ? 3 : (bar + (sec === 'C' ? 1 : 0)) % 3];
      const ch = p[s];
      if (ch !== '.') {
        let nx = s + 1;
        while (nx < 16 && p[nx] === '.') nx++;
        const off = [0, 0, 7, 12, 12]['xX5oO'.indexOf(ch)];
        this.b808(rootAt(c, 34) + k + off, t, Math.min((nx - s) * d + 0.05, 1.5), ch === 'X' || ch === 'O');
      }
      if (s === 0 || (sec === 'C' && s === 11)) this.kick('kick', t, 0.5, 170, 55, 0.12, 0.1);
      // 第三拍：拍手疊小鼓（半拍感）
      if (s === 8) { this.clap('drum', t, 0.45, 1150, 0.16); this.nz('drum', t, 0.13, 0.22, 'bandpass', 2300, 0.8); this.kick('drum', t, 0.14, 240, 180, 0.06); }
      if (last && sec !== 'D' && (s === 13 || s === 15)) this.nz('drum', t, 0.08, 0.16, 'bandpass', 2000);
    }
    // 踩鈸：八分、三連音與 32 分連打
    if ((groove && sec !== 'D') || (sec === 'I' && bar >= 2)) {
      const h = HATS[b.rush ? 4 : last ? 3 : sec === 'A' ? bar % 2 : 1 + (bar % 2)][s];
      const hit = (tt: number, v: number): void => this.nz('hat', tt, 0.035, v, 'highpass', 8500);
      if (h === '1') hit(t, s % 4 === 0 ? 0.15 : 0.09);
      else if (h === '3') for (let j = 0; j < 3; j++) hit(t + (j * 2 * d) / 3, 0.07 + j * 0.03);
      else if (h === '4') for (let j = 0; j < 4; j++) hit(t + (j * d) / 2, 0.05 + j * 0.025);
    }
    // 反向噪音：進副歌、前奏與間奏結尾
    if (last && s === 8 && (b.next === 'C' || sec === 'I' || sec === 'D')) this.nz('fx', t, 0.02, 0.26, 'highpass', 7000, 0.7, { a: 8 * d, f2: 800 });
    if (b.hit) this.nz('fx', t, 1.2, 0.18, 'highpass', 5000, 0.6);
    // 稀疏的暗色鋪底
    if (s === 0 && (sec === 'I' || sec === 'C' || sec === 'D' || (sec === 'B' && bar % 2 === 0))) this.v('pad', 'triangle', voice(c, 58 + k).map(mtof), t, (sec === 'B' ? 30 : 15) * d, 0.06, { det: [-9, 9], a: 0.5, r: 1, cut: 950 });
    // 鐘聲旋律（前奏先預告副歌）；B 段改成三連音感的暗色撥弦
    const m = sec === 'I' ? this.def.mel.C?.[b.i] : sec === 'B' ? undefined : this.mel(b);
    if (m) this.fm('bell', mtof(m.n + k), t, Math.max(m.l * d, 0.45), 0.17, { ratio: 3.5, i0: 2.4, i1: 0.1, it: 0.12, dec: 0.4, r: 0.15 });
    if (sec === 'B' && s % 3 === 0 && s < 15) {
      const tn = voice(c, 64 + k);
      this.v('pluck', 'sawtooth', mtof(tn[(s / 3 + bar) % tn.length]), t, d * 1.4, 0.11, { cut: 650, env: 5, fd: 0.06, q: 4, r: 0.12 });
    }
  }

  /** 金屬：Drop D 184 BPM，悶音 gallop 重複段、雙踏 16 分、每小節重拍鈸、副歌三度和聲主奏、半拍感 breakdown */
  private metal(b: Beat): void {
    const { t, d, s, sec, bar, c, k, last } = b;
    const rows = RIFF[sec], row = rows[bar % rows.length], ch = row[s];
    const root = rootAt(c, 38) + k; // 強力和弦根音（D2 以上）；x 一律打最低的 D 弦
    if (ch === 'x' || ch === 'm') this.chug(ch === 'x' ? 38 + k : root, t, d * 0.8, false);
    else if (ch === 'o') {
      let l = 1;
      while (s + l < 16 && row[s + l] === '-') l++;
      this.chug(root, t, l * d, true);
    }
    const half = sec === 'I' || sec === 'D';
    const fill = last && s >= 8 && sec !== 'D';
    const snare = (): void => { this.nz('drum', t, 0.18, 0.45, 'bandpass', 1900, 0.7); this.kick('drum', t, 0.32, 320, 200, 0.06); };
    if (fill) {
      // 段落結尾：中鼓由高到低
      const f = 240 - (s - 8) * 18;
      if (s % 2 === 0 || s >= 12) this.kick('drum', t, 0.5, f * 1.5, f, 0.22);
      if (s % 2 === 0) this.kick('kick', t, 0.6, 130, 50, 0.09, 0.2);
    } else if (half) {
      if (s === 8) snare();
      if (ch === 'x' || ch === 'o' || s === 0) this.kick('kick', t, 0.75, 130, 50, 0.1, 0.25);
    } else if (sec === 'B' && !b.rush) {
      // B 段：鞭打節奏（大鼓正拍、小鼓反拍）
      if (s % 4 === 0) this.kick('kick', t, 0.7, 130, 50, 0.09, 0.22);
      if (s % 4 === 2) snare();
    } else {
      this.kick('kick', t, 0.6, 130, 52, 0.08, 0.22);
      if (s === 4 || s === 12) snare();
    }
    if ((s === 0 && (bar % 2 === 0 || sec === 'C' || sec === 'D')) || b.hit) this.nz('cym', t, 1.5, 0.22, 'highpass', 4500, 0.6);
    else if ((sec === 'D' && s === 8) || (b.rush && sec === 'C' && s % 4 === 0)) this.nz('cym', t, 0.5, 0.17, 'bandpass', 2800, 0.9);
    else if (!half && !fill && s % 2 === 0) {
      if (sec === 'A') this.nz('hat', t, 0.25, 0.07, 'bandpass', 4200, 2.5);
      else this.nz('hat', t, 0.03, 0.09, 'highpass', 8000);
    }
    // 副歌主奏：三度和聲（A 和弦時用和聲小音階）
    const m = sec === 'C' ? this.mel(b) : undefined;
    if (m) {
      const dur = m.l * d * 0.95;
      const o: VO = { det: [-6, 6], cut: 3000, vib: m.l >= 4 ? 30 : 0, vibR: 6, vibD: 0.12, a: 0.01, r: 0.08, must: true };
      this.v('ldA', 'sawtooth', mtof(m.n + k), t, dur, 0.3, o);
      this.v('ldB', 'sawtooth', mtof(third(m.n, c.r === 9 ? D_HARM : D_NAT) + k), t, dur, 0.26, o);
    }
  }

  /** 8-bit：A 大調 160 BPM，兩個不同工作週期的脈衝波、4-bit 三角波低音、NES 雜訊鼓、快速琶音、B 段轉 A 小調 */
  private chip(b: Beat): void {
    const { t, d, s, sec, bar, c, k, last } = b;
    // 三角波低音
    const bp = CHIP_BASS[sec], j = s >> 1;
    if (s % 2 === 0 && bp[j] !== R) {
      let l = 1;
      while (j + l < 8 && bp[j + l] === R) l++;
      this.v('tri', this.triW, mtof(rootAt(c, 40) + k + bp[j]), t, d * (2 * l - 0.3), 0.42, { a: 0.002, r: 0.015, must: true });
    }
    // 雜訊鼓：播放速率 = NES 的雜訊週期
    const groove = !(sec === 'I' && bar < 2);
    const roll = last && s >= 12 && sec !== 'D';
    if (groove && CHIP_KICK[sec][s] === 'x') { this.kick('noise', t, 0.55, 420, 60, 0.07, 0, this.triW); this.nz('noise', t, 0.04, 0.22, null, 0, 0, { buf: this.nesL, rate: 0.1 }); }
    const sn = roll || (sec !== 'I' && (s === 12 || (s === 4 && sec !== 'D')));
    if (groove && sn) this.nz('noise', t, 0.1, roll ? 0.16 + (s - 12) * 0.05 : 0.3, null, 0, 0, { buf: this.nesL, rate: roll ? 0.4 + (s - 12) * 0.12 : 0.42 });
    else if (groove && sec !== 'D' && (s % 2 === 0 || sec === 'C' || b.rush)) this.nz('noise', t, 0.022, s % 4 === 2 ? 0.13 : 0.08, null, 0, 0, { buf: this.nesL, rate: 1 });
    if ((s === 0 && bar === 0 && sec === 'C') || b.hit) this.nz('noise', t, 0.45, 0.16, null, 0, 0, { buf: this.nesS, rate: 0.3 });
    // 脈衝 1（25%）：主旋律，長音帶延遲顫音
    const m = this.mel(b);
    if (m) this.v('p1', this.pw[1], mtof(m.n + k), t, m.l * d * 0.9, 0.12, { a: 0.002, r: 0.012, vib: m.l >= 6 ? 30 : 0, vibR: 7, vibD: 0.14, must: true });
    // 脈衝 2：副歌三度和聲（50%）、B 段回音（12.5%）、其他段落快速琶音和弦（12.5%）
    if (sec === 'C') {
      if (m) this.v('p2', this.pw[2], mtof(third(m.n, A_MAJ) + k), t, m.l * d * 0.9, 0.06, { a: 0.002, r: 0.012 });
    } else if (sec === 'B') {
      const e = this.def.mel.B?.[b.i - 3];
      if (e) this.v('p2', this.pw[0], mtof(e.n + k), t, e.l * d * 0.8, 0.05, { a: 0.002, r: 0.012 });
    } else if (s % 2 === 0) {
      const tn = voice(c, 66 + k, false).map(mtof);
      this.v('p2', this.pw[0], tn[0], t, d * 1.7, 0.06, { arp: tn, ar: 0.034, a: 0.002, r: 0.01 });
    }
  }

  /** 選單：F 大調 94 BPM，柔和鋪底＋輕打擊；主旋律音色借用目前選的風格 */
  private menu(b: Beat): void {
    const { t, d, s, sec, c } = b;
    if (s === 0) this.v('pad', 'triangle', voice(c, 62, false).map(mtof), t, 16 * d, 0.05, { det: [-7, 7], a: 0.8, r: 1.6, cut: 1400 });
    const r = rootAt(c, 41);
    if (s === 0) this.v('bass', 'triangle', mtof(r), t, d * 7, 0.3, { cut: 600, a: 0.02, r: 0.2, must: true });
    if (s === 8 && sec !== 'I') this.v('bass', 'triangle', mtof(r + 7), t, d * 6, 0.24, { cut: 600, a: 0.02, r: 0.2, must: true });
    if (sec !== 'I') {
      if (s === 0 || s === 8) this.kick('kick', t, 0.4, 95, 45, 0.25);
      if (s % 2 === 0) this.nz('hat', t, 0.05, s % 4 === 2 ? 0.07 : 0.04, 'bandpass', 7500, 0.8, { a: 0.012 });
      if (sec === 'B' && (s === 4 || s === 12)) this.nz('drum', t, 0.04, 0.12, 'bandpass', 1700, 4);
    }
    const m = this.mel(b);
    if (m) this.menuLead(mtof(m.n), t, m.l * d);
    if (sec === 'B' && (s === 6 || s === 14)) this.v('spark', 'sine', mtof(voice(c, 79, false)[s === 6 ? 0 : 2]), t, 0.05, 0.05, { dec: 0.15, r: 0.3 });
  }

  private menuLead(f: number, t: number, dur: number): void {
    switch (this.style) {
      case 'lofi': return this.fm('lead', f, t, dur, 0.14, { ratio: 1, i0: 1.4, i1: 0.25, it: 0.3, dec: 1, sus: 0.3, r: 0.4, wob: true });
      case 'hiphop': return this.fm('lead', f, t, Math.max(dur, 0.6), 0.12, { ratio: 3.5, i0: 2.2, i1: 0.1, it: 0.15, dec: 0.45, r: 0.2 });
      case 'chip': return this.v('lead', this.pw[2], f, t, dur * 0.9, 0.07, { vib: dur > 0.5 ? 25 : 0, vibR: 6.5, r: 0.02 });
      case 'metal': return this.v('lead', 'sawtooth', f, t, dur, 0.1, { det: [-9, 9], cut: 1300, env: 2.5, fd: 0.18, dec: 0.6, sus: 0.3, r: 0.3 });
      default: return this.v('lead', 'sawtooth', f, t, dur, 0.07, { det: [-6, 6], a: 0.05, cut: 1700, vib: 14, vibD: 0.3, r: 0.3 });
    }
  }
}
