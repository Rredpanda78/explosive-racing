import * as THREE from 'three';

/**
 * 靜態合併（static batching）：手機上最貴的是 draw call，不是三角形。
 *
 * 把不會動的網格依「材質＋陰影設定＋頂點屬性」分組，同一組、同一個空間格子裡的合併成一個網格：
 * - 純色、沒有貼圖的不透明材質（Kenney 景物、護欄頂、武器零件大多是這種）把顏色寫進頂點顏色，
 *   不同顏色也能合成一個 draw call（著色結果完全一樣：color × vertexColor）
 * - 設定完全相同的材質（例如換色景物各自 clone 出來的）視為同一個
 * - 依 cell 公尺切成格子，畫面外的格子照樣被視錐剔除；比格子還大的網格（繞整圈的路面、護欄、遠山）不切，同材質的全部合成一個
 *
 * 不合併：InstancedMesh／Points／Sprite／Line、半透明材質、ShaderMaterial、自訂 onBeforeCompile 而且有位移旋轉的網格
 * （shader 可能用到物件座標）、renderOrder ≠ 0、frustumCulled = false、隱藏的、userData.noBatch，
 * 以及 exclude 裡的物件與它們底下的所有東西（會動的東西）。
 */

export interface BatchOptions {
  /** 空間格子的大小（公尺）；Infinity = 不切格子 */
  cell?: number;
  /** 會動、會被程式改顯示狀態的物件：連同底下的東西都不合併 */
  exclude?: Iterable<THREE.Object3D>;
  /** 會被程式改顏色等設定的材質：照樣合併網格，但不能換成別的材質實例（不併色、不去重） */
  dynamicMaterials?: Set<THREE.Material>;
  /**
   * 會被程式移動、旋轉或切換顯示的容器（例如「裡面有會轉的槍管」的武器群組）：
   * 容器裡的靜態網格在容器自己的座標裡合併、留在容器底下，跟著容器動
   */
  containers?: Set<THREE.Object3D>;
}

export interface BatchStats {
  /** 合併前被合併掉的網格數（多材質網格算一個） */
  meshes: number;
  /** 合併後新增的網格數 */
  batches: number;
  ms: number;
}

const DEFAULT_OBC = THREE.Material.prototype.onBeforeCompile;
const customShader = (m: THREE.Material): boolean => (m as THREE.ShaderMaterial).isShaderMaterial === true || m.onBeforeCompile !== DEFAULT_OBC;

/** 可以把顏色搬進頂點顏色的材質種類（著色器都是 diffuse = color × vColor） */
const FOLD_TYPES = new Set(['MeshLambertMaterial', 'MeshBasicMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshToonMaterial']);

const objIds = new WeakMap<object, number>();
let nextObjId = 1;
const objId = (o: object): number => {
  let id = objIds.get(o);
  if (!id) objIds.set(o, (id = nextObjId++));
  return id;
};

function hasTexture(m: THREE.Material): boolean {
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) return true;
  return false;
}

/** 材質的設定摘要：一樣的摘要畫出來就一樣（fold = 不看顏色與 vertexColors） */
function matKey(m: THREE.Material, fold: boolean): string {
  const o = m as unknown as Record<string, unknown>;
  let s = m.type;
  for (const k of Object.keys(o).sort()) {
    if (k === 'uuid' || k === 'id' || k === 'name' || k === 'version' || k === 'userData' || k === '_listeners') continue;
    if (fold && (k === 'color' || k === 'vertexColors')) continue;
    const v = o[k];
    if (v === null || v === undefined) s += `|${k}:-`;
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') s += `|${k}:${v}`;
    else if (typeof v === 'function') s += `|${k}:f${objId(v)}`;
    else if ((v as THREE.Color).isColor) { const c = v as THREE.Color; s += `|${k}:${c.r},${c.g},${c.b}`; }
    else if ((v as THREE.Texture).isTexture) s += `|${k}:t${objId(v as object)}`;
    else if ((v as THREE.Vector2).isVector2) { const p = v as THREE.Vector2; s += `|${k}:${p.x},${p.y}`; }
    else if ((v as THREE.Euler).isEuler) { const e = v as THREE.Euler; s += `|${k}:${e.x},${e.y},${e.z},${e.order}`; }
    else if (Array.isArray(v) && v.length === 0) s += `|${k}:[]`;
    else s += `|${k}:o${objId(v as object)}`;
  }
  return s;
}

/** 物件身上（含陣列、一般物件，往下 depth 層）引用到的所有 3D 物件與材質：這些是程式之後會去動的 */
export function scanRefs(holder: object, depth = 3): { objects: Set<THREE.Object3D>; materials: Set<THREE.Material> } {
  const objects = new Set<THREE.Object3D>();
  const materials = new Set<THREE.Material>();
  const seen = new Set<object>();
  const visit = (v: unknown, d: number): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if ((v as THREE.Object3D).isObject3D) {
      objects.add(v as THREE.Object3D);
      return;
    }
    if ((v as THREE.Material).isMaterial) {
      materials.add(v as THREE.Material);
      return;
    }
    if (d <= 0 || ArrayBuffer.isView(v) || (v as THREE.Texture).isTexture || (v as THREE.BufferGeometry).isBufferGeometry) return;
    const vals = v instanceof Map || v instanceof Set ? [...v.values()] : Array.isArray(v) ? v : Object.values(v);
    for (const x of vals) visit(x, d - 1);
  };
  for (const x of Object.values(holder)) visit(x, depth);
  return { objects, materials };
}

/**
 * 找出 run() 會動到的物件與材質：先記下所有物件的位置／旋轉／縮放／顯示狀態與材質設定，
 * 執行 run()（例如試跑幾次場景的 update），比較哪些變了，再全部還原。
 */
export function findDynamic(root: THREE.Object3D, run: () => void): { objects: Set<THREE.Object3D>; materials: Set<THREE.Material> } {
  const snap = new Map<THREE.Object3D, number[]>();
  const mats = new Map<THREE.Material, string>();
  const state = (o: THREE.Object3D): number[] => {
    const a = [o.position.x, o.position.y, o.position.z, o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w, o.scale.x, o.scale.y, o.scale.z, o.visible ? 1 : 0];
    if (!o.matrixAutoUpdate) a.push(...o.matrix.elements);
    return a;
  };
  root.traverse((o) => {
    snap.set(o, state(o));
    const m = (o as THREE.Mesh).material;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) if (!mats.has(mm)) mats.set(mm, matKey(mm, false));
  });
  run();
  const objects = new Set<THREE.Object3D>();
  // update 裡才建立的東西一律當成會動的
  root.traverse((o) => { if (!snap.has(o)) objects.add(o); });
  for (const [o, a] of snap) {
    const b = state(o);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) objects.add(o);
    // 還原
    o.position.set(a[0], a[1], a[2]);
    o.quaternion.set(a[3], a[4], a[5], a[6]);
    o.scale.set(a[7], a[8], a[9]);
    o.visible = a[10] === 1;
    if (!o.matrixAutoUpdate) o.matrix.fromArray(a, 11);
  }
  const materials = new Set<THREE.Material>();
  for (const [m, k] of mats) if (matKey(m, false) !== k) materials.add(m);
  return { objects, materials };
}

interface Part {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  start: number;
  count: number;
  /** 合併後要用的材質；fold = 要寫進頂點顏色的材質顏色（null = 不併色） */
  mat: THREE.Material;
  fold: THREE.Color | null;
  /** 原本的材質有沒有用頂點顏色（併色時要乘上去） */
  vc: boolean;
  /** 合併後放在哪個物件底下（root，或會動的容器） */
  cont: THREE.Object3D;
}

const IDENTITY = new THREE.Matrix4();

/** 這個網格能不能合併（不看它在不在 exclude 裡） */
function mergeable(mesh: THREE.Mesh, rel: THREE.Matrix4): boolean {
  if ((mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return false;
  if (mesh.renderOrder !== 0 || !mesh.frustumCulled || mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return false;
  const geo = mesh.geometry;
  if (!geo.attributes.position || geo.attributes.tangent || Object.keys(geo.morphAttributes).length) return false;
  if (Object.values(geo.attributes).some((a) => (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute)) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (mats.some((m) => !m || m.transparent || !m.visible || (m as THREE.ShaderMaterial).isShaderMaterial)) return false;
  // 自訂 shader 可能用到物件座標：只有本來就沒有變換的才合併
  if (mats.some(customShader) && !rel.equals(IDENTITY)) return false;
  return true;
}

interface Bucket {
  cont: THREE.Object3D;
  mat: THREE.Material;
  cast: boolean;
  receive: boolean;
  attrs: { name: string; size: number }[];
  /** 已經轉成 root 座標、只留用到的頂點 */
  pieces: { pos: Float32Array; attrs: Float32Array[]; index: Uint32Array }[];
  verts: number;
  indices: number;
}

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** 合併 root 底下的靜態網格。合併出來的網格直接加在 root 底下（root 座標），原本的網格移除，留下的空群組也一併移除 */
export function batchStatic(root: THREE.Object3D, opt: BatchOptions = {}): BatchStats {
  const t0 = performance.now();
  const cell = opt.cell ?? 150;
  const dynMats = opt.dynamicMaterials ?? new Set<THREE.Material>();
  const skip = new Set<THREE.Object3D>(opt.exclude ?? []);
  skip.delete(root);
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  // ---- 1. 找出可以合併的網格 ----
  const parts: Part[] = [];
  const victims: THREE.Mesh[] = [];
  const canon = new Map<string, THREE.Material>();
  const folded = new Map<string, THREE.Material>();
  const pick = (m: THREE.Material, geo: THREE.BufferGeometry): { mat: THREE.Material; fold: THREE.Color | null } => {
    if (dynMats.has(m) || customShader(m) || m.userData.noBatch) return { mat: m, fold: null };
    const col = (m as THREE.MeshLambertMaterial).color;
    const vc = geo.attributes.color;
    if (FOLD_TYPES.has(m.type) && col && !hasTexture(m) && !(m.vertexColors && (!vc || vc.itemSize !== 3))) {
      const k = matKey(m, true);
      let f = folded.get(k);
      if (!f) {
        f = m.clone();
        (f as THREE.MeshLambertMaterial).color.setRGB(1, 1, 1);
        f.vertexColors = true;
        f.name = 'batch-vc';
        f.userData = { batched: true };
        folded.set(k, f);
      }
      return { mat: f, fold: col };
    }
    const k = matKey(m, false);
    let c = canon.get(k);
    if (!c) canon.set(k, (c = m));
    return { mat: c, fold: null };
  };
  const containers = opt.containers ?? new Set<THREE.Object3D>();
  const invOf = new Map<THREE.Object3D, THREE.Matrix4>([[root, rootInv]]);
  const visit = (o: THREE.Object3D, cont: THREE.Object3D): void => {
    if (skip.has(o) || !o.visible || o.userData.noBatch) return;
    if (containers.has(o)) {
      cont = o;
      if (!invOf.has(o)) invOf.set(o, new THREE.Matrix4().copy(o.matrixWorld).invert());
    }
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mergeable(mesh, _m.multiplyMatrices(invOf.get(cont)!, mesh.matrixWorld))) {
      const geo = mesh.geometry;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const total = geo.index ? geo.index.count : geo.attributes.position.count;
      const dr0 = geo.drawRange.start, dr1 = Math.min(total, geo.drawRange.start + geo.drawRange.count);
      // 多材質網格依 group 拆開；單一材質時 three.js 不看 group，整段畫
      const groups = Array.isArray(mesh.material) && geo.groups.length ? geo.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
      for (const g of groups) {
        const s = Math.max(g.start, dr0), e = Math.min(g.start + g.count, dr1);
        if (e - s < 3) continue;
        const src = mats[g.materialIndex ?? 0] ?? mats[0];
        const { mat, fold } = pick(src, geo);
        parts.push({ mesh, geo, start: s, count: e - s - ((e - s) % 3), mat, fold, vc: !!src.vertexColors, cont });
      }
      victims.push(mesh);
    }
    for (const c of o.children) visit(c, cont);
  };
  for (const c of root.children) visit(c, root);
  if (!victims.length) return { meshes: 0, batches: 0, ms: performance.now() - t0 };

  // ---- 2. 轉到 root 座標、依（材質、陰影、頂點屬性、格子）分桶 ----
  const buckets = new Map<string, Bucket>();
  for (const p of parts) {
    const { geo, mesh } = p;
    _m.multiplyMatrices(invOf.get(p.cont)!, mesh.matrixWorld);
    _n.getNormalMatrix(_m);
    const flip = _m.determinant() < 0;
    // 併色的材質不需要貼圖座標（沒有貼圖）；顏色改用材質顏色（乘上原本的頂點顏色）
    const names = Object.keys(geo.attributes).filter((n) => n !== 'position' && !(p.fold && (n === 'color' || n.startsWith('uv')))).sort();
    const attrs = names.map((n) => ({ name: n, size: geo.attributes[n].itemSize }));
    if (p.fold) attrs.push({ name: 'color', size: 3 });
    // 用到的頂點（只留這一段三角形用到的）
    const idx = geo.index;
    const remap = new Int32Array(geo.attributes.position.count).fill(-1);
    const order: number[] = [];
    const index = new Uint32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const v = idx ? idx.getX(p.start + i) : p.start + i;
      let r = remap[v];
      if (r < 0) {
        r = remap[v] = order.length;
        order.push(v);
      }
      index[i] = r;
    }
    if (flip) for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
    const nv = order.length;
    const pos = new Float32Array(nv * 3);
    const src = geo.attributes.position;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < nv; i++) {
      _v.fromBufferAttribute(src, order[i]).applyMatrix4(_m);
      pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
      if (_v.x < x0) x0 = _v.x;
      if (_v.x > x1) x1 = _v.x;
      if (_v.z < z0) z0 = _v.z;
      if (_v.z > z1) z1 = _v.z;
    }
    const data: Float32Array[] = [];
    for (const a of attrs) {
      const out = new Float32Array(nv * a.size);
      if (p.fold && a.name === 'color') {
        const c = p.fold, vc = p.vc ? geo.attributes.color : null;
        for (let i = 0; i < nv; i++) {
          const v = order[i];
          out[i * 3] = c.r * (vc ? vc.getX(v) : 1);
          out[i * 3 + 1] = c.g * (vc ? vc.getY(v) : 1);
          out[i * 3 + 2] = c.b * (vc ? vc.getZ(v) : 1);
        }
      } else if (a.name === 'normal') {
        const s = geo.attributes.normal;
        for (let i = 0; i < nv; i++) {
          _v.fromBufferAttribute(s, order[i]).applyMatrix3(_n).normalize();
          out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
        }
      } else {
        const s = geo.attributes[a.name];
        for (let i = 0; i < nv; i++) for (let c = 0; c < a.size; c++) out[i * a.size + c] = s.getComponent(order[i], c);
      }
      data.push(out);
    }
    const big = !isFinite(cell) || x1 - x0 > cell || z1 - z0 > cell;
    const cx = big ? 'all' : Math.floor((x0 + x1) / 2 / cell) + ',' + Math.floor((z0 + z1) / 2 / cell);
    const sig = attrs.map((a) => a.name + a.size).join(',');
    const key = `${objId(p.cont)}|${objId(p.mat)}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${sig}|${cx}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { cont: p.cont, mat: p.mat, cast: mesh.castShadow, receive: mesh.receiveShadow, attrs, pieces: [], verts: 0, indices: 0 }));
    b.pieces.push({ pos, attrs: data, index });
    b.verts += nv;
    b.indices += index.length;
  }

  // ---- 3. 每桶接成一個網格 ----
  let batches = 0;
  for (const b of buckets.values()) {
    const pos = new Float32Array(b.verts * 3);
    const out = b.attrs.map((a) => new Float32Array(b.verts * a.size));
    const index = b.verts > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices);
    let vo = 0, io = 0;
    for (const p of b.pieces) {
      pos.set(p.pos, vo * 3);
      b.attrs.forEach((a, i) => out[i].set(p.attrs[i], vo * a.size));
      for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i] + vo;
      vo += p.pos.length / 3;
      io += p.index.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    b.attrs.forEach((a, i) => g.setAttribute(a.name, new THREE.BufferAttribute(out[i], a.size)));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, b.mat);
    mesh.name = 'batch';
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.userData.batched = true;
    mesh.matrixAutoUpdate = false;
    b.cont.add(mesh);
    batches++;
  }

  // ---- 4. 移除原本的網格與因此變空的群組 ----
  for (const m of victims) {
    let p: THREE.Object3D | null = m.parent;
    m.removeFromParent();
    while (p && p !== root && p.children.length === 0 && !skip.has(p) && !containers.has(p) && (p.type === 'Group' || p.type === 'Object3D')) {
      const up: THREE.Object3D | null = p.parent;
      p.removeFromParent();
      p = up;
    }
  }
  return { meshes: victims.length, batches, ms: performance.now() - t0 };
}


/** 釋放 batchStatic 建立的幾何與併色材質 */
export function disposeBatched(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData.batched) return;
    m.geometry.dispose();
    const mat = m.material as THREE.Material;
    if (mat.userData.batched) mat.dispose();
  });
}

/** 場景試跑用的兩台鏡頭（在場景兩側），讓跟著鏡頭的東西也被偵測出來 */
function probeCameras(): THREE.PerspectiveCamera[] {
  const a = new THREE.PerspectiveCamera(66, 1.8, 0.3, 4000);
  a.position.set(-640, 70, -520);
  a.lookAt(0, 0, 0);
  const b = new THREE.PerspectiveCamera(66, 1.8, 0.3, 4000);
  b.position.set(710, 120, 480);
  b.lookAt(40, 0, -30);
  a.updateMatrixWorld();
  b.updateMatrixWorld();
  return [a, b];
}

/**
 * 賽道場景（world.ts 的 buildWorld 最後呼叫）：用 update 試跑兩次找出會動的東西（風車、熱氣球、雲、天空…），
 * 其餘靜態網格依材質與 150 公尺格子合併。新地圖不用另外設定：update 裡會動的東西自動排除。
 * 只在特定條件才動（不在 update 裡動）的網格，設 userData.noBatch = true 就不會被合併。
 */
export function batchWorld(world: { group: THREE.Object3D; update(dt: number, time: number, camera: THREE.Camera): void }): BatchStats {
  const [a, b] = probeCameras();
  const dyn = findDynamic(world.group, () => {
    world.update(0.37, 3.1, a);
    world.update(0.53, 7.9, b);
  });
  const stats = batchStatic(world.group, { cell: 150, exclude: dyn.objects, dynamicMaterials: dyn.materials });
  world.group.userData.batch = stats;
  return stats;
}

/**
 * 車子（KartView 建好後呼叫）：KartView 欄位引用到的東西會被程式拿去動——
 * - 引用到的網格、精靈（火焰、槍口火光、車燈、車殼…）：不合併
 * - 引用到的群組（會轉的槍管、N2O 配件…）與這些東西的上層群組：當成容器，裡面的靜態零件在容器座標裡合併、跟著容器動
 * - 引用到的材質（車漆、過熱發紅的槍管…）：不併色、不換材質
 * 其餘車身上的靜態零件（武器外殼等）合成幾個網格。之後新增會動的零件，只要像現有的一樣存在 KartView 的欄位裡就會自動處理；
 * 如果要在執行中個別修改群組裡的子網格（不是整個群組一起動），請把那些子網格也存進欄位，或設 userData.noBatch。
 */
export function batchKart(kv: { group: THREE.Object3D; body: THREE.Object3D }): BatchStats {
  const refs = scanRefs(kv);
  const exclude = new Set<THREE.Object3D>();
  const containers = new Set<THREE.Object3D>();
  for (const r of refs.objects) {
    if (r === kv.body || r === kv.group) continue;
    if (r.type === 'Group' || r.type === 'Object3D') containers.add(r);
    else exclude.add(r);
    // 上層群組可能被程式透過 parent 移動或隱藏：裡面的靜態零件就在那個群組裡合併
    for (let p = r.parent; p && p !== kv.body && p !== kv.group; p = p.parent) containers.add(p);
  }
  return batchStatic(kv.body, { cell: Infinity, exclude, containers, dynamicMaterials: refs.materials });
}
