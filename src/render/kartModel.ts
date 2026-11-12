import * as THREE from 'three';
import type { Kart } from '../game/kart';
import type { PrimaryId, SecondaryId } from '../game/weapons';

const DARK = new THREE.MeshLambertMaterial({ color: 0x23262d });
const METAL = new THREE.MeshLambertMaterial({ color: 0x8c93a0 });
const GUN = new THREE.MeshLambertMaterial({ color: 0x4a4f59 });
const TIRE = new THREE.MeshLambertMaterial({ color: 0x17181c });
const HUB = new THREE.MeshLambertMaterial({ color: 0xd9dde5 });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
const SKIN = new THREE.MeshLambertMaterial({ color: 0x2b3440 });
const FLAME = new THREE.MeshBasicMaterial({ color: 0x66d9ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
const FLAME_MINI = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
const SHADOW = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });

const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.36, 14).rotateZ(Math.PI / 2);
const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.38, 8).rotateZ(Math.PI / 2);
const flameGeo = new THREE.ConeGeometry(0.24, 1.8, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.9);
const shadowGeo = new THREE.CircleGeometry(1.75, 18).rotateX(-Math.PI / 2);

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

/** 程式生成的低多邊形卡丁車。車頭朝 +Z。 */
export class KartView {
  group = new THREE.Group();
  body = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private frontPivots: THREE.Group[] = [];
  private flames: THREE.Mesh[] = [];
  private vulcanBarrels: THREE.Object3D[] = [];
  private hpTex?: THREE.CanvasTexture;
  private hpCtx?: CanvasRenderingContext2D;
  private hpSprite?: THREE.Sprite;
  private lastHp = -1;
  private fakeYaw = 0;
  private t = Math.random() * 10;

  constructor(color: number, primary: PrimaryId, secondary: SecondaryId, isPlayer: boolean) {
    const g = this.group;
    const b = this.body;
    g.add(b);
    const paint = new THREE.MeshLambertMaterial({ color });

    // 車體
    b.add(box(1.5, 0.3, 2.7, paint, 0, 0.45, 0));
    b.add(box(1.0, 0.26, 0.9, paint, 0, 0.52, 1.5));
    b.add(box(1.95, 0.1, 0.36, DARK, 0, 0.32, 1.98));
    b.add(box(0.36, 0.36, 1.3, paint, 0.9, 0.5, -0.1));
    b.add(box(0.36, 0.36, 1.3, paint, -0.9, 0.5, -0.1));
    b.add(box(0.9, 0.62, 0.3, DARK, 0, 0.9, -0.72));
    b.add(box(1.0, 0.46, 0.62, METAL, 0, 0.72, -1.2));
    b.add(box(0.1, 0.5, 0.1, DARK, 0.6, 1.0, -1.42));
    b.add(box(0.1, 0.5, 0.1, DARK, -0.6, 1.0, -1.42));
    b.add(box(1.75, 0.08, 0.42, paint, 0, 1.28, -1.45));
    b.add(box(1.6, 0.1, 0.12, WHITE, 0, 0.62, 1.05));

    // 車手
    b.add(box(0.56, 0.5, 0.4, SKIN, 0, 0.95, -0.38));
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), isPlayer ? WHITE : paint);
    helmet.position.set(0, 1.42, -0.36);
    b.add(helmet);
    b.add(box(0.5, 0.16, 0.2, DARK, 0, 1.44, -0.1));
    b.add(box(0.5, 0.06, 0.06, DARK, 0, 1.02, 0.25));

    // 輪子
    const wp: [number, number, boolean][] = [[0.98, 1.05, true], [-0.98, 1.05, true], [1.02, -1.05, false], [-1.02, -1.05, false]];
    for (const [x, z, front] of wp) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.4, z);
      const w = new THREE.Mesh(wheelGeo, TIRE);
      w.add(new THREE.Mesh(hubGeo, HUB));
      pivot.add(w);
      b.add(pivot);
      this.wheels.push(w);
      if (front) this.frontPivots.push(pivot);
    }

    // 主武器：車身兩側
    for (const side of [1, -1]) {
      if (primary === 'vulcan') {
        const grp = new THREE.Group();
        grp.position.set(0.92 * side, 0.82, 0.55);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          grp.add(barrel(0.045, 1.3, GUN, Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0));
        }
        grp.add(barrel(0.15, 0.4, GUN, 0, 0, -0.5));
        b.add(grp);
        this.vulcanBarrels.push(grp);
      } else {
        b.add(barrel(0.07, 1.4, GUN, 0.92 * side, 0.82, 0.6));
        b.add(box(0.22, 0.22, 0.6, GUN, 0.92 * side, 0.8, 0.05));
      }
    }

    // 副武器：引擎蓋上
    if (secondary === 'missile') {
      b.add(box(0.7, 0.26, 0.7, GUN, 0, 0.8, 1.2));
      for (const x of [-0.2, 0.2]) b.add(barrel(0.09, 0.2, new THREE.MeshLambertMaterial({ color: 0xff5533 }), x, 0.8, 1.6));
    } else {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 1.2, 10).rotateX(Math.PI / 2 - 0.42), GUN);
      tube.position.set(0, 0.98, 1.25);
      b.add(tube);
      b.add(box(0.5, 0.25, 0.5, GUN, 0, 0.75, 1.0));
    }

    // 噴射火焰
    for (const x of [-0.3, 0.3]) {
      const f = new THREE.Mesh(flameGeo, FLAME);
      f.position.set(x, 0.62, -1.5);
      f.visible = false;
      b.add(f);
      this.flames.push(f);
    }

    const sh = new THREE.Mesh(shadowGeo, SHADOW);
    sh.position.y = 0.045;
    sh.renderOrder = 1;
    g.add(sh);

    // 敵車血條
    if (!isPlayer) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 8;
      this.hpCtx = c.getContext('2d')!;
      this.hpTex = new THREE.CanvasTexture(c);
      this.hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.hpTex, depthTest: false, transparent: true }));
      this.hpSprite.scale.set(2.6, 0.32, 1);
      this.hpSprite.position.y = 2.6;
      this.hpSprite.renderOrder = 20;
      g.add(this.hpSprite);
    }
  }

  update(k: Kart, dt: number): void {
    this.t += dt;
    const g = this.group;
    g.visible = !k.dead && !(k.invulnT > 0 && k.invulnT < 10 && Math.floor(this.t * 12) % 2 === 0);
    g.position.set(k.x, 0, k.z);
    g.rotation.y = k.heading;

    // AI 沒有真的甩尾，用假的車身偏擺讓過彎看起來有滑動感
    const fakeTarget = k.aiAssist && k.speed > 18 ? k.steerVis * 0.38 : 0;
    this.fakeYaw += (fakeTarget - this.fakeYaw) * Math.min(1, dt * 6);
    this.body.rotation.y = this.fakeYaw;
    const lean = -(k.slip * 0.22 + k.steerVis * 0.05 * Math.min(1, k.speed / 20));
    this.body.rotation.z += (lean - this.body.rotation.z) * Math.min(1, dt * 8);
    const pitch = k.boostT > 0 ? -0.06 : 0;
    this.body.rotation.x += (pitch - this.body.rotation.x) * Math.min(1, dt * 6);
    this.body.position.y = Math.sin(this.t * 30) * 0.008 * Math.min(1, Math.abs(k.speed) / 10);

    const spin = (k.speed / 0.4) * dt;
    for (const w of this.wheels) w.rotation.x += spin;
    const st = k.steerVis * 0.45 - (k.drifting ? k.slip * 0.6 : 0);
    for (const p of this.frontPivots) p.rotation.y = st;
    for (const v of this.vulcanBarrels) v.rotation.z += k.spin * 40 * dt;

    const boosting = k.boostT > 0;
    const mini = k.miniT > 0;
    for (const f of this.flames) {
      f.visible = boosting || mini;
      if (f.visible) {
        f.material = boosting ? FLAME : FLAME_MINI;
        const s = (boosting ? 1 : 0.6) * (0.8 + Math.random() * 0.5);
        f.scale.set(1, 1, s);
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
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry !== wheelGeo && m.geometry !== hubGeo && m.geometry !== flameGeo && m.geometry !== shadowGeo) m.geometry.dispose();
    });
    this.hpTex?.dispose();
  }
}
