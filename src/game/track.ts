export interface Sample {
  x: number;
  z: number;
  /** 路面高度 */
  y: number;
  /** 沿前進方向的坡度 dy/ds */
  slope: number;
  /** 切線（前進方向） */
  tx: number;
  tz: number;
  /** 左側法線 */
  nx: number;
  nz: number;
  dist: number;
  /** 曲率，正值 = 左彎 */
  curv: number;
}

/** 加速帶：dist 為距起跑線的公尺數，lat 為橫向位置（左為正） */
export interface BoostPad {
  dist: number;
  lat: number;
}

export type ThemeId = 'meadow' | 'desert' | 'city';

/** 沿賽道的一段範圍（公尺）；side：1 = 行進方向左側，-1 = 右側，0 = 兩側 */
export interface SceneRange {
  from: number;
  to: number;
  side: number;
}

/** 賽道旁要擺哪些大型景物 */
export interface Scenery {
  stands: SceneRange[];
  pits: SceneRange[];
  tents: SceneRange[];
  /** 橫跨路面的拱門位置 */
  arches: number[];
}

export interface TrackDef {
  id: string;
  name: string;
  /** 選單上的一句話介紹 */
  desc: string;
  theme: ThemeId;
  scenery: Scenery;
  laps: number;
  halfWidth: number;
  /** 控制點 [x, z, 高度] */
  points: [number, number, number][];
  pads: BoostPad[];
  /** 跳台（距起跑線的公尺數，指跳台頂端的位置），整條路寬都是斜坡 */
  ramps: number[];
  /** 爆炸桶的位置 */
  barrels: BoostPad[];
}

export const PAD_LENGTH = 9;
export const PAD_HALF_WIDTH = 3.2;

export const TRACKS: TrackDef[] = [
  {
    id: 'skyline-loop',
    name: '雲頂山道',
    desc: '長直線、山頂髮夾彎與連續 S 彎',
    theme: 'meadow',
    scenery: {
      stands: [{ from: -70, to: 170, side: 1 }, { from: 700, to: 830, side: 1 }, { from: 1395, to: 1440, side: 0 }],
      pits: [{ from: 12, to: 140, side: -1 }],
      tents: [{ from: 640, to: 690, side: -1 }, { from: 1300, to: 1560, side: 0 }, { from: 1880, to: 2000, side: 0 }],
      arches: [1010, 1720, 2290],
    },
    laps: 2,
    halfWidth: 12,
    points: [
      // 起跑直線
      [0, -60, 0], [0, 40, 0], [0, 140, 0],
      // 上坡大左彎
      [25, 225, 3], [95, 280, 8], [190, 285, 13], [265, 240, 16],
      // 山頂髮夾彎
      [285, 170, 17], [290, 105, 17], [325, 68, 16], [360, 105, 15],
      // 下坡直線接右彎
      [365, 175, 12], [385, 250, 9], [435, 305, 6], [510, 318, 4], [565, 275, 3],
      // 連續 S 彎
      [578, 200, 2], [548, 140, 2], [578, 80, 2], [548, 20, 2], [575, -45, 3],
      // 第二段爬坡與山脊
      [548, -118, 8], [482, -165, 13], [400, -158, 18], [332, -118, 20], [268, -148, 20],
      // 長下坡回到終點
      [205, -195, 16], [150, -262, 11], [78, -300, 6], [12, -268, 3], [-4, -195, 1], [0, -128, 0],
    ],
    pads: [
      { dist: 150, lat: 0 },
      { dist: 900, lat: -4 },
      { dist: 900, lat: 4 },
      { dist: 1290, lat: 4 },
      { dist: 1590, lat: 0 },
      { dist: 2040, lat: 0 },
      { dist: 2330, lat: -3 },
    ],
    ramps: [965, 1650],
    barrels: [
      { dist: 330, lat: 9.2 }, { dist: 338, lat: -9.2 }, { dist: 520, lat: -9.2 }, { dist: 680, lat: 9.2 },
      { dist: 850, lat: 9.2 }, { dist: 856, lat: -9.2 }, { dist: 1130, lat: -9.2 }, { dist: 1240, lat: 9.2 },
      { dist: 1350, lat: 9.2 }, { dist: 1425, lat: -9.2 }, { dist: 1500, lat: 9.2 }, { dist: 1760, lat: 9.2 },
      { dist: 1766, lat: -9.2 }, { dist: 1980, lat: -9.2 }, { dist: 2120, lat: 9.2 }, { dist: 2126, lat: -9.2 },
      { dist: 2300, lat: 9.2 },
    ],
  },
  {
    id: 'red-canyon',
    name: '赤岩峽谷',
    desc: '大落差長下坡、峽谷 S 彎與谷底髮夾彎',
    theme: 'desert',
    scenery: {
      stands: [{ from: -70, to: 170, side: 1 }, { from: 1300, to: 1380, side: 1 }, { from: 730, to: 820, side: 1 }, { from: 480, to: 560, side: 1 }],
      pits: [{ from: 12, to: 140, side: -1 }],
      tents: [{ from: 600, to: 700, side: 0 }, { from: 1500, to: 1600, side: 0 }, { from: 1850, to: 1990, side: 0 }],
      arches: [880, 1180, 1800],
    },
    laps: 2,
    halfWidth: 12,
    // 控制點由賽道設計腳本產生：起跑直線 → 爬坡右彎 → 峽谷 S 彎 → 岩台右彎 → 長下坡 → 谷底髮夾彎 → 左彎爬坡 → 斜向下坡 → 長右彎回到起點
    points: [[0, 0, 3], [0, 95, 3], [0, 190, 3.4], [-19, 268, 6], [-89, 308, 9], [-173, 308, 12.5], [-250, 345, 16], [-327, 308, 19.5], [-411, 308, 22.5], [-481, 268, 24.3], [-503, 191, 24.5], [-503, 69, 20.5], [-503, -53, 15.5], [-503, -175, 10.5], [-499, -241, 6], [-462, -279, 3], [-424, -241, 1.2], [-421, -175, 1.5], [-405, -115, 4], [-354, -80, 7], [-292, -87, 9], [-236, -135, 7.5], [-179, -182, 5.5], [-121, -213, 4.2], [-56, -204, 3.4], [-11, -155, 3], [0, -90, 3]],
    pads: [
      { dist: 150, lat: 0 }, { dist: 400, lat: -3 }, { dist: 645, lat: 3 }, { dist: 860, lat: -3 },
      { dist: 1100, lat: 4 }, { dist: 1460, lat: -3 }, { dist: 1700, lat: 0 }, { dist: 2090, lat: 0 },
    ],
    ramps: [950, 1720],
    barrels: [{ dist: 120, lat: 9.2 }, { dist: 200, lat: -9.2 }, { dist: 300, lat: 9.2 }, { dist: 380, lat: -9.2 }, { dist: 470, lat: 9.2 }, { dist: 560, lat: -9.2 }, { dist: 650, lat: 9.2 }, { dist: 740, lat: -9.2 }, { dist: 830, lat: 9.2 }, { dist: 1040, lat: -9.2 }, { dist: 1150, lat: 9.2 }, { dist: 1240, lat: -9.2 }, { dist: 1380, lat: 9.2 }, { dist: 1470, lat: -9.2 }, { dist: 1580, lat: 9.2 }, { dist: 1800, lat: -9.2 }, { dist: 1900, lat: 9.2 }, { dist: 2000, lat: -9.2 }],
  },
  {
    id: 'neon-bay',
    name: '霓虹灣岸',
    desc: '夜間街道賽：直角彎、減速彎、髮夾彎與跨海大橋',
    theme: 'city',
    scenery: {
      stands: [{ from: -70, to: 170, side: -1 }, { from: 1070, to: 1150, side: -1 }, { from: 1590, to: 1690, side: 1 }, { from: 470, to: 540, side: -1 }],
      pits: [{ from: 12, to: 140, side: 1 }],
      tents: [{ from: 600, to: 760, side: 0 }, { from: 1400, to: 1500, side: 0 }],
      arches: [1000, 1280, 1758],
    },
    laps: 2,
    halfWidth: 12,
    points: [
      // 起跑直線
      [0, 0, 0.6], [0, 72, 0.6], [0, 147, 0.6], [0, 205, 0.6],
      // 第一個直角彎，接港邊直線（第一座跳台）
      [25, 230, 0.6], [83, 230, 0.6], [190, 230, 0.6],
      // 減速彎
      [250, 230, 0.6], [285, 260, 0.6], [345, 260, 0.6],
      // 直角右彎往南
      [405, 260, 0.6], [433, 232, 0.6], [433, 175.5, 0.6],
      // 直角左彎往東
      [433, 119, 0.6], [459, 93, 0.6], [519, 93, 0.6],
      // 第二座跳台直線，接髮夾彎
      [625, 93, 0.6], [690, 93, 0.6], [728, 55, 0.6], [690, 17, 0.6], [633, 17, 0.6], [576, 17, 0.6],
      // 直角右彎往南
      [516, 17, 0.6], [490, -9, 0.6], [490, -65.5, 0.6],
      // 直角右彎往西
      [490, -122, 0.6], [462, -150, 0.8],
      // 跨海大橋
      [402, -150, 2.4], [323.25, -150, 6.3], [244.5, -150, 9.3], [165.75, -150, 6.3], [87, -150, 2.4],
      // 最後一個直角彎回到起跑直線
      [27, -150, 0.8], [0, -123, 0.6], [0, -63, 0.6],
    ],
    pads: [
      { dist: 120, lat: 0 }, { dist: 420, lat: -4 }, { dist: 980, lat: 4 }, { dist: 1250, lat: 0 },
      { dist: 1440, lat: 3 }, { dist: 1600, lat: -3 }, { dist: 1880, lat: 3 }, { dist: 2090, lat: 0 },
    ],
    ramps: [320, 900],
    barrels: [{ dist: 150, lat: 9.2 }, { dist: 230, lat: -9.2 }, { dist: 400, lat: 9.2 }, { dist: 520, lat: -9.2 }, { dist: 600, lat: 9.2 }, { dist: 700, lat: -9.2 }, { dist: 760, lat: 9.2 }, { dist: 970, lat: -9.2 }, { dist: 1040, lat: 9.2 }, { dist: 1160, lat: -9.2 }, { dist: 1270, lat: 9.2 }, { dist: 1360, lat: -9.2 }, { dist: 1450, lat: 9.2 }, { dist: 1520, lat: -9.2 }, { dist: 1650, lat: 9.2 }, { dist: 1800, lat: -9.2 }, { dist: 1950, lat: 9.2 }, { dist: 2030, lat: -9.2 }],
  },
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 封閉賽道：把控制點平滑成等距取樣點，提供「最近點／橫向偏移／高度」查詢。 */
export class Track {
  samples: Sample[] = [];
  n = 0;
  length = 0;
  spacing = 1.5;
  halfWidth: number;
  laps: number;
  def: TrackDef;
  pads: BoostPad[];
  ramps: number[];
  /** 最近一次 locate() 算出的橫向偏移（左為正） */
  lat = 0;

  constructor(def: TrackDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.laps = def.laps;
    const P = def.points;
    const m = P.length;
    const dense: [number, number, number][] = [];
    const SUB = 32;
    for (let i = 0; i < m; i++) {
      const a = P[(i - 1 + m) % m], b = P[i], c = P[(i + 1) % m], d = P[(i + 2) % m];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        dense.push([catmull(a[0], b[0], c[0], d[0], t), catmull(a[1], b[1], c[1], d[1], t), catmull(a[2], b[2], c[2], d[2], t)]);
      }
    }
    const L = dense.length;
    const cum = new Float64Array(L + 1);
    for (let j = 0; j < L; j++) {
      const p = dense[j], q = dense[(j + 1) % L];
      cum[j + 1] = cum[j] + Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    this.length = cum[L];
    this.n = Math.round(this.length / 1.5);
    this.spacing = this.length / this.n;
    const pts: [number, number, number][] = [];
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const d = i * this.spacing;
      while (j < L - 1 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = (d - cum[j]) / seg;
      const p = dense[j], q = dense[(j + 1) % L];
      pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
    }
    const n = this.n;

    // 高度做幾次平滑，避免曲線過衝造成路面抖動
    let ys = pts.map((p) => p[2]);
    for (let pass = 0; pass < 3; pass++) {
      const out = new Array<number>(n);
      const R = 6;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -R; k <= R; k++) s += ys[(i + k + n) % n];
        out[i] = s / (2 * R + 1);
      }
      ys = out;
    }

    const ang: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      ang.push(Math.atan2(tx, tz));
      const slope = (ys[(i + 1) % n] - ys[(i - 1 + n) % n]) / (2 * this.spacing);
      this.samples.push({ x: pts[i][0], z: pts[i][1], y: ys[i], slope, tx, tz, nx: tz, nz: -tx, dist: i * this.spacing, curv: 0 });
    }
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      let da = ang[(i + 1) % n] - ang[(i - 1 + n) % n];
      da = Math.atan2(Math.sin(da), Math.cos(da));
      raw.push(da / (2 * this.spacing));
    }
    const R = 4;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += raw[(i + k + n) % n];
      this.samples[i].curv = s / (2 * R + 1);
    }
    this.ramps = def.ramps.map((d) => ((d % this.length) + this.length) % this.length);
    this.pads = def.pads.map((p) => ({ dist: ((p.dist % this.length) + this.length) % this.length, lat: p.lat }));
  }

  wrap(i: number): number {
    const n = this.n;
    return ((i % n) + n) % n;
  }

  /** 找離 (x,z) 最近的取樣點索引；hint < 0 時做全域搜尋。橫向偏移寫入 this.lat。 */
  locate(x: number, z: number, hint: number, win = 30): number {
    const n = this.n;
    const S = this.samples;
    let best = 0;
    let bd = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let k = -win; k <= win; k++) {
        const i = (((hint + k) % n) + n) % n;
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    const s = S[best];
    this.lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    return best;
  }

  /** 已知最近取樣點 idx 時，(x,z) 處的路面高度 */
  heightAt(idx: number, x: number, z: number): number {
    const s = this.samples[idx];
    return s.y + ((x - s.x) * s.tx + (z - s.z) * s.tz) * s.slope;
  }

  /** 與某個距離點的有號差距（考慮賽道首尾相接） */
  private rel(idx: number, dist: number): number {
    let d = this.samples[idx].dist - dist;
    if (d > this.length / 2) d -= this.length;
    else if (d < -this.length / 2) d += this.length;
    return d;
  }

  /**
   * 跳台：回傳 0~1 表示車在斜坡上的進度（1 = 頂端，該起跳了），不在斜坡上回傳 -1。
   * rampLen 為斜坡長度。
   */
  rampProgress(idx: number, rampLen: number): number {
    for (const r of this.ramps) {
      const d = this.rel(idx, r);
      if (d > -rampLen && d <= 1.6) return Math.min(1, (d + rampLen) / rampLen);
    }
    return -1;
  }

  /** 車輛（idx, lat）是否踩在加速帶上 */
  onPad(idx: number, lat: number): boolean {
    const d = this.samples[idx].dist;
    for (const p of this.pads) {
      let dd = d - p.dist;
      if (dd > this.length / 2) dd -= this.length;
      else if (dd < -this.length / 2) dd += this.length;
      if (Math.abs(dd) < PAD_LENGTH / 2 && Math.abs(lat - p.lat) < PAD_HALF_WIDTH + 0.6) return true;
    }
    return false;
  }
}
