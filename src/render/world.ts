import * as THREE from 'three';
import { PAD_HALF_WIDTH, PAD_LENGTH, type Sample, type Track } from '../game/track';
import { mulberry32 } from '../game/util';
import { makeInstanced, makeProp } from './assets';

export const SKY_TOP = 0x3d8fe0;
export const SKY_HORIZON = 0xbfe6ff;

export interface World {
  group: THREE.Group;
  /** 任意位置的地形高度（賽道外的草地） */
  terrainH(x: number, z: number): number;
  update(dt: number, time: number, camera: THREE.Camera): void;
}

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** 彎道內側的偏移不能超過曲率半徑，否則網格會翻摺 */
function latClamp(s: Sample, lat: number): number {
  if (s.curv * lat > 0) {
    const lim = 0.9 / Math.abs(s.curv);
    if (Math.abs(lat) > lim) return Math.sign(lat) * lim;
  }
  return lat;
}

interface StripOpt {
  /** 兩條邊相對中心線的橫向偏移與相對路面的高度；水平面時 A 必須是左邊（lat 較大） */
  latA: number; yA: number;
  latB: number; yB: number;
  /** 沿賽道方向每多少公尺貼圖重複一次 */
  scale: number;
  /** true = 貼圖 U 沿賽道方向（牆面用）；false = V 沿賽道方向（路面用） */
  uAlong?: boolean;
  when?: (s: Sample, i: number) => boolean;
  /** 自訂沿賽道方向的貼圖座標 */
  along?: (s: Sample, i: number) => number;
}

function strip(track: Track, o: StripOpt): THREE.BufferGeometry {
  const n = track.n;
  const pos = new Float32Array((n + 1) * 6);
  const uv = new Float32Array((n + 1) * 4);
  const idx: number[] = [];
  const ok: boolean[] = [];
  for (let i = 0; i <= n; i++) {
    const s = track.samples[i % n];
    const la = latClamp(s, o.latA), lb = latClamp(s, o.latB);
    pos.set([s.x + s.nx * la, s.y + o.yA, s.z + s.nz * la, s.x + s.nx * lb, s.y + o.yB, s.z + s.nz * lb], i * 6);
    const d = o.along ? o.along(s, i % n) : (i === n ? track.length : s.dist) / o.scale;
    if (o.uAlong) uv.set([d, 0, d, 1], i * 4);
    else uv.set([0, d, 1, d], i * 4);
    ok.push(!o.when || o.when(s, i % n));
  }
  for (let i = 0; i < n; i++) {
    if (!ok[i] || !ok[i + 1]) continue;
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 建立賽道、護欄、地形與周邊景物 */
export function buildWorld(track: Track, shadows: boolean): World {
  const root = new THREE.Group();
  const hw = track.halfWidth;
  const S = track.samples;
  const n = track.n;
  const rng = mulberry32(42);
  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, receive = true): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = shadows && receive;
    root.add(m);
    return m;
  };

  // ---------- 地形高度：以賽道各點高度做距離加權平均 ----------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
  for (const s of S) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
    sumY += s.y;
  }
  const baseY = sumY / n - 3;
  const coarse: Sample[] = [];
  for (let i = 0; i < n; i += 3) coarse.push(S[i]);
  const terrainH = (x: number, z: number): number => {
    let num = 0, den = 0, dmin = Infinity;
    for (const s of coarse) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
      const w = 1 / ((d2 + 40) * (d2 + 40));
      num += w * s.y;
      den += w;
    }
    const h = num / den - 1.9;
    const d = Math.sqrt(dmin);
    const t = Math.min(1, Math.max(0, (d - 150) / 110));
    return h + (baseY - h) * t * t * (3 - 2 * t);
  };
  /** 與賽道中心線的最短距離 */
  const trackDist = (x: number, z: number): number => {
    let dmin = Infinity;
    for (const s of coarse) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
    }
    return Math.sqrt(dmin);
  };

  // ---------- 草地 ----------
  const grassTex = canvasTex(128, 128, (c) => {
    c.fillStyle = '#6dbb4c';
    c.fillRect(0, 0, 128, 128);
    const r = mulberry32(7);
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = r() > 0.5 ? 'rgba(140,215,95,0.45)' : 'rgba(60,140,58,0.45)';
      c.fillRect(r() * 128, r() * 128, 1 + r() * 3, 1 + r() * 3);
    }
  });
  const M = 270, STEP = 9;
  const gx0 = minX - M, gz0 = minZ - M;
  const nx = Math.ceil((maxX - minX + 2 * M) / STEP), nz = Math.ceil((maxZ - minZ + 2 * M) / STEP);
  {
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    const col = new Float32Array((nx + 1) * (nz + 1) * 3);
    const idx: number[] = [];
    const c = new THREE.Color();
    let p = 0;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = gx0 + i * STEP, z = gz0 + j * STEP;
      const y = terrainH(x, z);
      pos.set([x, y, z], p * 3);
      uv.set([x / 7, z / 7], p * 2);
      const v = 0.82 + rng() * 0.22 + (y - baseY) * 0.006;
      c.setRGB(v, v * (0.98 + rng() * 0.06), v * 0.92);
      col.set([c.r, c.g, c.b], p * 3);
      p++;
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    addMesh(g, new THREE.MeshLambertMaterial({ map: grassTex, vertexColors: true }));
    const farTex = grassTex.clone();
    farTex.repeat.set(500, 500);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: farTex, color: 0xdfe8d8 }));
    far.position.set((minX + maxX) / 2, baseY - 0.15, (minZ + maxZ) / 2);
    root.add(far);
  }

  // ---------- 路面 ----------
  const roadTex = canvasTex(512, 512, (c) => {
    c.fillStyle = '#424650';
    c.fillRect(0, 0, 512, 512);
    const r = mulberry32(3);
    for (let i = 0; i < 9000; i++) {
      const v = 48 + r() * 46;
      c.fillStyle = `rgba(${v},${v},${v + 8},0.3)`;
      c.fillRect(r() * 512, r() * 512, 2, 2);
    }
    // 輪胎磨出的深色帶
    for (const x of [150, 362]) {
      const g = c.createLinearGradient(x - 46, 0, x + 46, 0);
      g.addColorStop(0, 'rgba(20,20,24,0)');
      g.addColorStop(0.5, 'rgba(20,20,24,0.22)');
      g.addColorStop(1, 'rgba(20,20,24,0)');
      c.fillStyle = g;
      c.fillRect(x - 46, 0, 92, 512);
    }
    c.fillStyle = '#f3f3f3';
    c.fillRect(14, 0, 7, 512);
    c.fillRect(491, 0, 7, 512);
    c.fillStyle = '#ffd94a';
    c.fillRect(252, 0, 8, 250);
  });
  addMesh(strip(track, { latA: hw, yA: 0.02, latB: -hw, yB: 0.02, scale: 12 }), new THREE.MeshLambertMaterial({ map: roadTex }));

  // 彎道的紅白路緣
  const curbTex = canvasTex(32, 64, (c) => {
    c.fillStyle = '#f4f4f4';
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = '#e8343f';
    c.fillRect(0, 32, 32, 32);
  });
  const curbMat = new THREE.MeshLambertMaterial({ map: curbTex });
  const inCorner = (s: Sample, i: number) => {
    for (let k = -8; k <= 8; k += 4) if (Math.abs(S[(i + k + n) % n].curv) > 0.012) return true;
    return Math.abs(s.curv) > 0.012;
  };
  addMesh(strip(track, { latA: hw, yA: 0.05, latB: hw - 1.5, yB: 0.035, scale: 5, when: inCorner }), curbMat);
  addMesh(strip(track, { latA: -(hw - 1.5), yA: 0.035, latB: -hw, yB: 0.05, scale: 5, when: inCorner }), curbMat);

  // ---------- 護欄（彩色積木風） ----------
  const wallTex = canvasTex(256, 64, (c) => {
    const cols = ['#ff5d8f', '#ffd23f', '#3bceac', '#4d9de0'];
    cols.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(i * 64, 0, 64, 64);
      c.fillStyle = 'rgba(0,0,0,0.14)';
      c.fillRect(i * 64, 44, 64, 20);
      c.fillStyle = 'rgba(255,255,255,0.4)';
      c.fillRect(i * 64 + 4, 7, 56, 8);
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(i * 64, 0, 2, 64);
    });
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 256, 5);
  });
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex, side: THREE.DoubleSide });
  const capMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
  const WH = 1.5;
  for (const sg of [1, -1]) {
    const inner = sg * (hw + 0.35), outer = sg * (hw + 0.95);
    const wIn = addMesh(strip(track, { latA: inner, yA: WH, latB: inner, yB: -0.4, scale: 12, uAlong: true }), wallMat);
    const wOut = addMesh(strip(track, { latA: outer, yA: WH, latB: outer, yB: -0.6, scale: 12, uAlong: true }), wallMat);
    wIn.castShadow = wOut.castShadow = shadows;
    addMesh(strip(track, sg > 0 ? { latA: outer, yA: WH, latB: inner, yB: WH, scale: 10 } : { latA: inner, yA: WH, latB: outer, yB: WH, scale: 10 }), capMat);
  }

  // 急彎外側的方向指示牌
  const arrowTex = canvasTex(128, 64, (c) => {
    c.fillStyle = '#ffd400';
    c.fillRect(0, 0, 128, 64);
    c.fillStyle = '#15161a';
    for (const x of [8, 72]) {
      c.beginPath();
      c.moveTo(x, 6); c.lineTo(x + 24, 6); c.lineTo(x + 50, 32); c.lineTo(x + 24, 58); c.lineTo(x, 58); c.lineTo(x + 26, 32);
      c.closePath();
      c.fill();
    }
  });
  const arrowMat = new THREE.MeshBasicMaterial({ map: arrowTex, side: THREE.DoubleSide });
  for (const sg of [1, -1]) {
    // 左彎（curv > 0）的外側在右邊（lat < 0），反之亦然
    const when = (s: Sample, i: number) => {
      const a = S[(i + 6) % n].curv, b = S[(i - 6 + n) % n].curv;
      return s.curv * sg < -0.02 && a * sg < -0.014 && b * sg < -0.014;
    };
    const lat = sg * (hw + 0.4);
    addMesh(strip(track, { latA: lat, yA: WH + 2.1, latB: lat, yB: WH + 0.15, scale: 4, uAlong: true, when }), arrowMat, false);
  }

  // ---------- 路肩（從護欄外側往下接到草地） ----------
  const shoulderMat = new THREE.MeshLambertMaterial({ map: grassTex, color: 0xcfe6bd });
  addMesh(strip(track, { latA: hw + 9, yA: -3.2, latB: hw + 0.95, yB: -0.02, scale: 7 }), shoulderMat);
  addMesh(strip(track, { latA: -(hw + 0.95), yA: -0.02, latB: -(hw + 9), yB: -3.2, scale: 7 }), shoulderMat);

  // ---------- 加速帶 ----------
  const padTex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#1b1d25';
    c.fillRect(0, 0, 64, 64);
    const g = c.createLinearGradient(0, 64, 0, 0);
    g.addColorStop(0, '#ff7a1a');
    g.addColorStop(1, '#ffe14d');
    c.fillStyle = g;
    for (const y of [56, 24]) {
      c.beginPath();
      c.moveTo(6, y); c.lineTo(32, y - 22); c.lineTo(58, y); c.lineTo(58, y - 12); c.lineTo(32, y - 34); c.lineTo(6, y - 12);
      c.closePath();
      c.fill();
    }
  });
  const padMat = new THREE.MeshBasicMaterial({ map: padTex });
  for (const p of track.pads) {
    const rel = (s: Sample) => {
      let d = s.dist - p.dist;
      if (d > track.length / 2) d -= track.length;
      else if (d < -track.length / 2) d += track.length;
      return d;
    };
    const geo = strip(track, {
      latA: p.lat + PAD_HALF_WIDTH, yA: 0.045, latB: p.lat - PAD_HALF_WIDTH, yB: 0.045, scale: 1,
      when: (s) => Math.abs(rel(s)) <= PAD_LENGTH / 2 + track.spacing,
      along: (s) => rel(s) / (PAD_LENGTH / 2),
    });
    addMesh(geo, padMat, false);
  }

  // ---------- 起跑線、發車格與拱門 ----------
  const s0 = S[0];
  const yaw0 = Math.atan2(s0.tx, s0.tz);
  const checker = canvasTex(256, 32, (c) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      c.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      c.fillRect(i * 16, j * 16, 16, 16);
    }
  }, false);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 3).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: checker }));
  line.position.set(s0.x, s0.y + 0.04, s0.z);
  line.rotation.y = yaw0;
  root.add(line);
  const gridMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let j = 0; j < 8; j++) {
    const row = Math.floor(j / 2), side = j % 2 === 0 ? 1 : -1;
    const back = Math.round((9 + row * 8 + (j % 2) * 3) / track.spacing);
    const s = S[track.wrap(-back + 1)];
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.3).rotateX(-Math.PI / 2), gridMat);
    m.position.set(s.x + s.nx * side * 4.5 + s.tx * 1.2, s.y + 0.04, s.z + s.nz * side * 4.5 + s.tz * 1.2);
    m.rotation.y = Math.atan2(s.tx, s.tz);
    root.add(m);
  }

  const arch = new THREE.Group();
  arch.position.set(s0.x, s0.y, s0.z);
  arch.rotation.y = yaw0;
  const postMat = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.3, 10, 1.3), postMat);
    p.position.set(side * (hw + 1.6), 5, 0);
    p.castShadow = shadows;
    arch.add(p);
  }
  const banner = canvasTex(1024, 128, (c) => {
    c.fillStyle = '#1b1e27';
    c.fillRect(0, 0, 1024, 128);
    c.fillStyle = '#ffd23f';
    c.fillRect(0, 0, 1024, 10);
    c.fillRect(0, 118, 1024, 10);
    c.font = 'italic 900 78px "Segoe UI", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ff7a1a';
    c.fillText('EXPLOSIVE RACING', 516, 68);
    c.fillStyle = '#fff';
    c.fillText('EXPLOSIVE RACING', 512, 64);
  }, false);
  const bannerMat = new THREE.MeshLambertMaterial({ map: banner });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 4.5, 3, 0.9), [postMat, postMat, postMat, postMat, bannerMat, bannerMat]);
  beam.position.y = 9.5;
  beam.castShadow = shadows;
  arch.add(beam);
  root.add(arch);

  // ---------- 沿賽道擺放的模型 ----------
  const props = new THREE.Group();
  root.add(props);
  const sampleAt = (dist: number): Sample => S[track.wrap(Math.round(dist / track.spacing))];
  interface PlaceOpt { yaw?: number; recolor?: Record<string, number>; sink?: number; onRoadLevel?: boolean }
  /** 在距起點 dist 公尺、橫向 lat 處放一個模型，預設正面朝向賽道 */
  const place = (name: string, dist: number, lat: number, width: number, o: PlaceOpt = {}): THREE.Group | null => {
    const s = sampleAt(dist);
    const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
    if (Math.abs(lat) > hw + 2 && trackDist(x, z) < Math.min(Math.abs(lat) - 1.5, hw + 5)) return null; // 會壓到別段賽道
    const g = makeProp(name, width, o.recolor);
    if (!g) return null;
    const y = o.onRoadLevel ? s.y : terrainH(x, z);
    g.position.set(x, y - (o.sink ?? 0), z);
    // 模型的 +Z 朝向賽道中心，再加上各模型自己的修正角
    g.rotation.y = Math.atan2(-s.nx * Math.sign(lat || 1), -s.nz * Math.sign(lat || 1)) + (o.yaw ?? 0);
    if (shadows) g.traverse((m) => { m.castShadow = true; });
    props.add(g);
    return g;
  };
  const L = track.length;
  const far = hw + 15;
  const TENT_COLS = [0xe8545a, 0x3f8fe8, 0xffc93c, 0x39c48a, 0xb469ff];

  // 起跑直線：左側看台、右側維修站
  for (let d = -70; d <= 170; d += 17) place(d % 34 === 0 ? 'grandStandCovered' : 'grandStand', (d + L) % L, far + 2, 16, { sink: 0.3 });
  for (let d = 12; d <= 118; d += 15) place('pitsGarage', d, -(far + 1), 14, { sink: 0.3 });
  place('pitsOffice', 136, -(far + 1), 14, { sink: 0.3 });
  place('pitsOffice', L - 6, -(far + 1), 14, { sink: 0.3 });
  for (const d of [L - 30, L - 55, 190]) place('tentLong', (d + L) % L, -(far + 1), 20, { recolor: { red: TENT_COLS[1] }, sink: 0.2 });
  for (const lat of [hw + 3.2, -(hw + 3.2)]) {
    place('flagCheckers', 6, lat, 1.6, { onRoadLevel: true });
    place('flagCheckers', L - 6, lat, 1.6, { onRoadLevel: true });
    for (let d = 40; d <= 180; d += 35) place(d % 70 === 40 ? 'flagGreen' : 'flagRed', d, lat, 1.4, { onRoadLevel: true });
  }

  // 整條賽道：路燈、旗塔、看板依路段輪流出現
  for (let d = 215; d < L - 90; d += 42) {
    const s = sampleAt(d);
    const out = s.curv > 0 ? -1 : 1; // 彎道外側
    const zone = Math.floor(d / 300) % 4;
    if (Math.abs(s.curv) < 0.01) {
      place('lightPostLarge', d, hw + 3.4, 5.5, { onRoadLevel: true, sink: 0.3 });
      place('lightPostLarge', d + 21, -(hw + 3.4), 5.5, { onRoadLevel: true, sink: 0.3 });
    } else {
      place(zone % 2 ? 'bannerTowerRed' : 'bannerTowerGreen', d, out * (hw + 5), 5, { sink: 0.6 });
    }
    if (d % 126 < 42) place(zone % 2 ? 'billboard' : 'billboardLow', d + 10, out * (far - 2), 13, { sink: 0.3 });
  }

  // 山頂髮夾彎：外側看台與帳篷，內側雷達站
  for (let d = 700; d <= 830; d += 18) place(d % 36 === 0 ? 'grandStandAwning' : 'grandStand', d, far + 3, 16, { sink: 0.4 });
  place('radarEquipment', 760, -(far + 6), 12, { sink: 0.3 });
  for (let i = 0; i < 4; i++) place(i % 2 ? 'tent' : 'tentClosed', 640 + i * 16, -(far + 1), 11, { recolor: { red: TENT_COLS[i], grass: TENT_COLS[(i + 2) % 5] }, sink: 0.2 });

  // 連續 S 彎：兩側彩色帳篷市集與角錐
  for (let d = 1300; d <= 1560; d += 26) {
    const i = Math.round(d / 26);
    place(i % 3 === 0 ? 'tentLong' : 'tent', d, (i % 2 ? 1 : -1) * (far + 2), i % 3 === 0 ? 20 : 11, { recolor: { red: TENT_COLS[i % 5] }, sink: 0.2 });
  }
  place('grandStandCovered', 1430, far + 4, 16, { sink: 0.4 });
  place('grandStandCovered', 1395, -(far + 4), 16, { sink: 0.4 });

  // 山脊與終點前：拱形門架
  for (const d of [1010, 1720, 2290]) {
    const g = place('overheadRoundColored', d, 0, hw * 2 + 9, { onRoadLevel: true, sink: 0.2 });
    if (g) g.rotation.y = Math.atan2(sampleAt(d).tx, sampleAt(d).tz);
  }
  for (let d = 1880; d <= 2000; d += 20) place('tent', d, (d % 40 ? 1 : -1) * (far + 1), 11, { recolor: { red: TENT_COLS[(d / 20) % 5] }, sink: 0.2 });

  // ---------- 樹、灌木、岩石 ----------
  const spots: { x: number; z: number; y: number; d: number }[] = [];
  for (let tries = 0; tries < 9000 && spots.length < 620; tries++) {
    const x = minX - 170 + rng() * (maxX - minX + 340);
    const z = minZ - 170 + rng() * (maxZ - minZ + 340);
    const d = trackDist(x, z);
    if (d < hw + 11) continue;
    // 離賽道越遠越稀疏，並避開看台與維修站
    if (d > 60 && rng() > 0.45) continue;
    let blocked = false;
    for (const pr of props.children) {
      const dx = pr.position.x - x, dz = pr.position.z - z;
      if (dx * dx + dz * dz < 150) { blocked = true; break; }
    }
    if (!blocked) spots.push({ x, z, y: terrainH(x, z), d });
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const mats: THREE.Matrix4[][] = [[], [], [], []];
  for (let i = 0; i < spots.length; i++) {
    const sp = spots[i];
    const kind = i % 10 < 5 ? 0 : i % 10 < 8 ? 1 : i % 10 < 9 ? 2 : 3;
    const s = kind < 2 ? 0.75 + rng() * 0.6 : 0.6 + rng() * 0.9;
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    m4.compose(v.set(sp.x, sp.y - 0.15, sp.z), q, sc.set(s, s * (0.85 + rng() * 0.3), s));
    mats[kind].push(m4.clone());
  }
  const addInst = (g: THREE.Object3D | null) => {
    if (!g) return;
    if (shadows) g.traverse((m) => { m.castShadow = true; });
    root.add(g);
  };
  const treeL = makeInstanced('treeLarge', 13, mats[0]);
  const treeS = makeInstanced('treeSmall', 9, mats[1]);
  if (treeL && treeS) {
    addInst(treeL);
    addInst(treeS);
  } else {
    // 模型沒載入時的備用樹
    const all = [...mats[0], ...mats[1]];
    const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 6.5, 7).translate(0, 5.2, 0), new THREE.MeshLambertMaterial({ color: 0x2f9e58 }), all.length);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshLambertMaterial({ color: 0x8a5a3c }), all.length);
    all.forEach((m, i) => { leaves.setMatrixAt(i, m); trunks.setMatrixAt(i, m); });
    leaves.frustumCulled = trunks.frustumCulled = false;
    addInst(leaves);
    addInst(trunks);
  }
  const bush = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.5, 1).scale(1, 0.75, 1).translate(0, 0.8, 0), new THREE.MeshLambertMaterial({ color: 0x3fa35a, flatShading: true }), mats[2].length);
  mats[2].forEach((m, i) => bush.setMatrixAt(i, m));
  const rock = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1.6, 0).scale(1.2, 0.8, 1).translate(0, 0.7, 0), new THREE.MeshLambertMaterial({ color: 0x9aa0a8, flatShading: true }), mats[3].length);
  mats[3].forEach((m, i) => rock.setMatrixAt(i, m));
  bush.frustumCulled = rock.frustumCulled = false;
  addInst(bush);
  addInst(rock);

  // ---------- 遠山 ----------
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const mMat = new THREE.MeshLambertMaterial({ color: 0x86aacc, flatShading: true });
  const snow = new THREE.MeshLambertMaterial({ color: 0xf2f6fa, flatShading: true });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng() * 0.2;
    const r = 760 + rng() * 260;
    const h = 150 + rng() * 190;
    const rad = 150 + rng() * 110;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), mMat);
    m.position.set(cx + Math.cos(a) * r, baseY + h / 2 - 6, cz + Math.sin(a) * r);
    m.rotation.y = rng() * 3;
    root.add(m);
    if (h > 230) {
      const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.3, h * 0.3, 7), snow);
      cap.position.set(m.position.x, baseY + h * 0.85 - 5.5, m.position.z);
      cap.rotation.y = m.rotation.y;
      root.add(cap);
    }
  }

  // ---------- 天空、雲與熱氣球 ----------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1300, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(SKY_TOP) },
        horizon: { value: new THREE.Color(SKY_HORIZON) },
        sunDir: { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.9, 0.7) * (pow(s, 240.0) * 1.5 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  root.add(sky);

  const clouds = new THREE.Group();
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const puff = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 16; i++) {
    const g = new THREE.Group();
    const parts = 4 + Math.floor(rng() * 4);
    for (let k = 0; k < parts; k++) {
      const m = new THREE.Mesh(puff, cloudMat);
      const s = 16 + rng() * 22;
      m.scale.set(s * 1.5, s * 0.6, s);
      m.position.set((k - parts / 2) * 22 + rng() * 10, rng() * 8, rng() * 18 - 9);
      g.add(m);
    }
    const a = rng() * Math.PI * 2, r = 250 + rng() * 650;
    g.position.set(cx + Math.cos(a) * r, 210 + rng() * 120, cz + Math.sin(a) * r);
    g.rotation.y = rng() * 3;
    clouds.add(g);
  }
  root.add(clouds);

  const balloons: THREE.Group[] = [];
  const balloonCols = [0xff5d8f, 0xffd23f, 0x3bceac, 0x4d9de0, 0xff7a1a, 0xb05cff];
  const envelope = new THREE.SphereGeometry(9, 12, 10).scale(1, 1.15, 1);
  const basket = new THREE.BoxGeometry(3, 2.4, 3);
  const basketMat = new THREE.MeshLambertMaterial({ color: 0x8a5a3c });
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const e = new THREE.Mesh(envelope, new THREE.MeshLambertMaterial({ color: balloonCols[i], flatShading: true }));
    e.position.y = 13;
    const b = new THREE.Mesh(basket, basketMat);
    g.add(e, b);
    const sp = S[Math.floor((i + 0.5) * (n / 6))];
    const side = i % 2 ? 1 : -1;
    g.position.set(sp.x + sp.nx * side * (45 + rng() * 40), sp.y + 38 + rng() * 30, sp.z + sp.nz * side * (45 + rng() * 40));
    g.userData.y0 = g.position.y;
    g.userData.ph = rng() * 6;
    balloons.push(g);
    root.add(g);
  }

  return {
    group: root,
    terrainH,
    update(dt, time, camera) {
      padTex.offset.y = -(time * 1.6) % 1;
      sky.position.copy(camera.position);
      clouds.rotation.y += dt * 0.004;
      for (const b of balloons) {
        b.position.y = b.userData.y0 + Math.sin(time * 0.4 + b.userData.ph) * 3;
        b.rotation.y += dt * 0.1;
      }
    },
  };
}
