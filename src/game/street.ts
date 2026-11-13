import { CFG } from './config';
import type { HazardState, Race } from './race';
import type { HazardDef, Track } from './track';
import { clamp } from './util';

/**
 * 廟口夜市的街頭機關（全部只看比賽時鐘 race.clock，不用亂數，連線時每台電腦算出來的都一樣）：
 * - 機車：從巷口橫越馬路的一群機車，或沿著路邊騎的機車。撞到 = 像撞到捷徑上的障礙物一樣被彈開、掉速，不扣血
 * - 鞭炮陣：鋪在路面上的幾串鞭炮輪流點燃（先冒火花 → 炸開），炸開時在上面的車小扣血、被炸得往旁邊彈
 * - 河堤強風：一陣一陣從河面吹來，把車往側邊推（空中推得更多）
 * 只處理自己控制的車（遠端的車由車主的電腦判定），跟其他機關一樣。
 */

export const SCOOTER = {
  /** 碰撞半徑（車身中心到機車中心） */
  r: 1.05,
  /** 橫越馬路的速度（公尺／秒） */
  cross: 7.4,
  /** 沿路騎的速度 */
  ride: 15,
  /** 從巷子裡出來到回到巷子裡，離路緣多遠 */
  out: 7,
  /** 沿路騎的機車：切進車道與離開車道各花幾秒 */
  merge: 1.7,
};

export const CRACKER = {
  /** 點燃後火花沿引信跑的時間（警示） */
  warn: 0.9,
  /** 炸開的時間 */
  burst: 1.15,
  /** 一片鞭炮沿賽道方向的半長、橫向的半寬 */
  halfLen: 3.2,
  halfW: 3.5,
  dmg: 6,
};

export const GUST = {
  /** 一陣風：增強、維持、減弱各幾秒 */
  rise: 0.7,
  hold: 1.6,
  fall: 0.9,
  /** 最強時的橫向加速度（公尺／秒²）；穩定時大約是 accel / 抓地力 ≈ 2 公尺／秒的側滑 */
  accel: 17,
};

/** 一台機車（畫面依這些值擺模型） */
export interface StreetRider {
  on: boolean;
  x: number; y: number; z: number;
  /** 車頭朝向（世界座標的 atan2(dx, dz)） */
  yaw: number;
  vx: number; vz: number;
  /** 傾斜（轉彎、切車道時） */
  lean: number;
  /** 外觀編號（顏色、騎士） */
  look: number;
}

/** 一片鞭炮：u / c 是在賽道上的位置（距離、橫向）；state 0 = 沒事、1 = 引信燒著（警示）、2 = 炸開中 */
export interface CrackerMat {
  d: number; c: number;
  x: number; y: number; z: number; tx: number; tz: number; nx: number; nz: number;
  state: 0 | 1 | 2;
  /** 這個階段進行到幾成（0~1） */
  t: number;
  phase: number;
  /** 這一輪的編號（換輪時發事件） */
  cycle: number;
}

/** 0~1 的雜湊（同樣的輸入永遠得到同樣的值） */
export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number) => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };

/** 沿路騎的機車：同時最多有幾台 */
function rideSlots(def: HazardDef): number {
  const T = (def.len ?? 150) / SCOOTER.ride + SCOOTER.merge;
  return Math.ceil(T / def.period) + 1;
}

/** 鞭炮陣的配置：沿賽道每 13 公尺一片，橫向在左、中、右三條線上輪流；最外側（貼著路邊）永遠留一條安全的車道 */
const MAT_LANES = [-5.8, 5.4, 0, 5.8, -5.4, 0.4, -5.8, 5.4];

/** 建立機關狀態時呼叫：準備好機車與鞭炮的陣列 */
export function initStreet(h: HazardState, track: Track): void {
  const def = h.def;
  if (def.kind === 'scooter') {
    const n = def.len ? rideSlots(def) : 6;
    h.riders = [];
    for (let i = 0; i < n; i++) h.riders.push({ on: false, x: h.x, y: h.y, z: h.z, yaw: 0, vx: 0, vz: 0, lean: 0, look: 0 });
  } else if (def.kind === 'firecracker') {
    const len = def.len ?? 90;
    const count = Math.max(1, Math.floor((len - 8) / 13) + 1);
    h.mats = [];
    for (let i = 0; i < count; i++) {
      const d = def.dist + 6 + i * 13;
      const p = track.pointAt(d);
      const c = MAT_LANES[i % MAT_LANES.length];
      h.mats.push({
        d, c, x: p.x + p.nx * c, y: p.y, z: p.z + p.nz * c, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz,
        // 每片錯開：一波一波往前點燃，旁邊那條線慢半拍
        state: 0, t: 0, phase: (i * 0.29 + (i % 3) * 0.11) % 1, cycle: -1,
      });
    }
  } else if (def.kind === 'gust') {
    h.gust = 0;
  }
}

/** 每幀更新（dt = 0 時只算位置，不做碰撞） */
export function updateStreet(race: Race, h: HazardState, dt: number): void {
  const k = h.def.kind;
  if (k === 'scooter') {
    if (h.def.len) rideScooters(race.track, h, race.clock);
    else {
      crossScooters(race.track, h, race.clock);
      // 新的一群要出來了：按喇叭（從哪一側出來就在哪一側）
      const cyc = Math.floor(race.clock / h.def.period + (h.def.phase ?? 0));
      if (cyc !== h.cycle) {
        if (h.cycle >= 0 && dt > 0) {
          // 跟 crossScooters 一樣：dir = 往哪邊騎，起點在 -dir 那一側
          const dir = cyc % 2 ? 1 : -1;
          const off = race.track.halfWidth + 6;
          race.events.push({ t: 'street', kind: 'horn', x: h.x - h.nx * dir * off, y: h.y + 1, z: h.z - h.nz * dir * off });
        }
        h.cycle = cyc;
      }
    }
    if (dt > 0 && race.state !== 'countdown') scooterHits(race, h);
  } else if (k === 'firecracker') {
    crackers(race, h, dt);
  } else if (k === 'gust') {
    gusts(race, h, dt);
  }
}

/** 巷口：每 period 秒一群（2~3 台）機車從一側的巷子騎出來橫越馬路，方向一輪一輪交替 */
function crossScooters(track: Track, h: HazardState, clock: number): void {
  const def = h.def, P = def.period;
  const ph = clock / P + (def.phase ?? 0);
  const hw = track.halfWidth;
  const idx = track.wrap(Math.round(def.dist / track.spacing));
  const riders = h.riders!;
  for (const r of riders) r.on = false;
  // 這一輪與上一輪（上一輪最後一台可能還沒騎完）
  for (const cyc of [Math.floor(ph), Math.floor(ph) - 1]) {
    const tau = (ph - cyc) * P;
    const dir = cyc % 2 ? 1 : -1;
    const n = hash01(cyc, 11) < 0.45 ? 2 : 3;
    // 兩側的起點與終點：路緣外（有緩衝區就在緩衝區外）再 SCOOTER.out
    const from = -dir * (hw + track.runoffW(idx, -dir) + SCOOTER.out);
    const to = dir * (hw + track.runoffW(idx, dir) + SCOOTER.out);
    for (let i = 0; i < n; i++) {
      // 這一輪與上一輪的奇偶不同，各用一半的位置
      const r = riders[(cyc & 1) * 3 + i];
      const delay = i * 0.62 + hash01(cyc, i) * 0.25;
      const v = SCOOTER.cross * (0.9 + hash01(cyc, i + 7) * 0.25);
      const t = tau - delay;
      const span = Math.abs(to - from);
      if (t < 0 || t * v > span) continue;
      const lat = from + dir * v * t;
      const along = (i - 1) * 3.4 + (hash01(cyc, i + 3) - 0.5) * 1.6;
      const p = track.pointAt(def.dist + along);
      r.on = true;
      r.x = p.x + p.nx * lat;
      r.z = p.z + p.nz * lat;
      r.y = p.y;
      r.vx = p.nx * dir * v;
      r.vz = p.nz * dir * v;
      r.yaw = Math.atan2(r.vx, r.vz);
      r.lean = 0;
      r.look = (cyc * 3 + i) & 7;
    }
  }
}

/** 沿路騎：每 period 秒一台從左邊的坡道騎上來、切到 def.lat 的車道往前騎 len 公尺，再往右邊離開 */
function rideScooters(track: Track, h: HazardState, clock: number): void {
  const def = h.def, P = def.period, L = def.len ?? 150;
  const ph = clock / P + (def.phase ?? 0);
  const v = SCOOTER.ride, M = SCOOTER.merge;
  const T = L / v;
  const hw = track.halfWidth;
  const lane = def.lat ?? -(hw - 2.5);
  const riders = h.riders!;
  for (let j = 0; j < riders.length; j++) {
    const r = riders[j];
    const cyc = Math.floor(ph) - j;
    const t = (ph - cyc) * P;
    r.on = t >= 0 && t <= T;
    if (!r.on) continue;
    const d = def.dist + v * t;
    const i0 = track.wrap(Math.round(def.dist / track.spacing)), i1 = track.wrap(Math.round((def.dist + L) / track.spacing));
    const latIn = -Math.sign(lane) * (hw + track.runoffW(i0, -Math.sign(lane)) + 4);
    const latOut = Math.sign(lane) * (hw + track.runoffW(i1, Math.sign(lane)) + 4);
    const latAt = (u: number) => {
      const weave = Math.sin(u * 1.3 + cyc * 1.7) * 0.5;
      const kIn = smooth(u / M), kOut = smooth((u - (T - M)) / M);
      return latIn + (lane + weave - latIn) * kIn + (latOut - lane - weave) * kOut;
    };
    const lat = latAt(t);
    // 橫向速度（數值微分）→ 車頭方向與傾斜
    const dl = (latAt(t + 0.05) - lat) / 0.05;
    const p = track.pointAt(d);
    r.x = p.x + p.nx * lat;
    r.z = p.z + p.nz * lat;
    r.y = p.y;
    r.vx = p.tx * v + p.nx * dl;
    r.vz = p.tz * v + p.nz * dl;
    r.yaw = Math.atan2(r.vx, r.vz);
    r.lean = clamp(-dl * 0.06, -0.4, 0.4);
    r.look = (cyc * 5 + 2) & 7;
  }
}

/** 機車撞到車：把車推開、反彈、掉速（跟撞到捷徑上的障礙物一樣，不扣血） */
function scooterHits(race: Race, h: HazardState): void {
  const min = SCOOTER.r + CFG.kartRadius * 0.9;
  for (const r of h.riders!) {
    if (!r.on) continue;
    for (const k of race.karts) {
      if (k.dead || k.out || k.remote || k.fallT > 0 || k.air > 1.2) continue;
      const dx = k.x - r.x, dz = k.z - r.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      k.x = r.x + nx * min;
      k.z = r.z + nz * min;
      // 相對速度：機車自己也在動
      const vn = -((k.vx - r.vx) * nx + (k.vz - r.vz) * nz);
      if (vn <= 0) continue;
      k.vx += nx * vn * 1.25;
      k.vz += nz * vn * 1.25;
      const f = Math.min(1, vn / 14);
      k.vx *= 1 - (CFG.wallLoss + 0.15) * f;
      k.vz *= 1 - (CFG.wallLoss + 0.15) * f;
      k.spinVel += (k.vx * nz - k.vz * nx > 0 ? 1 : -1) * f * 3;
      if (vn > 4) {
        k.drifting = false;
        if (k.hazardCd <= 0) {
          k.hazardCd = 0.8;
          race.events.push({ t: 'hazard', k, kind: 'scooter', x: (k.x + r.x) / 2, y: k.y + 0.8, z: (k.z + r.z) / 2 });
        }
      }
    }
  }
}

/** 鞭炮：每片自己的節奏（沒事 → 引信 → 炸開）；炸開時在上面的車被炸 */
function crackers(race: Race, h: HazardState, dt: number): void {
  const P = h.def.period;
  const ph0 = race.clock / P + (h.def.phase ?? 0);
  const idle = P - CRACKER.warn - CRACKER.burst;
  for (const m of h.mats!) {
    const ph = ph0 + m.phase;
    const cyc = Math.floor(ph);
    const tau = (ph - cyc) * P;
    if (tau < idle) { m.state = 0; m.t = tau / idle; }
    else if (tau < idle + CRACKER.warn) { m.state = 1; m.t = (tau - idle) / CRACKER.warn; }
    else {
      m.state = 2;
      m.t = (tau - idle - CRACKER.warn) / CRACKER.burst;
      if (m.cycle !== cyc) {
        if (m.cycle >= 0 && dt > 0) race.events.push({ t: 'street', kind: 'cracker', x: m.x, y: m.y + 0.5, z: m.z });
        m.cycle = cyc;
      }
    }
    if (m.state !== 2 || dt <= 0 || race.state === 'countdown') continue;
    for (const k of race.karts) {
      if (k.dead || k.out || k.remote || k.hazardCd > 0 || k.invulnT > 0 || k.air > 1.5) continue;
      const dx = k.x - m.x, dz = k.z - m.z;
      const along = dx * m.tx + dz * m.tz, lat = dx * m.nx + dz * m.nz;
      if (Math.abs(along) > CRACKER.halfLen + 0.7 || Math.abs(lat) > CRACKER.halfW + 0.6) continue;
      // 往鞭炮外側彈（橫向），保留大部分速度：只是被炸得歪一下
      const side = Math.sign(lat || (m.c >= 0 ? -1 : 1));
      k.hazardCd = 1.0;
      race.events.push({ t: 'hazard', k, kind: 'firecracker', x: k.x, y: k.y + 0.8, z: k.z });
      race.damage(k, CRACKER.dmg, null);
      if (k.dead) continue;
      k.vx = k.vx * 0.82 + m.nx * side * 7.5;
      k.vz = k.vz * 0.82 + m.nz * side * 7.5;
      if (k.air <= 0) k.jumped = false;
      k.hop = false;
      k.y += Math.max(0, 0.05 - k.air);
      k.air = Math.max(k.air, 0.05);
      k.vy = Math.max(k.vy, 4.2);
      k.spinVel += side * 2.2;
      k.tumble = side * 2.5;
      k.drifting = false;
    }
  }
}

/** 強風：0~1 的強度；在範圍內的車（主線上、不在捷徑）被往左側（def.lat 的正負決定方向，預設往左）推 */
export function gustStrength(def: HazardDef, clock: number): number {
  const P = def.period;
  const ph = clock / P + (def.phase ?? 0);
  const tau = (ph - Math.floor(ph)) * P;
  const { rise, hold, fall } = GUST;
  if (tau < rise) return smooth(tau / rise);
  if (tau < rise + hold) return 1;
  if (tau < rise + hold + fall) return 1 - smooth((tau - rise - hold) / fall);
  return 0;
}

function gusts(race: Race, h: HazardState, dt: number): void {
  const def = h.def;
  h.gust = gustStrength(def, race.clock);
  if (dt <= 0 || h.gust <= 0 || race.state === 'countdown') return;
  const track = race.track, L = track.length;
  const dir = Math.sign(def.lat ?? 1) || 1;
  for (const k of race.karts) {
    if (k.dead || k.out || k.remote || k.branch || k.fallT > 0 || k.finished) continue;
    let d = track.samples[k.idx].dist - def.dist;
    d = ((d % L) + L) % L;
    const len = def.len ?? 120;
    if (d > len) continue;
    // 範圍兩端漸強漸弱
    const edge = Math.min(1, d / 15, (len - d) / 15);
    const s = track.samples[k.idx];
    const a = GUST.accel * h.gust * edge * (k.air > 0 && !k.hop ? 1.8 : 1) * dir;
    k.vx += s.nx * a * dt;
    k.vz += s.nz * a * dt;
  }
}

/** AI 用：預測 t 秒後這台機車在哪裡（還在騎的話） */
export function riderAhead(r: StreetRider, t: number): { x: number; z: number } {
  return { x: r.x + r.vx * t, z: r.z + r.vz * t };
}

/** 給 AI：這片鞭炮在 t 秒後（前後留一點餘裕，車身通過要一點時間）會不會正在炸 */
export function crackerHotIn(def: HazardDef, m: CrackerMat, clock: number, t: number): boolean {
  const P = def.period;
  for (const dt of [-0.25, 0, 0.3]) {
    const ph = (clock + t + dt) / P + (def.phase ?? 0) + m.phase;
    const tau = (ph - Math.floor(ph)) * P;
    if (tau >= P - CRACKER.burst - 0.1) return true;
  }
  return false;
}
