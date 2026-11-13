import * as THREE from 'three';
import type { Kart } from '../game/kart';
import { clamp } from '../game/util';
import { shieldHalfArc, type PrimaryId, type SecondaryId } from '../game/weapons';
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
const FLAME_CORE = additive(0xffffff, 0.9);
const FLAME_MINI = additive(0xffa033, 0.85);
const MUZZLE = additive(0xffd27a, 0.95);
const FIRE = additive(0xff7a1a, 0.8);
const FIRE_CORE = additive(0xffe08a, 0.85);
const BEAM = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.5, 0.6), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
const BEAM_CORE = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const BEAM_HALO = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.25, 0.35), transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const ORB = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.9, 1), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
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
// 雷射：車頭中央射出的一道粗光束（外層、白色核心、淡淡的光暈），長度 1、沿 +Z，用 scale.z 拉長
const beamGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 16, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const beamCoreGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
const beamHaloGeo = new THREE.CylinderGeometry(0.3, 0.3, 1, 16, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
// 蓄力時兩把雷射槍口的光球
const orbGeo = new THREE.SphereGeometry(0.16, 12, 8);
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
// 後方護盾的六角格紋
const shieldTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 64;
  const c = cv.getContext('2d')!;
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(0, 0, 128, 64);
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.lineWidth = 1.6;
  const r = 9;
  for (let row = -1; row < 6; row++) {
    for (let col = -1; col < 10; col++) {
      const x = col * r * 1.73 + (row % 2 ? r * 0.87 : 0), y = row * r * 1.5;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.closePath();
      c.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1.5);
  return t;
})();
const SHELL = new THREE.MeshBasicMaterial({
  map: shellTex, color: new THREE.Color(0.55, 0.85, 1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const NOZZLE_METAL = new THREE.MeshLambertMaterial({ color: 0x5d636e });
// 噴口外殼（沿 Z 軸、長度 1，用 scale 調大小）、噴口的光環、拉長的尾焰
const nozzleGeo = new THREE.CylinderGeometry(1, 0.78, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);
const ringGeo = new THREE.TorusGeometry(1, 0.07, 6, 22);
const streakGeo = new THREE.CylinderGeometry(0.06, 1, 1, 7, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);

/**
 * N2O 變形：每台車各自一套小配件與噴口（參考卡丁車開氮氣時車尾彈出小尾翼、多個噴口的感覺）。
 * fins = 車尾兩片立起的小尾翼；pods = 兩側滑出的推進器；ducktail = 升起的鴨尾小擾流；
 * split = 兩片斜立的小翼；blower = 引擎蓋升起增壓器、兩側小鰭；basic = 卡丁車用的小尾翼。
 */
type KitStyle = 'fins' | 'pods' | 'ducktail' | 'split' | 'blower' | 'basic';
const KIT_STYLE: Record<string, { style: KitStyle; flame: number }> = {
  'tripo/car1': { style: 'fins', flame: 0x59ccff },
  'tripo/car2': { style: 'pods', flame: 0xff4f7a },
  'tripo/car3': { style: 'ducktail', flame: 0x9fe8ff },
  'tripo/car4': { style: 'split', flame: 0xb07bff },
  'tripo/car5': { style: 'blower', flame: 0xff8a2a },
};

/** 變形配件：base 是展開後的位置；收起時位置加上 slide、旋轉加上 fold，並縮小 */
interface KitPart { o: THREE.Object3D; base: THREE.Vector3; rot: THREE.Euler; slide: THREE.Vector3; fold: THREE.Vector3 }
interface Nozzle { housing: KitPart; r: number; main: boolean; flame: THREE.Mesh; core: THREE.Mesh; ring: THREE.Mesh; streak: THREE.Mesh; mat: THREE.Material }

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

const SHARED_GEOS = new Set<THREE.BufferGeometry>([sprayGeo, shellGeo, wheelGeo, hubGeo, flameGeo, flameCoreGeo, shadowGeo, muzzleGeo, fireGeo, fireCoreGeo, beamGeo, beamCoreGeo, beamHaloGeo, orbGeo]);

/** 模型放大倍率：Kenney 卡丁車原始約 1 m 寬，放大成遊戲中的車體尺寸 */
const MODEL_SCALE = 1.9;
/**
 * Tripo 車體依「體積」統一大小：長寬高的幾何平均縮放到這個值（公尺）。
 * 只對齊車長的話，寬胖的車會比細長的車大一圈。
 */
const CAR_SIZE = 1.97;
const CAR_MAX_LENGTH = 3.4;

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
  /** 副武器等級（護盾 Lv.5 的角度比較大） */
  secondaryLvl?: number;
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
  private orbs: THREE.Object3D[] = [];
  /** N2O 變形：每台車各自的小配件與多個噴口，以及破風氣流 */
  private kit: KitPart[] = [];
  private nozzles: Nozzle[] = [];
  private shell: THREE.Mesh;
  private deploy = 0;
  private shield: THREE.Mesh | null = null;
  private shieldFlash = 0;
  private shieldK = 0;
  /** 甩尾的破風噴花（左右各一）與排氣管的螺旋火環 */
  private sprays: THREE.Mesh[] = [];
  private swirls: THREE.Sprite[] = [];
  private sprayT = 0;
  private paint: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;
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
    if (look.secondary === 'shield') this.addShield(look.secondaryLvl ?? 1);
    this.shell = new THREE.Mesh(shellGeo, SHELL);
    this.addBoostKit(KIT_STYLE[look.model] ?? { style: 'basic', flame: 0x59ccff });
    this.addDriftFx();

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
    const s = Math.min(CAR_SIZE / Math.cbrt(Math.max(size.x * size.y * size.z, 1e-6)), CAR_MAX_LENGTH / Math.max(size.z, 0.001));
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
    this.trim = this.paint as THREE.MeshLambertMaterial;
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
        // 兩把雷射槍口各一顆蓄力光球；光束只有一道，從車頭中央射出（迴圈結束後建立）
        const orb = new THREE.Mesh(orbGeo, ORB);
        orb.position.set(mx, my, mzz);
        orb.visible = false;
        b.add(orb);
        this.orbs.push(orb);
        if (side === -1) {
          const beam = new THREE.Group();
          beam.position.set(0, my, mzz);
          beam.add(new THREE.Mesh(beamHaloGeo, BEAM_HALO), new THREE.Mesh(beamGeo, BEAM), new THREE.Mesh(beamCoreGeo, BEAM_CORE));
          beam.visible = false;
          b.add(beam);
          this.beams.push(beam);
        }
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
    if (secondary === 'mine' || secondary === 'cluster' || secondary === 'shield') sec.position.set(0, this.m.rearY, this.m.rearZ);
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

  /** N2O 變形配件與噴口（平常收起來看不到，噴口的火焰在小噴時也會出現） */
  private addBoostKit(kit: { style: KitStyle; flame: number }): void {
    const b = this.body;
    const m = this.m;
    const trim = this.trim;
    const fc = new THREE.Color(kit.flame);
    const flameMat = additive(kit.flame, 0.85);
    const glow = new THREE.MeshBasicMaterial({ color: fc.clone().multiplyScalar(2.2) });
    this.ownMats.push(flameMat, glow);
    const W = m.halfW, tz = m.tailZ, ey = m.exhaustY;
    const part = (o: THREE.Object3D, slide: [number, number, number] = [0, 0, 0], fold: [number, number, number] = [0, 0, 0]): KitPart => {
      const p: KitPart = { o, base: o.position.clone(), rot: o.rotation.clone(), slide: new THREE.Vector3(...slide), fold: new THREE.Vector3(...fold) };
      o.visible = false;
      b.add(o);
      this.kit.push(p);
      return p;
    };
    // 噴口：外殼是變形配件（往車內縮），火焰、光環、尾焰跟著外殼的位置
    const nozzle = (x: number, y: number, r: number, main: boolean, slide: [number, number, number] = [0, 0, 0.16]) => {
      const g = new THREE.Group();
      g.position.set(x, y, tz + 0.1);
      const h = new THREE.Mesh(nozzleGeo, NOZZLE_METAL);
      h.scale.set(r * 1.25, r * 1.25, 0.24);
      g.add(h);
      const rim = new THREE.Mesh(ringGeo, glow);
      rim.scale.set(r * 1.2, r * 1.2, r * 1.2);
      rim.position.z = -0.24;
      g.add(rim);
      const housing = part(g, slide);
      const flame = new THREE.Mesh(flameGeo, flameMat);
      const core = new THREE.Mesh(flameCoreGeo, FLAME_CORE);
      flame.add(core);
      const ringMat = additive(kit.flame, 0.8);
      const streakMat = additive(kit.flame, 0.2);
      this.ownMats.push(ringMat, streakMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      const streak = new THREE.Mesh(streakGeo, streakMat);
      for (const o of [flame, ring, streak]) { o.visible = false; b.add(o); }
      this.nozzles.push({ housing, r, main, flame, core, ring, streak, mat: flameMat });
      this.flames.push(flame);
      this.cores.push(core);
    };
    const finPair = (x: number, y: number, z: number, h: number, l: number) => {
      for (const side of [1, -1]) {
        const g = new THREE.Group();
        g.position.set(side * x, y, z);
        g.add(box(0.04, h, l, trim, 0, h / 2, 0));
        g.add(box(0.045, 0.03, l * 0.9, glow, 0, h, 0));
        part(g, [0, -0.08, 0], [0, 0, side * 1.45]);
      }
    };
    switch (kit.style) {
      case 'fins': {
        finPair(W - 0.2, m.rearY - 0.04, tz + 0.45, 0.3, 0.38);
        nozzle(-0.2, ey, 0.12, true);
        nozzle(0.2, ey, 0.12, true);
        nozzle(-0.48, ey, 0.085, false);
        nozzle(0.48, ey, 0.085, false);
        break;
      }
      case 'pods': {
        for (const side of [1, -1]) {
          const g = new THREE.Group();
          g.position.set(side * (W + 0.04), ey + 0.12, tz + 0.55);
          g.add(barrel(0.13, 0.72, trim, 0, 0, 0));
          g.add(box(0.03, 0.17, 0.3, trim, 0, 0.16, 0.05));
          g.add(box(0.035, 0.03, 0.26, glow, 0, 0.25, 0.05));
          part(g, [-side * 0.32, 0, 0.15]);
          nozzle(side * (W + 0.04), ey + 0.12, 0.12, true, [-side * 0.32, 0, 0.3]);
        }
        nozzle(0, ey, 0.1, false);
        break;
      }
      case 'ducktail': {
        const g = new THREE.Group();
        g.position.set(0, m.spoilerY, m.spoilerZ);
        for (const x of [-0.3, 0.3]) g.add(box(0.05, 0.18, 0.07, GUN, x, 0.09, 0));
        g.add(box(1.0, 0.045, 0.26, trim, 0, 0.19, -0.02));
        g.add(box(1.0, 0.025, 0.04, glow, 0, 0.2, -0.15));
        part(g, [0, -0.2, 0]);
        nozzle(0, ey + 0.13, 0.1, true);
        nozzle(-0.15, ey - 0.03, 0.1, true);
        nozzle(0.15, ey - 0.03, 0.1, true);
        nozzle(-(W - 0.24), ey, 0.07, false);
        nozzle(W - 0.24, ey, 0.07, false);
        break;
      }
      case 'split': {
        for (const side of [1, -1]) {
          const g = new THREE.Group();
          g.position.set(side * 0.34, m.rearY - 0.02, tz + 0.42);
          g.add(box(0.04, 0.16, 0.06, GUN, 0, 0.08, 0));
          const blade = box(0.5, 0.035, 0.22, trim, side * 0.2, 0.17, 0);
          blade.rotation.z = side * 0.38;
          g.add(blade);
          const strip = box(0.5, 0.02, 0.035, glow, side * 0.2, 0.19, -0.1);
          strip.rotation.z = side * 0.38;
          g.add(strip);
          part(g, [0, -0.16, 0], [0.7, 0, 0]);
        }
        nozzle(-0.25, ey - 0.1, 0.095, true);
        nozzle(0.25, ey - 0.1, 0.095, true);
        nozzle(-0.25, ey + 0.1, 0.095, false);
        nozzle(0.25, ey + 0.1, 0.095, false);
        break;
      }
      case 'blower': {
        const g = new THREE.Group();
        g.position.set(0, m.hoodY - 0.04, m.hoodZ - 0.15);
        g.add(box(0.42, 0.14, 0.5, GUN_LIGHT, 0, 0.07, 0));
        for (const x of [-0.12, 0.12]) {
          const st = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.24, 8), NOZZLE_METAL);
          st.position.set(x, 0.24, 0.06);
          g.add(st);
          const top = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.03, 8), glow);
          top.position.set(x, 0.37, 0.06);
          g.add(top);
        }
        part(g, [0, -0.22, 0]);
        for (const side of [1, -1]) {
          const fin = new THREE.Group();
          fin.position.set(side * (W - 0.04), ey + 0.22, tz + 0.42);
          fin.add(box(0.03, 0.17, 0.32, trim, 0, 0, -0.16));
          fin.add(box(0.035, 0.025, 0.3, glow, 0, 0.09, -0.16));
          part(fin, [0, 0, 0], [0, side * 1.3, 0]);
        }
        nozzle(-0.38, ey, 0.15, true);
        nozzle(0.38, ey, 0.15, true);
        nozzle(-0.64, ey + 0.04, 0.08, false);
        nozzle(0.64, ey + 0.04, 0.08, false);
        break;
      }
      default: {
        finPair(0.42, m.rearY, m.rearZ, 0.24, 0.3);
        nozzle(-0.3, ey, 0.11, true);
        nozzle(0.3, ey, 0.11, true);
      }
    }
    // 氣流殼要比照獨立的材質透明度：每台車各自一份
    const mat = SHELL.clone();
    this.ownMats.push(mat);
    this.shell.material = mat;
    this.shell.position.set(0, this.m.shellY, this.m.shellZ);
    this.shell.visible = false;
    this.shell.renderOrder = 5;
    b.add(this.shell);
  }

  /** 後方護盾：車尾一段弧形的能量牆（六角格紋），被打中時閃一下 */
  private addShield(lvl: number): void {
    const half = shieldHalfArc(lvl);
    const geo = new THREE.CylinderGeometry(2.15, 2.0, 1.9, 30, 1, true, Math.PI - half, half * 2);
    const mat = new THREE.MeshBasicMaterial({ map: shieldTex, color: new THREE.Color(0.45, 1.3, 2.2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.ownMats.push(mat);
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.95;
    m.visible = false;
    m.renderOrder = 6;
    this.body.add(m);
    this.shield = m;
  }

  /** 護盾擋下攻擊：閃一下 */
  shieldHit(): void {
    this.shieldFlash = 1;
  }

  /** 護盾碎掉：立刻消失（碎片由畫面的碎片特效負責） */
  shieldBreak(): void {
    this.shieldK = 0;
    this.shieldFlash = 0;
    if (this.shield) this.shield.visible = false;
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
    for (const o of this.orbs) o.visible = false;
    for (const p of this.kit) p.o.visible = false;
    for (const n of this.nozzles) n.ring.visible = n.streak.visible = false;
    for (const m of this.sprays) m.parent!.visible = false;
    for (const sw of this.swirls) sw.visible = false;
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
    // 車身側傾：跟著實際的轉向角速度慢慢傾斜，看起來是貼著地面滑過彎
    const lean = -(k.slip * 0.24 + k.yawRate * 0.045 * Math.min(1, k.speed / 20));
    this.body.rotation.z += (lean - this.body.rotation.z) * Math.min(1, dt * 5);
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
    const laserCharging = k.charge > 0 && !k.dead;
    for (const bm of this.beams) {
      const on = firing || laserCharging;
      bm.visible = on;
      if (on) {
        const len = Math.max(1, k.beamLen - 1);
        // 蓄力：一條細細閃爍的瞄準線；射出：一道很粗的光束，0.25 秒內變細消失
        const w = firing
          ? (1.2 + 3.6 * Math.min(1, k.firing / 0.25)) * (0.92 + Math.random() * 0.16)
          : (0.25 + 0.35 * Math.min(1, k.charge / 0.3)) * (0.6 + Math.random() * 0.6);
        bm.scale.set(w, w, len);
      }
    }
    for (const o of this.orbs) {
      // 槍口光球：蓄力時越來越大，射出瞬間最亮
      const c = laserCharging ? Math.min(1, k.charge / 0.3) : firing ? Math.min(1, k.firing / 0.25) : 0;
      o.visible = c > 0.02;
      if (o.visible) o.scale.setScalar((0.4 + 1.1 * c) * (0.85 + Math.random() * 0.3));
    }

    // 後方護盾：展開時從透明淡入，被打中時亮一下
    if (this.shield) {
      this.shieldK += ((k.shieldT > 0 && !k.dead ? 1 : 0) - this.shieldK) * Math.min(1, dt * 10);
      this.shieldFlash = Math.max(0, this.shieldFlash - dt * 4);
      const vis = this.shieldK > 0.02;
      this.shield.visible = vis;
      if (vis) {
        const mat = this.shield.material as THREE.MeshBasicMaterial;
        // 耐久（只有自己控制的車知道）：越低越偏橘、越透明；快結束或快碎時閃爍提醒
        const hp = k.remote ? 1 : clamp(k.shieldHp / Math.max(1, k.shieldMax), 0, 1);
        mat.color.setRGB(0.45 + (1 - hp) * 1.9, 1.3 - (1 - hp) * 0.5, 2.2 - (1 - hp) * 1.9);
        const ending = (k.shieldT < 0.8 || hp < 0.3) && Math.floor(this.t * 12) % 2 === 0 ? 0.35 : 1;
        mat.opacity = (0.22 + 0.12 * hp + 0.06 * Math.sin(this.t * 9) + this.shieldFlash * 0.6) * this.shieldK * ending;
        if (mat.map) mat.map.offset.x = (this.t * 0.15) % 1;
        const s = 0.9 + 0.1 * this.shieldK + this.shieldFlash * 0.05;
        this.shield.scale.set(s, 1, s);
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
    // N2O 變形：小配件彈出／滑出、噴口伸出；結束後收回
    this.deploy += ((boosting && !k.dead ? 1 : 0) - this.deploy) * Math.min(1, dt * (boosting ? 10 : 4));
    const d = this.deploy * this.deploy * (3 - 2 * this.deploy);
    const show = d > 0.02;
    const u = 1 - d;
    for (const p of this.kit) {
      p.o.position.copy(p.base).addScaledVector(p.slide, u);
      p.o.visible = show;
      if (!show) continue;
      p.o.rotation.set(p.rot.x + p.fold.x * u, p.rot.y + p.fold.y * u, p.rot.z + p.fold.z * u);
      p.o.scale.setScalar(0.2 + 0.8 * d);
    }
    this.shell.visible = show;
    if (show) {
      const m = this.shell.material as THREE.MeshBasicMaterial;
      m.opacity = 0.2 * d * (0.85 + Math.random() * 0.3);
      if (m.map) m.map.offset.y = (this.t * 3.2) % 1;
      this.shell.scale.set(1, 1, 0.9 + Math.random() * 0.15);
    }
    // 噴口火焰：N2O 時全部噴口一起噴（加上光環與拉長的尾焰），小噴只有主噴口
    for (let i = 0; i < this.nozzles.length; i++) {
      const n = this.nozzles[i];
      const hp = n.housing.o.position;
      const tipZ = hp.z - 0.24 * (n.housing.o.visible ? n.housing.o.scale.z : 0.2);
      const on = boosting || (mini && n.main);
      n.flame.visible = on;
      if (on) {
        n.flame.material = boosting ? n.mat : FLAME_MINI;
        const rs = (n.r / 0.24) * (boosting ? 1.25 : 0.95);
        n.flame.position.set(hp.x, hp.y, tipZ);
        n.flame.scale.set(rs, rs, (boosting ? 1.1 : 0.6) * (0.8 + Math.random() * 0.5) * (n.main ? 1 : 0.75));
        n.core.scale.z = 0.7 + Math.random() * 0.5;
      }
      n.ring.visible = boosting && d > 0.5;
      n.streak.visible = boosting && d > 0.3;
      if (n.ring.visible) {
        const ph = (this.t * 3.2 + i * 0.17) % 1;
        const rs = n.r * (1.3 + ph * 2.4);
        n.ring.position.set(hp.x, hp.y, tipZ - 0.1 - ph * 0.6);
        n.ring.scale.set(rs, rs, rs);
        (n.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - ph);
      }
      if (n.streak.visible) {
        n.streak.position.set(hp.x, hp.y, tipZ - 0.2);
        n.streak.scale.set(n.r * 0.42, n.r * 0.42, (n.main ? 3.4 : 2.4) * (0.85 + Math.random() * 0.3) * d);
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
