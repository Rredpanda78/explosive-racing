import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { clamp, lerpAngle } from '../game/util';
import { KartView } from './kartModel';
import { Particles } from './particles';
import { buildWorld, SKY_COLOR } from './world';

const MAX_TRACERS = 256;
const POOL = 14;

interface Blast { mesh: THREE.Mesh; t: number; r: number }

export class GameView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(66, 1, 0.3, 1400);
  mobile: boolean;
  shake = 0;

  private world?: THREE.Group;
  private track?: Track;
  private kartViews = new Map<Kart, KartView>();
  private smoke = new Particles(700, false);
  private fire = new Particles(1000, true);
  private tracers: THREE.InstancedMesh;
  private missiles: THREE.Group[] = [];
  private shells: THREE.Mesh[] = [];
  private blasts: Blast[] = [];
  private camYaw = 0;
  private boostK = 0;
  private fov = 66;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(canvas: HTMLCanvasElement, mobile: boolean) {
    this.mobile = mobile;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 160, 760);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7fae6a, 1.25));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.7);
    sun.position.set(0.5, 1, 0.35);
    this.scene.add(sun);

    this.scene.add(this.smoke.points, this.fire.points);

    this.tracers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.09, 0.09, 5),
      new THREE.MeshBasicMaterial({ color: 0xffe7a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_TRACERS,
    );
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);

    const mBody = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8).rotateX(Math.PI / 2);
    const mNose = new THREE.ConeGeometry(0.15, 0.4, 8).rotateX(Math.PI / 2).translate(0, 0, 0.8);
    const mWhite = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const mRed = new THREE.MeshLambertMaterial({ color: 0xff4433 });
    const shellGeo = new THREE.SphereGeometry(0.32, 10, 8);
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    const blastGeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < POOL; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(mBody, mWhite), new THREE.Mesh(mNose, mRed));
      g.visible = false;
      this.scene.add(g);
      this.missiles.push(g);
      const s = new THREE.Mesh(shellGeo, shellMat);
      s.visible = false;
      this.scene.add(s);
      this.shells.push(s);
    }
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      mesh.visible = false;
      this.scene.add(mesh);
      this.blasts.push({ mesh, t: 1, r: 1 });
    }
    this.resize();
  }

  setTrack(track: Track): void {
    if (this.world) this.scene.remove(this.world);
    this.track = track;
    this.world = buildWorld(track);
    this.scene.add(this.world);
  }

  setRace(race: Race | null): void {
    for (const kv of this.kartViews.values()) {
      this.scene.remove(kv.group);
      kv.dispose();
    }
    this.kartViews.clear();
    this.smoke.clear();
    this.fire.clear();
    this.tracers.count = 0;
    for (const m of this.missiles) m.visible = false;
    for (const s of this.shells) s.visible = false;
    for (const b of this.blasts) b.mesh.visible = false;
    this.shake = 0;
    if (!race) return;
    for (const k of race.karts) {
      const kv = new KartView(k.color, k.primary, k.secondary, k.isPlayer);
      this.kartViews.set(k, kv);
      this.scene.add(kv.group);
      kv.update(k, 0);
    }
    this.camYaw = race.player.heading;
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

  onEvent(e: RaceEvent, race: Race): void {
    const f = this.fire, sm = this.smoke;
    const R = Math.random;
    switch (e.t) {
      case 'shot':
        f.spawn(e.x, 0.85, e.z, 0, 0, 0, 0.05, 1.5, 0.6, 1, 0.85, 0.4, 1);
        break;
      case 'hit':
        for (let i = 0; i < 3; i++) f.spawn(e.x, 0.9, e.z, (R() - 0.5) * 14, 2 + R() * 6, (R() - 0.5) * 14, 0.25 + R() * 0.2, 0.5, 0.1, 1, 0.8, 0.3, 1, 18);
        if (e.k === race.player) this.shake = Math.min(1, this.shake + 0.12);
        break;
      case 'blast': {
        const n = Math.round(16 + e.r * 2);
        for (let i = 0; i < n; i++) {
          const a = R() * Math.PI * 2, sp = (0.3 + R()) * e.r * 1.6;
          f.spawn(e.x, e.y, e.z, Math.cos(a) * sp, 2 + R() * e.r * 1.5, Math.sin(a) * sp, 0.4 + R() * 0.5, 2 + R() * 2, 0.4, 1, 0.45 + R() * 0.35, 0.1, 1, 9, 1.5);
        }
        for (let i = 0; i < 12; i++) {
          const a = R() * Math.PI * 2, sp = R() * e.r * 0.7;
          sm.spawn(e.x, e.y + 0.5, e.z, Math.cos(a) * sp, 2 + R() * 4, Math.sin(a) * sp, 1 + R() * 0.9, 2, 6 + R() * 3, 0.13, 0.12, 0.12, 0.7, -1, 1.2);
        }
        const b = this.blasts.find((x) => x.t >= 1) || this.blasts[0];
        b.t = 0;
        b.r = e.r;
        b.mesh.position.set(e.x, e.y, e.z);
        b.mesh.visible = true;
        const p = race.player;
        const d = Math.hypot(e.x - p.x, e.z - p.z);
        this.shake = Math.min(1.2, this.shake + clamp(1 - d / 70, 0, 1) * 0.9);
        break;
      }
      case 'kart':
        if (e.e === 'wall') {
          for (let i = 0; i < 6; i++) f.spawn(e.k.x, 0.6, e.k.z, (R() - 0.5) * 12, 2 + R() * 5, (R() - 0.5) * 12, 0.3, 0.5, 0.1, 1, 0.8, 0.4, 1, 18);
          if (e.k === race.player) this.shake = Math.min(1, this.shake + 0.35);
        } else if (e.e === 'boost' || e.e === 'mini') {
          const blue = e.e === 'boost';
          for (let i = 0; i < 12; i++) f.spawn(e.k.x, 0.6, e.k.z, (R() - 0.5) * 10, R() * 4, (R() - 0.5) * 10, 0.35, 1.6, 0.2, blue ? 0.3 : 1, blue ? 0.8 : 0.6, blue ? 1 : 0.2, 1);
        }
        break;
      case 'respawn':
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          f.spawn(e.k.x, 0.5, e.k.z, Math.cos(a) * 6, 3, Math.sin(a) * 6, 0.5, 1.2, 0.2, 0.5, 1, 0.7, 1);
        }
        break;
    }
  }

  update(dt: number, race: Race, lookBack: boolean): void {
    const R = Math.random;
    const f = this.fire, sm = this.smoke;
    for (const k of race.karts) {
      this.kartViews.get(k)?.update(k, dt);
      if (k.dead) continue;
      const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
      const lx = fz, lz = -fx;
      const sliding = k.drifting ? Math.abs(k.slip) > 0.12 : k.aiAssist && Math.abs(k.steerVis) > 0.75 && k.speed > 20;
      if (sliding) {
        for (const side of [1, -1]) {
          if (R() < dt * 45) {
            sm.spawn(k.x + lx * side - fx * 1.05, 0.25, k.z + lz * side - fz * 1.05, k.vx * 0.15 + (R() - 0.5), 0.8 + R(), k.vz * 0.15 + (R() - 0.5), 0.5 + R() * 0.4, 1, 3.2, 0.93, 0.93, 0.95, 0.5, -0.5, 1);
          }
        }
      }
      if (k.boostT > 0 || k.miniT > 0) {
        const blue = k.boostT > 0;
        const cnt = blue ? 2 : 1;
        for (let i = 0; i < cnt; i++) {
          const side = R() > 0.5 ? 0.3 : -0.3;
          f.spawn(k.x + lx * side - fx * 1.9, 0.62, k.z + lz * side - fz * 1.9, k.vx * 0.4 - fx * 6, R() * 0.6, k.vz * 0.4 - fz * 6, 0.22, 1.1, 0.15, blue ? 0.35 : 1, blue ? 0.75 : 0.6, blue ? 1 : 0.2, 0.9);
        }
      }
      if (k.hp < k.maxHp * 0.35 && R() < dt * 14) {
        sm.spawn(k.x - fx * 1.1, 1, k.z - fz * 1.1, k.vx * 0.3, 1.5 + R(), k.vz * 0.3, 0.8, 0.8, 2.6, 0.1, 0.1, 0.1, 0.6, -1, 0.8);
      }
    }

    // 曳光彈
    const B = race.bullets;
    const nb = Math.min(B.length, MAX_TRACERS);
    for (let i = 0; i < nb; i++) {
      const b = B[i];
      this.q.setFromAxisAngle(this.up, Math.atan2(b.vx, b.vz));
      this.m4.compose(this.v3.set(b.x, 0.82, b.z), this.q, this.one);
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
        mm.position.set(m.x, 0.95, m.z);
        mm.rotation.y = m.a;
        const bx = Math.sin(m.a), bz = Math.cos(m.a);
        sm.spawn(m.x - bx * 0.8, 0.95, m.z - bz * 0.8, (R() - 0.5) * 1.5, R(), (R() - 0.5) * 1.5, 0.5, 0.6, 1.8, 0.9, 0.9, 0.9, 0.5);
        f.spawn(m.x - bx * 0.9, 0.95, m.z - bz * 0.9, 0, 0, 0, 0.08, 1.4, 0.4, 1, 0.6, 0.2, 1);
      }
      const ss = this.shells[i];
      const s = race.shells[i];
      ss.visible = !!s;
      if (s) {
        ss.position.set(s.x, s.y, s.z);
        if (R() < 0.6) sm.spawn(s.x, s.y, s.z, 0, 0, 0, 0.35, 0.5, 1.2, 0.3, 0.3, 0.3, 0.45);
      }
    }

    for (const b of this.blasts) {
      if (b.t >= 1) continue;
      b.t += dt / 0.28;
      const t = Math.min(1, b.t);
      const s = b.r * (0.25 + 0.75 * Math.sqrt(t));
      b.mesh.scale.set(s, s, s);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - t);
      if (t >= 1) b.mesh.visible = false;
    }

    sm.update(dt);
    f.update(dt);
    this.updateChaseCam(dt, race.player, lookBack);
  }

  private updateChaseCam(dt: number, k: Kart, lookBack: boolean): void {
    const want = k.heading + k.slip * 0.55;
    this.camYaw = lerpAngle(this.camYaw, want, 1 - Math.exp(-7 * dt));
    const yaw = this.camYaw + (lookBack ? Math.PI : 0);
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const bk = k.boostT > 0 ? 1 : k.miniT > 0 ? 0.5 : 0;
    this.boostK += (bk - this.boostK) * Math.min(1, dt * 5);
    const ratio = clamp(k.speed / k.topSpeed, 0, 1.4);
    const dist = 7.4 + this.boostK * 1.3;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const sh = this.shake * this.shake * 0.5;
    this.camera.position.set(
      k.x - dx * dist + (Math.random() - 0.5) * sh,
      3.4 + (Math.random() - 0.5) * sh,
      k.z - dz * dist + (Math.random() - 0.5) * sh,
    );
    this.camera.lookAt(k.x + dx * 5, 1.3, k.z + dz * 5);
    const fov = 64 + ratio * 8 + this.boostK * 12;
    this.fov += (fov - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
  }

  /** 主選單背景：沿賽道飛行 */
  updateMenuCam(t: number): void {
    const tr = this.track;
    if (!tr) return;
    const n = tr.n;
    const fi = ((t * 16) / tr.spacing) % n;
    const i = Math.floor(fi);
    const a = tr.samples[i], b = tr.samples[(i + 1) % n];
    const u = fi - i;
    const c = tr.samples[(i + 30) % n];
    this.camera.position.set(a.x + (b.x - a.x) * u, 11, a.z + (b.z - a.z) * u);
    this.camera.lookAt(c.x, 1, c.z);
    if (this.camera.fov !== 66) {
      this.camera.fov = 66;
      this.camera.updateProjectionMatrix();
      this.updateParticleScale();
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
