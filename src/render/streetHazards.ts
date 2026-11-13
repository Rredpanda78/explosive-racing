import * as THREE from 'three';
import { TRAIN, type HazardState, type Race } from '../game/race';
import { CRACKER, hash01 } from '../game/street';
import type { Track } from '../game/track';
import { Particles } from './particles';
import type { Theme } from './themes';
import { Geo, helmetGeometry, riderGeometry, scooterGeometry } from './town';

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';

function tex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 粒子的大小換算要用畫面高度與視角：在畫之前自己算 */
function autoScale(p: Particles): void {
  p.points.onBeforeRender = (renderer, _s, camera) => {
    const cam = camera as THREE.PerspectiveCamera;
    p.setScale(renderer.getContext().drawingBufferHeight / (2 * Math.tan((cam.fov * Math.PI) / 360)));
  };
}

/**
 * 街頭機關的畫面（src/game/street.ts 的狀態 → 模型）：
 * - 機車：車殼、騎士、安全帽、車燈與照在路面上的光（全部 InstancedMesh，數量 = 同時在路上的機車）
 * - 鞭炮陣：路面上一片一片的鞭炮（點燃時閃爍、引信的火花跑向鞭炮），炸開時一團團火光、白煙、紅紙屑
 * - 平交道：路面上的鐵軌、會放下來的柵欄、閃紅燈的「停看聽」號誌、三節車廂的區間車
 * - 河堤強風：被風吹過去的白色風痕，風向袋
 */
export class StreetHazardView {
  group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private riders: { h: HazardState; k: number }[] = [];
  private scooter: THREE.InstancedMesh | null = null;
  private rider: THREE.InstancedMesh | null = null;
  private helmet: THREE.InstancedMesh | null = null;
  private lights: THREE.InstancedMesh | null = null;
  private beams: THREE.InstancedMesh | null = null;
  private mats: { h: HazardState; k: number }[] = [];
  private matMesh: THREE.InstancedMesh | null = null;
  private matGlow: THREE.InstancedMesh | null = null;
  private pop: Particles;
  private smoke: Particles;
  private trains: { h: HazardState; train: THREE.Group; arms: THREE.Object3D[]; lamps: THREE.Mesh[] }[] = [];
  private lampOn: THREE.MeshBasicMaterial;
  private lampOff: THREE.MeshLambertMaterial;
  private gusts: { h: HazardState; lines: THREE.LineSegments; pos: Float32Array; seed: Float32Array; socks: THREE.Object3D[]; mat: THREE.LineBasicMaterial }[] = [];
  private last = -1;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  private low: boolean;

  static wants(race: Race): boolean {
    return race.hazards.some((h) => h.riders || h.mats || h.def.kind === 'gust' || (h.def.kind === 'tram' && h.def.train));
  }

  constructor(race: Race, track: Track, theme: Theme, shadows: boolean, low: boolean) {
    this.low = low;
    const hw = track.halfWidth;
    this.pop = new Particles(low ? 500 : 1100, true);
    this.smoke = new Particles(low ? 260 : 600, false);
    autoScale(this.pop);
    autoScale(this.smoke);
    this.group.add(this.pop.points, this.smoke.points);
    this.lampOn = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a1a).multiplyScalar(3) });
    this.lampOff = new THREE.MeshLambertMaterial({ color: 0x4a1210 });
    this.disposables.push(this.lampOn, this.lampOff);

    // ---------- 機車 ----------
    for (const h of race.hazards) if (h.riders) h.riders.forEach((_r, k) => this.riders.push({ h, k }));
    if (this.riders.length) {
      const N = this.riders.length;
      const lam = (vc: boolean) => new THREE.MeshLambertMaterial({ vertexColors: vc });
      const mk = (g: THREE.BufferGeometry, m: THREE.Material) => {
        const im = new THREE.InstancedMesh(g, m, N);
        im.frustumCulled = false;
        im.count = 0;
        this.group.add(im);
        this.disposables.push(g, m);
        return im;
      };
      this.scooter = mk(scooterGeometry(), lam(true));
      this.scooter.castShadow = shadows;
      this.rider = mk(riderGeometry(), lam(true));
      this.helmet = mk(helmetGeometry(), lam(true));
      // 車燈：前面白色大燈、後面紅色尾燈（夜裡最顯眼的就是這個）
      const lg = new Geo();
      lg.box(0, 0.86, 0.66, 1, 0, 0.26, 0.06, 0.18, [3, 2.8, 2.4]);
      lg.box(0, 0.5, -0.99, 1, 0, 0.3, 0.04, 0.12, [2.6, 0.2, 0.15]);
      this.lights = mk(lg.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
      // 照在路面上的光
      const beamTex = tex(64, 128, (c) => {
        const g = c.createLinearGradient(0, 128, 0, 0);
        g.addColorStop(0, 'rgba(255,240,200,0.9)');
        g.addColorStop(1, 'rgba(255,240,200,0)');
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(24, 128); c.lineTo(40, 128); c.lineTo(64, 0); c.lineTo(0, 0);
        c.closePath();
        c.fill();
      });
      const bg = new THREE.PlaneGeometry(3.4, 8).rotateX(-Math.PI / 2).translate(0, 0.06, 4.9);
      const bm = new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.disposables.push(beamTex);
      this.beams = mk(bg, bm);
      this.beams.renderOrder = 4;
    }

    // ---------- 鞭炮陣 ----------
    for (const h of race.hazards) if (h.mats) h.mats.forEach((_m, k) => this.mats.push({ h, k }));
    if (this.mats.length) {
      // 鋪在地上的鞭炮：一排排紅色的炮仔，中間一條金色的引信
      const crackTex = tex(256, 256, (c) => {
        c.clearRect(0, 0, 256, 256);
        const r = (i: number) => hash01(i, 77);
        for (let row = 0; row < 7; row++) {
          const y0 = 20 + row * 34;
          // 引信
          c.strokeStyle = 'rgba(235,190,70,0.95)';
          c.lineWidth = 3;
          c.beginPath();
          for (let x = 8; x <= 248; x += 8) c.lineTo(x, y0 + Math.sin(x * 0.08 + row) * 3);
          c.stroke();
          // 炮仔
          for (let x = 10; x < 246; x += 7) {
            const yy = y0 + Math.sin(x * 0.08 + row) * 3;
            c.fillStyle = r(row * 100 + x) < 0.85 ? '#d0201a' : '#f2c230';
            c.save();
            c.translate(x, yy);
            c.rotate((r(row * 31 + x) - 0.5) * 0.6 + (x % 14 ? 0.5 : -0.5));
            c.fillRect(-2, -11, 4.5, 22);
            c.restore();
          }
        }
        // 散落的紅紙
        for (let i = 0; i < 160; i++) {
          c.fillStyle = 'rgba(200,30,25,0.7)';
          c.fillRect(r(i) * 256, r(i + 999) * 256, 3, 2);
        }
      });
      const g = new THREE.PlaneGeometry(CRACKER.halfW * 2, CRACKER.halfLen * 2).rotateX(-Math.PI / 2);
      const m = new THREE.MeshBasicMaterial({ map: crackTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      this.disposables.push(crackTex, g, m);
      this.matMesh = new THREE.InstancedMesh(g, m, this.mats.length);
      this.matMesh.renderOrder = 3;
      // 炸開時地面的火光
      const glowTex = tex(64, 64, (c) => {
        const gr = c.createRadialGradient(32, 32, 2, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,220,150,1)');
        gr.addColorStop(1, 'rgba(255,120,40,0)');
        c.fillStyle = gr;
        c.fillRect(0, 0, 64, 64);
      });
      const gg = new THREE.PlaneGeometry(CRACKER.halfW * 3.2, CRACKER.halfLen * 3.2).rotateX(-Math.PI / 2);
      const gm = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      this.disposables.push(glowTex, gg, gm);
      this.matGlow = new THREE.InstancedMesh(gg, gm, this.mats.length);
      this.matGlow.renderOrder = 5;
      this.mats.forEach(({ h, k }, i) => {
        const mt = h.mats![k];
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(mt.tx, mt.tz));
        this.m4.compose(this.v.set(mt.x, mt.y + 0.05, mt.z), this.q, this.s.set(1, 1, 1));
        this.matMesh!.setMatrixAt(i, this.m4);
        this.m4.compose(this.v.set(mt.x, mt.y + 0.07, mt.z), this.q, this.s.set(1, 1, 1));
        this.matGlow!.setMatrixAt(i, this.m4);
        this.matMesh!.setColorAt(i, this.c.setRGB(1, 1, 1));
        this.matGlow!.setColorAt(i, this.c.setRGB(0, 0, 0));
      });
      this.matMesh.frustumCulled = this.matGlow.frustumCulled = false;
      this.group.add(this.matMesh, this.matGlow);
    }

    // ---------- 平交道 ----------
    for (const h of race.hazards) {
      if (h.def.kind !== 'tram' || !h.def.train) continue;
      const g = new THREE.Group();
      g.position.set(h.x, h.y, h.z);
      g.rotation.y = Math.atan2(h.tx, h.tz);
      this.group.add(g);
      // 群組座標：+X = 賽道左側法線（火車沿 X 開），+Z = 前進方向
      const solid = new Geo(), glow = new Geo();
      const reach = hw + 4.2;
      // 路面上的平交道鋪面與鐵軌
      solid.box(0, -0.02, 0, 1, 0, reach * 2, TRAIN.width * 2 + 1.6, 0.06, [0.2, 0.2, 0.22]);
      for (const z of [-0.75, 0.75]) solid.box(0, 0.03, z, 1, 0, reach * 2, 0.14, 0.07, [0.7, 0.72, 0.76]);
      // 黃黑的停止線
      for (const z of [-(TRAIN.width + 3.2), TRAIN.width + 3.2]) for (let x = -hw; x < hw; x += 2) solid.box(x + 0.5, 0.0, z, 1, 0, 1, 0.5, 0.05, (x / 2) % 2 ? [0.95, 0.75, 0.1] : [0.1, 0.1, 0.1]);
      // 兩側（路的左右）的號誌柱：叉型的「停看聽」牌、兩顆輪流閃的紅燈、柵欄
      const xTex = tex(256, 128, (c) => {
        c.clearRect(0, 0, 256, 128);
        c.fillStyle = '#ffffff';
        c.fillRect(8, 30, 240, 68);
        c.strokeStyle = '#d0201a';
        c.lineWidth = 8;
        c.strokeRect(12, 34, 232, 60);
        c.fillStyle = '#d0201a';
        c.font = `bold 46px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('停 看 聽', 128, 66);
      });
      const xm = new THREE.MeshBasicMaterial({ map: xTex, transparent: true, side: THREE.DoubleSide, color: new THREE.Color(1.1, 1.1, 1.1) });
      this.disposables.push(xTex, xm);
      const lamps: THREE.Mesh[] = [];
      const arms: THREE.Object3D[] = [];
      const armTex = tex(128, 16, (c) => {
        for (let x = 0; x < 128; x += 16) {
          c.fillStyle = (x / 16) % 2 ? '#1a1a1a' : '#ffd200';
          c.fillRect(x, 0, 16, 16);
        }
      });
      armTex.wrapS = THREE.RepeatWrapping;
      armTex.repeat.set(5, 1);
      const armMat = new THREE.MeshLambertMaterial({ map: armTex, emissive: 0x332a00 });
      this.disposables.push(armTex, armMat);
      const armLen = hw - 0.4;
      for (const sx of [1, -1]) for (const sz of [1, -1]) {
        // 柵欄：在鐵軌的前後各一支，從路邊伸向路中央
        const z = sz * (TRAIN.width + 2.2);
        const x = sx * (hw + 1.3);
        solid.box(x, 0, z, 1, 0, 0.5, 0.5, 1.2, [0.95, 0.95, 0.92]);
        const pivot = new THREE.Group();
        pivot.position.set(x, 1.15, z);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.16, 0.16).translate(-sx * armLen / 2, 0, 0), armMat);
        pivot.add(arm);
        // 柵欄中間的紅燈
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), this.lampOff);
        lamp.position.set(-sx * armLen * 0.55, 0.12, 0);
        pivot.add(lamp);
        lamps.push(lamp);
        pivot.userData.sx = sx;
        g.add(pivot);
        arms.push(pivot);
        this.disposables.push(arm.geometry, lamp.geometry);
      }
      for (const sx of [1, -1]) {
        const x = sx * (hw + 2.4), z = -sx * (TRAIN.width + 3.6);
        solid.cyl(x, 0, z, 0.12, 4.6, 8, [0.92, 0.92, 0.9]);
        const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3), xm);
        board.position.set(x, 4.1, z);
        board.rotation.y = sx > 0 ? 0 : Math.PI;
        g.add(board);
        this.disposables.push(board.geometry);
        for (const dx of [-0.42, 0.42]) {
          solid.box(x + dx, 2.75, z + sx * 0.05, 1, 0, 0.5, 0.25, 0.5, [0.1, 0.1, 0.1]);
          const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.2, 12), this.lampOff);
          lamp.position.set(x + dx, 3.0, z - sx * 0.1);
          lamp.rotation.y = sx > 0 ? Math.PI : 0;
          g.add(lamp);
          lamps.push(lamp);
          this.disposables.push(lamp.geometry);
        }
      }
      const sm = new THREE.Mesh(solid.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
      sm.receiveShadow = shadows;
      g.add(sm);
      this.disposables.push(sm.geometry, sm.material as THREE.Material);
      // 火車：三節，車頭有大燈與「區間」字樣
      const train = new THREE.Group();
      const body = new Geo(), lit = new Geo();
      const carL = (TRAIN.half * 2) / 3, W = TRAIN.width * 2, H0 = 0.75, H1 = 4.0;
      for (let k = 0; k < 3; k++) {
        const cx = -TRAIN.half + carL * (k + 0.5);
        body.box(cx, H0, 0, 1, 0, carL - 0.5, W, H1 - H0, [0.82, 0.84, 0.86]);
        body.box(cx, 0.25, 0, 1, 0, carL - 3, W - 0.6, 0.5, [0.15, 0.15, 0.16]);
        // 藍色與橘色的腰帶（不是任何真的車種）
        for (const s of [-1, 1]) {
          body.quad([cx - carL / 2 + 0.3, 1.25, s * (W / 2 + 0.01)], [cx + carL / 2 - 0.3, 1.25, s * (W / 2 + 0.01)], [cx + carL / 2 - 0.3, 1.6, s * (W / 2 + 0.01)], [cx - carL / 2 + 0.3, 1.6, s * (W / 2 + 0.01)], [0, 0, 1, 1], [0.12, 0.3, 0.75], [0, 0, s]);
          body.quad([cx - carL / 2 + 0.3, 1.6, s * (W / 2 + 0.012)], [cx + carL / 2 - 0.3, 1.6, s * (W / 2 + 0.012)], [cx + carL / 2 - 0.3, 1.72, s * (W / 2 + 0.012)], [cx - carL / 2 + 0.3, 1.72, s * (W / 2 + 0.012)], [0, 0, 1, 1], [0.95, 0.5, 0.1], [0, 0, s]);
          // 車窗（夜裡車廂內亮著）
          for (let wx = cx - carL / 2 + 1.6; wx < cx + carL / 2 - 1.6; wx += 2.2) {
            lit.quad([wx - 0.8, 2.0, s * (W / 2 + 0.02)], [wx + 0.8, 2.0, s * (W / 2 + 0.02)], [wx + 0.8, 3.1, s * (W / 2 + 0.02)], [wx - 0.8, 3.1, s * (W / 2 + 0.02)], [0, 0, 1, 1], [1.05, 1.0, 0.82], [0, 0, s]);
          }
        }
        // 集電弓
        if (k === 1) for (const dz of [-0.5, 0.5]) body.box(cx, H1, dz, 1, 0, 1.6, 0.08, 1.2, [0.3, 0.3, 0.3], false);
      }
      for (const end of [-1, 1]) {
        const x = end * TRAIN.half;
        lit.quad([x + end * 0.02, 2.2, -1.2], [x + end * 0.02, 2.2, 1.2], [x + end * 0.02, 3.3, 1.2], [x + end * 0.02, 3.3, -1.2], [0, 0, 1, 1], [0.35, 0.42, 0.5], [end, 0, 0]);
        for (const z of [-1.05, 1.05]) lit.box(x + end * 0.03, 1.15, z, 0, 1, 0.5, 0.06, 0.32, [3, 2.9, 2.4]);
        lit.quad([x + end * 0.03, 3.45, -0.8], [x + end * 0.03, 3.45, 0.8], [x + end * 0.03, 3.85, 0.8], [x + end * 0.03, 3.85, -0.8], [0, 0, 1, 1], [2.2, 0.6, 0.15], [end, 0, 0]);
      }
      const tb = new THREE.Mesh(body.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
      tb.castShadow = shadows;
      const tl = new THREE.Mesh(lit.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
      train.add(tb, tl);
      train.visible = false;
      g.add(train);
      this.disposables.push(tb.geometry, tb.material as THREE.Material, tl.geometry, tl.material as THREE.Material);
      this.trains.push({ h, train, arms, lamps });
    }

    // ---------- 強風 ----------
    for (const h of race.hazards) {
      if (h.def.kind !== 'gust') continue;
      const N = low ? 60 : 140;
      const pos = new Float32Array(N * 6), seed = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) seed.set([hash01(i, 5), hash01(i, 6), hash01(i, 7)], i * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.LineBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const lines = new THREE.LineSegments(g, mat);
      lines.frustumCulled = false;
      this.group.add(lines);
      this.disposables.push(g, mat);
      // 風向袋：區段頭尾各一個（在河那一側的欄杆外）
      const socks: THREE.Object3D[] = [];
      const sockMat = new THREE.MeshLambertMaterial({ color: 0xff6a1a, emissive: 0x401000 });
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
      this.disposables.push(sockMat, poleMat);
      for (const dd of [10, (h.def.len ?? 120) - 10]) {
        const p = track.pointAt(h.def.dist + dd);
        const lat = -(hw + 2.2);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 6).translate(0, 3, 0), poleMat);
        pole.position.set(p.x + p.nx * lat, p.y, p.z + p.nz * lat);
        this.group.add(pole);
        const pivot = new THREE.Group();
        pivot.position.set(pole.position.x, p.y + 5.8, pole.position.z);
        pivot.rotation.y = Math.atan2(p.nx, p.nz);
        const sock = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.4, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 1.2), sockMat);
        pivot.add(sock);
        this.group.add(pivot);
        socks.push(pivot);
        this.disposables.push(pole.geometry, sock.geometry);
      }
      this.gusts.push({ h, lines, pos, seed, socks, mat });
    }
    void theme;
  }

  update(race: Race, time: number): void {
    const dt = this.last < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.last));
    this.last = time;
    const R = Math.random;
    // ---------- 機車 ----------
    if (this.scooter) {
      let n = 0;
      for (const { h, k } of this.riders) {
        const r = h.riders![k];
        if (!r.on) continue;
        this.e.set(0, r.yaw, r.lean, 'YXZ');
        this.q.setFromEuler(this.e);
        // 小小的上下晃動
        this.m4.compose(this.v.set(r.x, r.y + Math.abs(Math.sin(time * 9 + k)) * 0.03, r.z), this.q, this.s.set(1, 1, 1));
        for (const im of [this.scooter, this.rider!, this.helmet!, this.lights!]) im.setMatrixAt(n, this.m4);
        this.e.set(0, r.yaw, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.m4.compose(this.v.set(r.x, r.y, r.z), this.q, this.s.set(1, 1, 1));
        this.beams!.setMatrixAt(n, this.m4);
        const look = r.look;
        this.scooter.setColorAt(n, this.c.setHex([0xe8e6e2, 0x1e1e22, 0xc8302a, 0x2a5cb0, 0x8fbf3a, 0xf2c230, 0xff8ab0, 0x3ab0b0][look & 7]));
        this.rider!.setColorAt(n, this.c.setHex([0x2f3542, 0xd94848, 0x3a7bd5, 0xf2c94c, 0x46a36a, 0xe8e4dc, 0xff8a3a, 0x8a6ad0][(look * 3 + 1) & 7]));
        this.helmet!.setColorAt(n, this.c.setHex([0xf4f4f0, 0xd0201a, 0x1d4fc4, 0xf2c230, 0x222222, 0xff8ab0, 0x13924a, 0xffffff][(look * 5 + 2) & 7]));
        n++;
      }
      for (const im of [this.scooter, this.rider!, this.helmet!, this.lights!, this.beams!]) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
    // ---------- 鞭炮 ----------
    if (this.matMesh && this.matGlow) {
      this.mats.forEach(({ h, k }, i) => {
        const m = h.mats![k];
        let b = 1, gl = 0;
        if (m.state === 1) {
          // 引信燒著：鞭炮一閃一閃，火花從路邊沿著引信跑過來
          b = 1.1 + 0.6 * Math.abs(Math.sin(time * 18 + i));
          gl = 0.15 + 0.15 * m.t;
          if (dt > 0) {
            const side = m.c >= 0 ? 1 : -1;
            const from = (CRACKER.halfW + 4) * side, to = CRACKER.halfW * side;
            const lat = from + (to - from) * m.t;
            const x = m.x + m.nx * lat, z = m.z + m.nz * lat;
            for (let s = 0; s < 3; s++) this.pop.spawn(x, m.y + 0.15, z, (R() - 0.5) * 3, 1 + R() * 3, (R() - 0.5) * 3, 0.25 + R() * 0.2, 0.5, 0.1, 1, 0.85, 0.4, 1, 9, 0.5, m.y);
            if (R() < 0.4) this.smoke.spawn(x, m.y + 0.3, z, 0, 0.8, 0, 0.9, 0.5, 1.6, 0.8, 0.78, 0.75, 0.35, -0.2, 0.8);
          }
        } else if (m.state === 2) {
          // 炸開：整片劈哩啪啦，火光、白煙、紅紙屑
          b = 0.6 + R() * 1.6;
          gl = 0.55 + R() * 0.6 * (1 - m.t * 0.5);
          if (dt > 0) {
            const pops = Math.round((this.low ? 4 : 9) * (1 - m.t * 0.6));
            for (let s = 0; s < pops; s++) {
              const a = (R() * 2 - 1) * CRACKER.halfLen, l = (R() * 2 - 1) * CRACKER.halfW;
              const x = m.x + m.tx * a + m.nx * l, z = m.z + m.tz * a + m.nz * l;
              this.pop.spawn(x, m.y + 0.25 + R() * 0.4, z, 0, 0, 0, 0.06 + R() * 0.07, 1.4 + R() * 1.2, 0.3, 1, 0.92, 0.6, 1);
              if (R() < 0.5) this.pop.spawn(x, m.y + 0.3, z, (R() - 0.5) * 8, 3 + R() * 6, (R() - 0.5) * 8, 0.3 + R() * 0.3, 0.35, 0.05, 1, 0.75, 0.3, 1, 14, 0.3, m.y);
              if (R() < 0.3) this.smoke.spawn(x, m.y + 0.5, z, (R() - 0.5) * 2, 1.4 + R() * 1.8, (R() - 0.5) * 2, 1.3 + R() * 0.8, 1.0, 3 + R() * 1.5, 0.82, 0.8, 0.78, 0.3, -0.25, 0.8);
              if (R() < 0.3) this.smoke.spawn(x, m.y + 0.4, z, (R() - 0.5) * 5, 3 + R() * 4, (R() - 0.5) * 5, 1.2 + R(), 0.22, 0.18, 0.85, 0.12, 0.1, 1, 6, 1.5, m.y);
            }
          }
        } else if (m.t < 0.25) {
          // 剛炸完：燒焦的暗色
          b = 0.35 + m.t * 2.6;
        }
        this.matMesh!.setColorAt(i, this.c.setRGB(b, b, b));
        this.matGlow!.setColorAt(i, this.c.setRGB(gl * 1.6, gl * 1.0, gl * 0.5));
      });
      this.matMesh.instanceColor!.needsUpdate = true;
      this.matGlow.instanceColor!.needsUpdate = true;
    }
    // ---------- 平交道 ----------
    for (const t of this.trains) {
      const h = t.h;
      t.train.visible = Math.abs(h.c) < TRAIN.reach - 0.5;
      t.train.position.x = h.c;
      // 柵欄：警示中放下來（只放到斜斜的角度，車子從底下鑽得過去）
      const want = h.warn ? 0.42 : 1.45;
      for (const a of t.arms) {
        const cur = a.userData.ang ?? 1.45;
        const ang = cur + (want - cur) * Math.min(1, dt * 2.2);
        a.userData.ang = ang;
        a.rotation.z = -a.userData.sx * ang;
      }
      const on = h.warn && Math.floor(time * 3) % 2 === 0;
      t.lamps.forEach((l, k) => { l.material = h.warn && on === (k % 2 === 0) ? this.lampOn : this.lampOff; });
    }
    // ---------- 強風 ----------
    for (const g of this.gusts) {
      const s = g.h.gust ?? 0;
      g.mat.opacity = Math.min(0.55, s * 0.6);
      const tr = race.track, def = g.h.def;
      const len = def.len ?? 120;
      const N = g.seed.length / 3;
      for (let i = 0; i < N; i++) {
        const a = g.seed[i * 3], b = g.seed[i * 3 + 1], c2 = g.seed[i * 3 + 2];
        const p = tr.pointAt(def.dist + a * len);
        // 從河那一側（右）吹向左側：橫向位置隨時間往左移
        const span = 70;
        const lat = -span / 2 + (((time * (22 + b * 10) + c2 * span) % span) + span) % span;
        const y = p.y + 0.6 + b * 6;
        const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
        const l = 2.5 + s * 4;
        g.pos.set([x, y, z, x - p.nx * l, y - 0.1, z - p.nz * l], i * 6);
      }
      g.lines.geometry.attributes.position.needsUpdate = true;
      for (const sk of g.socks) {
        // 沒風時下垂、有風時被吹平（指向下風處）
        sk.rotation.x = 1.3 * (1 - s) + Math.sin(time * 7) * 0.08 * s;
      }
    }
    this.pop.update(dt);
    this.smoke.update(dt);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.pop.points.geometry.dispose();
    this.smoke.points.geometry.dispose();
  }
}
