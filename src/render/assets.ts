import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// 模型來源：Kenney Car Kit / Racing Kit（CC0），放在 public/models
// 大部分 GLB 用 meshopt 壓縮（EXT_meshopt_compression＋量化），Tripo 的貼圖是 WebP；解碼器是純 JS＋內嵌 wasm，不用另外放檔案
const BASE = import.meta.env.BASE_URL + 'models/';
export const modelUrl = (n: string) => BASE + n + '.glb';

export const KART_MODELS = ['kart-oobi', 'kart-oodi', 'kart-ooli', 'kart-oopi', 'kart-oozi'];
/** 使用者用 Tripo 生成的車體 */
export const CAR_MODELS = ['tripo/car1', 'tripo/car2', 'tripo/car3', 'tripo/car4', 'tripo/car5'];
/** 使用者用 Tripo 生成的地標造景 */
export const LANDMARK_MODELS = [
  'tripo/city_a', 'tripo/city_b', 'tripo/windmill_tower', 'tripo/windmill_blades',
  'tripo/water_tower', 'tripo/ferris_stand', 'tripo/ferris_wheel', 'tripo/highrise',
];
export const DEBRIS_MODELS = ['debris-tire', 'debris-plate-a', 'debris-spoiler-a', 'debris-bumper', 'debris-bolt'];
export const PROP_MODELS = [
  'grandStand', 'grandStandCovered', 'grandStandAwning', 'pitsGarage', 'pitsOffice', 'tent', 'tentLong', 'tentClosed',
  'billboard', 'billboardLow', 'flagCheckers', 'flagGreen', 'flagRed', 'lightPostLarge', 'overheadLights',
  'overheadRoundColored', 'treeLarge', 'treeSmall', 'bannerTowerGreen', 'bannerTowerRed', 'barrierRed', 'barrierWhite',
  'pylon', 'radarEquipment', 'fenceStraight', 'lightColored',
];

interface Entry {
  root: THREE.Object3D;
  /** 模型原始包圍盒 */
  box: THREE.Box3;
}

const cache = new Map<string, Entry>();
const matCache = new Map<THREE.Material, THREE.MeshLambertMaterial>();
/** 正在下載的模型（同一個模型同時被要求兩次時共用一個下載） */
const pending = new Map<string, Promise<void>>();
/** 載入失敗的模型（不再重試，改用內建幾何） */
const failed = new Set<string>();
/** 建場景時被用到、但還沒載入的模型（之後補載再重建場景；新賽道用了沒登記的模型也不會少東西） */
const missing = new Set<string>();
let known: Set<string> | null = null;
const knownModels = (): Set<string> =>
  known ?? (known = new Set([...KART_MODELS, ...CAR_MODELS, ...LANDMARK_MODELS, ...DEBRIS_MODELS, ...PROP_MODELS]));
/** 額外登記會用到的模型（例如森林），用到但沒載入時才會記到 missing */
export function registerModels(names: string[]): void {
  for (const n of names) knownModels().add(n);
}
function note(n: string): void {
  if (!cache.has(n) && !failed.has(n) && knownModels().has(n)) missing.add(n);
}
/** 取出（並清空）建場景時缺少的模型 */
export function takeMissing(): string[] {
  const out = [...missing];
  missing.clear();
  return out;
}
export const isLoaded = (n: string) => cache.has(n) || failed.has(n);

let loader: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

/**
 * 量化過的頂點屬性（int8/int16 正規化）換回浮點數：
 * 後面的程式會 applyMatrix4、合併幾何，這些都需要浮點數（只影響記憶體，不影響下載量）
 */
function toFloat(geo: THREE.BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    if (a.array instanceof Float32Array && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
    const n = a.count, s = a.itemSize;
    const f = new Float32Array(n * s);
    for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) f[i * s + c] = a.getComponent(i, c);
    geo.setAttribute(name, new THREE.BufferAttribute(f, s));
  }
}

/** 換成便宜的 Lambert 材質（手機也跑得動），保留顏色與貼圖 */
function toLambert(m: THREE.Material): THREE.MeshLambertMaterial {
  let out = matCache.get(m);
  if (!out) {
    const src = m as THREE.MeshStandardMaterial;
    out = new THREE.MeshLambertMaterial({
      color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
      map: src.map ?? null,
      transparent: src.transparent,
      opacity: src.opacity,
      side: src.side,
      name: src.name,
    });
    matCache.set(m, out);
  }
  return out;
}

async function loadOne(n: string): Promise<void> {
  try {
    const g = await gltfLoader().loadAsync(modelUrl(n));
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      toFloat(mesh.geometry);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toLambert) : toLambert(mesh.material);
    });
    g.scene.updateMatrixWorld(true);
    cache.set(n, { root: g.scene, box: new THREE.Box3().setFromObject(g.scene) });
  } catch (e) {
    console.warn('[assets] 模型載入失敗，改用內建幾何：', n, e);
    failed.add(n);
  }
}

/** onProgress(0~1)：每載完一個模型回報一次（給載入條用）；已經載入的直接算完成 */
export async function loadModels(names: string[], onProgress?: (f: number) => void): Promise<void> {
  let done = 0;
  const tick = () => onProgress?.(++done / names.length);
  await Promise.all(
    names.map(async (n) => {
      if (!isLoaded(n)) {
        let p = pending.get(n);
        if (!p) {
          p = loadOne(n).finally(() => pending.delete(n));
          pending.set(n, p);
        }
        await p;
      }
      missing.delete(n);
      tick();
    }),
  );
}

/** 先把模型檔抓進瀏覽器快取（不解析）：之後真的要用時不必再等網路。一次一個，不跟正在用的下載搶頻寬 */
export async function prefetchModels(names: string[]): Promise<void> {
  // 使用者開了省流量模式就不預先下載
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  for (const n of names) {
    if (isLoaded(n) || pending.has(n)) continue;
    try {
      await fetch(modelUrl(n));
    } catch {
      /* 離線或失敗：真的要用時再載一次 */
    }
  }
}

export const hasModel = (n: string) => cache.has(n);

/** 複製一份模型（共用幾何與材質） */
export function cloneModel(n: string): THREE.Object3D | null {
  const e = cache.get(n);
  if (!e) note(n);
  return e ? e.root.clone(true) : null;
}

/**
 * 取得一個場景物件：底部貼地、水平置中，並等比縮放到指定寬度（模型 X 方向）。
 * 回傳的 Group 可直接設定 position / rotation。
 */
export function makeProp(n: string, width: number, recolor?: Record<string, number>): THREE.Group | null {
  const e = cache.get(n);
  if (!e) {
    note(n);
    return null;
  }
  const size = e.box.getSize(new THREE.Vector3());
  const c = e.box.getCenter(new THREE.Vector3());
  const s = width / Math.max(size.x, 0.001);
  const inner = e.root.clone(true);
  inner.position.set(-c.x * s, -e.box.min.y * s, -c.z * s);
  inner.scale.setScalar(s);
  if (recolor) {
    inner.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material) => {
        const col = recolor[m.name];
        if (col === undefined) return m;
        const cm = (m as THREE.MeshLambertMaterial).clone();
        cm.color.setHex(col);
        return cm;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }
  const g = new THREE.Group();
  g.add(inner);
  g.userData.height = size.y * s;
  g.userData.depth = size.z * s;
  return g;
}

/**
 * 地標：底部貼地、水平置中，等比縮放到指定高度。原點在底部中心，正面朝 +Z。
 * 回傳的 userData 有縮放後的寬（width）、深（depth）、高（height）。
 */
export function makeLandmark(n: string, height: number): THREE.Group | null {
  const e = cache.get(n);
  if (!e) {
    note(n);
    return null;
  }
  const size = e.box.getSize(new THREE.Vector3());
  const c = e.box.getCenter(new THREE.Vector3());
  const s = height / Math.max(size.y, 0.001);
  const inner = e.root.clone(true);
  inner.position.set(-c.x * s, -e.box.min.y * s, -c.z * s);
  inner.scale.setScalar(s);
  const g = new THREE.Group();
  g.add(inner);
  g.userData.width = size.x * s;
  g.userData.depth = size.z * s;
  g.userData.height = height;
  return g;
}

/** 大量重複的物件（樹、角錐）用 InstancedMesh 畫，matrices 為每個實例的世界矩陣 */
export function makeInstanced(n: string, height: number, matrices: THREE.Matrix4[]): THREE.Group | null {
  const e = cache.get(n);
  if (!e) {
    note(n);
    return null;
  }
  if (matrices.length === 0) return null;
  const size = e.box.getSize(new THREE.Vector3());
  const c = e.box.getCenter(new THREE.Vector3());
  const s = height / Math.max(size.y, 0.001);
  const fix = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-c.x, -e.box.min.y, -c.z));
  const g = new THREE.Group();
  e.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(fix, mesh.matrixWorld));
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // 多材質的網格依 group 拆開，各自成為一個 InstancedMesh
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
    for (const grp of groups) {
      const sub = geo.clone();
      sub.clearGroups();
      const total = sub.index ? sub.index.count : sub.attributes.position.count;
      sub.setDrawRange(grp.start, Math.min(grp.count, total - grp.start));
      const im = new THREE.InstancedMesh(sub, mats[grp.materialIndex ?? 0], matrices.length);
      matrices.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;
      g.add(im);
    }
  });
  return g;
}
