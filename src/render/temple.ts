import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 夜市賽道的廟宇景物（全部用程式產生，之後可換成 Tripo 模型）：
 * - 廟：三川殿（中間屋脊較高的三段式屋頂、燕尾脊、剪黏雙龍、龍柱、門神、對聯、匾額）＋後方重簷正殿
 * - 牌樓：四柱三間的廟口門樓，匾額文字可以換
 * - 香爐、神轎
 * 每個模型依材質合併成少數幾個網格；材質與貼圖在所有模型間共用（第一次用到時才建立）。
 * 夜裡不放真的燈光：燈籠、屋簷的 LED 燈條用會發亮的基本材質，牆面與屋頂加一點暖色自發光當作投射燈。
 * 廟名、匾額、對聯都是自己編的吉祥話，不對應任何真實的廟。
 */

export interface TempleOpts { lowDetail: boolean; shadows: boolean }

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
/** 發光材質的亮度倍率（大於 1 才會被泛光暈開） */
const GLOW = 1.45;
const TAU = Math.PI * 2;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 剪黏、石材、金漆等頂點色（同一個材質，用頂點色區分） */
const COL = {
  stone: 0x9a948a, stoneLight: 0xb4ada2, stoneDark: 0x7d776e,
  gold: 0xe2b040, bronze: 0x8c5a2c, red: 0xb3221b, deepRed: 0x8a1d14, wood: 0x5a1c12, dark: 0x1a100b,
  teal: 0x1f6e74, orange: 0xd8822a, green: 0x2fae5a, blue: 0x2f6fd8, pink: 0xe86a8a, fin: 0xe0502a,
  lantern: 0xff2a10, led: 0xffc070, ember: 0xff6a18, pearl: 0xff5020, stick: 0x8a4a2a,
};

// ---------- 貼圖 ----------

/** 畫在 canvas 上的貼圖；沒有 document（無畫面的測試）時回傳 null，材質改用純色 */
function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = false): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (!c) return null;
  draw(c);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

type Rect = readonly [number, number, number, number];
// 共用圖集（512×512）裡各區塊的位置（canvas 像素）
const AT_DOOR: Rect = [0, 0, 256, 256];
const AT_SIDE: Rect = [256, 0, 128, 256];
const AT_COUPLET = (k: number): Rect => [384 + k * 32, 0, 32, 256];
const AT_PLAQUE: Rect = [0, 256, 256, 96];
const AT_WINDOW: Rect = [256, 256, 128, 128];
const AT_PANEL: Rect = [384, 256, 128, 128];
const AT_BAND: Rect = [0, 384, 512, 64];
// 牌樓的匾額貼圖（每種標題一張）
const GT_TITLE: Rect = [0, 0, 512, 128];
const GT_COUPLET = (k: number): Rect => [k * 48, 128, 48, 384];
const GT_SIDE = (k: number): Rect => [192, 128 + k * 96, 320, 96];

/** 直書文字（對聯） */
function vText(c: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, fg: string): void {
  const chars = Array.from(text);
  const n = chars.length, step = h / n, px = Math.floor(Math.min(w * 0.78, step * 0.8));
  c.font = `bold ${px}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    c.fillStyle = 'rgba(40,10,0,0.6)';
    c.fillText(ch, x + w / 2 + 1, y + step * (i + 0.5) + 1);
    c.fillStyle = fg;
    c.fillText(ch, x + w / 2, y + step * (i + 0.5));
  });
}

/** 紅底金字的對聯條 */
function couplet(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string, bg: string, fg: string): void {
  c.fillStyle = '#e2b04a';
  c.fillRect(x, y, w, h);
  c.fillStyle = bg;
  c.fillRect(x + 2, y + 2, w - 4, h - 4);
  vText(c, text, x + 2, y + 6, w - 4, h - 12, fg);
}

/** 橫匾：金框、深色底、字平均排開 */
function plaqueBox(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, bg: string, text: string, fg: string): void {
  c.fillStyle = '#6a3a0c';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#e2b04a';
  c.fillRect(x + 3, y + 3, w - 6, h - 6);
  c.fillStyle = bg;
  c.fillRect(x + 9, y + 9, w - 18, h - 18);
  c.strokeStyle = 'rgba(255,215,110,0.75)';
  c.lineWidth = 2;
  c.strokeRect(x + 14, y + 14, w - 28, h - 28);
  c.fillStyle = '#e2b04a';
  for (const [cx, cy] of [[x + 10, y + 10], [x + w - 18, y + 10], [x + 10, y + h - 18], [x + w - 18, y + h - 18]]) c.fillRect(cx, cy, 8, 8);
  const chars = Array.from(text);
  const n = chars.length, step = (w - 40) / n;
  const px = Math.floor(Math.min((h - 30) * 0.86, step * 0.9));
  c.font = `bold ${px}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    const cx = x + 20 + step * (i + 0.5);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillText(ch, cx + 2, y + h / 2 + 2);
    c.fillStyle = fg;
    c.fillText(ch, cx, y + h / 2);
  });
}

/** 門神（簡化的幾何造型：頭盔、鎧甲、背旗、長兵器），flip = 右扇（兵器拿在另一邊、門環在左緣） */
function doorGod(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, face: string, robe: string, flip: boolean): void {
  c.fillStyle = '#9e1a17';
  c.fillRect(x, y, w, h);
  c.strokeStyle = '#e2b04a';
  c.lineWidth = 6;
  c.strokeRect(x + 4, y + 4, w - 8, h - 8);
  c.strokeStyle = '#5a0c0a';
  c.lineWidth = 2;
  c.strokeRect(x + 10, y + 10, w - 20, h - 20);
  const cx = x + w / 2;
  // 光圈
  c.fillStyle = 'rgba(255,200,90,0.35)';
  c.beginPath();
  c.arc(cx, y + 66, 34, 0, TAU);
  c.fill();
  // 背旗
  c.fillStyle = '#e8c040';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(cx + s * 16, y + 98);
    c.lineTo(cx + s * 44, y + 34);
    c.lineTo(cx + s * 30, y + 100);
    c.closePath();
    c.fill();
  }
  // 鎧甲
  c.fillStyle = robe;
  c.beginPath();
  c.moveTo(cx - 34, y + 100);
  c.lineTo(cx + 34, y + 100);
  c.lineTo(cx + 44, y + 232);
  c.lineTo(cx - 44, y + 232);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,215,100,0.8)';
  c.lineWidth = 1.5;
  for (let r = 0; r < 8; r++) for (let k = -3; k <= 3; k++) {
    c.beginPath();
    c.arc(cx + k * 10 + (r % 2) * 5, y + 118 + r * 13, 5, 0, Math.PI);
    c.stroke();
  }
  c.fillStyle = '#e8c040';
  c.fillRect(cx - 38, y + 166, 76, 9);
  c.fillStyle = '#d23a2a';
  c.fillRect(cx - 8, y + 175, 16, 40);
  for (const s of [-1, 1]) {
    c.fillStyle = '#e8c040';
    c.beginPath();
    c.arc(cx + s * 31, y + 106, 13, 0, TAU);
    c.fill();
  }
  // 頭、眉眼、鬍子
  c.fillStyle = face;
  c.beginPath();
  c.arc(cx, y + 74, 21, 0, TAU);
  c.fill();
  c.fillStyle = '#111';
  c.fillRect(cx - 14, y + 64, 10, 3);
  c.fillRect(cx + 4, y + 64, 10, 3);
  c.fillRect(cx - 10, y + 70, 4, 4);
  c.fillRect(cx + 6, y + 70, 4, 4);
  c.fillStyle = '#151010';
  c.beginPath();
  c.moveTo(cx - 13, y + 84);
  c.lineTo(cx + 13, y + 84);
  c.lineTo(cx, y + 112);
  c.closePath();
  c.fill();
  // 頭盔與紅纓
  c.fillStyle = '#e8c040';
  c.beginPath();
  c.moveTo(cx - 25, y + 62);
  c.lineTo(cx + 25, y + 62);
  c.lineTo(cx + 16, y + 40);
  c.lineTo(cx - 16, y + 40);
  c.closePath();
  c.fill();
  c.fillStyle = '#d23a2a';
  c.beginPath();
  c.arc(cx, y + 35, 7, 0, TAU);
  c.fill();
  // 長兵器
  const wx = cx + (flip ? -46 : 46);
  c.fillStyle = '#c9c2b0';
  c.fillRect(wx - 2, y + 32, 4, 200);
  c.fillStyle = '#e8c040';
  c.beginPath();
  c.moveTo(wx, y + 14);
  c.lineTo(wx + 7, y + 38);
  c.lineTo(wx - 7, y + 38);
  c.closePath();
  c.fill();
  // 門環
  c.strokeStyle = '#f0c050';
  c.lineWidth = 3;
  c.beginPath();
  c.arc(flip ? x + 14 : x + w - 14, y + h * 0.56, 7, 0, TAU);
  c.stroke();
}

function drawAtlas(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#3a1a10';
  c.fillRect(0, 0, 512, 512);
  // 中門：一對門神
  doorGod(c, 0, 0, 128, 256, '#efc49a', '#2f7a46', false);
  doorGod(c, 128, 0, 128, 256, '#c2452f', '#2a4f9a', true);
  // 側門：門釘與門環
  for (let k = 0; k < 2; k++) {
    const x = 256 + k * 64;
    c.fillStyle = '#9e1a17';
    c.fillRect(x, 0, 64, 256);
    c.strokeStyle = '#e2b04a';
    c.lineWidth = 4;
    c.strokeRect(x + 3, 3, 58, 250);
    c.fillStyle = '#f0c050';
    for (let r = 0; r < 9; r++) for (let q = 0; q < 4; q++) {
      c.beginPath();
      c.arc(x + 13 + q * 12, 22 + r * 25, 3.2, 0, TAU);
      c.fill();
    }
    c.strokeStyle = '#f0c050';
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(k ? x + 8 : x + 56, 135, 5.5, 0, TAU);
    c.stroke();
  }
  // 對聯
  ['風調雨順', '國泰民安', '合境平安', '五穀豐登'].forEach((t, k) => couplet(c, 384 + k * 32, 0, 32, 256, t, '#b3161b', '#ffd76a'));
  // 匾額（自編的廟名）
  plaqueBox(c, 0, 256, 256, 96, '#163a6a', '福安宮', '#ffd45a');
  // 石雕竹節窗：窗後透出暖色燈光
  {
    const x = 256, y = 256;
    c.fillStyle = '#8d877c';
    c.fillRect(x, y, 128, 128);
    c.fillStyle = '#6e695f';
    c.fillRect(x + 6, y + 6, 116, 116);
    const g = c.createRadialGradient(x + 64, y + 64, 6, x + 64, y + 64, 62);
    g.addColorStop(0, '#d07a22');
    g.addColorStop(1, '#3a1608');
    c.fillStyle = g;
    c.fillRect(x + 14, y + 14, 100, 100);
    for (let k = 0; k < 7; k++) {
      const x0 = x + 17 + k * 14;
      c.fillStyle = '#a9a294';
      c.fillRect(x0, y + 14, 7, 100);
      c.fillStyle = '#7d776c';
      for (let j = 0; j < 4; j++) c.fillRect(x0 - 1, y + 28 + j * 24, 9, 3);
    }
  }
  // 神轎的金色雕花板
  {
    const x = 384, y = 256;
    c.fillStyle = '#c99a30';
    c.fillRect(x, y, 128, 128);
    c.fillStyle = '#8a1414';
    c.fillRect(x + 12, y + 12, 104, 104);
    c.strokeStyle = '#f0c860';
    c.lineWidth = 2;
    c.strokeRect(x + 17, y + 17, 94, 94);
    c.fillStyle = '#f0c860';
    c.beginPath();
    c.arc(x + 64, y + 64, 22, 0, TAU);
    c.fill();
    c.fillStyle = '#8a1414';
    c.beginPath();
    c.arc(x + 64, y + 64, 16, 0, TAU);
    c.fill();
    c.fillStyle = '#f0c860';
    c.font = `bold 22px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('福', x + 64, y + 65);
    c.strokeStyle = '#f0c860';
    c.lineWidth = 3;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const cx = x + 64 + sx * 30, cy = y + 64 + sy * 30;
      c.beginPath();
      c.arc(cx, cy, 10, 0, Math.PI * 1.5);
      c.stroke();
      c.beginPath();
      c.arc(cx + sx * 9, cy + sy * 2, 5, 0, Math.PI * 1.5);
      c.stroke();
    }
  }
  // 樑上的彩繪：藍綠底、旋子花、中間紅色包巾
  {
    const y = 384;
    c.fillStyle = '#1d5a78';
    c.fillRect(0, y, 512, 64);
    c.fillStyle = '#e2b04a';
    c.fillRect(0, y, 512, 5);
    c.fillRect(0, y + 59, 512, 5);
    for (let x = 32; x < 512; x += 64) {
      if (x > 150 && x < 362) continue;
      c.strokeStyle = '#e2b04a';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x, y + 32, 17, 0, TAU);
      c.stroke();
      c.fillStyle = '#3fa66a';
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU;
        c.beginPath();
        c.arc(x + Math.cos(a) * 9, y + 32 + Math.sin(a) * 9, 5, 0, TAU);
        c.fill();
      }
      c.fillStyle = '#e2b04a';
      c.beginPath();
      c.arc(x, y + 32, 4, 0, TAU);
      c.fill();
    }
    c.fillStyle = '#e2b04a';
    c.beginPath();
    c.ellipse(256, y + 32, 96, 28, 0, 0, TAU);
    c.fill();
    c.fillStyle = '#a01c18';
    c.beginPath();
    c.ellipse(256, y + 32, 90, 23, 0, 0, TAU);
    c.fill();
    for (const dx of [-48, 0, 48]) {
      c.fillStyle = '#f08aa8';
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU;
        c.beginPath();
        c.arc(256 + dx + Math.cos(a) * 7, y + 32 + Math.sin(a) * 7, 5, 0, TAU);
        c.fill();
      }
      c.fillStyle = '#fff2c0';
      c.beginPath();
      c.arc(256 + dx, y + 32, 3.5, 0, TAU);
      c.fill();
    }
  }
}

/** 琉璃瓦：一條條筒瓦（明暗漸層）加上橫向的瓦縫 */
function drawTile(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#d9852a';
  c.fillRect(0, 0, 128, 128);
  for (let x = 0; x < 128; x += 16) {
    const g = c.createLinearGradient(x, 0, x + 16, 0);
    g.addColorStop(0, '#8a4a18');
    g.addColorStop(0.25, '#e09a3a');
    g.addColorStop(0.5, '#f6c060');
    g.addColorStop(0.8, '#c87a28');
    g.addColorStop(1, '#7a3e14');
    c.fillStyle = g;
    c.fillRect(x, 0, 16, 128);
  }
  c.fillStyle = 'rgba(90,40,10,0.35)';
  for (let y = 0; y < 128; y += 32) c.fillRect(0, y, 128, 3);
}

function drawGate(c: CanvasRenderingContext2D, title: string): void {
  c.fillStyle = '#2a0e08';
  c.fillRect(0, 0, 512, 512);
  plaqueBox(c, 0, 0, 512, 128, '#0f3d66', title, '#ffd75e');
  ['夜市燈如晝', '廟口人似潮', '香煙通四海', '福澤遍千家'].forEach((t, k) => couplet(c, k * 48, 128, 48, 384, t, '#b3121b', '#ffd76a'));
  plaqueBox(c, 192, 128, 320, 96, '#1d5a3a', '風調雨順', '#ffd75e');
  plaqueBox(c, 192, 224, 320, 96, '#1d5a3a', '國泰民安', '#ffd75e');
}

// ---------- 材質（所有模型共用） ----------

interface Mats {
  red: THREE.MeshLambertMaterial;
  tile: THREE.MeshLambertMaterial;
  deco: THREE.MeshLambertMaterial;
  atlas: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
}
let MATS: Mats | null = null;
function mats(): Mats {
  if (MATS) return MATS;
  const tileTex = canvasTex(128, 128, drawTile, true);
  const atlasTex = canvasTex(512, 512, drawAtlas);
  MATS = {
    // 朱紅色的柱子與牆：加一點暖色自發光，像被投射燈照亮
    red: new THREE.MeshLambertMaterial({ color: COL.red, emissive: 0x3c0e06, side: THREE.DoubleSide }),
    tile: new THREE.MeshLambertMaterial({ color: tileTex ? 0xffffff : 0xd9852a, map: tileTex, emissive: 0x2c1606, side: THREE.DoubleSide }),
    deco: new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x24160a, side: THREE.DoubleSide }),
    atlas: new THREE.MeshBasicMaterial({ color: atlasTex ? new THREE.Color(0.86, 0.86, 0.86) : 0x8a2a1a, map: atlasTex }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(GLOW, GLOW, GLOW), side: THREE.DoubleSide }),
  };
  return MATS;
}
const gateMats = new Map<string, THREE.MeshBasicMaterial>();
function gateMat(title: string): THREE.MeshBasicMaterial {
  let m = gateMats.get(title);
  if (m) return m;
  const tex = canvasTex(512, 512, (c) => drawGate(c, title));
  m = new THREE.MeshBasicMaterial({ color: tex ? new THREE.Color(0.9, 0.9, 0.9) : 0x1a4a7a, map: tex });
  gateMats.set(title, m);
  return m;
}

/** 燈籠與 LED 燈條輕輕閃爍（共用材質，所有廟與牌樓一起） */
function flicker(time: number): void {
  const k = GLOW * (1 + 0.045 * Math.sin(time * 2.7) + 0.025 * Math.sin(time * 7.3 + 1.3));
  mats().glow.color.setRGB(k, k, k);
}

// ---------- 幾何工具 ----------

type Key = 'red' | 'tile' | 'deco' | 'atlas' | 'glow' | 'sign';
const KEEP = ['position', 'normal', 'uv'];

function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** 合併前統一屬性：非索引、position / normal / uv（＋頂點色） */
function prep(g: THREE.BufferGeometry, colored: boolean): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  if (!out.attributes.normal) out.computeVertexNormals();
  const n = out.attributes.position.count;
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (colored && !out.attributes.color) paint(out, 0xffffff);
  for (const name of Object.keys(out.attributes)) if (!KEEP.includes(name) && !(colored && name === 'color')) out.deleteAttribute(name);
  out.clearGroups();
  return out;
}

/** 依材質收集零件，最後每種材質合併成一個網格 */
class Parts {
  private m = new Map<Key, THREE.BufferGeometry[]>();
  add(k: Key, g: THREE.BufferGeometry, col?: number): void {
    if (col !== undefined) paint(g, col);
    let l = this.m.get(k);
    if (!l) this.m.set(k, (l = []));
    l.push(g);
  }
  build(group: THREE.Group, mat: (k: Key) => THREE.Material, shadows: boolean, cast: Key[]): void {
    for (const [k, list] of this.m) {
      const colored = k === 'deco' || k === 'glow';
      const geos = list.map((g) => prep(g, colored));
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat(k));
      mesh.name = k;
      mesh.castShadow = shadows && cast.includes(k);
      mesh.receiveShadow = shadows && (k === 'red' || k === 'tile' || k === 'deco');
      group.add(mesh);
    }
  }
}

function mkGeo(pos: number[], uv: number[], idx: number[], col?: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function bx(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rz = 0, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  return g.translate(x, y, z);
}
/** 圓柱：y0 = 底部高度 */
function cyl(rt: number, rb: number, h: number, seg: number, x: number, y0: number, z: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y0 + h / 2, z);
}
function atlasUV(g: THREE.BufferGeometry, r: Rect, size = 512): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const u0 = (r[0] + 1) / size, u1 = (r[0] + r[2] - 1) / size;
  const v1 = 1 - (r[1] + 1) / size, v0 = 1 - (r[1] + r[3] - 1) / size;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}
/** 貼圖集裡一塊區域的平面（預設面向 +Z） */
function plane(w: number, h: number, r: Rect, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  return atlasUV(new THREE.PlaneGeometry(w, h), r).rotateY(ry).translate(x, y, z);
}

/** 沿折線掃出多邊形斷面的管子（可漸細、每一圈可換顏色）：屋脊、燕尾、龍身、LED 燈條 */
function sweep(pts: THREE.Vector3[], rad: (u: number) => number, sides: number, col: (u: number) => number, rot = Math.PI / 4): THREE.BufferGeometry {
  const n = pts.length;
  const pos: number[] = [], uv: number[] = [], color: number[] = [], idx: number[] = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);
  const c = new THREE.Color();
  let first = true;
  for (let i = 0; i < n; i++) {
    T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    if (first) {
      N.crossVectors(T, up);
      if (N.lengthSq() < 1e-6) N.crossVectors(T, side);
      N.normalize();
      first = false;
    } else {
      // 平行移動：沿著管子不會突然扭轉
      N.addScaledVector(T, -N.dot(T));
      if (N.lengthSq() < 1e-8) N.crossVectors(T, up);
      N.normalize();
    }
    B.crossVectors(T, N).normalize();
    const u = n > 1 ? i / (n - 1) : 0, r = rad(u);
    c.setHex(col(u));
    for (let k = 0; k <= sides; k++) {
      const a = rot + (k / sides) * TAU;
      p.copy(pts[i]).addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r);
      pos.push(p.x, p.y, p.z);
      uv.push(k / sides, u);
      color.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < sides; k++) {
    const a = i * (sides + 1) + k, b = a + 1, cc = a + sides + 1, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  return mkGeo(pos, uv, idx, color);
}

function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.push(V(p0.x * a + p1.x * b + p2.x * c, p0.y * a + p1.y * b + p2.y * c, p0.z * a + p1.z * b + p2.z * c));
  }
  return out;
}

// ---------- 屋頂 ----------

interface SlopeOpt {
  xc: number;
  /** 屋面沿 X 的半長：屋脊處與屋簷處（屋簷處較長 = 翼角往外伸），之間依 (1-t)^flare 變化 */
  hrRidge: number; hrEave: number; flare: number;
  zEave: number; zRidge: number; yEave: number; yRidge: number;
  /** 翼角起翹的高度 */
  lift: number;
  /** 翼角往外推出的比例（四面圍起來的腰簷要 0，斜脊才對得齊） */
  push: number;
  /** 斷面的凹曲程度（越大越凹：屋簷平緩、近屋脊陡） */
  curve: number;
}

/** 一面屋坡：t = 0 在屋簷、1 在屋脊，xs = -1 ~ 1 沿屋脊方向 */
class Slope {
  constructor(readonly o: SlopeOpt) {}
  hw(t: number): number {
    const o = this.o;
    return o.hrRidge + (o.hrEave - o.hrRidge) * Math.pow(1 - t, o.flare);
  }
  at(xs: number, t: number, out = new THREE.Vector3()): THREE.Vector3 {
    const o = this.o, a = Math.min(1, Math.abs(xs)), e = (1 - t) * (1 - t);
    const sz = Math.sign(o.zEave - o.zRidge);
    return out.set(
      o.xc + xs * this.hw(t),
      o.yEave + (o.yRidge - o.yEave) * Math.pow(t, o.curve) + o.lift * a * a * a * e,
      o.zEave + (o.zRidge - o.zEave) * t + sz * o.push * o.lift * a * a * a * a * e,
    );
  }
  /** 屋面（琉璃瓦貼圖：u 沿屋脊、v 沿斜面，每 2.4 公尺重複） */
  surface(nx: number, nt: number): THREE.BufferGeometry {
    const o = this.o;
    const len = Math.hypot(o.zRidge - o.zEave, o.yRidge - o.yEave);
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const p = new THREE.Vector3();
    for (let j = 0; j <= nt; j++) for (let i = 0; i <= nx; i++) {
      const t = j / nt;
      this.at(-1 + (2 * i) / nx, t, p);
      pos.push(p.x, p.y, p.z);
      uv.push(p.x / 2.4, (t * len) / 2.4);
    }
    for (let j = 0; j < nt; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    return mkGeo(pos, uv, idx);
  }
  /** 屋簷前緣往下的一條封簷板 */
  fascia(nx: number, h: number): THREE.BufferGeometry {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= nx; i++) {
      this.at(-1 + (2 * i) / nx, 0, p);
      pos.push(p.x, p.y, p.z, p.x, p.y - h, p.z);
      uv.push(i / nx, 1, i / nx, 0);
    }
    for (let i = 0; i < nx; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    return mkGeo(pos, uv, idx);
  }
  /** 屋簷下緣的線（LED 燈條） */
  eaveLine(nx: number, dy: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const sz = Math.sign(this.o.zEave - this.o.zRidge);
    for (let i = 0; i <= nx; i++) {
      const p = this.at(-1 + (2 * i) / nx, 0);
      p.y -= dy;
      p.z += sz * 0.04;
      out.push(p);
    }
    return out;
  }
  /** 屋坡一端的垂脊：從屋脊沿邊緣下到翼角，最後往外往上捲起 */
  edge(side: number, nt: number, inset: number, up: number, sc: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let k = 0; k <= nt; k++) {
      const t = 1 - k / nt, hw = this.hw(t);
      const p = this.at((side * (hw - inset)) / hw, t);
      p.y += up;
      out.push(p);
    }
    const p0 = out[out.length - 1];
    const sz = Math.sign(this.o.zEave - this.o.zRidge);
    for (const [o, h] of [[0.45, 0.3], [0.75, 0.8], [0.8, 1.15]]) out.push(V(p0.x + side * o * sc * 0.7, p0.y + h * sc, p0.z + sz * o * sc * 0.7));
    return out;
  }
}

/** 燕尾脊：屋脊兩端往外往上翹、分成兩叉（d = 往外的方向） */
function swallow(P: Parts, xe: number, yr: number, zr: number, d: number, sc: number, lo: boolean): void {
  const n = lo ? 6 : 10;
  for (const [dz, hy, reach] of [[0.32, 2.1, 1.95], [-0.32, 1.6, 1.75]]) {
    const pts = bezier(V(xe - d * 0.5 * sc, yr, zr), V(xe + d * 1.25 * sc, yr + 0.25 * sc, zr + dz * 0.2 * sc), V(xe + d * reach * sc, yr + hy * sc, zr + dz * sc), n);
    P.add('deco', sweep(pts, (u) => sc * (0.26 - 0.19 * u), lo ? 3 : 4, (u) => (u > 0.8 ? COL.gold : COL.teal)));
  }
}

/** 剪黏的龍：彎曲的龍身（綠、藍、金一節節）、龍頭、角、背鰭、腳；尾巴在 xTail，頭朝 xHead */
function dragon(P: Parts, xTail: number, xHead: number, y0: number, z0: number, s: number, lo: boolean): void {
  const d = Math.sign(xHead - xTail) || 1;
  const segs = lo ? 12 : 22;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    pts.push(V(
      xTail + (xHead - xTail) * u,
      y0 + s * (0.32 + 0.34 * Math.sin(u * Math.PI * 2.6 + 0.4) * (1 - 0.35 * u) + 0.35 * u),
      z0 + s * 0.14 * Math.sin(u * Math.PI * 3.2),
    ));
  }
  const rad = (u: number) => s * (0.045 + 0.15 * smooth(0, 0.4, u));
  P.add('deco', sweep(pts, rad, lo ? 4 : 6, (u) => {
    const k = Math.floor(u * segs);
    return k % 3 === 2 ? COL.gold : k % 2 ? COL.blue : COL.green;
  }));
  const h = pts[segs];
  P.add('deco', bx(0.55 * s, 0.36 * s, 0.38 * s, h.x + d * 0.12 * s, h.y + 0.06 * s, h.z), COL.green);
  P.add('deco', bx(0.32 * s, 0.1 * s, 0.3 * s, h.x + d * 0.4 * s, h.y - 0.08 * s, h.z), COL.fin);
  for (const sz of [-1, 1]) P.add('deco', bx(0.07 * s, 0.34 * s, 0.07 * s, h.x - d * 0.06 * s, h.y + 0.36 * s, h.z + sz * 0.1 * s, 0, d * 0.5), COL.gold);
  if (!lo) {
    for (const u of [0.25, 0.45, 0.65, 0.85]) {
      const p = pts[Math.round(u * segs)];
      P.add('deco', bx(0.14 * s, 0.24 * s, 0.05 * s, p.x, p.y + rad(u) + 0.08 * s, p.z, 0, -d * 0.4), COL.fin);
    }
    for (const u of [0.35, 0.7]) {
      const p = pts[Math.round(u * segs)];
      P.add('deco', bx(0.1 * s, 0.32 * s, 0.1 * s, p.x, p.y - 0.22 * s, p.z), COL.green);
    }
  }
}

/** 火珠（雙龍搶的那顆）：發亮的珠子加三道火焰 */
function pearl(P: Parts, x: number, y: number, z: number, s: number, lo: boolean): void {
  P.add('deco', bx(0.08 * s, 0.5 * s, 0.08 * s, x, y - 0.25 * s, z), COL.gold);
  P.add('glow', new THREE.SphereGeometry(0.3 * s, lo ? 8 : 12, lo ? 6 : 8).translate(x, y + 0.1 * s, z), COL.pearl);
  for (const k of [-1, 0, 1]) P.add('glow', new THREE.ConeGeometry(0.11 * s, 0.45 * s, 5).rotateZ(-k * 0.35).translate(x + k * 0.14 * s, y + 0.5 * s, z), COL.ember);
}

/** 屋脊中央的小寶塔 */
function pagoda(P: Parts, x: number, y: number, z: number, s: number): void {
  let yy = y;
  for (let k = 0; k < 5; k++) {
    const w = (0.62 - 0.09 * k) * s;
    P.add('deco', bx(w, 0.24 * s, w, x, yy + 0.12 * s, z), k % 2 ? COL.green : COL.red);
    P.add('deco', bx(w + 0.22 * s, 0.06 * s, w + 0.22 * s, x, yy + 0.27 * s, z), COL.gold);
    yy += 0.3 * s;
  }
  P.add('deco', new THREE.SphereGeometry(0.09 * s, 8, 6).translate(x, yy + 0.08 * s, z), COL.gold);
}

/** 紅燈籠：吊繩、金色頂蓋與底蓋、發亮的燈籠身、兩圈金邊、紅色流蘇 */
function lantern(P: Parts, x: number, yTop: number, z: number, r: number, lo: boolean, str = 0.35): void {
  P.add('deco', bx(0.03, str, 0.03, x, yTop - str / 2, z), COL.dark);
  const top = yTop - str;
  P.add('deco', cyl(r * 0.42, r * 0.42, 0.12, 8, x, top - 0.12, z), COL.gold);
  const ry = r * 1.15, cy = top - 0.1 - ry;
  P.add('glow', new THREE.SphereGeometry(r, lo ? 8 : 12, lo ? 6 : 9).scale(1, 1.15, 1).translate(x, cy, z), COL.lantern);
  if (!lo) for (const k of [-0.45, 0.45]) P.add('deco', cyl(r * 0.9, r * 0.9, 0.04, 12, x, cy + k * ry - 0.02, z), COL.gold);
  const bot = cy - ry + 0.04;
  P.add('deco', cyl(r * 0.42, r * 0.42, 0.12, 8, x, bot - 0.1, z), COL.gold);
  P.add('deco', bx(0.07, 0.84 * r, 0.07, x, bot - 0.1 - 0.42 * r, z), COL.red);
}

interface RoofOpt {
  xc: number;
  /** 屋脊（不含出挑）的半長 */
  hr: number;
  zF: number; zR: number; zB: number; yE: number; yR: number; lift: number;
  /** 屋脊處／屋簷處往兩端出挑多少 */
  oh?: [number, number];
  /** 屋脊、燕尾等零件的大小倍率 */
  sc?: number;
  /** 哪幾端要燕尾、垂脊：-1 = -X 端、1 = +X 端 */
  tails?: number[];
  edges?: number[];
  /** 屋簷下的 LED 燈條：前簷、後簷 */
  ledF?: boolean;
  ledB?: boolean;
  /** 屋面改用這個頂點色（神轎的金頂）；沒設定 = 琉璃瓦 */
  tileCol?: number;
  ridgeCol?: number;
}

/** 兩坡頂（屋脊沿 X）：凹曲的屋面、起翹的翼角、屋脊、剪黏、燕尾、垂脊、LED 燈條 */
function gableRoof(P: Parts, r: RoofOpt, lo: boolean): { front: Slope; back: Slope } {
  const sc = r.sc ?? 1;
  const [oh0, oh1] = r.oh ?? [0.6, 1.5];
  const mk = (zE: number) => new Slope({ xc: r.xc, hrRidge: r.hr + oh0, hrEave: r.hr + oh1, flare: 2, zEave: zE, zRidge: r.zR, yEave: r.yE, yRidge: r.yR, lift: r.lift, push: 1, curve: 1.6 });
  const front = mk(r.zF), back = mk(r.zB);
  const L = 2 * (r.hr + oh1);
  const nx = Math.max(6, Math.round(((lo ? 0.5 : 1) * L) / 1.2)), nt = lo ? 4 : 8;
  for (const s of [front, back]) {
    const g = s.surface(nx, nt);
    if (r.tileCol !== undefined) P.add('deco', g, r.tileCol);
    else P.add('tile', g);
    P.add('deco', s.fascia(nx, 0.28 * sc), COL.deepRed);
  }
  // 屋脊：深色脊身、橘色脊頂，兩面嵌一排彩色剪黏
  const rl = 2 * (r.hr + oh0) + 0.1 * sc;
  P.add('deco', bx(rl, 0.55 * sc, 0.42 * sc, r.xc, r.yR + 0.18 * sc, r.zR), r.ridgeCol ?? COL.teal);
  P.add('deco', bx(rl, 0.12 * sc, 0.5 * sc, r.xc, r.yR + 0.5 * sc, r.zR), COL.orange);
  if (!lo && sc > 0.5) {
    const cols = [COL.blue, COL.green, COL.gold, COL.pink, COL.fin];
    let k = 0;
    for (let x = -rl / 2 + 0.6 * sc; x < rl / 2 - 0.5 * sc; x += 1.0 * sc, k++) {
      for (const sz of [-1, 1]) P.add('deco', bx(0.6 * sc, 0.28 * sc, 0.05, r.xc + x + 0.3 * sc, r.yR + 0.2 * sc, r.zR + sz * 0.22 * sc), cols[k % cols.length]);
    }
  }
  for (const e of r.tails ?? []) swallow(P, r.xc + e * (r.hr + oh0), r.yR + 0.18 * sc, r.zR, e, sc, lo);
  for (const e of r.edges ?? []) for (const s of [front, back]) {
    P.add('deco', sweep(s.edge(e, nt, 0.3 * sc, 0.2 * sc, sc), () => 0.16 * sc, lo ? 3 : 4, (u) => (u > 0.85 ? COL.gold : COL.teal)));
  }
  if (r.ledF) P.add('glow', sweep(front.eaveLine(nx * 2, 0.32 * sc), () => 0.05, 3, () => COL.led));
  if (r.ledB) P.add('glow', sweep(back.eaveLine(nx * 2, 0.32 * sc), () => 0.05, 3, () => COL.led));
  return { front, back };
}

/** 兩坡頂一端的山牆：上緣貼著屋面的凹曲線（在 x 處、從前牆線 zA 到後牆線 zB） */
function gableWall(front: Slope, back: Slope, x: number, y0: number, zA: number, zB: number, K: number): THREE.BufferGeometry {
  const zr = front.o.zRidge;
  const zs: number[] = [];
  for (let k = 0; k <= K; k++) zs.push(zA + ((zr - zA) * k) / K);
  for (let k = 1; k <= K; k++) zs.push(zr + ((zB - zr) * k) / K);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const p = new THREE.Vector3();
  zs.forEach((z, k) => {
    const s = z >= zr ? front : back;
    const t = Math.min(1, Math.max(0, (s.o.zEave - z) / (s.o.zEave - s.o.zRidge)));
    s.at(Math.max(-1, Math.min(1, (x - s.o.xc) / s.hw(t))), t, p);
    pos.push(x, y0, z, x, Math.max(y0, p.y - 0.12), z);
    uv.push(k / zs.length, 0, k / zs.length, 1);
  });
  for (let k = 0; k < zs.length - 1; k++) {
    const a = k * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return mkGeo(pos, uv, idx);
}

/** 正殿的腰簷：四面斜坡圍一圈（四條斜脊對齊）；hx / hz = 牆的半寬／半深，(cx, cz) = 正殿中心 */
function skirt(P: Parts, cx: number, cz: number, hx: number, hz: number, run: number, yTop: number, yEave: number, lift: number, lo: boolean): void {
  for (let k = 0; k < 4; k++) {
    // k：0 = 前（+Z）、1 = +X、2 = 後、3 = -X；先在「屋脊沿 X、屋簷朝 +Z」的座標裡做，再轉過去
    const ridgeHalf = k % 2 ? hz : hx, dist = k % 2 ? hx : hz;
    const s = new Slope({ xc: 0, hrRidge: ridgeHalf, hrEave: ridgeHalf + run, flare: 1, zEave: dist + run, zRidge: dist, yEave, yRidge: yTop, lift, push: 0, curve: 1.3 });
    const nx = lo ? 8 : Math.max(8, Math.round(ridgeHalf * 1.2)), nt = lo ? 2 : 4;
    const rot = (k * Math.PI) / 2;
    P.add('tile', s.surface(nx, nt).rotateY(rot).translate(cx, 0, cz));
    P.add('deco', s.fascia(nx, 0.24).rotateY(rot).translate(cx, 0, cz), COL.deepRed);
    if (k === 0) P.add('glow', sweep(s.eaveLine(nx * 2, 0.28), () => 0.05, 3, () => COL.led).translate(cx, 0, cz));
    if (!lo) {
      // 斜脊：沿 xs = 1 那條邊，翼角往外捲起
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= nt; j++) {
        const p = s.at(1, 1 - j / nt);
        p.y += 0.16;
        p.x -= 0.15;
        p.z -= 0.15;
        pts.push(p);
      }
      const p0 = pts[pts.length - 1];
      pts.push(V(p0.x + 0.3, p0.y + 0.25, p0.z + 0.3), V(p0.x + 0.5, p0.y + 0.65, p0.z + 0.5));
      P.add('deco', sweep(pts, () => 0.13, 4, (u) => (u > 0.85 ? COL.gold : COL.teal)).rotateY(rot).translate(cx, 0, cz));
    }
  }
}

// ---------- 廟 ----------

/** 廟：原點 = 廟埕（前方地面）與台基前緣交界的中點，正面朝 +Z，寬約 30 m（X），深約 24 m（往 -Z），屋脊最高約 15 m */
export function buildTemple(o: TempleOpts): { group: THREE.Group; smoke: THREE.Vector3[]; update(time: number): void } {
  const M = mats(), P = new Parts(), lo = o.lowDetail;
  const seg = lo ? 8 : 14;
  /** 台基頂面（殿內地面）高度 */
  const FY = 1.05;

  // ---- 台基：三層石階，全寬 ----
  P.add('deco', bx(32, 0.35, 24, 0, 0.175, -12), COL.stoneDark);
  P.add('deco', bx(31.2, 0.35, 23.4, 0, 0.525, -12.3), COL.stone);
  P.add('deco', bx(30.4, 0.35, 22.8, 0, 0.875, -12.6), COL.stoneLight);

  // ---- 三川殿：前排六根柱（中間兩根是龍柱） ----
  const CZ = -2.4, CT = 6.4;
  for (const x of [-13, -8.3, -3.5, 3.5, 8.3, 13]) {
    P.add('deco', cyl(0.5, 0.52, 0.45, seg, x, FY, CZ), COL.stone);
    const dragonCol = Math.abs(x) < 4;
    if (dragonCol) {
      P.add('deco', cyl(0.34, 0.34, CT - FY - 0.45, seg, x, FY + 0.45, CZ), COL.stoneLight);
      // 盤龍：繞著石柱的螺旋（綠鱗金節），頂端是龍頭
      const n = lo ? 20 : 44, turns = 2.2;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const u = i / n, a = u * turns * TAU + (x > 0 ? Math.PI : 0);
        pts.push(V(x + Math.cos(a) * 0.4, FY + 0.7 + u * 4.1, CZ + Math.sin(a) * 0.4));
      }
      P.add('deco', sweep(pts, (u) => 0.07 + 0.09 * smooth(0, 0.3, u), lo ? 4 : 5, (u) => (Math.floor(u * n) % 4 === 0 ? COL.gold : COL.green)));
      const h = pts[n];
      P.add('deco', bx(0.42, 0.3, 0.36, h.x, h.y + 0.1, h.z + 0.1), COL.green);
      P.add('deco', bx(0.06, 0.3, 0.06, h.x, h.y + 0.38, h.z, 0, 0.4), COL.gold);
    } else {
      P.add('red', cyl(0.32, 0.32, CT - FY - 0.45, seg, x, FY + 0.45, CZ));
      P.add('deco', cyl(0.35, 0.35, 0.16, seg, x, FY + 3.2, CZ), COL.gold);
    }
    P.add('deco', bx(0.85, 0.3, 0.85, x, CT + 0.05, CZ), COL.gold);
    // 柱頭到牆的穿樑
    P.add('red', bx(0.3, 0.35, 2.0, x, CT - 0.2, CZ - 1.0));
  }
  // 簷下的大樑與彩繪
  P.add('red', bx(27.2, 0.55, 0.42, 0, CT + 0.25, CZ));
  const cols = [-13, -8.3, -3.5, 3.5, 8.3, 13];
  for (let i = 0; i < cols.length - 1; i++) {
    const x0 = cols[i] + 0.35, x1 = cols[i + 1] - 0.35;
    for (const sz of [1, -1]) P.add('atlas', plane(x1 - x0, 0.45, AT_BAND, (x0 + x1) / 2, CT + 0.25, CZ + sz * 0.215, sz > 0 ? 0 : Math.PI));
  }
  // 斗栱：中間開間的大樑上一排彩色的小方塊（兩側屋簷較低，放不下）
  if (!lo) for (let x = -3.0; x <= 3.01; x += 1.2) {
    const k = Math.round((x + 3.0) / 1.2);
    P.add('deco', bx(0.5, 0.36, 0.62, x, CT + 0.72, CZ), k % 2 ? COL.green : COL.blue);
    P.add('deco', bx(0.66, 0.08, 0.7, x, CT + 0.94, CZ), COL.gold);
  }

  // ---- 三川殿的牆面：中門（門神）、兩側門（門釘）、石雕窗、對聯、匾額 ----
  const WZ = -4.4, WT = 7.0;
  P.add('red', bx(28, WT - FY, 8.2, 0, (FY + WT) / 2, WZ - 4.1));
  P.add('deco', bx(28.04, 1.0, 8.24, 0, FY + 0.5, WZ - 4.1), COL.stone);
  const FZ = WZ + 0.05;
  P.add('atlas', plane(3.2, 3.9, AT_DOOR, 0, FY + 1.95, FZ));
  P.add('deco', bx(3.7, 0.25, 0.14, 0, FY + 4.02, FZ), COL.gold);
  for (const s of [-1, 1]) {
    P.add('deco', bx(0.25, 3.9, 0.14, s * 1.72, FY + 1.95, FZ), COL.gold);
    P.add('atlas', plane(0.5, 3.4, AT_COUPLET(s > 0 ? 0 : 1), s * 2.2, FY + 2.0, FZ));
    // 側門
    const sx = s * 5.9;
    P.add('atlas', plane(2.2, 3.4, AT_SIDE, sx, FY + 1.7, FZ));
    P.add('deco', bx(2.6, 0.2, 0.12, sx, FY + 3.5, FZ), COL.gold);
    for (const t of [-1, 1]) {
      P.add('deco', bx(0.2, 3.4, 0.12, sx + t * 1.2, FY + 1.7, FZ), COL.gold);
      P.add('atlas', plane(0.42, 2.9, AT_COUPLET(t > 0 ? 2 : 3), sx + t * 1.6, FY + 1.85, FZ));
    }
    // 石雕窗
    P.add('deco', bx(2.4, 2.4, 0.1, s * 10.65, FY + 2.6, FZ - 0.02), COL.stone);
    P.add('atlas', plane(2.0, 2.0, AT_WINDOW, s * 10.65, FY + 2.6, FZ + 0.04));
  }
  P.add('deco', bx(3.4, 1.2, 0.2, 0, 5.6, FZ + 0.05), COL.gold);
  P.add('atlas', plane(3.0, 1.0, AT_PLAQUE, 0, 5.6, FZ + 0.16));
  // 殿前的小香爐（冒煙點）
  P.add('red', bx(1.2, 0.8, 0.6, 0, FY + 0.4, -3.4));
  P.add('deco', new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.22, 0.02), new THREE.Vector2(0.3, 0.14), new THREE.Vector2(0.28, 0.3), new THREE.Vector2(0.32, 0.34), new THREE.Vector2(0.25, 0.34)], lo ? 8 : 12).translate(0, FY + 0.8, -3.4), COL.bronze);
  P.add('glow', new THREE.CircleGeometry(0.24, 10).rotateX(-Math.PI / 2).translate(0, FY + 1.1, -3.4), COL.ember);

  // ---- 三川殿屋頂：中間一段較高（三川脊），兩側較低，都是燕尾脊 ----
  const mid = gableRoof(P, { xc: 0, hr: 4.6, zF: -1.0, zR: -7.2, zB: -13.4, yE: 7.0, yR: 11.6, lift: 0.9, tails: [-1, 1], edges: [-1, 1], ledF: true }, lo);
  for (const s of [-1, 1]) {
    P.add('red', gableWall(mid.front, mid.back, s * 4.6, WT, WZ, WZ - 8.2, lo ? 4 : 8));
    const side = gableRoof(P, { xc: s * 9.35, hr: 4.15, zF: -1.3, zR: -7.2, zB: -13.4, yE: 6.9, yR: 10.2, lift: 0.8, tails: [s], edges: [s], ledF: true }, lo);
    P.add('red', gableWall(side.front, side.back, s * 13.5, WT, WZ, WZ - 8.2, lo ? 4 : 8));
    // 山牆上的懸魚
    P.add('deco', bx(0.12, 0.9, 0.7, s * 13.56, 9.0, -7.2), COL.gold);
  }
  pagoda(P, 0, 11.6 + 0.45, -7.2, 1.3);

  // ---- 正殿（後方）：牆身、四面腰簷、上層牆、重簷的上層屋頂 ----
  const HZ = -19.4;
  P.add('red', bx(26, 9.0 - FY, 8.0, 0, (FY + 9.0) / 2, HZ));
  skirt(P, 0, HZ, 13, 4, 2.0, 9.02, 8.0, 0.6, lo);
  P.add('red', bx(21, 2.6, 5.2, 0, 9.0 + 1.3, HZ));
  for (let k = 0; k < 4; k++) {
    const x = -10.5 + 2.625 + k * 5.25;
    P.add('atlas', plane(5.0, 0.45, AT_BAND, x, 11.25, HZ + 2.62));
    P.add('atlas', plane(1.4, 1.4, AT_WINDOW, x, 10.1, HZ + 2.62));
  }
  const top = gableRoof(P, { xc: 0, hr: 10.5, zF: -14.9, zR: HZ, zB: -23.9, yE: 11.4, yR: 14.3, lift: 1.0, tails: [-1, 1], edges: [-1, 1], ledF: true }, lo);
  for (const s of [-1, 1]) {
    P.add('red', gableWall(top.front, top.back, s * 10.5, 11.6, HZ + 2.6, HZ - 2.6, lo ? 3 : 6));
    P.add('deco', bx(0.12, 0.8, 0.6, s * 10.56, 13.2, HZ), COL.gold);
  }
  // 屋脊上的雙龍搶珠
  const ry = 14.3 + 0.45;
  dragon(P, -4.6, -0.75, ry, HZ, 1.25, lo);
  dragon(P, 4.6, 0.75, ry, HZ, 1.25, lo);
  pearl(P, 0, ry + 0.85, HZ, 1.3, lo);

  // ---- 簷下的大紅燈籠 ----
  for (const x of [-10.65, -5.9, -2.45, 2.45, 5.9, 10.65]) lantern(P, x, CT - 0.02, CZ, Math.abs(x) < 3 ? 0.46 : 0.5, lo);

  const group = new THREE.Group();
  group.name = 'temple';
  P.build(group, (k) => (k === 'sign' ? M.atlas : M[k]), o.shadows, ['red', 'tile', 'deco']);
  return { group, smoke: [V(0, FY + 1.3, -3.4)], update: flicker };
}

// ---------- 牌樓 ----------

/** 牌樓（廟口的門樓）：四柱三間，中間開口 span 公尺（兩根中柱的中心距，約 28），兩側各一個小開口；原點在中間開口正下方地面，橫樑沿 X，兩面都好看；高約 11~12 m */
export function buildPaifang(span: number, o: TempleOpts, title = '廟口夜市'): THREE.Group {
  const M = mats(), P = new Parts(), lo = o.lowDetail;
  const seg = lo ? 8 : 14;
  const H = span / 2, SW = 5;
  // ---- 中柱：石座、抱鼓石、金箍、前後兩面對聯 ----
  for (const s of [-1, 1]) {
    const x = s * H;
    P.add('deco', cyl(0.57, 0.58, 0.7, seg, x, 0, 0), COL.stone);
    P.add('red', cyl(0.42, 0.42, 8.4, seg, x, 0.6, 0));
    for (const y of [5.3, 8.75]) P.add('deco', cyl(0.46, 0.46, 0.18, seg, x, y, 0), COL.gold);
    for (const z of [-1, 1]) {
      P.add('deco', bx(0.42, 0.7, 1.0, x, 0.35, z * 0.95), COL.stone);
      P.add('deco', new THREE.CylinderGeometry(0.42, 0.42, 0.34, seg).rotateZ(Math.PI / 2).translate(x, 1.1, z * 1.05), COL.stoneLight);
    }
    P.add('sign', plane(0.5, 3.9, GT_COUPLET(s > 0 ? 0 : 1), x, 3.2, 0.44));
    P.add('sign', plane(0.5, 3.9, GT_COUPLET(s > 0 ? 3 : 2), x, 3.2, -0.44, Math.PI));
    // 邊柱
    const xs = s * (H + SW);
    P.add('deco', cyl(0.48, 0.5, 0.6, seg, xs, 0, 0), COL.stone);
    P.add('red', cyl(0.36, 0.36, 6.3, seg, xs, 0.5, 0));
    P.add('deco', cyl(0.4, 0.4, 0.16, seg, xs, 4.0, 0), COL.gold);
  }
  // ---- 中間開口：下樑、匾額板、上樑、斗栱、屋頂 ----
  P.add('red', bx(span, 0.5, 0.6, 0, 6.15, 0));
  for (const sz of [-1, 1]) P.add('deco', bx(span - 0.9, 0.06, 0.02, 0, 6.15, sz * 0.31), COL.gold);
  P.add('red', bx(span, 1.6, 0.3, 0, 7.2, 0));
  P.add('deco', bx(7.6, 2.05, 0.36, 0, 7.2, 0), COL.gold);
  P.add('sign', plane(7.2, 1.8, GT_TITLE, 0, 7.2, 0.185));
  P.add('sign', plane(7.2, 1.8, GT_TITLE, 0, 7.2, -0.185, Math.PI));
  P.add('red', bx(span + 0.4, 0.6, 0.7, 0, 8.3, 0));
  if (!lo) for (let x = -H + 0.7, k = 0; x <= H - 0.69; x += 1.4, k++) P.add('deco', bx(0.5, 0.35, 0.9, x, 8.77, 0), k % 2 ? COL.green : COL.gold);
  gableRoof(P, { xc: 0, hr: H + 0.3, zF: 1.9, zR: 0, zB: -1.9, yE: 8.95, yR: 10.3, lift: 0.6, oh: [0.5, 1.2], sc: 0.75, tails: [-1, 1], edges: [-1, 1], ledF: true, ledB: true }, lo);
  const ry = 10.3 + 0.35;
  dragon(P, -3.8, -0.7, ry, 0, 0.6, lo);
  dragon(P, 3.8, 0.7, ry, 0, 0.6, lo);
  pearl(P, 0, ry + 0.45, 0, 0.7, lo);
  // ---- 兩側小開口 ----
  for (const s of [-1, 1]) {
    const xm = s * (H + SW / 2);
    P.add('red', bx(SW, 0.4, 0.5, xm, 4.7, 0));
    P.add('red', bx(SW, 0.9, 0.26, xm, 5.35, 0));
    P.add('deco', bx(3.5, 1.15, 0.32, xm, 5.35, 0), COL.gold);
    P.add('sign', plane(3.2, 0.96, GT_SIDE(s > 0 ? 0 : 1), xm, 5.35, 0.165));
    P.add('sign', plane(3.2, 0.96, GT_SIDE(s > 0 ? 1 : 0), xm, 5.35, -0.165, Math.PI));
    P.add('red', bx(SW, 0.45, 0.6, xm, 6.02, 0));
    gableRoof(P, { xc: s * (H + SW / 2 + 0.1), hr: SW / 2 - 0.2, zF: 1.5, zR: 0, zB: -1.5, yE: 6.45, yR: 7.6, lift: 0.45, oh: [0.4, 1.0], sc: 0.6, tails: [s], edges: [s], ledF: true, ledB: true }, lo);
    lantern(P, xm, 4.5, 0, 0.42, lo, 0.25);
  }
  // （中間開口的下樑不吊燈籠：賽車的鏡頭高度約 4.5 公尺，會直接穿過去）

  const group = new THREE.Group();
  group.name = 'paifang';
  const sign = gateMat(title);
  P.build(group, (k) => (k === 'sign' ? sign : M[k]), o.shadows, ['red', 'tile', 'deco']);
  return group;
}

// ---------- 香爐 ----------

/** 香爐：銅色大香爐放在石座上，高約 2.4 m，原點在底部中心；smoke = 冒煙點（區域座標） */
export function buildIncenseBurner(o: TempleOpts): { group: THREE.Group; smoke: THREE.Vector3 } {
  const P = new Parts(), lo = o.lowDetail;
  const seg = lo ? 10 : 18;
  // 石座
  P.add('deco', bx(1.7, 0.5, 1.7, 0, 0.25, 0), COL.stone);
  P.add('deco', bx(1.45, 0.25, 1.45, 0, 0.625, 0), COL.stoneLight);
  // 三足
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + Math.PI / 2;
    P.add('deco', cyl(0.1, 0.15, 0.4, 6, Math.cos(a) * 0.52, 0.75, Math.sin(a) * 0.52), COL.bronze);
    P.add('deco', new THREE.SphereGeometry(0.15, 8, 6).translate(Math.cos(a) * 0.54, 0.8, Math.sin(a) * 0.54), COL.gold);
  }
  // 爐身（旋轉體：圓肚、束頸、外翻的口沿，再往內收成爐膛）
  const prof = [[0, 1.05], [0.5, 1.06], [0.78, 1.18], [0.92, 1.42], [0.9, 1.68], [0.76, 1.86], [0.72, 1.94], [0.86, 1.98], [0.88, 2.06], [0.74, 2.08], [0.66, 1.98], [0.6, 1.8]].map(([r, y]) => new THREE.Vector2(r, y));
  P.add('deco', new THREE.LatheGeometry(prof, seg), COL.bronze);
  P.add('deco', cyl(0.935, 0.935, 0.06, seg, 0, 1.39, 0), COL.gold);
  // 兩隻爐耳
  for (const s of [-1, 1]) {
    for (const z of [-0.18, 0.18]) P.add('deco', bx(0.08, 0.38, 0.08, s * 0.82, 2.23, z), COL.bronze);
    P.add('deco', bx(0.09, 0.09, 0.46, s * 0.82, 2.44, 0), COL.gold);
  }
  // 爐膛裡的香灰與炭火、插著的香
  P.add('glow', new THREE.CircleGeometry(0.62, seg).rotateX(-Math.PI / 2).translate(0, 1.84, 0), COL.ember);
  const sticks = lo ? 4 : 9;
  for (let k = 0; k < sticks; k++) {
    const a = k * 2.4, r = 0.12 + (k % 3) * 0.13;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, tilt = (k % 2 ? 1 : -1) * 0.08;
    P.add('deco', bx(0.025, 0.5, 0.025, x, 2.09, z, 0, tilt), COL.stick);
    P.add('glow', bx(0.04, 0.05, 0.04, x - Math.sin(tilt) * 0.25, 2.35, z), COL.ember);
  }
  const group = new THREE.Group();
  group.name = 'incense-burner';
  P.build(group, (k) => mats()[k === 'sign' ? 'atlas' : k], o.shadows, ['deco']);
  return { group, smoke: V(0, 2.3, 0) };
}

// ---------- 神轎 ----------

/** 神轎：寬約 1.4 m、高約 2.3 m，含兩根約 4.6 m 長的轎槓（沿 Z），原點在底部中心 */
export function buildPalanquin(o: TempleOpts): THREE.Group {
  const P = new Parts(), lo = o.lowDetail;
  // 轎凳
  for (const z of [-1.55, 1.55]) {
    P.add('deco', bx(1.6, 0.08, 0.42, 0, 0.5, z), COL.red);
    for (const x of [-0.7, 0.7]) P.add('deco', bx(0.08, 0.46, 0.36, x, 0.23, z), COL.deepRed);
  }
  // 轎槓
  for (const x of [-0.62, 0.62]) {
    P.add('deco', bx(0.12, 0.14, 4.6, x, 0.61, 0), COL.wood);
    for (const z of [-2.3, 2.3]) P.add('deco', bx(0.15, 0.17, 0.1, x, 0.61, z), COL.gold);
  }
  // 底座與轎身
  P.add('deco', bx(1.3, 0.28, 1.3, 0, 0.82, 0), COL.gold);
  P.add('deco', bx(1.12, 0.95, 1.12, 0, 1.435, 0), COL.red);
  for (const x of [-0.6, 0.6]) for (const z of [-0.6, 0.6]) P.add('deco', bx(0.09, 1.05, 0.09, x, 1.48, z), COL.gold);
  // 雕花側板（左、右、後）
  P.add('atlas', plane(0.9, 0.72, AT_PANEL, 0.565, 1.45, 0, Math.PI / 2));
  P.add('atlas', plane(0.9, 0.72, AT_PANEL, -0.565, 1.45, 0, -Math.PI / 2));
  P.add('atlas', plane(0.9, 0.72, AT_PANEL, 0, 1.45, -0.565, Math.PI));
  // 正面：轎門裡的金身、上方紅色門簾
  P.add('deco', bx(0.8, 0.8, 0.02, 0, 1.43, 0.565), COL.dark);
  P.add('deco', bx(0.24, 0.36, 0.08, 0, 1.25, 0.61), COL.gold);
  P.add('deco', new THREE.SphereGeometry(0.09, 8, 6).translate(0, 1.5, 0.61), COL.gold);
  P.add('deco', bx(0.86, 0.14, 0.04, 0, 1.78, 0.6), COL.red);
  // 金頂：小小的兩坡頂，翼角起翹
  gableRoof(P, { xc: 0, hr: 0.5, zF: 0.86, zR: 0, zB: -0.86, yE: 1.92, yR: 2.1, lift: 0.14, oh: [0.12, 0.3], sc: 0.25, tileCol: COL.gold, ridgeCol: COL.red, edges: lo ? [] : [-1, 1] }, true);
  P.add('deco', new THREE.SphereGeometry(0.075, 8, 6).translate(0, 2.27, 0), COL.gold);
  P.add('deco', new THREE.SphereGeometry(0.05, 8, 6).translate(0, 2.36, 0), COL.gold);
  // 四角的流蘇
  for (const x of [-0.68, 0.68]) for (const z of [-0.8, 0.8]) P.add('deco', bx(0.04, 0.22, 0.04, x, 1.76, z), x * z > 0 ? COL.red : COL.gold);
  const group = new THREE.Group();
  group.name = 'palanquin';
  P.build(group, (k) => mats()[k === 'sign' ? 'atlas' : k], o.shadows, ['deco']);
  return group;
}
