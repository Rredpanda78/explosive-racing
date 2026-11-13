import * as THREE from 'three';

export type WeatherKind = 'petals' | 'sand' | 'rain';

export interface WeatherOpts {
  mobile: boolean;
  /** 地面高度（splash、沙塵貼地用） */
  groundY: (x: number, z: number) => number;
  /** 花瓣換成別的東西（例如廟口的金紙灰燼）：[顏色, 亮度倍率]，亮度 > 1 的會發光 */
  petals?: [number, number][];
}

const R = Math.random;
const TAU = Math.PI * 2;
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrapM = (a: number, m: number): number => ((a % m) + m) % m;
const PETAL_COLS = [0xf6b3c6, 0xf9cdd9, 0xfff0ec, 0xf0a0b6];
const LEAF_COLS = [0x7da046, 0x96b450, 0xe0883a, 0xcf6a2c];
const BOLT_SEG = 40;

// 相機周圍循環的粒子場（雨絲／沙塵／花瓣），位置完全在 GPU 計算
const FIELD_VERT = /* glsl */ `
attribute vec4 aSeed;
#ifdef PETAL
attribute vec4 aColor;
varying vec3 vColor;
varying float vShade;
varying float vLeaf;
#endif
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uDisp;
uniform vec3 uVel;
uniform vec3 uPlayer;
uniform float uTime;
uniform float uVar;
uniform float uLean;
uniform float uSway;
uniform vec4 uShape;
uniform float uMaxLen;
varying vec2 vUv;
varying float vFade;
#include <fog_pars_vertex>
void main() {
  float s = aSeed.w;
  float k = 1.0 + uVar * (s * 2.0 - 1.0);
  vec3 h = 0.5 * uBox;
  vec3 rel = mod(aSeed.xyz * uBox + uDisp * k - uCenter + h, uBox) - h;
  vec3 c = uCenter + rel;
  vFade = 1.0 - smoothstep(0.7, 1.0, max(abs(rel.x) / h.x, abs(rel.z) / h.z));
#ifdef ANCHOR_Y
  c.y = uCenter.y + aSeed.y * aSeed.y * uBox.y + sin(uTime * (0.6 + s) + s * 50.0) * 0.5;
#else
  vFade *= 1.0 - smoothstep(0.8, 1.0, abs(rel.y) / h.y);
#endif
  c.x += sin(uTime * (0.9 + s * 0.8) + s * 61.0) * uSway;
  c.z += cos(uTime * (0.7 + s * 0.9) + s * 37.0) * uSway;
  vec3 toCam = cameraPosition - c;
  float dist = max(length(toCam), 1e-3);
  vUv = position.xy;
  vec3 wp;
#ifdef PETAL
  vColor = aColor.rgb;
  vLeaf = aColor.a;
  float sz = uShape.x * (0.75 + 0.5 * fract(s * 29.0)) * (1.0 + 0.7 * aColor.a)
    * (1.0 + dist * 0.015) * vFade * smoothstep(0.4, 1.8, dist);
  float ang = uTime * (1.2 + 2.8 * fract(s * 7.0)) + s * 30.0;
  vec3 ax = normalize(vec3(fract(s * 13.0) - 0.5, fract(s * 17.0) - 0.2, fract(s * 23.0) - 0.5));
  float cs = cos(ang), sn = sin(ang);
  vec3 lp = vec3(position.x, position.y - 0.5, 0.0) * sz;
  wp = c + lp * cs + cross(ax, lp) * sn + ax * dot(ax, lp) * (1.0 - cs);
  vec3 n = vec3(0.0, 0.0, cs) + cross(ax, vec3(0.0, 0.0, 1.0)) * sn + ax * ax.z * (1.0 - cs);
  vShade = 0.55 + 0.4 * abs(dot(n, vec3(0.45, 0.8, 0.4)));
#else
  // 條紋沿「相對相機的速度」拉長
  vec3 v = uVel * k - uPlayer * uLean;
  float sp = max(length(v), 1e-3);
  vec3 dir = v / sp;
  float len = clamp(sp * uShape.z, uShape.w, uMaxLen);
  vec3 side = cross(dir, toCam / dist);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
  wp = c + side * (position.x * (uShape.x + dist * uShape.y)) - dir * (position.y * len);
  vFade *= smoothstep(0.8, 3.0, dist);
#endif
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vFade;
#ifdef PETAL
varying vec3 vColor;
varying float vShade;
varying float vLeaf;
#endif
#include <fog_pars_fragment>
void main() {
#ifdef PETAL
  vec2 p = vec2(vUv.x, vUv.y - 0.5);
  float shade = vShade;
  if (vLeaf > 0.5) {
    if (abs(p.x) > 0.34 * (1.0 - 4.0 * p.y * p.y)) discard;
    if (abs(p.x) < 0.025) shade *= 0.8;
  } else {
    if (p.x * p.x / 0.09 + p.y * p.y / 0.25 > 1.0) discard;
    if (p.y > 0.38 && abs(p.x) < 0.06) discard;
    shade *= 0.85 + 0.25 * (p.y + 0.5);
  }
  gl_FragColor = vec4(vColor * shade * vec3(1.0, 0.94, 0.86), 1.0);
#else
  float a = (1.0 - abs(vUv.x) * 2.0) * sin(3.14159 * vUv.y);
  gl_FragColor = vec4(uColor, uOpacity * vFade * a);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// CPU 擺位的面片：一般為面向相機的柔和煙團，RING 為貼地水花圈
const SPRITE_VERT = /* glsl */ `
attribute vec4 aP;
attribute vec2 aQ;
varying vec2 vUv;
varying vec2 vQ;
#include <fog_pars_vertex>
void main() {
  vec2 q = position.xy - vec2(0.0, 0.5);
  vUv = q;
  vQ = aQ;
#ifdef RING
  vec4 mvPosition = viewMatrix * vec4(aP.xyz + vec3(q.x, 0.0, q.y) * aP.w, 1.0);
#else
  float cs = cos(aQ.y), sn = sin(aQ.y);
  vec4 mvPosition = viewMatrix * vec4(aP.xyz, 1.0);
  mvPosition.xy += mat2(cs, sn, -sn, cs) * q * aP.w;
#endif
  gl_Position = projectionMatrix * mvPosition;
  if (aQ.x <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  #include <fog_vertex>
}`;

const SPRITE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying vec2 vQ;
#include <fog_pars_fragment>
void main() {
  float r = length(vUv) * 2.0;
#ifdef RING
  float ph = vQ.y;
  float a = smoothstep(0.16, 0.0, abs(r - ph)) * (1.0 - ph)
    + smoothstep(0.35, 0.0, r) * (1.0 - smoothstep(0.0, 0.3, ph)) * 0.8;
#else
  float an = atan(vUv.y, vUv.x + 1e-5);
  float lump = 1.0 + 0.16 * sin(an * 3.0 + vQ.y * 2.0) + 0.09 * sin(an * 5.0 - vQ.y * 3.0);
  float a = smoothstep(1.0, 0.05, r * lump);
  a *= a;
#endif
  a *= vQ.x;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function quadGeo(n: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = n;
  return g;
}

function shaderMat(
  vert: string, frag: string, defines: Record<string, string>,
  uniforms: Record<string, THREE.IUniform>, transparent: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    defines,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    fog: true,
    transparent,
    depthWrite: !transparent,
    side: THREE.DoubleSide,
  });
}

/** 每個實例：p = (x, y, z, 尺寸)，q = (透明度, 旋轉角/水花進度) */
class Sprites {
  readonly mesh: THREE.Mesh;
  readonly p: Float32Array;
  readonly q: Float32Array;
  private pa: THREE.InstancedBufferAttribute;
  private qa: THREE.InstancedBufferAttribute;

  constructor(n: number, ring: boolean, color: number) {
    const g = quadGeo(n);
    this.p = new Float32Array(n * 4);
    this.q = new Float32Array(n * 2);
    this.pa = new THREE.InstancedBufferAttribute(this.p, 4).setUsage(THREE.DynamicDrawUsage);
    this.qa = new THREE.InstancedBufferAttribute(this.q, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP', this.pa);
    g.setAttribute('aQ', this.qa);
    const m = shaderMat(SPRITE_VERT, SPRITE_FRAG, ring ? { RING: '' } : {}, { uColor: { value: new THREE.Color(color) } }, true);
    if (ring) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -2;
    }
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
  }

  flush(): void {
    this.pa.needsUpdate = true;
    this.qa.needsUpdate = true;
  }
}

interface FieldCfg {
  count: number;
  box: [number, number, number];
  defines: Record<string, string>;
  color: number;
  opacity: number;
  /** 條紋：寬、寬隨距離增量、長度/速度、最短長度；花瓣：x = 大小 */
  shape: [number, number, number, number];
  maxLen: number;
  vary: number;
  lean: number;
  sway: number;
}

export class Weather {
  group = new THREE.Group();
  /** 這一幀閃電的亮度 0~1（只有 rain 會 > 0），由外部拿去調亮環境光 */
  flash = 0;

  private kind: WeatherKind;
  private opts: WeatherOpts;
  private t = 0;
  private primed = false;
  private meshes: THREE.Mesh[] = [];
  private cam = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  // 粒子場 uniform（直接持有向量參考）
  private fieldMat!: THREE.ShaderMaterial;
  private center = new THREE.Vector3();
  private disp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private player = new THREE.Vector3();
  private baseOpacity = 1;
  // 風與陣風
  private windAng = R() * TAU;
  private gust = 0;
  private gustIn = 4 + R() * 6;
  private gustAge = -1;
  private gustLen = 3;
  private gustAng = 0;
  private groundSm = NaN;
  // 雨：水花、閃電
  private splash: Sprites | null = null;
  private splLife = new Float32Array(0);
  private splDur = new Float32Array(0);
  private strikeIn = 3 + R() * 6;
  private strikeAge = -1;
  private pulseAt = new Float32Array(3);
  private pulseAmp = new Float32Array(3);
  private bolt: THREE.Mesh | null = null;
  private boltMat: THREE.MeshBasicMaterial | null = null;
  private boltPos = new Float32Array(0);
  private boltSeg = 0;
  private mainPts = new Float32Array(21 * 3);
  private branchPts = new Float32Array(8 * 3);
  // 沙：低空煙團、塵捲風
  private wisps: Sprites | null = null;
  private wispData = new Float32Array(0); // 地面高、離地高、透明度、轉速
  private rr = 0;
  private devil: Sprites | null = null;
  private devilData = new Float32Array(0); // 起始高度比、相位、半徑係數、是否為底部裙擺
  private devilIn = 4 + R() * 8;
  private devilAge = -1;
  private devilX = 0;
  private devilY = 0;
  private devilZ = 0;
  private devilH = 20;
  private devilVX = 0;
  private devilVZ = 0;
  private devilGT = 0;

  constructor(kind: WeatherKind, opts: WeatherOpts) {
    this.kind = kind;
    this.opts = opts;
    this.group.name = 'weather';
    const n = (c: number): number => Math.max(1, Math.round(c * (opts.mobile ? 0.4 : 1)));
    if (kind === 'rain') {
      this.makeField({
        count: n(3000), box: [120, 50, 120], defines: {}, color: 0xc4d4ec, opacity: 0.55,
        shape: [0.012, 0.0009, 0.03, 0.5], maxLen: 2.2, vary: 0.12, lean: 0.8, sway: 0,
      });
      const ns = n(160);
      this.splash = this.addSprites(ns, true, 0xc4d6f0);
      this.splLife = new Float32Array(ns);
      this.splDur = new Float32Array(ns);
      this.makeBolt();
    } else if (kind === 'sand') {
      this.makeField({
        count: n(1500), box: [160, 30, 160], defines: { ANCHOR_Y: '' }, color: 0xd9b58a, opacity: 0.8,
        shape: [0.09, 0.0016, 0.024, 0.3], maxLen: 1.1, vary: 0.3, lean: 0.5, sway: 0,
      });
      const nw = n(120);
      const wi = (this.wisps = this.addSprites(nw, false, 0xd6aa80));
      this.wispData = new Float32Array(nw * 4);
      for (let i = 0; i < nw; i++) {
        const s = 3 + R() * 6;
        wi.p[i * 4] = (R() - 0.5) * 160;
        wi.p[i * 4 + 2] = (R() - 0.5) * 160;
        wi.p[i * 4 + 3] = s;
        wi.q[i * 2 + 1] = R() * TAU;
        this.wispData.set([0, s * 0.3 + R() * 1.5, 0.22 + R() * 0.16, (R() - 0.5) * 0.3], i * 4);
      }
      const nd = n(260);
      this.devil = this.addSprites(nd, false, 0xc49166);
      this.devil.mesh.visible = false;
      this.devilData = new Float32Array(nd * 4);
      for (let i = 0; i < nd; i++) this.devilData.set([R(), R() * TAU, 0.7 + R() * 0.4, R() < 0.2 ? 1 : 0], i * 4);
    } else {
      const geo = this.makeField({
        count: n(500), box: [70, 26, 70], defines: { PETAL: '' }, color: 0xffffff, opacity: 1,
        shape: [0.2, 0, 0, 0], maxLen: 0, vary: 0.3, lean: 0, sway: 0.6,
      });
      const cnt = geo.instanceCount;
      const col = new Float32Array(cnt * 4);
      const c = new THREE.Color();
      for (let i = 0; i < cnt; i++) {
        const custom = opts.petals;
        const leaf = !custom && R() < 0.14;
        if (custom) {
          const [hx, k] = custom[Math.floor(R() * custom.length)];
          c.setHex(hx).multiplyScalar(k);
        } else {
          const pal = leaf ? LEAF_COLS : PETAL_COLS;
          c.setHex(pal[Math.floor(R() * pal.length)]);
        }
        col.set([c.r, c.g, c.b, leaf ? 1 : 0], i * 4);
      }
      geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 4));
    }
  }

  private add(m: THREE.Mesh): void {
    this.group.add(m);
    this.meshes.push(m);
  }

  private addSprites(n: number, ring: boolean, color: number): Sprites {
    const s = new Sprites(n, ring, color);
    this.add(s.mesh);
    return s;
  }

  private makeField(c: FieldCfg): THREE.InstancedBufferGeometry {
    const geo = quadGeo(c.count);
    const seed = new Float32Array(c.count * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = R();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    const petal = 'PETAL' in c.defines;
    this.baseOpacity = c.opacity;
    this.fieldMat = shaderMat(FIELD_VERT, FIELD_FRAG, c.defines, {
      uCenter: { value: this.center },
      uBox: { value: new THREE.Vector3(c.box[0], c.box[1], c.box[2]) },
      uDisp: { value: this.disp },
      uVel: { value: this.vel },
      uPlayer: { value: this.player },
      uTime: { value: 0 },
      uVar: { value: c.vary },
      uLean: { value: c.lean },
      uSway: { value: c.sway },
      uShape: { value: new THREE.Vector4(c.shape[0], c.shape[1], c.shape[2], c.shape[3]) },
      uMaxLen: { value: c.maxLen },
      uColor: { value: new THREE.Color(c.color) },
      uOpacity: { value: c.opacity },
    }, !petal);
    const mesh = new THREE.Mesh(geo, this.fieldMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = petal ? 0 : 9;
    this.add(mesh);
    return geo;
  }

  private makeBolt(): void {
    const g = new THREE.BufferGeometry();
    this.boltPos = new Float32Array(BOLT_SEG * 12);
    g.setAttribute('position', new THREE.BufferAttribute(this.boltPos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let s = 0; s < BOLT_SEG; s++) {
      const b = s * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setIndex(idx);
    this.boltMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, side: THREE.DoubleSide,
    });
    this.bolt = new THREE.Mesh(g, this.boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = 8;
    this.add(this.bolt);
  }

  private ground(x: number, z: number, fallback: number): number {
    const y = this.opts.groundY(x, z);
    return Number.isFinite(y) ? y : fallback;
  }

  update(dt: number, _time: number, camera: THREE.Camera, vx: number, vz: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.t += dt;
    const cam = camera.getWorldPosition(this.cam);
    camera.getWorldDirection(this.fwd);
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const fx = this.fwd.x / fl, fz = this.fwd.z / fl;
    this.updateGust(dt);
    const wa = this.windAng + 0.3 * Math.sin(this.t * 0.05);
    const wx = Math.cos(wa), wz = Math.sin(wa);
    const g = this.gust;
    const u = this.fieldMat.uniforms;
    if (this.kind === 'rain') {
      this.vel.set(wx * 3, -40, wz * 3);
      this.center.set(cam.x, cam.y + 10, cam.z);
    } else if (this.kind === 'sand') {
      const gy = this.ground(cam.x, cam.z, cam.y - 4.5);
      this.groundSm = Number.isFinite(this.groundSm) ? this.groundSm + (gy - this.groundSm) * Math.min(1, dt * 2) : gy;
      const sp = 12 * (1 + 0.6 * g);
      this.vel.set(wx * sp, 0, wz * sp);
      this.center.set(cam.x, this.groundSm - 1, cam.z);
    } else {
      // 陣風：側向把花瓣吹快、略微上揚
      const gx = Math.cos(this.gustAng) * 7 * g, gz = Math.sin(this.gustAng) * 7 * g;
      this.vel.set(wx * 1.2 + gx, -1.1 + 0.5 * g, wz * 1.2 + gz);
      this.center.set(cam.x, cam.y + 4, cam.z);
      u.uSway.value = 0.6 + 0.5 * g;
    }
    this.disp.addScaledVector(this.vel, dt);
    if (this.disp.lengthSq() > 4e9) this.disp.set(0, 0, 0); // 避免浮點精度流失
    this.player.set(vx, 0, vz);
    u.uTime.value = this.t;

    if (this.kind === 'rain') {
      this.updateRain(dt, cam, fx, fz);
      u.uOpacity.value = this.baseOpacity * (1 + 1.5 * this.flash);
    } else if (this.kind === 'sand') {
      this.updateSand(dt, cam, fx, fz, wx, wz, g);
    }
    this.primed = true;
  }

  private updateGust(dt: number): void {
    if (this.gustAge < 0) {
      this.gust = 0;
      this.gustIn -= dt;
      if (this.gustIn <= 0) {
        this.gustAge = 0;
        this.gustLen = 2.5 + R() * 2;
        this.gustAng = this.windAng + (R() - 0.5) * 1.2;
      }
      return;
    }
    this.gustAge += dt;
    const k = this.gustAge / this.gustLen;
    if (k >= 1) {
      this.gustAge = -1;
      this.gustIn = 6 + R() * 9;
      this.gust = 0;
      return;
    }
    const s = Math.sin(Math.PI * k);
    this.gust = s * s;
  }

  // ---------- 雨 ----------
  private spawnSplash(i: number, cam: THREE.Vector3, fx: number, fz: number): void {
    const sp = this.splash;
    if (!sp) return;
    const a = R() * TAU, r = Math.sqrt(R()) * 18;
    const x = cam.x + fx * 12 + Math.cos(a) * r, z = cam.z + fz * 12 + Math.sin(a) * r;
    const o = i * 4;
    sp.p[o] = x;
    sp.p[o + 1] = this.ground(x, z, cam.y - 4.5) + 0.04;
    sp.p[o + 2] = z;
    sp.p[o + 3] = 0.3 + R() * 0.35;
    sp.q[i * 2] = 0.3 + R() * 0.3;
    this.splDur[i] = 0.3 + R() * 0.25;
  }

  private updateRain(dt: number, cam: THREE.Vector3, fx: number, fz: number): void {
    const sp = this.splash;
    if (sp) {
      for (let i = 0; i < this.splLife.length; i++) {
        let l: number;
        if (!this.primed) {
          this.spawnSplash(i, cam, fx, fz);
          l = R();
        } else {
          l = this.splLife[i] + dt / this.splDur[i];
          if (l >= 1) {
            this.spawnSplash(i, cam, fx, fz);
            l = 0;
          }
        }
        this.splLife[i] = l;
        sp.q[i * 2 + 1] = l;
      }
      sp.flush();
    }
    // 閃電：主閃 + 偶爾的二、三次閃爍，每次 0.25 s 內衰減
    if (this.strikeAge < 0) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) this.strike(cam, fx, fz);
    }
    let f = 0;
    if (this.strikeAge >= 0) {
      for (let j = 0; j < 3; j++) {
        const a = this.strikeAge - this.pulseAt[j];
        if (a >= 0 && a < 0.25) {
          const k = 1 - a / 0.25;
          f = Math.max(f, this.pulseAmp[j] * k * k);
        }
      }
      this.strikeAge += dt;
      if (this.strikeAge > 0.8) this.strikeAge = -1;
    }
    this.flash = f;
    if (this.bolt && this.boltMat) {
      this.bolt.visible = f > 0.02;
      this.boltMat.color.setRGB(3 * f, 3.3 * f, 4.4 * f); // > 1 讓 bloom 發光
    }
  }

  private strike(cam: THREE.Vector3, fx: number, fz: number): void {
    this.strikeAge = 0;
    this.strikeIn = 8 + R() * 12;
    this.pulseAt[0] = 0;
    this.pulseAmp[0] = 1;
    this.pulseAt[1] = 0.08 + R() * 0.08;
    this.pulseAmp[1] = R() < 0.6 ? 0.6 + R() * 0.35 : 0;
    this.pulseAt[2] = 0.24 + R() * 0.12;
    this.pulseAmp[2] = R() < 0.3 ? 0.35 + R() * 0.3 : 0;
    this.buildBolt(cam, fx, fz);
  }

  /** 在相機前方 300~600 m 產生一道鋸齒閃電（含兩條分岔） */
  private buildBolt(cam: THREE.Vector3, fx: number, fz: number): void {
    if (!this.bolt) return;
    const o = (R() - 0.5) * 2.2, d = 300 + R() * 300;
    const dx = fx * Math.cos(o) - fz * Math.sin(o), dz = fx * Math.sin(o) + fz * Math.cos(o);
    let x = cam.x + dx * d, z = cam.z + dz * d;
    const top = cam.y + 150 + R() * 90, bot = cam.y - 20;
    const M = this.mainPts, N = 20;
    for (let j = 0; j <= N; j++) {
      M[j * 3] = x;
      M[j * 3 + 1] = top + ((bot - top) * j) / N + (j > 0 && j < N ? (R() - 0.5) * 6 : 0);
      M[j * 3 + 2] = z;
      x += (R() - 0.5) * 18;
      z += (R() - 0.5) * 18;
    }
    this.boltSeg = 0;
    this.strip(M, N + 1, 2.6, 1.2, cam);
    const B = this.branchPts;
    for (let b = 0; b < 2; b++) {
      const s = 3 + Math.floor(R() * 9);
      let bx = M[s * 3], by = M[s * 3 + 1], bz = M[s * 3 + 2];
      const ba = R() * TAU, ox = Math.cos(ba), oz = Math.sin(ba);
      for (let j = 0; j < 8; j++) {
        B[j * 3] = bx;
        B[j * 3 + 1] = by;
        B[j * 3 + 2] = bz;
        bx += ox * 9 + (R() - 0.5) * 10;
        bz += oz * 9 + (R() - 0.5) * 10;
        by -= 7 + R() * 7;
      }
      this.strip(B, 8, 1.2, 0.3, cam);
    }
    const geo = this.bolt.geometry;
    geo.setDrawRange(0, this.boltSeg * 6);
    geo.attributes.position.needsUpdate = true;
  }

  /** 折線轉成面向相機的四邊形帶，寬度由 w0 漸變到 w1 */
  private strip(P: Float32Array, n: number, w0: number, w1: number, cam: THREE.Vector3): void {
    const out = this.boltPos;
    for (let j = 0; j < n - 1 && this.boltSeg < BOLT_SEG; j++) {
      const ax = P[j * 3], ay = P[j * 3 + 1], az = P[j * 3 + 2];
      const bx = P[j * 3 + 3], by = P[j * 3 + 4], bz = P[j * 3 + 5];
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const cx = cam.x - ax, cy = cam.y - ay, cz = cam.z - az;
      const sx = dy * cz - dz * cy, sy = dz * cx - dx * cz, sz = dx * cy - dy * cx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const wa = ((w0 + ((w1 - w0) * j) / (n - 1)) * 0.5) / sl;
      const wb = ((w0 + ((w1 - w0) * (j + 1)) / (n - 1)) * 0.5) / sl;
      const o = this.boltSeg * 12;
      out[o] = ax - sx * wa; out[o + 1] = ay - sy * wa; out[o + 2] = az - sz * wa;
      out[o + 3] = ax + sx * wa; out[o + 4] = ay + sy * wa; out[o + 5] = az + sz * wa;
      out[o + 6] = bx + sx * wb; out[o + 7] = by + sy * wb; out[o + 8] = bz + sz * wb;
      out[o + 9] = bx - sx * wb; out[o + 10] = by - sy * wb; out[o + 11] = bz - sz * wb;
      this.boltSeg++;
    }
  }

  // ---------- 沙 ----------
  private updateSand(dt: number, cam: THREE.Vector3, fx: number, fz: number, wx: number, wz: number, g: number): void {
    const wi = this.wisps;
    if (wi) {
      const W = 80, ws = 12 * (1 + 0.6 * g) * 0.55;
      const D = this.wispData, n = D.length / 4, p = wi.p, q = wi.q;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        let x = p[o] + wx * ws * dt, z = p[o + 2] + wz * ws * dt;
        let wrapped = !this.primed;
        if (wrapped) { x += cam.x; z += cam.z; }
        let rx = x - cam.x, rz = z - cam.z;
        if (rx > W || rx < -W) { rx = wrapM(rx + W, 2 * W) - W; x = cam.x + rx; wrapped = true; }
        if (rz > W || rz < -W) { rz = wrapM(rz + W, 2 * W) - W; z = cam.z + rz; wrapped = true; }
        if (wrapped) D[o] = this.ground(x, z, this.groundSm);
        p[o] = x;
        p[o + 1] = D[o] + D[o + 1];
        p[o + 2] = z;
        const dist = Math.hypot(rx, p[o + 1] - cam.y, rz);
        const edge = Math.max(Math.abs(rx), Math.abs(rz)) / W;
        q[i * 2] = D[o + 2] * (1 + 0.5 * g) * (1 - sstep(0.65, 1, edge)) * sstep(2, 10, dist);
        q[i * 2 + 1] += D[o + 3] * dt;
      }
      // 輪流重新取樣地面高度
      for (let k = 0; k < 3; k++) {
        const o = this.rr * 4;
        D[o] = this.ground(p[o], p[o + 2], D[o]);
        this.rr = (this.rr + 1) % n;
      }
      wi.flush();
    }

    const dv = this.devil;
    if (!dv) return;
    if (this.devilAge < 0) {
      this.devilIn -= dt;
      if (this.devilIn <= 0) {
        // 偏離正前方 7°~40°，避免正好落在賽道上又容易被看到
        const o = (R() < 0.5 ? -1 : 1) * (0.12 + R() * 0.58), d = 50 + R() * 100;
        const dx = fx * Math.cos(o) - fz * Math.sin(o), dz = fx * Math.sin(o) + fz * Math.cos(o);
        this.devilX = cam.x + dx * d;
        this.devilZ = cam.z + dz * d;
        this.devilY = this.ground(this.devilX, this.devilZ, this.groundSm);
        this.devilH = 15 + R() * 10;
        const side = (R() - 0.5) * 3;
        this.devilVX = wx * 2.5 - wz * side;
        this.devilVZ = wz * 2.5 + wx * side;
        this.devilAge = 0;
        this.devilGT = 0.4;
        this.devilIn = 10 + R() * 15;
        dv.mesh.visible = true;
      }
    }
    if (this.devilAge >= 0) {
      this.devilAge += dt;
      if (this.devilAge > 8) {
        this.devilAge = -1;
        dv.mesh.visible = false;
      } else {
        this.updateDevil(dv, dt);
      }
    }
  }

  /** 塵捲風：螺旋上升的煙團柱 + 底部裙擺 */
  private updateDevil(dv: Sprites, dt: number): void {
    const t = this.t, age = this.devilAge;
    this.devilX += this.devilVX * dt;
    this.devilZ += this.devilVZ * dt;
    this.devilGT -= dt;
    if (this.devilGT <= 0) {
      this.devilGT = 0.4;
      this.devilY = this.ground(this.devilX, this.devilZ, this.devilY);
    }
    const env = sstep(0, 1.2, age) * (1 - sstep(5.5, 8, age)) * (this.opts.mobile ? 1.5 : 1);
    const D = this.devilData, n = D.length / 4, H = this.devilH;
    for (let i = 0; i < n; i++) {
      const o = i * 4, skirt = D[o + 3] > 0.5;
      const h = skirt ? D[o] * 0.12 : (D[o] + t * 0.14) % 1;
      const a = D[o + 1] + t * (3.2 - 1.4 * h) + h * 5;
      const r = skirt ? 1.6 + 2.6 * D[o + 2] : (1.1 + 1.6 * h * h) * D[o + 2];
      const wob = 1.2 * h;
      dv.p[o] = this.devilX + Math.cos(a) * r + Math.sin(t * 1.1 + h * 3.5) * wob;
      dv.p[o + 1] = this.devilY + 0.3 + h * H;
      dv.p[o + 2] = this.devilZ + Math.sin(a) * r + Math.cos(t * 0.9 + h * 3) * wob;
      dv.p[o + 3] = skirt ? 3 + D[o + 2] * 2 : 1.6 + 2.2 * h;
      const fade = sstep(0, 0.06, h) * (1 - sstep(0.8, 1, h));
      dv.q[i * 2] = env * (skirt ? 0.13 : 0.2 * (1 - 0.6 * h) * fade);
      dv.q[i * 2 + 1] = a;
    }
    dv.flush();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes.length = 0;
  }
}
