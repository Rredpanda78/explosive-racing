import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../game/util';
import type { Theme } from './themes';

/**
 * 精緻畫質才有的地面細節（低畫質、手機中畫質完全不建立，沒有額外成本）：
 * 路面的法線／粗糙度貼圖、地形依坡度與雜訊混入岩石和泥土、草原路邊的草叢。
 */

/** 可以無縫拼接的數值雜訊：size × size 格，週期 period 格 */
function tileNoise(size: number, period: number, seed: number): Float32Array {
  const r = mulberry32(seed);
  const n = Math.max(1, Math.round(size / period));
  const grid = new Float32Array(n * n).map(() => r());
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = (x / size) * n, gy = (y / size) * n;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const g = (i: number, j: number) => grid[((j + n) % n) * n + ((i + n) % n)];
    const a = g(ix, iy) + (g(ix + 1, iy) - g(ix, iy)) * fx;
    const b = g(ix, iy + 1) + (g(ix + 1, iy + 1) - g(ix, iy + 1)) * fx;
    out[y * size + x] = a + (b - a) * fy;
  }
  return out;
}

function dataTex(data: Uint8Array, size: number, repeat: [number, number]): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return t;
}

/**
 * 柏油路面：法線貼圖是細碎的骨材顆粒加上一點起伏（每 2.5 公尺重複一次），
 * 粗糙度貼圖對齊路面貼圖——輪胎常壓的兩條帶與標線比較滑亮；夜城下雨，整條路是濕的、會映出霓虹。
 */
export function roadDetailMaterial(map: THREE.Texture, theme: Theme, roadWidth: number): THREE.MeshStandardMaterial {
  const N = 256;
  const h = new Float32Array(N * N);
  const o1 = tileNoise(N, 64, 11), o2 = tileNoise(N, 16, 12), o3 = tileNoise(N, 4, 13);
  for (let i = 0; i < h.length; i++) h[i] = o1[i] * 0.5 + o2[i] * 0.3 + o3[i] * 0.35;
  // 骨材顆粒：隨機的小圓點凸起
  const r = mulberry32(21);
  for (let k = 0; k < 2600; k++) {
    const cx = r() * N, cy = r() * N, rad = 0.8 + r() * 1.8, amp = 0.4 + r() * 0.6;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy) / rad;
      if (d >= 1) continue;
      const x = (Math.floor(cx) + dx + N) % N, y = (Math.floor(cy) + dy + N) % N;
      h[y * N + x] += amp * (1 - d * d);
    }
  }
  const nrm = new Uint8Array(N * N * 4);
  const k = 2.2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const hx = h[y * N + ((x + 1) % N)] - h[y * N + ((x - 1 + N) % N)];
    const hy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
    let nx = -hx * k, ny = -hy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4;
    nrm[i] = (nx * 0.5 + 0.5) * 255;
    nrm[i + 1] = (ny * 0.5 + 0.5) * 255;
    nrm[i + 2] = (nz * 0.5 + 0.5) * 255;
    nrm[i + 3] = 255;
  }
  const normalMap = dataTex(nrm, N, [Math.max(1, Math.round(roadWidth / 2.5)), 12 / 2.5]);

  // 粗糙度（G 通道）：路面貼圖是 512 寬，輪胎帶在 150、362，白線在兩側 14～21、491～498，黃線在中間 252～260
  const R = 128;
  const wet = theme.night;
  const base = wet ? 0.42 : 0.88, band = wet ? 0.28 : 0.74, paint = wet ? 0.3 : 0.62;
  const n1 = tileNoise(R, 8, 31), n2 = tileNoise(R, 32, 32);
  const rough = new Uint8Array(R * R * 4);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const px = ((x + 0.5) / R) * 512;
    let v = base;
    for (const c of [150, 362]) v = Math.min(v, band + (base - band) * Math.min(1, Math.abs(px - c) / 46));
    if ((px > 12 && px < 23) || (px > 489 && px < 500) || (px > 250 && px < 262)) v = paint;
    v += (n1[y * R + x] - 0.5) * 0.12;
    // 下雨的路：低窪處積水，更亮更滑
    if (wet) v -= Math.max(0, n2[y * R + x] - 0.6) * 0.8;
    const i = (y * R + x) * 4;
    rough[i] = rough[i + 2] = 0;
    rough[i + 1] = Math.round(Math.min(1, Math.max(0.08, v)) * 255);
    rough[i + 3] = 255;
  }
  const roughnessMap = dataTex(rough, R, [1, 1]);
  return new THREE.MeshStandardMaterial({
    // 濕路面的起伏小一點（積水填平），不然亮點會一顆顆閃
    map, normalMap, normalScale: new THREE.Vector2(1, 1).multiplyScalar(wet ? 0.28 : 0.5), roughnessMap, roughness: 1, metalness: 0,
  });
}

/** 平滑的 2D 數值雜訊（不重複），地形斑塊用 */
function valueNoise(seed: number): (x: number, z: number) => number {
  const hash = (i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  return (x, z) => {
    const ix = Math.floor(x), iz = Math.floor(z);
    let fx = x - ix, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx);
    fz = fz * fz * (3 - 2 * fz);
    const a = hash(ix, iz) + (hash(ix + 1, iz) - hash(ix, iz)) * fx;
    const b = hash(ix, iz + 1) + (hash(ix + 1, iz + 1) - hash(ix, iz + 1)) * fx;
    return a + (b - a) * fz;
  };
}

/** 每個主題的岩石（陡坡）與斑塊（泥土、碎石、水泥地）顏色 */
const TERRAIN_MIX: Record<string, { rock: number; patch: number; patchAmt: number }> = {
  meadow: { rock: 0x8a8376, patch: 0x8d6b47, patchAmt: 0.75 },
  desert: { rock: 0xa65a38, patch: 0xa8774a, patchAmt: 0.7 },
  city: { rock: 0x4b5263, patch: 0x3b4252, patchAmt: 0.7 },
  // 海底：陡坡是深灰藍的礁岩，斑塊是比較暗、長了藻的沙
  ocean: { rock: 0x4d5a5e, patch: 0x8f9a74, patchAmt: 0.6 },
  // 夜市小鎮：水泥地與柏油的深淺補丁
  taiwan: { rock: 0x4a4446, patch: 0x38322f, patchAmt: 0.6 },
};

/**
 * 地形細節：每個頂點依坡度算岩石比例、依大尺度雜訊算泥土斑塊比例（建圖時算好，存在頂點屬性），
 * 片段著色器裡把草地貼圖換成岩石／泥土的顏色，並保留貼圖本身的明暗紋理。geometry 需要已算好法線。
 */
export function applyTerrainDetail(geo: THREE.BufferGeometry, mat: THREE.MeshLambertMaterial, theme: Theme): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const cfg = TERRAIN_MIX[theme.id] ?? TERRAIN_MIX.meadow;
  const big = valueNoise(7), small = valueNoise(8);
  const det = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), ny = nor.getY(i);
    const ss = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    // 坡度越陡越多岩石，邊界用小尺度雜訊打散
    const rock = ss(0.93, 0.8, ny + (small(x / 9, z / 9) - 0.5) * 0.08);
    const n = big(x / 70, z / 70) * 0.65 + small(x / 18, z / 18) * 0.35;
    const patch = ss(0.58, 0.72, n) * cfg.patchAmt;
    det[i * 2] = rock;
    det[i * 2 + 1] = patch;
  }
  geo.setAttribute('aDetail', new THREE.BufferAttribute(det, 2));
  const grass = new THREE.Color(theme.ground[0]);
  const grassLum = (grass.r + grass.g + grass.b) / 3;
  const uRock = { value: new THREE.Color(cfg.rock) };
  const uPatch = { value: new THREE.Color(cfg.patch) };
  const uLum = { value: grassLum };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRock = uRock;
    sh.uniforms.uPatch = uPatch;
    sh.uniforms.uGrassLum = uLum;
    sh.vertexShader = 'attribute vec2 aDetail;\nvarying vec2 vDetail;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetail = aDetail;');
    sh.fragmentShader = 'uniform vec3 uRock;\nuniform vec3 uPatch;\nuniform float uGrassLum;\nvarying vec2 vDetail;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      #ifdef USE_MAP
      {
        // 貼圖的明暗（相對草地平均亮度）當作岩石、泥土的紋理
        float lum = dot(sampledDiffuseColor.rgb, vec3(0.3333)) / uGrassLum;
        vec3 t2 = texture2D(map, vMapUv * 0.37 + 0.31).rgb;
        float lum2 = dot(t2, vec3(0.3333)) / uGrassLum;
        diffuseColor.rgb = mix(diffuseColor.rgb, uPatch * mix(lum, lum2, 0.5) * vColor.rgb, vDetail.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, uRock * (0.55 + 0.45 * lum2) * vColor.rgb, vDetail.x);
      }
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'terrain-detail';
}

/**
 * 草原路邊的草叢：一叢是幾片細長的三角形葉片，全部用一個 InstancedMesh 畫（一次繪製），
 * 頂點著色器讓葉尖隨風擺動。spots 是每一叢的位置，回傳的 tick 每幀更新風的時間。
 */
export function grassTufts(spots: THREE.Vector3[], seed: number): { mesh: THREE.InstancedMesh; tick: (time: number) => void } {
  const r = mulberry32(seed);
  const blades: THREE.BufferGeometry[] = [];
  const base = new THREE.Color(0.1, 0.22, 0.05), tip = new THREE.Color(0.5, 0.72, 0.22);
  for (let b = 0; b < 9; b++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.28;
    const bx = Math.cos(a) * rr, bz = Math.sin(a) * rr;
    const h = 0.32 + r() * 0.42, w = 0.05 + r() * 0.04;
    const yaw = r() * Math.PI, lean = 0.1 + r() * 0.22;
    const cx = Math.cos(yaw), cz = Math.sin(yaw);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      bx - cx * w, 0, bz - cz * w,
      bx + cx * w, 0, bz + cz * w,
      bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean,
    ], 3));
    // 法線一律朝上：葉片的亮度跟地面一致，不會因為角度忽明忽暗
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    const tc = tip.clone().offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.06);
    g.setAttribute('color', new THREE.Float32BufferAttribute([base.r, base.g, base.b, base.r, base.g, base.b, tc.r, tc.g, tc.b], 3));
    blades.push(g);
  }
  const geo = mergeGeometries(blades)!;
  const uTime = { value: 0 };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.23 + instanceMatrix[3].z * 0.19;
        float sway = sin(uTime * 1.8 + ph) * 0.6 + sin(uTime * 3.1 + ph * 1.7) * 0.25;
        transformed.xz += vec2(0.11, 0.07) * sway * position.y * position.y * 4.0;
      #endif`,
    );
  };
  mat.customProgramCacheKey = () => 'grass-tufts';
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  spots.forEach((p, i) => {
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    const k = 0.7 + r() * 0.7;
    m.compose(p, q, s.set(k, k * (0.8 + r() * 0.5), k));
    mesh.setMatrixAt(i, m);
    // 每叢顏色略有不同（偏黃、偏深）
    c.setRGB(0.85 + r() * 0.3, 0.85 + r() * 0.25, 0.75 + r() * 0.3);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;
  return { mesh, tick: (time) => { uTime.value = time; } };
}
