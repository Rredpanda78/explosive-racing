import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 模型來源：Kenney Car Kit / Racing Kit（CC0），放在 public/models
const BASE = import.meta.env.BASE_URL + 'models/';

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

export async function loadModels(names: string[]): Promise<void> {
  const loader = new GLTFLoader();
  await Promise.all(
    names.map(async (n) => {
      if (cache.has(n)) return;
      try {
        const g = await loader.loadAsync(BASE + n + '.glb');
        g.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toLambert) : toLambert(mesh.material);
        });
        g.scene.updateMatrixWorld(true);
        cache.set(n, { root: g.scene, box: new THREE.Box3().setFromObject(g.scene) });
      } catch (e) {
        console.warn('[assets] 模型載入失敗，改用內建幾何：', n, e);
      }
    }),
  );
}

export const hasModel = (n: string) => cache.has(n);

/** 複製一份模型（共用幾何與材質） */
export function cloneModel(n: string): THREE.Object3D | null {
  const e = cache.get(n);
  return e ? e.root.clone(true) : null;
}

/**
 * 取得一個場景物件：底部貼地、水平置中，並等比縮放到指定寬度（模型 X 方向）。
 * 回傳的 Group 可直接設定 position / rotation。
 */
export function makeProp(n: string, width: number, recolor?: Record<string, number>): THREE.Group | null {
  const e = cache.get(n);
  if (!e) return null;
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
  if (!e) return null;
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
  if (!e || matrices.length === 0) return null;
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
