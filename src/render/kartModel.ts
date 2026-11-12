import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { PrimaryId, SecondaryId } from '../game/weapons';
import { cloneModel } from './assets';
import { liveryMaterial, type Livery } from './livery';
import { buildPrimary, buildSecondary } from './weaponModels';

const DARK = new THREE.MeshLambertMaterial({ color: 0x23262d });
const METAL = new THREE.MeshLambertMaterial({ color: 0x8c93a0 });
const GUN = new THREE.MeshLambertMaterial({ color: 0x3f444e });
const GUN_LIGHT = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
const TIRE = new THREE.MeshLambertMaterial({ color: 0x17181c });
const HUB = new THREE.MeshLambertMaterial({ color: 0xd9dde5 });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
const SKIN = new THREE.MeshLambertMaterial({ color: 0x2b3440 });
const WARHEAD = new THREE.MeshLambertMaterial({ color: 0xff5533 });
const additive = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const FLAME = additive(0x59ccff, 0.85);
const FLAME_CORE = additive(0xffffff, 0.9);
const FLAME_MINI = additive(0xffa033, 0.85);
const MUZZLE = additive(0xffd27a, 0.95);
const FIRE = additive(0xff7a1a, 0.8);
const FIRE_CORE = additive(0xffe08a, 0.85);
const BEAM = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.5, 0.6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
const BEAM_CORE = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const SHADOW = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.36, 14).rotateZ(Math.PI / 2);
const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.38, 8).rotateZ(Math.PI / 2);
const flameGeo = new THREE.ConeGeometry(0.24, 1.8, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.9);
const flameCoreGeo = new THREE.ConeGeometry(0.11, 1.1, 6).rotateX(-Math.PI / 2).translate(0, 0, -0.55);
const shadowGeo = new THREE.CircleGeometry(1.75, 18).rotateX(-Math.PI / 2);
// 火焰噴流：從噴嘴往前的圓錐
const fireGeo = new THREE.ConeGeometry(0.55, 5, 9, 1, true).rotateX(Math.PI / 2).translate(0, 0, 2.5);
const fireCoreGeo = new THREE.ConeGeometry(0.22, 3, 7, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.5);
// 雷射光束：長度 1、沿 +Z，用 scale.z 拉長
const beamGeo = new THREE.BoxGeometry(0.16, 0.16, 1).translate(0, 0, 0.5);
const beamCoreGeo = new THREE.BoxGeometry(0.06, 0.06, 1).translate(0, 0, 0.5);
// 槍口火光：兩片交叉的菱形
const muzzleGeo = (() => {
  const a = new THREE.PlaneGeometry(0.5, 1.3).rotateX(Math.PI / 2).translate(0, 0, 0.65);
  const b = a.clone().rotateZ(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([...a.attributes.position.array, ...b.attributes.position.array]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const ia = Array.from(a.index!.array);
  g.setIndex([...ia, ...ia.map((i) => i + 4)]);
  return g;
})();
// N2O 時包住車頭的破風氣流：前窄後寬的圓錐殼，貼圖是一條條往後流的氣流線
const shellGeo = new THREE.CylinderGeometry(0.35, 2.1, 4.6, 18, 1, true).rotateX(Math.PI / 2);
const shellTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 128;
  const c = cv.getContext('2d')!;
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 64, y = Math.random() * 128, h = 20 + Math.random() * 60;
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,' + (0.3 + Math.random() * 0.6).toFixed(2) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, 1 + Math.random() * 2, h);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
})();
const SHELL = new THREE.MeshBasicMaterial({
  map: shellTex, color: new THREE.Color(0.55, 0.85, 1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const WING_GLOW = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.6, 2.6) });

// 甩尾時從後輪往外後方噴出的白色破風：好幾道帶鋸齒的弧線
const sprayTex = [0, 1, 2].map((seed) => {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 192;
  const c = cv.getContext('2d')!;
  let s = 1234 + seed * 777;
  const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  c.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    // 從左下角（後輪）往右上（外側、後方）扇形散開
    const ang = 0.15 + R() * 1.1;
    const len = 120 + R() * 140;
    let x = 4 + R() * 10, y = 186 - R() * 10;
    c.strokeStyle = 'rgba(255,255,255,' + (0.35 + R() * 0.6).toFixed(2) + ')';
    c.lineWidth = 2 + R() * 3.5;
    c.beginPath();
    c.moveTo(x, y);
    const steps = 8;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, bend = ang + t * 0.35;
      const jag = (R() - 0.5) * 9 * t;
      x += (Math.cos(bend) * len) / steps + jag * Math.sin(bend);
      y -= (Math.sin(bend) * len) / steps - jag * Math.cos(bend);
      c.lineTo(x, y);
    }
    c.stroke();
    // 尖刺
    if (R() < 0.6) {
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 14 + R() * 18, y - 4 - R() * 10);
      c.lineTo(x + 2, y + 3);
      c.closePath();
      c.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
});
// 噴花平面：內側前緣（後輪位置）在原點，往外側（+X）與後方（-Z）展開
const sprayGeo = new THREE.PlaneGeometry(2.3, 3.2).rotateX(-Math.PI / 2).translate(1.15, 0, -1.6);
// 排氣管的螺旋火環（甩尾集氣時出現）
const swirlTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d')!;
  c.translate(32, 32);
  c.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    c.strokeStyle = k === 0 ? 'rgba(255,240,170,0.95)' : 'rgba(255,170,40,0.85)';
    c.lineWidth = k === 0 ? 3 : 4;
    c.beginPath();
    for (let a = 0; a < Math.PI * 3.2; a += 0.15) {
      const r = 4 + a * 2.6 + k;
      const x = Math.cos(a + k * 2.1) * r, y = Math.sin(a + k * 2.1) * r;
      if (a === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  }
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 30);
  g.addColorStop(0, 'rgba(255,220,120,0.5)');
  g.addColorStop(1, 'rgba(255,140,30,0)');
  c.fillStyle = g;
  c.fillRect(-32, -32, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

const SHARED_GEOS = new Set<THREE.BufferGeometry>([sprayGeo, shellGeo, wheelGeo, hubGeo, flameGeo, flameCoreGeo, shadowGeo, muzzleGeo, fireGeo, fireCoreGeo, beamGeo, beamCoreGeo]);

/** 模型放大倍率：Kenney 卡丁車原始約 1 m 寬，放大成遊戲中的車體尺寸 */
const MODEL_SCALE = 1.9;
/** Tripo 車體縮放到這個車長（公尺） */
const CAR_LENGTH = 2.9;

/** 車上各種配件的位置（車體座標，車頭朝 +Z） */
interface Mounts {
  gunX: number; gunY: number; gunZ: number;
  hoodY: number; hoodZ: number;
  rearY: number; rearZ: number;
  /** 車尾（噴射火焰、排氣管火環） */
  tailZ: number; exhaustY: number;
  halfW: number; top: number;
  wingY: number; wingZ: number;
  spoilerY: number; spoilerZ: number;
  shellY: number; shellZ: number;
  sprayZ: number;
}
const KART_MOUNTS: Mounts = {
  gunX: 0.7, gunY: 0.95, gunZ: 0.2, hoodY: 0.66, hoodZ: 1.12, rearY: 0.55, rearZ: -1.2, tailZ: -1.15, exhaustY: 0.58,
  halfW: 0.85, top: 2.3, wingY: 0.6, wingZ: -0.45, spoilerY: 0.72, spoilerZ: -1.1, shellY: 0.75, shellZ: 0.75, sprayZ: -0.75,
};

function box(w: number, h: number, l: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
  mesh.position.set(x, y, z);
  return mesh;
}

function barrel(r: number, len: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8).rotateX(Math.PI / 2), m);
  mesh.position.set(x, y, z);
  return mesh;
}

export interface KartLook {
  color: number;
  primary: PrimaryId;
  secondary: SecondaryId;
  isPlayer: boolean;
  /** 車體模型名稱（tripo/… 或 Kenney 卡丁車）；載入失敗時改用 fallback，再不行就用內建幾何車 */
  model: string;
  fallback?: string;
  /** Tripo 車體的花色 */
  livery?: Livery;
}

/** 一台車的畫面：車體模型 + 武器 + 火焰 + 血條。車頭朝 +Z。 */
export class KartView {
  group = new THREE.Group();
  body = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private frontWheels: THREE.Object3D[] = [];
  private character: THREE.Object3D | null = null;
  private flames: THREE.Mesh[] = [];
  private cores: THREE.Mesh[] = [];
  private muzzles: THREE.Mesh[] = [];
  private muzzleT = [0, 0];
  private vulcanBarrels: THREE.Object3D[] = [];
  /** 火焰發射器的噴流與雷射光束（左右各一） */
  private fires: THREE.Object3D[] = [];
  private beams: THREE.Object3D[] = [];
  /** N2O 變形：兩側展開的翼片與升起的尾翼，以及破風氣流 */
  private wings: THREE.Group[] = [];
  private spoiler = new THREE.Group();
  private shell: THREE.Mesh;
  private deploy = 0;
  /** 甩尾的破風噴花（左右各一）與排氣管的螺旋火環 */
  private sprays: THREE.Mesh[] = [];
  private swirls: THREE.Sprite[] = [];
  private sprayT = 0;
  private paint: THREE.MeshLambertMaterial;
  /** 翼片等配件的顏色（Kenney 車用車身色，Tripo 車用車手代表色） */
  private trim: THREE.MeshLambertMaterial;
  private m: Mounts = { ...KART_MOUNTS };
  private ownMats: THREE.Material[] = [];
  private hpTex?: THREE.CanvasTexture;
  private hpCtx?: CanvasRenderingContext2D;
  private hpSprite?: THREE.Sprite;
  private lastHp = -1;
  private fakeYaw = 0;
  private t = Math.random() * 10;
  /** 被擊毀後變成翻滾燃燒的殘骸（純畫面效果） */
  wrecked = false;
  wreckT = 0;
  private wreckV = new THREE.Vector3();
  private wreckSpin = new THREE.Vector3();
  private lastVx = 0;
  private lastVz = 0;
  private baseColor = new THREE.Color();
  private tumbleAngle = 0;

  constructor(look: KartLook, shadows: boolean) {
    const g = this.group;
    const b = this.body;
    g.rotation.order = 'YXZ';
    g.add(b);
    this.paint = new THREE.MeshLambertMaterial({ color: look.color });
    this.trim = this.paint;
    this.ownMats.push(this.paint);

    let model = cloneModel(look.model);
    if (model && look.model.startsWith('tripo/')) this.buildFromTripo(model, look);
    else {
      if (!model && look.fallback) model = cloneModel(look.fallback);
      if (model) this.buildFromModel(model, look);
      else {
        this.buildProcedural(look);
        this.m.tailZ = -1.5;
        this.m.top = 1.8;
      }
    }
    this.baseColor.copy(this.paint.color);
    this.addWeapons(look.primary, look.secondary);
    this.shell = new THREE.Mesh(shellGeo, SHELL);
    this.addBoostKit();
    this.addDriftFx();

    // 噴射火焰
    for (const x of [-0.3, 0.3]) {
      const f = new THREE.Mesh(flameGeo, FLAME);
      f.position.set(x, this.m.exhaustY, this.m.tailZ);
      f.visible = false;
      const core = new THREE.Mesh(flameCoreGeo, FLAME_CORE);
      f.add(core);
      b.add(f);
      this.flames.push(f);
      this.cores.push(core);
    }

    if (shadows) {
      b.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !(m.material as THREE.Material).transparent) m.castShadow = true;
      });
    } else {
      const sh = new THREE.Mesh(shadowGeo, SHADOW);
      sh.position.y = 0.045;
      sh.renderOrder = 1;
      g.add(sh);
    }

    // 敵車血條
    if (!look.isPlayer) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 8;
      this.hpCtx = c.getContext('2d')!;
      this.hpTex = new THREE.CanvasTexture(c);
      this.hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.hpTex, depthTest: false, transparent: true }));
      this.hpSprite.scale.set(2.6, 0.32, 1);
      this.hpSprite.position.y = this.m.top + 0.8;
      this.hpSprite.renderOrder = 20;
      g.add(this.hpSprite);
    }
  }

  /**
   * Tripo 車體：縮放到固定車長、底部貼地，再用射線量出引擎蓋、車尾、車身側面的位置，
   * 讓武器與配件自動貼合不同外型的車。貼圖本身就有顏色，所以不染色。
   */
  private buildFromTripo(model: THREE.Object3D, look: KartLook): void {
    const box0 = new THREE.Box3().setFromObject(model);
    const size = box0.getSize(new THREE.Vector3()), c = box0.getCenter(new THREE.Vector3());
    const s = CAR_LENGTH / Math.max(size.z, 0.001);
    model.scale.setScalar(s);
    model.position.set(-c.x * s, -box0.min.y * s, -c.z * s);
    this.body.add(model);
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 每台車各自一份材質，受擊閃紅與殘骸變黑才不會影響別台
      const mat = liveryMaterial(mesh.material as THREE.Material, look.livery);
      this.ownMats.push(mat);
      mesh.material = mat;
      mesh.userData.own = false;
      this.paint = mat;
      meshes.push(mesh);
    });
    this.trim = new THREE.MeshLambertMaterial({ color: look.color });
    this.ownMats.push(this.trim);
    this.body.updateMatrixWorld(true);
    const L = size.z * s, W = size.x * s, H = size.y * s;
    const rc = new THREE.Raycaster();
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    const topAt = (z: number, fb: number) => {
      rc.set(o.set(0, H + 5, z), d.set(0, -1, 0));
      const h = rc.intersectObjects(meshes, false)[0];
      return h ? h.point.y : fb;
    };
    const sideAt = (y: number, z: number) => {
      let x = 0;
      for (const dir of [1, -1]) {
        rc.set(o.set(dir * (W + 5), y, z), d.set(-dir, 0, 0));
        const h = rc.intersectObjects(meshes, false)[0];
        x = Math.max(x, h ? Math.abs(h.point.x) : W / 2);
      }
      return x;
    };
    const m = this.m;
    m.halfW = W / 2;
    m.top = H;
    m.gunY = H * 0.5;
    m.gunZ = 0.15;
    m.gunX = sideAt(m.gunY, m.gunZ) + 0.12;
    m.hoodZ = L * 0.3;
    m.hoodY = topAt(m.hoodZ, H * 0.55);
    m.rearZ = -L * 0.36;
    m.rearY = topAt(m.rearZ, H * 0.55) - 0.05;
    m.tailZ = -L / 2 - 0.05;
    m.exhaustY = H * 0.28;
    m.wingY = H * 0.42;
    m.wingZ = -L * 0.12;
    m.spoilerZ = -L * 0.43;
    m.spoilerY = topAt(m.spoilerZ, H * 0.6) - 0.15;
    m.shellY = H * 0.45;
    m.shellZ = L * 0.22;
    m.sprayZ = -L * 0.27;
  }

  private buildFromModel(model: THREE.Object3D, look: KartLook): void {
    model.scale.setScalar(MODEL_SCALE);
    this.body.add(model);
    // 車身染成車手代表色；輪子與角色維持原色
    let tinted: THREE.MeshLambertMaterial | null = null;
    model.traverse((o) => {
      if (o.name.startsWith('wheel-')) {
        o.rotation.order = 'YXZ';
        this.wheels.push(o);
        if (o.name.includes('front')) this.frontWheels.push(o);
      } else if (o.name === 'character') {
        this.character = o;
      }
    });
    const skip = new Set<THREE.Object3D>();
    for (const w of [...this.wheels, ...(this.character ? [this.character] : [])]) w.traverse((o) => skip.add(o));
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || skip.has(o)) return;
      if (!tinted) {
        tinted = (m.material as THREE.MeshLambertMaterial).clone();
        tinted.color.set(look.color).lerp(new THREE.Color(0xffffff), 0.12);
        this.ownMats.push(tinted);
        this.paint = tinted;
      }
      m.material = tinted;
    });
    this.trim = this.paint;
  }

  private buildProcedural(look: KartLook): void {
    const b = this.body;
    const paint = this.paint;
    b.add(box(1.5, 0.3, 2.7, paint, 0, 0.45, 0));
    b.add(box(1.0, 0.26, 0.9, paint, 0, 0.52, 1.5));
    b.add(box(1.95, 0.1, 0.36, DARK, 0, 0.32, 1.98));
    b.add(box(0.36, 0.36, 1.3, paint, 0.9, 0.5, -0.1));
    b.add(box(0.36, 0.36, 1.3, paint, -0.9, 0.5, -0.1));
    b.add(box(0.9, 0.62, 0.3, DARK, 0, 0.9, -0.72));
    b.add(box(1.0, 0.46, 0.62, METAL, 0, 0.72, -1.2));
    b.add(box(1.75, 0.08, 0.42, paint, 0, 1.28, -1.45));
    b.add(box(0.56, 0.5, 0.4, SKIN, 0, 0.95, -0.38));
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), look.isPlayer ? WHITE : paint);
    helmet.position.set(0, 1.42, -0.36);
    b.add(helmet);
    const wp: [number, number, boolean][] = [[0.98, 1.05, true], [-0.98, 1.05, true], [1.02, -1.05, false], [-1.02, -1.05, false]];
    for (const [x, z, front] of wp) {
      const w = new THREE.Mesh(wheelGeo, TIRE);
      w.add(new THREE.Mesh(hubGeo, HUB));
      w.position.set(x, 0.4, z);
      w.rotation.order = 'YXZ';
      b.add(w);
      this.wheels.push(w);
      if (front) this.frontWheels.push(w);
    }
  }

  private addWeapons(primary: PrimaryId, secondary: SecondaryId): void {
    const b = this.body;
    const WS = 1.2;
    // 主武器：車身兩側各一把
    for (const side of [1, -1]) {
      const parts = buildPrimary(primary, side);
      const g = parts.group;
      g.scale.setScalar(WS);
      g.position.set(this.m.gunX * side, this.m.gunY - 0.2 * WS, this.m.gunZ - 0.12);
      b.add(g);
      this.vulcanBarrels.push(...parts.spinners);
      const mx = g.position.x, my = g.position.y + parts.muzzle.y * WS, mzz = g.position.z + parts.muzzle.z * WS;
      if (primary === 'flame') {
        const f = new THREE.Group();
        f.position.set(mx, my, mzz);
        f.add(new THREE.Mesh(fireGeo, FIRE), new THREE.Mesh(fireCoreGeo, FIRE_CORE));
        f.visible = false;
        b.add(f);
        this.fires.push(f);
      } else if (primary === 'laser') {
        const beam = new THREE.Group();
        beam.position.set(mx, my, mzz);
        beam.add(new THREE.Mesh(beamGeo, BEAM), new THREE.Mesh(beamCoreGeo, BEAM_CORE));
        beam.visible = false;
        beam.userData.side = side;
        b.add(beam);
        this.beams.push(beam);
      }
      const mz = new THREE.Mesh(muzzleGeo, MUZZLE);
      mz.position.set(mx, my, mzz);
      mz.visible = false;
      b.add(mz);
      this.muzzles.push(mz);
    }
    // 副武器：火箭、榴彈、導彈在引擎蓋上；地雷與圓雷的投放器在車尾
    const sec = buildSecondary(secondary);
    sec.scale.setScalar(1.25);
    if (secondary === 'mine' || secondary === 'cluster') sec.position.set(0, this.m.rearY, this.m.rearZ);
    else sec.position.set(0, this.m.hoodY - 0.06, this.m.hoodZ - 0.12);
    b.add(sec);
  }

  /** 甩尾特效：後輪外側往後噴的白色破風，以及排氣管的螺旋火環 */
  private addDriftFx(): void {
    for (const side of [1, -1]) {
      const g = new THREE.Group();
      g.position.set(side * this.m.halfW, 0.12, this.m.sprayZ);
      g.scale.x = side;
      const mat = new THREE.MeshBasicMaterial({ map: sprayTex[0], transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, color: new THREE.Color(1.5, 1.6, 1.9) });
      this.ownMats.push(mat);
      const m = new THREE.Mesh(sprayGeo, mat);
      m.rotation.z = 0.32; // 外緣微微翹起，從後方看得到
      m.renderOrder = 6;
      g.add(m);
      g.visible = false;
      this.group.add(g);
      this.sprays.push(m);
    }
    for (const x of [-0.3, 0.3]) {
      const sm = new THREE.SpriteMaterial({ map: swirlTex, color: new THREE.Color(2, 1.25, 0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      this.ownMats.push(sm);
      const sp = new THREE.Sprite(sm);
      sp.position.set(x, this.m.exhaustY, this.m.tailZ - 0.1);
      sp.scale.setScalar(0.6);
      sp.visible = false;
      this.body.add(sp);
      this.swirls.push(sp);
    }
  }

  /** N2O 時展開的翼片與尾翼（平常收起來看不到） */
  private addBoostKit(): void {
    const b = this.body;
    const paint = this.trim;
    for (const side of [1, -1]) {
      const w = new THREE.Group();
      w.position.set(side * (this.m.halfW - 0.03), this.m.wingY, this.m.wingZ);
      w.add(box(0.95, 0.045, 0.42, paint, side * 0.47, 0, 0));
      w.add(box(0.95, 0.03, 0.05, WING_GLOW, side * 0.47, 0.01, -0.22));
      w.add(box(0.04, 0.24, 0.36, paint, side * 0.93, 0.11, 0));
      w.visible = false;
      b.add(w);
      this.wings.push(w);
    }
    const sp = this.spoiler;
    sp.position.set(0, this.m.spoilerY, this.m.spoilerZ);
    for (const x of [-0.36, 0.36]) sp.add(box(0.06, 0.42, 0.09, GUN, x, 0.2, 0));
    sp.add(box(1.5, 0.06, 0.38, paint, 0, 0.42, -0.02));
    sp.add(box(1.5, 0.03, 0.05, WING_GLOW, 0, 0.44, -0.2));
    for (const x of [-0.76, 0.76]) sp.add(box(0.05, 0.3, 0.42, paint, x, 0.36, -0.02));
    sp.visible = false;
    b.add(sp);
    // 氣流殼要比照獨立的材質透明度：每台車各自一份
    const mat = SHELL.clone();
    this.ownMats.push(mat);
    this.shell.material = mat;
    this.shell.position.set(0, this.m.shellY, this.m.shellZ);
    this.shell.visible = false;
    this.shell.renderOrder = 5;
    b.add(this.shell);
  }

  /** 開火時讓對應那一側的槍口閃一下 */
  muzzleFlash(side: number): void {
    this.muzzleT[side > 0 ? 0 : 1] = 0.05;
  }

  /** 被擊毀：車身變黑，帶著原本的速度往上彈飛翻滾 */
  startWreck(): void {
    this.wrecked = true;
    this.wreckT = 0;
    const R = Math.random;
    this.wreckV.set(this.lastVx * 0.55 + (R() - 0.5) * 6, 9 + R() * 5, this.lastVz * 0.55 + (R() - 0.5) * 6);
    this.wreckSpin.set((R() - 0.5) * 14, (R() - 0.5) * 8, (R() - 0.5) * 14);
    this.paint.color.copy(this.baseColor).multiplyScalar(0.22);
    this.paint.emissive.setRGB(0.25, 0.06, 0);
    for (const f of this.flames) f.visible = false;
    for (const m of this.muzzles) m.visible = false;
    for (const f of this.fires) f.visible = false;
    for (const bm of this.beams) bm.visible = false;
    for (const w of this.wings) w.visible = false;
    for (const m of this.sprays) m.parent!.visible = false;
    for (const sw of this.swirls) sw.visible = false;
    this.spoiler.visible = false;
    this.shell.visible = false;
    this.deploy = 0;
    if (this.hpSprite) this.hpSprite.visible = false;
    this.group.visible = true;
  }

  updateWreck(dt: number, ground: number): void {
    this.wreckT += dt;
    const g = this.group;
    const v = this.wreckV;
    v.y -= 24 * dt;
    g.position.addScaledVector(v, dt);
    if (g.position.y < ground + 0.55) {
      g.position.y = ground + 0.55;
      if (v.y < 0) v.y = -v.y * 0.36;
      v.x *= 0.72;
      v.z *= 0.72;
      this.wreckSpin.multiplyScalar(0.6);
    }
    g.rotation.x += this.wreckSpin.x * dt;
    g.rotation.y += this.wreckSpin.y * dt;
    g.rotation.z += this.wreckSpin.z * dt;
  }

  endWreck(): void {
    this.wrecked = false;
    this.paint.color.copy(this.baseColor);
    this.paint.emissive.setRGB(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
    this.tumbleAngle = 0;
  }

  update(k: Kart, dt: number): void {
    this.t += dt;
    this.lastVx = k.vx;
    this.lastVz = k.vz;
    const g = this.group;
    g.visible = !k.dead && !(k.invulnT > 0 && k.invulnT < 10 && Math.floor(this.t * 12) % 2 === 0);
    g.position.set(k.x, k.y, k.z);
    g.rotation.y = k.heading;
    g.rotation.x = -k.pitch;
    // 被炸飛時在空中翻滾，落地後轉回正面
    if (k.air > 0 && k.tumble !== 0) this.tumbleAngle += k.tumble * dt;
    else {
      const full = Math.PI * 2;
      this.tumbleAngle -= Math.round(this.tumbleAngle / full) * full;
      this.tumbleAngle *= Math.exp(-14 * dt);
    }
    g.rotation.z = this.tumbleAngle;

    // AI 沒有真的甩尾，用假的車身偏擺讓過彎看起來有滑動感
    const fakeTarget = k.aiAssist && k.speed > 18 ? k.steerVis * 0.38 : 0;
    this.fakeYaw += (fakeTarget - this.fakeYaw) * Math.min(1, dt * 6);
    this.body.rotation.y = this.fakeYaw;
    const lean = -(k.slip * 0.22 + k.steerVis * 0.05 * Math.min(1, k.speed / 20));
    this.body.rotation.z += (lean - this.body.rotation.z) * Math.min(1, dt * 8);
    const fast = k.boostT > 0 || k.padT > 0;
    const pitch = fast ? -0.07 : 0;
    this.body.rotation.x += (pitch - this.body.rotation.x) * Math.min(1, dt * 6);
    this.body.position.y = Math.sin(this.t * 30) * 0.008 * Math.min(1, Math.abs(k.speed) / 10);
    if (this.character) this.character.rotation.z = -lean * 0.9 - k.steerVis * 0.18;

    const spin = (k.speed / 0.4) * dt;
    const st = k.steerVis * 0.45 - (k.drifting ? k.slip * 0.6 : 0);
    for (const w of this.wheels) w.rotation.x += spin;
    for (const w of this.frontWheels) w.rotation.y = st;
    for (const v of this.vulcanBarrels) v.rotation.z += k.spin * 40 * dt;
    const firing = k.firing > 0 && !k.dead;
    for (const f of this.fires) {
      f.visible = firing;
      if (firing) {
        const sc = 0.85 + Math.random() * 0.35;
        f.scale.set(sc, sc, 0.8 + Math.random() * 0.4);
        f.rotation.z = Math.random() * 6;
      }
    }
    for (const bm of this.beams) {
      bm.visible = firing;
      if (firing) {
        const len = Math.max(1, k.beamLen - 1);
        // 兩道光束收束到命中點
        bm.rotation.y = Math.atan2(-this.m.gunX * bm.userData.side, len);
        const w = 0.8 + Math.random() * 0.5;
        bm.scale.set(w, w, len);
      }
    }

    // 受擊時車身閃紅
    const hit = k.sinceDamage < 0.09 ? 1 : 0;
    this.paint.emissive.setRGB(hit * 0.9, hit * 0.15, hit * 0.05);

    const boosting = k.boostT > 0;
    const mini = k.miniT > 0 || k.padT > 0;
    // 甩尾破風：外側（車尾甩出去的那邊）比較強；電腦沒有真的甩尾，用轉向量代替
    const sliding = k.air <= 0 && k.speed > 16 && (k.drifting ? Math.abs(k.slip) > 0.1 : k.aiAssist && Math.abs(k.steerVis) > 0.75 && k.speed > 20);
    const dir = k.drifting ? k.driftDir : Math.sign(k.steerVis);
    const amt = sliding ? Math.min(1, 0.45 + Math.abs(k.slip) * 1.6 + (k.aiAssist ? 0.2 : 0)) : 0;
    this.sprayT += dt;
    const flip = this.sprayT > 0.05;
    if (flip) this.sprayT = 0;
    for (let i = 0; i < this.sprays.length; i++) {
      const m = this.sprays[i], side = i === 0 ? 1 : -1;
      // 左甩（dir > 0）時車尾往右甩，右側（side = -1）是外側
      const outer = side === -dir;
      const target = amt * (outer ? 1 : 0.45);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity += (target - mat.opacity) * Math.min(1, dt * 12);
      const vis = mat.opacity > 0.02;
      m.parent!.visible = vis;
      if (vis && flip) {
        mat.map = sprayTex[Math.floor(Math.random() * sprayTex.length)];
        const sc = 0.8 + Math.random() * 0.4 + (outer ? 0.25 : 0);
        m.scale.set(sc, 1, 0.85 + Math.random() * 0.35);
      }
    }
    // 螺旋火環：甩尾集氣中或小噴時出現
    const charging = (k.drifting && k.driftTime > 0.35) || k.miniT > 0 || (k.aiAssist && sliding);
    for (const sw of this.swirls) {
      sw.visible = charging && !boosting;
      if (sw.visible) {
        (sw.material as THREE.SpriteMaterial).rotation -= dt * 14;
        sw.scale.setScalar(0.5 + Math.random() * 0.18 + (k.miniT > 0 ? 0.2 : 0));
      }
    }
    // N2O 變形：翼片往外展開、尾翼升起；結束後收回
    this.deploy += ((boosting && !k.dead ? 1 : 0) - this.deploy) * Math.min(1, dt * (boosting ? 9 : 4));
    const d = this.deploy * this.deploy * (3 - 2 * this.deploy);
    const show = d > 0.02;
    for (let i = 0; i < this.wings.length; i++) {
      const w = this.wings[i], side = i === 0 ? 1 : -1;
      w.visible = show;
      w.scale.setScalar(Math.max(0.01, d));
      w.rotation.z = side * (1 - d) * 1.4;
    }
    this.spoiler.visible = show;
    this.spoiler.position.y = this.m.spoilerY + 0.28 * d;
    this.spoiler.scale.set(0.35 + 0.65 * d, Math.max(0.01, d), 1);
    this.shell.visible = show;
    if (show) {
      const m = this.shell.material as THREE.MeshBasicMaterial;
      m.opacity = 0.42 * d * (0.85 + Math.random() * 0.3);
      if (m.map) m.map.offset.y = (this.t * 3.2) % 1;
      this.shell.scale.set(1, 1, 0.9 + Math.random() * 0.15);
    }
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      f.visible = boosting || mini;
      if (f.visible) {
        f.material = boosting ? FLAME : FLAME_MINI;
        const s = (boosting ? 1.15 : 0.65) * (0.8 + Math.random() * 0.5);
        f.scale.set(boosting ? 1.2 : 0.9, boosting ? 1.2 : 0.9, s);
        this.cores[i].scale.z = 0.7 + Math.random() * 0.5;
      }
    }
    for (let i = 0; i < 2; i++) {
      const m = this.muzzles[i];
      this.muzzleT[i] -= dt;
      m.visible = this.muzzleT[i] > 0;
      if (m.visible) {
        m.rotation.z = Math.random() * Math.PI;
        const s = 0.7 + Math.random() * 0.6;
        m.scale.set(s, s, 0.6 + Math.random() * 0.8);
      }
    }

    if (this.hpSprite && this.hpCtx && this.hpTex) {
      const hp = Math.round((k.hp / k.maxHp) * 60);
      if (hp !== this.lastHp) {
        this.lastHp = hp;
        const c = this.hpCtx;
        c.clearRect(0, 0, 64, 8);
        c.fillStyle = 'rgba(0,0,0,0.6)';
        c.fillRect(0, 0, 64, 8);
        c.fillStyle = hp > 36 ? '#5cff6a' : hp > 18 ? '#ffd23f' : '#ff4040';
        c.fillRect(2, 2, hp, 4);
        this.hpTex.needsUpdate = true;
      }
      this.hpSprite.visible = k.invulnT < 10;
    }
  }

  dispose(): void {
    // 只釋放這台車自己建立的幾何與材質；模型的幾何是共用的，不能釋放
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.own !== false && m.geometry instanceof THREE.BufferGeometry && !SHARED_GEOS.has(m.geometry) && (m.geometry as THREE.BufferGeometry).type !== 'BufferGeometry') {
        m.geometry.dispose();
      }
    });
    for (const m of this.ownMats) m.dispose();
    this.hpTex?.dispose();
  }
}
