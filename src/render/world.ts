import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CFG } from '../game/config';
import { TRAM } from '../game/race';
import { makeTerrain } from '../game/terrain';
import { PAD_HALF_WIDTH, PAD_LENGTH, type Branch, type Sample, type SceneRange, type Track } from '../game/track';
import { mulberry32 } from '../game/util';
import { makeInstanced, makeLandmark, makeProp } from './assets';
import { applyTerrainDetail, grassTufts, roadDetailMaterial } from './detail';
import { buildRunoff, runoffPad } from './runoff';
import type { Theme } from './themes';

export interface World {
  group: THREE.Group;
  /** 任意位置的地形高度（賽道外的地面） */
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
  /** 額外加上的高度（跳台斜面用）；liftA / liftB 設為 false 可以只抬其中一邊 */
  lift?: (s: Sample, i: number) => number;
  liftB?: boolean;
  liftA?: boolean;
}

/** 主線（封閉）或捷徑（不封閉）都可以拿來鋪路面 */
type Path = Track | Branch;

function strip(track: Path, o: StripOpt): THREE.BufferGeometry {
  const n = track.n;
  const cnt = track.closed ? n + 1 : n;
  const pos = new Float32Array(cnt * 6);
  const uv = new Float32Array(cnt * 4);
  const idx: number[] = [];
  const ok: boolean[] = [];
  for (let i = 0; i < cnt; i++) {
    const s = track.samples[i % n];
    const la = latClamp(s, o.latA), lb = latClamp(s, o.latB);
    const lift = o.lift ? o.lift(s, i % n) : 0;
    pos.set([
      s.x + s.nx * la, s.y + o.yA + (o.liftA === false ? 0 : lift), s.z + s.nz * la,
      s.x + s.nx * lb, s.y + o.yB + (o.liftB === false ? 0 : lift), s.z + s.nz * lb,
    ], i * 6);
    const d = o.along ? o.along(s, i % n) : (i === n ? track.length : s.dist) / o.scale;
    if (o.uAlong) uv.set([d, 0, d, 1], i * 4);
    else uv.set([0, d, 1, d], i * 4);
    ok.push(!o.when || o.when(s, i % n));
  }
  for (let i = 0; i < cnt - 1; i++) {
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

/** 比 1 亮的顏色：在泛光下會發亮 */
const glow = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

/**
 * 依賽道與主題建立整個場景：路面、護欄、地形、景物、天空。
 * detail：地面細節（路面法線／粗糙度、地形岩石泥土、草叢）——0 = 不做、1 = 草叢稀疏、2 = 全部
 */
export function buildWorld(track: Track, theme: Theme, shadows: boolean, lowDetail: boolean, detail: 0 | 1 | 2 = 0): World {
  const root = new THREE.Group();
  const hw = track.halfWidth;
  const S = track.samples;
  const n = track.n;
  const L = track.length;
  const rng = mulberry32(42 + track.def.id.length * 7);
  const night = theme.night;
  const updaters: ((dt: number, time: number) => void)[] = [];
  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, receive = true): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = shadows && receive;
    root.add(m);
    return m;
  };
  const relDist = (s: Sample, d0: number): number => {
    let d = s.dist - d0;
    if (d > L / 2) d -= L;
    else if (d < -L / 2) d += L;
    return d;
  };
  const wrapD = (d: number) => ((d % L) + L) % L;
  const sampleAt = (dist: number): Sample => S[track.wrap(Math.round(wrapD(dist) / track.spacing))];

  // ---------- 地形 ----------
  const terrain = makeTerrain(track);
  const { minX, maxX, minZ, maxZ, baseY } = terrain;
  const trackDist = terrain.trackDist;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // 內野找一塊離賽道夠遠、地勢最低的地方挖一座湖
  let lake: { x: number; z: number; r: number; y: number } | null = null;
  if (theme.lake) {
    let best = Infinity;
    for (let x = minX + 40; x < maxX - 40; x += 14) for (let z = minZ + 40; z < maxZ - 40; z += 14) {
      const d = trackDist(x, z);
      if (d < 78) continue;
      const h = terrain.height(x, z) - d * 0.02;
      if (h < best) {
        best = h;
        lake = { x, z, r: Math.min(d - 36, 62), y: terrain.height(x, z) - 0.9 };
      }
    }
  }
  const terrainH = (x: number, z: number): number => {
    const h = terrain.height(x, z);
    if (!lake) return h;
    const d = Math.hypot(x - lake.x, z - lake.z);
    if (d > lake.r + 22) return h;
    // 湖底往下挖，岸邊平滑接回原本的地形（只會比原本低，不會把地面墊高）
    const bed = Math.min(h, lake.y - 2.2 * Math.max(0, 1 - (d / lake.r) * (d / lake.r)));
    const t = Math.min(1, Math.max(0, (d - lake.r) / 22));
    return bed + (h - bed) * t * t * (3 - 2 * t);
  };
  const inLake = (x: number, z: number, margin: number) => !!lake && Math.hypot(x - lake.x, z - lake.z) < lake.r + margin;

  const grassTex = canvasTex(128, 128, (c) => {
    c.fillStyle = theme.ground[0];
    c.fillRect(0, 0, 128, 128);
    const r = mulberry32(7);
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = r() > 0.5 ? theme.ground[1] : theme.ground[2];
      c.fillRect(r() * 128, r() * 128, 1 + r() * 3, 1 + r() * 3);
    }
  });
  const M = 270, STEP = lowDetail ? 12 : 8;
  const gx0 = minX - M, gz0 = minZ - M;
  const gnx = Math.ceil((maxX - minX + 2 * M) / STEP), gnz = Math.ceil((maxZ - minZ + 2 * M) / STEP);
  {
    const pos = new Float32Array((gnx + 1) * (gnz + 1) * 3);
    const uv = new Float32Array((gnx + 1) * (gnz + 1) * 2);
    const col = new Float32Array((gnx + 1) * (gnz + 1) * 3);
    const idx: number[] = [];
    const lo = theme.groundLow, hi = theme.groundHigh;
    let p = 0;
    for (let j = 0; j <= gnz; j++) for (let i = 0; i <= gnx; i++) {
      const x = gx0 + i * STEP, z = gz0 + j * STEP;
      const y = terrainH(x, z);
      pos.set([x, y, z], p * 3);
      uv.set([x / 7, z / 7], p * 2);
      // 依高度在兩種色調之間漸變，再加一點隨機斑駁
      const hN = Math.min(1, Math.max(0, (y - baseY) / 26));
      const v = 0.9 + rng() * 0.2;
      col.set([v * (lo[0] + (hi[0] - lo[0]) * hN), v * (lo[1] + (hi[1] - lo[1]) * hN), v * (lo[2] + (hi[2] - lo[2]) * hN)], p * 3);
      p++;
    }
    for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) {
      const a = j * (gnx + 1) + i, b = a + 1, d = a + gnx + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const terrainMat = new THREE.MeshLambertMaterial({ map: grassTex, vertexColors: true });
    if (detail) applyTerrainDetail(g, terrainMat, theme);
    addMesh(g, terrainMat);
    // 遠方的平地：高度是 baseY，一定低於賽道最低點
    const farTex = grassTex.clone();
    farTex.repeat.set(500, 500);
    const farPlane = new THREE.Mesh(new THREE.PlaneGeometry(4400, 4400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: farTex, color: theme.farGround }));
    farPlane.position.set(cx, baseY - 0.2, cz);
    root.add(farPlane);
  }

  if (lake) {
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(lake.r + 6, 40).rotateX(-Math.PI / 2),
      new THREE.MeshPhongMaterial({ color: theme.lakeColor, transparent: true, opacity: night ? 0.92 : 0.82, shininess: 120, specular: night ? 0x8fb0ff : 0xfff0d0 }),
    );
    water.position.set(lake.x, lake.y, lake.z);
    root.add(water);
  }

  // ---------- 路面 ----------
  const roadTex = canvasTex(512, 512, (c) => {
    c.fillStyle = theme.road;
    c.fillRect(0, 0, 512, 512);
    const r = mulberry32(3);
    for (let i = 0; i < 9000; i++) {
      const v = theme.roadSpeck + r() * 50;
      c.fillStyle = `rgba(${v},${v},${v + 8},0.3)`;
      c.fillRect(r() * 512, r() * 512, 2, 2);
    }
    // 輪胎磨出的深色帶
    for (const x of [150, 362]) {
      const g = c.createLinearGradient(x - 46, 0, x + 46, 0);
      g.addColorStop(0, 'rgba(20,20,24,0)');
      g.addColorStop(0.5, 'rgba(20,20,24,0.24)');
      g.addColorStop(1, 'rgba(20,20,24,0)');
      c.fillStyle = g;
      c.fillRect(x - 46, 0, 92, 512);
    }
    // 裂縫，讓路面不那麼單調
    c.strokeStyle = 'rgba(15,15,18,0.35)';
    c.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      let x = r() * 512, y = r() * 512;
      c.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 70; y += r() * 50; c.lineTo(x, y); }
      c.stroke();
    }
    c.fillStyle = '#f3f3f3';
    c.fillRect(14, 0, 7, 512);
    c.fillRect(491, 0, 7, 512);
    c.fillStyle = '#ffd94a';
    c.fillRect(252, 0, 8, 250);
  });
  addMesh(strip(track, { latA: hw, yA: 0.02, latB: -hw, yB: 0.02, scale: 12 }), detail ? roadDetailMaterial(roadTex, theme, hw * 2) : new THREE.MeshLambertMaterial({ map: roadTex }));

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

  // 夜晚：路面兩側的霓虹燈條
  if (night) {
    const neonL = new THREE.MeshBasicMaterial({ color: glow(0x22e6ff, 1.9) });
    const neonR = new THREE.MeshBasicMaterial({ color: glow(0xff3d9a, 1.9) });
    addMesh(strip(track, { latA: hw - 0.1, yA: 0.06, latB: hw - 0.45, yB: 0.06, scale: 10 }), neonL, false);
    addMesh(strip(track, { latA: -(hw - 0.45), yA: 0.06, latB: -(hw - 0.1), yB: 0.06, scale: 10 }), neonR, false);
  }

  // ---------- 護欄（彩色積木風） ----------
  const wallTex = canvasTex(256, 64, (c) => {
    theme.walls.forEach((col, i) => {
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
  // 夜晚的護欄自己會發光（不受光照影響），白天用一般材質
  const wallMat: THREE.Material = night
    ? new THREE.MeshBasicMaterial({ map: wallTex, side: THREE.DoubleSide, color: glow(0xffffff, 0.8) })
    : new THREE.MeshLambertMaterial({ map: wallTex, side: THREE.DoubleSide });
  const capMat: THREE.Material = night ? new THREE.MeshBasicMaterial({ color: glow(0xffffff, 0.9) }) : new THREE.MeshLambertMaterial({ color: 0xf4f4f4 });
  const WH = 1.5;
  // 捷徑經過的地方，主線護欄要留缺口（和車輛碰撞的判定一致）
  const BR = track.branches;
  const inBranch = (x: number, z: number, margin: number): boolean => {
    for (const b of BR) {
      if (!b.inBox(x, z)) continue;
      b.locate(x, z);
      if (b.inside() && Math.abs(b.lat) < b.halfWidth + margin) return true;
    }
    return false;
  };
  const gap = { 1: [] as boolean[], [-1]: [] as boolean[] } as Record<number, boolean[]>;
  // 電車平交道：兩側護欄開口讓電車進出（車輛一樣出不去）
  const trams = (track.def.hazards ?? []).filter((h) => h.kind === 'tram');
  for (let i = 0; i < n; i++) {
    const s = S[i];
    const tramGap = trams.some((h) => Math.abs(relDist(s, h.dist)) < TRAM.width * 2 + 0.6);
    // 軟邊界：有緩衝區的路段不放彩色護欄（外圍屏障在 runoff.ts）
    for (const sg of [1, -1]) gap[sg].push(tramGap || track.runoffW(i, sg) > 0 || (BR.length > 0 && inBranch(s.x + s.nx * sg * (hw + 0.6), s.z + s.nz * sg * (hw + 0.6), -0.4)));
  }
  const wallOn = (sg: number) => (_s: Sample, i: number) => !gap[sg][i];
  for (const sg of [1, -1]) {
    const inner = sg * (hw + 0.35), outer = sg * (hw + 0.95);
    const when = wallOn(sg);
    const wIn = addMesh(strip(track, { latA: inner, yA: WH, latB: inner, yB: -0.4, scale: 12, uAlong: true, when }), wallMat);
    const wOut = addMesh(strip(track, { latA: outer, yA: WH, latB: outer, yB: -0.6, scale: 12, uAlong: true, when }), wallMat);
    wIn.castShadow = wOut.castShadow = shadows;
    addMesh(strip(track, sg > 0 ? { latA: outer, yA: WH, latB: inner, yB: WH, scale: 10, when } : { latA: inner, yA: WH, latB: outer, yB: WH, scale: 10, when }), capMat, !night);
  }

  // ---------- 捷徑：較窄的小路，有自己的護欄與路肩 ----------
  if (BR.length) {
    const dirt = night ? theme.road : theme.vegetation === 'desert' ? '#b98f5e' : '#9a7a52';
    const scTex = canvasTex(256, 256, (c) => {
      c.fillStyle = dirt;
      c.fillRect(0, 0, 256, 256);
      const r = mulberry32(5);
      for (let i = 0; i < 3000; i++) {
        const v = r();
        c.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)';
        c.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1 + r() * 3);
      }
      // 兩條車轍
      for (const x of [70, 186]) {
        const g = c.createLinearGradient(x - 22, 0, x + 22, 0);
        g.addColorStop(0, 'rgba(30,20,10,0)');
        g.addColorStop(0.5, 'rgba(30,20,10,0.28)');
        g.addColorStop(1, 'rgba(30,20,10,0)');
        c.fillStyle = g;
        c.fillRect(x - 22, 0, 44, 256);
      }
      // 黃黑警示邊線
      for (const x of [0, 248]) for (let y = 0; y < 256; y += 32) {
        c.fillStyle = '#ffd23f';
        c.fillRect(x, y, 8, 16);
        c.fillStyle = '#1a1a1a';
        c.fillRect(x, y + 16, 8, 16);
      }
    });
    const scMat = new THREE.MeshLambertMaterial({ map: scTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // 鋪好的窄路（沒有碎石的捷徑）：深色柏油，兩側紅白路緣（沒護欄的路要看得出邊在哪）
    const pavedTex = canvasTex(256, 256, (c) => {
      c.fillStyle = night ? '#2a2f3d' : '#4a4d55';
      c.fillRect(0, 0, 256, 256);
      const r = mulberry32(9);
      for (let i = 0; i < 2500; i++) {
        c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.07)';
        c.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
      }
      c.fillStyle = 'rgba(255,255,255,0.75)';
      for (let y = 0; y < 256; y += 64) c.fillRect(124, y + 8, 8, 32);
      for (const x of [0, 240]) for (let y = 0; y < 256; y += 32) {
        c.fillStyle = '#e8402f';
        c.fillRect(x, y, 16, 16);
        c.fillStyle = '#f4f4f4';
        c.fillRect(x, y + 16, 16, 16);
      }
    });
    const pavedMat = new THREE.MeshLambertMaterial({ map: pavedTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // 懸崖的岩壁
    const cliffMat = new THREE.MeshLambertMaterial({ color: theme.vegetation === 'desert' ? 0x8a4b2c : night ? 0x2b2f3a : 0x5c5348, side: THREE.DoubleSide });
    // 障礙物：依主題換成石頭、樹或施工桶
    const rockMat = new THREE.MeshLambertMaterial({ color: theme.vegetation === 'desert' ? 0xa0583a : 0x7d7468, flatShading: true });
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
    const leafMat = new THREE.MeshLambertMaterial({ color: 0x3f8a3a, flatShading: true });
    const barrelTex = canvasTex(64, 64, (c) => {
      for (let y = 0; y < 64; y += 16) {
        c.fillStyle = '#ff6a1a';
        c.fillRect(0, y, 64, 9);
        c.fillStyle = '#f6f6f6';
        c.fillRect(0, y + 9, 64, 7);
      }
    });
    const barrelMat = night
      ? new THREE.MeshBasicMaterial({ map: barrelTex, color: glow(0xffffff, 1.3) })
      : new THREE.MeshLambertMaterial({ map: barrelTex });
    const makePost = (r: number): THREE.Object3D => {
      const g = new THREE.Group();
      if (theme.vegetation === 'desert') {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 1.05, 0), rockMat);
        rock.scale.set(1, 1.15, 1);
        rock.position.y = r * 0.8;
        rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        rock.castShadow = shadows;
        g.add(rock);
      } else if (night) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.9, 1.25, 14), barrelMat);
        bar.position.y = 0.62;
        g.add(bar);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.08, 14), new THREE.MeshBasicMaterial({ color: glow(0xffd23f, 1.8) }));
        top.position.y = 1.27;
        g.add(top);
      } else {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.38, r * 0.5, 3.2, 8), trunkMat);
        trunk.position.y = 1.6;
        trunk.castShadow = shadows;
        g.add(trunk);
        for (const [y, sc] of [[3.4, 1.9], [4.6, 1.45], [5.6, 0.95]] as [number, number][]) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(r * sc, 1.9, 8), leafMat);
          cone.position.y = y;
          cone.castShadow = shadows;
          g.add(cone);
        }
      }
      return g;
    };
    const mainLat = (x: number, z: number) => { track.locate(x, z, -1); return Math.abs(track.lat); };
    for (const b of BR) {
      const hb = b.halfWidth;
      const fall = b.def.edge === 'fall';
      const outFlag = b.samples.map((s) => mainLat(s.x, s.z) > hw - hb + 0.3);
      // 碎石、泥地用泥土路面；其他是鋪好的窄柏油路
      addMesh(strip(b, { latA: hb, yA: 0.03, latB: -hb, yB: 0.03, scale: 9, when: (_s, i) => outFlag[i] }), b.def.rough ? scMat : pavedMat);
      // 障礙物
      for (const p of b.posts) {
        const o = makePost(p.r);
        o.position.set(p.x, p.y, p.z);
        root.add(o);
      }
      if (fall) {
        // 沒有護欄：兩側是往下掉的岩壁（地形在這裡也往下挖）
        for (const sg of [1, -1]) {
          const when = (_s: Sample, i: number) => outFlag[i];
          addMesh(strip(b, sg > 0 ? { latA: hb + 0.05, yA: 0.02, latB: hb + 1.2, yB: -12, scale: 6, when } : { latA: -(hb + 1.2), yA: -12, latB: -(hb + 0.05), yB: 0.02, scale: 6, when }), cliffMat);
          if (night) {
            const edgeGlow = new THREE.MeshBasicMaterial({ color: glow(0xff4f5e, 1.8) });
            addMesh(strip(b, sg > 0 ? { latA: hb, yA: 0.06, latB: hb - 0.25, yB: 0.06, scale: 10, when } : { latA: -(hb - 0.25), yA: 0.06, latB: -hb, yB: 0.06, scale: 10, when }), edgeGlow, false);
          }
        }
      }
      if (!fall) for (const sg of [1, -1]) {
        const wallFlag = b.samples.map((s) => mainLat(s.x + s.nx * sg * (hb + 0.6), s.z + s.nz * sg * (hb + 0.6)) > hw + 0.4);
        const when = (_s: Sample, i: number) => wallFlag[i];
        const inner = sg * (hb + 0.35), outer = sg * (hb + 0.95);
        const wIn = addMesh(strip(b, { latA: inner, yA: WH, latB: inner, yB: -0.4, scale: 12, uAlong: true, when }), wallMat);
        const wOut = addMesh(strip(b, { latA: outer, yA: WH, latB: outer, yB: -0.6, scale: 12, uAlong: true, when }), wallMat);
        wIn.castShadow = wOut.castShadow = shadows;
        addMesh(strip(b, sg > 0 ? { latA: outer, yA: WH, latB: inner, yB: WH, scale: 10, when } : { latA: inner, yA: WH, latB: outer, yB: WH, scale: 10, when }), capMat, !night);
        if (night) {
          const neon = new THREE.MeshBasicMaterial({ color: glow(sg > 0 ? 0x39ffb0 : 0xffe14d, 1.9) });
          addMesh(strip(b, sg > 0 ? { latA: hb - 0.1, yA: 0.07, latB: hb - 0.45, yB: 0.07, scale: 10, when } : { latA: -(hb - 0.45), yA: 0.07, latB: -(hb - 0.1), yB: 0.07, scale: 10, when }), neon, false);
        }
      }
      if (!fall) {
        const shMat = new THREE.MeshLambertMaterial({ map: grassTex, color: theme.shoulder });
        addMesh(strip(b, { latA: hb + 9, yA: -3.2, latB: hb + 0.95, yB: -0.02, scale: 7 }), shMat);
        addMesh(strip(b, { latA: -(hb + 0.95), yA: -0.02, latB: -(hb + 9), yB: -3.2, scale: 7 }), shMat);
      }
      // 入口的指示牌：在主線上快到分岔點時就看得到
      const arrowSide = Math.sign(b.def.lat) || 1;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), new THREE.MeshBasicMaterial({ map: canvasTex(128, 64, (c) => {
        c.fillStyle = '#15161a';
        c.fillRect(0, 0, 128, 64);
        c.fillStyle = '#ffd23f';
        c.font = 'bold 26px "Segoe UI", Arial, sans-serif';
        c.textAlign = 'center';
        const label = b.def.name ?? '捷徑';
        c.font = `bold ${label.length > 3 ? 20 : 26}px "Segoe UI", Arial, sans-serif`;
        c.fillText(arrowSide > 0 ? '◀ ' + label : label + ' ▶', 64, 42);
      }, false), color: glow(0xffffff, night ? 1.6 : 1.15), side: THREE.DoubleSide }));
      const sp = track.pointAt(b.def.from - 25);
      // 有緩衝區的話立在屏障後面（不要擋在可以開的沙地上）
      const signLat = hw + 2.4 + track.runoffW(track.wrap(Math.round(wrapD(b.def.from - 25) / track.spacing)), arrowSide);
      const ox = sp.nx * arrowSide * signLat, oz = sp.nz * arrowSide * signLat;
      sign.position.set(sp.x + ox, sp.y + 3.4, sp.z + oz);
      sign.rotation.y = Math.atan2(sp.tx, sp.tz) + Math.PI;
      root.add(sign);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.4, 0.25), new THREE.MeshLambertMaterial({ color: 0x3a3d45 }));
      post.position.set(sp.x + ox, sp.y + 1.7 - 0.6, sp.z + oz);
      root.add(post);
    }
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
  const arrowMat = new THREE.MeshBasicMaterial({ map: arrowTex, side: THREE.DoubleSide, color: glow(0xffffff, night ? 1.7 : 1.25) });
  for (const sg of [1, -1]) {
    // 左彎（curv > 0）的外側在右邊（lat < 0），反之亦然
    const when = (s: Sample, i: number) => {
      const a = S[(i + 6) % n].curv, b = S[(i - 6 + n) % n].curv;
      return s.curv * sg < -0.02 && a * sg < -0.014 && b * sg < -0.014 && !gap[sg][i];
    };
    const lat = sg * (hw + 0.4);
    addMesh(strip(track, { latA: lat, yA: WH + 2.1, latB: lat, yB: WH + 0.15, scale: 4, uAlong: true, when }), arrowMat, false);
  }

  // ---------- 路肩（從護欄外側往下接到地面） ----------
  const shoulderMat = new THREE.MeshLambertMaterial({ map: grassTex, color: theme.shoulder });
  if (track.hasRunoff) {
    // 軟邊界：砂石緩衝區、路緣石、岩石／輪胎牆、懸崖，路肩也改從屏障外側開始鋪
    buildRunoff(track, theme, root, shoulderMat, shadows, lowDetail);
  } else {
    addMesh(strip(track, { latA: hw + 9, yA: -3.2, latB: hw + 0.95, yB: -0.02, scale: 7 }), shoulderMat);
    addMesh(strip(track, { latA: -(hw + 0.95), yA: -0.02, latB: -(hw + 9), yB: -3.2, scale: 7 }), shoulderMat);
  }

  // ---------- 加速帶 ----------
  const chevrons = (bg: string) => (c: CanvasRenderingContext2D) => {
    c.fillStyle = bg;
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
  };
  const padTex = canvasTex(64, 64, chevrons('#1b1d25'));
  const padMat = new THREE.MeshBasicMaterial({ map: padTex, color: glow(0xffffff, night ? 2.2 : 1.7) });
  for (const p of track.pads) {
    const geo = strip(track, {
      latA: p.lat + PAD_HALF_WIDTH, yA: 0.045, latB: p.lat - PAD_HALF_WIDTH, yB: 0.045, scale: 1,
      when: (s) => Math.abs(relDist(s, p.dist)) <= PAD_LENGTH / 2 + track.spacing,
      along: (s) => relDist(s, p.dist) / (PAD_LENGTH / 2),
    });
    addMesh(geo, padMat, false);
  }
  updaters.push((_dt, time) => { padTex.offset.y = -(time * 1.6) % 1; });

  // ---------- 跳台：整條路寬的斜坡 ----------
  const rampTex = canvasTex(64, 64, chevrons('#2a2f3c'));
  const rampMat: THREE.Material = night ? new THREE.MeshBasicMaterial({ map: rampTex, color: glow(0xffffff, 1.4) }) : new THREE.MeshLambertMaterial({ map: rampTex });
  const rampSide = new THREE.MeshLambertMaterial({ color: 0xff7a1a, side: THREE.DoubleSide });
  const RL = CFG.rampLength, RH = CFG.rampHeight;
  for (const r of track.ramps) {
    const on = (s: Sample) => { const d = relDist(s, r); return d >= -RL - track.spacing && d <= track.spacing * 0.5; };
    const lift = (s: Sample) => Math.min(RH, Math.max(0, ((relDist(s, r) + RL) / RL) * RH));
    const w = hw - 0.3;
    const top = addMesh(strip(track, { latA: w, yA: 0.03, latB: -w, yB: 0.03, scale: 1, when: on, lift, along: (s) => relDist(s, r) / 3.5 }), rampMat);
    top.castShadow = shadows;
    for (const sg of [1, -1]) {
      addMesh(strip(track, { latA: sg * w, yA: 0.03, latB: sg * w, yB: 0, scale: 4, uAlong: true, when: on, lift, liftB: false }), rampSide);
    }
    const s = sampleAt(r);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, RH), rampSide);
    back.position.set(s.x + s.tx * 0.6, s.y + RH / 2, s.z + s.tz * 0.6);
    back.rotation.y = Math.atan2(s.tx, s.tz);
    root.add(back);
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
  line.receiveShadow = shadows;
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
  const bannerMat: THREE.Material = night ? new THREE.MeshBasicMaterial({ map: banner, color: glow(0xffffff, 1.6) }) : new THREE.MeshLambertMaterial({ map: banner });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 4.5, 3, 0.9), [postMat, postMat, postMat, postMat, bannerMat, bannerMat]);
  beam.position.y = 9.5;
  beam.castShadow = shadows;
  arch.add(beam);
  root.add(arch);

  // ---------- 沿賽道擺放的模型 ----------
  const props = new THREE.Group();
  root.add(props);
  const stands: THREE.Group[] = [];
  /** ro：燈柱因為路邊的緩衝區往外移了多少 */
  const lamps: { s: Sample; sg: number; ro: number }[] = [];
  /** 軟邊界：半徑 r 的景物會不會擺進路邊的緩衝區或外圍屏障裡（懸崖外面也不放） */
  const roClear = (x: number, z: number, r: number): boolean => {
    if (!track.hasRunoff || trackDist(x, z) - r > hw + 30) return true;
    const i = track.locate(x, z, -1);
    const sg = Math.sign(track.lat);
    if (track.cliffAt(i, sg)) return false;
    return Math.abs(track.lat) - r > track.edgeLat(i, sg) + (track.runoffW(i, sg) > 0 ? 3 : 0);
  };
  interface PlaceOpt { yaw?: number; recolor?: Record<string, number>; sink?: number; onRoadLevel?: boolean }
  /** 在距起點 dist 公尺、橫向 lat 處放一個模型，預設正面朝向賽道 */
  const place = (name: string, dist: number, lat: number, width: number, o: PlaceOpt = {}): THREE.Group | null => {
    const s = sampleAt(dist);
    // 軟邊界：路邊的景物往外移到緩衝區外面（貼著路面高度的燈柱、旗子放在屏障後面）；懸崖那一側不放
    let ro = 0;
    if (track.hasRunoff && Math.abs(lat) > hw) {
      const sg = Math.sign(lat);
      for (let d = -width / 2; d <= width / 2 + 0.01; d += track.spacing) {
        const i = track.wrap(Math.round(wrapD(dist + d) / track.spacing));
        if (track.cliffAt(i, sg)) return null;
        ro = Math.max(ro, track.runoffW(i, sg));
      }
      if (ro > 0) lat += sg * (ro + (o.onRoadLevel ? 0 : 3));
    }
    const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
    // 往外移之後壓到別段路的緩衝區（燈柱本來就立在屏障後面，只要在緩衝區外緣外面就好）
    if (ro > 0 && !roClear(x, z, o.onRoadLevel ? -3 : 0.5)) return null;
    if (Math.abs(lat) > hw + 2 && trackDist(x, z) < Math.min(Math.abs(lat) - 1.5, hw + 5)) return null; // 會壓到別段賽道
    if (inLake(x, z, 12)) return null;
    const g = makeProp(name, width, o.recolor);
    if (!g) return null;
    const y = o.onRoadLevel ? s.y : terrainH(x, z);
    g.position.set(x, y - (o.sink ?? 0), z);
    // 模型的 +Z 朝向賽道中心，再加上各模型自己的修正角
    g.rotation.y = Math.atan2(-s.nx * Math.sign(lat || 1), -s.nz * Math.sign(lat || 1)) + (o.yaw ?? 0);
    if (shadows) g.traverse((m) => { m.castShadow = true; });
    props.add(g);
    if (name.startsWith('grandStand')) stands.push(g);
    g.userData.ro = ro;
    return g;
  };
  const far = hw + 15;
  const ACC = theme.accents;
  const sides = (r: SceneRange) => (r.side === 0 ? [1, -1] : [r.side]);
  const scn = track.def.scenery;

  // 看台
  for (const r of scn.stands) {
    let i = 0;
    for (let d = r.from; d <= r.to; d += 17, i++) {
      for (const sg of sides(r)) place(i % 2 === 0 ? 'grandStandCovered' : i % 4 === 1 ? 'grandStandAwning' : 'grandStand', d, sg * (far + 2.5), 16, { sink: 0.35 });
    }
  }
  // 維修站
  for (const r of scn.pits) {
    for (const sg of sides(r)) {
      for (let d = r.from; d <= r.to - 16; d += 15) place('pitsGarage', d, sg * (far + 1), 14, { sink: 0.3 });
      place('pitsOffice', r.to, sg * (far + 1), 14, { sink: 0.3 });
      place('pitsOffice', r.from - 16, sg * (far + 1), 14, { sink: 0.3 });
      for (const d of [r.from - 40, r.from - 64, r.to + 26]) place('tentLong', d, sg * (far + 1), 20, { recolor: { red: ACC[1] }, sink: 0.2 });
    }
  }
  // 帳篷市集
  for (const r of scn.tents) {
    let i = 0;
    for (let d = r.from; d <= r.to; d += 24, i++) {
      const sg = r.side === 0 ? (i % 2 ? 1 : -1) : r.side;
      const long = i % 3 === 0;
      place(long ? 'tentLong' : i % 3 === 1 ? 'tent' : 'tentClosed', d, sg * (far + 2), long ? 20 : 11, { recolor: { red: ACC[i % ACC.length], grass: ACC[(i + 2) % ACC.length] }, sink: 0.2 });
    }
  }
  // 起跑線旗子
  for (const lat of [hw + 3.2, -(hw + 3.2)]) {
    place('flagCheckers', 6, lat, 1.6, { onRoadLevel: true });
    place('flagCheckers', L - 6, lat, 1.6, { onRoadLevel: true });
    for (let d = 40; d <= 160; d += 40) place(d % 80 === 40 ? 'flagGreen' : 'flagRed', d, lat, 1.4, { onRoadLevel: true });
  }
  // 整條賽道：直線放路燈，彎道外側放旗塔，隔一段放看板
  const lampStep = night ? 30 : 42;
  for (let d = 200; d < L - 80; d += lampStep) {
    const s = sampleAt(d);
    const out = s.curv > 0 ? -1 : 1; // 彎道外側
    const zone = Math.floor(d / 300) % 4;
    if (Math.abs(s.curv) < 0.01) {
      for (const [dd, sg] of [[0, 1], [lampStep / 2, -1]] as [number, number][]) {
        const g = place('lightPostLarge', d + dd, sg * (hw + 3.4), 5.5, { onRoadLevel: true, sink: 0.3 });
        if (g) lamps.push({ s: sampleAt(d + dd), sg, ro: g.userData.ro });
      }
    } else {
      place(zone % 2 ? 'bannerTowerRed' : 'bannerTowerGreen', d, out * (hw + 5), 5, { sink: 0.6 });
      const g = night ? place('lightPostLarge', d, out * (hw + 3.4), 5.5, { onRoadLevel: true, sink: 0.3 }) : null;
      if (g) lamps.push({ s, sg: out, ro: g.userData.ro });
    }
    if (Math.floor(d / lampStep) % 3 === 0) place(zone % 2 ? 'billboard' : 'billboardLow', d + 10, out * (far - 2), 13, { sink: 0.3 });
  }
  // 跳台旁：兩側看台與旗子
  for (const r of track.ramps) {
    for (const sg of [1, -1]) for (const dd of [-4, 14]) place('grandStand', r + dd, sg * (far + 3), 16, { sink: 0.4 });
    for (const sg of [1, -1]) place('flagCheckers', r, sg * (hw + 3.2), 1.6, { onRoadLevel: true });
  }
  // 橫跨路面的拱門
  for (const d of scn.arches) {
    const g = place('overheadRoundColored', d, 0, hw * 2 + 9, { onRoadLevel: true, sink: 0.2, recolor: { red: ACC[Math.round(d) % ACC.length] } });
    if (g) g.rotation.y = Math.atan2(sampleAt(d).tx, sampleAt(d).tz);
  }

  // ---------- 夜晚：路燈的燈泡與照在路面上的光暈 ----------
  if (night && lamps.length) {
    const bulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: glow(0xffe2a8, 3) }), lamps.length);
    const poolTex = canvasTex(64, 64, (c) => {
      const g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,226,170,0.55)');
      g.addColorStop(1, 'rgba(255,226,170,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    }, false);
    const pool = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(26, 26).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      lamps.length,
    );
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const upv = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
    lamps.forEach((l, i) => {
      const s = l.s;
      m.makeTranslation(s.x + s.nx * l.sg * (hw + 2.1 + l.ro), s.y + 10.3, s.z + s.nz * l.sg * (hw + 2.1 + l.ro));
      bulb.setMatrixAt(i, m);
      // 光暈貼著路面的坡度
      nrm.set(-s.tx * s.slope, 1, -s.tz * s.slope).normalize();
      q.setFromUnitVectors(upv, nrm);
      m.compose(p.set(s.x + s.nx * l.sg * (hw - 5), s.y + 0.07, s.z + s.nz * l.sg * (hw - 5)), q, one);
      pool.setMatrixAt(i, m);
    });
    bulb.frustumCulled = pool.frustumCulled = false;
    pool.renderOrder = 4;
    root.add(bulb, pool);
  }

  // ---------- 看台上的觀眾（會上下跳動加油） ----------
  // 座位排的位置是從看台模型量出來的（模型座標：寬 1、前緣 z=0、往後往上）
  const ROWS: [number, number][] = [[0.25, -0.07], [0.28, -0.135], [0.34, -0.2], [0.4, -0.265], [0.46, -0.33], [0.52, -0.395], [0.57, -0.46], [0.63, -0.55]];
  const crowdM: THREE.Matrix4[] = [];
  const crowdC: number[] = [];
  const fanCols = [0xff5d8f, 0xffd23f, 0x3bceac, 0x4d9de0, 0xff7a1a, 0xffffff, 0xb05cff, 0x2f3542, 0xe8545a];
  const tmpC = new THREE.Color();
  const pm = new THREE.Matrix4(), lm = new THREE.Matrix4(), q0 = new THREE.Quaternion(), v0 = new THREE.Vector3(), one0 = new THREE.Vector3(1, 1, 1);
  const occupancy = lowDetail ? 0.3 : 0.62;
  for (const st of stands) {
    st.updateMatrixWorld(true);
    pm.copy(st.matrixWorld);
    for (const [ry, rz] of ROWS) {
      for (let x = 0.08; x <= 0.92; x += 0.042) {
        if (rng() > occupancy) continue;
        const s = 0.85 + rng() * 0.35;
        lm.compose(v0.set((x - 0.5) * 16, ry * 16 + 0.55 * s, (rz + 0.5) * 16), q0, one0.set(s, s, s));
        crowdM.push(new THREE.Matrix4().multiplyMatrices(pm, lm));
        tmpC.setHex(fanCols[Math.floor(rng() * fanCols.length)]);
        crowdC.push(tmpC.r, tmpC.g, tmpC.b);
      }
    }
  }
  if (crowdM.length) {
    const crowdTime = { value: 0 };
    // 小人的幾何：身體（衣服色）、頭與手臂（膚色）、頭髮（髮色）；part 決定用哪個顏色，arm 標記左右手
    const piece = (g: THREE.BufferGeometry, part: number, arm: number) => {
      const ng = g.index ? g.toNonIndexed() : g;
      const n = ng.attributes.position.count;
      ng.setAttribute('part', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
      ng.setAttribute('arm', new THREE.BufferAttribute(new Float32Array(n).fill(arm), 1));
      ng.deleteAttribute('uv');
      return ng;
    };
    const fan = mergeGeometries([
      piece(new THREE.BoxGeometry(0.5, 0.56, 0.34).translate(0, -0.25, 0), 0, 0),
      piece(new THREE.IcosahedronGeometry(0.25, 0).translate(0, 0.3, 0), 1, 0),
      piece(new THREE.BoxGeometry(0.5, 0.15, 0.46).translate(0, 0.49, -0.02), 2, 0),
      piece(new THREE.BoxGeometry(0.46, 0.26, 0.12).translate(0, 0.36, -0.2), 2, 0),
      piece(new THREE.BoxGeometry(0.11, 0.42, 0.11).translate(0.29, 0.21, 0), 1, 1),
      piece(new THREE.BoxGeometry(0.11, 0.42, 0.11).translate(-0.29, 0.21, 0), 1, -1),
    ])!;
    const skins = [0xf2c9a0, 0xe0ac7e, 0xc68642, 0x8d5524, 0xffdbb8];
    const hairs = [0x2b1d14, 0x5a3a22, 0xd9b24a, 0x1a1a1a, 0xb03a2e, 0x7a7f88, 0x3a5fc4, 0xf2f2f2];
    const aSkin = new Float32Array(crowdM.length * 3), aHair = new Float32Array(crowdM.length * 3);
    for (let i = 0; i < crowdM.length; i++) {
      tmpC.setHex(skins[Math.floor(rng() * skins.length)]);
      aSkin.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      tmpC.setHex(hairs[Math.floor(rng() * hairs.length)]);
      aHair.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    }
    fan.setAttribute('aSkin', new THREE.InstancedBufferAttribute(aSkin, 3));
    fan.setAttribute('aHair', new THREE.InstancedBufferAttribute(aHair, 3));
    const mat = new THREE.MeshLambertMaterial();
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = crowdTime;
      sh.vertexShader = 'uniform float uTime;\nattribute float part;\nattribute float arm;\nattribute vec3 aSkin;\nattribute vec3 aHair;\n' + sh.vertexShader
        .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = part < 0.5 ? instanceColor.xyz : ( part < 1.5 ? aSkin : aHair );
        #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          // 每個人依自己的位置有不同的節奏，偶爾大家一起跳起來揮手
          float ph = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z * 2.3;
          float cheer = step(0.2, sin(uTime * 0.9 + ph * 0.13));
          if (abs(arm) > 0.5) {
            vec3 pv = vec3(arm * 0.29, 0.0, 0.0);
            float a = -arm * (0.2 + (0.3 + 0.45 * sin(uTime * 9.0 + ph)) * (0.25 + 0.75 * cheer));
            vec3 q = transformed - pv;
            transformed = pv + vec3(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a), q.z);
          }
          transformed.y += max(0.0, sin(uTime * 7.0 + ph)) * 0.3 * cheer;
        #endif`);
    };
    const crowd = new THREE.InstancedMesh(fan, mat, crowdM.length);
    crowdM.forEach((m, i) => {
      crowd.setMatrixAt(i, m);
      crowd.setColorAt(i, tmpC.setRGB(crowdC[i * 3], crowdC[i * 3 + 1], crowdC[i * 3 + 2]));
    });
    crowd.frustumCulled = false;
    root.add(crowd);
    updaters.push((_dt, time) => { crowdTime.value = time; });
  }

  // 賽博龐克大樓：招牌與螢幕在夜裡發光（貼圖越亮、越鮮豔的地方越亮）
  const glowMats = new Map<THREE.Material, THREE.Material>();
  const neon = (m: THREE.Material): THREE.Material => {
    let out = glowMats.get(m);
    if (!out) {
      const c = (m as THREE.MeshLambertMaterial).clone();
      c.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          #ifdef USE_MAP
            vec3 tcol = texture2D( map, vMapUv ).rgb;
            float hi = max( max( tcol.r, tcol.g ), tcol.b );
            float sat = hi - min( min( tcol.r, tcol.g ), tcol.b );
            totalEmissiveRadiance += tcol * ( 0.18 + 2.4 * smoothstep( 0.35, 0.8, hi ) * smoothstep( 0.12, 0.35, sat ) );
          #endif`,
        );
      };
      glowMats.set(m, (out = c));
    }
    return out;
  };
  // ---------- Tripo 地標：草原的風車、夜城的大樓 ----------
  /** 在賽道某處的側邊找一塊放得下 radius 大小地標的空地，正面朝向賽道 */
  const spotFor = (dist: number, side: number, radius: number, lats: number[]): { x: number; z: number; yaw: number } | null => {
    const s = sampleAt(dist);
    for (const lat of lats) {
      const x = s.x + s.nx * side * lat, z = s.z + s.nz * side * lat;
      if (trackDist(x, z) < radius + hw + 4 || inLake(x, z, radius + 4) || !roClear(x, z, radius)) continue;
      let clash = false;
      for (const pr of props.children) {
        const r = (pr.userData.radius ?? 6) + radius;
        if ((pr.position.x - x) ** 2 + (pr.position.z - z) ** 2 < r * r) { clash = true; break; }
      }
      if (clash) continue;
      return { x, z, yaw: Math.atan2(-s.nx * side, -s.nz * side) };
    }
    return null;
  };
  if (theme.id === 'meadow') {
    // 風車：塔身與扇葉是兩個模型，扇葉裝在屋頂前方的轉軸上、會轉
    const blades: THREE.Object3D[] = [];
    let k = 0;
    for (const d of [260, 720, 1240, 1560, 2180]) {
      const H = 17 + rng() * 5;
      const tower = makeLandmark('tripo/windmill_tower', H);
      if (!tower) break;
      const sp = spotFor(d, k++ % 2 ? 1 : -1, H * 0.45, [hw + 22, hw + 32, hw + 45, hw + 60]);
      if (!sp) continue;
      tower.position.set(sp.x, terrainH(sp.x, sp.z) - 0.4, sp.z);
      tower.rotation.y = sp.yaw + (rng() - 0.5) * 0.5;
      tower.userData.radius = H * 0.4;
      const bl = makeLandmark('tripo/windmill_blades', H * 0.8);
      if (bl) {
        const hub = new THREE.Group();
        hub.position.set(0, H * 0.87, H * 0.36);
        bl.position.y = -H * 0.4;
        hub.add(bl);
        hub.rotation.z = rng() * 6;
        tower.add(hub);
        blades.push(hub);
      }
      if (shadows) tower.traverse((o) => { o.castShadow = true; });
      props.add(tower);
    }
    if (blades.length) updaters.push((dt) => { for (const b of blades) b.rotation.z += dt * 0.55; });
  } else if (theme.id === 'desert') {
    // 生鏽的水塔
    let k = 0;
    for (const d of [330, 1060, 1640, 1980]) {
      const H = 19 + rng() * 5;
      const t = makeLandmark('tripo/water_tower', H);
      if (!t) break;
      const sp = spotFor(d, k++ % 2 ? 1 : -1, H * 0.3, [hw + 14, hw + 22, hw + 34]);
      if (!sp) continue;
      t.position.set(sp.x, terrainH(sp.x, sp.z) - 0.4, sp.z);
      t.rotation.y = sp.yaw + rng() * 6;
      t.userData.radius = H * 0.28;
      if (shadows) t.traverse((o) => { o.castShadow = true; });
      props.add(t);
    }
  } else if (theme.id === 'city') {
    let k = 0;
    for (const d of [60, 330, 560, 820, 1240, 1420, 1700, 1980]) {
      const name = k % 2 ? 'tripo/city_b' : 'tripo/city_a';
      const H = 58 + rng() * 22;
      const b = makeLandmark(name, H);
      if (!b) break;
      const radius = Math.hypot(b.userData.width, b.userData.depth) * 0.5;
      const sp = spotFor(d, k % 3 === 1 ? 1 : -1, radius, [hw + 4 + radius, hw + 12 + radius, hw + 24 + radius]) ?? spotFor(d, k % 3 === 1 ? -1 : 1, radius, [hw + 4 + radius, hw + 12 + radius, hw + 24 + radius]);
      k++;
      if (!sp) continue;
      b.position.set(sp.x, terrainH(sp.x, sp.z) - 0.5, sp.z);
      b.rotation.y = sp.yaw;
      b.userData.radius = radius;
      b.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(neon) : neon(mesh.material);
        mesh.castShadow = shadows;
      });
      props.add(b);
    }
    // 摩天輪：放在海灣（湖）邊，輪面朝向賽道，慢慢轉
    if (lake) {
      const FS = 44;
      let best: { x: number; z: number; d: number } | null = null;
      for (const ring of [8, 16, 26, 38]) for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
        const x = lake.x + Math.cos(a) * (lake.r + ring), z = lake.z + Math.sin(a) * (lake.r + ring);
        const d = trackDist(x, z);
        if (d < hw + 18 || d > 160) continue;
        if (!best || d < best.d) best = { x, z, d };
      }
      const stand = best && makeLandmark('tripo/ferris_stand', FS * 0.72);
      const wheel = best && makeLandmark('tripo/ferris_wheel', FS);
      if (best && stand && wheel) {
        const g = new THREE.Group();
        g.position.set(best.x, terrainH(best.x, best.z) - 0.5, best.z);
        // 輪面（模型的 XY 平面）朝向最近的賽道
        const si = track.locate(best.x, best.z, -1);
        const s0 = S[si];
        g.rotation.y = Math.atan2(s0.x - best.x, s0.z - best.z);
        g.add(stand);
        const hub = new THREE.Group();
        hub.position.y = FS * 0.72 * 0.86;
        wheel.position.y = -FS / 2;
        hub.add(wheel);
        g.add(hub);
        g.userData.radius = FS * 0.5;
        for (const o of [stand, wheel]) o.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(neon) : neon(mesh.material);
          mesh.castShadow = shadows;
        });
        props.add(g);
        updaters.push((dt) => { hub.rotation.z += dt * 0.08; });
      }
    }
  }

  // ---------- 散布在賽道外的景物（依主題不同） ----------
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const addInst = (g: THREE.Object3D | null, cast = true) => {
    if (!g) return;
    if (shadows && cast) g.traverse((m) => { m.castShadow = true; });
    root.add(g);
  };
  const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], cast = true): THREE.InstancedMesh | null => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.frustumCulled = false;
    addInst(im, cast);
    return im;
  };
  /** 在賽道周圍隨機找位置：minD / maxD 是離賽道中心線的距離範圍，gap 是彼此的最小間距 */
  const scatter = (want: number, minD: number, maxD: number, gap: number, spread = 170): { x: number; z: number; y: number; d: number }[] => {
    const out: { x: number; z: number; y: number; d: number }[] = [];
    for (let tries = 0; tries < want * 30 && out.length < want; tries++) {
      const x = minX - spread + rng() * (maxX - minX + spread * 2);
      const z = minZ - spread + rng() * (maxZ - minZ + spread * 2);
      const d = trackDist(x, z);
      if (d < minD || d > maxD) continue;
      if (inLake(x, z, 9) || !roClear(x, z, 2)) continue;
      let blocked = false;
      for (const pr of props.children) {
        const dx = pr.position.x - x, dz = pr.position.z - z;
        const rr = 13 + (pr.userData.radius ?? 0);
        if (dx * dx + dz * dz < rr * rr) { blocked = true; break; }
      }
      if (!blocked && gap > 0) for (const o of out) {
        const dx = o.x - x, dz = o.z - z;
        if (dx * dx + dz * dz < gap * gap) { blocked = true; break; }
      }
      if (!blocked) out.push({ x, z, y: terrainH(x, z), d });
    }
    return out;
  };
  const matAt = (sp: { x: number; z: number; y: number }, s: number, sy = s, sink = 0.15): THREE.Matrix4 => {
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    return new THREE.Matrix4().compose(v.set(sp.x, sp.y - sink, sp.z), q, sc.set(s, sy, s));
  };

  if (theme.vegetation === 'forest') {
    const spots = scatter(lowDetail ? 380 : 760, hw + 11, 9999, 0).filter((s) => s.d < 60 || rng() < 0.45);
    const lists: THREE.Matrix4[][] = [[], [], [], []];
    spots.forEach((sp, i) => {
      const kind = i % 10 < 5 ? 0 : i % 10 < 8 ? 1 : i % 10 < 9 ? 2 : 3;
      const s = kind < 2 ? 0.75 + rng() * 0.6 : 0.6 + rng() * 0.9;
      lists[kind].push(matAt(sp, s, s * (0.85 + rng() * 0.3)));
    });
    const treeL = makeInstanced('treeLarge', 13, lists[0]);
    const treeS = makeInstanced('treeSmall', 9, lists[1]);
    if (treeL && treeS) {
      addInst(treeL);
      addInst(treeS);
    } else {
      // 模型沒載入時的備用樹
      const all = [...lists[0], ...lists[1]];
      instanced(new THREE.ConeGeometry(2.4, 6.5, 7).translate(0, 5.2, 0), new THREE.MeshLambertMaterial({ color: 0x2f9e58 }), all);
      instanced(new THREE.CylinderGeometry(0.4, 0.5, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshLambertMaterial({ color: 0x8a5a3c }), all);
    }
    instanced(new THREE.IcosahedronGeometry(1.5, 1).scale(1, 0.75, 1).translate(0, 0.8, 0), new THREE.MeshLambertMaterial({ color: 0x3fa35a, flatShading: true }), lists[2]);
    instanced(new THREE.DodecahedronGeometry(1.6, 0).scale(1.2, 0.8, 1).translate(0, 0.7, 0), new THREE.MeshLambertMaterial({ color: 0x9aa0a8, flatShading: true }), lists[3]);
  } else if (theme.vegetation === 'desert') {
    // 仙人掌：主幹加兩隻手臂
    const cactusGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.5, 0.55, 5, 7).translate(0, 2.5, 0),
      new THREE.SphereGeometry(0.5, 7, 5).translate(0, 5, 0),
      new THREE.CylinderGeometry(0.3, 0.3, 1.3, 6).rotateZ(Math.PI / 2).translate(0.9, 2.4, 0),
      new THREE.CylinderGeometry(0.3, 0.32, 1.9, 6).translate(1.5, 3.2, 0),
      new THREE.CylinderGeometry(0.28, 0.28, 1.1, 6).rotateZ(Math.PI / 2).translate(-0.8, 3.1, 0),
      new THREE.CylinderGeometry(0.28, 0.3, 1.4, 6).translate(-1.3, 3.7, 0),
    ]);
    const cacti = scatter(lowDetail ? 110 : 230, hw + 11, 230, 5).map((sp) => matAt(sp, 0.8 + rng() * 0.9));
    instanced(cactusGeo, new THREE.MeshLambertMaterial({ color: 0x4f9d58, flatShading: true }), cacti);
    const shrubs = scatter(lowDetail ? 120 : 280, hw + 10, 260, 0).map((sp) => matAt(sp, 0.6 + rng() * 0.9, 0.5 + rng() * 0.4));
    instanced(new THREE.IcosahedronGeometry(1.3, 0).scale(1, 0.6, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: 0xa3a04f, flatShading: true }), shrubs, false);
    const stones = scatter(lowDetail ? 90 : 200, hw + 10, 260, 0).map((sp) => matAt(sp, 0.6 + rng() * 1.6, 0.5 + rng()));
    instanced(new THREE.DodecahedronGeometry(1.7, 0).scale(1.2, 0.8, 1).translate(0, 0.7, 0), new THREE.MeshLambertMaterial({ color: 0xb4683f, flatShading: true }), stones);
    // 岩柱與平頂岩台：紅色岩層，頂端一層較亮
    const pillars = scatter(lowDetail ? 26 : 54, hw + 26, 210, 30);
    const rockMat = new THREE.MeshLambertMaterial({ color: theme.mountain, flatShading: true });
    const capRock = new THREE.MeshLambertMaterial({ color: theme.mountainCap ?? theme.mountain, flatShading: true });
    const bodyL: THREE.Matrix4[] = [], capL: THREE.Matrix4[] = [];
    for (const sp of pillars) {
      const r = 6 + rng() * 13, h = 14 + rng() * 34;
      if (!roClear(sp.x, sp.z, r)) continue;
      q.setFromAxisAngle(up, rng() * 6);
      bodyL.push(new THREE.Matrix4().compose(v.set(sp.x, sp.y - 2, sp.z), q, sc.set(r, h, r)));
      capL.push(new THREE.Matrix4().compose(v.set(sp.x, sp.y - 2 + h, sp.z), q, sc.set(r * 0.86, 2.2 + rng() * 2, r * 0.86)));
    }
    instanced(new THREE.CylinderGeometry(0.72, 1, 1, 7).translate(0, 0.5, 0), rockMat, bodyL);
    instanced(new THREE.CylinderGeometry(1, 0.9, 1, 7).translate(0, 0.5, 0), capRock, capL);
  } else {
    // 城市：周圍的大樓，窗戶會發亮
    const winTex = canvasTex(64, 96, (c) => {
      c.fillStyle = '#0d111c';
      c.fillRect(0, 0, 64, 96);
      const r = mulberry32(11);
      for (let y = 0; y < 6; y++) for (let x = 0; x < 4; x++) {
        const k = r();
        c.fillStyle = k < 0.42 ? '#161c2b' : k < 0.78 ? '#ffd98a' : k < 0.92 ? '#8fe9ff' : '#ff9ad5';
        c.fillRect(x * 16 + 3, y * 16 + 4, 10, 9);
      }
    });
    const winMat = new THREE.MeshBasicMaterial({ map: winTex, color: glow(0xffffff, 1.45) });
    const roofMat = new THREE.MeshBasicMaterial({ color: 0x0b0e17 });
    /** 一種尺寸的大樓：貼圖依牆面大小重複，屋頂是另一個材質 */
    const tower = (w: number, h: number, d: number): THREE.BufferGeometry => {
      const g = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      // BoxGeometry 的面順序：+x, -x, +y, -y, +z, -z，每面 4 個頂點
      for (let f = 0; f < 6; f++) {
        const side = f < 2 ? d : w;
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          if (f === 2 || f === 3) uv.setXY(i, 0.02, 0.02);
          else uv.setXY(i, uv.getX(i) * (side / 9), uv.getY(i) * (h / 18));
        }
      }
      g.clearGroups();
      g.addGroup(0, 12, 0);
      g.addGroup(12, 12, 1);
      g.addGroup(24, 12, 0);
      return g;
    };
    // 背景的高樓群：大量複製，一樣讓霓虹發光
    const towers = scatter(lowDetail ? 7 : 16, 55, 210, 60, 200);
    const list = towers.map((sp) => {
      q.setFromAxisAngle(up, Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.4);
      const s = 0.85 + rng() * 0.45;
      return new THREE.Matrix4().compose(v.set(sp.x, sp.y - 1, sp.z), q, sc.set(s, s, s));
    });
    const hr = makeInstanced('tripo/highrise', 85, list);
    if (hr) {
      hr.traverse((m) => {
        const mesh = m as THREE.Mesh;
        if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(neon) : neon(mesh.material);
      });
      root.add(hr);
      // 讓程式產生的方塊大樓避開這些高樓
      for (const sp of towers) {
        const marker = new THREE.Object3D();
        marker.position.set(sp.x, 0, sp.z);
        marker.userData.radius = 22;
        props.add(marker);
      }
    }
    const classes: [number, number, number][] = [[18, 30, 18], [24, 58, 22], [30, 92, 26]];
    const spots = scatter(lowDetail ? 70 : 150, 40, 250, 30, 230);
    const lists: THREE.Matrix4[][] = [[], [], []];
    for (const sp of spots) {
      const kind = sp.d < 75 ? 0 : rng() < 0.6 ? 1 : 2;
      q.setFromAxisAngle(up, Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.3);
      const s = 0.85 + rng() * 0.4;
      lists[kind].push(new THREE.Matrix4().compose(v.set(sp.x, sp.y - 2, sp.z), q, sc.set(s, 0.8 + rng() * 0.5, s)));
    }
    classes.forEach(([w, h, d], i) => {
      if (!lists[i].length) return;
      const im = new THREE.InstancedMesh(tower(w, h, d), [winMat, roofMat], lists[i].length);
      lists[i].forEach((m, k) => im.setMatrixAt(k, m));
      im.frustumCulled = false;
      root.add(im);
    });
    // 街道旁的行道樹（少量）
    const trees = scatter(lowDetail ? 40 : 90, hw + 11, 60, 9).map((sp) => matAt(sp, 0.7 + rng() * 0.4));
    addInst(makeInstanced('treeSmall', 9, trees));
  }

  /**
   * 軟邊界：路邊地面的高度（a = |lat|）：緩衝區上是路面高度、外圍屏障裡回傳 null、屏障後面是往下斜的路肩。
   * 沒有緩衝區的地方就是原本護欄外的路肩。
   */
  const roadsideY = (i: number, sg: number, a: number): number | null => {
    const s = S[i], w = track.runoffW(i, sg);
    if (w > 0 && a <= hw + w) return s.y + 0.02;
    const inner = w > 0 ? hw + w + runoffPad(w) : hw + 0.95;
    if (a < inner) return null;
    return a < inner + 8.05 ? s.y - 0.02 - 3.18 * ((a - inner) / 8.05) : -Infinity;
  };

  // 路肩上的花叢（有緩衝區的路段開在屏障後面的路肩上）
  if (theme.flowers) {
    const count = lowDetail ? 500 : 1400;
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.32, 0), new THREE.MeshLambertMaterial(), count);
    const cols = [0xff8fb3, 0xffe066, 0xffffff, 0xff9d5c, 0xc79bff];
    for (let i = 0; i < count; i++) {
      const si = Math.floor(rng() * n), s = S[si];
      const sg = rng() > 0.5 ? 1 : -1;
      const ro = track.runoffW(si, sg);
      const cl = latClamp(s, sg * ((ro > 0 ? ro + runoffPad(ro) - 0.95 : 0) + hw + 1.6 + rng() * 6.6));
      const drop = ro > 0
        ? (roadsideY(si, sg, Math.abs(cl)) ?? s.y) - s.y
        : -0.02 - 3.18 * ((Math.abs(cl) - (hw + 0.95)) / (9 - 0.95));
      const k = 0.7 + rng() * 0.9;
      m4.compose(v.set(s.x + s.nx * cl, s.y + drop + 0.18, s.z + s.nz * cl), q.identity(), sc.set(k, k * 0.8, k));
      flowers.setMatrixAt(i, m4);
      flowers.setColorAt(i, tmpC.setHex(cols[Math.floor(rng() * cols.length)]));
    }
    flowers.frustumCulled = false;
    root.add(flowers);
  }

  // 草原路邊的草叢（精緻畫質）：越靠近護欄越密；高度取路肩斜坡與地形較高的那個
  if (detail && theme.id === 'meadow') {
    const want = detail === 2 ? 14000 : 4500;
    const gr = mulberry32(77 + n);
    const spots: THREE.Vector3[] = [];
    for (let tries = 0; tries < want * 3 && spots.length < want; tries++) {
      const si = Math.floor(gr() * n), s = S[si];
      const sg = gr() > 0.5 ? 1 : -1;
      // 有緩衝區的路段：草叢也長在草地緩衝區上，範圍往外延伸到屏障後面
      const ro = track.runoffW(si, sg);
      const cl = latClamp(s, sg * (hw + 1.5 + Math.pow(gr(), 1.7) * (9 + ro)));
      const x = s.x + s.nx * cl, z = s.z + s.nz * cl;
      if (trackDist(x, z) < hw + 1.3 || inLake(x, z, 2) || (BR.length && inBranch(x, z, 1.2))) continue;
      const a = Math.abs(cl);
      const sy = track.hasRunoff ? roadsideY(si, sg, a) : a < hw + 9 ? s.y - 0.02 - 3.18 * ((a - (hw + 0.95)) / (9 - 0.95)) : -Infinity;
      if (sy === null) continue;
      spots.push(new THREE.Vector3(x, Math.max(sy, terrainH(x, z)) - 0.03, z));
    }
    if (spots.length) {
      const grass = grassTufts(spots, 5);
      root.add(grass.mesh);
      updaters.push((_dt, time) => grass.tick(time));
    }
  }

  // 風力發電機（遠處會轉的地標）
  if (theme.turbines) {
    const rotors: THREE.Object3D[] = [];
    const towerMat = new THREE.MeshLambertMaterial({ color: 0xf2f4f7 });
    const bladeGeo = new THREE.BoxGeometry(1.5, 20, 0.35).translate(0, 10.5, 0);
    for (const sp of scatter(lowDetail ? 4 : 8, 70, 190, 50)) {
      const g = new THREE.Group();
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.7, 44, 8).translate(0, 22, 0), towerMat);
      const hub = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 5).translate(0, 44, 0.8), towerMat);
      const rotor = new THREE.Group();
      rotor.position.set(0, 44, 3.6);
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(bladeGeo, towerMat);
        blade.rotation.z = (b / 3) * Math.PI * 2;
        rotor.add(blade);
      }
      rotor.rotation.z = rng() * 6;
      g.add(tw, hub, rotor);
      g.position.set(sp.x, sp.y - 0.5, sp.z);
      g.rotation.y = 0.6 + rng() * 0.5;
      if (shadows) g.traverse((m) => { m.castShadow = true; });
      root.add(g);
      rotors.push(rotor);
    }
    updaters.push((dt) => { for (const r of rotors) r.rotation.z += dt * 0.9; });
  }

  // ---------- 遠山（沙漠是平頂岩台） ----------
  const mMat = new THREE.MeshLambertMaterial({ color: theme.mountain, flatShading: true });
  const capMat2 = theme.mountainCap !== null ? new THREE.MeshLambertMaterial({ color: theme.mountainCap, flatShading: true }) : null;
  const mesa = theme.vegetation === 'desert';
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rng() * 0.2;
    const r = 760 + rng() * 260;
    const h = (mesa ? 90 : 150) + rng() * (mesa ? 120 : 190);
    const rad = 150 + rng() * 110;
    const geo = mesa ? new THREE.CylinderGeometry(rad * 0.62, rad, h, 8) : new THREE.ConeGeometry(rad, h, 7);
    const m = new THREE.Mesh(geo, mMat);
    m.position.set(cx + Math.cos(a) * r, baseY + h / 2 - 6, cz + Math.sin(a) * r);
    m.rotation.y = rng() * 3;
    root.add(m);
    if (capMat2 && (mesa || h > 230)) {
      const cap = mesa
        ? new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.6, rad * 0.66, h * 0.12, 8), capMat2)
        : new THREE.Mesh(new THREE.ConeGeometry(rad * 0.3, h * 0.3, 7), capMat2);
      cap.position.set(m.position.x, baseY + (mesa ? h * 1.0 : h * 0.85) - 5.5, m.position.z);
      cap.rotation.y = m.rotation.y;
      root.add(cap);
    }
  }

  // ---------- 天空 ----------
  const sunDir = new THREE.Vector3(...theme.sunDir).normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(theme.skyTop) },
        horizon: { value: new THREE.Color(theme.skyHorizon) },
        sunDir: { value: sunDir },
        disc: { value: theme.sunDisc },
        sunCol: { value: night ? new THREE.Color(0.75, 0.85, 1.0) : new THREE.Color(1.0, 0.82, 0.55) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float disc; uniform vec3 sunCol;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.5));
          float s = max(dot(d, sunDir), 0.0);
          // 太陽或月亮本體（很亮，泛光會讓它暈開）與周圍的光暈
          c += sunCol * disc * (pow(s, 600.0) * 6.0 + pow(s, 40.0) * 0.5 + pow(s, 6.0) * 0.22);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  root.add(sky);

  // 夜晚的星星
  let stars: THREE.Points | null = null;
  if (night) {
    const count = lowDetail ? 500 : 1100;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2, e = Math.asin(0.08 + rng() * 0.92);
      pos.set([Math.cos(a) * Math.cos(e) * 1800, Math.sin(e) * 1800, Math.sin(a) * Math.cos(e) * 1800], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars = new THREE.Points(g, new THREE.PointsMaterial({ color: glow(0xdfe8ff, 1.6), size: 2.2, sizeAttenuation: false, fog: false, depthWrite: false }));
    stars.frustumCulled = false;
    stars.renderOrder = -9;
    root.add(stars);
  }

  let clouds: THREE.Group | null = null;
  if (theme.cloud !== null) {
    clouds = new THREE.Group();
    const cloudMat = new THREE.MeshBasicMaterial({ color: theme.cloud, fog: false });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 18; i++) {
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
  }

  // 熱氣球（夜晚換成會發光的天燈）
  const balloons: THREE.Group[] = [];
  const envelope = new THREE.SphereGeometry(9, 12, 10).scale(1, 1.15, 1);
  const basket = new THREE.BoxGeometry(3, 2.4, 3);
  const basketMat = new THREE.MeshLambertMaterial({ color: 0x8a5a3c });
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const col = ACC[i % ACC.length];
    const e = new THREE.Mesh(envelope, night ? new THREE.MeshBasicMaterial({ color: glow(col, 1.5) }) : new THREE.MeshLambertMaterial({ color: col, flatShading: true }));
    e.position.y = 13;
    g.add(e, new THREE.Mesh(basket, basketMat));
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
      for (const u of updaters) u(dt, time);
      sky.position.copy(camera.position);
      if (stars) stars.position.copy(camera.position);
      if (clouds) clouds.rotation.y += dt * 0.004;
      for (const b of balloons) {
        b.position.y = b.userData.y0 + Math.sin(time * 0.4 + b.userData.ph) * 3;
        b.rotation.y += dt * 0.1;
      }
    },
  };
}
