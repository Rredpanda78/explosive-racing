import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Branch, Sample, Track } from '../game/track';
import { mulberry32 } from '../game/util';
import { loadSettings } from '../settings';
import { cloneModel } from './assets';
import { runoffPad } from './runoff';

/**
 * 金林飛躍的森林：
 * - 分層的樹林：櫻花（羽球專案的模型）、針葉樹、闊葉樹、紅楓，依賽道路段分區、成片聚集
 * - 林下植物：蕨類、灌木（含杜鵑）、野花、長青苔的石頭、倒木、樹樁、香菇
 * - 湖邊的瀑布：岩壁、流動的水、水花與水霧、水車、白鷺、睡蓮、蘆葦
 * - 櫻花與楓樹下飄落的花瓣與葉子
 *
 * 樹都用 InstancedMesh 畫：每種樹分近、中、遠三種精細度，每幀依鏡頭距離與視野重新分配，
 * 所以整片森林只要十幾個 draw call。之後要換成 Tripo 生成的模型，只要改 SPECIES 裡對應的幾何來源。
 */

/** 森林要先載入的模型（放在 public/models/forest） */
export const FOREST_MODELS = ['forest/tree_sakura', 'forest/waterwheel', 'forest/egret'];

/** 哪些賽道要種成森林（主題是共用的，所以用賽道 id 判斷） */
const FOREST_TRACKS = new Set(['forest-jump']);
export const hasForest = (trackId: string): boolean => FOREST_TRACKS.has(trackId);

export interface ForestCtx {
  track: Track;
  /** 地形高度（含湖） */
  terrainH(x: number, z: number): number;
  /** world.ts 畫地面用的網格：原點、格距與格數（林下植物要貼著畫出來的三角形） */
  grid: { x0: number; z0: number; step: number; nx: number; nz: number };
  /** 整個場景的根節點（用來找已經建好的地形網格） */
  world: THREE.Object3D;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  lake: { x: number; z: number; r: number; y: number } | null;
  /** 已經擺好的景物（看台、帳篷、風車…），樹與草叢都要避開 */
  props: THREE.Object3D;
  shadows: boolean;
  lowDetail: boolean;
}

export interface Forest {
  group: THREE.Group;
  update(dt: number, time: number, camera: THREE.Camera): void;
}

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** 畫質分級：0 = 低畫質／手機中畫質，1 = 電腦中畫質，2 = 高畫質 */
function detailTier(lowDetail: boolean): 0 | 1 | 2 {
  if (lowDetail) return 0;
  try {
    return loadSettings(window.matchMedia('(pointer: coarse)').matches).quality === 'high' ? 2 : 1;
  } catch {
    return 2;
  }
}

/** 各畫質的密度與距離（公尺） */
const TIERS = [
  { treeCell: 8.2, undCell: 4.4, logCell: 17, near: 42, mid: 105, far: 950, und: 55, rock: 110, petals: 260, mist: 60, cols: 26 },
  { treeCell: 6.8, undCell: 3.6, logCell: 14, near: 58, mid: 140, far: 1300, und: 80, rock: 160, petals: 480, mist: 120, cols: 34 },
  { treeCell: 6.0, undCell: 3.1, logCell: 12, near: 72, mid: 170, far: 1500, und: 100, rock: 200, petals: 700, mist: 180, cols: 40 },
];

// ---------- 雜湊與雜訊（擺放位置每次都一樣） ----------
function hash2(i: number, j: number, s = 0): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** 平滑的值雜訊 0~1：讓同一種樹聚成一片 */
function vnoise(x: number, z: number, s: number): number {
  const i = Math.floor(x), j = Math.floor(z), u = x - i, v = z - j;
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

// ---------- 程式產生的低多邊形幾何 ----------
const col = (hex: number) => new THREE.Color(hex);
type Painter = (x: number, y: number, z: number, ny: number, out: THREE.Color) => void;

/**
 * 每個面各自上色（平面著色的低多邊形風格）：fol = 1 的部分會被實例顏色染色（樹葉），0 不會（樹幹、石頭）。
 * 輸出只留 position / normal / color / fol 四個屬性，才能合併。
 */
function paint(src: THREE.BufferGeometry, fn: Painter, fol: number, jitter = 0.06, seed = 1): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.computeVertexNormals();
  const p = g.attributes.position, nr = g.attributes.normal;
  const n = p.count;
  const cs = new Float32Array(n * 3);
  const c = new THREE.Color();
  const r = mulberry32(seed);
  for (let i = 0; i + 2 < n; i += 3) {
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    const ny = (nr.getY(i) + nr.getY(i + 1) + nr.getY(i + 2)) / 3;
    fn(x, y, z, ny, c);
    const k = 1 + (r() - 0.5) * 2 * jitter;
    for (let v = 0; v < 3; v++) cs.set([c.r * k, c.g * k, c.b * k], (i + v) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
  g.setAttribute('fol', new THREE.BufferAttribute(new Float32Array(n).fill(fol), 1));
  return g;
}

/** 頂點隨機推一點，讓幾何體不那麼規則（先合併共用頂點，面才不會裂開） */
function lumpy(src: THREE.BufferGeometry, amt: number, seed: number): THREE.BufferGeometry {
  let g = src.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = (k: number) => hash2(Math.round(x * 97 + k * 13), Math.round(y * 89 + z * 71), seed + k) - 0.5;
    p.setXYZ(i, x + h(1) * amt * 2, y + h(2) * amt * 2, z + h(3) * amt * 2);
  }
  return g;
}

const merge = (list: THREE.BufferGeometry[]): THREE.BufferGeometry => mergeGeometries(list)!;

const BARK_D = col(0x3e2a1c), BARK_L = col(0x6e4c30);
const barkPaint: Painter = (_x, y, _z, ny, c) => { c.lerpColors(BARK_D, BARK_L, clamp01(y / 5) * 0.6 + clamp01(ny) * 0.3); };
/** 樹葉的灰階明暗：頂端亮、底部暗（顏色交給實例顏色決定） */
const leafPaint = (cy: number, span: number): Painter => (_x, y, _z, ny, c) => {
  const k = 0.5 + 0.38 * clamp01(ny * 0.5 + 0.5) + 0.16 * clamp01((y - cy) / span + 0.5);
  c.setRGB(k, k, k * 0.96);
};

/** 針葉樹（標準高 12 m）：幾層下緣有缺口、往下垂的圓錐 */
function coniferGeo(tiers: number, seg: number, jag: boolean, seed: number): THREE.BufferGeometry {
  const r = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = tiers > 1 ? 3.6 : 2.4;
  parts.push(paint(new THREE.CylinderGeometry(0.18, 0.34, trunkH, tiers > 2 ? 6 : 4, 1, true).translate(0, trunkH / 2, 0), barkPaint, 0, 0.08, seed));
  const top = 12, y0 = tiers > 1 ? 1.9 : 1.4;
  const D = col(0x1f4a33), Lc = col(0x4f8f57), U = col(0x173626);
  for (let t = 0; t < tiers; t++) {
    const k = tiers > 1 ? t / (tiers - 1) : 0;
    const rad = tiers > 1 ? 3.2 * (1 - k * 0.78) + 0.25 : 2.7;
    const h = tiers > 1 ? ((top - y0) / tiers) * 1.8 : top - y0;
    const yb = tiers > 1 ? y0 + (top - y0 - h) * k : y0;
    let g: THREE.BufferGeometry = new THREE.ConeGeometry(rad, h, seg, 1, false);
    g = lumpy(g, 0, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      if (y < -h / 2 + 1e-3 && Math.hypot(x, z) > 1e-3) {
        const idx = Math.round((Math.atan2(z, x) / TAU) * seg);
        const odd = ((idx % 2) + 2) % 2 === 1;
        const f = jag ? (odd ? 0.72 : 1.07) : 1;
        p.setXYZ(i, x * f, y - (jag && !odd ? h * 0.18 : 0), z * f);
      }
    }
    g.rotateY(r() * TAU).translate(0, yb + h / 2, 0);
    parts.push(paint(g, (_x, y, _z, ny, c) => {
      c.lerpColors(D, Lc, clamp01(ny * 0.5 + 0.5) * 0.7 + clamp01(y / top) * 0.3);
      if (ny < -0.15) c.lerp(U, 0.7);
    }, 1, 0.08, seed + t));
  }
  return merge(parts);
}

/** 闊葉樹／楓樹（標準高 9 m）：微彎的樹幹、兩根枝條、一團團的樹冠 */
function broadleafGeo(blobs: number, detail: number, seed: number, maple: boolean, branches = true): THREE.BufferGeometry {
  const r = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = maple ? 4.2 : 4.8;
  const trunk = new THREE.CylinderGeometry(0.2, 0.36, trunkH, branches ? 6 : 4, branches ? 2 : 1, true);
  const tp = trunk.attributes.position;
  const bend = (r() - 0.5) * 0.8;
  for (let i = 0; i < tp.count; i++) {
    const t = tp.getY(i) / trunkH + 0.5;
    tp.setX(i, tp.getX(i) + t * t * bend);
  }
  parts.push(paint(trunk.translate(0, trunkH / 2, 0), barkPaint, 0, 0.08, seed));
  if (branches) {
    for (let b = 0; b < 2; b++) {
      const br = new THREE.CylinderGeometry(0.06, 0.12, 2.4, 4, 1, true).translate(0, 1.2, 0)
        .rotateZ((b ? 1 : -1) * (0.65 + r() * 0.3)).rotateY(r() * TAU).translate(bend * 0.5, trunkH * 0.68, 0);
      parts.push(paint(br, barkPaint, 0, 0.08, seed + 9 + b));
    }
  }
  const cy = maple ? 6.0 : 6.4;
  const list: [number, number, number, number][] = [[bend, cy + (maple ? 0.6 : 1.0), 0, maple ? 2.1 : 2.0]];
  for (let b = 0; b < blobs; b++) {
    const a = (b / blobs) * TAU + r() * 0.7;
    const rr = (maple ? 2.1 : 1.7) + r() * 0.6;
    list.push([bend + Math.cos(a) * rr, cy - 0.5 + r() * 1.3, Math.sin(a) * rr, (maple ? 1.45 : 1.35) + r() * 0.5]);
  }
  list.forEach(([x, y, z, s], i) => {
    const base = maple ? new THREE.DodecahedronGeometry(s, 0) : new THREE.IcosahedronGeometry(s, detail);
    const g = lumpy(base, s * 0.14, seed * 31 + i).scale(1, maple ? 0.62 : 0.82, 1).translate(x, y, z);
    parts.push(paint(g, leafPaint(cy, 4), 1, 0.1, seed + 20 + i));
  });
  return merge(parts);
}

/** 遠景的樹：短樹幹加幾團壓扁的樹冠（櫻花用三團，闊葉與楓樹一團就夠） */
function blobTreeGeo(height: number, rad: number, colHex: number, seed: number, lobes = 3): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.2, 0.35, height * 0.5, 3, 1, true).translate(0, height * 0.25, 0), barkPaint, 0, 0, seed);
  const C = col(colHex);
  const parts = [trunk];
  for (let k = 0; k < lobes; k++) {
    const a = (k / 3) * TAU + seed;
    const off = k ? rad * 0.55 : 0;
    const rr = rad * (k ? 0.72 : lobes > 1 ? 0.85 : 1);
    const g = lumpy(new THREE.IcosahedronGeometry(rr, 0), rr * 0.12, seed * 7 + k).scale(1.15, lobes > 1 ? 0.62 : 0.8, 1.15)
      .translate(Math.cos(a) * off, height * (k ? 0.62 : 0.72), Math.sin(a) * off);
    parts.push(paint(g, (_x, _y, _z, ny, c) => { c.copy(C).multiplyScalar(0.62 + 0.38 * clamp01(ny * 0.5 + 0.5)); }, 1, 0.08, seed + k));
  }
  return merge(parts);
}

/** 從 GLB 取出幾何（套上節點變換、量化過的屬性換成浮點數），filter 決定要哪些網格 */
function glbGeo(name: string, filter: (meshName: string) => boolean, folOf: (meshName: string) => number): THREE.BufferGeometry | null {
  const root = cloneModel(name);
  if (!root) return null;
  root.updateMatrixWorld(true);
  const list: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !filter(mesh.name)) return;
    const src = mesh.geometry;
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'color'] as const) {
      const a = src.attributes[k];
      if (!a) continue;
      const items = k === 'color' ? 3 : a.itemSize;
      const f = new Float32Array(a.count * items);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < items; c++) f[i * items + c] = a.getComponent(i, c);
      g.setAttribute(k, new THREE.BufferAttribute(f, items));
    }
    if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 3).fill(1), 3));
    if (src.index) g.setIndex(src.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    g.computeVertexNormals();
    g.setAttribute('fol', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(folOf(mesh.name)), 1));
    list.push(g);
  });
  if (!list.length) return null;
  return list.length > 1 ? merge(list) : list[0];
}

// ---------- 之後換成 Tripo 生成的模型 ----------
/**
 * 每個欄位對應一種樹或林下植物的「近景」幾何。把 GLB 放進 public/models/forest/（例如 tripo_conifer.glb），
 * 再把 'forest/tripo_conifer' 加進 FOREST_MODELS，那一種就會改用模型（中遠景仍用便宜的程式幾何）。
 * 模型要求：Y 朝上，大小不拘（會自動把底部中心移到原點、縮放到 height 公尺高）。
 * 頂點顏色模型：網格或材質名稱含 leaf / leaves / foliage / canopy / blossom / needle 的部分會被實例顏色染色、隨風擺動；
 * 有貼圖的模型：直接用貼圖（不染色）。
 */
const TRIPO_SLOTS = {
  conifer: { file: 'forest/tripo_conifer', height: 12 },
  broadleaf: { file: 'forest/tripo_broadleaf', height: 9 },
  maple: { file: 'forest/tripo_maple', height: 9 },
  fern: { file: 'forest/tripo_fern', height: 1 },
  bush: { file: 'forest/tripo_bush', height: 1.2 },
  rock: { file: 'forest/tripo_rock', height: 1.4 },
  log: { file: 'forest/tripo_log', height: 1 },
  stump: { file: 'forest/tripo_stump', height: 0.9 },
};
type Slot = keyof typeof TRIPO_SLOTS;
const FOLIAGE = /leaf|leaves|foliage|canopy|blossom|needle/i;

/** 讀取 Tripo 模型當近景；沒有這個檔案就回傳 null（改用程式產生的幾何） */
function slotLod(slot: Slot): { geo: THREE.BufferGeometry; mat?: THREE.Material } | null {
  const { file, height } = TRIPO_SLOTS[slot];
  const root = cloneModel(file);
  if (!root) return null;
  try {
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const matOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshLambertMaterial;
    // 有貼圖就整個模型走貼圖（Tripo 匯出通常是一個網格、一張貼圖）
    const map = meshes.map(matOf).find((m) => m.map)?.map ?? null;
    const list: THREE.BufferGeometry[] = [];
    for (const mesh of meshes) {
      const m = matOf(mesh);
      const src = mesh.geometry;
      const n = src.attributes.position.count;
      const g = new THREE.BufferGeometry();
      const copy = (k: string, items: number, fill: number) => {
        const at = src.attributes[k];
        const fa = new Float32Array(n * items).fill(fill);
        if (at) for (let i = 0; i < n; i++) for (let c = 0; c < Math.min(items, at.itemSize); c++) fa[i * items + c] = at.getComponent(i, c);
        else if (k === 'color') { const c = m.color ?? new THREE.Color(1, 1, 1); for (let i = 0; i < n; i++) fa.set([c.r, c.g, c.b], i * 3); }
        g.setAttribute(k, new THREE.BufferAttribute(fa, items));
      };
      copy('position', 3, 0);
      if (map) copy('uv', 2, 0);
      else copy('color', 3, 1);
      if (src.index) g.setIndex(src.index.clone());
      g.applyMatrix4(mesh.matrixWorld);
      g.setAttribute('fol', new THREE.BufferAttribute(new Float32Array(n).fill(FOLIAGE.test(mesh.name + ' ' + m.name) ? 1 : 0), 1));
      const ng = g.index ? g.toNonIndexed() : g;
      ng.computeVertexNormals();
      list.push(ng);
    }
    if (!list.length) return null;
    const geo = list.length > 1 ? mergeGeometries(list) : list[0];
    if (!geo) return null;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const sz = bb.getSize(new THREE.Vector3());
    const k = height / Math.max(sz.y, 1e-3);
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2).scale(k, k, k);
    return map ? { geo, mat: new THREE.MeshLambertMaterial({ map }) } : { geo };
  } catch (e) {
    console.warn('[forest] 模型格式不符，改用程式產生的幾何：', file, e);
    return null;
  }
}

// ---------- 材質：實例顏色只染樹葉，樹葉隨風輕輕擺 ----------
function forestMat(time: { value: number }, sway: number, side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = 'uniform float uTime;\nattribute float fol;\n' + sh.vertexShader
      .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.rgb *= instanceColor.rgb;', 'vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, fol );'))
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float swPh = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
          float swH = max( position.y - 1.5, 0.0 ) * fol * ${sway.toFixed(4)};
          transformed.x += sin( uTime * 1.3 + swPh ) * swH;
          transformed.z += cos( uTime * 1.05 + swPh * 1.7 ) * swH * 0.6;
        #endif`);
  };
  m.customProgramCacheKey = () => `forest-${sway}-${side}`;
  return m;
}

// ---------- 依距離換精細度的實例圖層 ----------
/** mat：這一級另外指定材質（Tripo 有貼圖的模型），不指定就用圖層的材質 */
interface LodSpec { geo: THREE.BufferGeometry; dist: number; cast?: boolean; mat?: THREE.Material }
interface CamInfo { x: number; z: number; fx: number; fz: number; cos: number; cull: boolean }
const CELL = 48;
const ckey = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048);

class Layer {
  n = 0;
  private m: number[] = [];
  private c: number[] = [];
  private xs: number[] = [];
  private zs: number[] = [];
  private rs: number[] = [];
  private ys: number[] = [];
  private hs: number[] = [];
  private M = new Float32Array(0);
  private C = new Float32Array(0);
  X = new Float32Array(0);
  Z = new Float32Array(0);
  Y = new Float32Array(0);
  H = new Float32Array(0);
  private R = new Float32Array(0);
  private cells = new Map<number, number[]>();
  private lods: { spec: LodSpec; mesh: THREE.InstancedMesh; n: number }[] = [];
  /** 畫出來的實例數與三角形數（除錯／效能統計用） */
  drawn = 0;
  tris = 0;

  constructor(readonly name: string, private specs: LodSpec[], private mat: THREE.Material, private tinted: boolean) {}

  /** h = 實際高度（花瓣從樹冠落下要用） */
  add(m4: THREE.Matrix4, c: THREE.Color | null, x: number, y: number, z: number, r: number, h: number): void {
    for (let k = 0; k < 16; k++) this.m.push(m4.elements[k]);
    this.c.push(c ? c.r : 1, c ? c.g : 1, c ? c.b : 1);
    this.xs.push(x);
    this.ys.push(y);
    this.zs.push(z);
    this.rs.push(r);
    this.hs.push(h);
    this.n++;
  }

  build(group: THREE.Group, shadows: boolean): void {
    this.M = new Float32Array(this.m);
    this.C = new Float32Array(this.c);
    this.X = new Float32Array(this.xs);
    this.Y = new Float32Array(this.ys);
    this.Z = new Float32Array(this.zs);
    this.R = new Float32Array(this.rs);
    this.H = new Float32Array(this.hs);
    this.m = this.c = this.xs = this.ys = this.zs = this.rs = this.hs = [];
    for (let i = 0; i < this.n; i++) {
      const k = ckey(Math.floor(this.X[i] / CELL), Math.floor(this.Z[i] / CELL));
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    }
    if (!this.n) return;
    for (const spec of this.specs) {
      const mesh = new THREE.InstancedMesh(spec.geo, spec.mat ?? this.mat, this.n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (this.tinted && !spec.mat) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows && !!spec.cast;
      mesh.receiveShadow = shadows && !!spec.cast;
      mesh.name = this.name;
      group.add(mesh);
      this.lods.push({ spec, mesh, n: 0 });
    }
  }

  /** 依鏡頭位置重新分配每個實例要用哪一種精細度（看不到的不畫） */
  update(cam: CamInfo): void {
    if (!this.lods.length) return;
    const lods = this.lods;
    for (const l of lods) l.n = 0;
    const R = lods[lods.length - 1].spec.dist;
    const R2 = R * R;
    const i0 = Math.floor((cam.x - R) / CELL), i1 = Math.floor((cam.x + R) / CELL);
    const j0 = Math.floor((cam.z - R) / CELL), j1 = Math.floor((cam.z + R) / CELL);
    const half = CELL * 0.71;
    const { M, C, X, Z, R: RR } = this;
    for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
      const list = this.cells.get(ckey(ci, cj));
      if (!list) continue;
      const dx = (ci + 0.5) * CELL - cam.x, dz = (cj + 0.5) * CELL - cam.z;
      const dc = Math.hypot(dx, dz);
      if (dc - half > R) continue;
      if (cam.cull && dc > CELL && dx * cam.fx + dz * cam.fz < dc * cam.cos - half - 12) continue;
      for (let q = 0; q < list.length; q++) {
        const i = list[q];
        const ix = X[i] - cam.x, iz = Z[i] - cam.z;
        const d2 = ix * ix + iz * iz;
        if (d2 > R2) continue;
        const d = Math.sqrt(d2);
        const ri = RR[i];
        if (cam.cull && d > ri + 8 && ix * cam.fx + iz * cam.fz < d * cam.cos - ri - 6) continue;
        let li = 0;
        while (li < lods.length - 1 && d > lods[li].spec.dist) li++;
        const l = lods[li];
        const arr = l.mesh.instanceMatrix.array as Float32Array;
        const o = l.n * 16, s = i * 16;
        for (let k = 0; k < 16; k++) arr[o + k] = M[s + k];
        if (l.mesh.instanceColor) {
          const ca = l.mesh.instanceColor.array as Float32Array;
          ca[l.n * 3] = C[i * 3];
          ca[l.n * 3 + 1] = C[i * 3 + 1];
          ca[l.n * 3 + 2] = C[i * 3 + 2];
        }
        l.n++;
      }
    }
    this.drawn = 0;
    this.tris = 0;
    for (const l of lods) {
      const m = l.mesh;
      m.count = l.n;
      m.visible = l.n > 0;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, l.n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.clearUpdateRanges();
        m.instanceColor.addUpdateRange(0, l.n * 3);
        m.instanceColor.needsUpdate = true;
      }
      this.drawn += l.n;
      const g = l.spec.geo;
      this.tris += l.n * (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  }

  /** 半徑 R 內的實例索引（花瓣用） */
  near(x: number, z: number, R: number, out: number[]): void {
    out.length = 0;
    const i0 = Math.floor((x - R) / CELL), i1 = Math.floor((x + R) / CELL);
    const j0 = Math.floor((z - R) / CELL), j1 = Math.floor((z + R) / CELL);
    for (let ci = i0; ci <= i1; ci++) for (let cj = j0; cj <= j1; cj++) {
      const list = this.cells.get(ckey(ci, cj));
      if (!list) continue;
      for (const i of list) if ((this.X[i] - x) ** 2 + (this.Z[i] - z) ** 2 < R * R) out.push(i);
    }
  }
}

// ---------- 最近的賽道取樣點（格子加速） ----------
class PathIndex {
  d = Infinity;
  private x0: number;
  private z0: number;
  private ni: number;
  private nj: number;
  private start: Int32Array;
  private items: Int32Array;
  private sx: Float32Array;
  private sz: Float32Array;
  private best = -1;
  private bd = Infinity;
  private lb = new Map<number, number>();

  constructor(S: Sample[], private cell = 24) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of S) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z); }
    this.x0 = Math.floor(minX / cell);
    this.z0 = Math.floor(minZ / cell);
    this.ni = Math.floor(maxX / cell) - this.x0 + 1;
    this.nj = Math.floor(maxZ / cell) - this.z0 + 1;
    this.sx = new Float32Array(S.map((s) => s.x));
    this.sz = new Float32Array(S.map((s) => s.z));
    // 每一格的取樣點連續存放（start[c] ~ start[c+1]）
    const cellOf = (i: number) => (Math.floor(this.sx[i] / cell) - this.x0) * this.nj + (Math.floor(this.sz[i] / cell) - this.z0);
    const cnt = new Int32Array(this.ni * this.nj + 1);
    for (let i = 0; i < S.length; i++) cnt[cellOf(i) + 1]++;
    for (let c = 0; c < this.ni * this.nj; c++) cnt[c + 1] += cnt[c];
    this.start = cnt.slice();
    this.items = new Int32Array(S.length);
    const fill = cnt.slice();
    for (let i = 0; i < S.length; i++) this.items[fill[cellOf(i)]++] = i;
  }

  private scan(ci: number, cj: number, x: number, z: number): void {
    const i = ci - this.x0, j = cj - this.z0;
    if (i < 0 || j < 0 || i >= this.ni || j >= this.nj) return;
    const c = i * this.nj + j;
    for (let k = this.start[c], e = this.start[c + 1]; k < e; k++) {
      const s = this.items[k];
      const dx = this.sx[s] - x, dz = this.sz[s] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < this.bd) { this.bd = d2; this.best = s; }
    }
  }

  /** 到賽道距離的下限（以格子中心的距離估計），用來快速略過離賽道很遠的點 */
  lowerBound(x: number, z: number): number {
    const c = this.cell;
    const ci = Math.floor(x / c), cj = Math.floor(z / c);
    const k = ckey(ci, cj);
    let v = this.lb.get(k);
    if (v === undefined) {
      this.nearest((ci + 0.5) * c, (cj + 0.5) * c, 4000);
      v = this.d - c * 0.71;
      this.lb.set(k, v);
    }
    return v;
  }

  /** 最近取樣點的索引，超過 maxR 回傳 -1；距離寫進 this.d（由內往外一圈一圈找格子） */
  nearest(x: number, z: number, maxR: number): number {
    const c = this.cell;
    const ci = Math.floor(x / c), cj = Math.floor(z / c);
    this.best = -1;
    this.bd = Infinity;
    this.scan(ci, cj, x, z);
    const rings = Math.ceil(maxR / c) + 1;
    for (let ring = 1; ring <= rings; ring++) {
      if (this.best >= 0 && (ring - 1) * c >= Math.sqrt(this.bd)) break;
      // 整圈都在格子範圍外就不用再找了
      if (ci - ring < this.x0 && ci + ring >= this.x0 + this.ni && cj - ring < this.z0 && cj + ring >= this.z0 + this.nj) break;
      for (let di = -ring; di <= ring; di++) { this.scan(ci + di, cj - ring, x, z); this.scan(ci + di, cj + ring, x, z); }
      for (let dj = -ring + 1; dj < ring; dj++) { this.scan(ci - ring, cj + dj, x, z); this.scan(ci + ring, cj + dj, x, z); }
    }
    this.d = Math.sqrt(this.bd);
    return this.d > maxR ? -1 : this.best;
  }
}

// ---------- 分區：沿賽道距離決定各種樹的比例 ----------
// 距離（公尺）、櫻花、針葉、闊葉、楓樹
const ZONES: [number, number, number, number, number][] = [
  [0, 0.5, 0.08, 0.37, 0.05],
  [230, 0.72, 0.04, 0.19, 0.05],
  [560, 0.62, 0.12, 0.2, 0.06],
  [700, 0.08, 0.72, 0.17, 0.03],
  [1000, 0.06, 0.66, 0.22, 0.06],
  [1130, 0.4, 0.28, 0.2, 0.12],
  [1330, 0.32, 0.2, 0.26, 0.22],
  [1480, 0.06, 0.12, 0.3, 0.52],
  [1760, 0.06, 0.18, 0.26, 0.5],
  [1880, 0.04, 0.48, 0.38, 0.1],
  [2120, 0.24, 0.3, 0.3, 0.16],
  [2380, 0.5, 0.1, 0.3, 0.1],
];
function zoneWeights(dist: number, L: number, out: number[]): void {
  const d = ((dist % L) + L) % L;
  let a = ZONES[ZONES.length - 1], b = ZONES[0], t = 0;
  for (let i = 0; i < ZONES.length; i++) {
    const z0 = ZONES[i], z1 = ZONES[(i + 1) % ZONES.length];
    const e = i + 1 < ZONES.length ? z1[0] : L;
    if (d >= z0[0] && d < e) { a = z0; b = z1; t = (d - z0[0]) / (e - z0[0]); break; }
  }
  for (let k = 0; k < 4; k++) out[k] = a[k + 1] + (b[k + 1] - a[k + 1]) * t;
}

const SAKURA_TINT = [0xffffff, 0xfff2f6, 0xffe3ee, 0xffd6e6, 0xfff8fa];
const CONIFER_TINT = [0xffffff, 0xeef6e8, 0xe2ecff, 0xf6ffe6, 0xdfe9d8];
const BROAD_TINT = [0x5aa04a, 0x6fb043, 0x478f44, 0x88b54a, 0x3d8350, 0x9cc25a, 0x5f9a3a];
const MAPLE_TINT = [0xd8432a, 0xe8642a, 0xf29a2c, 0xc42e2e, 0xf2c23c, 0xe0502f, 0xb8b23c];
const FERN_TINT = [0x4f9a3f, 0x5fae45, 0x3f8a3a, 0x77b04a];
const BUSH_TINT = [0x4c9440, 0x5ea347, 0x3b7f3f, 0x6fa84a, 0x4c9440, 0xe0609a, 0xf07fa8, 0xc9509c, 0xf6c9d8];
const FLOWER_TINT = [0xfff27a, 0xffffff, 0xd9a8ff, 0xff9cc6, 0xffb35c, 0x9ad0ff];

// ---------- 瀑布 ----------
interface Falls {
  group: THREE.Group;
  update(time: number, camera: THREE.Camera): void;
  /** 被岩山佔住的地面 */
  covers(x: number, z: number, margin: number): boolean;
  /** 從賽道看瀑布的視線：樹頂超過視線就不種 */
  blocksView(x: number, z: number, top: number): boolean;
  /** 岩山頂上可以種樹的地方 */
  topSpots: { x: number; y: number; z: number; edge: number }[];
  /** 瀑布腳下的大石頭 */
  boulders: { x: number; y: number; z: number; s: number }[];
  /** 不要放蘆葦的方向（岩壁那一側） */
  center: number;
  halfArc: number;
}

/** 水的條紋貼圖（瀑布與水面泡沫共用） */
function streakTexture(): THREE.Texture {
  const W = 64, H = 256;
  const data = new Uint8Array(W * H * 4);
  const r = mulberry32(77);
  const colv = new Float32Array(W);
  for (let x = 0; x < W; x++) colv[x] = r();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // 每一欄有自己的亮度，往下有長短不一的亮帶
    const base = (colv[x] * 0.6 + colv[(x + 1) % W] * 0.25 + colv[(x + W - 1) % W] * 0.15);
    const band = vnoise(x * 0.5, y / 22, 5) * 0.7 + vnoise(x * 0.9, y / 9, 6) * 0.3;
    const v = clamp01(base * 0.55 + band * 0.75 - 0.25);
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255);
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, W, H);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function waterMat(tex: THREE.Texture, time: { value: number }, speed: number, len: number, opacity: number): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uTex: { value: null }, uSpeed: { value: speed }, uLen: { value: len }, uOpacity: { value: opacity },
      uDeep: { value: new THREE.Color(0x4aa7d8) }, uFoam: { value: new THREE.Color(0xf4fbff) },
    }]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime; uniform sampler2D uTex; uniform float uSpeed; uniform float uLen; uniform float uOpacity;
      uniform vec3 uDeep; uniform vec3 uFoam;
      varying vec2 vUv;
      void main() {
        float a = texture2D( uTex, vec2( vUv.x * 2.0, vUv.y * uLen * 0.3 - uTime * uSpeed ) ).r;
        float b = texture2D( uTex, vec2( vUv.x * 3.3 + 0.37, vUv.y * uLen * 0.45 - uTime * uSpeed * 1.55 ) ).r;
        float s = a * 0.6 + b * 0.55;
        float foam = smoothstep( 0.45, 0.95, s ) + smoothstep( 0.72, 1.0, vUv.y ) * 0.7;
        vec3 c = mix( uDeep, uFoam, clamp( 0.3 + foam, 0.0, 1.0 ) );
        float edge = smoothstep( 0.0, 0.14, vUv.x ) * smoothstep( 1.0, 0.86, vUv.x );
        float alpha = ( 0.5 + 0.5 * s ) * edge * smoothstep( 0.0, 0.04, vUv.y ) * uOpacity;
        gl_FragColor = vec4( c * 1.08, alpha );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  m.uniforms.uTime = time;
  m.uniforms.uTex.value = tex;
  return m;
}

function buildFalls(ctx: ForestCtx, tier: number, ground: (x: number, z: number) => number, main: PathIndex, time: { value: number }): Falls | null {
  const lake = ctx.lake;
  if (!lake) return null;
  const track = ctx.track, S = track.samples, hw = track.halfWidth;
  const L = { x: lake.x, z: lake.z };
  // 找一個方向：岩壁不壓到賽道，而且從某段直線路上開過來，瀑布剛好在正前方
  let bestA = 0, bestScore = -1;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * TAU;
    const ux = Math.cos(a), uz = Math.sin(a);
    let ok = true;
    for (const da of [-1.25, -0.8, -0.4, 0, 0.4, 0.8, 1.25]) for (const dr of [3, 30, 60, 85]) {
      const px = L.x + Math.cos(a + da) * (lake.r + dr), pz = L.z + Math.sin(a + da) * (lake.r + dr);
      main.nearest(px, pz, 120);
      if (main.d < hw + 20 + dr * 0.15) ok = false;
    }
    if (!ok) continue;
    const wx = L.x + ux * (lake.r + 3), wz = L.z + uz * (lake.r + 3);
    let score = 0;
    for (let i = 0; i < S.length; i += 3) {
      const s = S[i];
      const vx = wx - s.x, vz = wz - s.z;
      const D = Math.hypot(vx, vz);
      if (D < 90 || D > 460) continue;
      const cosA = (vx * s.tx + vz * s.tz) / D;
      const facing = (vx * ux + vz * uz) / D;
      if (cosA < 0.82 || facing < 0.25) continue;
      score += (cosA - 0.82) * facing * (1 - D / 620);
    }
    if (score > bestScore) { bestScore = score; bestA = a; }
  }
  if (bestScore <= 0) return null;
  const th = bestA;
  const ux = Math.cos(th), uz = Math.sin(th);
  // 看得到瀑布的視點（給視線走廊用）
  const wx = L.x + ux * (lake.r + 3), wz = L.z + uz * (lake.r + 3);
  const views: { x: number; z: number; y: number }[] = [];
  {
    const cand: { s: Sample; sc: number }[] = [];
    for (let i = 0; i < S.length; i += 2) {
      const s = S[i];
      const vx = wx - s.x, vz = wz - s.z;
      const D = Math.hypot(vx, vz);
      if (D < 70 || D > 460) continue;
      const cosA = (vx * s.tx + vz * s.tz) / D;
      if (cosA < 0.8 || (vx * ux + vz * uz) / D < 0.2) continue;
      cand.push({ s, sc: cosA * (1 - D / 700) });
    }
    cand.sort((a, b) => b.sc - a.sc);
    for (const c of cand) {
      if (views.length >= 10) break;
      if (views.some((v) => (v.x - c.s.x) ** 2 + (v.z - c.s.z) ** 2 < 18 * 18)) continue;
      views.push({ x: c.s.x, z: c.s.z, y: c.s.y + 4.5 });
    }
  }

  const g = new THREE.Group();
  const H0 = 44;
  const A2 = 1.25; // 岩壁的半弧（含兩端往下收的部分）
  const NC = TIERS[tier].cols;
  const NR = 6, NP = 6;
  // 岩層：每一層往內或往外錯開一點，看起來是一階一階的層狀岩壁
  const STRATA = [0, 1.7, -0.3, 2.0, 0.3, 1.5, 0];
  const faceR = (a: number) => lake.r + 2.5 + (1 - Math.cos(a)) * 6 + (vnoise(a * 5, 0.5, 41) - 0.5) * 4;
  const prof = (a: number) => Math.pow(Math.cos(Math.min(Math.abs(a) / A2, 1) * Math.PI / 2), 0.55);
  const topH = (a: number) => {
    const notch = 1 - 0.13 * Math.exp(-((a / 0.07) ** 2));
    return H0 * prof(a) * (0.86 + 0.28 * vnoise(a * 7, 2.5, 43)) * notch;
  };
  // 頂點格子：每一欄 = 一個角度；前 NR+1 列是岩壁（由下往上），後 NP 列是山頂往後斜下去
  const cols = NC + 1, rows = NR + 1 + NP;
  const P = new Float32Array(cols * rows * 3);
  const yBot = lake.y - 2.6;
  const topRing: { x: number; y: number; z: number }[] = [];
  for (let ci = 0; ci < cols; ci++) {
    const a = -A2 + (ci / NC) * 2 * A2;
    const phi = th + a;
    const cx = Math.cos(phi), cz = Math.sin(phi);
    const r0 = faceR(a);
    const ht = topH(a);
    const yTop = lake.y + Math.max(ht, 0.5);
    const wet = Math.abs(a) < 0.18 ? 0.35 : 1;
    let rTop = r0;
    for (let k = 0; k <= NR; k++) {
      const t = k / NR;
      const ledge = k > 0 && k < NR ? (STRATA[k] + (vnoise(a * 6, k * 1.3, 47) - 0.5) * 1.6) * wet : 0;
      const rr = r0 + t * 4 + ledge;
      let y = yBot + (yTop - yBot) * t;
      // 兩端（高度接近 0）的底部埋進地面
      if (k === 0) y = Math.min(y, ground(L.x + cx * rr, L.z + cz * rr) - 1.5);
      P.set([L.x + cx * rr, y, L.z + cz * rr], (k * cols + ci) * 3);
      if (k === NR) rTop = rr;
    }
    topRing.push({ x: L.x + cx * rTop, y: yTop, z: L.z + cz * rTop });
    for (let j = 1; j <= NP; j++) {
      const s = j / NP;
      const rr = rTop + s * 78;
      const x = L.x + cx * rr, z = L.z + cz * rr;
      const gnd = ground(x, z) - 1.2;
      const bump = (vnoise(a * 6, s * 4, 53) - 0.5) * 5 * (1 - s);
      // 瀑布上游的溪谷：山頂中間往下凹一點
      const groove = Math.exp(-((a / 0.09) ** 2)) * (1 - s) * 2.2;
      const y = Math.max(gnd, yTop + (gnd - yTop) * smooth(0.05, 1, s) * (0.4 + 0.6 * s) + bump - groove);
      P.set([x, y, z], ((NR + j) * cols + ci) * 3);
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < rows - 1; k++) for (let ci = 0; ci < NC; ci++) {
    const a = k * cols + ci, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.BufferAttribute(P, 3));
  mg.setIndex(idx);
  const ROCK = [col(0x7c766b), col(0x8e887b), col(0x6a6459), col(0x9a9384)];
  const WET = col(0x4e4c48), MOSS = col(0x3f6c2d), GRASS = col(0x4d8538);
  const massif = new THREE.Mesh(paint(mg, (x, y, z, ny, c) => {
    const flat = Math.abs(ny);
    const band = Math.floor((y - yBot) / ((H0 + 2.6) / NR) + vnoise(x * 0.03, z * 0.03, 3) * 0.6);
    c.copy(ROCK[((band % 4) + 4) % 4]);
    const a = Math.atan2(z - L.z, x - L.x) - th;
    const aw = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    if (aw < 0.14 && flat < 0.7) c.lerp(WET, 0.75 * (1 - aw / 0.14));
    if (flat > 0.72) c.copy(GRASS).lerp(MOSS, vnoise(x * 0.1, z * 0.1, 9));
    else if (flat > 0.5) c.lerp(MOSS, 0.65);
  }, 0, 0.035, 5), forestMat(time, 0, THREE.DoubleSide));
  massif.receiveShadow = ctx.shadows;
  massif.castShadow = ctx.shadows;
  g.add(massif);

  // 頂上的樹：沿著山頂往後種
  const topSpots: Falls['topSpots'] = [];
  for (let ci = 1; ci < NC; ci++) for (let j = 1; j < NP; j++) {
    const a = -A2 + (ci / NC) * 2 * A2;
    if (Math.abs(a) < 0.12 && j < 4) continue; // 溪谷留空
    if (prof(a) < 0.25) continue;
    const o = ((NR + j) * cols + ci) * 3;
    topSpots.push({ x: P[o], y: P[o + 1], z: P[o + 2], edge: j });
  }

  // ---------- 水 ----------
  const tex = streakTexture();
  const lip = topRing[Math.round(NC / 2)];
  const rLip = Math.hypot(lip.x - L.x, lip.z - L.z) - 0.6;
  const yLip = lip.y - topH(0) * 0.02 - 0.6;
  const drop = yLip - lake.y;
  const sheet = (aOff: number, w0: number, w1: number, yStart: number, push: number, segW: number, segH: number): THREE.BufferGeometry => {
    const pos: number[] = [], uv: number[] = [], ix: number[] = [];
    const ca = Math.cos(th + aOff), sa = Math.sin(th + aOff);
    const ta = -sa, tb = ca;
    const r0 = faceR(aOff) + 4 * clamp01((yStart - yBot) / (lake.y + topH(aOff) - yBot)) - push;
    const h = yStart - lake.y;
    for (let k = 0; k <= segH; k++) {
      const t = k / segH;
      const out = 1.2 + 4.8 * Math.sqrt(t) * (h / drop);
      const y = yStart - t * h;
      const rr = r0 - out;
      const w = w0 + (w1 - w0) * t;
      for (let c = 0; c <= segW; c++) {
        const u = c / segW;
        const lat = (u - 0.5) * w;
        const wob = Math.sin(u * 9 + t * 4) * 0.25;
        pos.push(L.x + ca * (rr + wob) + ta * lat, y, L.z + sa * (rr + wob) + tb * lat);
        uv.push(u, t);
      }
    }
    for (let k = 0; k < segH; k++) for (let c = 0; c < segW; c++) {
      const a = k * (segW + 1) + c, b = a + 1, d = a + segW + 1, e = d + 1;
      ix.push(a, d, b, b, d, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(ix);
    return geo;
  };
  const fallMat = waterMat(tex, time, 1.25, drop / 10, 0.95);
  const sheets = [sheet(0, 13, 19, yLip, 0, 10, 16)];
  // 兩側的細水流
  for (const [ao, f] of [[0.2, 0.55], [-0.27, 0.42]] as [number, number][]) {
    const yS = lake.y + topH(ao) * f;
    sheets.push(sheet(ao, 1.8, 3.2, yS, 0.3, 3, 10));
  }
  const fall = new THREE.Mesh(mergeGeometries(sheets)!, fallMat);
  fall.renderOrder = 3;
  g.add(fall);

  // 山頂的溪流（流向瀑布口）
  {
    const pos: number[] = [], uv: number[] = [], ix: number[] = [];
    const segs = 10;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const rr = rLip + 1.5 + (1 - t) * 34;
      const x = L.x + ux * rr, z = L.z + uz * rr;
      // 跟著山頂的格子高度走（中間那一欄）
      const s = clamp01((rr - rLip) / 78);
      const j = s * NP;
      const j0 = Math.min(NP - 1, Math.floor(j)), f = j - j0;
      const ci = Math.round(NC / 2);
      const y0 = P[((NR + j0) * cols + ci) * 3 + 1], y1 = P[((NR + j0 + 1) * cols + ci) * 3 + 1];
      const y = Math.max(y0 + (y1 - y0) * f, yLip) + 0.35;
      const hw2 = (5 + (1 - t) * 2) / 2;
      // 溪的左右兩岸：垂直於流向
      pos.push(x - uz * hw2, y, z + ux * hw2, x + uz * hw2, y, z - ux * hw2);
      uv.push(0, t, 1, t);
    }
    for (let k = 0; k < segs; k++) { const a = k * 2; ix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(ix);
    const rm = waterMat(tex, time, 0.35, 3, 0.85);
    const river = new THREE.Mesh(geo, rm);
    river.renderOrder = 3;
    g.add(river);
  }

  // 瀑布腳下的白色水花（往外擴散）
  const baseR = faceR(0) - 1.5;
  const bx = L.x + ux * baseR, bz = L.z + uz * baseR;
  {
    const foamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uTex: { value: null } }]),
      vertexShader: `
        #include <fog_pars_vertex>
        varying vec2 vUv;
        void main() { vUv = uv; vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 ); gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime; uniform sampler2D uTex; varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length( p ) * 2.0;
          float a = atan( p.y, p.x ) / 6.2831853;
          float n = texture2D( uTex, vec2( a * 5.0, r * 1.6 - uTime * 0.45 ) ).r * 0.6 + texture2D( uTex, vec2( a * 9.0 + 0.3, r * 2.4 - uTime * 0.7 ) ).r * 0.5;
          float alpha = smoothstep( 1.0, 0.35, r ) * smoothstep( 0.25, 0.75, n + ( 1.0 - r ) * 0.45 );
          gl_FragColor = vec4( vec3( 0.97, 0.99, 1.0 ), alpha * 0.92 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    foamMat.uniforms.uTex.value = tex;
    foamMat.uniforms.uTime = time;
    foamMat.name = 'falls-foam';
    const foam = new THREE.Mesh(new THREE.CircleGeometry(13, 28).rotateX(-Math.PI / 2), foamMat);
    foam.position.set(bx - ux * 3, lake.y + 0.06, bz - uz * 3);
    foam.renderOrder = 2;
    g.add(foam);
  }

  // 水霧：GPU 依時間動，CPU 不用管
  const scaleU = { value: 600 };
  {
    const N = TIERS[tier].mist;
    const seed = new Float32Array(N * 4);
    const pos = new Float32Array(N * 3);
    const r = mulberry32(91);
    for (let i = 0; i < N; i++) {
      // 偏向湖的那一側
      const ang = th + Math.PI + (r() - 0.5) * 2.6;
      seed.set([ang, 0.08 + r() * 0.1, r(), r()], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    const mist = new THREE.Points(geo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uScale: { value: 600 }, uOrigin: { value: new THREE.Vector3(bx, lake.y, bz) } }]),
      vertexShader: `
        #include <fog_pars_vertex>
        attribute vec4 seed; uniform float uTime; uniform float uScale; uniform vec3 uOrigin; varying float vA;
        void main() {
          float t = fract( uTime * seed.y + seed.z );
          float rad = 1.5 + t * ( 9.0 + seed.w * 6.0 );
          vec3 p = uOrigin + vec3( cos( seed.x ) * rad, 0.3 + t * ( 4.0 + seed.w * 7.0 ), sin( seed.x ) * rad );
          vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = ( 2.0 + t * 4.5 ) * ( 0.6 + seed.w ) * uScale / max( -mvPosition.z, 1.0 );
          vA = sin( 3.14159 * t ) * 0.15;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        varying float vA;
        void main() {
          float d = length( gl_PointCoord - 0.5 );
          float a = smoothstep( 0.5, 0.05, d ) * vA;
          gl_FragColor = vec4( 1.0, 1.0, 1.0, a );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    }));
    (mist.material as THREE.ShaderMaterial).uniforms.uTime = time;
    (mist.material as THREE.ShaderMaterial).uniforms.uScale = scaleU;
    mist.frustumCulled = false;
    mist.renderOrder = 5;
    g.add(mist);
  }

  // 瀑布腳下的大石頭
  const boulders: Falls['boulders'] = [];
  {
    const r = mulberry32(17);
    for (let i = 0; i < 14; i++) {
      const a = (r() - 0.5) * 0.7;
      const rr = faceR(a) - 1 - r() * 7;
      if (Math.abs(a) < 0.07 && rr > faceR(0) - 5) continue; // 不要擋住水落下的地方
      boulders.push({ x: L.x + Math.cos(th + a) * rr, y: lake.y - 0.6, z: L.z + Math.sin(th + a) * rr, s: 1.2 + r() * 2.2 });
    }
  }

  const polar = (x: number, z: number) => {
    const dx = x - L.x, dz = z - L.z;
    const a = Math.atan2(dz, dx) - th;
    return { rr: Math.hypot(dx, dz), a: Math.atan2(Math.sin(a), Math.cos(a)) };
  };
  return {
    group: g,
    center: th,
    halfArc: A2,
    topSpots,
    boulders,
    covers(x, z, margin) {
      const { rr, a } = polar(x, z);
      if (Math.abs(a) > A2 + margin / Math.max(rr, 1)) return false;
      return rr > faceR(a) - 3 - margin && rr < faceR(a) + 90 + margin;
    },
    blocksView(x, z, top) {
      for (const v of views) {
        const dx = wx - v.x, dz = wz - v.z;
        const l2 = dx * dx + dz * dz;
        const t = ((x - v.x) * dx + (z - v.z) * dz) / l2;
        if (t < 0.02 || t > 0.98) continue;
        const px = v.x + dx * t, pz = v.z + dz * t;
        const dp = Math.hypot(x - px, z - pz);
        if (dp > 5 + 22 * t) continue;
        const sightY = v.y + (lake.y + 14 - v.y) * t;
        if (top > sightY - 1.5) return true;
      }
      return false;
    },
    update(_time, camera) {
      const cam = camera as THREE.PerspectiveCamera;
      if (cam.isPerspectiveCamera) {
        const hpx = (typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) : 720);
        scaleU.value = hpx / (2 * Math.tan((cam.fov * Math.PI) / 360));
      }
    },
  };
}

// ---------- 飄落的花瓣與楓葉 ----------
interface PetalSource { layer: Layer; cols: THREE.Color[]; top: number; bottom: number; rad: number }

class FallingPetals {
  mesh: THREE.Mesh;
  private base: THREE.BufferAttribute;
  private gnd: THREE.BufferAttribute;
  private pcol: THREE.BufferAttribute;
  private seed: Float32Array;
  private cyc: Int32Array;
  private near: number[][] = [];
  private nearT = -1;
  private rnd = mulberry32(123);

  constructor(private n: number, private sources: PetalSource[], time: { value: number }) {
    const V = n * 4;
    const corner = new Float32Array(V * 2);
    const base = new Float32Array(V * 3);
    const gnd = new Float32Array(V);
    const seedV = new Float32Array(V * 4);
    const pc = new Float32Array(V * 3);
    const idx: number[] = [];
    this.seed = new Float32Array(n * 4);
    this.cyc = new Int32Array(n).fill(-99999);
    const r = mulberry32(55);
    for (let i = 0; i < n; i++) {
      const s = [r(), 0.07 + r() * 0.09, 0.4 + r() * 1.2, 1.5 + r() * 3];
      this.seed.set(s, i * 4);
      for (let k = 0; k < 4; k++) {
        corner.set([k & 1 ? 1 : -1, k & 2 ? 1 : -1], (i * 4 + k) * 2);
        seedV.set(s, (i * 4 + k) * 4);
        base.set([0, -1000, 0], (i * 4 + k) * 3);
      }
      const a = i * 4;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    this.base = new THREE.BufferAttribute(base, 3).setUsage(THREE.DynamicDrawUsage);
    this.gnd = new THREE.BufferAttribute(gnd, 1).setUsage(THREE.DynamicDrawUsage);
    this.pcol = new THREE.BufferAttribute(pc, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('base', this.base);
    geo.setAttribute('ground', this.gnd);
    geo.setAttribute('seed', new THREE.BufferAttribute(seedV, 4));
    geo.setAttribute('pcol', this.pcol);
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: `
        #include <fog_pars_vertex>
        attribute vec2 corner; attribute vec3 base; attribute float ground; attribute vec4 seed; attribute vec3 pcol;
        uniform float uTime; varying vec3 vCol;
        void main() {
          float t = fract( uTime * seed.y + seed.x );
          float y = mix( base.y, ground, t );
          float sw = seed.z;
          vec3 p = vec3( base.x + sin( uTime * 1.7 + seed.x * 31.0 ) * sw + t * 3.2, y, base.z + cos( uTime * 1.3 + seed.x * 23.0 ) * sw + t * 1.4 );
          float a = uTime * seed.w + seed.x * 40.0;
          float b = uTime * seed.w * 0.7 + seed.x * 17.0;
          vec3 ax = vec3( cos( a ), sin( b ) * 0.6, sin( a ) );
          vec3 ay = normalize( cross( ax, vec3( sin( b ), 1.0, cos( b ) ) ) );
          float s = smoothstep( 0.0, 0.05, t ) * ( 1.0 - smoothstep( 0.92, 1.0, t ) );
          p += ( ax * corner.x * 0.22 + ay * corner.y * 0.15 ) * s;
          vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          vCol = pcol * ( 0.8 + 0.2 * abs( ay.y ) );
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vCol;
        void main() {
          gl_FragColor = vec4( vCol, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    mat.uniforms.uTime = time;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  update(time: number, cx: number, cz: number, fx: number, fz: number): void {
    // 每半秒找一次附近的櫻花與楓樹（偏向鏡頭前方）
    if (time - this.nearT > 0.5 || this.nearT < 0) {
      this.nearT = time;
      const px = cx + fx * 25, pz = cz + fz * 25;
      this.near = this.sources.map((s) => { const out: number[] = []; s.layer.near(px, pz, 55, out); return out; });
    }
    const total = this.near.reduce((a, l) => a + l.length, 0);
    let dirty = false;
    const r = this.rnd;
    const B = this.base.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const c = Math.floor(time * this.seed[i * 4 + 1] + this.seed[i * 4]);
      // 飄完一輪才換位置；離鏡頭太遠（例如剛換地點）的直接搬過來，反正看不到
      const far = (B[i * 12] - cx) ** 2 + (B[i * 12 + 2] - cz) ** 2 > 110 * 110 && (B[i * 12 + 1] > -999 || total > 0);
      if (c === this.cyc[i] && !far) continue;
      this.cyc[i] = c;
      dirty = true;
      let x = 0, y = -1000, z = 0, g = -1000;
      let cr = 1, cg = 1, cb = 1;
      if (total > 0) {
        let pick = Math.floor(r() * total), si = 0;
        while (pick >= this.near[si].length) { pick -= this.near[si].length; si++; }
        const src = this.sources[si], L = src.layer, k = this.near[si][pick];
        const h = L.H[k];
        const a = r() * TAU, rr = Math.sqrt(r()) * h * src.rad;
        x = L.X[k] + Math.cos(a) * rr;
        z = L.Z[k] + Math.sin(a) * rr;
        y = L.Y[k] + h * (src.bottom + r() * (src.top - src.bottom));
        g = L.Y[k] + 0.1;
        const cc = src.cols[Math.floor(r() * src.cols.length)];
        cr = cc.r; cg = cc.g; cb = cc.b;
      }
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        this.base.setXYZ(v, x, y, z);
        this.gnd.setX(v, g);
        this.pcol.setXYZ(v, cr, cg, cb);
      }
    }
    if (dirty) {
      this.base.needsUpdate = true;
      this.gnd.needsUpdate = true;
      this.pcol.needsUpdate = true;
    }
  }
}

// ---------- 主程式 ----------
export function buildForest(ctx: ForestCtx): Forest {
  const t0 = performance.now();
  const tier = detailTier(ctx.lowDetail);
  const T = TIERS[tier];
  const track = ctx.track, S = track.samples, n = track.n, L = track.length, hw = track.halfWidth;
  const group = new THREE.Group();
  group.name = 'forest';
  const time = { value: 0 };
  const shadows = ctx.shadows;

  // 畫出來的地面高度（跟 world.ts 地形網格的三角形一致）。
  // 直接讀已經建好的地形網格頂點（算一次地形高度很貴），找不到才自己算。
  const { x0: gx0, z0: gz0, step, nx: gnx, nz: gnz } = ctx.grid;
  let gridY: THREE.BufferAttribute | null = null;
  ctx.world.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (gridY || !(o as THREE.Mesh).isMesh || !g) return;
    const p = g.attributes.position;
    if (p && p.count === (gnx + 1) * (gnz + 1) && Math.abs(p.getX(0) - gx0) < 0.01 && Math.abs(p.getZ(0) - gz0) < 0.01) gridY = p as THREE.BufferAttribute;
  });
  const hCache = new Map<number, number>();
  const hAt = (i: number, j: number) => {
    if (gridY && i >= 0 && j >= 0 && i <= gnx && j <= gnz) return (gridY as THREE.BufferAttribute).getY(j * (gnx + 1) + i);
    const k = ckey(i, j);
    let h = hCache.get(k);
    if (h === undefined) hCache.set(k, (h = ctx.terrainH(gx0 + i * step, gz0 + j * step)));
    return h;
  };
  const ground = (x: number, z: number): number => {
    const fx = (x - gx0) / step, fz = (z - gz0) / step;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = hAt(i, j), b = hAt(i + 1, j), d = hAt(i, j + 1), e = hAt(i + 1, j + 1);
    if (u + v <= 1) return a + (b - a) * u + (d - a) * v;
    return e + (d - e) * (1 - u) + (b - e) * (1 - v);
  };

  const main = new PathIndex(S, 24);
  const branches: { b: Branch; idx: PathIndex }[] = track.branches.map((b) => ({ b, idx: new PathIndex(b.samples, 16) }));
  // 彎道附近（含前後一段）：外側要多留空間給鏡頭
  const curvMax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = -10; k <= 10; k += 2) {
      const c = S[(i + k + n) % n].curv;
      if (Math.abs(c) > Math.abs(m)) m = c;
    }
    curvMax[i] = m;
  }
  /**
   * 路肩的高度（從護欄外往下斜 8 m），不在路肩上回傳 -Infinity。
   * ro：軟邊界的緩衝區寬度（主線才有），路肩改從緩衝區外的屏障後面開始
   */
  const shoulderY = (s: Sample, lat: number, half: number, ro = 0): number => {
    const al = Math.abs(lat);
    const in0 = half + (ro > 0 ? ro + runoffPad(ro) : 0.95);
    if (al < in0 || al > in0 + 8.05) return -Infinity;
    if (s.curv * lat > 0 && 0.9 / Math.abs(s.curv) < in0 + 8.05) return -Infinity;
    return s.y - 0.02 - 3.18 * ((al - in0) / 8.05);
  };
  /** 軟邊界：主線這一側的外圍屏障比原本的護欄往外移了多少（沒有緩衝區是 0）；樹與林下植物都從屏障後面開始長 */
  const roW = (si: number, lat: number) => track.runoffW(si, Math.sign(lat) || 1);
  const roEx = (si: number, lat: number) => { const w = roW(si, lat); return w > 0 ? w + runoffPad(w) - 0.95 : 0; };
  const roReach = track.hasRunoff ? 16 : 0;

  // 已經擺好的景物
  const boxes: { x0: number; x1: number; z0: number; z1: number }[] = [];
  ctx.props.updateMatrixWorld(true);
  const bb = new THREE.Box3();
  for (const ch of ctx.props.children) {
    bb.setFromObject(ch);
    if (bb.isEmpty()) {
      const r = (ch.userData.radius as number | undefined) ?? 4;
      boxes.push({ x0: ch.position.x - r, x1: ch.position.x + r, z0: ch.position.z - r, z1: ch.position.z + r });
    } else boxes.push({ x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z });
  }
  const blocked = (x: number, z: number, m: number) => {
    for (const b of boxes) if (x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m) return true;
    return false;
  };
  const relDist = (d: number, d0: number) => { let r = d - d0; if (r > L / 2) r -= L; else if (r < -L / 2) r += L; return r; };
  const hazards = (track.def.hazards ?? []).map((h) => h.dist);
  const arches = track.def.scenery.arches;

  // ---------- 瀑布 ----------
  const tm: Record<string, number> = {};
  let tl = performance.now();
  const lap = (k: string) => { const t = performance.now(); tm[k] = Math.round(t - tl); tl = t; };
  lap('setup');
  const falls = buildFalls(ctx, tier, ground, main, time);
  lap('falls');
  if (falls) group.add(falls.group);
  const lake = ctx.lake;
  const lakeD = (x: number, z: number) => (lake ? Math.hypot(x - lake.x, z - lake.z) - lake.r : Infinity);

  // ---------- 樹的種類 ----------
  const treeMat = forestMat(time, 0.011);
  const solidMat = forestMat(time, 0);
  const fernMat = forestMat(time, 0.05, THREE.DoubleSide);
  const sakNear = glbGeo('forest/tree_sakura', (nm) => !nm.includes('Far'), (nm) => (nm.includes('Blossom') ? 1 : 0));
  const sakMid = glbGeo('forest/tree_sakura', (nm) => nm.includes('Far'), (nm) => (nm.includes('Blossom') ? 1 : 0));
  // 模型的原始高度約 5.07 m；沒載入時改用程式產生的粉紅樹
  const SAK_H0 = 5.07;
  const sakFallback = blobTreeGeo(SAK_H0, 2.6, 0xf3b6c8, 3);
  const sakFar = blobTreeGeo(SAK_H0, 2.7, 0xe8a3b8, 4);
  const species = {
    sakura: new Layer('sakura', [
      { geo: sakNear ?? sakFallback, dist: T.near * 0.75, cast: true },
      { geo: sakMid ?? sakFallback, dist: T.mid * (tier === 0 ? 0.6 : 0.8) },
      { geo: sakFar, dist: T.far },
    ], treeMat, true),
    conifer: new Layer('conifer', [
      { geo: coniferGeo(5, 9, true, 11), ...slotLod('conifer'), dist: T.near, cast: true },
      { geo: coniferGeo(3, 7, false, 12), dist: T.mid },
      { geo: coniferGeo(1, 6, false, 13), dist: T.far },
    ], treeMat, true),
    broad: new Layer('broadleaf', [
      { geo: broadleafGeo(6, 0, 21, false), ...slotLod('broadleaf'), dist: T.near, cast: true },
      { geo: broadleafGeo(3, 0, 22, false, false), dist: T.mid },
      { geo: blobTreeGeo(9, 3.2, 0xffffff, 23, 1), dist: T.far },
    ], treeMat, true),
    maple: new Layer('maple', [
      { geo: broadleafGeo(6, 0, 31, true), ...slotLod('maple'), dist: T.near, cast: true },
      { geo: broadleafGeo(3, 0, 32, true, false), dist: T.mid },
      { geo: blobTreeGeo(8.5, 3.4, 0xffffff, 33, 1), dist: T.far },
    ], treeMat, true),
  };
  // 標準高度與樹冠半徑比例
  const SPEC = {
    sakura: { h0: SAK_H0, hr: [7, 10.5] as [number, number], cr: 0.62, tint: SAKURA_TINT, k: 1.12 },
    conifer: { h0: 12, hr: [11, 19] as [number, number], cr: 0.26, tint: CONIFER_TINT, k: 1 },
    broad: { h0: 9, hr: [8, 13] as [number, number], cr: 0.45, tint: BROAD_TINT, k: 1 },
    maple: { h0: 9, hr: [6.5, 10] as [number, number], cr: 0.5, tint: MAPLE_TINT, k: 1 },
  };
  type Kind = keyof typeof SPEC;
  const KINDS: Kind[] = ['sakura', 'conifer', 'broad', 'maple'];

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const tc = new THREE.Color();
  const plant = (kind: Kind, x: number, y: number, z: number, h: number, yaw: number, tintPick: number) => {
    const sp = SPEC[kind];
    const s = h / sp.h0;
    q.setFromAxisAngle(up, yaw);
    m4.compose(v3.set(x, y, z), q, sc.set(s, s * (0.92 + tintPick * 0.16), s));
    tc.setHex(sp.tint[Math.floor(tintPick * sp.tint.length) % sp.tint.length]).multiplyScalar(sp.k);
    species[kind].add(m4, tc, x, y, z, h * sp.cr, h);
  };

  lap('geo');
  // ---------- 種樹 ----------
  const w = [0, 0, 0, 0];
  const bx0 = ctx.bounds.minX - 250, bz0 = ctx.bounds.minZ - 250;
  const nI = Math.ceil((ctx.bounds.maxX - ctx.bounds.minX + 500) / T.treeCell);
  const nJ = Math.ceil((ctx.bounds.maxZ - ctx.bounds.minZ + 500) / T.treeCell);
  let treeCount = 0;
  // 越遠越稀疏，但遠處的樹比較大，連成一片樹海
  const pOf = (d: number) => (d < 55 ? 1 : d < 110 ? 0.66 : d < 190 ? 0.42 : 0.26);
  for (let gi = 0; gi < nI; gi++) for (let gj = 0; gj < nJ; gj++) {
    const x = bx0 + (gi + 0.1 + hash2(gi, gj, 1) * 0.8) * T.treeCell;
    const z = bz0 + (gj + 0.1 + hash2(gi, gj, 2) * 0.8) * T.treeCell;
    const r3 = hash2(gi, gj, 3);
    const lb = main.lowerBound(x, z);
    if (lb > 290 || r3 > pOf(lb)) continue;
    const si = main.nearest(x, z, 290);
    if (si < 0) continue;
    const dm = main.d;
    if (r3 > pOf(dm)) continue;
    const s = S[si];
    const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    zoneWeights(s.dist, L, w);
    const n1 = vnoise(x / 62, z / 62, 3), n2 = vnoise(x / 47, z / 47, 7);
    w[0] *= 0.25 + 1.5 * n1;
    w[3] *= 0.3 + 1.4 * (1 - n1);
    // 後排比較高：前面是櫻花、闊葉與楓樹，後面高大的針葉樹從上面露出來
    w[1] *= (0.5 + n2) * (dm > 90 ? 2 : dm > 42 ? 1.5 : 1);
    // 遠處以綠色為主，粉紅只是點綴
    if (dm > 90) w[0] *= 0.55;
    const ld = lakeD(x, z);
    if (ld < 30) { w[0] = 0.62; w[1] = 0.08; w[2] = 0.12; w[3] = 0.18; }
    const tot = w[0] + w[1] + w[2] + w[3];
    let pick = hash2(gi, gj, 4) * tot, kind: Kind = 'broad';
    for (let k = 0; k < 4; k++) { if (pick < w[k]) { kind = KINDS[k]; break; } pick -= w[k]; }
    const sp = SPEC[kind];
    const hr = hash2(gi, gj, 5);
    const h = (sp.hr[0] + (sp.hr[1] - sp.hr[0]) * hr) * (1 + clamp01((dm - 40) / 140) * 0.25);
    const cr = h * sp.cr;
    // 路邊留空：護欄外的路肩、彎道外側多留，樹冠不能伸到鏡頭的路線上
    const cm = curvMax[si];
    const outside = cm * lat < 0 && Math.abs(cm) > 0.01;
    // 有緩衝區的那一側：樹緊貼在屏障後面 3 m 起（還是要留鏡頭的空間），森林照樣夾著路
    const ex = roEx(si, lat);
    const clear = (ex > 0 ? hw + 0.95 + ex + 3 : hw + 8) + (outside ? 3.5 : 0) + hash2(gi, gj, 6) * 1.5;
    if (dm < clear + cr * 0.4) continue;
    let nearBranch = false;
    for (const br of branches) {
      if (!br.b.inBox(x, z)) continue;
      if (br.idx.nearest(x, z, 60) >= 0 && br.idx.d < br.b.halfWidth + 5.5 + cr * 0.45) nearBranch = true;
    }
    if (nearBranch) continue;
    if (ld < 7 + cr * 0.4) continue;
    if (falls && falls.covers(x, z, cr * 0.5)) continue;
    const y = ground(x, z);
    if (falls && falls.blocksView(x, z, y + h)) continue;
    if (blocked(x, z, cr * 0.5 + 1)) continue;
    plant(kind, x, y - 0.35, z, h, hash2(gi, gj, 8) * TAU, hash2(gi, gj, 9));
    treeCount++;
  }
  // 岩山頂上：針葉樹為主，邊緣幾棵櫻花
  if (falls) {
    falls.topSpots.forEach((sp, i) => {
      const r1 = hash2(i, 0, 61), r2 = hash2(i, 0, 62), r3 = hash2(i, 0, 63);
      if (r1 > (tier === 0 ? 0.5 : 0.8)) return;
      const kind: Kind = sp.edge <= 1 && r2 < 0.35 ? 'sakura' : r2 < 0.75 ? 'conifer' : r2 < 0.9 ? 'broad' : 'maple';
      const spc = SPEC[kind];
      const h = spc.hr[0] + (spc.hr[1] - spc.hr[0]) * r3;
      const jx = (hash2(i, 1, 64) - 0.5) * 4, jz = (hash2(i, 1, 65) - 0.5) * 4;
      plant(kind, sp.x + jx, sp.y - 0.6, sp.z + jz, h, r3 * TAU, r2);
    });
  }

  lap('trees');
  // ---------- 林下植物 ----------
  const fernGeo = (() => {
    const pos: number[] = [];
    const cnt = 7;
    for (let f = 0; f < cnt; f++) {
      const a = (f / cnt) * TAU + (hash2(f, 1, 5) - 0.5) * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      const len = 0.9 + hash2(f, 2, 5) * 0.4;
      const pts: [number, number, number][] = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const rr = len * t;
        const y = Math.sin(t * Math.PI * 0.85) * 0.75 * len - t * t * 0.25;
        const wdt = Math.sin(Math.PI * Math.min(1, t * 1.15)) * 0.2 + 0.02;
        pts.push([rr, y, wdt]);
      }
      for (let k = 0; k < 4; k++) {
        const [r0, y0, w0] = pts[k], [r1, y1, w1] = pts[k + 1];
        const P = (r: number, y: number, side: number, wd: number): [number, number, number] => [ca * r - sa * side * wd, y, sa * r + ca * side * wd];
        const a0 = P(r0, y0, -1, w0), b0 = P(r0, y0, 1, w0), a1 = P(r1, y1, -1, w1), b1 = P(r1, y1, 1, w1);
        pos.push(...a0, ...a1, ...b0, ...b0, ...a1, ...b1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const D = col(0x2d5a26), Lc = col(0xb8e08a);
    return paint(g, (_x, y, _z, _ny, c) => c.lerpColors(D, Lc, clamp01(y / 0.7)), 1, 0.12, 3);
  })();
  const bushGeo = paint(lumpy(new THREE.IcosahedronGeometry(1, 1), 0.16, 7).scale(1, 0.72, 1).translate(0, 0.5, 0), leafPaint(0.5, 1.4), 1, 0.12, 8);
  const flowerGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(paint(new THREE.ConeGeometry(0.28, 0.32, 5, 1, true).translate(0, 0.16, 0), (_x, _y, _z, _ny, c) => c.setHex(0x4f8f3a), 0, 0.1, 1));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU, rr = 0.12 + hash2(k, 3, 9) * 0.14;
      parts.push(paint(new THREE.OctahedronGeometry(0.11, 0).translate(Math.cos(a) * rr, 0.3 + hash2(k, 4, 9) * 0.22, Math.sin(a) * rr), (_x, _y, _z, ny, c) => c.setScalar(0.85 + 0.15 * ny), 1, 0.05, 2 + k));
    }
    return merge(parts);
  })();
  const GREY = col(0x75766e), GREY2 = col(0x56574f), MOSS = col(0x4f7d30);
  const rockGeo = paint(lumpy(new THREE.IcosahedronGeometry(1, 1), 0.22, 13).scale(1.15, 0.7, 1).translate(0, 0.25, 0), (x, _y, z, ny, c) => {
    c.lerpColors(GREY2, GREY, clamp01(ny * 0.5 + 0.5));
    if (ny > 0.3 + vnoise(x * 3, z * 3, 2) * 0.35) c.lerp(MOSS, 0.85);
  }, 0, 0.1, 14);
  const logGeo = (() => {
    const g = new THREE.CylinderGeometry(0.42, 0.5, 6, 8, 1, false).rotateZ(Math.PI / 2).translate(0, 0.38, 0);
    const WOOD = col(0xc79a62);
    return paint(g, (x, _y, _z, ny, c) => {
      if (Math.abs(x) > 2.95) { c.copy(WOOD); return; }
      c.lerpColors(BARK_D, BARK_L, clamp01(ny * 0.5 + 0.5));
      if (ny > 0.55) c.lerp(MOSS, 0.8);
    }, 0, 0.1, 15);
  })();
  const stumpGeo = paint(new THREE.CylinderGeometry(0.48, 0.62, 0.9, 8, 1, false).translate(0, 0.35, 0), (_x, _y, _z, ny, c) => {
    if (ny > 0.9) c.setHex(0xd2a66c);
    else c.lerpColors(BARK_D, BARK_L, 0.5);
  }, 0, 0.1, 16);
  const shroomGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const CAP = col(0xd23b2e), STEM = col(0xf3ead6);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU, rr = k ? 0.22 : 0, s = k ? 0.7 : 1;
      parts.push(paint(new THREE.CylinderGeometry(0.05 * s, 0.07 * s, 0.26 * s, 5, 1, true).translate(Math.cos(a) * rr, 0.13 * s, Math.sin(a) * rr), (_x, _y, _z, _ny, c) => c.copy(STEM), 0, 0.05, 30 + k));
      parts.push(paint(new THREE.ConeGeometry(0.17 * s, 0.13 * s, 6, 1, false).translate(Math.cos(a) * rr, 0.3 * s, Math.sin(a) * rr), (_x, _y, _z, ny, c) => c.copy(ny < -0.5 ? STEM : CAP), 0, 0.08, 40 + k));
    }
    return merge(parts);
  })();
  const reedGeo = (() => {
    const pos: number[] = [];
    for (let k = 0; k < 9; k++) {
      const a = hash2(k, 1, 71) * TAU, rr = hash2(k, 2, 71) * 0.5;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const h = 1.3 + hash2(k, 3, 71) * 1.1;
      const lean = (hash2(k, 4, 71) - 0.5) * 0.5;
      const ca = Math.cos(a + 1.3) * 0.06, sa = Math.sin(a + 1.3) * 0.06;
      pos.push(x - ca, 0, z - sa, x + ca, 0, z + sa, x + lean, h, z + lean * 0.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return paint(g, (_x, y, _z, _ny, c) => c.lerpColors(col(0x4f7a2a), col(0xc8c06a), clamp01(y / 2)), 1, 0.1, 72);
  })();

  const und = {
    fern: new Layer('fern', [{ geo: fernGeo, ...slotLod('fern'), dist: T.und * 0.75 }], fernMat, true),
    bush: new Layer('bush', [{ geo: bushGeo, ...slotLod('bush'), dist: T.und * 1.2 }], treeMat, true),
    flower: new Layer('flower', [{ geo: flowerGeo, dist: T.und * 0.6 }], solidMat, true),
    rock: new Layer('rock', [{ geo: rockGeo, ...slotLod('rock'), dist: T.rock }], solidMat, false),
    log: new Layer('log', [{ geo: logGeo, ...slotLod('log'), dist: T.und * 1.2 }], solidMat, false),
    stump: new Layer('stump', [{ geo: stumpGeo, ...slotLod('stump'), dist: T.und }], solidMat, false),
    shroom: new Layer('shroom', [{ geo: shroomGeo, dist: T.und * 0.5 }], solidMat, false),
    reed: new Layer('reed', [{ geo: reedGeo, dist: T.und * 1.4 }], fernMat, true),
  };
  type UKind = keyof typeof und;
  const put = (kind: UKind, x: number, y: number, z: number, s: number, sy: number, yaw: number, tint: number | null, r: number) => {
    q.setFromAxisAngle(up, yaw);
    m4.compose(v3.set(x, y, z), q, sc.set(s, sy, s));
    und[kind].add(m4, tint === null ? null : tc.setHex(tint), x, y, z, r, s);
  };

  /** 地面高度：在路肩上就用路肩的斜面 */
  const floorAt = (x: number, z: number, s: Sample, lat: number): number => {
    let y = ground(x, z);
    const sh = shoulderY(s, lat, hw, track.hasRunoff ? roW(track.wrap(Math.round(s.dist / track.spacing)), lat) : 0);
    if (sh > y) y = sh;
    for (const br of branches) {
      if (!br.b.inBox(x, z)) continue;
      const bi = br.idx.nearest(x, z, 30);
      if (bi < 0) continue;
      const bs = br.b.samples[bi];
      const bl = (x - bs.x) * bs.nx + (z - bs.z) * bs.nz;
      const bsh = shoulderY(bs, bl, br.b.halfWidth);
      if (bsh > y) y = bsh;
    }
    return y;
  };
  /** 林下植物能不能放在這裡（不在路上、捷徑上、機關與拱門的柱子旁） */
  const undOk = (x: number, z: number, si: number, dm: number, lat: number): boolean => {
    const s = S[si];
    if (dm < hw + 2.6 + roEx(si, lat)) return false;
    const al = Math.abs(lat);
    if (al < hw + 5.5) {
      for (const d of hazards) if (Math.abs(relDist(s.dist, d)) < 6) return false;
      for (const d of arches) if (Math.abs(relDist(s.dist, d)) < 5) return false;
    }
    for (const br of branches) {
      if (!br.b.inBox(x, z)) continue;
      if (br.idx.nearest(x, z, 40) >= 0 && br.idx.d < br.b.halfWidth + 2.2) return false;
    }
    if (lakeD(x, z) < 2) return false;
    if (falls && falls.covers(x, z, 1)) return false;
    return !blocked(x, z, 0.8);
  };

  const nUI = Math.ceil((ctx.bounds.maxX - ctx.bounds.minX + 140) / T.undCell);
  const nUJ = Math.ceil((ctx.bounds.maxZ - ctx.bounds.minZ + 140) / T.undCell);
  const ux0 = ctx.bounds.minX - 70, uz0 = ctx.bounds.minZ - 70;
  for (let gi = 0; gi < nUI; gi++) for (let gj = 0; gj < nUJ; gj++) {
    const x = ux0 + (gi + hash2(gi, gj, 21)) * T.undCell;
    const z = uz0 + (gj + hash2(gi, gj, 22)) * T.undCell;
    if (main.lowerBound(x, z) > hw + 46 + roReach) continue;
    const si = main.nearest(x, z, hw + 46 + roReach);
    if (si < 0) continue;
    const dm = main.d;
    const s = S[si];
    const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    // 最密的一圈跟著護欄（或緩衝區的屏障）走
    const ex = roEx(si, lat);
    const edge = dm > hw + 6 + ex && dm < hw + 14 + ex;
    const p = edge ? 1 : dm < hw + 20 + ex ? 0.85 : 0.55;
    if (hash2(gi, gj, 23) > p) continue;
    if (!undOk(x, z, si, dm, lat)) continue;
    zoneWeights(s.dist, L, w);
    // 櫻花區多野花與杜鵑，針葉林多蕨類與石頭，楓林多灌木
    const fern = 0.28 + w[1] * 0.5;
    const bush = (0.2 + w[3] * 0.3 + w[0] * 0.15) * (edge ? 2.2 : 1);
    const flower = 0.1 + w[0] * 0.35;
    const rock = 0.07 + w[1] * 0.12;
    const tot = fern + bush + flower + rock;
    let pick = hash2(gi, gj, 24) * tot;
    const y = floorAt(x, z, s, lat);
    const yaw = hash2(gi, gj, 25) * TAU, r6 = hash2(gi, gj, 26);
    if ((pick -= fern) < 0) {
      const k = 0.8 + r6 * 0.7;
      put('fern', x, y - 0.05, z, k, k, yaw, FERN_TINT[Math.floor(r6 * 97) % FERN_TINT.length], 1);
    } else if ((pick -= bush) < 0) {
      const k = 0.7 + r6 * 0.8;
      // 櫻花區的灌木多半是開花的杜鵑
      let tint = BUSH_TINT[Math.floor(r6 * 89) % 5];
      if (hash2(gi, gj, 27) < 0.12 + w[0] * 0.5) tint = BUSH_TINT[5 + (Math.floor(r6 * 53) % 4)];
      put('bush', x, y - 0.15, z, k, k * (0.8 + r6 * 0.4), yaw, tint, k);
    } else if ((pick -= flower) < 0) {
      const k = 0.9 + r6 * 0.6;
      put('flower', x, y - 0.03, z, k, k, yaw, FLOWER_TINT[Math.floor(r6 * 71) % FLOWER_TINT.length], 0.5);
    } else {
      const k = 0.5 + r6 * 1.1;
      put('rock', x, y - 0.2 * k, z, k, k * (0.7 + hash2(gi, gj, 28) * 0.6), yaw, null, k);
    }
  }
  // 倒木、樹樁、香菇（稀疏一點）
  const nLI = Math.ceil((ctx.bounds.maxX - ctx.bounds.minX + 160) / T.logCell);
  const nLJ = Math.ceil((ctx.bounds.maxZ - ctx.bounds.minZ + 160) / T.logCell);
  for (let gi = 0; gi < nLI; gi++) for (let gj = 0; gj < nLJ; gj++) {
    const x = ctx.bounds.minX - 80 + (gi + hash2(gi, gj, 31)) * T.logCell;
    const z = ctx.bounds.minZ - 80 + (gj + hash2(gi, gj, 32)) * T.logCell;
    if (main.lowerBound(x, z) > hw + 62 + roReach) continue;
    const si = main.nearest(x, z, hw + 62 + roReach);
    if (si < 0) continue;
    const dm = main.d;
    if (hash2(gi, gj, 33) > 0.45) continue;
    const s = S[si];
    const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    if (dm < hw + 6 + roEx(si, lat)) continue;
    if (!undOk(x, z, si, dm, lat) || blocked(x, z, 3)) continue;
    const y = floorAt(x, z, s, lat);
    const r = hash2(gi, gj, 34), yaw = hash2(gi, gj, 35) * TAU;
    if (r < 0.4) {
      const k = 0.7 + hash2(gi, gj, 36) * 0.6;
      put('log', x, y - 0.12, z, k, k, yaw, null, 3 * k);
      // 倒木旁長香菇
      if (hash2(gi, gj, 37) < 0.6) put('shroom', x + Math.cos(yaw + 1.6) * 0.9, y - 0.02, z + Math.sin(yaw + 1.6) * 0.9, 1.2, 1.2, yaw, null, 0.5);
    } else if (r < 0.75) {
      const k = 0.8 + hash2(gi, gj, 36) * 0.6;
      put('stump', x, y - 0.1, z, k, k, yaw, null, k);
      if (hash2(gi, gj, 37) < 0.5) put('shroom', x + Math.cos(yaw) * 0.8, y - 0.02, z + Math.sin(yaw) * 0.8, 1.1, 1.1, yaw, null, 0.5);
    } else {
      put('shroom', x, y - 0.02, z, 1.3, 1.3, yaw, null, 0.5);
    }
  }

  lap('und');
  // ---------- 湖邊：大石頭、蘆葦、睡蓮、水車、白鷺 ----------
  const extras: THREE.Object3D[] = [];
  let wheelRotor: THREE.Object3D | null = null;
  if (lake) {
    const r = mulberry32(808);
    if (falls) for (const b of falls.boulders) put('rock', b.x, b.y, b.z, b.s, b.s * 0.8, r() * TAU, null, b.s);
    // 岩壁那一側以外的湖岸
    const inArc = (a: number) => {
      if (!falls) return false;
      const d = Math.atan2(Math.sin(a - falls.center), Math.cos(a - falls.center));
      return Math.abs(d) < falls.halfArc + 0.05;
    };
    const reeds = tier === 0 ? 40 : 80;
    for (let i = 0; i < reeds; i++) {
      const a = r() * TAU;
      if (inArc(a)) continue;
      const rr = lake.r - 1.5 + r() * 5;
      const x = lake.x + Math.cos(a) * rr, z = lake.z + Math.sin(a) * rr;
      if (blocked(x, z, 1)) continue;
      const y = Math.max(ground(x, z), lake.y - 0.3);
      put('reed', x, y, z, 0.9 + r() * 0.5, 0.9 + r() * 0.5, r() * TAU, 0xffffff, 1);
    }
    // 睡蓮與蓮花
    const pads: THREE.Matrix4[] = [], padC: number[] = [];
    const lotus: THREE.Matrix4[] = [];
    for (let c = 0; c < 5; c++) {
      let a = r() * TAU;
      if (inArc(a)) a += Math.PI;
      const cr = lake.r * (0.35 + r() * 0.45);
      const cx = lake.x + Math.cos(a) * cr, cz = lake.z + Math.sin(a) * cr;
      const cnt = 8 + Math.floor(r() * 7);
      for (let k = 0; k < cnt; k++) {
        const pa = r() * TAU, pr = r() * 5;
        const x = cx + Math.cos(pa) * pr, z = cz + Math.sin(pa) * pr;
        if (lakeD(x, z) > -3) continue;
        const s = 0.6 + r() * 0.7;
        q.setFromAxisAngle(up, r() * TAU);
        pads.push(new THREE.Matrix4().compose(v3.set(x, lake.y + 0.04, z), q, sc.set(s, 1, s)));
        tc.setHex([0x4f9a3a, 0x5fae45, 0x3f8a3a, 0x6aa84a][k % 4]);
        padC.push(tc.r, tc.g, tc.b);
        if (r() < 0.3) lotus.push(new THREE.Matrix4().compose(v3.set(x + 0.2, lake.y + 0.05, z), q, sc.set(1, 1, 1)));
      }
    }
    if (pads.length) {
      const padGeo = new THREE.CircleGeometry(1, 10, 0.3, TAU - 0.6).rotateX(-Math.PI / 2);
      const pm = new THREE.InstancedMesh(padGeo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), pads.length);
      pads.forEach((m, i) => { pm.setMatrixAt(i, m); pm.setColorAt(i, tc.setRGB(padC[i * 3], padC[i * 3 + 1], padC[i * 3 + 2])); });
      pm.frustumCulled = false;
      extras.push(pm);
    }
    if (lotus.length) {
      const petal = merge([
        paint(new THREE.ConeGeometry(0.32, 0.4, 6, 1, true).rotateX(Math.PI).translate(0, 0.25, 0), (_x, y, _z, _ny, c) => c.lerpColors(col(0xffffff), col(0xf27ea6), clamp01(y / 0.45)), 0, 0.08, 3),
        paint(new THREE.OctahedronGeometry(0.1, 0).translate(0, 0.12, 0), (_x, _y, _z, _ny, c) => c.setHex(0xffd84a), 0, 0, 4),
      ]);
      const lm = new THREE.InstancedMesh(petal, solidMat, lotus.length);
      lotus.forEach((m, i) => lm.setMatrixAt(i, m));
      lm.frustumCulled = false;
      extras.push(lm);
    }
    // 水車：放在離賽道最近的湖岸旁邊，輪子一半泡在水裡
    const wheel = cloneModel('forest/waterwheel');
    if (wheel) {
      const sNear = S[main.nearest(lake.x, lake.z, 400)];
      const toTrack = Math.atan2(sNear.z - lake.z, sNear.x - lake.x);
      const a = toTrack + (falls && Math.sin(falls.center - toTrack) > 0 ? -0.55 : 0.55);
      const rr = lake.r + 2.5;
      const x = lake.x + Math.cos(a) * rr, z = lake.z + Math.sin(a) * rr;
      const WS = 3.2;
      wheel.scale.setScalar(WS);
      // 輪軸（模型的 X 軸）順著湖岸，從賽道看得到輪面
      wheel.rotation.y = -a;
      wheel.position.set(x, Math.min(ground(x, z), lake.y + 0.3) - 0.5, z);
      wheel.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.castShadow = shadows; mesh.receiveShadow = shadows; }
        if (o.name === 'PD_Waterwheel_RotorPivot') wheelRotor = o;
      });
      extras.push(wheel);
      // 白鷺站在水車附近的淺水
      const egretGeo = glbGeo('forest/egret', () => true, () => 0);
      if (egretGeo) {
        const eg = new THREE.InstancedMesh(egretGeo, solidMat, 4);
        for (let i = 0; i < 4; i++) {
          const ea = a + (i % 2 ? 1 : -1) * (0.12 + i * 0.07);
          const er = lake.r - 1 - r() * 3;
          const ex = lake.x + Math.cos(ea) * er, ez = lake.z + Math.sin(ea) * er;
          q.setFromAxisAngle(up, r() * TAU);
          eg.setMatrixAt(i, m4.compose(v3.set(ex, lake.y - 0.25, ez), q, sc.setScalar(1.5)));
        }
        eg.frustumCulled = false;
        eg.castShadow = shadows;
        extras.push(eg);
      }
    }
  }
  for (const e of extras) group.add(e);

  lap('lake');
  // ---------- 建立實例圖層 ----------
  const layers: Layer[] = [...Object.values(species), ...Object.values(und)];
  for (const l of layers) l.build(group, shadows);

  const petals = new FallingPetals(T.petals, [
    { layer: species.sakura, cols: [col(0xffc4d6), col(0xffd8e4), col(0xfff0f4), col(0xf7a8c0)], top: 0.95, bottom: 0.6, rad: 0.5 },
    { layer: species.maple, cols: [col(0xe0502f), col(0xf29a2c), col(0xc42e2e), col(0xf2c23c)], top: 0.85, bottom: 0.55, rad: 0.38 },
  ], time);
  group.add(petals.mesh);

  const stats = {
    tier,
    trees: treeCount,
    perLayer: Object.fromEntries(layers.map((l) => [l.name, l.n])),
    buildMs: 0,
    tm,
    drawnTrees: 0,
    drawnTris: 0,
    layerTris: {} as Record<string, number>,
  };
  group.userData.stats = stats;
  group.userData.layers = layers;

  const cam: CamInfo = { x: 0, z: 0, fx: 0, fz: 1, cos: 0, cull: true };
  const dir = new THREE.Vector3();
  const last = { x: 1e9, z: 1e9, fx: 0, fz: 0, t: -1 };
  stats.buildMs = Math.round(performance.now() - t0);

  return {
    group,
    update(dt, t, camera) {
      time.value = t;
      if (wheelRotor) (wheelRotor as THREE.Object3D).rotation.x -= dt * 0.6;
      camera.getWorldPosition(v3);
      camera.getWorldDirection(dir);
      const hl = Math.hypot(dir.x, dir.z);
      cam.x = v3.x;
      cam.z = v3.z;
      cam.cull = hl > 0.5;
      cam.fx = hl > 1e-4 ? dir.x / hl : 0;
      cam.fz = hl > 1e-4 ? dir.z / hl : 1;
      const pc = camera as THREE.PerspectiveCamera;
      const vfov = pc.isPerspectiveCamera ? (pc.fov * Math.PI) / 180 : 1.2;
      const aspect = pc.isPerspectiveCamera ? pc.aspect : 1.8;
      const hh = Math.atan(Math.tan(vfov / 2) * aspect);
      cam.cos = Math.cos(Math.min(hh + 0.22, Math.PI));
      // 鏡頭移動或轉向夠多才重新分配（省下上傳到顯示卡的頻寬）
      const moved = (cam.x - last.x) ** 2 + (cam.z - last.z) ** 2 > 2.2 || cam.fx * last.fx + cam.fz * last.fz < 0.9993 || t - last.t > 0.6 || t < last.t;
      if (moved) {
        last.x = cam.x; last.z = cam.z; last.fx = cam.fx; last.fz = cam.fz; last.t = t;
        let dn = 0, tr = 0;
        for (const l of layers) { l.update(cam); dn += l.drawn; tr += l.tris; stats.layerTris[l.name] = Math.round(l.tris); }
        stats.drawnTrees = dn;
        stats.drawnTris = Math.round(tr);
      }
      falls?.update(t, camera);
      petals.update(t, cam.x, cam.z, cam.fx, cam.fz);
    },
  };
}
