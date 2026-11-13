import * as THREE from 'three';
import { KERB_WIDTH, type Sample, type Track } from '../game/track';
import { mulberry32 } from '../game/util';
import type { Theme } from './themes';

/**
 * 軟邊界（路邊的砂石緩衝區）的畫面：
 * 砂石地面、路緣石、外圍的岩石與輪胎牆、台地邊緣的懸崖，以及屏障外面往下接到地形的路肩。
 * 寬度全部來自 track.runoffL / runoffR，跟物理用的是同一份資料。
 */

/** 彎道內側的偏移不能超過曲率半徑，否則網格會翻摺（跟 world.ts 的 latClamp 一樣） */
function clampIn(s: Sample, lat: number): number {
  if (s.curv * lat > 0) {
    const lim = 0.9 / Math.abs(s.curv);
    if (Math.abs(lat) > lim) return Math.sign(lat) * lim;
  }
  return lat;
}

type Fn = (i: number) => number;

/**
 * 沿主線鋪一條帶狀網格，兩條邊的橫向位置與高度可以逐點變化。
 * A 邊的 lat 要比 B 邊大（水平面時 A 在左邊，跟 world.ts 的 strip 一樣），seg(i) 決定第 i 到 i+1 點之間要不要鋪。
 */
function ribbon(track: Track, latA: Fn, yA: Fn, latB: Fn, yB: Fn, seg: (i: number) => boolean, uv: 'flat' | 'wall', scale: number): THREE.BufferGeometry {
  const S = track.samples, n = track.n;
  const pos = new Float32Array((n + 1) * 6), uvs = new Float32Array((n + 1) * 4);
  for (let k = 0; k <= n; k++) {
    const i = k % n, s = S[i];
    const la = clampIn(s, latA(i)), lb = clampIn(s, latB(i));
    pos.set([s.x + s.nx * la, s.y + yA(i), s.z + s.nz * la, s.x + s.nx * lb, s.y + yB(i), s.z + s.nz * lb], k * 6);
    const d = (k === n ? track.length : s.dist) / scale;
    if (uv === 'flat') uvs.set([la / scale, d, lb / scale, d], k * 4);
    else uvs.set([d, 0, d, 1], k * 4);
  }
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    if (!seg(k)) continue;
    const a = k * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** 屏障內側（車碰得到的那一面）離緩衝區外緣的距離：跟一般護欄一樣 */
const FACE = 0.35;
/** 屏障本身的厚度（砂石地面要鋪到屏障底下） */
const BARRIER_DEPTH = 2.6;
/** 屏障底下要多鋪的緩衝區地面寬度：寬度 0（一般護欄）時正好接到護欄外側，跟原本的路肩接得起來 */
export const runoffPad = (w: number) => Math.min(BARRIER_DEPTH, 0.95 + 2 * w);

/** 緩衝區地面的貼圖：沙漠是砂石、草原是比旁邊草地深一點的草（有輪胎痕）、城市是畫了斜紋的水泥鋪面 */
function surfaceTex(style: Track['runoffSurface'], desert: boolean): THREE.CanvasTexture {
  return canvasTex(256, 256, (c) => {
    const r = mulberry32(17);
    if (style === 'forest') {
      // 森林地面：草地與泥土斑塊，撒滿紅橙黃的落葉
      c.fillStyle = '#5f7d35';
      c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 46; i++) {
        c.fillStyle = r() < 0.6 ? 'rgba(118,86,50,0.45)' : 'rgba(80,110,40,0.4)';
        c.beginPath();
        c.ellipse(r() * 256, r() * 256, 10 + r() * 26, 6 + r() * 16, r() * 3, 0, Math.PI * 2);
        c.fill();
      }
      for (let i = 0; i < 2600; i++) {
        const v = r();
        c.fillStyle = v < 0.35 ? 'rgba(40,70,25,0.35)' : v < 0.6 ? 'rgba(160,200,100,0.22)' : v < 0.75 ? 'rgba(200,100,40,0.7)' : v < 0.88 ? 'rgba(220,165,60,0.7)' : 'rgba(140,55,35,0.7)';
        c.fillRect(r() * 256, r() * 256, v < 0.6 ? 1 + r() * 2 : 2 + r() * 3, v < 0.6 ? 2 + r() * 3 : 2 + r() * 2);
      }
      c.strokeStyle = 'rgba(70,50,30,0.18)';
      c.lineWidth = 7;
      for (const x0 of [74, 100, 168, 194]) {
        c.beginPath();
        c.moveTo(x0, 0);
        c.bezierCurveTo(x0 + 28, 90, x0 - 24, 170, x0 + 8, 256);
        c.stroke();
      }
      return;
    }
    if (style === 'grass') {
      c.fillStyle = '#4f9a3c';
      c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 4200; i++) {
        const v = r();
        c.fillStyle = v < 0.5 ? 'rgba(30,80,25,0.3)' : v < 0.9 ? 'rgba(150,210,100,0.22)' : 'rgba(110,90,50,0.35)';
        c.fillRect(r() * 256, r() * 256, 1 + r() * 2, 2 + r() * 4);
      }
      // 開出去的車留下的淡淡輪胎痕
      c.strokeStyle = 'rgba(70,55,35,0.16)';
      c.lineWidth = 7;
      for (const x0 of [70, 96, 170, 196]) {
        c.beginPath();
        c.moveTo(x0, 0);
        c.bezierCurveTo(x0 + 30, 90, x0 - 26, 170, x0 + 8, 256);
        c.stroke();
      }
      return;
    }
    if (style === 'paved') {
      c.fillStyle = '#5b606b';
      c.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 3800; i++) {
        c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.07)';
        c.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
      }
      // 水泥板的接縫與斜紋標線（禁止停車區那種）
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, 127, 256, 2);
      c.fillRect(127, 0, 2, 256);
      c.fillStyle = 'rgba(235,235,225,0.42)';
      for (let k = -256; k < 512; k += 64) {
        c.beginPath();
        c.moveTo(k, 256);
        c.lineTo(k + 18, 256);
        c.lineTo(k + 18 + 256, 0);
        c.lineTo(k + 256, 0);
        c.closePath();
        c.fill();
      }
      return;
    }
    c.fillStyle = desert ? '#cfa36a' : '#b9a383';
    c.fillRect(0, 0, 256, 256);
    // 細砂的明暗斑點與小碎石
    for (let i = 0; i < 5200; i++) {
      const v = r();
      c.fillStyle = v < 0.45 ? 'rgba(120,80,40,0.16)' : v < 0.85 ? 'rgba(255,240,210,0.16)' : 'rgba(90,60,35,0.45)';
      const s = v < 0.85 ? 1 + r() * 3 : 1 + r() * 2;
      c.fillRect(r() * 256, r() * 256, s, s);
    }
    // 被風吹出的淡淡波紋
    c.strokeStyle = 'rgba(120,80,40,0.08)';
    c.lineWidth = 3;
    for (let y = 8; y < 256; y += 22) {
      c.beginPath();
      c.moveTo(0, y);
      for (let x = 0; x <= 256; x += 16) c.lineTo(x, y + Math.sin(x * 0.05 + y) * 4);
      c.stroke();
    }
  });
}

export function buildRunoff(track: Track, theme: Theme, root: THREE.Group, shoulderMat: THREE.Material, shadows: boolean, lowDetail: boolean): void {
  if (!track.hasRunoff) return;
  const S = track.samples, n = track.n, hw = track.halfWidth;
  const rng = mulberry32(913 + n);
  const W = (sg: number) => (sg > 0 ? track.runoffL : track.runoffR);
  const cliff = (i: number, sg: number) => track.cliffAt(track.wrap(i), sg);
  const pad = runoffPad;
  const desert = theme.vegetation === 'desert';
  const style = track.runoffSurface;
  const add = (g: THREE.BufferGeometry, m: THREE.Material, receive = true, cast = false) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = shadows && receive;
    mesh.castShadow = shadows && cast;
    root.add(mesh);
    return mesh;
  };

  // ---------- 緩衝區地面 ----------
  const sandMat = new THREE.MeshLambertMaterial({ map: surfaceTex(style, desert) });
  for (const sg of [1, -1]) {
    const w = W(sg);
    const inner = () => sg * hw;
    const outer = (i: number) => sg * (hw + w[i] + (cliff(i, sg) ? 0 : pad(w[i])));
    const seg = (i: number) => w[i] > 0 || w[track.wrap(i + 1)] > 0;
    const y = () => 0.02;
    add(sg > 0 ? ribbon(track, outer, y, inner, y, seg, 'flat', 7) : ribbon(track, inner, y, outer, y, seg, 'flat', 7), sandMat);
  }

  // ---------- 路緣石：有緩衝區的路段，路邊一律是紅白路緣（壓上去沒有懲罰） ----------
  const kerbTex = canvasTex(32, 64, (c) => {
    c.fillStyle = '#f4f4f4';
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = '#e8343f';
    c.fillRect(0, 32, 32, 32);
  });
  kerbTex.wrapS = THREE.ClampToEdgeWrapping;
  const kerbMat = new THREE.MeshLambertMaterial({ map: kerbTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (const sg of [1, -1]) {
    const w = W(sg);
    const seg = (i: number) => w[i] > 0 && w[track.wrap(i + 1)] > 0;
    const a = () => sg * hw, b = () => sg * (hw + KERB_WIDTH);
    const yIn = () => 0.04, yOut = () => 0.03;
    add(sg > 0 ? ribbon(track, b, yOut, a, yIn, seg, 'wall', 5) : ribbon(track, a, yIn, b, yOut, seg, 'wall', 5), kerbMat);
  }

  // ---------- 屏障外的路肩（往下接到地形）；這條賽道的路肩全部在這裡鋪 ----------
  for (const sg of [1, -1]) {
    const w = W(sg);
    const seg = (i: number) => !cliff(i, sg) && !cliff(i + 1, sg);
    const a = (i: number) => sg * (hw + w[i] + pad(w[i])), b = (i: number) => sg * (hw + w[i] + pad(w[i]) + 8.05);
    const yIn = () => -0.02, yOut = () => -3.2;
    add(sg > 0 ? ribbon(track, b, yOut, a, yIn, seg, 'flat', 7) : ribbon(track, a, yIn, b, yOut, seg, 'flat', 7), shoulderMat);
  }

  // ---------- 台地邊緣的懸崖：岩壁直直往下，邊緣一圈深色的岩石 ----------
  const faceTex = canvasTex(64, 256, (c) => {
    c.fillStyle = desert ? '#a4532f' : '#6d665c';
    c.fillRect(0, 0, 64, 256);
    const r = mulberry32(23);
    // 水平岩層
    for (let y = 0; y < 256; y += 6 + r() * 14) {
      c.fillStyle = r() < 0.5 ? 'rgba(255,200,150,0.14)' : 'rgba(60,25,10,0.18)';
      c.fillRect(0, y, 64, 2 + r() * 6);
    }
    for (let i = 0; i < 260; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)';
      c.fillRect(r() * 64, r() * 256, 1 + r() * 3, 2 + r() * 6);
    }
  });
  const faceMat = new THREE.MeshLambertMaterial({ map: faceTex, side: THREE.DoubleSide });
  const rimMat = new THREE.MeshLambertMaterial({ color: desert ? 0x9a5a36 : 0x6f6a62 });
  for (const sg of [1, -1]) {
    const w = W(sg);
    const seg = (i: number) => cliff(i, sg) || cliff(i + 1, sg);
    const top = (i: number) => sg * (hw + w[i]), bot = (i: number) => sg * (hw + w[i] + 2.5);
    const yTop = () => 0.02, yBot = () => -26;
    // 岩壁的貼圖：沿賽道 8 公尺重複一次，高度方向整張
    add(sg > 0 ? ribbon(track, bot, yBot, top, yTop, seg, 'wall', 8) : ribbon(track, top, yTop, bot, yBot, seg, 'wall', 8), faceMat);
    const rimIn = (i: number) => sg * (hw + w[i] - 0.7);
    const yRim = () => 0.045;
    add(sg > 0 ? ribbon(track, top, yRim, rimIn, yRim, seg, 'flat', 4) : ribbon(track, rimIn, yRim, top, yRim, seg, 'flat', 4), rimMat);
  }

  // ---------- 外圍屏障 ----------
  // 沙漠：急彎外側與收窄的地方是輪胎牆，其他是岩石；草原：輪胎牆＋乾草捆；城市：水泥護欄加霓虹燈條
  // 一疊三個輪胎畫成一個圓柱（貼圖畫出三圈輪胎），最上面一個紅白相間：紅頂、白頂各一組
  const tyresRed: THREE.Matrix4[] = [], tyresWhite: THREE.Matrix4[] = [];
  const rocks: THREE.Matrix4[] = [], rockCol: number[] = [];
  const bales: THREE.Matrix4[] = [], baleCol: number[] = [];
  const logs: THREE.Matrix4[] = [], logCol: number[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const rows = lowDetail ? 1 : 2;
  const rockBase = new THREE.Color(desert ? 0xb4683f : 0x8d877c);
  const c0 = new THREE.Color();
  if (style === 'paved') buildJersey();
  else for (const sg of [1, -1]) {
    const w = W(sg);
    const on = (i: number) => !cliff(i, sg) && (w[i] > 0 || w[track.wrap(i + 1)] > 0 || w[track.wrap(i - 1)] > 0);
    /** 這個取樣點用輪胎牆嗎：緩衝區窄（接近護欄的收口）、寬度在變化、或是急彎外側（容易高速撞上去） */
    const tyreAt = (i: number) => {
      if (w[i] < 5 || Math.abs(w[track.wrap(i + 6)] - w[track.wrap(i - 6)]) > 1) return true;
      for (let k = -6; k <= 6; k += 2) if (S[track.wrap(i + k)].curv * sg < -0.025) return true;
      return false;
    };
    let carryT = 0, carryR = 0, stack = 0;
    for (let i = 0; i < n; i++) {
      const j = track.wrap(i + 1);
      if (!on(i) || !on(j)) { carryT = carryR = 0; continue; }
      const a = S[i], b = S[j];
      const la = clampIn(a, sg * (hw + w[i] + FACE)), lb = clampIn(b, sg * (hw + w[j] + FACE));
      const ax = a.x + a.nx * la, az = a.z + a.nz * la, bx = b.x + b.nx * lb, bz = b.z + b.nz * lb;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      // 屏障往外的方向（取兩點的法線平均）
      let ox = (a.nx + b.nx) * sg, oz = (a.nz + b.nz) * sg;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      const y0 = (a.y + b.y) / 2 + 0.02;
      if (tyreAt(i)) {
        carryR = 0;
        // 輪胎：每 0.9 公尺一疊（三個高），前後兩排
        let t = carryT;
        for (; t < len; t += 0.9) {
          const u = t / len, px = ax + (bx - ax) * u, pz = az + (bz - az) * u;
          for (let r = 0; r < rows; r++) {
            m4.makeTranslation(px + ox * (0.45 + r * 0.9), y0 + 0.53, pz + oz * (0.45 + r * 0.9));
            ((stack + r) % 2 ? tyresWhite : tyresRed).push(m4.clone());
          }
          stack++;
        }
        carryT = t - len;
      } else if (style === 'forest') {
        carryT = 0;
        // 疊起來的圓木：下面兩根並排、上面一根，每 3 公尺一組，長度比間距長一點，看起來連成一道矮牆
        const yaw = Math.atan2(bx - ax, bz - az);
        let t = carryR;
        for (; t < len; t += 3) {
          const u = t / len, px = ax + (bx - ax) * u, pz = az + (bz - az) * u;
          q.setFromAxisAngle(v.set(0, 1, 0), yaw + (rng() - 0.5) * 0.06);
          for (const [o, h] of [[0.32, 0.3], [0.9, 0.3], [0.61, 0.82]] as [number, number][]) {
            m4.compose(v.set(px + ox * o, y0 + h, pz + oz * o), q, sc.set(1, 1, 0.94 + rng() * 0.12));
            logs.push(m4.clone());
            logCol.push(c0.setRGB(1, 1, 1).multiplyScalar(0.82 + rng() * 0.3).getHex());
          }
        }
        carryR = t - len;
      } else if (style === 'grass') {
        carryT = 0;
        // 乾草捆：沿著屏障線排一排，每隔一捆上面再疊一捆
        const yaw = Math.atan2(bx - ax, bz - az);
        let t = carryR;
        for (; t < len; t += 1.75) {
          const u = t / len, px = ax + (bx - ax) * u, pz = az + (bz - az) * u;
          q.setFromAxisAngle(v.set(0, 1, 0), yaw + (rng() - 0.5) * 0.08);
          for (let h = 0; h < (stack % 2 ? 2 : 1); h++) {
            m4.compose(v.set(px + ox * (0.6 + h * 0.08), y0 + 0.45 + h * 0.88, pz + oz * (0.6 + h * 0.08)), q, sc.set(1, 1, 1));
            bales.push(m4.clone());
            baleCol.push(c0.setRGB(1, 1, 1).multiplyScalar(0.88 + rng() * 0.2).getHex());
          }
          stack++;
        }
        carryR = t - len;
      } else {
        carryT = 0;
        // 岩石：前排緊貼屏障線、彼此重疊成一道矮岩牆；後排是比較大的岩塊
        let t = carryR;
        for (; t < len; t += 1.7 + rng() * 0.8) {
          const u = t / len, px = ax + (bx - ax) * u, pz = az + (bz - az) * u;
          const r = 1.15 + rng() * 0.6;
          e.set((rng() - 0.5) * 0.4, rng() * Math.PI * 2, (rng() - 0.5) * 0.4);
          q.setFromEuler(e);
          m4.compose(v.set(px + ox * r * 0.8, y0 + r * 0.3, pz + oz * r * 0.8), q, sc.set(r * 1.15, r * (0.85 + rng() * 0.3), r));
          rocks.push(m4.clone());
          rockCol.push(c0.copy(rockBase).multiplyScalar(0.85 + rng() * 0.3).getHex());
          if (!lowDetail && rng() < 0.45) {
            const R = 1.8 + rng() * 1.6;
            e.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5);
            q.setFromEuler(e);
            const back = 2.2 + R * 0.6;
            m4.compose(v.set(px + ox * back, y0 + R * 0.15, pz + oz * back), q, sc.set(R * 1.2, R * (0.7 + rng() * 0.5), R));
            rocks.push(m4.clone());
            rockCol.push(c0.copy(rockBase).multiplyScalar(0.75 + rng() * 0.3).getHex());
          }
        }
        carryR = t - len;
      }
    }
  }
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], list: THREE.Matrix4[], cols?: number[]) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => {
      im.setMatrixAt(i, m);
      if (cols) im.setColorAt(i, c0.setHex(cols[i]));
    });
    im.frustumCulled = false;
    im.castShadow = shadows;
    im.receiveShadow = shadows;
    root.add(im);
  };
  /** 一疊輪胎的側面：下面兩個黑色、最上面一個是 top 色，每個輪胎中間有一圈胎紋 */
  const tyreTex = (top: string) => canvasTex(16, 96, (c) => {
    for (let k = 0; k < 3; k++) {
      const y0 = 96 - (k + 1) * 32;
      c.fillStyle = k === 2 ? top : '#202126';
      c.fillRect(0, y0, 16, 32);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(0, y0, 16, 3);
      c.fillRect(0, y0 + 29, 16, 3);
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.fillRect(0, y0 + 13, 16, 6);
    }
  });
  const tyreGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.06, 8);
  // 圓柱的群組是側面、頂面、底面：底面貼在地上看不到，不畫
  tyreGeo.groups.length = 2;
  for (const [list, top, cap] of [[tyresRed, '#e23b3b', 0xe23b3b], [tyresWhite, '#f2f2f2', 0xf2f2f2]] as [THREE.Matrix4[], string, number][]) {
    inst(tyreGeo, [new THREE.MeshLambertMaterial({ map: tyreTex(top) }), new THREE.MeshLambertMaterial({ color: cap })], list);
  }
  inst(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ flatShading: true }), rocks, rockCol);
  if (logs.length) {
    // 圓木：樹皮的縱紋與青苔，兩端是淺色的年輪切面
    const barkTex = canvasTex(64, 32, (c) => {
      c.fillStyle = '#6b4a2b';
      c.fillRect(0, 0, 64, 32);
      const r = mulberry32(37);
      for (let i = 0; i < 90; i++) {
        c.fillStyle = r() < 0.6 ? 'rgba(30,18,8,0.45)' : 'rgba(150,110,70,0.35)';
        c.fillRect(r() * 64, r() * 32, 1 + r() * 2, 4 + r() * 12);
      }
      c.fillStyle = 'rgba(90,130,50,0.5)';
      c.fillRect(0, 0, 64, 5);
    });
    // 圓柱沿 Y 軸，轉成沿 Z 軸（屏障的方向）
    const logGeo = new THREE.CylinderGeometry(0.29, 0.31, 3.1, 7).rotateX(Math.PI / 2);
    // 群組：側面（樹皮）、兩端的切面
    inst(logGeo, [new THREE.MeshLambertMaterial({ map: barkTex }), new THREE.MeshLambertMaterial({ color: 0xd9b07a }), new THREE.MeshLambertMaterial({ color: 0xd9b07a })], logs, logCol);
  }
  if (bales.length) {
    // 乾草捆：草稈的橫紋與兩道綁繩
    const strawTex = canvasTex(64, 64, (c) => {
      c.fillStyle = '#d8b35a';
      c.fillRect(0, 0, 64, 64);
      const r = mulberry32(31);
      for (let i = 0; i < 260; i++) {
        c.fillStyle = r() < 0.5 ? 'rgba(140,100,30,0.35)' : 'rgba(255,240,170,0.35)';
        c.fillRect(r() * 64, r() * 64, 4 + r() * 10, 1);
      }
      c.fillStyle = 'rgba(90,60,25,0.6)';
      c.fillRect(18, 0, 3, 64);
      c.fillRect(43, 0, 3, 64);
    });
    inst(new THREE.BoxGeometry(1.1, 0.88, 1.7), new THREE.MeshLambertMaterial({ map: strawTex }), bales, baleCol);
  }

  /**
   * 城市的外圍屏障：水泥護欄（Jersey barrier）的斷面沿著緩衝區外緣拉出來，內側上緣一條霓虹燈條
   * （夜裡看得到；左側青色、右側洋紅，跟路邊的燈條一樣）。寬度變窄的地方護欄跟著斜斜收進來。
   */
  function buildJersey(): void {
    const concrete = new THREE.MeshLambertMaterial({ color: 0xb9bdc6, emissive: theme.night ? 0x262a36 : 0x000000, side: THREE.DoubleSide });
    // 斷面：[離緩衝區外緣的距離, 高度]，從車道那一側的底部開始
    const prof: [number, number][] = [[FACE, 0], [FACE + 0.12, 0.3], [FACE + 0.28, 0.95], [FACE + 0.72, 0.95], [FACE + 0.88, 0.3], [FACE + 1.0, 0]];
    for (const sg of [1, -1]) {
      const w = W(sg);
      const seg = (i: number) => !cliff(i, sg) && !cliff(i + 1, sg) && (w[i] > 0 || w[track.wrap(i + 1)] > 0);
      for (let k = 0; k < prof.length - 1; k++) {
        const [o0, y0] = prof[k], [o1, y1] = prof[k + 1];
        const l0 = (i: number) => sg * (hw + w[i] + o0), l1 = (i: number) => sg * (hw + w[i] + o1);
        const h0 = () => y0, h1 = () => y1;
        // A 邊要是 lat 比較大的那一邊
        const big = sg > 0 ? o1 >= o0 : o1 < o0;
        add(big ? ribbon(track, l1, h1, l0, h0, seg, 'wall', 6) : ribbon(track, l0, h0, l1, h1, seg, 'wall', 6), concrete, true, k === 1 || k === 2);
      }
      // 霓虹燈條（白天是紅白相間的反光條）
      const stripMat = theme.night
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(sg > 0 ? theme.edgeNeon?.[0] ?? 0x22e6ff : theme.edgeNeon?.[1] ?? 0xff3d9a).multiplyScalar(1.9), side: THREE.DoubleSide })
        : new THREE.MeshLambertMaterial({ color: 0xe8343f, side: THREE.DoubleSide });
      // 貼在內側斜面前面一點點（斜面在 0.66 m 高處約 FACE+0.21、0.86 m 處約 FACE+0.26）
      const lo = (i: number) => sg * (hw + w[i] + FACE + 0.19), hi = (i: number) => sg * (hw + w[i] + FACE + 0.237);
      const yLo = () => 0.66, yHi = () => 0.86;
      add(sg > 0 ? ribbon(track, hi, yHi, lo, yLo, seg, 'wall', 6) : ribbon(track, lo, yLo, hi, yHi, seg, 'wall', 6), stripMat, false);
    }
  }
}
