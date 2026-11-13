import * as THREE from 'three';
import type { PrimaryId, SecondaryId } from '../game/weapons';

/**
 * 武器模型（程式產生）。每個模型的原點在安裝座底部中心，槍管朝 +Z。
 * 車上與車庫圖示共用同一套模型。
 */

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, rx = 1, ry = 1): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

const lambert = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const glow = (r: number, g: number, b: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });

// 共用材質（永遠不釋放）
const M = {
  steel: lambert(0x9aa3b0),
  steelDark: lambert(0x4b515c),
  black: lambert(0x23262d),
  gun: lambert(0x343842),
  olive: lambert(0x5d6b3a),
  brass: lambert(0xd8a640),
  red: lambert(0xd7263d),
  white: lambert(0xeef0f3),
  green: lambert(0x56703f),
  hazard: lambert(0xffffff, {
    map: canvasTex(64, 16, (c) => {
      c.fillStyle = '#ffc93c';
      c.fillRect(0, 0, 64, 16);
      c.fillStyle = '#17181c';
      for (let x = -16; x < 80; x += 16) {
        c.beginPath();
        c.moveTo(x, 16); c.lineTo(x + 8, 16); c.lineTo(x + 16, 0); c.lineTo(x + 8, 0);
        c.closePath();
        c.fill();
      }
    }, 2, 1),
  }),
  // 散熱套筒上的圓孔
  holes: lambert(0xffffff, {
    map: canvasTex(64, 64, (c) => {
      c.fillStyle = '#a9b1bd';
      c.fillRect(0, 0, 64, 64);
      c.fillStyle = '#1a1c21';
      for (const [x, y] of [[16, 16], [48, 16], [0, 48], [32, 48], [64, 48]]) {
        c.beginPath();
        c.arc(x, y, 8, 0, Math.PI * 2);
        c.fill();
      }
    }, 6, 5),
  }),
  // 紅白條紋的集束圓雷
  striped: lambert(0xffffff, {
    map: canvasTex(32, 64, (c) => {
      c.fillStyle = '#f2f2f2';
      c.fillRect(0, 0, 32, 64);
      c.fillStyle = '#d7263d';
      c.fillRect(0, 0, 32, 22);
      c.fillRect(0, 42, 32, 22);
    }),
  }),
  lens: glow(2.4, 0.25, 0.3),
  slit: glow(2.2, 0.3, 0.45),
  pilot: glow(0.5, 0.9, 2.4),
  mineLight: glow(2.2, 0.15, 0.1),
  // 電弧槍：銅線圈、白色陶瓷絕緣管、電藍色的放電球
  copper: lambert(0xc8743a, { emissive: 0x2a1004 }),
  ceramic: lambert(0xe9e4d8),
  arcGlow: glow(0.75, 1.35, 2.8),
  // 冷凍光束：白色冷卻罐、冰藍色鰭片與發光鏡頭
  cryo: lambert(0xdde8f0),
  ice: lambert(0x8fd3ff, { emissive: 0x0c2a40 }),
  iceGlow: glow(0.55, 1.6, 2.6),
  // 音波炮：深紫色擴音箱、發光的音圈
  violet: lambert(0x4a3a7a),
  hornIn: lambert(0x1c1924, { side: THREE.BackSide }),
  sonicGlow: glow(1.9, 0.55, 2.4),
  // 魚叉鉤：麻繩、紅色氣瓶
  rope: lambert(0xffa31a, { emissive: 0x3a1c00 }),
  // 散熱套筒上的圓孔
  grille: lambert(0xffffff, {
    map: canvasTex(64, 64, (c) => {
      c.fillStyle = '#2a2433';
      c.fillRect(0, 0, 64, 64);
      c.fillStyle = '#0d0b10';
      for (let y = 4; y < 64; y += 8) for (let x = 4 + ((y / 8) % 2) * 4; x < 64; x += 8) { c.beginPath(); c.arc(x, y, 2.6, 0, Math.PI * 2); c.fill(); }
    }, 1, 1),
  }),
};

const SHARED = new Set<THREE.Material>(Object.values(M));
/** 武器模型裡的材質都是共用的，車輛釋放時不能一起釋放 */
export const isSharedWeaponMaterial = (m: THREE.Material) => SHARED.has(m);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}
const box = (w: number, h: number, l: number, mat: THREE.Material, x = 0, y = 0, z = 0) => mesh(new THREE.BoxGeometry(w, h, l), mat, x, y, z);
/** 沿 Z 軸的圓柱 */
const tube = (r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0, seg = 10, r2 = r) =>
  mesh(new THREE.CylinderGeometry(r, r2, len, seg).rotateX(Math.PI / 2), mat, x, y, z);

/** 安裝座：底板加短柱 */
function mount(g: THREE.Group, h: number): void {
  g.add(box(0.2, 0.04, 0.26, M.steelDark, 0, 0.02, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.045, 0.06, h, 8), M.steel, 0, h / 2 + 0.02, 0));
}

export interface PrimaryParts {
  group: THREE.Group;
  /** 槍口位置（模型座標） */
  muzzle: THREE.Vector3;
  /** 會繞 Z 軸旋轉的部分（六管機槍的槍管組） */
  spinners: THREE.Object3D[];
  /** 裝填在槍上的彈藥（魚叉鉤的魚叉：射出去之後藏起來） */
  ammo?: THREE.Object3D;
  /** 開火時會往前一震的部分（音波炮的喇叭） */
  kick?: THREE.Object3D;
  /** 繞 X 軸轉的捲線輪（魚叉鉤收線時轉） */
  reel?: THREE.Object3D;
}

/** 魚叉：細長的桿子、尖頭與兩片倒鉤，原點在桿尾，朝 +Z（槍上裝填的與飛出去的共用） */
export function buildHarpoonSpear(): THREE.Group {
  const g = new THREE.Group();
  g.add(tube(0.022, 0.9, M.steel, 0, 0, 0.45, 6));
  g.add(tube(0.035, 0.08, M.red, 0, 0, 0.06, 8));
  g.add(mesh(new THREE.ConeGeometry(0.06, 0.22, 8).rotateX(Math.PI / 2), M.steelDark, 0, 0, 1.0));
  for (const s of [1, -1]) {
    const barb = box(0.016, 0.1, 0.03, M.steelDark, 0, s * 0.055, 0.86);
    barb.rotation.x = s * 0.6;
    g.add(barb);
  }
  return g;
}

/** 主武器。side = 1 裝在左側、-1 裝在右側（彈藥箱之類的配件放在外側） */
export function buildPrimary(id: PrimaryId, side = 1): PrimaryParts {
  const g = new THREE.Group();
  const spinners: THREE.Object3D[] = [];
  const Y = 0.2;
  let muzzleZ = 1.1;
  let ammo: THREE.Object3D | undefined;
  let kick: THREE.Object3D | undefined;
  let reelObj: THREE.Object3D | undefined;
  mount(g, 0.12);
  if (id === 'mg') {
    // .50 機槍：方形機匣、打孔散熱套筒、外側彈藥箱與彈鏈、後方握把
    g.add(box(0.2, 0.22, 0.52, M.gun, 0, Y, -0.04));
    g.add(box(0.21, 0.04, 0.4, M.steelDark, 0, Y + 0.13, 0));
    g.add(tube(0.07, 0.72, M.holes, 0, Y, 0.57, 14));
    g.add(tube(0.08, 0.06, M.steelDark, 0, Y, 0.22));
    g.add(tube(0.032, 0.24, M.black, 0, Y, 1.02, 8));
    g.add(tube(0.045, 0.1, M.steelDark, 0, Y, 1.12, 8, 0.055));
    for (const x of [-0.06, 0.06]) {
      const grip = tube(0.022, 0.16, M.black, x, Y - 0.02, -0.36, 6);
      grip.rotation.x = 0.5;
      g.add(grip);
    }
    const ax = side * 0.2;
    g.add(box(0.13, 0.17, 0.26, M.olive, ax, Y - 0.04, -0.06));
    g.add(box(0.135, 0.03, 0.27, M.steelDark, ax, Y + 0.05, -0.06));
    for (let i = 0; i < 4; i++) g.add(box(0.03, 0.035, 0.05, M.brass, ax - side * (0.04 + i * 0.025), Y + 0.06 - i * 0.005, -0.03 + i * 0.012));
    muzzleZ = 1.18;
  } else if (id === 'vulcan') {
    // 六管機槍：後方馬達箱、六根旋轉槍管、三道束環、側面彈鏈導管
    g.add(box(0.24, 0.24, 0.34, M.gun, 0, Y, -0.16));
    g.add(tube(0.12, 0.08, M.steelDark, 0, Y, -0.36, 12));
    g.add(tube(0.07, 0.06, M.black, 0, Y, -0.42, 10));
    const spin = new THREE.Group();
    spin.position.set(0, Y, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      spin.add(tube(0.03, 1.15, M.steel, Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0.6, 7));
    }
    for (const z of [0.12, 0.55, 1.0]) spin.add(tube(0.118, 0.045, M.black, 0, 0, z, 12));
    spin.add(tube(0.03, 1.15, M.black, 0, 0, 0.6, 6));
    g.add(spin);
    spinners.push(spin);
    const chute = mesh(new THREE.TorusGeometry(0.14, 0.035, 6, 10, Math.PI * 0.9), M.steelDark, side * 0.12, Y - 0.04, -0.12);
    chute.rotation.y = Math.PI / 2;
    g.add(chute);
    muzzleZ = 1.2;
  } else if (id === 'flame') {
    // 火焰發射器：後方兩個紅色燃料罐、軟管、鰭片槍管、噴嘴下方的藍色引火燈
    for (const [dy, dx] of [[0.06, 0], [-0.06, side * 0.02]] as [number, number][]) {
      g.add(tube(0.075, 0.42, M.red, dx, Y + dy + 0.02, -0.22, 12));
      g.add(tube(0.078, 0.03, M.steel, dx, Y + dy + 0.02, -0.12, 12));
      g.add(tube(0.078, 0.03, M.steel, dx, Y + dy + 0.02, -0.32, 12));
      g.add(mesh(new THREE.SphereGeometry(0.075, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), M.red, dx, Y + dy + 0.02, -0.43));
    }
    const hose = mesh(new THREE.TorusGeometry(0.12, 0.025, 6, 10, Math.PI), M.black, side * 0.1, Y, -0.02);
    hose.rotation.y = Math.PI / 2;
    g.add(hose);
    g.add(tube(0.05, 0.72, M.steelDark, 0, Y, 0.4, 10));
    for (let i = 0; i < 7; i++) g.add(tube(0.085, 0.022, M.gun, 0, Y, 0.12 + i * 0.075, 12));
    g.add(tube(0.06, 0.14, M.steel, 0, Y, 0.82, 10, 0.045));
    g.add(tube(0.012, 0.18, M.steel, 0, Y - 0.08, 0.76, 6));
    g.add(mesh(new THREE.SphereGeometry(0.025, 6, 4), M.pilot, 0, Y - 0.08, 0.86));
    muzzleZ = 0.9;
  } else if (id === 'arc') {
    // 電弧槍：後方高壓電箱（外側一條發光的電池槽）、白色陶瓷絕緣管上繞著一圈圈銅線圈、前端兩根電極夾著一顆放電球
    g.add(box(0.22, 0.2, 0.34, M.gun, 0, Y, -0.16));
    g.add(box(0.06, 0.14, 0.28, M.steelDark, side * 0.13, Y - 0.01, -0.16));
    g.add(box(0.01, 0.1, 0.22, M.arcGlow, side * 0.162, Y - 0.01, -0.16));
    for (const dz of [-0.28, -0.08]) g.add(tube(0.03, 0.05, M.ceramic, 0, Y + 0.13, dz, 8));
    g.add(tube(0.045, 0.74, M.ceramic, 0, Y, 0.38, 10));
    for (let i = 0; i < 7; i++) {
      const ring = mesh(new THREE.TorusGeometry(0.075, 0.022, 6, 14), M.copper, 0, Y, 0.1 + i * 0.085);
      g.add(ring);
    }
    g.add(tube(0.09, 0.05, M.steelDark, 0, Y, 0.72, 12));
    for (const s of [1, -1]) {
      const prong = box(0.028, 0.028, 0.26, M.copper, s * 0.06, Y, 0.86);
      prong.rotation.y = -s * 0.22;
      g.add(prong);
    }
    g.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), M.arcGlow, 0, Y, 0.97));
    muzzleZ = 0.99;
  } else if (id === 'freeze') {
    // 冷凍光束：後方兩罐白色冷卻劑（冰藍色束帶）、六角槍管上一片片冰藍散熱鰭片、前端發光的冰藍鏡頭
    for (const [dy, dx] of [[0.065, 0], [-0.065, side * 0.02]] as [number, number][]) {
      g.add(tube(0.07, 0.4, M.cryo, dx, Y + dy + 0.02, -0.2, 12));
      for (const z of [-0.1, -0.3]) g.add(tube(0.073, 0.035, M.ice, dx, Y + dy + 0.02, z, 12));
      g.add(mesh(new THREE.SphereGeometry(0.07, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), M.cryo, dx, Y + dy + 0.02, -0.4));
    }
    g.add(tube(0.02, 0.2, M.ice, side * 0.09, Y + 0.08, 0.02, 6));
    g.add(tube(0.065, 0.78, M.steelDark, 0, Y, 0.44, 6));
    for (let i = 0; i < 6; i++) g.add(tube(0.1, 0.018, M.ice, 0, Y, 0.16 + i * 0.09, 6));
    g.add(tube(0.085, 0.08, M.steel, 0, Y, 0.86, 12, 0.07));
    g.add(tube(0.055, 0.02, M.iceGlow, 0, Y, 0.905, 12));
    muzzleZ = 0.92;
  } else if (id === 'sonic') {
    // 音波炮：後方紫色擴音箱（側面喇叭網）、往前張開的大喇叭口，喉部一圈發光的音圈
    g.add(box(0.26, 0.24, 0.34, M.violet, 0, Y, -0.16));
    g.add(box(0.005, 0.18, 0.26, M.grille, side * 0.133, Y, -0.16));
    g.add(box(0.27, 0.03, 0.35, M.steelDark, 0, Y + 0.13, -0.16));
    g.add(tube(0.07, 0.24, M.steelDark, 0, Y, 0.1, 12));
    const horn = new THREE.Group();
    horn.position.set(0, Y, 0.22);
    // 外殼（往前張開的喇叭）＋內側（深色）
    horn.add(mesh(new THREE.CylinderGeometry(0.24, 0.075, 0.5, 18, 1, true).rotateX(Math.PI / 2), M.steel, 0, 0, 0.25));
    horn.add(mesh(new THREE.CylinderGeometry(0.225, 0.065, 0.49, 18, 1, true).rotateX(Math.PI / 2), M.hornIn, 0, 0, 0.25));
    horn.add(mesh(new THREE.TorusGeometry(0.24, 0.022, 6, 22), M.violet, 0, 0, 0.5));
    horn.add(mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 14), M.sonicGlow, 0, 0, 0.05));
    horn.add(mesh(new THREE.SphereGeometry(0.05, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), M.steelDark, 0, 0, 0.04));
    g.add(horn);
    kick = horn;
    muzzleZ = 0.72;
  } else if (id === 'harpoon') {
    // 魚叉鉤：長長的發射軌、下方紅色氣瓶、外側纏著麻繩的捲線輪，軌道上裝著一支魚叉
    g.add(box(0.16, 0.12, 0.5, M.gun, 0, Y - 0.02, -0.1));
    g.add(box(0.07, 0.05, 0.9, M.steelDark, 0, Y + 0.05, 0.3));
    g.add(tube(0.055, 0.42, M.red, 0, Y - 0.1, 0.12, 12));
    g.add(tube(0.057, 0.03, M.steel, 0, Y - 0.1, 0.32, 12));
    const reel = new THREE.Group();
    reel.position.set(side * 0.17, Y, -0.12);
    reel.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 14).rotateZ(Math.PI / 2), M.rope));
    for (const s of [1, -1]) reel.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 14).rotateZ(Math.PI / 2), M.steelDark, s * 0.055, 0, 0));
    g.add(reel);
    reelObj = reel;
    // 前端導環
    g.add(mesh(new THREE.TorusGeometry(0.05, 0.015, 6, 12), M.steel, 0, Y + 0.09, 0.72));
    const spear = buildHarpoonSpear();
    spear.position.set(0, Y + 0.09, -0.05);
    g.add(spear);
    ammo = spear;
    muzzleZ = 0.95;
  } else {
    // 雷射砲：後方電源箱與三根電容、長方形槍管（側面有發光導槽）、前端發光鏡頭
    g.add(box(0.24, 0.22, 0.32, M.gun, 0, Y, -0.2));
    for (const dz of [-0.3, -0.2, -0.1]) {
      g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8), M.steel, side * 0.05, Y + 0.17, dz));
      g.add(mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.02, 8), M.slit, side * 0.05, Y + 0.2, dz));
    }
    g.add(box(0.13, 0.15, 1.0, M.steelDark, 0, Y, 0.48));
    g.add(box(0.135, 0.03, 0.85, M.steel, 0, Y + 0.085, 0.5));
    g.add(box(0.01, 0.03, 0.8, M.slit, side * 0.068, Y, 0.48));
    for (const z of [0.1, 0.25, 0.4]) g.add(box(0.2, 0.02, 0.04, M.steel, 0, Y + 0.075, z));
    g.add(box(0.17, 0.19, 0.08, M.gun, 0, Y, 1.0));
    g.add(tube(0.05, 0.03, M.lens, 0, Y, 1.05, 12));
    muzzleZ = 1.07;
  }
  return { group: g, muzzle: new THREE.Vector3(0, Y, muzzleZ), spinners, ammo, kick, reel: reelObj };
}

/** 地雷本體（六角形，中間紅燈）：車尾投放箱上與賽道上共用造型 */
export function hexMineGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.5, 0.58, 0.2, 6).translate(0, 0.1, 0);
}

/** 副武器。火箭、榴彈、導彈裝在引擎蓋上；地雷與圓雷的投放箱裝在車尾 */
export function buildSecondary(id: SecondaryId): THREE.Group {
  const g = new THREE.Group();
  if (id === 'rocket') {
    // 火箭巢：圓筒外殼，前端蜂巢狀發射孔
    g.add(box(0.12, 0.08, 0.3, M.steelDark, 0, 0.04, 0));
    g.add(box(0.34, 0.04, 0.12, M.steelDark, 0, 0.02, -0.06));
    g.add(tube(0.2, 0.62, M.white, 0, 0.27, 0.02, 16));
    g.add(tube(0.205, 0.05, M.steel, 0, 0.27, 0.3, 16));
    g.add(tube(0.18, 0.04, M.black, 0, 0.27, 0.33, 16));
    g.add(tube(0.16, 0.06, M.steelDark, 0, 0.27, -0.31, 16, 0.12));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = i === 6 ? 0 : 0.11;
      const x = i === 6 ? 0 : Math.cos(a) * r, y = i === 6 ? 0 : Math.sin(a) * r;
      g.add(tube(0.042, 0.04, M.steel, x, 0.27 + y, 0.345, 8));
      g.add(tube(0.03, 0.045, M.black, x, 0.27 + y, 0.35, 8));
    }
    g.add(box(0.06, 0.03, 0.5, M.red, 0, 0.47, 0.02));
  } else if (id === 'grenade') {
    // 轉輪式榴彈發射器：後方彈巢、長槍管
    g.add(box(0.2, 0.06, 0.3, M.steelDark, 0, 0.03, -0.05));
    g.add(box(0.06, 0.12, 0.14, M.steel, 0, 0.12, -0.05));
    const gun = new THREE.Group();
    gun.position.set(0, 0.22, -0.05);
    gun.rotation.x = -0.18;
    const drum = tube(0.13, 0.22, M.steel, 0, 0, -0.12, 12);
    gun.add(drum);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      gun.add(tube(0.035, 0.225, M.black, Math.cos(a) * 0.085, Math.sin(a) * 0.085, -0.12, 8));
    }
    gun.add(tube(0.065, 0.8, M.black, 0, 0, 0.38, 10));
    gun.add(tube(0.08, 0.07, M.steelDark, 0, 0, 0.8, 10));
    gun.add(box(0.1, 0.12, 0.2, M.gun, 0, -0.03, -0.3));
    g.add(gun);
  } else if (id === 'missile') {
    // 箱型導彈發射器：綠色發射箱，前端露出紅色彈頭
    g.add(box(0.14, 0.1, 0.36, M.steelDark, 0, 0.05, 0));
    g.add(box(0.3, 0.28, 0.72, M.green, 0, 0.26, 0.02));
    g.add(box(0.31, 0.04, 0.74, M.olive, 0, 0.41, 0.02));
    g.add(box(0.24, 0.22, 0.02, M.black, 0, 0.26, 0.385));
    const nose = mesh(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), M.red, 0, 0.26, 0.38);
    g.add(nose);
    g.add(box(0.012, 0.05, 0.4, M.white, 0.156, 0.3, 0.02));
    g.add(mesh(new THREE.CylinderGeometry(0.08, 0.02, 0.05, 10).rotateX(-0.6), M.steel, -0.1, 0.46, -0.22));
  } else if (id === 'shield') {
    // 護盾發射器：車尾的扁平底座、半圓形的發射板與發光條
    g.add(box(0.56, 0.08, 0.3, M.steelDark, 0, 0.04, 0));
    const plate = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 16, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), M.steel, 0, 0.1, -0.12);
    g.add(plate);
    g.add(mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 16, Math.PI), M.mineLight, 0, 0.1, -0.16));
    g.add(box(0.06, 0.18, 0.06, M.gun, -0.2, 0.17, 0.06));
    g.add(box(0.06, 0.18, 0.06, M.gun, 0.2, 0.17, 0.06));
  } else if (id === 'mine') {
    // 地雷投放箱：黃黑警示帶，上面擺著一顆六角地雷
    g.add(box(0.62, 0.3, 0.4, M.gun, 0, 0.15, 0));
    g.add(box(0.63, 0.06, 0.41, M.hazard, 0, 0.27, 0));
    g.add(box(0.4, 0.04, 0.2, M.black, 0, 0.0, -0.2));
    const mine = mesh(hexMineGeometry(), M.steel, 0, 0.3, 0);
    mine.scale.setScalar(0.42);
    g.add(mine);
    g.add(mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.05, 10), M.mineLight, 0, 0.4, 0));
  } else {
    // 集束圓雷：方形投放器、彎曲軟管、紅白條紋圓雷
    g.add(box(0.5, 0.28, 0.42, M.gun, 0, 0.14, 0));
    for (const x of [-0.17, -0.06, 0.05, 0.16]) g.add(box(0.05, 0.06, 0.43, M.steelDark, x, 0.3, 0));
    g.add(box(0.51, 0.05, 0.1, M.hazard, 0, 0.16, 0.17));
    const hose = mesh(new THREE.TorusGeometry(0.16, 0.05, 8, 12, Math.PI), M.steel, 0.3, 0.12, -0.05);
    hose.rotation.y = Math.PI / 2;
    g.add(hose);
    for (const [x, z] of [[-0.12, -0.25], [0.12, -0.27]]) g.add(mesh(new THREE.SphereGeometry(0.09, 12, 8), M.striped, x, 0.09, z));
  }
  return g;
}

/** 集束圓雷（賽道上）的幾何與材質 */
export const clusterMineMaterial = () => M.striped;
export const steelMaterial = () => M.steel;
