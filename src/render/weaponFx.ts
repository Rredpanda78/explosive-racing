import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { RaceEvent } from '../game/race';
import { PRIMARY, type SecondaryId } from '../game/weapons';
import { Bits } from './bits';
import type { Particles } from './particles';

/** 每台車的武器光源狀態（只有高畫質電腦版有真的光源） */
interface Glow { flashT: number; x: number; y: number; z: number }

/**
 * 開火特效：退出來的彈殼、槍口／火焰／雷射照亮周圍的點光源（高畫質）、雷射蓄力時往槍口聚集的光點、
 * 副武器發射的煙霧與地雷落地的塵土。全部由比賽事件與車的狀態驅動，所以遠端玩家的車也一樣有。
 */
export class WeaponFx {
  group = new THREE.Group();
  private casings: Bits;
  private fire: Particles;
  private smoke: Particles;
  private lowDetail: boolean;
  /** 高畫質：固定 2 個點光源輪流給最需要的車用（數量不變，才不會讓材質重新編譯） */
  private lights: THREE.PointLight[] = [];
  private glow = new Map<Kart, Glow>();
  private shotN = 0;
  private time = 0;
  private cand: { k: Kart; i: number; r: number; g: number; b: number; x: number; y: number; z: number; s: number }[] = [];

  constructor(fire: Particles, smoke: Particles, lowDetail: boolean, lights: boolean) {
    this.fire = fire;
    this.smoke = smoke;
    this.lowDetail = lowDetail;
    // 彈殼：黃銅色小圓柱
    const geo = new THREE.CylinderGeometry(0.024, 0.024, 0.09, 6).rotateZ(Math.PI / 2);
    this.casings = new Bits(geo, new THREE.MeshLambertMaterial({ color: 0xe2ad4a, emissive: 0x3a2405 }), lowDetail ? 24 : 96, false);
    this.group.add(this.casings.mesh);
    if (lights) {
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight(0xffc070, 0, 16, 1.2);
        this.lights.push(l);
        this.group.add(l);
      }
    }
  }

  private g(k: Kart): Glow {
    let g = this.glow.get(k);
    if (!g) this.glow.set(k, (g = { flashT: 0, x: 0, y: 0, z: 0 }));
    return g;
  }

  /** 比賽事件：開槍退彈殼、閃光；副武器發射的煙 */
  onEvent(e: RaceEvent, cam: THREE.Vector3, playerId: number): void {
    const R = Math.random;
    if (e.t === 'shot') {
      const k = e.k;
      const g = this.g(k);
      g.flashT = 0.06;
      g.x = e.x; g.y = e.y; g.z = e.z;
      // 彈殼：從機匣往外側上方彈出（離鏡頭太遠就不做；低畫質每兩發一顆）
      this.shotN++;
      if (this.lowDetail && this.shotN % 2) return;
      const d2 = (e.x - cam.x) ** 2 + (e.z - cam.z) ** 2;
      if (d2 > 50 * 50 && k.id !== playerId) return;
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const lx = fz * e.side, lz = -fx * e.side;
      const out = 2.5 + R() * 2;
      this.casings.spawn(e.x - fx * 1.05, e.y + 0.05, e.z - fz * 1.05, k.vx * 0.85 + lx * out - fx * R(), 2.6 + R() * 2, k.vz * 0.85 + lz * out - fz * R(), 0.9 + R() * 0.4, k.y - k.air + 0.03, 1);
    } else if (e.t === 'rail' || e.t === 'zap' || e.t === 'pulse') {
      const g = this.g(e.k);
      g.flashT = 0.2;
      g.x = e.x; g.y = e.y; g.z = e.z;
    } else if (e.t === 'launch') {
      this.launch(e.k, e.kind);
    }
  }

  /** 副武器發射：火箭／導彈的尾焰煙與後噴、榴彈的砲口煙、地雷落地的塵土 */
  private launch(k: Kart, kind: SecondaryId): void {
    const R = Math.random;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const sm = this.smoke, f = this.fire;
    const gy = k.y - k.air;
    const n = this.lowDetail ? 0.5 : 1;
    if (kind === 'rocket' || kind === 'missile') {
      // 發射器往後噴的煙（後噴焰）
      for (let i = 0; i < 10 * n; i++) {
        const sp = 4 + R() * 6;
        sm.spawn(k.x + fx * 0.6, k.y + 1.25, k.z + fz * 0.6, k.vx * 0.5 - fx * sp + (R() - 0.5) * 3, 0.6 + R() * 1.6, k.vz * 0.5 - fz * sp + (R() - 0.5) * 3, 0.8 + R() * 0.6, 0.8, 3.6, 0.82, 0.82, 0.84, 0.5, -0.4, 1.6);
      }
      f.spawn(k.x + fx * 0.4, k.y + 1.25, k.z + fz * 0.4, k.vx, 0, k.vz, 0.12, 2.6, 0.6, 1, 0.65, 0.3, 1);
    } else if (kind === 'grenade') {
      // 榴彈：往上衝的一團砲口煙，加一圈貼地揚起的塵
      for (let i = 0; i < 12 * n; i++) {
        sm.spawn(k.x + fx * 1.2, k.y + 1.3, k.z + fz * 1.2, k.vx * 0.7 + (R() - 0.5) * 3, 3 + R() * 4, k.vz * 0.7 + (R() - 0.5) * 3, 0.9 + R() * 0.5, 0.7, 3.2, 0.75, 0.74, 0.72, 0.55, -0.5, 1.8);
      }
      f.spawn(k.x + fx * 1.2, k.y + 1.4, k.z + fz * 1.2, k.vx, 2, k.vz, 0.14, 3, 0.8, 1, 0.7, 0.3, 1);
      for (let i = 0; i < 8 * n; i++) {
        const a = (i / (8 * n)) * Math.PI * 2;
        sm.spawn(k.x + Math.cos(a) * 1.2, gy + 0.2, k.z + Math.sin(a) * 1.2, k.vx * 0.5 + Math.cos(a) * 4, 0.5, k.vz * 0.5 + Math.sin(a) * 4, 0.6, 0.8, 2.6, 0.78, 0.74, 0.66, 0.4, -0.2, 2);
      }
    } else if (kind === 'mine' || kind === 'cluster') {
      // 地雷落地：車尾地面「咚」一下揚起一圈塵土
      const x = k.x - fx * 2.3, z = k.z - fz * 2.3;
      for (let i = 0; i < 10 * n; i++) {
        const a = (i / (10 * n)) * Math.PI * 2 + R() * 0.3;
        const sp = 2.5 + R() * 2.5;
        sm.spawn(x, gy + 0.15, z, k.vx * 0.2 + Math.cos(a) * sp, 0.4 + R() * 0.8, k.vz * 0.2 + Math.sin(a) * sp, 0.6 + R() * 0.3, 0.6, 2.4, 0.8, 0.76, 0.68, 0.45, -0.2, 2.2);
      }
      for (let i = 0; i < 5 * n; i++) sm.spawn(x, gy + 0.1, z, (R() - 0.5) * 4, 2.5 + R() * 2.5, (R() - 0.5) * 4, 0.5, 0.15, 0.12, 0.3, 0.27, 0.24, 0.95, 20, 0, gy);
    }
  }

  update(dt: number, karts: readonly Kart[], cam: THREE.Vector3, player: Kart): void {
    this.time += dt;
    this.casings.update(dt);
    const R = Math.random;
    const cand = this.cand;
    cand.length = 0;
    for (const k of karts) {
      if (k.dead || k.out) continue;
      const kind = PRIMARY[k.primary].kind;
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const d2 = (k.x - cam.x) ** 2 + (k.z - cam.z) ** 2;
      // ---- 雷射蓄力：光點從四周螺旋往槍口聚集 ----
      if (kind === 'laser' && k.charge > 0 && d2 < 90 * 90) {
        const c = Math.min(1, k.charge / 0.3);
        const ox = k.x + fx * 1.6, oy = k.y + 0.95, oz = k.z + fz * 1.6;
        const lx = fz, lz = -fx;
        const n = this.lowDetail ? 1 : 3;
        for (let i = 0; i < n; i++) {
          const a = this.time * 17 + (i / n) * Math.PI * 2 + R() * 0.4;
          const r = 1.25 - c * 0.55;
          const px = (lx * Math.cos(a)) * r, py = Math.sin(a) * r, pz = (lz * Math.cos(a)) * r;
          const life = 0.16;
          // 往中心的速度加上一點切線方向，看起來是旋轉著吸進去
          const tx = -lx * Math.sin(a) * 4, ty = Math.cos(a) * 4, tz = -lz * Math.sin(a) * 4;
          this.fire.spawn(ox + px, oy + py, oz + pz, k.vx - px / life + tx, -py / life + ty, k.vz - pz / life + tz, life, 0.18 + c * 0.16, 0.06, 1, 0.35 + c * 0.3, 0.62, 1);
        }
      }
      if (!this.lights.length) continue;
      // ---- 光源候選：槍口火光、火焰、雷射蓄力與射出 ----
      const g = this.glow.get(k);
      if (g && g.flashT > 0) {
        g.flashT = Math.max(0, g.flashT - dt);
        const laser = kind === 'laser', big = laser || kind === 'arc' || kind === 'sonic';
        const u = Math.min(1, g.flashT / (big ? 0.2 : 0.06));
        if (laser) cand.push({ k, i: 10 * u, r: 1, g: 0.45, b: 0.6, x: g.x + fx * 2, y: g.y + 0.3, z: g.z + fz * 2, s: 0 });
        else if (kind === 'arc') cand.push({ k, i: 6 * u * (0.6 + R() * 0.6), r: 0.55, g: 0.75, b: 1, x: g.x + fx * 2, y: g.y + 0.3, z: g.z + fz * 2, s: 0 });
        else if (kind === 'sonic') cand.push({ k, i: 2.5 * u, r: 0.85, g: 0.5, b: 1, x: g.x + fx * 2, y: g.y + 0.3, z: g.z + fz * 2, s: 0 });
        else cand.push({ k, i: 3.5 * u, r: 1, g: 0.72, b: 0.38, x: g.x, y: g.y + 0.2, z: g.z, s: 0 });
      }
      if (kind === 'flame' && k.firing > 0) cand.push({ k, i: 3.5 * (0.65 + R() * 0.6), r: 1, g: 0.5, b: 0.16, x: k.x + fx * 3, y: k.y + 1.1, z: k.z + fz * 3, s: 0 });
      if (kind === 'freeze' && k.firing > 0) cand.push({ k, i: 2.6 * (0.85 + R() * 0.3), r: 0.45, g: 0.8, b: 1, x: k.x + fx * 3, y: k.y + 1.1, z: k.z + fz * 3, s: 0 });
      if (kind === 'laser' && k.charge > 0) {
        const c = Math.min(1, k.charge / 0.3);
        cand.push({ k, i: 0.5 + 2.6 * c * (0.85 + R() * 0.3), r: 1, g: 0.3, b: 0.5, x: k.x + fx * 1.8, y: k.y + 1.1, z: k.z + fz * 1.8, s: 0 });
      }
    }
    if (!this.lights.length) return;
    // 自己的車優先，其次是離鏡頭近、亮的
    for (const c of cand) {
      const d2 = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2;
      c.s = (c.i * (c.k === player ? 3 : 1)) / (1 + d2 / 400);
    }
    cand.sort((a, b) => b.s - a.s);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i], c = cand[i];
      if (!c || c.s < 0.05) {
        l.intensity = 0;
        continue;
      }
      l.position.set(c.x, c.y, c.z);
      l.color.setRGB(c.r, c.g, c.b);
      l.intensity = c.i;
    }
  }

  clear(): void {
    this.casings.clear();
    this.glow.clear();
    for (const l of this.lights) l.intensity = 0;
  }
}
