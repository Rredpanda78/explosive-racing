import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { PrimaryId, SecondaryId } from '../game/weapons';
import { cloneModel } from './assets';

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
const SHADOW = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.36, 14).rotateZ(Math.PI / 2);
const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.38, 8).rotateZ(Math.PI / 2);
const flameGeo = new THREE.ConeGeometry(0.24, 1.8, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.9);
const flameCoreGeo = new THREE.ConeGeometry(0.11, 1.1, 6).rotateX(-Math.PI / 2).translate(0, 0, -0.55);
const shadowGeo = new THREE.CircleGeometry(1.75, 18).rotateX(-Math.PI / 2);
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
const SHARED_GEOS = new Set<THREE.BufferGeometry>([wheelGeo, hubGeo, flameGeo, flameCoreGeo, shadowGeo, muzzleGeo]);

/** 模型放大倍率：Kenney 卡丁車原始約 1 m 寬，放大成遊戲中的車體尺寸 */
const MODEL_SCALE = 1.9;
/** 武器掛點（放大後的車體座標） */
const GUN_X = 0.7, GUN_Y = 0.95, GUN_Z = 0.2;
const HOOD_Y = 0.66, HOOD_Z = 1.12;

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
  /** Kenney 卡丁車模型名稱；載入失敗時自動改用內建幾何車 */
  model: string;
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
  private paint: THREE.MeshLambertMaterial;
  private ownMats: THREE.Material[] = [];
  private hpTex?: THREE.CanvasTexture;
  private hpCtx?: CanvasRenderingContext2D;
  private hpSprite?: THREE.Sprite;
  private lastHp = -1;
  private fakeYaw = 0;
  private t = Math.random() * 10;

  constructor(look: KartLook, shadows: boolean) {
    const g = this.group;
    const b = this.body;
    g.rotation.order = 'YXZ';
    g.add(b);
    this.paint = new THREE.MeshLambertMaterial({ color: look.color });
    this.ownMats.push(this.paint);

    const model = cloneModel(look.model);
    if (model) this.buildFromModel(model, look);
    else this.buildProcedural(look);
    this.addWeapons(look.primary, look.secondary);

    // 噴射火焰
    for (const x of [-0.3, 0.3]) {
      const f = new THREE.Mesh(flameGeo, FLAME);
      f.position.set(x, 0.58, model ? -1.15 : -1.5);
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
      this.hpSprite.position.y = model ? 3.1 : 2.6;
      this.hpSprite.renderOrder = 20;
      g.add(this.hpSprite);
    }
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
    // 主武器：車身兩側
    for (const side of [1, -1]) {
      const x = GUN_X * side;
      b.add(box(0.16, 0.34, 0.5, GUN_LIGHT, x * 0.86, GUN_Y - 0.2, GUN_Z - 0.3));
      if (primary === 'vulcan') {
        const grp = new THREE.Group();
        grp.position.set(x, GUN_Y, GUN_Z + 0.25);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          grp.add(barrel(0.04, 1.25, GUN, Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0));
        }
        grp.add(barrel(0.13, 0.12, GUN_LIGHT, 0, 0, 0.5));
        b.add(grp);
        b.add(barrel(0.17, 0.5, GUN_LIGHT, x, GUN_Y, GUN_Z - 0.35));
        this.vulcanBarrels.push(grp);
      } else {
        b.add(barrel(0.065, 1.35, GUN, x, GUN_Y, GUN_Z + 0.3));
        b.add(barrel(0.1, 0.22, GUN_LIGHT, x, GUN_Y, GUN_Z + 0.92));
        b.add(box(0.24, 0.26, 0.62, GUN, x, GUN_Y - 0.02, GUN_Z - 0.3));
        b.add(box(0.2, 0.3, 0.26, GUN_LIGHT, x + 0.2 * side, GUN_Y - 0.08, GUN_Z - 0.28));
      }
      const mz = new THREE.Mesh(muzzleGeo, MUZZLE);
      mz.position.set(x, GUN_Y, GUN_Z + 1.0);
      mz.visible = false;
      b.add(mz);
      this.muzzles.push(mz);
    }
    // 副武器：引擎蓋上
    if (secondary === 'rocket') {
      b.add(box(0.74, 0.3, 0.62, GUN, 0, HOOD_Y + 0.1, HOOD_Z));
      b.add(box(0.5, 0.12, 0.3, GUN_LIGHT, 0, HOOD_Y - 0.1, HOOD_Z - 0.1));
      for (const x of [-0.19, 0.19]) {
        b.add(barrel(0.11, 0.66, GUN_LIGHT, x, HOOD_Y + 0.12, HOOD_Z + 0.02));
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 8).rotateX(Math.PI / 2), WARHEAD);
        tip.position.set(x, HOOD_Y + 0.12, HOOD_Z + 0.42);
        b.add(tip);
      }
    } else {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.15, 10).rotateX(Math.PI / 2 - 0.42), GUN);
      tube.position.set(0, HOOD_Y + 0.34, HOOD_Z + 0.12);
      b.add(tube);
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.14, 10).rotateX(Math.PI / 2 - 0.42), GUN_LIGHT);
      ring.position.set(0, HOOD_Y + 0.56, HOOD_Z + 0.6);
      b.add(ring);
      b.add(box(0.56, 0.26, 0.5, GUN_LIGHT, 0, HOOD_Y + 0.04, HOOD_Z - 0.1));
    }
  }

  /** 開火時讓對應那一側的槍口閃一下 */
  muzzleFlash(side: number): void {
    this.muzzleT[side > 0 ? 0 : 1] = 0.05;
  }

  update(k: Kart, dt: number): void {
    this.t += dt;
    const g = this.group;
    g.visible = !k.dead && !(k.invulnT > 0 && k.invulnT < 10 && Math.floor(this.t * 12) % 2 === 0);
    g.position.set(k.x, k.y, k.z);
    g.rotation.y = k.heading;
    g.rotation.x = -k.pitch;

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

    // 受擊時車身閃紅
    const hit = k.sinceDamage < 0.09 ? 1 : 0;
    this.paint.emissive.setRGB(hit * 0.9, hit * 0.15, hit * 0.05);

    const boosting = k.boostT > 0;
    const mini = k.miniT > 0 || k.padT > 0;
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
