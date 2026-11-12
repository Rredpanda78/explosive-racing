import * as THREE from 'three';
import type { Track } from '../game/track';
import { mulberry32 } from '../game/util';

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

/** 沿賽道拉出一條水平帶狀網格，latL / latR 為左右邊相對中心線的偏移 */
function ribbon(track: Track, latL: number, latR: number, y: number, vScale: number): THREE.BufferGeometry {
  const n = track.n;
  const pos = new Float32Array((n + 1) * 6);
  const uv = new Float32Array((n + 1) * 4);
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = track.samples[i % n];
    const d = i === n ? track.length : s.dist;
    pos.set([s.x + s.nx * latL, y, s.z + s.nz * latL, s.x + s.nx * latR, y, s.z + s.nz * latR], i * 6);
    uv.set([0, d / vScale, 1, d / vScale], i * 4);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 沿賽道拉出一道垂直的牆 */
function wall(track: Track, lat: number, h: number, uScale: number): THREE.BufferGeometry {
  const n = track.n;
  const pos = new Float32Array((n + 1) * 6);
  const uv = new Float32Array((n + 1) * 4);
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = track.samples[i % n];
    const d = i === n ? track.length : s.dist;
    const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
    pos.set([x, 0, z, x, h, z], i * 6);
    uv.set([d / uScale, 0, d / uScale, 1], i * 4);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export const SKY_COLOR = 0x8fd3ff;

/** 建立賽道、護欄、起跑線與周邊景物 */
export function buildWorld(track: Track): THREE.Group {
  const root = new THREE.Group();
  const hw = track.halfWidth;

  // 草地
  const grassTex = canvasTex(128, 128, (c) => {
    c.fillStyle = '#69b84a';
    c.fillRect(0, 0, 128, 128);
    const r = mulberry32(7);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = r() > 0.5 ? 'rgba(120,200,90,0.5)' : 'rgba(70,150,60,0.5)';
      c.fillRect(r() * 128, r() * 128, 2 + r() * 3, 2 + r() * 3);
    }
  });
  grassTex.repeat.set(260, 260);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: grassTex }));
  ground.position.set(140, 0, 0);
  root.add(ground);

  // 路面（含紅白路緣與中線）
  const roadTex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#3d414b';
    c.fillRect(0, 0, 256, 256);
    const r = mulberry32(3);
    for (let i = 0; i < 2600; i++) {
      const v = 50 + r() * 40;
      c.fillStyle = `rgba(${v},${v},${v + 8},0.35)`;
      c.fillRect(r() * 256, r() * 256, 2, 2);
    }
    for (const x of [0, 240]) {
      c.fillStyle = '#f2f2f2';
      c.fillRect(x, 0, 16, 128);
      c.fillStyle = '#e63946';
      c.fillRect(x, 128, 16, 128);
    }
    c.fillStyle = '#f5f5f5';
    c.fillRect(18, 0, 3, 256);
    c.fillRect(235, 0, 3, 256);
    c.fillStyle = '#ffd23f';
    c.fillRect(126, 0, 4, 140);
  });
  const road = new THREE.Mesh(ribbon(track, hw, -hw, 0.02, 9), new THREE.MeshLambertMaterial({ map: roadTex }));
  root.add(road);

  // 護欄：彩色積木風
  const wallTex = canvasTex(256, 64, (c) => {
    const cols = ['#ff5d8f', '#ffd23f', '#3bceac', '#4d9de0'];
    cols.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(i * 64, 0, 64, 64);
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(i * 64, 44, 64, 20);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillRect(i * 64 + 4, 6, 56, 8);
    });
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 256, 5);
  });
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex, side: THREE.DoubleSide });
  root.add(new THREE.Mesh(wall(track, hw + 0.35, 1.5, 12), wallMat));
  root.add(new THREE.Mesh(wall(track, -(hw + 0.35), 1.5, 12), wallMat));
  const capMat = new THREE.MeshLambertMaterial({ color: 0xf1f1f1 });
  root.add(new THREE.Mesh(ribbon(track, hw + 0.9, hw + 0.35, 1.5, 10), capMat));
  root.add(new THREE.Mesh(ribbon(track, -(hw + 0.35), -(hw + 0.9), 1.5, 10), capMat));

  // 起跑線與拱門
  const s0 = track.samples[0];
  const yaw = Math.atan2(s0.tx, s0.tz);
  const checker = canvasTex(256, 32, (c) => {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      c.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      c.fillRect(i * 16, j * 16, 16, 16);
    }
  }, false);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 3).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: checker }));
  line.position.set(s0.x, 0.035, s0.z);
  line.rotation.y = yaw;
  root.add(line);

  const arch = new THREE.Group();
  arch.position.set(s0.x, 0, s0.z);
  arch.rotation.y = yaw;
  const postMat = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
  for (const side of [1, -1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 9, 1.2), postMat);
    p.position.set(side * (hw + 1.4), 4.5, 0);
    arch.add(p);
  }
  const banner = canvasTex(1024, 128, (c) => {
    c.fillStyle = '#1b1e27';
    c.fillRect(0, 0, 1024, 128);
    c.fillStyle = '#ffd23f';
    c.fillRect(0, 0, 1024, 10);
    c.fillRect(0, 118, 1024, 10);
    c.font = 'italic 900 78px "Segoe UI", Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ff7a1a';
    c.fillText('EXPLOSIVE RACING', 516, 68);
    c.fillStyle = '#fff';
    c.fillText('EXPLOSIVE RACING', 512, 64);
  }, false);
  const beamMats = [postMat, postMat, postMat, postMat, new THREE.MeshLambertMaterial({ map: banner }), new THREE.MeshLambertMaterial({ map: banner })];
  const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 4, 3, 0.8), beamMats);
  beam.position.y = 8.5;
  arch.add(beam);
  root.add(arch);

  // 景物：樹、彩色積木塔、遠山
  const rng = mulberry32(42);
  const S = track.samples;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of S) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
  }
  const clear = (x: number, z: number, margin: number): boolean => {
    const m2 = (hw + margin) * (hw + margin);
    for (let i = 0; i < S.length; i += 3) {
      const dx = x - S[i].x, dz = z - S[i].z;
      if (dx * dx + dz * dz < m2) return false;
    }
    return true;
  };
  const spots: [number, number, number][] = [];
  for (let tries = 0; tries < 4000 && spots.length < 340; tries++) {
    const x = minX - 110 + rng() * (maxX - minX + 220);
    const z = minZ - 110 + rng() * (maxZ - minZ + 220);
    if (clear(x, z, 6)) spots.push([x, z, 0.7 + rng() * 0.9]);
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const nTree = Math.floor(spots.length * 0.85);
  const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 6.5, 7).translate(0, 5.2, 0), new THREE.MeshLambertMaterial({ color: 0x2f9e58 }), nTree);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshLambertMaterial({ color: 0x8a5a3c }), nTree);
  const tint = new THREE.Color();
  for (let i = 0; i < nTree; i++) {
    const [x, z, s] = spots[i];
    m4.compose(v.set(x, 0, z), q.identity(), sc.set(s, s, s));
    leaves.setMatrixAt(i, m4);
    trunks.setMatrixAt(i, m4);
    leaves.setColorAt(i, tint.setHSL(0.33 + rng() * 0.08, 0.55, 0.36 + rng() * 0.12));
  }
  root.add(leaves, trunks);
  const blockCols = [0xff5d8f, 0xffd23f, 0x3bceac, 0x4d9de0, 0xff7a1a, 0xb05cff];
  for (let i = nTree; i < spots.length; i++) {
    const [x, z, s] = spots[i];
    if (!clear(x, z, 12)) continue;
    const w = 5 + s * 4, h = 8 + rng() * 22;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), new THREE.MeshLambertMaterial({ color: blockCols[i % blockCols.length] }));
    b.position.set(x, h / 2, z);
    b.rotation.y = rng() * Math.PI;
    root.add(b);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const mMat = new THREE.MeshLambertMaterial({ color: 0x7fa6c9, flatShading: true });
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rng() * 0.2;
    const r = 560 + rng() * 200;
    const h = 90 + rng() * 130;
    const m = new THREE.Mesh(new THREE.ConeGeometry(120 + rng() * 90, h, 6), mMat);
    m.position.set(cx + Math.cos(a) * r, h / 2 - 4, cz + Math.sin(a) * r);
    m.rotation.y = rng() * 3;
    root.add(m);
  }
  return root;
}
