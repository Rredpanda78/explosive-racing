import * as THREE from 'three';
import { BOULDER, HAMMER, TRAM, type Race } from '../game/race';
import type { Track } from '../game/track';
import { StreetHazardView } from './streetHazards';
import type { Theme } from './themes';
import { t } from '../i18n';
import { fitFont, liveSign } from './signText';

const glow = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

function stripeTex(a: string, b: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const c = cv.getContext('2d')!;
  c.fillStyle = a;
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = b;
  for (let x = -64; x < 128; x += 32) {
    c.beginPath();
    c.moveTo(x, 64); c.lineTo(x + 16, 64); c.lineTo(x + 80, 0); c.lineTo(x + 64, 0);
    c.closePath();
    c.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadows: boolean): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadows;
  m.receiveShadow = shadows;
  return m;
}

interface HammerParts { pivot: THREE.Group }
interface TramParts { tram: THREE.Group; lamps: THREE.Mesh[] }

/**
 * 機關的畫面：鐵鎚門架、電車平交道、落石。
 * 每個機關的群組以機關位置為原點：+X = 賽道左側法線，+Z = 前進方向，Y = 路面高度。
 */
export class HazardView {
  group = new THREE.Group();
  private hammers = new Map<number, HammerParts>();
  private trams = new Map<number, TramParts>();
  private rocks: THREE.Mesh[] = [];
  /** 廟口夜市的街頭機關（機車、鞭炮、平交道的火車、強風） */
  private street: StreetHazardView | null = null;
  private lampOn: THREE.Material;
  private lampOff: THREE.Material;
  private disposables: { dispose(): void }[] = [];
  private q = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  constructor(race: Race, track: Track, theme: Theme, shadows: boolean) {
    const hw = track.halfWidth;
    const night = theme.night;
    const yb = stripeTex('#ffc93c', '#1b1c20');
    const ybMat = new THREE.MeshLambertMaterial({ map: yb });
    const steel = new THREE.MeshLambertMaterial({ color: 0x4a505c });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    const red = new THREE.MeshLambertMaterial({ color: 0xe23b3b });
    this.lampOn = new THREE.MeshBasicMaterial({ color: glow(0xff3020, 3.2) });
    this.lampOff = new THREE.MeshLambertMaterial({ color: 0x5a1512 });
    this.disposables.push(yb, ybMat, steel, dark, red, this.lampOn, this.lampOff);

    race.hazards.forEach((h, i) => {
      // 街頭機關與平交道的火車由 StreetHazardView 畫
      if (h.def.kind === 'scooter' || h.def.kind === 'firecracker' || h.def.kind === 'gust' || (h.def.kind === 'tram' && h.def.train)) return;
      const g = new THREE.Group();
      g.position.set(h.x, h.y, h.z);
      g.rotation.y = Math.atan2(h.tx, h.tz);
      this.group.add(g);
      if (h.def.kind === 'hammer') {
        // 門架：兩根柱子加橫樑，鎚子吊在中間
        const top = HAMMER.pivot + 1.2;
        for (const sg of [1, -1]) {
          const post = mesh(new THREE.BoxGeometry(1.2, top + 0.8, 1.2), ybMat, sg * (hw + 2), (top + 0.8) / 2 - 0.4, 0, shadows);
          g.add(post);
        }
        g.add(mesh(new THREE.BoxGeometry((hw + 2) * 2 + 1.2, 1.4, 1.6), ybMat, 0, top, 0, shadows));
        g.add(mesh(new THREE.BoxGeometry(1.6, 1.6, 2.2), steel, 0, HAMMER.pivot + 0.2, 0, shadows));
        const pivot = new THREE.Group();
        pivot.position.y = HAMMER.pivot;
        // 鎚柄與鎚頭（鎚頭的軸沿左右方向，正面撞向擺動的方向）
        pivot.add(mesh(new THREE.BoxGeometry(0.45, HAMMER.arm, 0.45), steel, 0, -HAMMER.arm / 2, 0, shadows));
        const head = mesh(new THREE.CylinderGeometry(HAMMER.headR, HAMMER.headR, HAMMER.headHalf * 2, 14).rotateZ(Math.PI / 2), dark, 0, -HAMMER.arm, 0, shadows);
        pivot.add(head);
        for (const sg of [1, -1]) {
          pivot.add(mesh(new THREE.CylinderGeometry(HAMMER.headR + 0.08, HAMMER.headR + 0.08, 0.35, 14).rotateZ(Math.PI / 2), red, sg * (HAMMER.headHalf - 0.15), -HAMMER.arm, 0, shadows));
        }
        g.add(pivot);
        this.hammers.set(i, { pivot });
      } else if (h.def.kind === 'tram') {
        const reach = TRAM.reach + TRAM.half;
        // 鐵軌橫越路面
        const railMat = new THREE.MeshLambertMaterial({ color: 0x9aa3b0 });
        const bedMat = new THREE.MeshLambertMaterial({ color: 0x24262c, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        this.disposables.push(railMat, bedMat);
        g.add(mesh(new THREE.BoxGeometry(reach * 2, 0.04, TRAM.width * 2 + 1.2), bedMat, 0, 0.04, 0, false));
        for (const z of [-0.75, 0.75]) g.add(mesh(new THREE.BoxGeometry(reach * 2, 0.12, 0.16), railMat, 0, 0.1, z, false));
        // 停車警示線
        for (const z of [-(TRAM.width + 3), TRAM.width + 3]) g.add(mesh(new THREE.BoxGeometry(hw * 2, 0.03, 0.9), ybMat, 0, 0.05, z, false));
        // 兩側的車庫（電車平常停在裡面），面向賽道的一面是開口
        const wallMat = new THREE.MeshLambertMaterial({ color: night ? 0x3a4052 : 0x8c8f99 });
        const inMat = new THREE.MeshBasicMaterial({ color: 0x0b0c10 });
        this.disposables.push(wallMat, inMat);
        const lamps: THREE.Mesh[] = [];
        const len = 31, H = 5.2, W = TRAM.width * 2 + 2;
        for (const sg of [1, -1]) {
          const x0 = sg * (hw + 1.2), xc = x0 + (sg * len) / 2;
          g.add(mesh(new THREE.BoxGeometry(len, 0.5, W + 0.6), wallMat, xc, H, 0, shadows));
          for (const z of [-(W / 2), W / 2]) g.add(mesh(new THREE.BoxGeometry(len, H, 0.4), wallMat, xc, H / 2, z, shadows));
          g.add(mesh(new THREE.BoxGeometry(0.4, H, W), inMat, x0 + sg * len, H / 2, 0, false));
          g.add(mesh(new THREE.BoxGeometry(len - 1, 0.1, W - 0.4), inMat, xc, H - 0.3, 0, false));
          // 入口上方的警示燈與黃黑門框
          g.add(mesh(new THREE.BoxGeometry(0.7, 1, W + 1.2), ybMat, x0, H + 0.6, 0, shadows));
          for (const z of [-(W / 2 + 0.3), W / 2 + 0.3]) {
            const lamp = mesh(new THREE.SphereGeometry(0.42, 10, 8), this.lampOff, x0, H + 1.5, z, false);
            g.add(lamp);
            lamps.push(lamp);
          }
        }
        // 電車：兩節車廂
        const tram = new THREE.Group();
        const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2e9cf0 });
        const winMat = new THREE.MeshBasicMaterial({ color: night ? glow(0xffe0a0, 1.6) : new THREE.Color(0x203040) });
        const capMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
        const headMat = new THREE.MeshBasicMaterial({ color: glow(0xfff2c0, 3) });
        this.disposables.push(bodyMat, winMat, capMat, headMat);
        for (const cx of [-TRAM.half / 2, TRAM.half / 2]) {
          tram.add(mesh(new THREE.BoxGeometry(TRAM.half - 0.4, 2.6, TRAM.width * 2), bodyMat, cx, 1.75, 0, shadows));
          tram.add(mesh(new THREE.BoxGeometry(TRAM.half - 1.2, 0.9, TRAM.width * 2 + 0.05), winMat, cx, 2.3, 0, false));
          tram.add(mesh(new THREE.BoxGeometry(TRAM.half - 0.4, 0.35, TRAM.width * 2 + 0.1), capMat, cx, 3.2, 0, shadows));
          tram.add(mesh(new THREE.BoxGeometry(TRAM.half - 0.6, 0.45, TRAM.width * 2 - 0.4), dark, cx, 0.35, 0, false));
        }
        for (const sx of [-TRAM.half, TRAM.half]) for (const z of [-0.9, 0.9]) tram.add(mesh(new THREE.SphereGeometry(0.22, 8, 6), headMat, sx, 1.2, z, false));
        tram.add(mesh(new THREE.BoxGeometry(0.15, 1.2, 0.15), steel, 0, 3.9, 0, false));
        tram.visible = false;
        g.add(tram);
        this.trams.set(i, { tram, lamps });
      } else {
        // 落石區：路邊堆著石頭，前方立警告牌
        const rockMat = new THREE.MeshLambertMaterial({ color: theme.mountain, flatShading: true });
        this.disposables.push(rockMat);
        for (const sg of [1, -1]) for (let k = 0; k < 5; k++) {
          const r = 1.6 + Math.random() * 1.8;
          const m = mesh(new THREE.DodecahedronGeometry(r, 0), rockMat, sg * (hw + 5 + Math.random() * 6), r * 0.4 - 1.5, k * 6 + Math.random() * 3, shadows);
          m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
          g.add(m);
        }
        const cv = document.createElement('canvas');
        cv.width = 128;
        cv.height = 128;
        // 警告牌的字跟著介面語言（換語言時重畫）
        const drawSign = (c: CanvasRenderingContext2D) => {
          c.fillStyle = '#ffc93c';
          c.beginPath();
          c.moveTo(64, 6); c.lineTo(122, 116); c.lineTo(6, 116);
          c.closePath();
          c.fill();
          c.strokeStyle = '#1b1c20';
          c.lineWidth = 8;
          c.stroke();
          c.fillStyle = '#1b1c20';
          c.textAlign = 'center';
          fitFont(c, t.signRocks, 30, 74, '"Segoe UI", Arial, sans-serif', 14);
          c.fillText(t.signRocks, 64, 96);
          c.beginPath();
          c.arc(64, 54, 14, 0, Math.PI * 2);
          c.fill();
        };
        drawSign(cv.getContext('2d')!);
        const tex = liveSign(new THREE.CanvasTexture(cv), drawSign);
        tex.colorSpace = THREE.SRGBColorSpace;
        const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
        this.disposables.push(tex, signMat);
        for (const sg of [1, -1]) {
          const sign = mesh(new THREE.PlaneGeometry(3, 3), signMat, sg * (hw + 2.2), 3.4, -40, false);
          sign.rotation.y = Math.PI;
          g.add(sign);
          g.add(mesh(new THREE.BoxGeometry(0.2, 2.2, 0.2), steel, sg * (hw + 2.2), 1.1, -40, false));
        }
      }
    });

    if (StreetHazardView.wants(race)) {
      this.street = new StreetHazardView(race, track, theme, shadows, !shadows);
      this.group.add(this.street.group);
    }

    // 滾石的物件池
    if (race.hazards.some((h) => h.def.kind === 'boulder')) {
      const geo = new THREE.DodecahedronGeometry(BOULDER.r, 1);
      const pos = geo.attributes.position;
      // 讓石頭表面凹凸不平
      for (let i = 0; i < pos.count; i++) {
        const k = 0.85 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.25;
        pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
      }
      geo.computeVertexNormals();
      // 比周圍岩壁深一點，滾下來時才看得清楚
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(theme.mountain).multiplyScalar(0.7), flatShading: true });
      this.disposables.push(geo, mat);
      for (let i = 0; i < 14; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = shadows;
        m.visible = false;
        this.group.add(m);
        this.rocks.push(m);
      }
    }
  }

  update(race: Race, time: number): void {
    this.street?.update(race, time);
    race.hazards.forEach((h, i) => {
      const hm = this.hammers.get(i);
      if (hm) hm.pivot.rotation.z = h.theta;
      const tr = this.trams.get(i);
      if (tr) {
        tr.tram.visible = Math.abs(h.c) < TRAM.reach - 0.5;
        tr.tram.position.x = h.c;
        const on = h.warn && Math.floor(time * 3) % 2 === 0;
        tr.lamps.forEach((l, k) => { l.material = on === (k % 2 === 0) && h.warn ? this.lampOn : this.lampOff; });
      }
    });
    for (let i = 0; i < this.rocks.length; i++) {
      const m = this.rocks[i];
      const b = race.boulders[i];
      m.visible = !!b;
      if (!b) continue;
      m.position.set(b.x, b.y, b.z);
      // 往前滾：繞著賽道的橫向軸轉
      const p = race.track.pointAt(b.d);
      this.axis.set(p.nx, 0, p.nz);
      m.quaternion.copy(this.q.setFromAxisAngle(this.axis, b.roll));
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.street?.dispose();
  }
}
