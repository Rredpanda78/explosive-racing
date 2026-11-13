import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { HitWeapon } from '../game/race';
import { Bits } from './bits';
import type { Debris } from './effects';
import { holeTexture, scorchTexture } from './fxTextures';
import type { KartView } from './kartModel';
import type { Particles } from './particles';

/** 每台車最多留幾個彈孔／焦痕（最舊的先被蓋掉） */
const PER_KART = 12;
/** 車殼表面取樣點數量（貼彈孔時從這些點裡挑最靠近彈道的） */
const SAMPLES = 600;

interface KartDecals {
  /** 車體座標的貼花矩陣與種類（0 = 彈孔、1 = 焦痕） */
  m: THREE.Matrix4[];
  type: number[];
  cursor: number;
  /** 車殼表面取樣：x, y, z, nx, ny, nz（車體座標） */
  pts: Float32Array | null;
  /** 上一次貼彈孔、焦痕的時間（限制頻率） */
  lastHole: number;
  lastScorch: number;
  lastChip: number;
}

/**
 * 受擊回饋（取代整台車閃紅）：
 * - 打中的位置噴火花與金屬碎屑
 * - 彈孔、焦痕貼在車身上（跟著車身動，重生時清掉）
 * - 依血量分段：冒白煙 → 冒黑煙、引擎蓋起火、鈑金鬆脫拖地冒火花
 * - 重擊（火箭、榴彈、導彈、地雷、衝撞）打飛一塊零件在路上彈跳
 */
export class DamageFx {
  group = new THREE.Group();
  private holes: THREE.InstancedMesh;
  private scorch: THREE.InstancedMesh;
  private chips: Bits;
  private decals = new Map<KartView, KartDecals>();
  private time = 0;
  private lowDetail: boolean;
  private fire: Particles;
  private smoke: Particles;
  private debris: () => Debris | null;
  private m4 = new THREE.Matrix4();
  private inv = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private tmp = new THREE.Matrix4();
  private n = new THREE.Vector3();
  private s = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private col = new THREE.Color();
  private metal = new THREE.Color(0.58, 0.6, 0.64);

  constructor(fire: Particles, smoke: Particles, debris: () => Debris | null, lowDetail: boolean, shadows: boolean) {
    this.fire = fire;
    this.smoke = smoke;
    this.debris = debris;
    this.lowDetail = lowDetail;
    const plane = new THREE.PlaneGeometry(1, 1);
    const mk = (map: THREE.Texture) => {
      const mat = new THREE.MeshLambertMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const m = new THREE.InstancedMesh(plane, mat, PER_KART * 12);
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 4;
      this.group.add(m);
      return m;
    };
    this.holes = mk(holeTexture());
    this.scorch = mk(scorchTexture());
    // 金屬碎屑：小薄片，顏色混合車身色與金屬灰
    this.chips = new Bits(new THREE.BoxGeometry(1, 0.25, 0.7), new THREE.MeshLambertMaterial({ color: 0xffffff }), lowDetail ? 48 : 140, true, shadows && !lowDetail);
    this.group.add(this.chips.mesh);
  }

  private rec(kv: KartView): KartDecals {
    let r = this.decals.get(kv);
    if (!r) {
      r = { m: [], type: [], cursor: 0, pts: null, lastHole: -9, lastScorch: -9, lastChip: -9 };
      this.decals.set(kv, r);
    }
    return r;
  }

  /** 車體 → 世界的矩陣（車體的父層是 group，group 直接放在場景裡） */
  private bodyMatrix(kv: KartView, out: THREE.Matrix4): THREE.Matrix4 {
    kv.group.updateMatrix();
    kv.body.updateMatrix();
    return out.multiplyMatrices(kv.group.matrix, kv.body.matrix);
  }

  /** 從車殼網格的頂點挑出一批表面取樣點（第一次貼彈孔時才算，之後沿用） */
  private samples(kv: KartView, r: KartDecals): Float32Array {
    if (r.pts) return r.pts;
    kv.body.updateMatrixWorld(true);
    this.inv.copy(kv.body.matrixWorld).invert();
    let total = 0;
    for (const m of kv.hull) total += (m.geometry.attributes.position?.count ?? 0);
    const step = Math.max(1, Math.floor(total / SAMPLES));
    const out: number[] = [];
    const rel = new THREE.Matrix4(), nm = new THREE.Matrix3(), c = new THREE.Vector3();
    for (const mesh of kv.hull) {
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos) continue;
      const nor = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined;
      rel.multiplyMatrices(this.inv, mesh.matrixWorld);
      nm.getNormalMatrix(rel);
      for (let i = Math.floor(Math.random() * step); i < pos.count; i += step) {
        this.v.fromBufferAttribute(pos, i).applyMatrix4(rel);
        if (nor) this.n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        else this.n.copy(this.v).sub(c.set(0, 0.6, 0)).normalize();
        // 車底朝下的面不用（看不到，也不會被打到）
        if (this.n.y < -0.6 || this.v.y < 0.18) continue;
        out.push(this.v.x, this.v.y, this.v.z, this.n.x, this.n.y, this.n.z);
      }
    }
    return (r.pts = new Float32Array(out));
  }

  /**
   * 在車身上貼一個彈孔（type 0）或焦痕（type 1）：從 (sx,sy,sz) 往 (tx,ty,tz) 的方向，
   * 找車殼表面第一個面向來源的取樣點。
   */
  private addDecal(kv: KartView, type: number, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, size: number): boolean {
    const r = this.rec(kv);
    const pts = this.samples(kv, r);
    if (!pts.length) return false;
    this.inv.copy(this.bodyMatrix(kv, this.m4)).invert();
    const src = this.a.set(sx, sy, sz).applyMatrix4(this.inv);
    const tgt = this.b.set(tx, ty, tz).applyMatrix4(this.inv);
    const d = this.dir.subVectors(tgt, src);
    const len = d.length();
    if (len < 1e-4) return false;
    d.divideScalar(len);
    // 起點放在目標前方 6 公尺，避免來源太近時從車身裡面開始找
    const o = src.copy(tgt).addScaledVector(d, -6);
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < pts.length; i += 6) {
      const dot = pts[i + 3] * d.x + pts[i + 4] * d.y + pts[i + 5] * d.z;
      if (dot > -0.2) continue;
      const px = pts[i] - o.x, py = pts[i + 1] - o.y, pz = pts[i + 2] - o.z;
      const along = px * d.x + py * d.y + pz * d.z;
      if (along < 0) continue;
      const perp2 = px * px + py * py + pz * pz - along * along;
      // 離彈道越近越好；同樣近時選比較前面（外面）的
      const score = perp2 + along * 0.02;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 || bestScore > 1.6) return false;
    this.n.set(pts[best + 3], pts[best + 4], pts[best + 5]);
    this.q.setFromUnitVectors(this.zAxis, this.n);
    this.q2.setFromAxisAngle(this.zAxis, Math.random() * Math.PI * 2);
    this.q.multiply(this.q2);
    const p = this.v.set(pts[best], pts[best + 1], pts[best + 2]).addScaledVector(this.n, 0.012);
    const sc = size * (0.8 + Math.random() * 0.4);
    const m = new THREE.Matrix4().compose(p, this.q, this.s.set(sc, sc, sc));
    if (r.m.length < PER_KART) {
      r.m.push(m);
      r.type.push(type);
    } else {
      r.m[r.cursor] = m;
      r.type[r.cursor] = type;
      r.cursor = (r.cursor + 1) % PER_KART;
    }
    return true;
  }

  /** 金屬碎屑：顏色在車身色與金屬灰之間 */
  private chipBurst(k: Kart, x: number, y: number, z: number, n: number, power: number, dx = 0, dz = 0): void {
    const R = Math.random;
    if (this.lowDetail) n = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2;
      const sp = (0.3 + R()) * power;
      this.col.set(k.color).lerp(this.metal, 0.3 + R() * 0.6);
      this.chips.spawn(x, y, z, k.vx * 0.6 + Math.cos(a) * sp + dx * power, 2 + R() * power * 0.8, k.vz * 0.6 + Math.sin(a) * sp + dz * power, 0.9 + R() * 0.7, k.y - k.air + 0.04, 0.07 + R() * 0.09, this.col);
    }
  }

  private sparks(x: number, y: number, z: number, n: number, speed: number, ground: number, vx: number, vz: number): void {
    const R = Math.random;
    for (let i = 0; i < n; i++) {
      this.fire.spawn(x, y, z, vx + (R() - 0.5) * speed, 1.5 + R() * speed * 0.5, vz + (R() - 0.5) * speed, 0.2 + R() * 0.3, 0.45, 0.07, 1, 0.82, 0.45, 1, 20, 0, ground);
    }
  }

  /**
   * 主武器打中：by 是開火的車（決定彈孔方向），(x,y,z) 是命中點。
   * 子彈：火花 + 碎屑 + 彈孔；火焰：零星火星 + 焦痕；雷射：大把火花 + 一串焦痕
   */
  hit(k: Kart, kv: KartView, by: Kart, w: HitWeapon, x: number, y: number, z: number): void {
    const r = this.rec(kv);
    const R = Math.random;
    const g = k.y - k.air;
    if (w === 'gun') {
      if (this.time - r.lastChip > 0.05) {
        r.lastChip = this.time;
        this.chipBurst(k, x, y, z, 2, 4);
      }
      if (this.time - r.lastHole > 0.08) {
        r.lastHole = this.time;
        // 子彈散布：命中點附近隨機偏一點，彈孔才不會全部疊在同一個位置
        this.addDecal(kv, 0, by.x, by.y + 0.95, by.z, x + (R() - 0.5) * 0.9, y + (R() - 0.5) * 0.6, z + (R() - 0.5) * 0.9, 0.26);
      }
    } else if (w === 'flame') {
      if (R() < 0.35) this.fire.spawn(x + (R() - 0.5) * 1.6, y + (R() - 0.3), z + (R() - 0.5) * 1.6, k.vx * 0.8, 2 + R() * 2, k.vz * 0.8, 0.35, 0.5, 0.1, 1, 0.55, 0.15, 1, 6, 0, g);
      if (this.time - r.lastScorch > 0.45) {
        r.lastScorch = this.time;
        this.addDecal(kv, 1, by.x, by.y + 0.8, by.z, x + (R() - 0.5) * 1.6, y + (R() - 0.6) * 0.7, z + (R() - 0.5) * 1.6, 0.75);
      }
    } else if (w === 'arc') {
      // 電弧：小小的電灼焦痕
      if (this.time - r.lastScorch > 0.3) {
        r.lastScorch = this.time;
        this.addDecal(kv, 1, by.x, by.y + 0.95, by.z, x + (R() - 0.5) * 1.2, y + (R() - 0.5) * 0.5, z + (R() - 0.5) * 1.2, 0.45);
      }
    } else if (w === 'freeze') {
      // 冷凍光束：不留痕跡（車身結霜由 KartView 表現）
    } else if (w === 'sonic') {
      if (this.time - r.lastChip > 0.2) {
        r.lastChip = this.time;
        this.chipBurst(k, x, y, z, 2, 5);
      }
    } else if (w === 'harpoon') {
      // 魚叉：碎屑 + 一個孔
      this.chipBurst(k, x, y, z, 4, 5);
      this.addDecal(kv, 0, by.x, by.y + 0.95, by.z, x, y, z, 0.34);
    } else {
      // 雷射：一整道燒穿的焦痕
      this.chipBurst(k, x, y, z, 6, 7);
      for (let i = 0; i < 3; i++) this.addDecal(kv, 1, by.x, by.y + 0.95, by.z, x + (R() - 0.5), y + (R() - 0.5) * 0.4, z + (R() - 0.5), 0.6);
      this.addDecal(kv, 0, by.x, by.y + 0.95, by.z, x, y, z, 0.42);
    }
  }

  /** 爆炸波及（火箭、榴彈、導彈、地雷）：大把碎屑、焦痕、打飛一塊零件 */
  blast(k: Kart, kv: KartView, bx: number, by: number, bz: number, power: number): void {
    const dx = k.x - bx, dz = k.z - bz;
    const d = Math.max(0.5, Math.hypot(dx, dz));
    const ux = dx / d, uz = dz / d;
    const y = k.y + 0.8;
    this.chipBurst(k, k.x - ux * 0.8, y, k.z - uz * 0.8, Math.round(8 + power * 6), 6 + power * 4, ux * 0.5, uz * 0.5);
    this.sparks(k.x - ux, y, k.z - uz, Math.round(6 + power * 8), 14, k.y - k.air, k.vx * 0.5, k.vz * 0.5);
    for (let i = 0; i < 2; i++) this.addDecal(kv, 1, bx, by + 0.3, bz, k.x + (Math.random() - 0.5) * 1.4, y + (Math.random() - 0.5) * 0.5, k.z + (Math.random() - 0.5) * 1.4, 0.9 + power * 0.3);
    if (power > 0.35) this.knockPart(k, ux, uz, 7 + power * 6);
  }

  /** 衝撞：撞擊點的碎屑，夠大力就掉一塊零件 */
  ram(k: Kart, kv: KartView, x: number, y: number, z: number, power: number, other: Kart): void {
    const dx = k.x - other.x, dz = k.z - other.z;
    const d = Math.max(0.5, Math.hypot(dx, dz));
    this.chipBurst(k, x, y, z, Math.min(8, 2 + Math.round(power * 0.5)), 3 + power * 0.4);
    if (power > 9 && Math.random() < 0.6) this.knockPart(k, dx / d, dz / d, 5 + power * 0.4);
    if (power > 6) this.addDecal(kv, 1, other.x, other.y + 0.7, other.z, x, y, z, 0.5);
  }

  /** 打飛一塊零件（輪胎、鈑金、擾流板的模型）：往遠離來源的方向飛出、在路上彈跳 */
  private knockPart(k: Kart, ux: number, uz: number, power: number): void {
    this.debris()?.burst(k.x + ux * 0.6, k.y + 0.9, k.z + uz * 0.6, k.y - k.air, 1, power, ux, uz);
  }

  /** 換到新的一條命（重生）：清掉這台車的彈孔與焦痕 */
  clearKart(kv: KartView): void {
    const r = this.decals.get(kv);
    if (!r) return;
    r.m.length = 0;
    r.type.length = 0;
    r.cursor = 0;
  }

  clear(): void {
    this.decals.clear();
    this.chips.clear();
    this.holes.count = this.scorch.count = 0;
  }

  /** 每幀：貼花跟著車身、碎屑物理、依血量冒煙起火與鬆脫的鈑金 */
  update(dt: number, karts: readonly Kart[], views: Map<Kart, KartView>, cam: THREE.Vector3): void {
    this.time += dt;
    this.chips.update(dt);
    let nh = 0, ns = 0;
    const R = Math.random;
    for (const k of karts) {
      const kv = views.get(k);
      if (!kv) continue;
      // 損壞階段：60% 以下冒白煙，30% 以下冒黑煙、引擎蓋起火、鈑金鬆脫
      const hpR = k.dead ? 1 : k.hp / Math.max(1, k.maxHp);
      kv.damageStage = k.dead || k.out ? 0 : hpR < 0.3 ? 2 : hpR < 0.6 ? 1 : 0;
      if (kv.damageStage > 0 && kv.group.visible) {
        const far = this.v.set(k.x, k.y, k.z).distanceToSquared(cam) > 110 * 110;
        if (!far) this.damageSmoke(k, kv, dt, R);
      }
      const r = this.decals.get(kv);
      if (!r || !r.m.length || !kv.group.visible) continue;
      this.bodyMatrix(kv, this.m4);
      for (let i = 0; i < r.m.length; i++) {
        this.tmp.multiplyMatrices(this.m4, r.m[i]);
        if (r.type[i] === 0) this.holes.setMatrixAt(nh++, this.tmp);
        else this.scorch.setMatrixAt(ns++, this.tmp);
      }
    }
    this.holes.count = nh;
    this.scorch.count = ns;
    if (nh) this.holes.instanceMatrix.needsUpdate = true;
    if (ns) this.scorch.instanceMatrix.needsUpdate = true;
  }

  private damageSmoke(k: Kart, kv: KartView, dt: number, R: () => number): void {
    const M = kv.mounts;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hx = k.x + fx * M.hoodZ, hz = k.z + fz * M.hoodZ, hy = k.y + M.hoodY;
    const sm = this.smoke, f = this.fire;
    const heavy = kv.damageStage >= 2;
    const rate = (heavy ? 34 : 14) * (this.lowDetail ? 0.6 : 1);
    const n = Math.floor(dt * rate + R());
    for (let i = 0; i < n; i++) {
      // 輕傷淡灰煙、重傷濃黑煙：先跟著車跑一下再被風吹散（車速快時才看得到一條煙尾）
      const c = heavy ? 0.07 : 0.62;
      sm.spawn(hx + (R() - 0.5) * 0.5, hy, hz + (R() - 0.5) * 0.5, k.vx * 0.72 - fx * 1.2, 1.2 + R() * 1.2, k.vz * 0.72 - fz * 1.2, heavy ? 1.1 : 0.85, 0.8, heavy ? 3.8 : 2.8, c, c, c + 0.02, heavy ? 0.78 : 0.38, -0.8, 1.4);
    }
    if (!heavy) return;
    // 引擎蓋冒出的小火舌
    if (R() < dt * 34) f.spawn(hx + (R() - 0.5) * 0.6, hy + 0.05, hz + (R() - 0.5) * 0.6, k.vx * 0.9, 1.2 + R() * 1.5, k.vz * 0.9, 0.3, 0.8, 0.2, 1, 0.48 + R() * 0.2, 0.1, 0.9);
    // 鬆脫的鈑金拖地：車速夠快時從下緣噴火花
    if (Math.abs(k.speed) > 8 && R() < dt * 26 && kv.panelTip(this.v2)) {
      const gy = k.y - k.air;
      if (this.v2.y - gy < 0.45) {
        for (let i = 0; i < 2; i++) f.spawn(this.v2.x, gy + 0.08, this.v2.z, k.vx * 0.55 + (R() - 0.5) * 4, 1 + R() * 3, k.vz * 0.55 + (R() - 0.5) * 4, 0.25 + R() * 0.2, 0.4, 0.06, 1, 0.75, 0.3, 1, 18, 0, gy);
      }
    }
  }
}
