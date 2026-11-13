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
      const o = this.cursor * 12, P = this.pos;
      P[o] = p.ax; P[o + 1] = p.ay; P[o + 2] = p.az; P[o + 3] = p.bx; P[o + 4] = p.by; P[o + 5] = p.bz;
      P[o + 6] = ax; P[o + 7] = y; P[o + 8] = az; P[o + 9] = bx; P[o + 10] = y; P[o + 11] = bz;
      this.cursor = (this.cursor + 1) % this.max;
      // 只上傳新加的這一段（整個緩衝區有 77 KB）
      const a = this.geo.attributes.position as THREE.BufferAttribute;
      a.addUpdateRange(o, 12);
      a.needsUpdate = true;
    }
    p.ax = ax; p.ay = y; p.az = az; p.bx = bx; p.by = y; p.bz = bz;
  }

  clear(): void {
    this.pos.fill(0);
    this.cursor = 0;
    this.last.clear();
    const a = this.geo.attributes.position as THREE.BufferAttribute;
    a.clearUpdateRanges();
    a.needsUpdate = true;
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

  /** (dx, dz)：指定時零件偏往這個方向飛（被打飛的零件往遠離攻擊的方向掉） */
  burst(x: number, y: number, z: number, ground: number, n: number, power: number, dx = 0, dz = 0): void {
    const R = Math.random;
    const aim = dx !== 0 || dz !== 0;
    for (let i = 0; i < n; i++) {
      const c = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.items.length;
      const a = aim ? Math.atan2(dz, dx) + (R() - 0.5) * 1.2 : R() * Math.PI * 2, sp = (0.4 + R() * 0.8) * power;
      c.obj.position.set(x + Math.cos(a) * 0.6, y, z + Math.sin(a) * 0.6);
      c.obj.rotation.set(R() * 6, R() * 6, R() * 6);
      c.vx = Math.cos(a) * sp; c.vz = Math.sin(a) * sp; c.vy = (aim ? 4 : 6) + R() * power * 0.9;
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

/**
 * 破風氣流：從車身兩側拖出去的發光帶子。每條帶子是一個環狀緩衝區，
 * 每幀記錄一個點，越舊越淡；甩尾時是白色、N2O 時是藍色。所有帶子合成一次繪製。
 */
export class Trails {
  mesh: THREE.Mesh;
  private n: number;
  private pts: number;
  private width: number;
  private pos: Float32Array;
  private col: Float32Array;
  /** 每條帶子的歷史點：x, y, z, 強度, r, g, b, 寬度方向 ox, oy, oz */
  private hist: Float32Array;
  private head: Int32Array;
  private geo: THREE.BufferGeometry;

  /** pts：每條帶子記錄幾個點（越多越長）；width：最寬處的半寬 */
  constructor(ribbons: number, pts = 22, width = 0.25) {
    this.n = ribbons;
    this.pts = pts;
    this.width = width;
    const P = this.pts;
    this.pos = new Float32Array(ribbons * P * 2 * 3);
    this.col = new Float32Array(ribbons * P * 2 * 3);
    this.hist = new Float32Array(ribbons * P * 10);
    this.head = new Int32Array(ribbons);
    const idx: number[] = [];
    for (let r = 0; r < ribbons; r++) {
      for (let i = 0; i < P - 1; i++) {
        const a = (r * P + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * 記錄第 r 條帶子這一幀的位置；k = 0 表示沒有在噴（帶子會慢慢消失）。
   * (ox, oy, oz) 是帶子寬度的方向：預設垂直，傳入橫向向量就變成平貼地面的帶子。
   */
  push(r: number, x: number, y: number, z: number, k: number, cr: number, cg: number, cb: number, ox = 0, oy = 1, oz = 0): void {
    if (r >= this.n) return;
    const P = this.pts;
    const h = (this.head[r] = (this.head[r] + 1) % P);
    const H = this.hist, j = (r * P + h) * 10;
    H[j] = x; H[j + 1] = y; H[j + 2] = z; H[j + 3] = k;
    H[j + 4] = cr; H[j + 5] = cg; H[j + 6] = cb;
    H[j + 7] = ox; H[j + 8] = oy; H[j + 9] = oz;
  }

  update(): void {
    const P = this.pts, H = this.hist, pos = this.pos, col = this.col;
    let any = false;
    for (let r = 0; r < this.n; r++) {
      const h = this.head[r];
      for (let i = 0; i < P; i++) {
        // i = 0 是最新的點
        const j = (r * P + ((h - i + P) % P)) * 10;
        const fade = 1 - i / (P - 1);
        const k = H[j + 3] * fade;
        if (k > 0) any = true;
        const w = this.width * (0.2 + 0.8 * fade);
        const ox = H[j + 7] * w, oy = H[j + 8] * w, oz = H[j + 9] * w;
        // 直接寫入（不要每個點建一個暫時陣列：每幀兩千多個）
        const o = (r * P + i) * 6;
        pos[o] = H[j] + ox; pos[o + 1] = H[j + 1] + oy; pos[o + 2] = H[j + 2] + oz;
        pos[o + 3] = H[j] - ox; pos[o + 4] = H[j + 1] - oy; pos[o + 5] = H[j + 2] - oz;
        const cr = H[j + 4] * k, cg = H[j + 5] * k, cb = H[j + 6] * k;
        col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
        col[o + 3] = cr * 0.5; col[o + 4] = cg * 0.5; col[o + 5] = cb * 0.5;
      }
    }
    // 全部都是 0（沒人在噴、沒人在甩）時不畫也不上傳
    this.mesh.visible = any;
    if (!any) return;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.hist.fill(0);
    this.update();
  }
}

/** 爆炸留在路面上的焦痕：固定數量的貼花循環使用，25 秒內慢慢淡掉 */
export class Scorch {
  mesh: THREE.InstancedMesh;
  private fade: Float32Array;
  private fadeAttr: THREE.InstancedBufferAttribute;
  private cursor = 0;
  private max: number;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(max = 40) {
    this.max = max;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d')!;
    const g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(10,8,6,0.9)');
    g.addColorStop(0.55, 'rgba(25,18,12,0.55)');
    g.addColorStop(1, 'rgba(25,18,12,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    // 不規則的放射狀裂痕
    c.strokeStyle = 'rgba(5,4,3,0.6)';
    c.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      c.beginPath();
      c.moveTo(32, 32);
      c.lineTo(32 + Math.cos(a) * (18 + Math.random() * 12), 32 + Math.sin(a) * (18 + Math.random() * 12));
      c.stroke();
    }
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.fade = new Float32Array(max);
    this.fadeAttr = new THREE.InstancedBufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFade', this.fadeAttr);
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    // 每個實例自己的透明度
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aFade;\nvarying float vFade;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
      sh.fragmentShader = 'varying float vFade;\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.clear();
  }

  add(x: number, y: number, z: number, r: number): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.fade[i] = 1;
    this.q.setFromAxisAngle(this.up, Math.random() * 6.28);
    this.m4.compose(this.v.set(x, y + 0.06, z), this.q, this.s.set(r, 1, r));
    this.mesh.setMatrixAt(i, this.m4);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.fade[i] <= 0) continue;
      this.fade[i] = Math.max(0, this.fade[i] - dt / 25);
      any = true;
    }
    if (any) this.fadeAttr.needsUpdate = true;
  }

  clear(): void {
    this.fade.fill(0);
    this.fadeAttr.needsUpdate = true;
  }
}
