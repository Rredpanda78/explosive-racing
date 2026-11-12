export interface Sample {
  x: number;
  z: number;
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

export interface TrackDef {
  id: string;
  name: string;
  laps: number;
  halfWidth: number;
  points: [number, number][];
}

export const TRACKS: TrackDef[] = [
  {
    id: 'sunset-circuit',
    name: '夕陽環道',
    laps: 3,
    halfWidth: 12,
    points: [
      [0, -40], [0, 60], [0, 150], [30, 230], [110, 275], [200, 245],
      [232, 155], [185, 85], [112, 62], [90, -8], [150, -62], [240, -72],
      [290, -140], [252, -222], [150, -252], [52, -232], [6, -180], [0, -110],
    ],
  },
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 封閉賽道：把控制點平滑成等距取樣點，提供「最近點／橫向偏移」查詢。 */
export class Track {
  samples: Sample[] = [];
  n = 0;
  length = 0;
  spacing = 1.5;
  halfWidth: number;
  laps: number;
  def: TrackDef;
  /** 最近一次 locate() 算出的橫向偏移（左為正） */
  lat = 0;

  constructor(def: TrackDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.laps = def.laps;
    const P = def.points;
    const m = P.length;
    const dense: [number, number][] = [];
    const SUB = 32;
    for (let i = 0; i < m; i++) {
      const a = P[(i - 1 + m) % m], b = P[i], c = P[(i + 1) % m], d = P[(i + 2) % m];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        dense.push([catmull(a[0], b[0], c[0], d[0], t), catmull(a[1], b[1], c[1], d[1], t)]);
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
    const pts: [number, number][] = [];
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const d = i * this.spacing;
      while (j < L - 1 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = (d - cum[j]) / seg;
      const p = dense[j], q = dense[(j + 1) % L];
      pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
    const n = this.n;
    const ang: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      ang.push(Math.atan2(tx, tz));
      this.samples.push({ x: pts[i][0], z: pts[i][1], tx, tz, nx: tz, nz: -tx, dist: i * this.spacing, curv: 0 });
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
}
