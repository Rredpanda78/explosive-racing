import * as THREE from 'three';
import { CFG } from '../game/config';
import type { Kart } from '../game/kart';
import type { Track } from '../game/track';
import type { Particles } from './particles';
import type { Theme } from './themes';

/**
 * 甩尾火花分段的顏色（跑跑那種：藍 → 橘 → 紫），讓玩家一看就知道這次甩尾集了多少氣。
 * 0 = 還沒有火花（甩尾時間還不夠小噴）
 */
export const TIER_COLORS: readonly [number, number, number][] = [
  [1, 1, 1],
  [0.2, 0.55, 1.6],
  [1.5, 0.5, 0.05],
  [0.95, 0.12, 1.55],
];

/** 這次甩尾集到多少氣（一整瓶 = 1）就換下一段顏色 */
const TIER_GAIN = [0.12, 0.3];
/** 遠端玩家的車：只知道在甩尾，用甩尾秒數估 */
const TIER_TIME = [CFG.miniMinDrift, 0.95, 1.8];

/** 每條賽道每個取樣點是不是彎道（跟 world.ts 畫紅白路緣的條件一樣） */
const cornerCache = new WeakMap<Track, Uint8Array>();
function cornerMask(track: Track): Uint8Array {
  let m = cornerCache.get(track);
  if (m) return m;
  const S = track.samples, n = track.n;
  m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let on = Math.abs(S[i].curv) > 0.012;
    for (let k = -8; k <= 8 && !on; k += 4) if (Math.abs(S[(i + k + n) % n].curv) > 0.012) on = true;
    m[i] = on ? 1 : 0;
  }
  cornerCache.set(track, m);
  return m;
}

/**
 * 「手感」特效：甩尾火花分段、輪胎在泥地／碎石捷徑揚起的土、雨天輪胎濺水、壓到路緣的判定。
 * 全部只看車的狀態（不碰物理），所以遠端玩家的車也一樣有。
 */
export class FeelFx {
  /** 玩家這一幀壓在路緣上的強度 0~1（隆隆聲與手機震動用） */
  kerb = 0;
  private fire: Particles;
  private smoke: Particles;
  private lowDetail: boolean;
  private driftT = new Map<Kart, number>();
  private mask: Uint8Array | null = null;
  private rain = false;
  private night = false;
  /** 泥土顏色（捷徑路面）與碎石顏色 */
  private dirt: [number, number, number] = [0.6, 0.48, 0.33];
  private grit: [number, number, number] = [0.3, 0.24, 0.18];
  private v = new THREE.Vector3();

  constructor(fire: Particles, smoke: Particles, lowDetail: boolean) {
    this.fire = fire;
    this.smoke = smoke;
    this.lowDetail = lowDetail;
  }

  setTrack(track: Track, theme: Theme, rain: boolean): void {
    this.mask = cornerMask(track);
    this.rain = rain;
    this.night = theme.night;
    // 沙漠是淺黃褐色的碎石，草原地圖是深褐色的泥巴
    // 揚起的土比路面亮一點（才看得出來），石塊比路面暗
    if (theme.vegetation === 'desert') {
      this.dirt = [0.95, 0.83, 0.65];
      this.grit = [0.4, 0.27, 0.17];
    } else {
      this.dirt = [0.62, 0.5, 0.36];
      this.grit = [0.2, 0.13, 0.08];
    }
    this.driftT.clear();
  }

  /** 這台車目前的甩尾火花段數（0~3） */
  driftTier(k: Kart, dt: number): number {
    if (!k.drifting || k.dead) {
      this.driftT.delete(k);
      return 0;
    }
    const t = (this.driftT.get(k) ?? 0) + dt;
    this.driftT.set(k, t);
    if (!k.remote) {
      // 本機跑物理的車：看這次甩尾實際集到的氣（撞牆時會被扣回 0）
      if (k.driftTime <= CFG.miniMinDrift) return 0;
      return k.driftGain >= TIER_GAIN[1] ? 3 : k.driftGain >= TIER_GAIN[0] ? 2 : 1;
    }
    return t < TIER_TIME[0] ? 0 : t < TIER_TIME[1] ? 1 : t < TIER_TIME[2] ? 2 : 3;
  }

  /** 甩尾火花：從後輪往後噴，顏色依段數 */
  sparks(k: Kart, tier: number, wx: number, wz: number, fx: number, fz: number, dt: number): void {
    if (tier <= 0) return;
    const R = Math.random;
    const [r, g, b] = TIER_COLORS[tier];
    const rate = 40 + tier * 16;
    const n = Math.floor(dt * rate + R());
    for (let i = 0; i < n; i++) {
      const sp = 4 + R() * 5;
      this.fire.spawn(wx, k.y + 0.12, wz, k.vx * 0.3 - fx * 3 + (R() - 0.5) * sp * 1.6, 1.5 + R() * 4.5, k.vz * 0.3 - fz * 3 + (R() - 0.5) * sp * 1.6, 0.25 + R() * 0.25, 0.55 + tier * 0.08, 0.1, r, g, b, 1, 16, 0, k.y);
    }
    // 輪胎貼地處一團同色的光：火花顏色在白色的甩尾煙裡也看得清楚
    if (R() < dt * 30) this.fire.spawn(wx, k.y + 0.2, wz, k.vx * 0.85, 0.3, k.vz * 0.85, 0.09, 1.2 + tier * 0.15, 0.6, r * 0.8, g * 0.8, b * 0.8, 0.85);
  }

  /**
   * 路面回饋：碎石／泥地捷徑揚土與甩出小石塊、雨天濺水、判斷有沒有壓到路緣。
   * cam2：這台車到鏡頭距離的平方（太遠的車少噴一點）
   */
  surface(k: Kart, track: Track, dt: number, cam2: number, isPlayer: boolean): void {
    if (isPlayer) this.kerb = 0;
    if (k.air > 0 || k.dead) return;
    // 連線的遠端車沒有同步橫向位置與捷徑：自己從位置算（本機的車直接用物理算好的）
    let lat = k.lat, branch = k.branch;
    if (k.remote) {
      track.locate(k.x, k.z, k.idx);
      lat = track.lat;
      branch = null;
      if (Math.abs(lat) > track.halfWidth - 1) {
        const b = track.branchNear(k.x, k.z);
        if (b) {
          b.locate(k.x, k.z);
          if (b.inside() && Math.abs(b.lat) <= b.halfWidth + 0.5) branch = b;
        }
      }
    }
    const sp = Math.abs(k.speed);
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const lx = fz, lz = -fx;
    const R = Math.random;
    const far = cam2 > 90 * 90;
    const scale = (this.lowDetail ? 0.5 : 1) * (isPlayer ? 1 : far ? 0 : 0.6);

    // ---- 碎石、泥地捷徑：後輪揚起一團土，甩出往下掉的小石塊 ----
    const rough = branch?.def.rough;
    if (rough && sp > 6 && scale > 0) {
      const sk = Math.min(1.4, sp / 22) * scale;
      const [dr, dg, db] = this.dirt, [gr, gg, gb] = this.grit;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? 1 : -1;
        const wx = k.x + lx * side * 0.6 - fx * 0.75, wz = k.z + lz * side * 0.6 - fz * 0.75;
        const nd = Math.floor(dt * 44 * sk + R());
        for (let i = 0; i < nd; i++) {
          this.smoke.spawn(wx, k.y + 0.25, wz, k.vx * 0.3 - fx * 3 + lx * side * (1 + R() * 2.5), 1.2 + R() * 2.6, k.vz * 0.3 - fz * 3 + lz * side * (1 + R() * 2.5), 0.8 + R() * 0.6, 0.8, 3.8 + R() * 1.8, dr, dg, db, 0.62, -0.3, 1.4);
        }
        const n = Math.floor(dt * 34 * sk + R());
        for (let i = 0; i < n; i++) {
          const c = 0.8 + R() * 0.4;
          this.smoke.spawn(wx, k.y + 0.2, wz, k.vx * 0.45 - fx * (2 + R() * 4) + lx * side * R() * 3.5, 3.5 + R() * 4.5, k.vz * 0.45 - fz * (2 + R() * 4) + lz * side * R() * 3.5, 0.6 + R() * 0.3, 0.22 + R() * 0.16, 0.16, gr * c, gg * c, gb * c, 1, 20, 0.3, k.y);
        }
      }
    }

    // ---- 下雨：輪胎捲起的水花（像小公雞尾巴），速度越快越高 ----
    if (this.rain && sp > 7 && scale > 0) {
      const sk = Math.min(1.3, sp / 26) * scale;
      const c = this.night ? 0.66 : 0.85;
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? 1 : -1;
        const wx = k.x + lx * side * 0.62 - fx * 0.8, wz = k.z + lz * side * 0.62 - fz * 0.8;
        // 水珠：小顆、往上往後甩出去再落下
        const n = Math.floor(dt * 70 * sk + R());
        for (let i = 0; i < n; i++) {
          const up = 2.2 + R() * 3.6 * sk;
          this.smoke.spawn(wx, k.y + 0.12, wz, k.vx * 0.6 - fx * (1 + R() * 2.5) + lx * side * (0.5 + R() * 2.2), up, k.vz * 0.6 - fz * (1 + R() * 2.5) + lz * side * (0.5 + R() * 2.2), 0.3 + R() * 0.25, 0.16 + R() * 0.1, 0.4, c * 0.92, c * 0.97, c * 1.06, 0.55, 15, 0.4, k.y);
        }
        // 細霧：比較大、比較淡，留在車後
        if (R() < dt * 14 * sk) this.smoke.spawn(wx - fx * 0.6, k.y + 0.35, wz - fz * 0.6, k.vx * 0.45, 0.5, k.vz * 0.45, 0.7, 1, 3.4, c, c, c * 1.06, 0.12, -0.2, 1.5);
      }
    }

    // ---- 路緣：主線彎道上、輪子壓在最外側 1.5 公尺的紅白條紋上 ----
    if (!this.mask || branch || !this.mask[k.idx]) return;
    const s = track.samples[k.idx];
    const hw = track.halfWidth;
    const ln = lx * s.nx + lz * s.nz;
    let on = 0;
    for (const side of [1, -1]) {
      const wl = Math.abs(lat + side * 0.9 * ln);
      if (wl >= hw - 1.5 && wl <= hw + 0.3) on++;
    }
    if (!on || sp < 6) return;
    if (isPlayer) this.kerb = (on / 2) * Math.min(1, sp / 24);
    // 壓過路緣時輪下彈起一點細灰
    if (scale > 0 && R() < dt * 14 * scale) {
      const side = lat > 0 ? 1 : -1;
      const p = this.v.set(k.x + s.nx * side * 0.9, k.y + 0.1, k.z + s.nz * side * 0.9);
      this.smoke.spawn(p.x, p.y, p.z, k.vx * 0.3, 0.6 + R(), k.vz * 0.3, 0.45, 0.4, 1.6, 0.85, 0.82, 0.8, 0.28, -0.2, 1.5);
    }
  }
}
