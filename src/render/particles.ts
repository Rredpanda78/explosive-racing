import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.15, r);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

/** 以單一 Points 繪製的粒子池（煙、火花、火焰） */
export class Particles {
  points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private ground: Float32Array;
  private cursor = 0;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.ground = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 11 : 10;
  }

  setScale(v: number): void {
    this.mat.uniforms.uScale.value = v;
  }

  spawn(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, r: number, g: number, b: number, a: number,
    grav = 0, drag = 0, ground = -1e9,
  ): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a;
    this.grav[i] = grav; this.drag[i] = drag; this.ground[i] = ground;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.size[i] = s0;
  }

  update(dt: number): void {
    const { pos, vel, life, maxLife, size, col } = this;
    for (let i = 0; i < this.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        size[i] = 0;
        col[i * 4 + 3] = 0;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      vel[i * 3] *= d; vel[i * 3 + 2] *= d;
      vel[i * 3 + 1] = vel[i * 3 + 1] * d - this.grav[i] * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const gy = this.ground[i] + 0.05;
      if (pos[i * 3 + 1] < gy) { pos[i * 3 + 1] = gy; vel[i * 3 + 1] *= -0.3; }
      const t = 1 - life[i] / maxLife[i];
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      col[i * 4 + 3] = this.a0[i] * (1 - t * t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
    this.col.fill(0);
  }
}
