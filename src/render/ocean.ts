import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Sample, Track } from '../game/track';
import { mulberry32 } from '../game/util';
import { loadSettings } from '../settings';
import { buildLife, type Cruiser, type Glow, type Life, type School, type Shaft, type Vent } from './oceanLife';

/**
 * 蔚藍海廊（海底研究園區）的場景：
 * - 玻璃隧道：大半圈的路包在透明的玻璃管裡（玻璃本身就是護欄），每 12 公尺一道鋼肋、頂上兩條燈帶、
 *   底部一圈踢腳板與燈條；轉彎外側的玻璃上有會流動的全息箭頭
 * - 起點的玻璃展演大廳（看台、維修區、跳台都在裡面）與珊瑚廣場的大圓頂（裡面是沙地緩衝區）
 * - 斷管捷徑：海溝裂縫上方一段斷掉的維修管，只剩底板、殘存的鋼肋與碎玻璃，底下的裂縫發著藍光
 * - 海床：珊瑚叢、礁岩、天然岩拱、海藻林、沉船、亮著燈的研究站圓頂，海溝兩側的高聳岩壁與發光生物
 * - 魚群、鯊魚、魟魚、水母、光束與水面（oceanLife.ts）
 * - 水面透下來的焦散光（打在所有景物上）與依鏡頭深度變化的海水顏色、霧與光線
 * 景物大多是 InstancedMesh，依賽道分段切成幾塊，看不到的那幾塊整塊跳過不畫。
 */

type Zone = 'reef' | 'kelp' | 'shallow' | 'wreck' | 'trench';

interface Layout {
  /** 起點大廳：沿主線 from~to（公尺，負的 = 起跑線前），半寬與高度 */
  hall: { from: number; to: number; half: number; height: number };
  /** 珊瑚廣場的大圓頂：罩住有沙地緩衝區的這段路 */
  plaza: { from: number; to: number };
  /** 各段的景觀 */
  zones: [number, number, Zone][];
  /** 沉船：斷成兩截，隧道從斷口中間穿過 */
  wreck: number;
  /** 研究站圓頂：[x, z, 半徑] */
  domes: [number, number, number][];
  /** 跨在隧道上的天然岩拱 */
  arches: number[];
  /** 水面高度 */
  surfaceY: number;
}

const LAYOUTS: Record<string, Layout> = {
  'sea-tunnel': {
    hall: { from: -76, to: 218, half: 55, height: 30 },
    plaza: { from: 1236, to: 1504 },
    zones: [[218, 560, 'reef'], [560, 1010, 'kelp'], [1010, 1440, 'shallow'], [1440, 1625, 'wreck'], [1625, 1965, 'trench'], [1965, 2400, 'reef']],
    wreck: 1530,
    domes: [[160, 170, 30], [215, -95, 24], [115, -250, 26], [335, -230, 20]],
    arches: [395, 492, 2105],
    surfaceY: 66,
  },
};

export const hasOcean = (trackId: string): boolean => trackId in LAYOUTS;

/** 隧道的斷面：路面兩側到玻璃底部的半寬多 0.6 公尺，高 10.5 公尺的半橢圓 */
const TUBE_H = 10.5;
const tubeA = (hw: number) => hw + 0.6;

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const glow = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k);

function hash2(i: number, j: number, s = 0): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 沿主線的距離是否落在 [from, to]（考慮首尾相接） */
const inSpan = (d: number, from: number, to: number, L: number) => ((((d - from) % L) + L) % L) <= to - from;

/** 畫質分級：0 = 低畫質／手機中畫質，1 = 電腦中畫質，2 = 高畫質（跟森林一樣） */
function detailTier(lowDetail: boolean): 0 | 1 | 2 {
  if (lowDetail) return 0;
  try {
    return loadSettings(window.matchMedia('(pointer: coarse)').matches).quality === 'high' ? 2 : 1;
  } catch {
    return 2;
  }
}

/** 各畫質的數量 */
const TIERS = [
  { decor: 0.55, schools: 9, fishMax: 34, sharks: 4, mantas: 2, jellies: 26, glows: 220, vents: 6, shafts: 9, ribLights: false, shards: 0.5 },
  { decor: 0.75, schools: 15, fishMax: 50, sharks: 5, mantas: 3, jellies: 50, glows: 420, vents: 10, shafts: 16, ribLights: true, shards: 1 },
  { decor: 1, schools: 22, fishMax: 64, sharks: 7, mantas: 4, jellies: 80, glows: 700, vents: 14, shafts: 22, ribLights: true, shards: 1 },
];

/** world.ts 用：主線每個取樣點是不是包在玻璃隧道裡（大廳與有緩衝區的圓頂裡不是） */
export function oceanGlass(track: Track): Uint8Array {
  const lay = LAYOUTS[track.def.id];
  const g = new Uint8Array(track.n);
  if (!lay) return g;
  for (let i = 0; i < track.n; i++) {
    if (inSpan(track.samples[i].dist, lay.hall.from, lay.hall.to, track.length)) continue;
    if (track.runoffW(i, 1) > 0 || track.runoffW(i, -1) > 0) continue;
    g[i] = 1;
  }
  return g;
}

// ---------- 共用貼圖與材質 ----------

let causticTexCache: THREE.DataTexture | null = null;
/** 焦散紋理：可以無縫重複的 Worley 雜訊（F2 − F1 小的地方是亮線），兩層錯開捲動取最小值就是會動的焦散 */
function causticTexture(): THREE.DataTexture {
  if (causticTexCache) return causticTexCache;
  const N = 128, P = 26;
  const r = mulberry32(77);
  const pts: [number, number][] = [];
  for (let i = 0; i < P; i++) pts.push([r(), r()]);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N;
    let f1 = 9, f2 = 9;
    for (const [px, pz] of pts) {
      let dx = Math.abs(u - px), dz = Math.abs(v - pz);
      if (dx > 0.5) dx = 1 - dx;
      if (dz > 0.5) dz = 1 - dz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    const k = Math.exp(-(f2 - f1) * 26);
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(k * 255);
    data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  causticTexCache = t;
  return t;
}

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * 玻璃：不做折射，只有很淡的底色＋邊緣的菲涅耳反光＋玻璃板的接縫線＋一道慢慢掃過的反光。
 * seams = 沿斷面、沿賽道方向每單位 uv 幾條接縫。兩面都畫、不寫深度。
 */
function glassMaterial(uTime: { value: number }, tint: number, base: number, rim: number, seams: [number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime, uTint: { value: new THREE.Color(tint) }, uBase: { value: base }, uRim: { value: rim }, uSeam: { value: new THREE.Vector2(...seams) },
    },
    fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN; varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint; uniform float uBase; uniform float uRim; uniform float uTime; uniform vec2 uSeam;
      varying vec3 vW; varying vec3 vN; varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        vec3 V = cameraPosition - vW;
        float dist = length(V);
        float ndv = abs(dot(normalize(vN), V / dist));
        float fres = pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
        // 玻璃板接縫（遠處淡掉，不然會變成一片細網紋）
        vec2 q = vUv * uSeam;
        vec2 g = 0.5 - abs(fract(q) - 0.5);
        vec2 fw = fwidth(q);
        vec2 ln = 1.0 - smoothstep(fw * 0.7, fw * 1.8, g);
        float seam = max(ln.x, ln.y) * (1.0 - smoothstep(25.0, 110.0, dist));
        // 一道斜斜掃過的反光
        float sheen = pow(max(0.0, sin(vW.x * 0.045 + vW.z * 0.03 + vW.y * 0.25 - uTime * 0.7)), 30.0);
        float a = uBase + fres * uRim + seam * 0.22 + sheen * 0.05;
        vec3 col = uTint * (0.35 + fres * 0.6) + vec3(0.75, 0.92, 1.0) * (seam * 0.35 + sheen * 0.5);
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.6));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------- 掃掠網格 ----------

interface ProfPt { lat: number; y: number; nl: number; ny: number; u: number }

/** 半橢圓斷面（θ 從左側底部 0 到右側底部 π）；out = 法線朝外 */
function ellipseProfile(A: number, B: number, K: number, yOff = 0, out = true): ProfPt[] {
  const P: ProfPt[] = [];
  for (let k = 0; k <= K; k++) {
    const th = (k / K) * Math.PI;
    let nl = Math.cos(th) / A, ny = Math.sin(th) / B;
    const l = Math.hypot(nl, ny) || 1;
    nl /= l; ny /= l;
    P.push({ lat: A * Math.cos(th), y: yOff + B * Math.sin(th), nl: out ? nl : -nl, ny: out ? ny : -ny, u: k / K });
  }
  return P;
}

/** 彎道內側的偏移不能超過曲率半徑（跟 world.ts 的 latClamp 一樣） */
function latClamp(s: Sample, lat: number): number {
  if (s.curv * lat > 0) {
    const lim = 0.9 / Math.abs(s.curv);
    if (Math.abs(lat) > lim) return Math.sign(lat) * lim;
  }
  return lat;
}

/**
 * 沿一串取樣點掃出斷面：rings 是取樣點索引（依序），vOf(r) 是第 r 圈沿賽道方向的貼圖座標；
 * seg(r, k) 決定第 r~r+1 圈、斷面第 k~k+1 點之間要不要鋪。
 */
function sweep(S: Sample[], rings: number[], prof: ProfPt[], vOf: (r: number) => number, seg?: (r: number, k: number) => boolean): THREE.BufferGeometry | null {
  const R = rings.length, K = prof.length;
  if (R < 2) return null;
  const pos = new Float32Array(R * K * 3), nor = new Float32Array(R * K * 3), uv = new Float32Array(R * K * 2);
  for (let r = 0; r < R; r++) {
    const s = S[rings[r]];
    const v = vOf(r);
    for (let k = 0; k < K; k++) {
      const p = prof[k];
      const la = latClamp(s, p.lat);
      const o = (r * K + k);
      pos.set([s.x + s.nx * la, s.y + p.y, s.z + s.nz * la], o * 3);
      nor.set([s.nx * p.nl, p.ny, s.nz * p.nl], o * 3);
      uv.set([p.u, v], o * 2);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < R - 1; r++) for (let k = 0; k < K - 1; k++) {
    if (seg && !seg(r, k)) continue;
    const a = r * K + k, b = a + 1, c = a + K, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * 鋼肋：沿半橢圓的一道矩形斷面環（寬 w 沿賽道方向、厚 t 往外），模型座標 x = 橫向、y = 上、z = 沿賽道。
 * from/to：只做 θ 的一段（斷掉的肋用）。
 */
function ribGeo(A: number, B: number, w: number, t: number, K = 18, from = 0, to = Math.PI): THREE.BufferGeometry {
  const pos: number[] = [];
  const P = (th: number, out: number, z: number) => [(A + out) * Math.cos(th), (B + out) * Math.sin(th), z];
  const quadP = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  for (let k = 0; k < K; k++) {
    const t0 = from + ((to - from) * k) / K, t1 = from + ((to - from) * (k + 1)) / K;
    // 內面、外面、前面、後面
    quadP(P(t0, 0, -w / 2), P(t1, 0, -w / 2), P(t1, 0, w / 2), P(t0, 0, w / 2));
    quadP(P(t0, t, w / 2), P(t1, t, w / 2), P(t1, t, -w / 2), P(t0, t, -w / 2));
    quadP(P(t0, 0, w / 2), P(t1, 0, w / 2), P(t1, t, w / 2), P(t0, t, w / 2));
    quadP(P(t0, t, -w / 2), P(t1, t, -w / 2), P(t1, 0, -w / 2), P(t0, 0, -w / 2));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** 讓幾何體凹凸不平（先合併共用頂點，面才不會裂開），再改回平面著色 */
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
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/** 幾何體每個面依位置／法線上色（輸出只留 position / normal / color，才能合併） */
function paint(src: THREE.BufferGeometry, fn: (x: number, y: number, z: number, ny: number, out: THREE.Color) => void, jitter = 0.08, seed = 1): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.computeVertexNormals();
  const p = g.attributes.position, nr = g.attributes.normal;
  const cs = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  const r = mulberry32(seed);
  for (let i = 0; i + 2 < p.count; i += 3) {
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    const ny = (nr.getY(i) + nr.getY(i + 1) + nr.getY(i + 2)) / 3;
    fn(x, y, z, ny, c);
    const k = 1 + (r() - 0.5) * 2 * jitter;
    for (let v = 0; v < 3; v++) cs.set([c.r * k, c.g * k, c.b * k], (i + v) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cs, 3));
  return g;
}

const solid = (hex: number) => (_x: number, _y: number, _z: number, _ny: number, out: THREE.Color) => { out.setHex(hex); };

// ---------- 珊瑚、岩石、海藻的幾何 ----------

const CORAL_COLS = [0xff5f8f, 0xff9a3c, 0xffd166, 0xb06cff, 0x2ec4b6, 0xe8434f, 0x9bdc3a, 0x56b4ff, 0xff8fb8, 0xf7a34b];

/** 一叢珊瑚：鹿角珊瑚、腦珊瑚、桌珊瑚、海扇、管狀海綿混在一起（直徑約 5 公尺） */
function coralPatch(seed: number, lite = false): THREE.BufferGeometry {
  const r = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const col = () => CORAL_COLS[Math.floor(r() * CORAL_COLS.length)];
  const put = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number, k: number) => {
    e.set(rx, ry, rz);
    q.setFromEuler(e);
    m.compose(v.set(x, y, z), q, s.set(k, k, k));
    parts.push(g.applyMatrix4(m));
  };
  // 低畫質：一叢只放 3~4 個，三角形少一半
  const pieces = lite ? 3 + Math.floor(r() * 2) : 5 + Math.floor(r() * 3);
  for (let p = 0; p < pieces; p++) {
    const a = r() * TAU, d = Math.sqrt(r()) * 2.3;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const kind = Math.floor(r() * 5);
    const c = col();
    const k = 0.7 + r() * 0.8;
    if (kind === 0) {
      // 鹿角珊瑚：樹枝一路分岔
      const branches: THREE.BufferGeometry[] = [];
      const grow = (bx: number, by: number, bz: number, dir: THREE.Vector3, len: number, rad: number, depth: number) => {
        const end = new THREE.Vector3(bx, by, bz).addScaledVector(dir, len);
        const cyl = new THREE.CylinderGeometry(rad * 0.7, rad, len, 5, 1, true).translate(0, len / 2, 0);
        const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        branches.push(cyl.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(bx, by, bz), qq, new THREE.Vector3(1, 1, 1))));
        if (depth <= 0) {
          branches.push(new THREE.OctahedronGeometry(rad * 0.85, 0).translate(end.x, end.y, end.z));
          return;
        }
        const nb = 3 + (r() < 0.4 ? 1 : 0);
        for (let b = 0; b < nb; b++) {
          const d2 = dir.clone().applyAxisAngle(new THREE.Vector3(r() - 0.5, 0, r() - 0.5).normalize(), 0.45 + r() * 0.4).normalize();
          grow(end.x, end.y, end.z, d2, len * (0.65 + r() * 0.2), rad * 0.72, depth - 1);
        }
      };
      grow(0, 0, 0, new THREE.Vector3(0, 1, 0), 0.8 + r() * 0.3, 0.15, 1);
      const g = paint(mergeGeometries(branches.map((b) => (b.index ? b.toNonIndexed() : b)))!, solid(c), 0.1, p);
      put(g, x, -0.05, z, 0, r() * TAU, 0, k);
    } else if (kind === 1) {
      // 腦珊瑚：壓扁的凹凸圓球，表面一圈圈深淺紋
      const base = new THREE.Color(c);
      const g = paint(lumpy(new THREE.IcosahedronGeometry(0.85, 1), 0.07, seed + p).scale(1, 0.62, 1), (xx, yy, zz, _ny, out) => {
        const band = 0.5 + 0.5 * Math.sin((xx * 3.1 + zz * 2.3 + yy * 4) * 3);
        out.copy(base).multiplyScalar(0.7 + band * 0.4);
      }, 0.05, p);
      put(g, x, 0.1, z, 0, r() * TAU, 0, k);
    } else if (kind === 2) {
      // 桌珊瑚：短柄上一片平平的圓盤
      const g = paint(mergeGeometries([
        new THREE.CylinderGeometry(0.16, 0.24, 0.9, 6).translate(0, 0.45, 0).toNonIndexed(),
        lumpy(new THREE.CylinderGeometry(1.25, 1.05, 0.16, 10), 0.05, seed + p).translate(0, 0.95, 0),
      ].map((gg) => { for (const kk of Object.keys(gg.attributes)) if (kk !== 'position') gg.deleteAttribute(kk); return gg; }))!, solid(c), 0.1, p);
      put(g, x, -0.05, z, (r() - 0.5) * 0.25, r() * TAU, (r() - 0.5) * 0.25, k);
    } else if (kind === 3) {
      // 海扇：直立的薄扇面
      const g = paint(lumpy(new THREE.SphereGeometry(1, 7, 3, 0, TAU, 0, Math.PI / 2), 0.05, seed + p).scale(1.1, 1.45, 0.07), solid(c), 0.14, p);
      put(g, x, -0.05, z, 0, r() * TAU, 0, k);
    } else {
      // 管狀海綿：幾根粗細不同的管子
      const tubes: THREE.BufferGeometry[] = [];
      const n = 3 + Math.floor(r() * 3);
      for (let t = 0; t < n; t++) {
        const h = 0.8 + r() * 1.4, rad = 0.16 + r() * 0.14;
        tubes.push(new THREE.CylinderGeometry(rad, rad * 0.85, h, 6, 1, false).translate((r() - 0.5) * 0.7, h / 2, (r() - 0.5) * 0.7).rotateZ((r() - 0.5) * 0.3).toNonIndexed());
      }
      tubes.forEach((gg) => { for (const kk of Object.keys(gg.attributes)) if (kk !== 'position') gg.deleteAttribute(kk); });
      const g = paint(mergeGeometries(tubes)!, solid(c), 0.1, p);
      put(g, x, -0.05, z, 0, r() * TAU, 0, k);
    }
  }
  return mergeGeometries(parts)!;
}

/** 礁岩：凹凸的石塊，頂面長了一層綠褐色的藻 */
function rockGeo(seed: number, dark: boolean): THREE.BufferGeometry {
  const side = new THREE.Color(dark ? 0x2f3a46 : 0x5f6b74), top = new THREE.Color(dark ? 0x31445a : 0x6f7d4c);
  return paint(lumpy(new THREE.DodecahedronGeometry(1, 1), 0.12, seed), (_x, _y, _z, ny, out) => {
    out.copy(side).lerp(top, sstep(0.35, 0.75, ny));
  }, 0.12, seed);
}

/** 海溝的岩壁：圓鈍、坑坑疤疤的大岩塊，深石板色，零星幾點發光的藻 */
function cliffGeo(seed: number): THREE.BufferGeometry {
  const base = new THREE.Color(0x27333f), top = new THREE.Color(0x2e4d55), speck = new THREE.Color(0x46e0f0);
  return paint(lumpy(new THREE.IcosahedronGeometry(1, 2), 0.13, seed), (x, y, z, ny, out) => {
    out.copy(base).lerp(top, sstep(0.3, 0.9, ny) * 0.7);
    if (hash2(Math.round(x * 9), Math.round(y * 9 + z * 7), seed) > 0.982) out.copy(speck);
  }, 0.12, seed);
}

/** 海藻：兩片交叉的長葉帶（高 1，往上越來越窄），根部深橄欖綠、葉尖金黃 */
function kelpGeo(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const lo = new THREE.Color(0x3a5420), hi = new THREE.Color(0xc0a43a);
  const SEG = 6;
  for (const rot of [0, Math.PI / 2]) {
    const cx = Math.cos(rot), cz = Math.sin(rot);
    for (let s = 0; s < SEG; s++) {
      const y0 = s / SEG, y1 = (s + 1) / SEG;
      const w = (y: number) => 0.32 * (1 - y * 0.55) * (0.8 + 0.2 * Math.sin(y * 19));
      const a = [-cx * w(y0), y0, -cz * w(y0)], b = [cx * w(y0), y0, cz * w(y0)], c = [cx * w(y1), y1, cz * w(y1)], d = [-cx * w(y1), y1, -cz * w(y1)];
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (const y of [y0, y0, y1, y0, y1, y1]) { const k = lo.clone().lerp(hi, Math.pow(y, 0.8)); col.push(k.r, k.g, k.b); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // 法線朝上偏外：葉片亮度一致，不會因為角度忽明忽暗
  const nor = new Float32Array(pos.length);
  for (let i = 0; i < nor.length; i += 3) { nor[i + 1] = 1; }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/** 海溝裡發光的管蟲／海葵：細梗加一顆亮球，一叢 6 根 */
function glowPlantGeo(): THREE.BufferGeometry {
  const r = mulberry32(5);
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const a = r() * TAU, d = r() * 0.9, h = 0.5 + r() * 1.3;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    parts.push(new THREE.CylinderGeometry(0.035, 0.06, h, 4, 1, true).translate(x, h / 2, z).toNonIndexed());
    parts.push(new THREE.IcosahedronGeometry(0.13 + r() * 0.08, 0).translate(x, h, z));
  }
  parts.forEach((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k); });
  return mergeGeometries(parts)!;
}

// ---------- 沉船 ----------

/** 船身的一段（z 從 z0 到 z1，船長 Lh、寬 Bh、深 Dh）：U 形斷面，甲板在 y = 0 */
function hullGeo(z0: number, z1: number, Lh: number, Bh: number, Dh: number): { hull: THREE.BufferGeometry; deck: THREE.BufferGeometry } {
  const half = Lh / 2;
  const width = (z: number) => {
    const u = z / half;
    return u > 0 ? (Bh / 2) * Math.max(0.04, 1 - Math.pow(u, 2.2)) : (Bh / 2) * Math.max(0.3, 1 - Math.pow(-u, 6));
  };
  const depth = (z: number) => Dh * (1 - Math.pow(Math.abs(z / half), 8) * 0.5);
  const ST = 14, J = 10;
  const pos: number[] = [], uv: number[] = [];
  const P = (z: number, j: number): [number, number, number, number] => {
    const ph = (j / J) * Math.PI;
    const c = Math.cos(ph), s = Math.sin(ph);
    const x = width(z) * Math.sign(c) * Math.pow(Math.abs(c), 0.55);
    const y = -depth(z) * Math.pow(s, 0.7);
    return [x, y + 0.6 * Math.pow(Math.abs(z / half), 3), z, j / J];
  };
  for (let i = 0; i < ST; i++) {
    const za = z0 + ((z1 - z0) * i) / ST, zb = z0 + ((z1 - z0) * (i + 1)) / ST;
    for (let j = 0; j < J; j++) {
      const a = P(za, j), b = P(za, j + 1), c = P(zb, j), d = P(zb, j + 1);
      for (const p of [a, c, b, b, c, d]) { pos.push(p[0], p[1], p[2]); uv.push(p[2] / 7, p[3] * 2.2); }
    }
  }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hull.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  hull.computeVertexNormals();
  const dp: number[] = [], du: number[] = [];
  for (let i = 0; i < ST; i++) {
    const za = z0 + ((z1 - z0) * i) / ST, zb = z0 + ((z1 - z0) * (i + 1)) / ST;
    const ya = 0.6 * Math.pow(Math.abs(za / half), 3), yb = 0.6 * Math.pow(Math.abs(zb / half), 3);
    const wa = width(za) * 0.97, wb = width(zb) * 0.97;
    const a = [-wa, ya, za], b = [wa, ya, za], c = [-wb, yb, zb], d = [wb, yb, zb];
    for (const p of [a, b, c, b, d, c]) { dp.push(...p); du.push(p[0] / 4, p[2] / 4); }
  }
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  deck.setAttribute('uv', new THREE.Float32BufferAttribute(du, 2));
  deck.computeVertexNormals();
  return { hull, deck };
}

// ---------- 主程式 ----------

export interface OceanCtx {
  track: Track;
  /** 地形高度 */
  terrainH(x: number, z: number): number;
  /** oceanGlass() 的結果 */
  glass: Uint8Array;
  /** 已經擺好的景物（看台、維修區…），珊瑚與岩石要避開 */
  props: THREE.Object3D;
  shadows: boolean;
  lowDetail: boolean;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface Ocean {
  group: THREE.Group;
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** 建圖最後呼叫：替整個場景的材質加上焦散光，並接手天空的顏色（依深度變化） */
  finish(root: THREE.Object3D, sky: THREE.ShaderMaterial): void;
}

/** 依取樣點建的格點索引：找最近的主線／捷徑取樣點 */
class Near {
  private cell = 12;
  private map = new Map<number, number[]>();
  constructor(private pts: { x: number; z: number }[]) {
    pts.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.z / this.cell));
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(i);
    });
  }
  private key(i: number, j: number) { return (i + 4096) * 8192 + (j + 4096); }
  /** 最近的點（maxR 以內，找不到回傳 -1）；距離寫進 this.d */
  d = Infinity;
  find(x: number, z: number, maxR: number): number {
    const c = this.cell, R = Math.ceil(maxR / c);
    const ci = Math.floor(x / c), cj = Math.floor(z / c);
    let best = -1, bd = maxR * maxR;
    // 一圈一圈往外找，找到的點比下一圈還近就停
    for (let ring = 0; ring <= R; ring++) {
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
        const a = this.map.get(this.key(i, j));
        if (!a) continue;
        for (const k of a) {
          const p = this.pts[k];
          const d = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
      }
      if (best >= 0 && bd <= (ring * c) ** 2) break;
    }
    this.d = best >= 0 ? Math.sqrt(bd) : Infinity;
    return best;
  }
}

export function buildOcean(ctx: OceanCtx): Ocean {
  const { track, terrainH, glass, shadows } = ctx;
  const lay = LAYOUTS[track.def.id];
  const tier = detailTier(ctx.lowDetail);
  const T = TIERS[tier];
  const group = new THREE.Group();
  group.name = 'ocean';
  const S = track.samples, n = track.n, L = track.length, hw = track.halfWidth, sp = track.spacing;
  const A = tubeA(hw), B = TUBE_H;
  const rng = mulberry32(4711);
  const uTime = { value: 0 };
  const updaters: ((dt: number, time: number) => void)[] = [];
  const wrap = (i: number) => ((i % n) + n) % n;
  const idxAt = (d: number) => wrap(Math.round((((d % L) + L) % L) / sp));
  const zoneAt = (d: number): Zone => {
    for (const [a, b, z] of lay.zones) if (inSpan(d, a, b, L)) return z;
    return 'reef';
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v3 = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const yawOf = (s: Sample) => Math.atan2(s.tx, s.tz);
  const add = (g: THREE.BufferGeometry | null, mat: THREE.Material, cast = false, receive = true): THREE.Mesh | null => {
    if (!g) return null;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = shadows && cast;
    m.receiveShadow = shadows && receive;
    group.add(m);
    return m;
  };
  const near = new Near(S);
  const BR = track.branches;
  const brPts: { x: number; z: number; b: number }[] = [];
  BR.forEach((b, bi) => b.samples.forEach((s) => brPts.push({ x: s.x, z: s.z, b: bi })));
  const nearBr = new Near(brPts);

  // ---------- 材質 ----------
  const glassMat = glassMaterial(uTime, 0x9fe6ff, 0.03, 0.4, [7, 1]);
  const steel = new THREE.MeshStandardMaterial({ color: 0xaebfcc, metalness: 0.65, roughness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x33414f, metalness: 0.5, roughness: 0.5 });
  const ledCyan = new THREE.MeshBasicMaterial({ color: glow(0x5ff2ff, 1.7) });
  const ledWarm = new THREE.MeshBasicMaterial({ color: glow(0xffe2a8, 1.8) });
  const ledCool = new THREE.MeshBasicMaterial({ color: glow(0xd8fbff, 1.25) });

  // ---------- 捷徑出入口：主線玻璃要開口的地方（跟 world.ts 的護欄缺口一樣的判斷） ----------
  const inBranch = (x: number, z: number, margin: number): boolean => {
    for (const b of BR) {
      if (!b.inBox(x, z)) continue;
      b.locate(x, z);
      if (b.inside() && Math.abs(b.lat) < b.halfWidth + margin) return true;
    }
    return false;
  };
  const open: Record<number, Uint8Array> = { 1: new Uint8Array(n), [-1]: new Uint8Array(n) };
  if (BR.length) for (let i = 0; i < n; i++) for (const sg of [1, -1]) {
    const s = S[i];
    // 開口比路面護欄的缺口前後多留一點，碎玻璃邊緣才不會擋在出入口
    if (inBranch(s.x + s.nx * sg * (hw + 0.6), s.z + s.nz * sg * (hw + 0.6), 1.2)) open[sg][i] = 1;
  }

  // ---------- 玻璃隧道 ----------
  const STEP = 2; // 每 3 公尺一圈
  {
    const K = 14;
    const prof = ellipseProfile(A, B, K);
    // 連續的玻璃段：切成每段最多 90 圈（約 270 公尺），各自做視錐剔除
    const runs: number[][] = [];
    let cur: number[] = [];
    // 從一個不是玻璃的地方開始走一圈，玻璃段才不會被起點切斷
    let start = 0;
    while (start < n && glass[start]) start++;
    for (let k = 0; k <= n; k += STEP) {
      const i = wrap(start + k);
      if (glass[i] || (cur.length && glass[wrap(i - 1)])) {
        cur.push(i);
        if (cur.length >= 90) { runs.push(cur); cur = [i]; }
      } else if (cur.length) { runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    const cutL = (i: number) => 0.33 + (hash2(i, 3) - 0.5) * 0.12, cutR = (i: number) => 0.67 + (hash2(i, 5) - 0.5) * 0.12;
    for (const rings of runs) {
      const vOf = (r: number) => {
        // 沿賽道的貼圖座標用實際距離（跨過起點時接續）
        const d0 = S[rings[0]].dist;
        let d = S[rings[r]].dist - d0;
        if (d < -1) d += L;
        return (d0 + d) / 6;
      };
      const seg = (r: number, k: number) => {
        const i = rings[r], j = rings[Math.min(rings.length - 1, r + 1)];
        if (!glass[i] && !glass[j]) return false;
        const u = (k + 0.5) / K;
        // 捷徑那一側：下半部的玻璃碎掉，留下參差的邊
        if ((open[1][i] || open[1][j]) && u < cutL(i)) return false;
        if ((open[-1][i] || open[-1][j]) && u > cutR(i)) return false;
        return true;
      };
      const g = sweep(S, rings, prof, vOf, seg);
      const m = add(g, glassMat, false, false);
      if (m) m.renderOrder = 2;
    }

    // 路緣到玻璃之間的鋼格柵、底部的踢腳板與燈條（捷徑開口處不放）
    const glassRings: number[] = [];
    for (let i = 0; i < n; i += STEP) glassRings.push(i);
    glassRings.push(0);
    const vD = (r: number) => (r === glassRings.length - 1 ? L : S[glassRings[r]].dist) / 4;
    const on = (sg: number) => (r: number) => {
      const i = glassRings[r], j = glassRings[r + 1];
      return !!glass[i] && !!glass[j] && !open[sg][i] && !open[sg][j];
    };
    const grate = canvasTex(64, 64, (c) => {
      c.fillStyle = '#2a333c';
      c.fillRect(0, 0, 64, 64);
      c.fillStyle = '#56636f';
      for (let k = 0; k < 64; k += 8) { c.fillRect(k, 0, 3, 64); c.fillRect(0, k, 64, 2); }
    });
    const grateMat = new THREE.MeshLambertMaterial({ map: grate });
    for (const sg of [1, -1]) {
      const okR = on(sg);
      const segOk = (r: number) => okR(r);
      // 斷面的點要往 +lat 方向排，面才會朝上
      const flat: ProfPt[] = sg > 0
        ? [{ lat: hw - 0.05, y: 0.02, nl: 0, ny: 1, u: 0 }, { lat: A + 0.05, y: 0.02, nl: 0, ny: 1, u: 1 }]
        : [{ lat: -(A + 0.05), y: 0.02, nl: 0, ny: 1, u: 0 }, { lat: -(hw - 0.05), y: 0.02, nl: 0, ny: 1, u: 1 }];
      add(sweep(S, glassRings, flat, vD, segOk), grateMat);
      const kick: ProfPt[] = [{ lat: sg * (A - 0.06), y: -0.8, nl: -sg, ny: 0, u: 0 }, { lat: sg * (A - 0.06), y: 0.82, nl: -sg, ny: 0, u: 1 }];
      add(sweep(S, glassRings, sg > 0 ? kick : [...kick].reverse(), vD, segOk), darkSteel, false);
      const led: ProfPt[] = [{ lat: sg * (A - 0.1), y: 0.82, nl: -sg, ny: 0, u: 0 }, { lat: sg * (A - 0.1), y: 0.98, nl: -sg, ny: 0, u: 1 }];
      add(sweep(S, glassRings, sg > 0 ? led : [...led].reverse(), vD, segOk), ledCyan, false, false);
      // 頂上的兩排燈板（一段亮、一段空）
      const la = sg * 3.4, yTop = B * Math.sqrt(1 - (3.4 / A) ** 2) - 0.12;
      const strip: ProfPt[] = [{ lat: la + 0.14, y: yTop, nl: 0, ny: -1, u: 0 }, { lat: la - 0.14, y: yTop, nl: 0, ny: -1, u: 1 }];
      add(sweep(S, glassRings, strip, vD, (r) => r % 3 === 0 && !!glass[glassRings[r]] && !!glass[glassRings[r + 1]]), ledCool, false, false);
    }

    // 鋼肋：每 12 公尺一道；隧道出入口加一圈厚的門框
    const ribs: THREE.Matrix4[] = [], collars: THREE.Matrix4[] = [], lights: THREE.Matrix4[] = [];
    const place = (s: Sample, list: THREE.Matrix4[], scale = 1, along = 1) => {
      q.setFromAxisAngle(up, yawOf(s));
      m4.compose(v3.set(s.x, s.y, s.z), q, sc.set(scale, scale, along));
      list.push(m4.clone());
    };
    for (let i = 0; i < n; i += 8) {
      if (!glass[i] || open[1][i] || open[-1][i]) continue;
      place(S[i], ribs);
      if (T.ribLights) for (const th of [0.42, Math.PI / 2, Math.PI - 0.42]) {
        const s = S[i];
        const lat = (A - 0.15) * Math.cos(th), y = (B - 0.15) * Math.sin(th);
        m4.compose(v3.set(s.x + s.nx * lat, s.y + y, s.z + s.nz * lat), q.setFromAxisAngle(up, yawOf(s)), sc.set(1, 1, 1));
        lights.push(m4.clone());
      }
    }
    for (let i = 0; i < n; i++) {
      if (glass[i] && (!glass[wrap(i - 1)] || !glass[wrap(i + 1)])) place(S[i], collars, 1.06, 3);
    }
    const ribG = ribGeo(A, B, 0.55, 0.42, tier === 0 ? 10 : 18);
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], cast: boolean): THREE.InstancedMesh | null => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.computeBoundingSphere();
      im.castShadow = shadows && cast;
      im.receiveShadow = shadows;
      group.add(im);
      return im;
    };
    inst(ribG, steel, ribs, true);
    inst(ribGeo(A, B, 1.4, 0.9), darkSteel, collars, true);
    inst(new THREE.BoxGeometry(0.5, 0.18, 0.7), ledCyan, lights, false);

    // 轉彎外側玻璃上的全息箭頭（往前流動）
    const chev = canvasTex(64, 128, (c) => {
      c.clearRect(0, 0, 64, 128);
      c.fillStyle = '#000';
      c.fillRect(0, 0, 64, 128);
      c.strokeStyle = '#fff';
      c.lineWidth = 11;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(8, 92); c.lineTo(32, 40); c.lineTo(56, 92);
      c.stroke();
    });
    const chevMat = new THREE.MeshBasicMaterial({ map: chev, color: glow(0xffc23a, 1.3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const corner = (i: number, sg: number) => {
      for (let k = -6; k <= 6; k += 3) {
        const c = S[wrap(i + k)].curv;
        if (Math.abs(c) < 0.017 || Math.sign(c) === sg) return false;
      }
      return !!glass[i] && !open[sg][i];
    };
    for (const sg of [1, -1]) {
      const chRings: number[] = [];
      for (let i = 0; i < n; i += 1) chRings.push(i);
      chRings.push(0);
      const y0 = 2.4, y1 = 4.1;
      const latAt = (y: number) => sg * (A * Math.sqrt(Math.max(0, 1 - (y / B) ** 2)) - 0.12);
      const pr: ProfPt[] = [{ lat: latAt(y0), y: y0, nl: -sg, ny: 0, u: 0 }, { lat: latAt(y1), y: y1, nl: -sg, ny: 0, u: 1 }];
      const g = sweep(S, chRings, sg > 0 ? pr : [...pr].reverse(), (r) => (r === chRings.length - 1 ? L : S[chRings[r]].dist) / 3.2, (r) => corner(chRings[r], sg) && corner(chRings[r + 1], sg));
      const m = add(g, chevMat, false, false);
      if (m) m.renderOrder = 3;
    }
    updaters.push((_dt, time) => { chev.offset.y = -(time * 0.9) % 1; });
  }

  // ---------- 起點大廳 ----------
  const hallIdx: number[] = [];
  for (let i = 0; i < n; i++) if (inSpan(S[i].dist, lay.hall.from, lay.hall.to, L)) hallIdx.push(i);
  // 依沿賽道的順序排好（跨過起點）
  hallIdx.sort((a, b) => ((((S[a].dist - lay.hall.from) % L) + L) % L) - ((((S[b].dist - lay.hall.from) % L) + L) % L));
  const H = lay.hall;
  let floorY = -Infinity;
  if (hallIdx.length > 2) {
    const s0 = S[hallIdx[0]];
    // 地板高度：整個大廳範圍內地形的最高點，地形才不會穿出地板
    for (let k = 0; k < hallIdx.length; k += 4) {
      const s = S[hallIdx[k]];
      for (let lat = hw + 4; lat <= H.half; lat += 6) for (const sg of [1, -1]) floorY = Math.max(floorY, terrainH(s.x + s.nx * sg * lat, s.z + s.nz * sg * lat));
    }
    floorY = Math.min(floorY + 0.06, s0.y - 0.6);
    const yOff = (i: number) => floorY - S[i].y;
    const rings: number[] = [];
    for (let k = 0; k < hallIdx.length; k += 2) rings.push(hallIdx[k]);
    if (rings[rings.length - 1] !== hallIdx[hallIdx.length - 1]) rings.push(hallIdx[hallIdx.length - 1]);
    const yo = yOff(rings[0]);
    const vOf = (r: number) => r * 2 * sp / 12;
    // 拱頂玻璃（底部往下多一圈裙邊，蓋住地板與地形的縫）
    const vault = ellipseProfile(H.half, H.height, 24, yo);
    vault.unshift({ lat: H.half, y: yo - 5, nl: 1, ny: 0, u: 0 });
    vault.push({ lat: -H.half, y: yo - 5, nl: -1, ny: 0, u: 1 });
    const hallGlass = glassMaterial(uTime, 0xa8ecff, 0.02, 0.22, [16, 1]);
    const vm = add(sweep(S, rings, vault, vOf), hallGlass, false, false);
    if (vm) vm.renderOrder = 2;
    // 地板：磨石子地磚，中間是賽道的路基
    const floorTex = canvasTex(256, 256, (c) => {
      c.fillStyle = '#7f95a3';
      c.fillRect(0, 0, 256, 256);
      const r = mulberry32(8);
      for (let k = 0; k < 900; k++) {
        c.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(20,40,60,0.12)';
        c.fillRect(r() * 256, r() * 256, 2, 2);
      }
      c.fillStyle = 'rgba(30,50,70,0.55)';
      for (let k = 0; k <= 256; k += 64) { c.fillRect(k - 1, 0, 2, 256); c.fillRect(0, k - 1, 256, 2); }
      c.fillStyle = 'rgba(80,230,255,0.5)';
      c.fillRect(0, 126, 256, 4);
    });
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.45, metalness: 0.1 });
    for (const sg of [1, -1]) {
      const pr: ProfPt[] = [{ lat: sg * (hw + 0.95), y: yo, nl: 0, ny: 1, u: 0 }, { lat: sg * H.half, y: yo, nl: 0, ny: 1, u: (H.half - hw) / 8 }];
      add(sweep(S, rings, sg > 0 ? pr : [...pr].reverse(), (r) => (r * 2 * sp) / 8), floorMat);
    }
    // 拱架：每 18 公尺一道，頂上一排燈
    const arches: THREE.Matrix4[] = [], lamps: THREE.Matrix4[] = [];
    for (let k = 0; k < hallIdx.length; k += 12) {
      const s = S[hallIdx[k]];
      q.setFromAxisAngle(up, yawOf(s));
      m4.compose(v3.set(s.x, s.y + yo, s.z), q, sc.set(1, 1, 1));
      arches.push(m4.clone());
      for (const th of [0.75, 1.2, Math.PI / 2, Math.PI - 1.2, Math.PI - 0.75]) {
        const lat = (H.half - 0.6) * Math.cos(th), y = yo + (H.height - 0.6) * Math.sin(th);
        m4.compose(v3.set(s.x + s.nx * lat, s.y + y, s.z + s.nz * lat), q, sc.set(1, 1, 1));
        lamps.push(m4.clone());
      }
    }
    const archIm = new THREE.InstancedMesh(ribGeo(H.half, H.height, 1.1, 0.9, 30), steel, arches.length);
    arches.forEach((mm, k) => archIm.setMatrixAt(k, mm));
    archIm.computeBoundingSphere();
    archIm.castShadow = shadows;
    group.add(archIm);
    const lampIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.3, 1.6), ledWarm, lamps.length);
    lamps.forEach((mm, k) => lampIm.setMatrixAt(k, mm));
    lampIm.computeBoundingSphere();
    group.add(lampIm);
    // 兩端的牆：半橢圓的鋼板，中間開一個隧道口；朝大廳那一面掛著園區的看板
    const wallShape = new THREE.Shape();
    for (let k = 0; k <= 40; k++) {
      const th = (k / 40) * Math.PI;
      const x = H.half * Math.cos(th), y = yo + H.height * Math.sin(th);
      if (k === 0) wallShape.moveTo(x, yo - 5);
      wallShape.lineTo(x, y);
    }
    wallShape.lineTo(-H.half, yo - 5);
    wallShape.closePath();
    const hole = new THREE.Path();
    for (let k = 0; k <= 24; k++) {
      const th = (k / 24) * Math.PI;
      const x = (A + 0.4) * Math.cos(th), y = (B + 0.4) * Math.sin(th);
      if (k === 0) hole.moveTo(x, -2.4);
      hole.lineTo(x, y);
    }
    hole.lineTo(-(A + 0.4), -2.4);
    hole.closePath();
    wallShape.holes.push(hole);
    const wallGeo = new THREE.ShapeGeometry(wallShape, 4);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x29445a, metalness: 0.45, roughness: 0.55, side: THREE.DoubleSide });
    const signTex = canvasTex(1024, 256, (c) => {
      const g = c.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#0b2a3d');
      g.addColorStop(1, '#06324a');
      c.fillStyle = g;
      c.fillRect(0, 0, 1024, 256);
      c.strokeStyle = '#5ff2ff';
      c.lineWidth = 8;
      c.strokeRect(10, 10, 1004, 236);
      c.textAlign = 'center';
      c.fillStyle = '#e9fbff';
      c.font = 'bold 104px "Segoe UI", "Microsoft JhengHei", sans-serif';
      c.fillText('蔚藍海廊', 512, 128);
      c.fillStyle = '#5ff2ff';
      c.font = 'bold 44px "Segoe UI", Arial, sans-serif';
      c.fillText('OCEAN RESEARCH PARK', 512, 206);
    }, false);
    const signMat = new THREE.MeshBasicMaterial({ map: signTex, color: glow(0xffffff, 1.25) });
    for (const end of [0, 1]) {
      const s = S[end ? hallIdx[hallIdx.length - 1] : hallIdx[0]];
      const w = new THREE.Mesh(wallGeo, wallMat);
      w.position.set(s.x, s.y, s.z);
      w.rotation.y = yawOf(s);
      w.receiveShadow = shadows;
      group.add(w);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(26, 6.5), signMat);
      // 看板掛在隧道口上方、朝大廳裡面
      const dir = end ? -1 : 1;
      sign.position.set(s.x + s.tx * dir * 0.6, s.y + B + 5.5, s.z + s.tz * dir * 0.6);
      sign.rotation.y = yawOf(s) + (end ? Math.PI : 0);
      group.add(sign);
      // 隧道口的門框
      const frame = new THREE.Mesh(ribGeo(A + 0.4, B + 0.4, 1.8, 1.2), darkSteel);
      frame.position.set(s.x, s.y, s.z);
      frame.rotation.y = yawOf(s);
      group.add(frame);
      const frameLed = new THREE.Mesh(ribGeo(A + 0.25, B + 0.25, 0.3, 0.2), ledCyan);
      frameLed.position.set(s.x + s.tx * dir * 0.95, s.y, s.z + s.tz * dir * 0.95);
      frameLed.rotation.y = yawOf(s);
      group.add(frameLed);
    }
    // 拱頂中央一條長燈帶
    const top: ProfPt[] = [{ lat: 0.8, y: yo + H.height - 0.5, nl: 0, ny: -1, u: 0 }, { lat: -0.8, y: yo + H.height - 0.5, nl: 0, ny: -1, u: 1 }];
    add(sweep(S, rings, top, vOf), ledCyan, false, false);
  }

  // ---------- 珊瑚廣場的大圓頂 ----------
  let plaza: { x: number; z: number; R: number; Hd: number; y0: number } | null = null;
  {
    const P = lay.plaza;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (inSpan(S[i].dist, P.from, P.to, L)) idx.push(i);
    if (idx.length) {
      let cx = 0, cz = 0, ry = 0;
      for (const i of idx) { cx += S[i].x; cz += S[i].z; ry += S[i].y; }
      cx /= idx.length; cz /= idx.length; ry /= idx.length;
      let R = 0;
      for (const i of idx) {
        const s = S[i];
        for (const sg of [1, -1]) {
          const lat = sg * (hw + track.runoffW(i, sg) + 6);
          R = Math.max(R, Math.hypot(s.x + s.nx * lat - cx, s.z + s.nz * lat - cz));
        }
      }
      R += 4;
      const Hd = Math.min(40, R * 0.5);
      // 底部高度：路面往下一點（路肩斜坡的底），地基再往下埋
      const y0 = ry - 3.4;
      plaza = { x: cx, z: cz, R, Hd, y0 };
      const dome = new THREE.SphereGeometry(1, 48, 14, 0, TAU, 0, Math.PI / 2).scale(R, Hd, R).translate(cx, y0, cz).toNonIndexed();
      // 隧道穿過圓頂的地方挖洞（三角形的中心落在隧道斷面裡就拿掉）
      const pa = dome.attributes.position, na = dome.attributes.normal, ua = dome.attributes.uv;
      const keep: number[] = [];
      for (let t = 0; t < pa.count; t += 3) {
        const x = (pa.getX(t) + pa.getX(t + 1) + pa.getX(t + 2)) / 3, y = (pa.getY(t) + pa.getY(t + 1) + pa.getY(t + 2)) / 3, z = (pa.getZ(t) + pa.getZ(t + 1) + pa.getZ(t + 2)) / 3;
        const i = near.find(x, z, A + 20);
        if (i >= 0) {
          const s = S[i];
          const lat = (x - s.x) * s.nx + (z - s.z) * s.nz, hy = y - s.y;
          if (Math.abs(lat) < A + 1.8 && hy < B + 1.8 && hy > -4) continue;
        }
        keep.push(t);
      }
      const dp = new Float32Array(keep.length * 9), dn = new Float32Array(keep.length * 9), du = new Float32Array(keep.length * 6);
      keep.forEach((t, k) => {
        for (let j = 0; j < 3; j++) {
          dp.set([pa.getX(t + j), pa.getY(t + j), pa.getZ(t + j)], (k * 3 + j) * 3);
          dn.set([na.getX(t + j), na.getY(t + j), na.getZ(t + j)], (k * 3 + j) * 3);
          du.set([ua.getX(t + j), ua.getY(t + j)], (k * 3 + j) * 2);
        }
      });
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
      dg.setAttribute('normal', new THREE.BufferAttribute(dn, 3));
      dg.setAttribute('uv', new THREE.BufferAttribute(du, 2));
      const dm = add(dg, glassMaterial(uTime, 0xa8ecff, 0.02, 0.26, [24, 7]), false, false);
      if (dm) dm.renderOrder = 2;
      // 經線鋼架與兩圈緯線，底下一圈地基
      const mer = ribGeo(R, Hd, 0.9, 0.7, 26);
      const merIm = new THREE.InstancedMesh(mer, steel, 6);
      for (let k = 0; k < 6; k++) {
        m4.compose(v3.set(cx, y0, cz), q.setFromAxisAngle(up, (k / 6) * Math.PI), sc.set(1, 1, 1));
        merIm.setMatrixAt(k, m4);
      }
      merIm.computeBoundingSphere();
      group.add(merIm);
      for (const f of [0.42, 0.78]) {
        const rr = R * Math.sqrt(1 - f * f);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.45, 5, 64).rotateX(Math.PI / 2), steel);
        ring.position.set(cx, y0 + Hd * f, cz);
        group.add(ring);
      }
      const base = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.6, R + 1.2, 7, 64, 1, true), new THREE.MeshLambertMaterial({ color: 0x6d7f8a, side: THREE.DoubleSide }));
      base.position.set(cx, y0 - 2.4, cz);
      group.add(base);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.12, R * 0.14, 1.2, 24), darkSteel);
      crown.position.set(cx, y0 + Hd - 0.3, cz);
      group.add(crown);
      const crownLed = new THREE.Mesh(new THREE.TorusGeometry(R * 0.13, 0.25, 4, 32).rotateX(Math.PI / 2), ledCyan);
      crownLed.position.set(cx, y0 + Hd - 0.9, cz);
      group.add(crownLed);
    }
  }

  // ---------- 斷管捷徑：殘存的鋼肋、碎玻璃、邊緣警示燈，底下裂縫的藍光 ----------
  const abyss: { x: number; y: number; z: number }[] = [];
  for (const b of BR) {
    const hb = b.halfWidth;
    const out = b.samples.map((s) => { track.locate(s.x, s.z, -1); return Math.abs(track.lat) > hw + 1.5; });
    const Ab = hb + 1.1, Bb = 6.2;
    const left = ribGeo(Ab, Bb, 0.4, 0.32, 9, 0, Math.PI / 2), right = ribGeo(Ab, Bb, 0.4, 0.32, 9, Math.PI / 2, Math.PI);
    const ls: THREE.Matrix4[] = [], rs: THREE.Matrix4[] = [], beacons: THREE.Matrix4[] = [];
    const r = mulberry32(31);
    for (let i = 2; i < b.n - 2; i += 6) {
      if (!out[i]) continue;
      const s = b.samples[i];
      e.set((r() - 0.5) * 0.12, yawOf(s), (r() - 0.5) * 0.2);
      q.setFromEuler(e);
      m4.compose(v3.set(s.x, s.y - 0.3, s.z), q, sc.set(1, 1, 1));
      // 有的肋斷了一邊
      const br = r();
      if (br > 0.22) ls.push(m4.clone());
      if (br < 0.78) rs.push(m4.clone());
    }
    for (let i = 0; i < b.n; i += 2) {
      if (!out[i]) continue;
      const s = b.samples[i];
      for (const sg of [1, -1]) {
        m4.compose(v3.set(s.x + s.nx * sg * (hb + 0.06), s.y + 0.08, s.z + s.nz * sg * (hb + 0.06)), q.setFromAxisAngle(up, yawOf(s)), sc.set(1, 1, 1));
        beacons.push(m4.clone());
      }
      if (i % 4 === 0) abyss.push({ x: s.x, y: s.y, z: s.z });
    }
    for (const [geo, list] of [[left, ls], [right, rs]] as [THREE.BufferGeometry, THREE.Matrix4[]][]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, steel, list.length);
      list.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.computeBoundingSphere();
      im.castShadow = shadows;
      group.add(im);
    }
    // 邊緣的琥珀色警示燈（一起閃）
    const blinkMat = new THREE.MeshBasicMaterial({ color: glow(0xffa53a, 2) });
    const bIm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.14, 0.5), blinkMat, beacons.length);
    beacons.forEach((mm, k) => bIm.setMatrixAt(k, mm));
    bIm.computeBoundingSphere();
    group.add(bIm);
    updaters.push((_dt, time) => { blinkMat.color.copy(glow(0xffa53a, Math.sin(time * 5) > 0 ? 2.2 : 0.35)); });
    // 殘存的玻璃板：上半部零零落落的幾片
    const rings: number[] = [];
    for (let i = 0; i < b.n; i += 2) rings.push(i);
    const pr = ellipseProfile(Ab, Bb, 8);
    const shards = sweep(b.samples, rings, pr, (k) => (rings[k] * b.spacing) / 5, (k, j) => out[rings[k]] && out[rings[Math.min(rings.length - 1, k + 1)]] && j >= 2 && j <= 5 && hash2(k, j, 9) < 0.3 * T.shards);
    const shm = add(shards, glassMaterial(uTime, 0xbff3ff, 0.06, 0.6, [4, 1]), false, false);
    if (shm) shm.renderOrder = 2;
    // 裂縫深處的藍光：沿捷徑往下十幾公尺的一條發光帶
    const glowTex = canvasTex(64, 16, (c) => {
      const g = c.createLinearGradient(0, 0, 64, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.5, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 16);
    });
    const abyssMat = new THREE.MeshBasicMaterial({ map: glowTex, color: glow(0x1fb8ff, 1.1), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
    const deep: ProfPt[] = [{ lat: -11, y: -10.2, nl: 0, ny: 1, u: 0 }, { lat: 11, y: -10.2, nl: 0, ny: 1, u: 1 }];
    add(sweep(b.samples, rings, deep, (k) => k * 0.1, (k) => out[rings[k]]), abyssMat, false, false);
    // 裂縫的黑洞：底板兩側一大片往外淡掉的深藍黑色，零星的藍綠光點像是深處的發光生物
    // （地形網格太粗，挖下去的坑看不出深度，用這一層畫出「往下看是無底深淵」的感覺）
    const voidMat = new THREE.ShaderMaterial({
      uniforms: { uTime },
      transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vW;
        void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv; varying vec3 vW;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        void main() {
          float edge = vUv.x;
          float a = 1.0 - smoothstep(0.55, 1.0, edge);
          vec2 cell = floor(vW.xz * 1.3);
          float sp = step(0.985, h(cell)) * (0.5 + 0.5 * sin(uTime * 2.0 + h(cell + 7.0) * 30.0));
          vec3 col = mix(vec3(0.0, 0.012, 0.03), vec3(0.01, 0.06, 0.1), edge) + vec3(0.2, 0.9, 1.0) * sp * (1.0 - edge) * 1.6;
          gl_FragColor = vec4(col, a * 0.96);
        }`,
    });
    for (const sg of [1, -1]) {
      const inner = { lat: sg * (hb + 1.25), y: -1.55, nl: 0, ny: 1, u: 0 }, outer = { lat: sg * (hb + 15), y: -1.55, nl: 0, ny: 1, u: 1 };
      const vm = add(sweep(b.samples, rings, sg > 0 ? [inner, outer] : [outer, inner], (k) => k * 0.2, (k) => out[rings[k]] && out[rings[Math.min(rings.length - 1, k + 1)]]), voidMat, false, false);
      if (vm) vm.renderOrder = 1;
    }
  }

  // ---------- 海床的景物：珊瑚、礁岩、海藻、發光生物（依位置分格的 InstancedMesh） ----------
  // 每 140 公尺一格：看不到（視錐外）或整格都在霧的盡頭之外的格子整個跳過
  // （同一格裡的珊瑚都用同一種珊瑚叢、岩石也只用一種，一格最多三四次繪製）
  const CELL_SIZE = 240;
  const chunks = new Map<string, THREE.Matrix4[]>();
  const chunkCols = new Map<string, number[]>();
  const push = (type: string, _d: number, m: THREE.Matrix4, col?: number) => {
    const cx = Math.floor(m.elements[12] / CELL_SIZE), cz = Math.floor(m.elements[14] / CELL_SIZE);
    if (type.startsWith('coral')) type = `coral${Math.floor(hash2(cx, cz, 3) * 3)}`;
    else if (type === 'rockDark') type = 'rock';
    const key = `${type}:${cx}:${cz}`;
    let a = chunks.get(key);
    if (!a) { chunks.set(key, (a = [])); chunkCols.set(key, []); }
    a.push(m.clone());
    if (col !== undefined) chunkCols.get(key)!.push(col);
  };
  const propsBlock = (x: number, z: number, r: number) => {
    for (const pr of ctx.props.children) {
      const rr = (pr.userData.radius ?? 9) + r;
      if ((pr.position.x - x) ** 2 + (pr.position.z - z) ** 2 < rr * rr) return true;
    }
    return false;
  };
  const inHall = (i: number, lat: number) => inSpan(S[i].dist, H.from - 6, H.to + 6, L) && Math.abs(lat) < H.half + 4;
  const inPlaza = (x: number, z: number, pad: number) => !!plaza && Math.hypot(x - plaza.x, z - plaza.z) < plaza.R + pad;
  // 沉船的位置（珊瑚與岩石不要長在船身裡）
  const ws = S[idxAt(lay.wreck)];
  const wreckSpots: { x: number; z: number; r: number }[] = [];
  for (const sg of [1, -1]) for (const f of [0.35, 0.75]) {
    const lat = sg * (A + 4 + f * 26);
    wreckSpots.push({ x: ws.x + ws.nx * lat, z: ws.z + ws.nz * lat, r: 9 });
  }
  const inWreck = (x: number, z: number) => wreckSpots.some((w) => (w.x - x) ** 2 + (w.z - z) ** 2 < w.r * w.r);
  const domeBlock = (x: number, z: number, pad: number) => lay.domes.some(([dx, dz, r]) => Math.hypot(x - dx, z - dz) < r + pad);
  {
    const b = ctx.bounds, M = 80, CELL = 6.5;
    const r = mulberry32(99);
    for (let gx = b.minX - M; gx < b.maxX + M; gx += CELL) for (let gz = b.minZ - M; gz < b.maxZ + M; gz += CELL) {
      const x = gx + r() * CELL, z = gz + r() * CELL;
      const roll = r(), roll2 = r(), roll3 = r(), roll4 = r();
      if (roll4 > T.decor) continue;
      const i = near.find(x, z, 75);
      if (i < 0) {
        // 離賽道比較遠的海床：稀稀落落的大礁岩與珊瑚叢（從隧道裡看過去才不會是一整片空沙地）
        if (roll > 0.07 || domeBlock(x, z, 8) || inPlaza(x, z, 6) || propsBlock(x, z, 4)) continue;
        const j = near.find(x, z, 260);
        if (j < 0) continue;
        const y = terrainH(x, z);
        q.setFromAxisAngle(up, r() * TAU);
        if (roll2 < 0.55) {
          const k = 2.5 + r() * 4;
          push('rock', S[j].dist, m4.compose(v3.set(x, y - k * 0.3, z), q, sc.set(k * (0.8 + r() * 0.6), k * (0.4 + r() * 0.5), k)));
        } else {
          const k = 1.2 + r() * 0.8;
          push(`coral${Math.floor(roll3 * 3)}`, S[j].dist, m4.compose(v3.set(x, y - 0.1, z), q, sc.set(k, k, k)), 0xffffff);
        }
        continue;
      }
      const dm = near.d;
      const s = S[i];
      const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
      const sg = Math.sign(lat) || 1;
      // 隧道外、緩衝區外、大廳與圓頂外、捷徑與裂縫外
      const edge = hw + track.runoffW(i, sg) + (track.runoffW(i, sg) > 0 ? 5 : 0);
      if (dm < Math.max(A + 2.2, edge)) continue;
      if (inHall(i, lat) || inWreck(x, z) || domeBlock(x, z, 4)) continue;
      if (BR.length && nearBr.find(x, z, 30) >= 0 && nearBr.d < 26) continue;
      if (propsBlock(x, z, 3)) continue;
      const d = s.dist;
      const zone = zoneAt(d);
      // 海溝 U 形彎的內側是裂縫，不放東西
      if (zone === 'trench' && lat > 0 && inSpan(d, 1645, 1935, L)) continue;
      const nearK = sstep(70, 18, dm);
      const y = terrainH(x, z);
      e.set((r() - 0.5) * 0.2, r() * TAU, (r() - 0.5) * 0.2);
      q.setFromEuler(e);
      if (zone === 'trench') {
        if (roll < 0.1 + 0.25 * nearK) {
          const k = 0.8 + r() * 1.4;
          push('glowPlant', d, m4.compose(v3.set(x, y - 0.1, z), q, sc.set(k, k, k)), [0x3ff6ff, 0x7dff9a, 0xb388ff, 0x4f9dff][Math.floor(r() * 4)]);
        } else if (roll < 0.42) {
          const k = 1.2 + r() * 2.8;
          push('rockDark', d, m4.compose(v3.set(x, y - k * 0.3, z), q, sc.set(k * (0.8 + r() * 0.5), k * (0.5 + r() * 0.6), k)));
        }
        continue;
      }
      const coralP = zone === 'reef' ? 0.42 : zone === 'wreck' ? 0.35 : zone === 'shallow' ? 0.16 : 0.1;
      const kelpP = zone === 'kelp' ? 0.5 : zone === 'shallow' ? 0.16 : zone === 'reef' ? 0.05 : 0.03;
      if (roll < coralP * (0.25 + 0.75 * nearK)) {
        const k = 0.8 + r() * 0.7;
        q.setFromAxisAngle(up, r() * TAU);
        push(`coral${Math.floor(roll2 * 3)}`, d, m4.compose(v3.set(x, y - 0.1, z), q, sc.set(k, k * (0.8 + r() * 0.4), k)), 0xffffff);
      } else if (roll3 < kelpP * (0.3 + 0.7 * nearK) && !inPlaza(x, z, 4)) {
        const h = 9 + r() * 10, w = 1.3 + r() * 0.9;
        q.setFromAxisAngle(up, r() * TAU);
        push('kelp', d, m4.compose(v3.set(x, y - 0.2, z), q, sc.set(w, h, w)));
        // 海藻長成一叢
        for (let c = 0; c < 1 + (r() < 0.5 ? 1 : 0); c++) {
          const ox = x + (r() - 0.5) * 3.5, oz = z + (r() - 0.5) * 3.5;
          const hh = h * (0.6 + r() * 0.4);
          q.setFromAxisAngle(up, r() * TAU);
          push('kelp', d, m4.compose(v3.set(ox, terrainH(ox, oz) - 0.2, oz), q, sc.set(w, hh, w)));
        }
      } else if (roll2 < 0.1) {
        const k = 1 + r() * 2.6;
        push('rock', d, m4.compose(v3.set(x, y - k * 0.3, z), q, sc.set(k * (0.8 + r() * 0.5), k * (0.5 + r() * 0.5), k)));
      }
    }
  }
  // 海溝兩側的高聳岩壁
  {
    const r = mulberry32(57);
    for (let d = 1560; d < 2060; d += 7) {
      const i = idxAt(d);
      const s = S[i];
      for (const sg of [1, -1]) {
        if (sg > 0 && inSpan(d, 1620, 1960, L)) continue;
        if (r() < 0.25) continue;
        const lat = sg * (hw + 17 + r() * 16);
        const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
        const j = near.find(x, z, 60);
        if (j >= 0 && near.d < hw + 12) continue;
        if (BR.length && nearBr.find(x, z, 40) >= 0 && nearBr.d < 30) continue;
        if (inWreck(x, z)) continue;
        const k = 8 + r() * 7, h = 10 + r() * 14 * (inSpan(d, 1620, 1980, L) ? 1 : 0.5);
        e.set((r() - 0.5) * 0.3, r() * TAU, (r() - 0.5) * 0.3);
        q.setFromEuler(e);
        push('cliff', d, m4.compose(v3.set(x, terrainH(x, z) - 4, z), q, sc.set(k, h, k * (0.8 + r() * 0.4))));
      }
    }
  }
  {
    const coralMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const kelpMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x1a2408 });
    kelpMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
          float h = position.y;
          transformed.x += (sin(uTime * 0.8 + ph + h * 2.2) * 0.9 + sin(uTime * 1.7 + ph * 2.0) * 0.25) * pow(h, 1.4);
          transformed.z += cos(uTime * 0.6 + ph * 1.3 + h * 1.8) * 0.7 * pow(h, 1.4);
        #endif`);
    };
    kelpMat.customProgramCacheKey = () => 'ocean-kelp';
    const plantMat = new THREE.MeshBasicMaterial({ color: glow(0xffffff, 1.6) });
    updaters.push((_dt, time) => { plantMat.color.setScalar(1.25 + 0.45 * Math.sin(time * 1.3)); });
    const geos: Record<string, [THREE.BufferGeometry, THREE.Material, boolean]> = {
      coral0: [coralPatch(11, tier === 0), coralMat, false], coral1: [coralPatch(23, tier === 0), coralMat, false], coral2: [coralPatch(37, tier === 0), coralMat, false],
      rock: [rockGeo(3, false), rockMat, true], rockDark: [rockGeo(7, true), rockMat, true], cliff: [cliffGeo(19), rockMat, true],
      kelp: [kelpGeo(), kelpMat, false], glowPlant: [glowPlantGeo(), plantMat, false],
    };
    for (const [key, list] of chunks) {
      const type = key.split(':')[0];
      const [geo, mat, cast] = geos[type];
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm, k) => im.setMatrixAt(k, mm));
      const cols = chunkCols.get(key)!;
      if (cols.length === list.length && type === 'glowPlant') cols.forEach((c, k) => im.setColorAt(k, color.setHex(c)));
      else if (type.startsWith('coral')) for (let k = 0; k < list.length; k++) im.setColorAt(k, color.setRGB(0.85 + rng() * 0.3, 0.85 + rng() * 0.3, 0.85 + rng() * 0.3));
      im.computeBoundingSphere();
      im.castShadow = shadows && cast;
      im.receiveShadow = shadows && type !== 'kelp';
      group.add(im);
    }
  }

  // ---------- 天然岩拱：跨在隧道上方 ----------
  {
    // 岩拱：灰藍的礁岩，朝上的面長了褐綠色的藻，零星幾塊淡粉紅的殼狀珊瑚藻
    const algae = new THREE.Color(0x7a7a4a), pinkish = new THREE.Color(0xc98a96);
    const geo = paint(lumpy(new THREE.TorusGeometry(A + 7.5, 3.4, 8, 26, Math.PI), 0.6, 13), (x, y, z, ny, out) => {
      out.setHex(0x4f5b63).lerp(algae, sstep(0.2, 0.8, ny) * 0.7);
      if (hash2(Math.round(x * 0.7), Math.round(y * 0.7 + z), 4) > 0.8) out.lerp(pinkish, 0.55);
    }, 0.14, 5);
    const list: THREE.Matrix4[] = [];
    for (const d of lay.arches) {
      const s = S[idxAt(d)];
      e.set(0, yawOf(s) + (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.12);
      q.setFromEuler(e);
      list.push(new THREE.Matrix4().compose(v3.set(s.x, s.y - 3.2, s.z), q, sc.set(1, 1.05, 1.4)));
    }
    if (list.length) {
      const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
      list.forEach((mm, k) => im.setMatrixAt(k, mm));
      im.computeBoundingSphere();
      im.castShadow = shadows;
      im.receiveShadow = shadows;
      group.add(im);
    }
  }

  // ---------- 沉船：斷成兩截，隧道從斷口穿過 ----------
  {
    const Lh = 64, Bh = 12, Dh = 7.5;
    // 海裡紅色最先被吸收：鏽色畫得比實際亮、偏橘，遠遠的才看得出是一艘鏽掉的船
    const hullTex = canvasTex(256, 128, (c) => {
      c.fillStyle = '#c0703e';
      c.fillRect(0, 0, 256, 128);
      const r = mulberry32(61);
      // 鏽痕往下流
      for (let k = 0; k < 140; k++) {
        c.fillStyle = r() < 0.5 ? 'rgba(230,140,70,0.4)' : 'rgba(70,35,20,0.35)';
        c.fillRect(r() * 256, r() * 128, 2 + r() * 4, 10 + r() * 50);
      }
      // 船身上半部白色的漆（剝落）
      c.fillStyle = 'rgba(225,225,210,0.55)';
      c.fillRect(0, 0, 256, 16);
      // 吃水線以上長了青綠色的藻
      for (let k = 0; k < 220; k++) {
        c.fillStyle = r() < 0.5 ? 'rgba(70,140,110,0.45)' : 'rgba(120,160,90,0.4)';
        c.beginPath();
        c.arc(r() * 256, r() * 48, 2 + r() * 7, 0, TAU);
        c.fill();
      }
      // 藤壺與舷窗
      for (let k = 0; k < 300; k++) { c.fillStyle = 'rgba(220,210,190,0.5)'; c.fillRect(r() * 256, r() * 128, 2, 2); }
      c.fillStyle = '#1b2a33';
      for (let x = 12; x < 256; x += 28) { c.beginPath(); c.arc(x, 30, 5, 0, TAU); c.fill(); }
    });
    const deckTex = canvasTex(128, 128, (c) => {
      c.fillStyle = '#4b4232';
      c.fillRect(0, 0, 128, 128);
      for (let x = 0; x < 128; x += 10) { c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x, 0, 2, 128); }
      const r = mulberry32(62);
      for (let k = 0; k < 90; k++) { c.fillStyle = 'rgba(70,130,100,0.45)'; c.beginPath(); c.arc(r() * 128, r() * 128, 3 + r() * 9, 0, TAU); c.fill(); }
    });
    const hullMat = new THREE.MeshLambertMaterial({ map: hullTex, side: THREE.DoubleSide });
    const deckMat = new THREE.MeshLambertMaterial({ map: deckTex, side: THREE.DoubleSide });
    const rust = new THREE.MeshLambertMaterial({ color: 0x5b3a2e });
    const gap = A + 3.5;
    // 船的座標：z 沿著賽道的橫向（左 = +），斷口在 z = 0 附近
    const pieces: { z0: number; z1: number; roll: number; pitch: number; sink: number }[] = [
      { z0: 0, z1: Lh / 2, roll: 0.3, pitch: 0.1, sink: 2.2 },
      { z0: -Lh / 2, z1: -1.5, roll: -0.2, pitch: -0.08, sink: 1.8 },
    ];
    for (const [pi, p] of pieces.entries()) {
      const g = new THREE.Group();
      const { hull, deck } = hullGeo(p.z0, p.z1, Lh, Bh, Dh);
      const hm = new THREE.Mesh(hull, hullMat), dm = new THREE.Mesh(deck, deckMat);
      hm.castShadow = dm.castShadow = shadows;
      hm.receiveShadow = dm.receiveShadow = shadows;
      g.add(hm, dm);
      if (pi === 0) {
        // 船頭：斷掉的前桅
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 11, 7).translate(0, 5.5, 0), rust);
        mast.position.set(0, 0.5, 18);
        mast.rotation.set(0.5, 0, 0.3);
        g.add(mast);
      } else {
        // 船尾：駕駛艙、煙囪、後桅
        const house = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 8).translate(0, 2.5, 0), hullMat);
        house.position.set(0, 0.2, -20);
        const funnel = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 6, 10).translate(0, 3, 0), rust);
        funnel.position.set(0, 4.5, -14);
        funnel.rotation.x = -0.18;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 15, 7).translate(0, 7.5, 0), rust);
        mast.position.set(0, 0.5, -9);
        const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 9, 6).rotateZ(Math.PI / 2), rust);
        yard.position.set(0, 12, -9);
        for (const o of [house, funnel, mast, yard]) { o.castShadow = shadows; g.add(o); }
      }
      // 擺到隧道兩側：船的 z 軸 = 賽道左側法線，斷口朝隧道
      const zc = (p.z0 + p.z1) / 2;
      const offs = Math.sign(zc) * gap - (zc > 0 ? p.z0 : p.z1);
      // 船身底下的地面高度取幾個點的平均（船埋進沙裡 sink 公尺）
      let gy = 0;
      for (let f = 0; f <= 1.0001; f += 0.25) {
        const lat = p.z0 + (p.z1 - p.z0) * f + offs;
        gy += terrainH(ws.x + ws.nx * lat, ws.z + ws.nz * lat) / 5;
      }
      g.position.set(ws.x + ws.nx * offs, gy - p.sink + Dh, ws.z + ws.nz * offs);
      g.rotation.set(0, Math.atan2(ws.nx, ws.nz), 0);
      const inner = new THREE.Group();
      inner.add(...g.children);
      inner.rotation.set(p.pitch, 0, p.roll);
      g.add(inner);
      group.add(g);
    }
  }

  // ---------- 研究站圓頂與連接管 ----------
  {
    const glassG: THREE.BufferGeometry[] = [], baseG: THREE.BufferGeometry[] = [], glowG: THREE.BufferGeometry[] = [], towerG: THREE.BufferGeometry[] = [], tubeG: THREE.BufferGeometry[] = [];
    const beacons: THREE.Matrix4[] = [];
    for (const [x, z, R] of lay.domes) {
      const y = terrainH(x, z) - 0.6;
      glassG.push(new THREE.SphereGeometry(R, 28, 10, 0, TAU, 0, Math.PI / 2).translate(x, y + 1.6, z));
      baseG.push(new THREE.CylinderGeometry(R + 0.8, R + 1.4, 3.2, 32).translate(x, y, z).toNonIndexed());
      glowG.push(new THREE.CylinderGeometry(R * 0.82, R * 0.82, 0.12, 32).translate(x, y + 1.7, z).toNonIndexed());
      // 中間的研究塔：窗戶發亮
      towerG.push(new THREE.CylinderGeometry(R * 0.22, R * 0.3, R * 0.75, 12).translate(x, y + 1.6 + R * 0.375, z).toNonIndexed());
      glowG.push(new THREE.CylinderGeometry(R * 0.225, R * 0.25, 0.6, 12, 1, true).translate(x, y + 1.6 + R * 0.45, z).toNonIndexed());
      glowG.push(new THREE.TorusGeometry(R + 0.85, 0.22, 4, 48).rotateX(Math.PI / 2).translate(x, y + 1.65, z).toNonIndexed());
      m4.makeTranslation(x, y + 1.6 + R + 0.6, z);
      beacons.push(m4.clone());
    }
    // 連接管：沿地面拉過去，兩端接在圓頂邊上
    for (let k = 0; k + 1 < lay.domes.length; k++) {
      const [x0, z0, r0] = lay.domes[k], [x1, z1, r1] = lay.domes[k + 1];
      const dx = x1 - x0, dz = z1 - z0, dl = Math.hypot(dx, dz);
      const pts: THREE.Vector3[] = [];
      for (let u = 0; u <= 1.0001; u += 0.1) {
        const t = (r0 * 0.9 + (dl - r0 * 0.9 - r1 * 0.9) * u) / dl;
        const x = x0 + dx * t + Math.sin(u * Math.PI) * dz * 0.08, z = z0 + dz * t - Math.sin(u * Math.PI) * dx * 0.08;
        pts.push(new THREE.Vector3(x, terrainH(x, z) + 2.4, z));
      }
      tubeG.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 2.1, 10));
    }
    const glassDomeMat = glassMaterial(uTime, 0xbff3ff, 0.05, 0.6, [10, 5]);
    const gd = add(mergeGeometries(glassG.map((g) => g.toNonIndexed())), glassDomeMat, false, false);
    if (gd) gd.renderOrder = 2;
    const tb = add(tubeG.length ? mergeGeometries(tubeG.map((g) => g.toNonIndexed())) : null, glassMaterial(uTime, 0xbff3ff, 0.06, 0.6, [6, 18]), false, false);
    if (tb) tb.renderOrder = 2;
    add(mergeGeometries(baseG.map((g) => { g.deleteAttribute('uv'); return g; })), new THREE.MeshLambertMaterial({ color: 0x8395a1 }));
    add(mergeGeometries(towerG.map((g) => { g.deleteAttribute('uv'); return g; })), new THREE.MeshStandardMaterial({ color: 0xdfe8ee, metalness: 0.3, roughness: 0.4 }));
    add(mergeGeometries(glowG.map((g) => { g.deleteAttribute('uv'); return g; })), new THREE.MeshBasicMaterial({ color: glow(0x7ff4ff, 1.35) }), false, false);
    const beaconMat = new THREE.MeshBasicMaterial({ color: glow(0xff4a4a, 2.5) });
    const bm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 8, 6), beaconMat, beacons.length);
    beacons.forEach((mm, k) => bm.setMatrixAt(k, mm));
    bm.computeBoundingSphere();
    group.add(bm);
    updaters.push((_dt, time) => { beaconMat.color.copy(glow(0xff4a4a, (time % 1.6) < 0.25 ? 3 : 0.4)); });
  }

  // ---------- 海中生物、光束、水面（oceanLife.ts） ----------
  const cau = causticTexture();
  let life: Life | null = null;
  const sunDir = new THREE.Vector3(0.22, 0.93, 0.3).normalize();
  {
    const r = mulberry32(808);
    const zoneSamples = (zs: Zone[]) => {
      const out: number[] = [];
      for (let i = 0; i < n; i += 4) if (zs.includes(zoneAt(S[i].dist)) && !inSpan(S[i].dist, H.from, H.to, L)) out.push(i);
      return out;
    };
    const lively = zoneSamples(['reef', 'kelp', 'shallow', 'wreck']);
    const pick = (list: number[]) => S[list[Math.floor(r() * list.length)]];
    const FISH_COLS = [0xd9e4ec, 0xffd23f, 0x56b4ff, 0xff8c42, 0xc8f0ff, 0x7dffcf, 0xff6f91];
    const schools: School[] = [];
    for (let k = 0; k < T.schools; k++) {
      const s = pick(lively);
      const rr = 5 + r() * 8;
      const above = r() < 0.4;
      const sg = r() < 0.5 ? 1 : -1;
      const lat = above ? (r() - 0.5) * 10 : sg * (A + rr + 5 + r() * 14);
      const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
      const y = above ? s.y + B + 6 + r() * 8 : Math.max(terrainH(x, z) + 3, s.y + 1 + r() * 8);
      schools.push({ x, y, z, r: rr, n: Math.round(T.fishMax * (0.55 + r() * 0.45)), size: 0.9 + r() * 0.6, color: FISH_COLS[k % FISH_COLS.length], dir: r() < 0.5 ? 1 : -1 });
    }
    const sharks: Cruiser[] = [];
    const sharkZone = zoneSamples(['reef', 'kelp', 'wreck']);
    for (let k = 0; k < T.sharks; k++) {
      const s = pick(sharkZone);
      sharks.push({ x: s.x + (r() - 0.5) * 30, y: s.y + B + 4 + r() * 7, z: s.z + (r() - 0.5) * 30, r: 22 + r() * 18, size: 2.9 + r() * 0.9, speed: 5 + r() * 2.5 });
    }
    const mantas: Cruiser[] = [];
    const mantaZone = zoneSamples(['shallow', 'reef']);
    for (let k = 0; k < T.mantas; k++) {
      const s = pick(mantaZone);
      mantas.push({ x: s.x + (r() - 0.5) * 50, y: s.y + B + 8 + r() * 10, z: s.z + (r() - 0.5) * 50, r: 30 + r() * 25, size: 2.6 + r() * 1.2, speed: 4 + r() * 1.5 });
    }
    const trench = zoneSamples(['trench']);
    const jellies: { x: number; y: number; z: number; h: number; color: number; size: number }[] = [];
    const JCOL = [0x4ff0ff, 0xb68cff, 0xff7ad9, 0x6fffb0];
    for (let k = 0; k < T.jellies; k++) {
      const s = pick(trench);
      const lat = (r() < 0.5 ? 1 : -1) * (A + 3 + r() * 36);
      const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
      jellies.push({ x, y: Math.min(s.y - 2, terrainH(x, z) + 1), z, h: 16 + r() * 16, color: JCOL[k % JCOL.length], size: 0.7 + r() * 0.8 });
    }
    // 裂縫裡多放一些水母
    for (let k = 0; k < Math.min(abyss.length, T.jellies / 3); k++) {
      const a = abyss[Math.floor(r() * abyss.length)];
      const side = r() < 0.5 ? 1 : -1;
      jellies.push({ x: a.x + side * (18 + r() * 12), y: a.y - 12, z: a.z + side * (r() - 0.5) * 20, h: 15, color: JCOL[k % JCOL.length], size: 0.6 + r() * 0.5 });
    }
    const glows: Glow[] = [];
    const GCOL = [0x3ff6ff, 0x7dff9a, 0x6f8dff, 0xb388ff];
    for (let k = 0; k < T.glows; k++) {
      const s = pick(trench);
      const lat = (r() - 0.5) * 2 * (A + 40);
      const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
      // 隧道裡面不放
      if (Math.abs(lat) < A + 1 && r() < 0.85) continue;
      glows.push({ x, y: s.y - 4 + r() * 22, z, color: GCOL[Math.floor(r() * GCOL.length)], size: 0.18 + r() * 0.3 });
    }
    for (const a of abyss) for (let k = 0; k < 3; k++) glows.push({ x: a.x + (r() - 0.5) * 20, y: a.y - 14 + r() * 12, z: a.z + (r() - 0.5) * 20, color: GCOL[k % 4], size: 0.25 + r() * 0.3 });
    const vents: Vent[] = [];
    for (let k = 0; k < T.vents; k++) {
      const s = S[Math.floor(r() * n)];
      if (inSpan(s.dist, H.from, H.to, L)) { k--; continue; }
      const lat = (r() < 0.5 ? 1 : -1) * (A + 4 + r() * 10);
      const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
      if (inPlaza(x, z, 2)) continue;
      vents.push({ x, y: terrainH(x, z), z, h: lay.surfaceY - terrainH(x, z) - 6 });
    }
    // 隧道底部每隔一段冒出一串細小的氣泡（玻璃外面）
    const shafts: Shaft[] = [];
    const shZone = zoneSamples(['shallow']), shZone2 = zoneSamples(['reef', 'kelp']);
    for (let k = 0; k < T.shafts; k++) {
      const s = k < T.shafts * 0.7 ? pick(shZone) : pick(shZone2);
      const lat = (r() - 0.5) * 70;
      shafts.push({ x: s.x + s.nx * lat, z: s.z + s.nz * lat, w: 5 + r() * 9, len: lay.surfaceY - s.y + 8, k: k < T.shafts * 0.7 ? 0.8 + r() * 0.5 : 0.45 + r() * 0.3 });
    }
    const b = ctx.bounds;
    life = buildLife({
      schools, sharks, mantas, jellies, glows, vents, shafts,
      surfaceY: lay.surfaceY, center: [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2], sunDir, causticTex: cau, tier,
    });
    group.add(life.group);
    const lf = life;
    updaters.push((_dt, time) => lf.update(time));
  }

  // ---------- 依鏡頭深度的海水氛圍：淺灘亮、海溝暗 ----------
  const AMB = {
    shallow: { fog: new THREE.Color(0x1a7f9c), near: 30, far: 430, hemi: 1.05, sun: 2.3, env: 0.9, top: new THREE.Color(0x9ff4ff) },
    mid: { fog: new THREE.Color(0x0d5576), near: 24, far: 360, hemi: 0.85, sun: 1.9, env: 0.75, top: new THREE.Color(0x7fe6f6) },
    deep: { fog: new THREE.Color(0x031c2d), near: 10, far: 210, hemi: 0.55, sun: 0.7, env: 0.4, top: new THREE.Color(0x1d6f8c) },
  };
  let skyMat: THREE.ShaderMaterial | null = null;
  const lights: { hemi: THREE.HemisphereLight | null; sun: THREE.DirectionalLight | null; found: boolean } = { hemi: null, sun: null, found: false };
  const depthK = { v: NaN };
  const tmpC = new THREE.Color(), tmpTop = new THREE.Color();
  const ambience = (dt: number, camera: THREE.Camera) => {
    const scene = group.parent?.parent as THREE.Scene | undefined;
    if (!scene || !(scene as THREE.Scene).isScene) return;
    if (!lights.found) {
      lights.found = true;
      for (const o of scene.children) {
        if ((o as THREE.HemisphereLight).isHemisphereLight && !lights.hemi) lights.hemi = o as THREE.HemisphereLight;
        if ((o as THREE.DirectionalLight).isDirectionalLight && !lights.sun) lights.sun = o as THREE.DirectionalLight;
      }
    }
    // 深度係數：-1 = 海溝、0 = 一般、1 = 淺灘（平滑跟上，不會一下子跳）
    const y = camera.position.y;
    const want = y > 6 ? sstep(9, 22, y) : -sstep(4, -9, y);
    depthK.v = Number.isNaN(depthK.v) ? want : depthK.v + (want - depthK.v) * Math.min(1, dt * 1.5);
    const k = depthK.v;
    const a = AMB.mid, b = k >= 0 ? AMB.shallow : AMB.deep, t = Math.abs(k);
    const lerp = (p: number, q2: number) => p + (q2 - p) * t;
    tmpC.copy(a.fog).lerp(b.fog, t);
    const fog = scene.fog as THREE.Fog | null;
    if (fog && (fog as THREE.Fog).isFog) {
      fog.color.copy(tmpC);
      fog.near = lerp(a.near, b.near);
      fog.far = lerp(a.far, b.far);
    }
    if (scene.background && (scene.background as THREE.Color).isColor) (scene.background as THREE.Color).copy(tmpC);
    scene.environmentIntensity = lerp(a.env, b.env);
    if (lights.hemi) lights.hemi.intensity = lerp(a.hemi, b.hemi);
    if (lights.sun) lights.sun.intensity = lerp(a.sun, b.sun);
    if (skyMat) {
      tmpTop.copy(a.top).lerp(b.top, t);
      (skyMat.uniforms.top.value as THREE.Color).copy(tmpTop);
      (skyMat.uniforms.horizon.value as THREE.Color).copy(tmpC);
    }
    caustic.uCauK.value = 0.55 + 0.25 * k;
    life?.setLight(k >= 0 ? 1 + 0.15 * k : 1 + 0.75 * k);
    // 整塊都在霧的盡頭之外的景物：不畫（霧裡本來就看不到）
    const far = (fog && fog.isFog ? fog.far : 400) + 12;
    const cp = camera.position;
    if (!cullables) {
      cullables = [];
      // 海底模組自己的景物，加上大廳裡的看台、維修區這些（world.ts 擺的，霧裡看不到時一樣跳過）
      for (const o of [...group.children, ...ctx.props.children]) {
        if (o === life?.group) continue;
        o.updateMatrixWorld(true);
        const im = o as THREE.InstancedMesh;
        if (im.isInstancedMesh) {
          if (!im.boundingSphere) im.computeBoundingSphere();
          cullables.push({ o, s: im.boundingSphere!.clone().applyMatrix4(im.matrixWorld) });
          continue;
        }
        const box = new THREE.Box3().setFromObject(o, false);
        if (box.isEmpty()) continue;
        cullables.push({ o, s: box.getBoundingSphere(new THREE.Sphere()) });
      }
    }
    for (const c of cullables) c.o.visible = c.s.center.distanceTo(cp) - c.s.radius < far;
  };
  let cullables: { o: THREE.Object3D; s: THREE.Sphere }[] | null = null;

  // ---------- 焦散光：替場景裡所有一般材質加上（world.ts 建完之後呼叫） ----------
  const caustic = { uCauTex: { value: cau as THREE.Texture }, uCauT: { value: 0 }, uCauK: { value: 0.55 } };
  const patched = new WeakSet<THREE.Material>();
  const patch = (mat: THREE.Material) => {
    if (patched.has(mat)) return;
    patched.add(mat);
    const m = mat as THREE.MeshLambertMaterial;
    if (!(m.isMeshLambertMaterial || (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || (mat as THREE.MeshPhongMaterial).isMeshPhongMaterial)) return;
    const prevKey = mat.customProgramCacheKey();
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, renderer) => {
      prev.call(mat, sh, renderer);
      sh.uniforms.uCauTex = caustic.uCauTex;
      sh.uniforms.uCauT = caustic.uCauT;
      sh.uniforms.uCauK = caustic.uCauK;
      sh.vertexShader = 'varying vec3 vCauP;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 cp = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            cp = batchingMatrix * cp;
          #endif
          #ifdef USE_INSTANCING
            cp = instanceMatrix * cp;
          #endif
          vCauP = (modelMatrix * cp).xyz;
        }`);
      sh.fragmentShader = 'uniform sampler2D uCauTex;\nuniform float uCauT;\nuniform float uCauK;\nvarying vec3 vCauP;\n' + sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // 水面透下來的光斑：兩層錯開捲動的紋理取最小值；只打在朝上的面，越深越淡
          vec2 cuv = vCauP.xz * 0.06;
          float ca = texture2D(uCauTex, cuv + vec2(uCauT * 0.023, uCauT * 0.017)).r;
          float cb = texture2D(uCauTex, cuv * 1.31 + vec2(0.37 - uCauT * 0.019, 0.11 + uCauT * 0.021)).r;
          float cau = pow(min(ca, cb), 1.5);
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float facing = clamp(dot(normal, upV) * 1.2 - 0.1, 0.0, 1.0);
          float depthK = clamp((vCauP.y + 22.0) / 40.0, 0.12, 1.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.75, 0.95, 1.0) * cau * facing * depthK * uCauK * 1.5;
          // 越深的地方照到的光越少（海溝底部只剩三四成，發光的東西不受影響）
          float lightK = mix(0.36, 1.0, smoothstep(-15.0, 2.0, vCauP.y));
          reflectedLight.directDiffuse *= lightK;
          reflectedLight.indirectDiffuse *= lightK;
          reflectedLight.directSpecular *= lightK;
          reflectedLight.indirectSpecular *= lightK;
        }`);
    };
    mat.customProgramCacheKey = () => prevKey + '|ocean-caustic';
    mat.needsUpdate = true;
  };

  return {
    group,
    update(dt, time, camera) {
      uTime.value = time;
      caustic.uCauT.value = time;
      for (const u of updaters) u(dt, time);
      ambience(dt, camera);
    },
    finish(root, sky) {
      skyMat = sky;
      // 模型快取裡的材質是各張地圖共用的：一律複製一份再加焦散，原本的材質不動（換地圖後不會殘留）
      const clones = new Map<THREE.Material, THREE.Material>();
      const own = (mat: THREE.Material): THREE.Material => {
        const m = mat as THREE.MeshLambertMaterial;
        if (!(m.isMeshLambertMaterial || (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || (mat as THREE.MeshPhongMaterial).isMeshPhongMaterial)) return mat;
        let c = clones.get(mat);
        if (!c) {
          c = mat.clone();
          // clone() 不會帶走自訂的 onBeforeCompile（草叢擺動、觀眾、地形細節…），接回去
          c.onBeforeCompile = mat.onBeforeCompile;
          c.customProgramCacheKey = mat.customProgramCacheKey;
          patch(c);
          clones.set(mat, c);
        }
        return c;
      };
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
      });
    },
  };
}
