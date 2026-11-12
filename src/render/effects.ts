import * as THREE from 'three';
import { cloneModel, DEBRIS_MODELS } from './assets';

/** 甩尾胎痕：固定數量的四邊形循環使用，最舊的會被新的蓋掉 */
export class SkidMarks {
  mesh: THREE.Mesh;
  private pos: Float32Array;
  private max: number;
  private cursor = 0;
  private geo: THREE.BufferGeometry;
  private last = new Map<unknown, { ax: number; ay: number; az: number; bx: number; by: number; bz: number; on: boolean }[]>();

  constructor(max = 1600) {
    this.max = max;
    this.pos = new Float32Array(max * 12);
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ color: 0x0c0c0e, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * 每幀回報一顆輪子的位置。on=false 表示沒在滑，會中斷這條胎痕。
   * (lx, lz) 是車身的左向量，用來決定胎痕寬度方向。
   */
  wheel(key: unknown, i: number, on: boolean, x: number, y: number, z: number, lx: number, lz: number): void {
    let arr = this.last.get(key);
    if (!arr) {
      arr = [];
      this.last.set(key, arr);
    }
    const w = 0.17;
    const ax = x + lx * w, az = z + lz * w, bx = x - lx * w, bz = z - lz * w;
    const p = arr[i] || (arr[i] = { ax, ay: y, az, bx, by: y, bz, on: false });
    if (!on) {
      p.on = false;
      return;
    }
    if (!p.on) {
      p.ax = ax; p.ay = y; p.az = az; p.bx = bx; p.by = y; p.bz = bz;
      p.on = true;
      return;
    }
    const dx = (ax + bx) / 2 - (p.ax + p.bx) / 2, dz = (az + bz) / 2 - (p.az + p.bz) / 2;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.3) return;
    if (d2 < 30) {
      const o = this.cursor * 12;
      this.pos.set([p.ax, p.ay, p.az, p.bx, p.by, p.bz, ax, y, az, bx, y, bz], o);
      this.cursor = (this.cursor + 1) % this.max;
      this.geo.attributes.position.needsUpdate = true;
    }
    p.ax = ax; p.ay = y; p.az = az; p.bx = bx; p.by = y; p.bz = bz;
  }

  clear(): void {
    this.pos.fill(0);
    this.cursor = 0;
    this.last.clear();
    this.geo.attributes.position.needsUpdate = true;
  }
}

interface Chunk { obj: THREE.Object3D; vx: number; vy: number; vz: number; sx: number; sy: number; sz: number; life: number; ground: number; scale: number }

/** 爆炸飛出的零件（輪胎、鈑金、擾流板） */
export class Debris {
  group = new THREE.Group();
  private items: Chunk[] = [];
  private cursor = 0;

  constructor(count: number, shadows: boolean) {
    const fallback = new THREE.MeshLambertMaterial({ color: 0x555a66 });
    for (let i = 0; i < count; i++) {
      const name = DEBRIS_MODELS[i % DEBRIS_MODELS.length];
      let obj = cloneModel(name);
      let scale = 1.7;
      if (!obj) {
        obj = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.7), fallback);
        scale = 1;
      }
      if (shadows) obj.traverse((o) => { o.castShadow = true; });
      obj.visible = false;
      this.group.add(obj);
      this.items.push({ obj, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, life: 0, ground: 0, scale });
    }
  }

  burst(x: number, y: number, z: number, ground: number, n: number, power: number): void {
    const R = Math.random;
    for (let i = 0; i < n; i++) {
      const c = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.items.length;
      const a = R() * Math.PI * 2, sp = (0.4 + R() * 0.8) * power;
      c.obj.position.set(x + Math.cos(a) * 0.6, y, z + Math.sin(a) * 0.6);
      c.obj.rotation.set(R() * 6, R() * 6, R() * 6);
      c.vx = Math.cos(a) * sp; c.vz = Math.sin(a) * sp; c.vy = 6 + R() * power * 0.9;
      c.sx = (R() - 0.5) * 16; c.sy = (R() - 0.5) * 16; c.sz = (R() - 0.5) * 16;
      c.life = 2.2 + R() * 1.2;
      c.ground = ground;
      c.obj.visible = true;
      c.obj.scale.setScalar(c.scale);
    }
  }

  update(dt: number): void {
    for (const c of this.items) {
      if (c.life <= 0) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.obj.visible = false;
        continue;
      }
      c.vy -= 24 * dt;
      const p = c.obj.position;
      p.x += c.vx * dt; p.y += c.vy * dt; p.z += c.vz * dt;
      if (p.y < c.ground + 0.25) {
        p.y = c.ground + 0.25;
        if (c.vy < 0) c.vy = -c.vy * 0.38;
        c.vx *= 0.7; c.vz *= 0.7;
        c.sx *= 0.6; c.sy *= 0.6; c.sz *= 0.6;
      }
      c.obj.rotation.x += c.sx * dt;
      c.obj.rotation.y += c.sy * dt;
      c.obj.rotation.z += c.sz * dt;
      if (c.life < 0.4) c.obj.scale.setScalar(c.scale * (c.life / 0.4));
    }
  }

  clear(): void {
    for (const c of this.items) {
      c.life = 0;
      c.obj.visible = false;
    }
  }
}

interface Timed { mesh: THREE.Mesh; t: number; r: number }

/** 爆炸的火球、地面衝擊波、焦痕與閃光 */
export class BlastFx {
  group = new THREE.Group();
  light = new THREE.PointLight(0xffa040, 0, 55, 1.6);
  private balls: Timed[] = [];
  private rings: Timed[] = [];
  private scorch: Timed[] = [];
  private lightT = 1;

  constructor() {
    const ballGeo = new THREE.SphereGeometry(1, 16, 12);
    const ringGeo = new THREE.RingGeometry(0.72, 1, 40).rotateX(-Math.PI / 2);
    const scorchGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    const add = (geo: THREE.BufferGeometry, color: number, blend: THREE.Blending, list: Timed[], n: number, order: number) => {
      for (let i = 0; i < n; i++) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: blend, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
        mesh.visible = false;
        mesh.renderOrder = order;
        this.group.add(mesh);
        list.push({ mesh, t: 1, r: 1 });
      }
    };
    add(ballGeo, 0xffb040, THREE.AdditiveBlending, this.balls, 8, 12);
    add(ringGeo, 0xfff0c0, THREE.AdditiveBlending, this.rings, 8, 12);
    add(scorchGeo, 0x0a0a0a, THREE.NormalBlending, this.scorch, 12, 3);
    this.group.add(this.light);
  }

  private take(list: Timed[]): Timed {
    let best = list[0];
    for (const x of list) if (x.t > best.t) best = x;
    return best;
  }

  spawn(x: number, y: number, z: number, ground: number, r: number): void {
    const b = this.take(this.balls);
    b.t = 0; b.r = r;
    b.mesh.position.set(x, y, z);
    b.mesh.visible = true;
    const ring = this.take(this.rings);
    ring.t = 0; ring.r = r * 1.7;
    ring.mesh.position.set(x, ground + 0.12, z);
    ring.mesh.visible = true;
    const s = this.take(this.scorch);
    s.t = 0; s.r = r * 0.42;
    s.mesh.position.set(x, ground + 0.06, z);
    s.mesh.rotation.y = Math.random() * 6;
    s.mesh.scale.set(s.r, 1, s.r * (0.8 + Math.random() * 0.4));
    s.mesh.visible = true;
    this.light.position.set(x, y + 1.5, z);
    this.lightT = 0;
  }

  update(dt: number): void {
    for (const b of this.balls) {
      if (b.t >= 1) continue;
      b.t += dt / 0.3;
      const t = Math.min(1, b.t);
      const s = b.r * (0.25 + 0.75 * Math.sqrt(t));
      b.mesh.scale.setScalar(s);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
      if (t >= 1) b.mesh.visible = false;
    }
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t += dt / 0.45;
      const t = Math.min(1, r.t);
      const s = r.r * (0.15 + 0.85 * (1 - (1 - t) * (1 - t)));
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
      if (t >= 1) r.mesh.visible = false;
    }
    for (const s of this.scorch) {
      if (s.t >= 1) continue;
      s.t += dt / 9;
      const t = Math.min(1, s.t);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - t * t);
      if (t >= 1) s.mesh.visible = false;
    }
    if (this.lightT < 1) {
      this.lightT = Math.min(1, this.lightT + dt / 0.35);
      this.light.intensity = 900 * (1 - this.lightT) * (1 - this.lightT);
    } else {
      this.light.intensity = 0;
    }
  }

  clear(): void {
    for (const l of [this.balls, this.rings, this.scorch]) for (const x of l) { x.t = 1; x.mesh.visible = false; }
    this.lightT = 1;
    this.light.intensity = 0;
  }
}
