import * as THREE from 'three';

/**
 * 護盾碎片：護盾被打破時，整片弧形能量牆裂成一塊塊三角形碎片往外噴、旋轉、落下、縮小消失。
 * 用一個 InstancedMesh 當碎片池（一次畫完），碎片停在世界座標，不跟著車走。
 */
interface Shard { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; wx: number; wy: number; wz: number; s: number; life: number; max: number }

export class Shards {
  readonly mesh: THREE.InstancedMesh;
  private list: Shard[] = [];
  private cap: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();

  constructor(cap = 160) {
    this.cap = cap;
    // 一片碎片：不規則的三角形（雙面）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.32, -0.22, 0, 0.36, -0.12, 0, -0.04, 0.34, 0], 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.5, 2.4), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  /**
   * 在車尾的弧上噴出碎片：(x, y, z) 車的位置、heading 車頭方向、half 護盾半角、
   * (vx, vz) 車速（碎片先帶著一部分車速，再往外飛）
   */
  burst(x: number, y: number, z: number, heading: number, half: number, vx: number, vz: number, n = 36): void {
    const R = Math.random;
    for (let i = 0; i < n; i++) {
      if (this.list.length >= this.cap) this.list.shift();
      // 弧上的角度（車尾 = heading + π），高度在護盾範圍內
      const a = heading + Math.PI + (R() * 2 - 1) * half;
      const ox = Math.sin(a), oz = Math.cos(a);
      const r = 2.0 + R() * 0.2;
      const out = 4 + R() * 7;
      const life = 0.6 + R() * 0.6;
      this.list.push({
        x: x + ox * r, y: y + 0.15 + R() * 1.8, z: z + oz * r,
        vx: vx * 0.6 + ox * out + (R() - 0.5) * 2, vy: 2 + R() * 6, vz: vz * 0.6 + oz * out + (R() - 0.5) * 2,
        rx: R() * 6, ry: R() * 6, rz: R() * 6, wx: (R() - 0.5) * 18, wy: (R() - 0.5) * 18, wz: (R() - 0.5) * 18,
        s: 0.6 + R() * 0.9, life, max: life,
      });
    }
  }

  update(dt: number): void {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const s = L[i];
      s.life -= dt;
      if (s.life <= 0) { L.splice(i, 1); continue; }
      s.vy -= 14 * dt;
      s.vx *= 1 - 1.2 * dt;
      s.vz *= 1 - 1.2 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rx += s.wx * dt;
      s.ry += s.wy * dt;
      s.rz += s.wz * dt;
    }
    const n = Math.min(L.length, this.cap);
    for (let i = 0; i < n; i++) {
      const s = L[i];
      // 最後一段時間縮小消失
      const k = s.s * Math.min(1, (s.life / s.max) * 2.2);
      this.p.set(s.x, s.y, s.z);
      this.q.setFromEuler(this.e.set(s.rx, s.ry, s.rz));
      this.sc.set(k, k, k);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.list.length = 0;
    this.mesh.count = 0;
  }
}
