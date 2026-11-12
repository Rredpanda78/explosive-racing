import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { clamp, lerpAngle } from '../game/util';
import { KART_MODELS } from './assets';
import { BlastFx, Debris, SkidMarks } from './effects';
import { KartView } from './kartModel';
import { Particles } from './particles';
import { buildWorld, SKY_HORIZON, type World } from './world';

const MAX_TRACERS = 256;
const POOL = 14;
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.3).normalize();

export class GameView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(66, 1, 0.3, 2600);
  mobile: boolean;
  shadows: boolean;
  /** 畫面震動強度 0~1（實際位移為平方） */
  shake = 0;
  /** 0~1，氮氣／加速帶時的速度感，HUD 用來畫速度線 */
  boostK = 0;

  private world?: World;
  private track?: Track;
  private kartViews = new Map<Kart, KartView>();
  private smoke = new Particles(900, false);
  private fire = new Particles(1400, true);
  private skid = new SkidMarks();
  private debris: Debris | null = null;
  private blast = new BlastFx();
  private tracers: THREE.InstancedMesh;
  private missiles: THREE.Group[] = [];
  private shells: THREE.Mesh[] = [];
  private sun: THREE.DirectionalLight;
  private camYaw = 0;
  private camY = 0;
  private fov = 66;
  private time = 0;
  private shakeT = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(canvas: HTMLCanvasElement, mobile: boolean) {
    this.mobile = mobile;
    this.shadows = !mobile;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 220, 1150);
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x7fae6a, 1.15));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 1.9));
    sun.position.copy(SUN_DIR).multiplyScalar(200);
    this.scene.add(sun, sun.target);
    if (this.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      const c = sun.shadow.camera;
      c.left = -85; c.right = 85; c.top = 85; c.bottom = -85; c.near = 10; c.far = 420;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.06;
    }

    this.scene.add(this.skid.mesh, this.blast.group, this.smoke.points, this.fire.points);

    this.tracers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.1, 0.1, 5.5),
      new THREE.MeshBasicMaterial({ color: 0xffe7a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_TRACERS,
    );
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);

    const mBody = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8).rotateX(Math.PI / 2);
    const mNose = new THREE.ConeGeometry(0.15, 0.4, 8).rotateX(Math.PI / 2).translate(0, 0, 0.8);
    const mFin = new THREE.BoxGeometry(0.7, 0.04, 0.3).translate(0, 0, -0.5);
    const mWhite = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const mRed = new THREE.MeshLambertMaterial({ color: 0xff4433 });
    const shellGeo = new THREE.SphereGeometry(0.34, 10, 8);
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    for (let i = 0; i < POOL; i++) {
      const g = new THREE.Group();
      const fin2 = new THREE.Mesh(mFin, mRed);
      fin2.rotation.z = Math.PI / 2;
      g.add(new THREE.Mesh(mBody, mWhite), new THREE.Mesh(mNose, mRed), new THREE.Mesh(mFin, mRed), fin2);
      g.visible = false;
      this.scene.add(g);
      this.missiles.push(g);
      const s = new THREE.Mesh(shellGeo, shellMat);
      s.visible = false;
      this.scene.add(s);
      this.shells.push(s);
    }
    this.resize();
  }

  /** 模型載入完成後呼叫，建立賽道場景與零件池 */
  setTrack(track: Track): void {
    if (this.world) this.scene.remove(this.world.group);
    this.track = track;
    this.world = buildWorld(track, this.shadows);
    this.scene.add(this.world.group);
    if (this.debris) this.scene.remove(this.debris.group);
    this.debris = new Debris(this.mobile ? 16 : 30, this.shadows);
    this.scene.add(this.debris.group);
  }

  setRace(race: Race | null): void {
    for (const kv of this.kartViews.values()) {
      this.scene.remove(kv.group);
      kv.dispose();
    }
    this.kartViews.clear();
    this.smoke.clear();
    this.fire.clear();
    this.skid.clear();
    this.debris?.clear();
    this.blast.clear();
    this.tracers.count = 0;
    for (const m of this.missiles) m.visible = false;
    for (const s of this.shells) s.visible = false;
    this.shake = 0;
    this.boostK = 0;
    if (!race) return;
    for (const k of race.karts) {
      const model = KART_MODELS[k.id % KART_MODELS.length];
      const kv = new KartView({ color: k.color, primary: k.primary, secondary: k.secondary, isPlayer: k.isPlayer, model }, this.shadows);
      this.kartViews.set(k, kv);
      this.scene.add(kv.group);
      kv.update(k, 0);
    }
    this.camYaw = race.player.heading;
    this.camY = race.player.y;
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateParticleScale();
  }

  private updateParticleScale(): void {
    const hpx = this.renderer.domElement.height;
    const s = hpx / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.smoke.setScale(s);
    this.fire.setScale(s);
  }

  /** 世界座標轉螢幕座標（CSS 像素）；在鏡頭後方時回傳 false */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = this.v3.set(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return false;
    out.x = (v.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    return true;
  }

  private addShake(a: number): void {
    this.shake = Math.min(1, this.shake + a);
  }

  onEvent(e: RaceEvent, race: Race): void {
    const f = this.fire, sm = this.smoke;
    const R = Math.random;
    const p = race.player;
    switch (e.t) {
      case 'shot':
        this.kartViews.get(e.k)?.muzzleFlash(e.side);
        f.spawn(e.x, e.y, e.z, e.k.vx, 0, e.k.vz, 0.06, 2.2, 0.8, 1, 0.8, 0.35, 0.9);
        break;
      case 'hit':
        for (let i = 0; i < 4; i++) f.spawn(e.x, e.y, e.z, e.k.vx * 0.5 + (R() - 0.5) * 16, 2 + R() * 7, e.k.vz * 0.5 + (R() - 0.5) * 16, 0.25 + R() * 0.25, 0.55, 0.1, 1, 0.8, 0.3, 1, 20, 0, e.k.y);
        f.spawn(e.x, e.y, e.z, 0, 0, 0, 0.07, 2.4, 0.6, 1, 0.9, 0.6, 0.9);
        if (e.k === p) this.addShake(0.1);
        break;
      case 'blast': {
        const big = e.kart ? 1.5 : 1;
        // 火球碎片
        const n = Math.round((18 + e.r * 2.2) * big);
        for (let i = 0; i < n; i++) {
          const a = R() * Math.PI * 2, sp = (0.3 + R()) * e.r * 1.7;
          f.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 2 + R() * e.r * 1.6, Math.sin(a) * sp, 0.45 + R() * 0.55, 2.2 + R() * 2.4, 0.4, 1, 0.42 + R() * 0.38, 0.08, 1, 9, 1.6, e.gy);
        }
        // 帶重力的火星
        for (let i = 0; i < 14 * big; i++) {
          const a = R() * Math.PI * 2, sp = 6 + R() * 16;
          f.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 8 + R() * 14, Math.sin(a) * sp, 0.7 + R() * 0.7, 0.45, 0.1, 1, 0.85, 0.4, 1, 26, 0.4, e.gy);
        }
        // 濃煙柱
        for (let i = 0; i < 16 * big; i++) {
          const a = R() * Math.PI * 2, sp = R() * e.r * 0.75;
          sm.spawn(e.x, e.y + 0.5, e.z, Math.cos(a) * sp, 2.5 + R() * 5, Math.sin(a) * sp, 1.2 + R() * 1.2, 2.2, 7 + R() * 4, 0.12, 0.11, 0.11, 0.72, -1.2, 1.2);
        }
        this.blast.spawn(e.x, e.y, e.z, e.gy, e.r);
        this.debris?.burst(e.x, e.y, e.z, e.gy, e.kart ? 9 : 3, e.kart ? 15 : 10);
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        this.addShake(clamp(1 - d / 80, 0, 1) * 0.85);
        break;
      }
      case 'launch': {
        const fx = Math.sin(e.k.heading), fz = Math.cos(e.k.heading);
        for (let i = 0; i < 8; i++) sm.spawn(e.k.x + fx * 1.4, e.k.y + 1, e.k.z + fz * 1.4, e.k.vx + (R() - 0.5) * 4, 1 + R() * 2, e.k.vz + (R() - 0.5) * 4, 0.5, 0.8, 2.6, 0.85, 0.85, 0.85, 0.5);
        f.spawn(e.k.x + fx * 1.6, e.k.y + 1, e.k.z + fz * 1.6, e.k.vx, 0, e.k.vz, 0.1, 3.2, 1, 1, 0.75, 0.35, 1);
        if (e.k === p) this.addShake(e.kind === 'howitzer' ? 0.3 : 0.15);
        break;
      }
      case 'kart': {
        const k = e.k;
        if (e.e === 'wall') {
          for (let i = 0; i < 9; i++) f.spawn(k.x, k.y + 0.6, k.z, (R() - 0.5) * 14, 2 + R() * 6, (R() - 0.5) * 14, 0.35, 0.5, 0.1, 1, 0.8, 0.4, 1, 20, 0, k.y);
          if (k === p) this.addShake(0.35);
        } else if (e.e === 'boost' || e.e === 'mini' || e.e === 'pad') {
          const blue = e.e === 'boost';
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            f.spawn(k.x, k.y + 0.6, k.z, k.vx * 0.6 + Math.cos(a) * 7, R() * 3, k.vz * 0.6 + Math.sin(a) * 7, 0.35, 1.7, 0.2, blue ? 0.3 : 1, blue ? 0.8 : 0.65, blue ? 1 : 0.2, 1);
          }
        } else if (e.e === 'n2o') {
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            f.spawn(k.x + Math.cos(a) * 1.6, k.y + 0.3, k.z + Math.sin(a) * 1.6, k.vx, 5 + R() * 2, k.vz, 0.45, 1.1, 0.2, 0.35, 0.85, 1, 1);
          }
        }
        break;
      }
      case 'respawn':
        for (let i = 0; i < 24; i++) {
          const a = (i / 12) * Math.PI * 2;
          f.spawn(e.k.x + Math.cos(a) * 1.8, e.k.y + (i < 12 ? 0.3 : 1.6), e.k.z + Math.sin(a) * 1.8, 0, 4 + R() * 3, 0, 0.6, 1.3, 0.2, 0.5, 1, 0.7, 1);
        }
        break;
    }
  }

  update(dt: number, race: Race, lookBack: boolean): void {
    this.time += dt;
    const R = Math.random;
    const f = this.fire, sm = this.smoke;
    for (const k of race.karts) {
      this.kartViews.get(k)?.update(k, dt);
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const lx = fz, lz = -fx;
      const sliding = !k.dead && (k.drifting ? Math.abs(k.slip) > 0.12 : k.aiAssist && Math.abs(k.steerVis) > 0.75 && k.speed > 20);
      // 後輪位置：胎痕與輪胎煙
      for (let w = 0; w < 2; w++) {
        const side = w === 0 ? 1 : -1;
        const wx = k.x + lx * side * 0.55 - fx * 0.68, wz = k.z + lz * side * 0.55 - fz * 0.68;
        this.skid.wheel(k, w, sliding, wx, k.y + 0.035, wz, lx, lz);
        if (!sliding) continue;
        if (R() < dt * 50) {
          sm.spawn(wx, k.y + 0.25, wz, k.vx * 0.15 + (R() - 0.5) * 1.2, 0.8 + R(), k.vz * 0.15 + (R() - 0.5) * 1.2, 0.5 + R() * 0.5, 1, 3.4, 0.94, 0.94, 0.96, 0.5, -0.5, 1);
        }
        // 拖得夠久會磨出火花
        if (k.drifting && k.driftTime > 0.7 && R() < dt * 55) {
          const hot = k.driftTime > 1.8;
          f.spawn(wx, k.y + 0.12, wz, k.vx * 0.3 - fx * 3 + (R() - 0.5) * 5, 1.5 + R() * 4, k.vz * 0.3 - fz * 3 + (R() - 0.5) * 5, 0.2 + R() * 0.25, 0.42, 0.08, hot ? 0.45 : 1, hot ? 0.8 : 0.72, hot ? 1 : 0.25, 1, 16, 0, k.y);
        }
      }
      if (k.dead) continue;
      if (k.boostT > 0 || k.miniT > 0 || k.padT > 0) {
        const blue = k.boostT > 0;
        const cnt = blue ? 3 : 1;
        for (let i = 0; i < cnt; i++) {
          const side = R() > 0.5 ? 0.3 : -0.3;
          f.spawn(k.x + lx * side - fx * 1.6, k.y + 0.6, k.z + lz * side - fz * 1.6, k.vx * 0.4 - fx * 7, R() * 0.6, k.vz * 0.4 - fz * 7, 0.24, 1.3, 0.15, blue ? 0.35 : 1, blue ? 0.75 : 0.6, blue ? 1 : 0.2, 0.9);
        }
      }
      // 受損冒煙，瀕死時著火
      const hpR = k.hp / k.maxHp;
      if (hpR < 0.5 && R() < dt * (hpR < 0.25 ? 22 : 10)) {
        sm.spawn(k.x - fx * 0.9, k.y + 1, k.z - fz * 0.9, k.vx * 0.3, 1.6 + R(), k.vz * 0.3, 0.9, 0.8, 2.8, 0.1, 0.1, 0.1, 0.6, -1, 0.8);
        if (hpR < 0.25) f.spawn(k.x - fx * 0.9, k.y + 0.9, k.z - fz * 0.9, k.vx * 0.5, 1.5 + R() * 2, k.vz * 0.5, 0.3, 1.2, 0.3, 1, 0.5, 0.1, 0.9);
      }
    }

    // 曳光彈
    const B = race.bullets;
    const nb = Math.min(B.length, MAX_TRACERS);
    for (let i = 0; i < nb; i++) {
      const b = B[i];
      this.q.setFromAxisAngle(this.up, Math.atan2(b.vx, b.vz));
      this.m4.compose(this.v3.set(b.x, b.y, b.z), this.q, this.one);
      this.tracers.setMatrixAt(i, this.m4);
    }
    this.tracers.count = nb;
    this.tracers.instanceMatrix.needsUpdate = true;

    // 飛彈與砲彈
    for (let i = 0; i < POOL; i++) {
      const mm = this.missiles[i];
      const m = race.missiles[i];
      mm.visible = !!m;
      if (m) {
        mm.position.set(m.x, m.y, m.z);
        mm.rotation.set(0, m.a, this.time * 9);
        const bx = Math.sin(m.a), bz = Math.cos(m.a);
        for (let j = 0; j < 2; j++) sm.spawn(m.x - bx * (0.8 + j), m.y, m.z - bz * (0.8 + j), (R() - 0.5) * 1.5, R(), (R() - 0.5) * 1.5, 0.6, 0.6, 2.1, 0.92, 0.92, 0.92, 0.5);
        f.spawn(m.x - bx * 0.9, m.y, m.z - bz * 0.9, 0, 0, 0, 0.09, 1.8, 0.5, 1, 0.62, 0.2, 1);
      }
      const ss = this.shells[i];
      const s = race.shells[i];
      ss.visible = !!s;
      if (s) {
        ss.position.set(s.x, s.gy + s.y, s.z);
        sm.spawn(s.x, s.gy + s.y, s.z, 0, 0, 0, 0.4, 0.5, 1.4, 0.3, 0.3, 0.3, 0.45);
        if (R() < 0.5) f.spawn(s.x, s.gy + s.y, s.z, 0, 0, 0, 0.1, 1, 0.3, 1, 0.5, 0.15, 0.8);
      }
    }

    this.blast.update(dt);
    this.debris?.update(dt);
    sm.update(dt);
    f.update(dt);
    this.updateChaseCam(dt, race.player, lookBack);
    this.world?.update(dt, this.time, this.camera);
    this.updateSun(race.player.x, race.player.y, race.player.z);
  }

  /** 陰影範圍跟著玩家移動（以固定格距對齊，避免陰影邊緣閃爍） */
  private updateSun(x: number, y: number, z: number): void {
    const g = 4;
    this.sun.target.position.set(Math.round(x / g) * g, y, Math.round(z / g) * g);
    this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 200);
  }

  private updateChaseCam(dt: number, k: Kart, lookBack: boolean): void {
    const want = k.heading + k.slip * 0.55;
    this.camYaw = lerpAngle(this.camYaw, want, 1 - Math.exp(-7 * dt));
    this.camY += (k.y - this.camY) * (1 - Math.exp(-10 * dt));
    const yaw = this.camYaw + (lookBack ? Math.PI : 0);
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const bk = k.boostT > 0 ? 1 : k.padT > 0 ? 0.7 : k.miniT > 0 ? 0.5 : 0;
    this.boostK += (bk - this.boostK) * Math.min(1, dt * 5);
    const ratio = clamp(k.speed / k.topSpeed, 0, 1.4);
    const dist = 8.6 + this.boostK * 1.5;
    // 震動：強度平方 × 幾個不同頻率的正弦波相加（比每幀亂數平滑）
    this.shake = Math.max(0, this.shake - dt * 1.9);
    this.shakeT += dt * 34;
    const sh = this.shake * this.shake * 0.55;
    const t = this.shakeT;
    const slope = Math.tan(k.pitch) * (lookBack ? -1 : 1);
    this.camera.position.set(
      k.x - dx * dist + Math.sin(t * 1.7) * sh,
      this.camY + 4.5 - slope * dist * 0.5 + Math.sin(t * 2.3) * sh,
      k.z - dz * dist + Math.sin(t * 1.3 + 1) * sh,
    );
    this.camera.lookAt(k.x + dx * 6, this.camY + 1.7 + slope * 6, k.z + dz * 6);
    this.camera.rotateZ(Math.sin(t * 1.1) * sh * 0.05);
    const fov = 64 + ratio * 8 + this.boostK * 13;
    this.fov += (fov - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
  }

  /** 主選單背景：沿賽道飛行 */
  updateMenuCam(dt: number): void {
    const tr = this.track;
    if (!tr) return;
    this.time += dt;
    const n = tr.n;
    const fi = ((this.time * 18) / tr.spacing) % n;
    const i = Math.floor(fi);
    const a = tr.samples[i], b = tr.samples[(i + 1) % n];
    const u = fi - i;
    const c = tr.samples[(i + 34) % n];
    const x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y = a.y + (b.y - a.y) * u;
    this.camera.position.set(x, y + 9, z);
    this.camera.lookAt(c.x, c.y + 1.5, c.z);
    if (this.camera.fov !== 66) {
      this.camera.fov = 66;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
    this.boostK = 0;
    this.world?.update(dt, this.time, this.camera);
    this.updateSun(x, y, z);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
