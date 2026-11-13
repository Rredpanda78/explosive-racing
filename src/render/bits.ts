import * as THREE from 'three';

/**
 * 會彈跳的小碎片（金屬碎屑、彈殼）：固定數量循環使用，全部一次繪製（InstancedMesh）。
 * 只有簡單的重力與地面反彈，地面高度在生成時給定。
 */
export class Bits {
  mesh: THREE.InstancedMesh;
  private max: number;
  private cursor = 0;
  /** 每個碎片：位置 3、速度 3、旋轉 3、角速度 3、剩餘壽命、總壽命、地面高度、大小 */
  private d: Float32Array;
  private alive = 0;
  private o = new THREE.Object3D();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private col = new THREE.Color();

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, max: number, colors: boolean, shadows = false) {
    this.max = max;
    this.d = new Float32Array(max * 16);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    if (colors) this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.clear();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, ground: number, scale: number, color?: THREE.Color): void {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    const d = this.d, j = i * 16;
    const R = Math.random;
    if (d[j + 12] <= 0) this.alive++;
    d[j] = x; d[j + 1] = y; d[j + 2] = z;
    d[j + 3] = vx; d[j + 4] = vy; d[j + 5] = vz;
    d[j + 6] = R() * 6; d[j + 7] = R() * 6; d[j + 8] = R() * 6;
    d[j + 9] = (R() - 0.5) * 30; d[j + 10] = (R() - 0.5) * 30; d[j + 11] = (R() - 0.5) * 30;
    d[j + 12] = life; d[j + 13] = life; d[j + 14] = ground; d[j + 15] = scale;
    if (color && this.mesh.instanceColor) {
      this.mesh.setColorAt(i, this.col.copy(color));
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt: number): void {
    if (this.alive <= 0) return;
    const d = this.d, o = this.o;
    for (let i = 0; i < this.max; i++) {
      const j = i * 16;
      if (d[j + 12] <= 0) continue;
      d[j + 12] -= dt;
      if (d[j + 12] <= 0) {
        this.alive--;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      d[j + 4] -= 22 * dt;
      d[j] += d[j + 3] * dt; d[j + 1] += d[j + 4] * dt; d[j + 2] += d[j + 5] * dt;
      if (d[j + 1] < d[j + 14]) {
        // 落地：往上彈一點、水平速度與旋轉減慢
        d[j + 1] = d[j + 14];
        if (d[j + 4] < 0) d[j + 4] *= -0.32;
        d[j + 3] *= 0.55; d[j + 5] *= 0.55;
        d[j + 9] *= 0.5; d[j + 10] *= 0.5; d[j + 11] *= 0.5;
      }
      d[j + 6] += d[j + 9] * dt; d[j + 7] += d[j + 10] * dt; d[j + 8] += d[j + 11] * dt;
      const fade = Math.min(1, d[j + 12] / 0.25);
      o.position.set(d[j], d[j + 1], d[j + 2]);
      o.rotation.set(d[j + 6], d[j + 7], d[j + 8]);
      o.scale.setScalar(d[j + 15] * fade);
      o.updateMatrix();
      this.mesh.setMatrixAt(i, o.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.max; i++) {
      this.d[i * 16 + 12] = 0;
      this.mesh.setMatrixAt(i, this.zero);
    }
    this.alive = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
