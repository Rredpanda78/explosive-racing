import * as THREE from 'three';
import { mulberry32 } from '../game/util';

/**
 * 蔚藍海廊的海中生物與水中光影（都在 GPU 上動，CPU 每幀只更新時間）：
 * - 魚群：小魚繞著各自的群中心游圈，身體左右擺尾
 * - 鯊魚：在隧道上方慢慢巡游；魟魚：在淺灘上方拍翅滑翔
 * - 海溝的水母（會發光、一縮一放往上漂）與發光浮游生物
 * - 從水面斜射下來的光束、頭頂的水面波光、海床冒出來的氣泡
 * 每一種都是一個 InstancedMesh（一次繪製），位置與動作全部在頂點著色器裡算。
 */

export interface School { x: number; y: number; z: number; r: number; n: number; size: number; color: number; dir: number }
export interface Cruiser { x: number; y: number; z: number; r: number; size: number; speed: number }
export interface Glow { x: number; y: number; z: number; color: number; size: number }
export interface Vent { x: number; y: number; z: number; h: number }
export interface Shaft { x: number; z: number; w: number; len: number; k: number }

export interface LifeCtx {
  schools: School[];
  sharks: Cruiser[];
  mantas: Cruiser[];
  /** 水母：起點與往上漂的範圍 */
  jellies: { x: number; y: number; z: number; h: number; color: number; size: number }[];
  glows: Glow[];
  vents: Vent[];
  shafts: Shaft[];
  surfaceY: number;
  center: [number, number];
  sunDir: THREE.Vector3;
  causticTex: THREE.Texture;
  /** 0 = 低畫質：氣泡、浮游生物減量 */
  tier: number;
}

export interface Life {
  group: THREE.Group;
  update(time: number): void;
  /** 水面與光束的亮度（0~1，深海裡變暗） */
  setLight(k: number): void;
}

const TAU = Math.PI * 2;

/**
 * 位置在著色器裡算的 InstancedMesh：用實例的基準位置（每 stride 個數字的前三個是 x, y, z）加上活動範圍 pad，
 * 算出一個包圍球給視錐剔除（整群都看不到時整個跳過）
 */
function cullSphere(im: THREE.InstancedMesh, arr: Float32Array, stride: number, pad: number, padY = 0): void {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < arr.length; i += stride) {
    box.expandByPoint(v.set(arr[i], arr[i + 1], arr[i + 2]));
    if (padY) box.expandByPoint(v.set(arr[i], arr[i + 1] + padY, arr[i + 2]));
  }
  box.expandByScalar(pad);
  im.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  im.frustumCulled = true;
}

// ---------- 幾何 ----------

/** 由三角形清單組成的幾何（各面平面著色）：每個三角形一個顏色，可選擇是否兩面都畫 */
class TriBuilder {
  pos: number[] = [];
  col: number[] = [];
  extra: number[] = [];
  /** center：判斷「朝外」用的中心點；null = 兩面都加 */
  tri(a: number[], b: number[], c: number[], color: THREE.Color, center: number[] | null, ex = 0): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const push = (p: number[], q: number[], r: number[]) => {
      this.pos.push(...p, ...q, ...r);
      for (let k = 0; k < 3; k++) { this.col.push(color.r, color.g, color.b); this.extra.push(ex); }
    };
    if (!center) { push(a, b, c); push(a, c, b); return; }
    const mx = (a[0] + b[0] + c[0]) / 3 - center[0], my = (a[1] + b[1] + c[1]) / 3 - center[1], mz = (a[2] + b[2] + c[2]) / 3 - center[2];
    if (nx * mx + ny * my + nz * mz >= 0) push(a, b, c);
    else push(a, c, b);
  }
  build(extraName?: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (extraName) g.setAttribute(extraName, new THREE.Float32BufferAttribute(this.extra, 1));
    g.computeVertexNormals();
    return g;
  }
}

/** 小魚（長 1，鼻子在 +z）：菱形身體、背鰭與尾鰭 */
function fishGeo(): THREE.BufferGeometry {
  const t = new TriBuilder();
  const nose = [0, 0, 0.55], tail = [0, 0, -0.3], top = [0, 0.2, 0.06], bot = [0, -0.17, 0.06], l = [0.085, 0.01, 0.04], r = [-0.085, 0.01, 0.04];
  const back = new THREE.Color(0.55, 0.6, 0.66), side = new THREE.Color(0.95, 0.95, 0.95), belly = new THREE.Color(1.1, 1.1, 1.05);
  const C = [0, 0, 0.06];
  t.tri(nose, top, l, back, C); t.tri(nose, r, top, back, C);
  t.tri(nose, l, bot, belly, C); t.tri(nose, bot, r, belly, C);
  t.tri(tail, top, l, side, C); t.tri(tail, r, top, side, C);
  t.tri(tail, l, bot, side, C); t.tri(tail, bot, r, side, C);
  // 尾鰭（兩面）
  t.tri([0, 0, -0.26], [0, 0.21, -0.6], [0, 0.02, -0.5], back, null);
  t.tri([0, 0, -0.26], [0, -0.02, -0.5], [0, -0.19, -0.58], back, null);
  return t.build();
}

/** 鯊魚（長 2，鼻子在 +z）：放樣的身體、背鰭、胸鰭與上長下短的尾鰭 */
function sharkGeo(): THREE.BufferGeometry {
  const t = new TriBuilder();
  const rings: [number, number, number, number][] = [
    // z, 半寬, 半高, 中心高度
    [0.86, 0.06, 0.05, -0.01], [0.72, 0.15, 0.12, 0], [0.5, 0.23, 0.2, 0.01], [0.25, 0.27, 0.24, 0.02], [0, 0.25, 0.23, 0.02],
    [-0.28, 0.18, 0.17, 0.02], [-0.52, 0.1, 0.1, 0.03], [-0.72, 0.045, 0.05, 0.04],
  ];
  const SIDES = 8;
  const top = new THREE.Color(0x5a6e7e), belly = new THREE.Color(0xdfe7ec);
  const ring = (k: number) => rings[k];
  const pt = (k: number, j: number): number[] => {
    const [z, rx, ry, cy] = ring(k);
    const a = (j / SIDES) * TAU;
    return [Math.sin(a) * rx, cy + Math.cos(a) * ry, z];
  };
  const colAt = (y: number, cy: number) => (y > cy - 0.02 ? top : belly);
  for (let k = 0; k < rings.length - 1; k++) {
    for (let j = 0; j < SIDES; j++) {
      const a = pt(k, j), b = pt(k, j + 1), c = pt(k + 1, j), d = pt(k + 1, j + 1);
      const cen = [0, (rings[k][3] + rings[k + 1][3]) / 2, (rings[k][0] + rings[k + 1][0]) / 2];
      const col = colAt((a[1] + b[1] + c[1]) / 3, cen[1]);
      t.tri(a, b, c, col, cen);
      t.tri(b, d, c, col, cen);
    }
  }
  // 鼻尖與尾柄
  const noseTip = [0, -0.02, 1.0], tailTip = [0, 0.05, -0.8];
  for (let j = 0; j < SIDES; j++) {
    const a = pt(0, j), b = pt(0, j + 1);
    t.tri(noseTip, a, b, colAt((a[1] + b[1]) / 2, 0), [0, 0, 0.8]);
    const c = pt(rings.length - 1, j), d = pt(rings.length - 1, j + 1);
    t.tri(tailTip, c, d, colAt((c[1] + d[1]) / 2, 0.04), [0, 0.04, -0.6]);
  }
  const fin = new THREE.Color(0x4f6272);
  // 背鰭
  t.tri([0, 0.22, 0.2], [0, 0.66, -0.12], [0, 0.2, -0.12], fin, null);
  // 胸鰭
  for (const s of [1, -1]) t.tri([s * 0.2, -0.1, 0.32], [s * 0.82, -0.36, -0.02], [s * 0.2, -0.1, 0.06], fin, null);
  // 尾鰭：上葉長、下葉短
  t.tri([0, 0.04, -0.7], [0, 0.55, -1.08], [0, 0.06, -0.86], fin, null);
  t.tri([0, 0.03, -0.72], [0, -0.03, -0.86], [0, -0.32, -0.98], fin, null);
  // 小背鰭與臀鰭
  t.tri([0, 0.12, -0.5], [0, 0.24, -0.62], [0, 0.1, -0.6], fin, null);
  return t.build();
}

/** 魟魚（翼展 2，頭在 +z）：上面深藍、下面白色的菱形翅膀，加上頭鰭與細長的尾巴 */
function mantaGeo(): THREE.BufferGeometry {
  const t = new TriBuilder();
  const top = new THREE.Color(0x24344a), bottom = new THREE.Color(0xe6ecf0);
  const COLS = 12, ROWS = 4;
  const front = (x: number) => 0.42 * (1 - Math.abs(x)) + 0.04;
  const back = (x: number) => -0.3 * (1 - Math.pow(Math.abs(x), 0.6)) - 0.02;
  const thick = (x: number, v: number) => 0.075 * Math.pow(1 - Math.abs(x), 1.4) * Math.sin(Math.PI * v);
  const P = (i: number, j: number, s: number): number[] => {
    const x = -1 + (2 * i) / COLS, v = j / ROWS;
    const z = back(x) + (front(x) - back(x)) * v;
    return [x, s * thick(x, v) * (s > 0 ? 1 : 0.6), z];
  };
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      for (const s of [1, -1]) {
        const a = P(i, j, s), b = P(i + 1, j, s), c = P(i, j + 1, s), d = P(i + 1, j + 1, s);
        const cen = [0, -s, 0];
        t.tri(a, b, c, s > 0 ? top : bottom, cen);
        t.tri(b, d, c, s > 0 ? top : bottom, cen);
      }
    }
  }
  // 頭鰭與尾巴（兩面）
  for (const s of [1, -1]) t.tri([s * 0.12, 0, 0.42], [s * 0.2, -0.02, 0.6], [s * 0.2, 0, 0.4], top, null);
  t.tri([0.025, 0.01, -0.28], [-0.025, 0.01, -0.28], [0, 0.0, -1.3], top, null);
  return t.build();
}

/** 水母：半球形的傘（開口朝下）與 8 條觸手；aTent = 1 標記觸手 */
function jellyGeo(): THREE.BufferGeometry {
  const bell = new THREE.SphereGeometry(1, 12, 6, 0, TAU, 0, Math.PI / 2).scale(1, 0.75, 1).toNonIndexed();
  bell.deleteAttribute('uv');
  const n = bell.attributes.position.count;
  const tentPos: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU, r = 0.72;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const w = 0.05;
    for (let s = 0; s < 5; s++) {
      const y0 = -s * 0.55, y1 = -(s + 1) * 0.55;
      const ox = -Math.sin(a) * w, oz = Math.cos(a) * w;
      tentPos.push(x - ox, y0, z - oz, x + ox, y0, z + oz, x + ox, y1, z + oz, x - ox, y0, z - oz, x + ox, y1, z + oz, x - ox, y1, z - oz);
    }
  }
  const pos = new Float32Array(n * 3 + tentPos.length);
  pos.set(bell.attributes.position.array as Float32Array, 0);
  pos.set(tentPos, n * 3);
  const tent = new Float32Array(pos.length / 3);
  tent.fill(1, n);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTent', new THREE.BufferAttribute(tent, 1));
  return g;
}

/** 一個面朝鏡頭的四邊形（位置在頂點著色器裡算） */
function quad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ---------- 材質 ----------

/**
 * 會游的生物共用：Lambert 打光＋霧，頂點著色器把模型座標換成世界座標（instanceMatrix 是單位矩陣）。
 * motion：算出 pos（中心）、fwd（前進方向）與 lp（模型座標，含擺動）的 GLSL。
 */
function swimMat(uTime: { value: number }, key: string, attrs: string, motion: string, side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = `uniform float uTime;\n${attrs}\n` + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        vec3 pos; vec3 fwd; vec3 lp; float bank = 0.0;
        ${motion}
        vec3 upv = vec3(0.0, 1.0, 0.0);
        vec3 sidev = normalize(cross(upv, fwd));
        upv = normalize(cross(fwd, sidev));
        // 轉彎時往內側傾斜
        vec3 sd = sidev * cos(bank) + upv * sin(bank);
        vec3 ud = upv * cos(bank) - sidev * sin(bank);
        vec3 objectNormal = normalize(sd * normal.x + ud * normal.y + fwd * normal.z);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = pos + sd * lp.x + ud * lp.y + fwd * lp.z;');
  };
  m.customProgramCacheKey = () => 'ocean-swim-' + key;
  return m;
}

// ---------- 主程式 ----------

export function buildLife(ctx: LifeCtx): Life {
  const group = new THREE.Group();
  group.name = 'ocean-life';
  const uTime = { value: 0 };
  const uLight = { value: 1 };
  const rng = mulberry32(2024);
  const color = new THREE.Color();
  const sunDir = ctx.sunDir.clone().normalize();

  const addInst = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number, attrs: Record<string, [Float32Array, number]>, colors?: Float32Array): THREE.InstancedMesh => {
    for (const [name, [arr, size]] of Object.entries(attrs)) geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
    const im = new THREE.InstancedMesh(geo, mat, count);
    if (colors) im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    im.frustumCulled = false;
    group.add(im);
    return im;
  };

  // ---------- 魚群 ----------
  {
    const total = ctx.schools.reduce((s, c) => s + c.n, 0);
    if (total > 0) {
      const orbit = new Float32Array(total * 4), move = new Float32Array(total * 4), off = new Float32Array(total * 3), cols = new Float32Array(total * 3);
      let i = 0;
      for (const sc of ctx.schools) {
        const ph0 = rng() * TAU;
        const w = (sc.dir * (3.2 + rng() * 2.4)) / Math.max(4, sc.r);
        color.setHex(sc.color);
        for (let k = 0; k < sc.n; k++, i++) {
          orbit.set([sc.x, sc.y, sc.z, sc.r], i * 4);
          move.set([w * (0.95 + rng() * 0.1), ph0 + (rng() - 0.5) * 0.5, 0.6 + rng() * 1.2, sc.size * (0.75 + rng() * 0.5)], i * 4);
          off.set([(rng() - 0.5) * 6, (rng() - 0.5) * 4, (rng() - 0.5) * 3.2], i * 3);
          const v = 0.85 + rng() * 0.3;
          cols.set([color.r * v, color.g * v, color.b * v], i * 3);
        }
      }
      const mat = swimMat(uTime, 'fish', 'attribute vec4 aOrbit;\nattribute vec4 aMove;\nattribute vec3 aOff;', `
        float ang = aMove.y + uTime * aMove.x;
        float R = aOrbit.w + aOff.y;
        pos = aOrbit.xyz + vec3(cos(ang) * R, aOff.z + sin(uTime * 0.6 + aMove.y * 5.0) * aMove.z, sin(ang) * R);
        fwd = normalize(vec3(-sin(ang), 0.0, cos(ang)) * sign(aMove.x));
        pos += fwd * aOff.x;
        // 偶爾一起轉向：前進方向加一點上下起伏
        fwd = normalize(fwd + vec3(0.0, cos(uTime * 0.6 + aMove.y * 5.0) * 0.15, 0.0));
        lp = position * aMove.w;
        lp.x += sin(uTime * 11.0 + aMove.y * 9.0 + position.z * 4.0) * 0.16 * smoothstep(0.25, -0.6, position.z) * aMove.w;
        bank = -sign(aMove.x) * 0.25;`, THREE.DoubleSide);
      addInst(fishGeo(), mat, total, { aOrbit: [orbit, 4], aMove: [move, 4], aOff: [off, 3] }, cols);
    }
  }

  // ---------- 鯊魚、魟魚：沿大圓巡游 ----------
  const cruisers = (list: Cruiser[], geo: THREE.BufferGeometry, key: string, wiggle: string, side: THREE.Side) => {
    if (!list.length) return;
    const path = new Float32Array(list.length * 4), prm = new Float32Array(list.length * 4);
    list.forEach((c, i) => {
      path.set([c.x, c.y, c.z, c.r], i * 4);
      prm.set([(c.speed / c.r) * (rng() < 0.5 ? 1 : -1), rng() * TAU, c.size, 1 + rng() * 2], i * 4);
    });
    const mat = swimMat(uTime, key, 'attribute vec4 aPath;\nattribute vec4 aPrm;', `
      float ang = aPrm.y + uTime * aPrm.x;
      pos = aPath.xyz + vec3(cos(ang) * aPath.w, sin(uTime * 0.23 + aPrm.y) * aPrm.w, sin(ang) * aPath.w);
      fwd = normalize(vec3(-sin(ang), cos(uTime * 0.23 + aPrm.y) * aPrm.w * 0.23 / max(1.0, abs(aPrm.x) * aPath.w), cos(ang)) * vec3(sign(aPrm.x), 1.0, sign(aPrm.x)));
      lp = position * aPrm.z;
      ${wiggle}
      bank = -sign(aPrm.x) * 0.22;`, side);
    addInst(geo, mat, list.length, { aPath: [path, 4], aPrm: [prm, 4] });
  };
  // 鯊魚：尾巴左右擺，越後面擺越大
  cruisers(ctx.sharks, sharkGeo(), 'shark', `
      float sw = sin(uTime * 2.3 + aPrm.y * 3.0 - position.z * 2.4);
      lp.x += sw * 0.1 * pow(max(0.0, 0.55 - position.z), 1.7) * aPrm.z;`, THREE.DoubleSide);
  // 魟魚：翅膀上下拍動，翅尖晚一點跟上
  cruisers(ctx.mantas, mantaGeo(), 'manta', `
      float fl = sin(uTime * 1.25 + aPrm.y * 3.0 - abs(position.x) * 1.3);
      lp.y += fl * pow(abs(position.x), 1.35) * 0.42 * aPrm.z;
      lp.z += -abs(fl) * abs(position.x) * 0.04 * aPrm.z;`, THREE.DoubleSide);

  // ---------- 水母（海溝） ----------
  if (ctx.jellies.length) {
    const n = ctx.jellies.length;
    const base = new Float32Array(n * 4), prm = new Float32Array(n * 4), cols = new Float32Array(n * 3);
    ctx.jellies.forEach((j, i) => {
      base.set([j.x, j.y, j.z, j.h], i * 4);
      prm.set([rng() * TAU, j.size, 0.5 + rng() * 0.6, rng()], i * 4);
      color.setHex(j.color);
      cols.set([color.r, color.g, color.b], i * 3);
    });
    const geo = jellyGeo();
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 4));
    geo.setAttribute('aPrm', new THREE.InstancedBufferAttribute(prm, 4));
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(cols, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec4 aBase; attribute vec4 aPrm; attribute vec3 aCol; attribute float aTent;
        varying vec3 vCol; varying float vA;
        void main() {
          float ph = aPrm.x, sz = aPrm.y;
          float pulse = sin(uTime * 2.1 * aPrm.z + ph);
          vec3 p = position;
          if (aTent < 0.5) {
            p.xz *= 1.0 + 0.16 * pulse;
            p.y *= 1.0 - 0.14 * pulse;
          } else {
            p.x += sin(uTime * 1.6 + p.y * 1.8 + ph) * 0.16 * -p.y;
            p.z += cos(uTime * 1.3 + p.y * 1.5 + ph) * 0.16 * -p.y;
          }
          // 一縮一放慢慢往上漂，到頂之後回到底部（兩端淡出）
          float u = fract(uTime * 0.018 * aPrm.z + aPrm.w);
          vec3 c = aBase.xyz + vec3(sin(uTime * 0.2 + ph) * 2.0, u * aBase.w, cos(uTime * 0.17 + ph) * 2.0);
          vec4 mv = viewMatrix * vec4(c + p * sz, 1.0);
          gl_Position = projectionMatrix * mv;
          float fade = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.85, 1.0, u)) * (1.0 - smoothstep(110.0, 220.0, -mv.z));
          vCol = aCol * (aTent > 0.5 ? 0.55 * (1.0 + p.y * 0.3) : 1.0 + 0.35 * pulse);
          vA = fade * (aTent > 0.5 ? 0.6 : 0.85);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vA;
        void main() { gl_FragColor = vec4(vCol * vA, 1.0); }`,
    });
    const im = new THREE.InstancedMesh(geo, mat, n);
    cullSphere(im, base, 4, 6, 34);
    group.add(im);
  }

  // ---------- 面朝鏡頭的小光點：發光浮游生物（加亮）與氣泡 ----------
  const sprites = (count: number, a0: Float32Array, a1: Float32Array, a2: Float32Array, key: string, motion: string, frag: string, additive: boolean, padY: number) => {
    if (!count) return;
    const geo = quad();
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(a0, 4));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(a1, 4));
    geo.setAttribute('aC', new THREE.InstancedBufferAttribute(a2, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime },
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec4 aA; attribute vec4 aB; attribute vec3 aC;
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main() {
          vec3 c; float size; float alpha;
          ${motion}
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy * 2.0;
          vCol = aC;
          vA = alpha * (1.0 - smoothstep(90.0, 170.0, -mv.z)) * smoothstep(0.5, 2.0, -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          ${frag}
        }`,
    });
    mat.name = key;
    const im = new THREE.InstancedMesh(geo, mat, count);
    cullSphere(im, a0, 4, 5, padY);
    group.add(im);
  };
  if (ctx.glows.length) {
    const n = ctx.glows.length;
    const a = new Float32Array(n * 4), b = new Float32Array(n * 4), c = new Float32Array(n * 3);
    ctx.glows.forEach((g, i) => {
      a.set([g.x, g.y, g.z, g.size], i * 4);
      b.set([rng() * TAU, 0.6 + rng() * 1.6, 1 + rng() * 3, rng()], i * 4);
      color.setHex(g.color);
      c.set([color.r, color.g, color.b], i * 3);
    });
    sprites(n, a, b, c, 'glow', `
      float tw = 0.5 + 0.5 * sin(uTime * aB.y + aB.x);
      c = aA.xyz + vec3(sin(uTime * 0.31 + aB.x) * aB.z, sin(uTime * 0.23 + aB.x * 2.0) * 1.2, cos(uTime * 0.27 + aB.x) * aB.z);
      size = aA.w * (0.7 + 0.5 * tw);
      alpha = 0.35 + 0.65 * tw;`, `
      float k = pow(max(0.0, 1.0 - r), 2.2);
      gl_FragColor = vec4(vCol * k * vA * 1.6, 1.0);`, true, 4);
  }
  if (ctx.vents.length) {
    const per = ctx.tier === 0 ? 14 : ctx.tier === 1 ? 22 : 30;
    const n = ctx.vents.length * per;
    const a = new Float32Array(n * 4), b = new Float32Array(n * 4), c = new Float32Array(n * 3);
    let i = 0;
    for (const v of ctx.vents) {
      for (let k = 0; k < per; k++, i++) {
        a.set([v.x + (rng() - 0.5) * 1.2, v.y, v.z + (rng() - 0.5) * 1.2, v.h], i * 4);
        b.set([rng(), 2.2 + rng() * 2.2, 0.12 + rng() * 0.3, rng() * TAU], i * 4);
        c.set([0.85, 0.97, 1.0], i * 3);
      }
    }
    sprites(n, a, b, c, 'bubbles', `
      float u = fract(aB.x + uTime * aB.y / aA.w);
      c = aA.xyz + vec3(sin(uTime * 2.1 + aB.w) * 0.35 * u, u * aA.w, cos(uTime * 1.7 + aB.w) * 0.35 * u);
      size = aB.z * (0.7 + u * 0.9);
      alpha = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.85, 1.0, u)) * 0.85;`, `
      // 氣泡：透明的圓，邊緣一圈亮、左上一個反光點
      float ring = smoothstep(0.62, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r));
      float hl = 1.0 - smoothstep(0.0, 0.28, length(vUv - vec2(-0.32, 0.36)));
      gl_FragColor = vec4(vCol, min(1.0, (ring * 0.75 + hl * 0.9 + 0.08) * vA));`, false, 50);
  }

  // ---------- 光束：從水面斜射下來，越往下越淡 ----------
  if (ctx.shafts.length) {
    const n = ctx.shafts.length;
    const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
    ctx.shafts.forEach((s, i) => {
      a.set([s.x, s.z, s.w, s.len], i * 4);
      b.set([rng() * TAU, s.k, 0.2 + rng() * 0.3, 0], i * 4);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(a, 4));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(b, 4));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uLight, uSurf: { value: ctx.surfaceY }, uDir: { value: sunDir.clone().negate() }, uCol: { value: new THREE.Color(0.55, 0.9, 1.0) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uSurf; uniform vec3 uDir;
        attribute vec4 aA; attribute vec4 aB;
        varying vec2 vUv; varying float vK; varying float vFade;
        void main() {
          vec3 top = vec3(aA.x, uSurf, aA.y);
          vec3 p = top + uDir * (1.0 - position.y) * aA.w;
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(uDir, toCam));
          p += side * position.x * aA.z;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vUv = vec2(position.x * 2.0, position.y);
          vK = aB.y * (0.65 + 0.35 * sin(uTime * aB.z + aB.x));
          vFade = (1.0 - smoothstep(160.0, 320.0, -mv.z)) * smoothstep(2.0, 14.0, -mv.z);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; uniform float uLight;
        varying vec2 vUv; varying float vK; varying float vFade;
        void main() {
          // 內插後的 |x| 可能略大於 1：pow 的底數不能是負的（NaN 會被泛光擴散成整片黑）
          float across = pow(max(0.0, 1.0 - abs(vUv.x)), 1.6);
          float along = smoothstep(0.0, 0.55, vUv.y) * (0.6 + 0.4 * vUv.y);
          gl_FragColor = vec4(uCol * across * along * vK * vFade * 0.36 * uLight, 1.0);
        }`,
    });
    const im = new THREE.InstancedMesh(geo, mat, n);
    const tops = new Float32Array(n * 3);
    let maxLen = 0;
    ctx.shafts.forEach((s, i) => { tops.set([s.x, ctx.surfaceY, s.z], i * 3); maxLen = Math.max(maxLen, s.len); });
    cullSphere(im, tops, 3, 20, -maxLen);
    im.renderOrder = 6;
    group.add(im);
  }

  // ---------- 水面：從下面往上看，波光粼粼 ----------
  {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime, uLight, uCau: { value: ctx.causticTex }, uCol: { value: new THREE.Color(0x8ff0ff) }, uDeep: { value: new THREE.Color(0x2a9cc0) },
      },
      fog: true,
      vertexShader: /* glsl */ `
        varying vec3 vW;
        #include <fog_pars_vertex>
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uCau; uniform vec3 uCol; uniform vec3 uDeep; uniform float uLight;
        varying vec3 vW;
        #include <fog_pars_fragment>
        void main() {
          float a = texture2D(uCau, vW.xz * 0.011 + uTime * vec2(0.006, 0.004)).r;
          float b = texture2D(uCau, vW.xz * 0.016 + vec2(0.3, 0.7) - uTime * vec2(0.005, 0.007)).r;
          float c = min(a, b);
          vec3 col = mix(uDeep, uCol, 0.3 + c * 0.7) * (0.85 + c * 0.6) * uLight;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const surf = new THREE.Mesh(new THREE.PlaneGeometry(3600, 3600, 1, 1).rotateX(Math.PI / 2), mat);
    surf.position.set(ctx.center[0], ctx.surfaceY, ctx.center[1]);
    surf.frustumCulled = false;
    surf.renderOrder = -5;
    group.add(surf);
  }

  return {
    group,
    update(time) {
      uTime.value = time;
    },
    setLight(k) {
      uLight.value = k;
    },
  };
}
