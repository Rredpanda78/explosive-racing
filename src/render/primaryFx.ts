import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { Race, RaceEvent } from '../game/race';
import { PRIMARY } from '../game/weapons';
import type { KartView } from './kartModel';
import type { Particles } from './particles';
import { buildHarpoonSpear } from './weaponModels';

/** 沿 +Z、長度 1 的細圓柱：電弧與繩子的一小段（用實例的縮放拉長） */
const segGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const ringGeo = new THREE.TorusGeometry(1, 0.06, 6, 48);

const MAX_BOLT_SEG = 420;
const MAX_ROPE_SEG = 16 * 14;
const ROPE_SEGS = 14;
const SPEARS = 12;
const RINGS = 12;
const BOLT_LIFE = 0.16;
const RING_LIFE = 0.32;

/** 一次放電：從開火的車的槍口依序連到被電到的車（沒電到人就往前劈一道） */
interface Bolt { k: Kart; chain: Kart[]; len: number; t: number }
/** 一圈震波：從槍口往前擴散 */
interface Ring { x: number; y: number; z: number; a: number; r: number; w: number; t: number; delay: number; thin: boolean; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }

/**
 * 功能型主武器的畫面效果（全部由比賽事件與車的狀態驅動，所以遠端的車也一樣有）：
 * 電弧槍的鋸齒閃電與電火花、音波炮往前擴散的震波圈、魚叉鉤飛行中的魚叉與繩子（叉住後插在對方車上）、
 * 冷凍光束沿路的冰晶與結冰車身上的霜氣
 */
export class PrimaryFx {
  group = new THREE.Group();
  private fire: Particles;
  private smoke: Particles;
  private lowDetail: boolean;
  private boltCore: THREE.InstancedMesh;
  private boltGlow: THREE.InstancedMesh;
  private bolts: Bolt[] = [];
  private rings: Ring[] = [];
  private rope: THREE.InstancedMesh;
  /** 飛行中與插在車上的魚叉 */
  private spears: THREE.Object3D[] = [];
  /** 剛被電到的車：身上繼續劈啪冒電火花的剩餘秒數 */
  private zapped = new Map<Kart, number>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private zAxis = new THREE.Vector3(0, 0, 1);
  private col = new THREE.Color();
  private pts: THREE.Vector3[] = [];
  private nb = 0;
  private nr = 0;
  private time = 0;

  constructor(fire: Particles, smoke: Particles, lowDetail: boolean) {
    this.fire = fire;
    this.smoke = smoke;
    this.lowDetail = lowDetail;
    const additive = (c: THREE.Color, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
    this.boltCore = new THREE.InstancedMesh(segGeo, additive(new THREE.Color(1, 1, 1), 1), MAX_BOLT_SEG);
    this.boltGlow = new THREE.InstancedMesh(segGeo, additive(new THREE.Color(1, 1, 1), 0.35), MAX_BOLT_SEG);
    for (const m of [this.boltCore, this.boltGlow]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, this.col.setRGB(1, 1, 1));
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 8;
      this.group.add(m);
    }
    // 繩子用醒目的橘黃色（船用纜繩），在柏油路上才看得清楚
    this.rope = new THREE.InstancedMesh(segGeo, new THREE.MeshLambertMaterial({ color: 0xffa31a, emissive: 0x6a3200 }), MAX_ROPE_SEG);
    this.rope.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rope.count = 0;
    this.rope.frustumCulled = false;
    this.group.add(this.rope);
    for (let i = 0; i < RINGS; i++) {
      const mat = additive(new THREE.Color(1.3, 0.75, 1.9), 0);
      mat.side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.rings.push({ x: 0, y: 0, z: 0, a: 0, r: 0, w: 0, t: 1, delay: 0, thin: false, mesh, mat });
    }
    for (let i = 0; i < SPEARS; i++) {
      const sp = buildHarpoonSpear();
      sp.scale.setScalar(1.3);
      sp.visible = false;
      this.group.add(sp);
      this.spears.push(sp);
    }
    for (let i = 0; i < 64; i++) this.pts.push(new THREE.Vector3());
  }

  onEvent(e: RaceEvent, race: Race, views: Map<Kart, KartView>): void {
    const R = Math.random, f = this.fire, sm = this.smoke;
    switch (e.t) {
      case 'zap': {
        views.get(e.k)?.zapFlash();
        this.bolts.push({ k: e.k, chain: e.chain.slice(), len: e.len, t: 0 });
        // 槍口：一小把電藍色火花
        for (let i = 0; i < (this.lowDetail ? 3 : 6); i++) f.spawn(e.x, e.y, e.z, e.k.vx + (R() - 0.5) * 8, (R() - 0.2) * 5, e.k.vz + (R() - 0.5) * 8, 0.12 + R() * 0.1, 0.35, 0.05, 0.55, 0.8, 1, 1);
        f.spawn(e.x, e.y, e.z, e.k.vx, 0, e.k.vz, 0.08, 2.4, 0.6, 0.5, 0.7, 1, 0.9);
        // 沒電到人：電弧盡頭劈在地上
        if (!e.chain.length) {
          const fx = Math.sin(e.k.heading), fz = Math.cos(e.k.heading);
          const x = e.x + fx * e.len, z = e.z + fz * e.len;
          for (let i = 0; i < 4; i++) f.spawn(x, e.y - 0.6, z, (R() - 0.5) * 6, 2 + R() * 3, (R() - 0.5) * 6, 0.25, 0.3, 0.05, 0.6, 0.85, 1, 1, 14, 0, e.k.y - e.k.air);
        }
        break;
      }
      case 'pulse': {
        views.get(e.k)?.pulseKick();
        let n = 0;
        for (const r of this.rings) {
          if (r.t < 1 || n >= 2) continue;
          r.x = e.x; r.y = e.y; r.z = e.z; r.a = e.a; r.r = e.r; r.w = e.w;
          r.t = 0;
          r.delay = n * 0.05;
          r.thin = n > 0;
          n++;
        }
        // 震波掃過路面揚起的塵土
        const gy = e.k.y - e.k.air;
        const cnt = this.lowDetail ? 4 : 9;
        for (let i = 0; i < cnt; i++) {
          const d = 3 + R() * (e.r - 3), a = e.a + (R() * 2 - 1) * e.w;
          const dx = Math.sin(a), dz = Math.cos(a);
          sm.spawn(e.x + dx * d, gy + 0.25, e.z + dz * d, e.k.vx * 0.5 + dx * 5, 0.8 + R(), e.k.vz * 0.5 + dz * 5, 0.5 + R() * 0.3, 0.8, 2.6, 0.82, 0.8, 0.78, 0.28, -0.3, 2);
        }
        break;
      }
      case 'hook': {
        // 氣動發射：槍口一團白色氣體
        for (let i = 0; i < (this.lowDetail ? 3 : 6); i++) sm.spawn(e.x, e.y, e.z, e.k.vx * 0.8 + (R() - 0.5) * 3, 0.5 + R(), e.k.vz * 0.8 + (R() - 0.5) * 3, 0.45, 0.5, 1.8, 0.92, 0.92, 0.95, 0.45, -0.3, 2);
        break;
      }
      case 'tether': {
        const v = e.v;
        if (e.on) {
          for (let i = 0; i < 8; i++) f.spawn(v.x, v.y + 0.9, v.z, v.vx + (R() - 0.5) * 9, 1 + R() * 4, v.vz + (R() - 0.5) * 9, 0.3, 0.4, 0.06, 1, 0.8, 0.4, 1, 18, 0, v.y - v.air);
        } else if (e.why === 'snap') {
          // 繩子扯斷：中間甩出幾段纖維
          const x = (e.k.x + v.x) / 2, z = (e.k.z + v.z) / 2;
          for (let i = 0; i < 6; i++) sm.spawn(x, e.k.y + 1, z, (R() - 0.5) * 6, 1 + R() * 2, (R() - 0.5) * 6, 0.5, 0.25, 0.12, 0.7, 0.6, 0.45, 0.9, 10, 0, e.k.y - e.k.air);
        }
        break;
      }
      case 'hit': {
        const k = e.k;
        const g = k.y - k.air;
        if (e.w === 'arc') {
          // 電到：電藍白色火花往四周噴，之後車身繼續劈啪一下
          for (let i = 0; i < (this.lowDetail ? 6 : 12); i++) f.spawn(e.x, e.y, e.z, k.vx * 0.6 + (R() - 0.5) * 14, 1 + R() * 6, k.vz * 0.6 + (R() - 0.5) * 14, 0.2 + R() * 0.25, 0.35, 0.05, 0.6, 0.85, 1, 1, 16, 0, g);
          f.spawn(e.x, e.y, e.z, k.vx, 0, k.vz, 0.1, 3.4, 0.8, 0.55, 0.75, 1, 0.9);
          this.zapped.set(k, 0.4);
        } else if (e.w === 'freeze') {
          // 冰晶碎屑（帶重力、會掉到地上）
          if (R() < 0.6) f.spawn(e.x, e.y, e.z, k.vx * 0.8 + (R() - 0.5) * 4, 1 + R() * 2, k.vz * 0.8 + (R() - 0.5) * 4, 0.4, 0.22, 0.08, 0.75, 0.95, 1, 1, 12, 0, g);
          if (R() < 0.25) sm.spawn(e.x, e.y, e.z, k.vx * 0.7, 0.5, k.vz * 0.7, 0.6, 0.6, 2, 0.88, 0.95, 1, 0.35, -0.3, 1.5);
        } else if (e.w === 'sonic') {
          // 被震到：一團白色衝擊氣與灰塵
          f.spawn(e.x, e.y, e.z, k.vx, 0, k.vz, 0.1, 2, 0.6, 0.9, 0.7, 1, 0.6);
          for (let i = 0; i < 5; i++) sm.spawn(e.x, g + 0.3, e.z, k.vx * 0.6 + (R() - 0.5) * 5, 0.8 + R(), k.vz * 0.6 + (R() - 0.5) * 5, 0.5, 0.6, 2.2, 0.85, 0.83, 0.8, 0.4, -0.3, 2);
        } else if (e.w === 'harpoon') {
          for (let i = 0; i < 8; i++) f.spawn(e.x, e.y, e.z, k.vx * 0.5 + (R() - 0.5) * 12, 1 + R() * 5, k.vz * 0.5 + (R() - 0.5) * 12, 0.3, 0.4, 0.06, 1, 0.8, 0.4, 1, 20, 0, g);
        }
        break;
      }
    }
  }

  update(dt: number, race: Race, cam: THREE.Vector3): void {
    this.time += dt;
    this.nb = 0;
    this.nr = 0;
    this.updateBolts(dt);
    this.updateRings(dt);
    this.updateHarpoons(race);
    this.updateFrost(dt, race, cam);
    for (const m of [this.boltCore, this.boltGlow]) {
      m.count = this.nb;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.rope.count = this.nr;
    this.rope.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------

  /** 一小段（a → b）：放進實例清單 */
  private seg(mesh: THREE.InstancedMesh, i: number, a: THREE.Vector3, b: THREE.Vector3, r: number): void {
    const v = this.v.subVectors(b, a);
    const len = v.length();
    if (len < 1e-4) v.set(0, 0, 1);
    this.q.setFromUnitVectors(this.zAxis, v.normalize());
    this.m4.compose(a, this.q, this.s.set(r, r, Math.max(0.01, len)));
    mesh.setMatrixAt(i, this.m4);
  }

  /** 一道鋸齒閃電：a → b 之間切成幾段、中間的點隨機往旁邊抖（每幀重抖，看起來在閃） */
  private bolt(a: THREE.Vector3, b: THREE.Vector3, fade: number, fork: boolean): void {
    const d = a.distanceTo(b);
    const n = Math.max(3, Math.min(12, Math.round(d / 1.5)));
    const amp = Math.min(0.9, 0.15 + d * 0.05);
    const P = this.pts;
    P[0].copy(a);
    for (let i = 1; i < n; i++) {
      const u = i / n, s = Math.sin(Math.PI * u) * amp;
      P[i].lerpVectors(a, b, u);
      P[i].x += (Math.random() * 2 - 1) * s;
      P[i].y += (Math.random() * 2 - 1) * s * 0.7;
      P[i].z += (Math.random() * 2 - 1) * s;
    }
    P[n].copy(b);
    let last = n;
    // 分岔：從中間某一點往旁邊劈出一小段
    if (fork && n > 3 && Math.random() < 0.7) {
      const j = 1 + Math.floor(Math.random() * (n - 2));
      P[n + 1].copy(P[j]);
      P[n + 2].set(P[j].x + (Math.random() - 0.5) * 2.4, P[j].y + (Math.random() - 0.3) * 1.2, P[j].z + (Math.random() - 0.5) * 2.4);
      last = n + 2;
    }
    for (let i = 0; i < last; i++) {
      if (i === n) continue; // 分岔的起點不跟主幹的終點相連
      if (this.nb >= MAX_BOLT_SEG) return;
      const isFork = i > n;
      const w = (isFork ? 0.5 : 1) * fade;
      this.seg(this.boltCore, this.nb, P[i], P[i + 1], 0.055 * (0.6 + 0.4 * fade));
      this.seg(this.boltGlow, this.nb, P[i], P[i + 1], 0.26 * (0.7 + 0.3 * fade));
      this.boltCore.setColorAt(this.nb, this.col.setRGB(1.6 * w, 1.9 * w, 2.4 * w));
      this.boltGlow.setColorAt(this.nb, this.col.setRGB(0.35 * w, 0.55 * w, 1.6 * w));
      this.nb++;
    }
  }

  private updateBolts(dt: number): void {
    const A = this.pts[50], B = this.pts[51];
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const bo = this.bolts[i];
      bo.t += dt;
      if (bo.t >= BOLT_LIFE || bo.k.dead) {
        this.bolts.splice(i, 1);
        continue;
      }
      // 一閃一閃：前半亮、後半忽明忽暗
      const u = bo.t / BOLT_LIFE;
      const fade = (1 - u * 0.6) * (u > 0.4 && Math.random() < 0.35 ? 0.35 : 1);
      const k = bo.k, fx = Math.sin(k.heading), fz = Math.cos(k.heading), lx = fz, lz = -fx;
      // 兩把槍口各劈出一道，在第一個目標（或電弧盡頭）會合，接著一路跳下去
      const c0 = bo.chain[0];
      if (c0) B.set(c0.x, c0.y + 0.85, c0.z);
      else B.set(k.x + fx * (bo.len + 1.3), k.y + 0.45, k.z + fz * (bo.len + 1.3));
      for (const side of [1, -1]) {
        A.set(k.x + fx * 1.35 + lx * 0.7 * side, k.y + 0.95, k.z + fz * 1.35 + lz * 0.7 * side);
        this.bolt(A, B, fade, true);
      }
      for (let j = 1; j < bo.chain.length; j++) {
        const c = bo.chain[j];
        A.copy(B);
        B.set(c.x, c.y + 0.85, c.z);
        this.bolt(A, B, fade, true);
      }
    }
  }

  private updateRings(dt: number): void {
    for (const r of this.rings) {
      if (r.t >= 1) {
        r.mesh.visible = false;
        continue;
      }
      if (r.delay > 0) {
        r.delay -= dt;
        r.mesh.visible = false;
        continue;
      }
      r.t = Math.min(1, r.t + dt / RING_LIFE);
      const u = r.t;
      const d = r.r * (1 - (1 - u) * (1 - u));
      const rad = 0.6 + d * Math.tan(r.w);
      const fx = Math.sin(r.a), fz = Math.cos(r.a);
      r.mesh.visible = r.t < 1;
      r.mesh.position.set(r.x + fx * d, r.y, r.z + fz * d);
      r.mesh.rotation.set(0, r.a, 0);
      r.mesh.scale.set(rad, rad * 0.75, (r.thin ? 0.5 : 1) * (1 + rad * 0.4));
      r.mat.opacity = (r.thin ? 0.4 : 0.85) * (1 - u * u);
    }
  }

  /** 從開火的車的槍口（side 那一側）到 b 的一條繩子：sag = 下垂的公尺數 */
  private ropeLine(k: Kart, side: number, b: THREE.Vector3, sag: number): void {
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const a = this.pts[40].set(k.x + fz * 0.7 * side + fx * 1.5, k.y + 1.0, k.z - fx * 0.7 * side + fz * 1.5);
    const p0 = this.pts[41], p1 = this.pts[42];
    p0.copy(a);
    for (let i = 1; i <= ROPE_SEGS; i++) {
      if (this.nr >= MAX_ROPE_SEG) return;
      const u = i / ROPE_SEGS;
      p1.lerpVectors(a, b, u);
      p1.y -= sag * 4 * u * (1 - u);
      this.seg(this.rope, this.nr++, p0, p1, 0.075);
      p0.copy(p1);
    }
  }

  /** 飛行中的魚叉（後面拖著繩子）與叉住的繩子、插在對方車上的魚叉 */
  private updateHarpoons(race: Race): void {
    let ns = 0;
    const B = this.pts[52];
    for (const h of race.hooks) {
      if (ns >= SPEARS) break;
      const sp = this.spears[ns++];
      const hs = Math.hypot(h.vx, h.vz);
      sp.visible = true;
      sp.position.set(h.x, h.y, h.z);
      sp.rotation.set(-Math.atan2(h.vy, hs), Math.atan2(h.vx, h.vz), 0, 'YXZ');
      const fx = h.vx / hs, fz = h.vz / hs;
      B.set(h.x - fx * 0.2, h.y, h.z - fz * 0.2);
      if (!h.owner.dead) this.ropeLine(h.owner, h.side, B, 0.5);
    }
    for (const k of race.karts) {
      const t = k.tether;
      if (!t || k.dead || t.dead) continue;
      // 插在對方車身朝向自己的那一側
      const dx = k.x - t.x, dz = k.z - t.z;
      const d = Math.max(0.1, Math.hypot(dx, dz));
      B.set(t.x + (dx / d) * 1.0, t.y + 0.85, t.z + (dz / d) * 1.0);
      // 拉緊的繩子幾乎不垂，微微震動
      this.ropeLine(k, k.gunSide, B, 0.08 + 0.06 * Math.sin(this.time * 37 + k.id));
      if (ns < SPEARS) {
        const sp = this.spears[ns++];
        sp.visible = true;
        // 魚叉的尖端插進車身：桿尾露在外面、朝向開火的人
        const ux = -dx / d, uz = -dz / d;
        sp.position.set(B.x - ux * 0.75, B.y, B.z - uz * 0.75);
        sp.rotation.set(0, Math.atan2(ux, uz), 0, 'YXZ');
      }
    }
    for (let i = ns; i < SPEARS; i++) this.spears[i].visible = false;
  }

  /** 冷凍光束沿路的冰晶、命中處的霧氣；結冰的車身冒寒氣、亮晶晶；剛被電到的車劈啪冒電火花 */
  private updateFrost(dt: number, race: Race, cam: THREE.Vector3): void {
    const R = Math.random, f = this.fire, sm = this.smoke;
    const k2 = this.lowDetail ? 0.5 : 1;
    for (const k of race.karts) {
      if (k.dead || k.out) continue;
      const near = (k.x - cam.x) ** 2 + (k.z - cam.z) ** 2 < 120 * 120;
      if (!near) continue;
      const g = k.y - k.air;
      if (k.firing > 0 && PRIMARY[k.primary].kind === 'freeze') {
        const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
        const len = Math.max(1, k.beamLen);
        for (let i = 0; i < 3 * k2; i++) {
          const t = 1.6 + R() * len;
          f.spawn(k.x + fx * t + (R() - 0.5) * 0.5, k.y + 0.95 + (R() - 0.5) * 0.4, k.z + fz * t + (R() - 0.5) * 0.5, k.vx * 0.9 + (R() - 0.5), (R() - 0.5), k.vz * 0.9 + (R() - 0.5), 0.3, 0.18, 0.04, 0.7, 0.95, 1, 0.9);
        }
        if (k.beamHit && R() < dt * 30) {
          const x = k.x + fx * (len + 0.2), z = k.z + fz * (len + 0.2);
          sm.spawn(x, k.y + 0.9, z, k.vx * 0.8, 0.4, k.vz * 0.8, 0.5, 0.8, 2.4, 0.85, 0.95, 1, 0.3, -0.2, 1.5);
        }
      }
      if (k.chill > 0.12 && R() < dt * 28 * k.chill * k2) {
        // 結冰：車身上的亮晶晶與往下沉的寒氣
        f.spawn(k.x + (R() - 0.5) * 1.8, k.y + 0.4 + R() * 0.9, k.z + (R() - 0.5) * 2.4, k.vx, 0.3, k.vz, 0.35, 0.16, 0.02, 0.8, 0.95, 1, 0.9);
        sm.spawn(k.x + (R() - 0.5) * 1.6, g + 0.3, k.z + (R() - 0.5) * 2.2, k.vx * 0.7, -0.2, k.vz * 0.7, 0.8, 0.5, 2.2, 0.9, 0.96, 1, 0.22 * k.chill, 0, 1.4);
      }
      const z = this.zapped.get(k);
      if (z !== undefined) {
        const left = z - dt;
        if (left <= 0) this.zapped.delete(k);
        else {
          this.zapped.set(k, left);
          if (R() < dt * 40) f.spawn(k.x + (R() - 0.5) * 1.6, k.y + 0.3 + R() * 1.0, k.z + (R() - 0.5) * 2.2, k.vx + (R() - 0.5) * 6, R() * 3, k.vz + (R() - 0.5) * 6, 0.1, 0.3, 0.05, 0.6, 0.85, 1, 1);
        }
      }
    }
  }

  clear(): void {
    this.bolts.length = 0;
    this.zapped.clear();
    for (const r of this.rings) { r.t = 1; r.mesh.visible = false; }
    for (const s of this.spears) s.visible = false;
    this.boltCore.count = this.boltGlow.count = this.rope.count = 0;
  }
}
