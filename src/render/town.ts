import * as THREE from 'three';
import { TRAIN } from '../game/race';
import type { Branch, Track } from '../game/track';
import { mulberry32 } from '../game/util';
import { loadSettings } from '../settings';
import { runoffPad } from './runoff';
import { buildIncenseBurner, buildPaifang, buildPalanquin, buildTemple } from './temple';

// 鐵道兩端的車站雨棚要把開進去的火車整台遮住（火車中心最遠開到 TRAIN.reach）
const STATION_FROM = TRAIN.reach - TRAIN.half - 3;

/**
 * 廟口夜市的小鎮造景（取代一般城市的散布大樓）：
 * - 街道兩旁的透天厝：騎樓（柱子、日光燈、店面）、磁磚外牆、鐵窗、冷氣、直立招牌、屋頂的鐵皮屋與水塔
 * - 夜市街：攤車（招牌、燈泡、蒸氣）、橫越馬路的紅燈籠串、人潮、停滿路邊的機車
 * - 廟口：牌樓、廟（src/render/temple.ts）、香爐、神轎、廟埕
 * - 夜市小巷（捷徑）兩旁的攤販與燈籠、巷子裡的障礙物（攤車、垃圾桶、機車）
 * - 平交道的鐵道、小車站；電線桿與亂牽的電線；便利商店、檳榔攤
 * - 河堤外的河、對岸山坡上的燈火、遠方的橋、天燈
 *
 * 靜態的東西全部依「區塊 × 材質」合併成少數幾個網格（每個區塊可以被視錐剔除）；
 * 燈籠、人、機車、燈泡這些大量重複的用 InstancedMesh / Points。夜景靠自發光材質，沒有真的燈。
 */

const TOWN_TRACKS = new Set(['temple-night']);
export const hasTown = (trackId: string): boolean => TOWN_TRACKS.has(trackId);

export interface TownCtx {
  track: Track;
  terrainH(x: number, z: number): number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  shadows: boolean;
  lowDetail: boolean;
}

export interface Town {
  group: THREE.Group;
  update(dt: number, time: number, camera: THREE.Camera): void;
}

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif';
const TAU = Math.PI * 2;

/** 畫質分級：0 = 低畫質／手機中畫質，1 = 電腦中畫質，2 = 高畫質 */
function detailTier(lowDetail: boolean): 0 | 1 | 2 {
  if (lowDetail) return 0;
  try {
    return loadSettings(window.matchMedia('(pointer: coarse)').matches).quality === 'high' ? 2 : 1;
  } catch {
    return 2;
  }
}

// =====================================================================
// 幾何累加器：直接往陣列裡塞四邊形、方塊、圓柱，最後一次做成 BufferGeometry
// =====================================================================
type RGB = [number, number, number];
type V3 = [number, number, number];

export class Geo {
  p: number[] = [];
  n: number[] = [];
  u: number[] = [];
  c: number[] = [];
  i: number[] = [];
  get empty(): boolean { return this.i.length === 0; }
  /** 四邊形 a→b→c→d（從正面看逆時針：左下、右下、右上、左上）；want = 想要的法線方向，反了就自動翻面 */
  quad(a: V3, b: V3, c: V3, d: V3, uv: [number, number, number, number], col: RGB, want?: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    let [u0, v0, u1, v1] = uv;
    if (want && nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      // 翻面：左右對調（貼圖也跟著左右對調，從正面看才不會反）
      [a, b, c, d] = [b, a, d, c];
      nx = -nx; ny = -ny; nz = -nz;
      [u0, u1] = [u1, u0];
    }
    const base = this.p.length / 3;
    this.p.push(...a, ...b, ...c, ...d);
    for (let k = 0; k < 4; k++) { this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); }
    this.u.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /**
   * 方塊：底面中心 (x, y0, z)，ax/az = 「寬」方向的單位向量（深的方向是它的垂直），
   * 寬 w、深 d、高 h；bottom = false 不畫底面
   */
  box(x: number, y0: number, z: number, ax: number, az: number, w: number, d: number, h: number, col: RGB, top = true): void {
    const ox = -az, oz = ax;
    const hw = w / 2, hd = d / 2, y1 = y0 + h;
    const P = (s: number, t: number, y: number): V3 => [x + ax * s + ox * t, y, z + az * s + oz * t];
    const uv: [number, number, number, number] = [0, 0, 1, 1];
    this.quad(P(-hw, -hd, y0), P(hw, -hd, y0), P(hw, -hd, y1), P(-hw, -hd, y1), uv, col, [-ox, 0, -oz]);
    this.quad(P(hw, hd, y0), P(-hw, hd, y0), P(-hw, hd, y1), P(hw, hd, y1), uv, col, [ox, 0, oz]);
    this.quad(P(-hw, hd, y0), P(-hw, -hd, y0), P(-hw, -hd, y1), P(-hw, hd, y1), uv, col, [-ax, 0, -az]);
    this.quad(P(hw, -hd, y0), P(hw, hd, y0), P(hw, hd, y1), P(hw, -hd, y1), uv, col, [ax, 0, az]);
    if (top) this.quad(P(-hw, -hd, y1), P(hw, -hd, y1), P(hw, hd, y1), P(-hw, hd, y1), uv, col, [0, 1, 0]);
  }
  /** 直立圓柱（側面 + 頂面） */
  cyl(x: number, y0: number, z: number, r: number, h: number, seg: number, col: RGB, top = true, r1 = r): void {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad([x + c0 * r, y0, z + s0 * r], [x + c1 * r, y0, z + s1 * r], [x + c1 * r1, y0 + h, z + s1 * r1], [x + c0 * r1, y0 + h, z + s0 * r1], [0, 0, 1, 1], col, [(c0 + c1) / 2, 0, (s0 + s1) / 2]);
      if (top) {
        const base = this.p.length / 3;
        this.p.push(x, y0 + h, z, x + c1 * r1, y0 + h, z + s1 * r1, x + c0 * r1, y0 + h, z + s0 * r1);
        for (let q = 0; q < 3; q++) { this.n.push(0, 1, 0); this.c.push(col[0], col[1], col[2]); this.u.push(0.5, 0.5); }
        this.i.push(base, base + 1, base + 2);
      }
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const hex = (h: number, k = 1): RGB => [((h >> 16) & 255) / 255 * k, ((h >> 8) & 255) / 255 * k, (h & 255) / 255 * k];

// =====================================================================
// 貼圖
// =====================================================================
function canvas(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
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

/** 外牆的樣式：0 白色馬賽克磁磚、1 米色二丁掛、2 灰色老公寓、3 紅磚老街屋 */
const STYLE_COUNT = 4;
const STYLE_CAP: RGB[] = [hex(0xd9d4c8), hex(0xb89a7a), hex(0x8f8c88), hex(0xa4553a)];

/**
 * 外牆貼圖：4 開間 × 4 層樓（16 m × 12.8 m），每格窗戶隨機亮燈（暖黃、冷白、電視的藍光）、有鐵窗與冷氣。
 * 回傳顏色貼圖與自發光貼圖（只有亮著的窗戶）
 */
function facadeTex(style: number, seed: number): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const r = mulberry32(seed);
  const wins: { x: number; y: number; w: number; h: number; lit: string | null; arch: boolean; grille: boolean; ac: boolean }[] = [];
  for (let f = 0; f < 4; f++) for (let b = 0; b < 4; b++) {
    const k = r();
    const lit = k < 0.36 ? null : k < 0.7 ? '#ffcf7a' : k < 0.82 ? '#ffe9c4' : k < 0.9 ? '#cfe6ff' : k < 0.96 ? '#ff9a5a' : '#6f9cff';
    const arch = style === 3;
    wins.push({ x: b * 128 + (arch ? 30 : 18), y: f * 128 + (arch ? 26 : 24), w: arch ? 68 : 92, h: arch ? 80 : 70, lit, arch, grille: style !== 3 && r() < 0.6, ac: style !== 3 && r() < 0.35 });
  }
  const winPath = (c: CanvasRenderingContext2D, wdw: (typeof wins)[number]) => {
    c.beginPath();
    if (wdw.arch) {
      const rr = wdw.w / 2;
      c.moveTo(wdw.x, wdw.y + wdw.h);
      c.lineTo(wdw.x, wdw.y + rr);
      c.arc(wdw.x + rr, wdw.y + rr, rr, Math.PI, 0);
      c.lineTo(wdw.x + wdw.w, wdw.y + wdw.h);
      c.closePath();
    } else c.rect(wdw.x, wdw.y, wdw.w, wdw.h);
  };
  const map = canvas(512, 512, (c) => {
    // 牆面
    const base = ['#d6d1c4', '#b79877', '#8d8a85', '#a5533a'][style];
    c.fillStyle = base;
    c.fillRect(0, 0, 512, 512);
    if (style === 0) {
      // 小磁磚的格線
      c.fillStyle = 'rgba(0,0,0,0.06)';
      for (let x = 0; x < 512; x += 6) c.fillRect(x, 0, 1, 512);
      for (let y = 0; y < 512; y += 6) c.fillRect(0, y, 512, 1);
    } else if (style === 1 || style === 3) {
      // 二丁掛／紅磚：交錯的長條磚
      c.fillStyle = style === 1 ? 'rgba(70,40,20,0.18)' : 'rgba(40,10,5,0.28)';
      for (let y = 0; y < 512; y += 8) {
        c.fillRect(0, y, 512, 1);
        for (let x = (y / 8) % 2 ? 0 : 12; x < 512; x += 24) c.fillRect(x, y, 1, 8);
      }
      for (let i = 0; i < 300; i++) {
        c.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
        c.fillRect(r() * 512, r() * 512, 24, 7);
      }
    }
    // 雨水留下的黑色水痕
    for (let i = 0; i < 26; i++) {
      const x = r() * 512, y = r() * 512, h = 30 + r() * 120;
      const g = c.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, `rgba(30,25,20,${style === 2 ? 0.35 : 0.16})`);
      g.addColorStop(1, 'rgba(30,25,20,0)');
      c.fillStyle = g;
      c.fillRect(x, y, 4 + r() * 10, h);
    }
    // 樓層之間的橫帶
    c.fillStyle = style === 3 ? '#e8e0d0' : 'rgba(0,0,0,0.12)';
    for (let f = 0; f < 4; f++) c.fillRect(0, f * 128 + 118, 512, style === 3 ? 6 : 3);
    for (const wdw of wins) {
      // 窗框、玻璃（亮的窗戶有窗簾的暖色、暗的是深藍灰）
      c.fillStyle = style === 3 ? '#f2ebdd' : '#9aa0a6';
      c.fillRect(wdw.x - 4, wdw.y - 4, wdw.w + 8, wdw.h + 8);
      winPath(c, wdw);
      c.fillStyle = wdw.lit ?? '#1c2230';
      c.fill();
      if (wdw.lit) {
        c.fillStyle = 'rgba(120,60,20,0.25)';
        c.fillRect(wdw.x, wdw.y, wdw.w * 0.28, wdw.h);
        c.fillRect(wdw.x + wdw.w * 0.72, wdw.y, wdw.w * 0.28, wdw.h);
      } else {
        c.fillStyle = 'rgba(120,150,190,0.18)';
        c.fillRect(wdw.x + 6, wdw.y + 6, wdw.w * 0.35, wdw.h * 0.4);
      }
      // 窗格
      c.fillStyle = 'rgba(60,64,70,0.9)';
      c.fillRect(wdw.x + wdw.w / 2 - 2, wdw.y, 4, wdw.h);
      if (wdw.grille) {
        // 鐵窗：外凸的鐵條與上面的小雨遮
        c.fillStyle = 'rgba(40,44,48,0.85)';
        for (let x = wdw.x - 6; x <= wdw.x + wdw.w + 6; x += 9) c.fillRect(x, wdw.y - 8, 2, wdw.h + 14);
        c.fillRect(wdw.x - 8, wdw.y + wdw.h * 0.5, wdw.w + 16, 2);
        c.fillStyle = '#6d7680';
        c.fillRect(wdw.x - 10, wdw.y - 14, wdw.w + 20, 8);
      }
      if (wdw.ac) {
        c.fillStyle = '#e4e4e0';
        c.fillRect(wdw.x + wdw.w - 30, wdw.y + wdw.h + 6, 34, 20);
        c.fillStyle = '#9a9a96';
        for (let x = wdw.x + wdw.w - 27; x < wdw.x + wdw.w + 2; x += 5) c.fillRect(x, wdw.y + wdw.h + 9, 2, 14);
      }
    }
  });
  const glow = canvas(512, 512, (c) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, 512, 512);
    for (const wdw of wins) {
      if (!wdw.lit) continue;
      winPath(c, wdw);
      c.fillStyle = wdw.lit;
      c.globalAlpha = 0.85;
      c.fill();
      c.globalAlpha = 1;
      c.fillStyle = '#000';
      c.fillRect(wdw.x + wdw.w / 2 - 2, wdw.y, 4, wdw.h);
      if (wdw.grille) for (let x = wdw.x - 6; x <= wdw.x + wdw.w + 6; x += 9) c.fillRect(x, wdw.y - 8, 2, wdw.h + 14);
    }
  });
  return { map, glow };
}

/** 騎樓裡的店面：8 間（每間 4 m 寬）：雜貨店、鐵捲門、小吃店、飲料店、機車行、藥局…… */
function shopTex(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const r = mulberry32(31);
  const kinds = [0, 1, 2, 3, 4, 5, 6, 7];
  const draw = (c: CanvasRenderingContext2D, glow: boolean) => {
    c.fillStyle = glow ? '#000' : '#2a2624';
    c.fillRect(0, 0, 1024, 128);
    kinds.forEach((k, i) => {
      const x0 = i * 128;
      const lit = k !== 1 && k !== 7;
      if (k === 1 || k === 7) {
        // 鐵捲門（7 = 拉起一半，底下透出燈光）
        const top = k === 7 ? 70 : 128;
        if (!glow) {
          c.fillStyle = '#7d8086';
          c.fillRect(x0 + 6, 8, 116, top - 8);
          c.fillStyle = 'rgba(0,0,0,0.25)';
          for (let y = 12; y < top; y += 5) c.fillRect(x0 + 6, y, 116, 1);
          c.fillStyle = 'rgba(255,255,255,0.12)';
          c.fillRect(x0 + 20 + r() * 50, 30, 30, 20);
        }
        if (k === 7) {
          c.fillStyle = glow ? '#ffd8a0' : '#ffe2b0';
          c.fillRect(x0 + 6, top, 116, 128 - top);
          if (!glow) {
            c.fillStyle = '#6a4a30';
            c.fillRect(x0 + 18, top + 22, 40, 36);
          }
        }
        return;
      }
      const bg = ['#ffe6bd', '', '#ffd9a8', '#f4fbff', '#fff1cf', '#e6b878', '#f2fff4', ''][k];
      c.fillStyle = glow ? bg : bg;
      c.fillRect(x0 + 6, 8, 116, 120);
      if (glow) {
        // 自發光：店裡整片亮，但貨架與人擋住的地方暗一點
        c.fillStyle = 'rgba(0,0,0,0.45)';
        c.fillRect(x0 + 10, 70, 108, 58);
        return;
      }
      if (k === 0 || k === 6) {
        // 貨架
        for (let y = 24; y < 110; y += 22) {
          c.fillStyle = '#8a7a6a';
          c.fillRect(x0 + 10, y + 16, 108, 3);
          for (let x = x0 + 12; x < x0 + 116; x += 7) {
            c.fillStyle = ['#e8443a', '#3a8ae8', '#f2c230', '#44b06a', '#ffffff', '#e87a3a'][Math.floor(r() * 6)];
            c.fillRect(x, y + 4 + r() * 4, 5, 12 - r() * 3);
          }
        }
        if (k === 6) {
          c.fillStyle = '#18a050';
          c.fillRect(x0 + 52, 12, 24, 8);
          c.fillRect(x0 + 60, 4, 8, 24);
        }
      } else if (k === 2) {
        // 小吃店：桌椅、牆上的菜單、紅燈籠
        c.fillStyle = '#fff';
        c.fillRect(x0 + 14, 16, 100, 26);
        c.fillStyle = '#c0281e';
        for (let i2 = 0; i2 < 5; i2++) c.fillRect(x0 + 18 + i2 * 19, 20, 14, 18);
        c.fillStyle = '#b02020';
        c.beginPath(); c.arc(x0 + 12, 52, 8, 0, TAU); c.fill();
        c.beginPath(); c.arc(x0 + 116, 52, 8, 0, TAU); c.fill();
        c.fillStyle = '#c8a070';
        c.fillRect(x0 + 20, 92, 36, 6);
        c.fillRect(x0 + 72, 92, 36, 6);
        c.fillStyle = '#e04030';
        for (const x of [24, 46, 76, 98]) c.fillRect(x0 + x, 100, 8, 22);
      } else if (k === 3 || k === 4) {
        // 飲料店：吧台、杯子、亮白色菜單燈箱
        c.fillStyle = k === 3 ? '#20c0b0' : '#e85a8a';
        c.fillRect(x0 + 10, 14, 108, 30);
        c.fillStyle = '#fff';
        for (let i2 = 0; i2 < 6; i2++) c.fillRect(x0 + 14 + i2 * 17, 20, 12, 3);
        c.fillStyle = '#d8c0a0';
        c.fillRect(x0 + 8, 84, 112, 40);
        for (let i2 = 0; i2 < 6; i2++) {
          c.fillStyle = ['#c89058', '#f0e0c0', '#8a5030'][i2 % 3];
          c.fillRect(x0 + 16 + i2 * 17, 70, 9, 14);
        }
      } else if (k === 5) {
        // 機車行：輪胎、工具牆
        c.fillStyle = '#2a2420';
        for (let i2 = 0; i2 < 4; i2++) { c.beginPath(); c.arc(x0 + 24 + i2 * 26, 40, 11, 0, TAU); c.fill(); }
        c.fillStyle = '#3a3a40';
        c.fillRect(x0 + 20, 80, 80, 40);
        c.fillStyle = '#d04040';
        c.fillRect(x0 + 30, 88, 50, 20);
      }
      // 人影
      if (lit && r() < 0.7) {
        c.fillStyle = 'rgba(40,30,30,0.85)';
        const px = x0 + 30 + r() * 60;
        c.beginPath(); c.arc(px, 64, 8, 0, TAU); c.fill();
        c.fillRect(px - 10, 72, 20, 40);
      }
    });
    // 店與店之間的牆
    c.fillStyle = glow ? '#000' : '#4a4440';
    for (let i = 0; i <= 8; i++) c.fillRect(i * 128 - 3, 0, 6, 128);
  };
  const map = canvas(1024, 128, (c) => draw(c, false));
  const glow = canvas(1024, 128, (c) => draw(c, true));
  return { map, glow };
}

// 招牌上的字（一般的店名、小吃名，沒有任何品牌）
const V_WORDS = ['滷味', '雞排', '珍珠奶茶', '臭豆腐', '蚵仔煎', '當舖', '診所', '藥局', '旅社', '理髮', '小吃', '冰店', '麵店', '茶行', '中藥行', '五金行',
  '眼鏡行', '補習班', '卡拉OK', '牙科', '水果行', '麵包店', '早餐店', '便當', '電器行', '鐘錶行', '銀樓', '彩券行', '機車行', '洗衣店', '書局', '婚紗'];
const H_WORDS = ['滷味', '雞排', '珍奶', '臭豆腐', '蚵仔煎', '大腸包小腸', '烤玉米', '地瓜球', '刨冰', '鹽酥雞', '胡椒餅', '蔥油餅', '豆花', '甘蔗汁', '魷魚羹', '米糕',
  '肉圓', '車輪餅', '烤香腸', '芒果冰', '木瓜牛奶', '牛排', '麻辣燙', '棺材板', '生煎包', '青草茶', '射氣球', '撈金魚', '彈珠台', '夾娃娃', '便利商店 24H', '檳榔'];
const SIGN_COLS: [string, string][] = [
  ['#d8231c', '#fff3a0'], ['#ffffff', '#c8151b'], ['#ffd200', '#b0120e'], ['#1d4fc4', '#ffffff'], ['#13924a', '#ffffff'], ['#ff7a00', '#ffffff'],
  ['#7a1fa0', '#ffe14d'], ['#141414', '#ff4040'], ['#fff6e0', '#1d4fc4'], ['#c8151b', '#ffffff'],
];

/** 招牌貼圖：上半部 32 個直立招牌（64×256），下半部 32 個橫招牌（256×64） */
function signAtlas(): THREE.CanvasTexture {
  return canvas(1024, 1024, (c) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, 1024, 1024);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    V_WORDS.forEach((w, i) => {
      const x = (i % 16) * 64, y = Math.floor(i / 16) * 256;
      const [bg, fg] = SIGN_COLS[(i * 3) % SIGN_COLS.length];
      c.fillStyle = bg;
      c.fillRect(x + 2, y + 2, 60, 252);
      c.strokeStyle = fg;
      c.lineWidth = 3;
      c.strokeRect(x + 6, y + 6, 52, 244);
      c.fillStyle = fg;
      const chars = [...w];
      const step = Math.min(56, 236 / chars.length);
      c.font = `bold ${Math.min(46, step * 0.9)}px ${FONT}`;
      chars.forEach((ch, k) => c.fillText(ch, x + 32, y + 128 + (k - (chars.length - 1) / 2) * step));
    });
    H_WORDS.forEach((w, i) => {
      const x = (i % 4) * 256, y = 512 + Math.floor(i / 4) * 64;
      const [bg, fg] = SIGN_COLS[(i * 7 + 1) % SIGN_COLS.length];
      c.fillStyle = bg;
      c.fillRect(x + 2, y + 2, 252, 60);
      c.fillStyle = fg;
      c.fillRect(x + 2, y + 2, 252, 4);
      c.fillRect(x + 2, y + 58, 252, 4);
      c.font = `bold ${w.length > 4 ? 34 : 42}px ${FONT}`;
      c.fillText(w, x + 128, y + 34, 236);
    });
  }, false);
}
const vSign = (i: number): [number, number, number, number] => {
  const k = i % V_WORDS.length, x = (k % 16) * 64, y = Math.floor(k / 16) * 256;
  return [x / 1024 + 0.002, 1 - (y + 256) / 1024 + 0.002, (x + 64) / 1024 - 0.002, 1 - y / 1024 - 0.002];
};
const hSign = (i: number): [number, number, number, number] => {
  const k = i % H_WORDS.length, x = (k % 4) * 256, y = 512 + Math.floor(k / 4) * 64;
  return [x / 1024 + 0.001, 1 - (y + 64) / 1024 + 0.003, (x + 256) / 1024 - 0.001, 1 - y / 1024 - 0.003];
};
const H_CONV = H_WORDS.indexOf('便利商店 24H'), H_BETEL = H_WORDS.indexOf('檳榔');
const STALL_SIGNS = H_WORDS.length - 2;

// =====================================================================
// 機車與人的模型（停在路邊的機車、騎在路上的機車共用）
// =====================================================================
/** 機車：長約 1.8 m（沿 +Z，車頭朝 +Z）、寬 0.66、高 1.15；白色的部分會被 instanceColor 染成車殼顏色 */
export function scooterGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const W: RGB = [1, 1, 1], D: RGB = [0.07, 0.07, 0.08], M: RGB = [0.55, 0.56, 0.6];
  // 輪子（上面被車殼蓋住，不畫頂面）
  for (const z of [-0.62, 0.62]) g.box(0, 0, z, 1, 0, 0.14, 0.5, 0.5, D, false);
  // 車身：踏板、後殼（座墊下）與座墊、前殼、龍頭（中間是大燈）
  g.box(0, 0.25, -0.1, 1, 0, 0.44, 0.7, 0.14, W);
  g.box(0, 0.3, -0.55, 1, 0, 0.56, 0.75, 0.45, W);
  g.box(0, 0.75, -0.5, 1, 0, 0.5, 0.82, 0.12, D);
  g.box(0, 0.25, 0.42, 1, 0, 0.5, 0.3, 0.72, W);
  g.box(0, 0.97, 0.48, 1, 0, 0.62, 0.12, 0.12, M);
  return g.build();
}
/** 騎士：坐姿，安全帽；白色部分（衣服）被 instanceColor 染色 */
export function riderGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const W: RGB = [1, 1, 1], P: RGB = [0.16, 0.18, 0.26], S: RGB = [0.86, 0.66, 0.5];
  g.box(0, 0.5, -0.05, 1, 0, 0.4, 0.42, 0.25, P);
  g.box(0, 0.82, -0.32, 1, 0, 0.44, 0.28, 0.58, W);
  g.box(0.24, 0.98, -0.05, 0, 1, 0.42, 0.1, 0.1, W);
  g.box(-0.24, 0.98, -0.05, 0, 1, 0.42, 0.1, 0.1, W);
  g.box(0, 1.4, -0.3, 1, 0, 0.22, 0.2, 0.08, S);
  return g.build();
}
/** 安全帽（另外上色） */
export function helmetGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  g.cyl(0, 1.44, -0.3, 0.17, 0.2, 8, [1, 1, 1], true, 0.13);
  return g.build();
}

/** 路邊的人：身體（衣服，白色 → instanceColor）與頭、褲子（固定顏色）分兩個網格 */
function personGeos(): { shirt: THREE.BufferGeometry; rest: THREE.BufferGeometry } {
  const a = new Geo(), b = new Geo();
  a.box(0, 0.85, 0, 1, 0, 0.44, 0.26, 0.62, [1, 1, 1]);
  b.box(0, 0, 0, 1, 0, 0.38, 0.22, 0.85, [0.18, 0.2, 0.28]);
  b.box(0, 1.47, 0, 1, 0, 0.22, 0.22, 0.24, [0.85, 0.65, 0.5]);
  b.box(0, 1.64, -0.02, 1, 0, 0.24, 0.24, 0.08, [0.08, 0.07, 0.07]);
  return { shirt: a.build(), rest: b.build() };
}

// =====================================================================
// 發光點（燈泡、對岸的燈火）：Points + 加法混色，大小隨距離縮放
// =====================================================================
function glowPoints(pos: number[], col: number[], size: number[], soft: number): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 600 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vC;
      void main() {
        vC = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.5, aSize * uScale / max(0.5, -mv.z));
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float a = exp(-r * r * ${soft.toFixed(1)}) + 0.6 * smoothstep(0.35, 0.0, r);
        gl_FragColor = vec4(vC * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  // 點的大小換算：依畫面高度與視角
  pts.onBeforeRender = (renderer, _s, camera) => {
    const cam = camera as THREE.PerspectiveCamera;
    const h = renderer.getContext().drawingBufferHeight;
    mat.uniforms.uScale.value = h / (2 * Math.tan((cam.fov * Math.PI) / 360));
  };
  return pts;
}

// =====================================================================
// 主程式
// =====================================================================
export function buildTown(ctx: TownCtx): Town {
  const { track, terrainH, shadows } = ctx;
  const tier = detailTier(ctx.lowDetail);
  const group = new THREE.Group();
  group.name = 'town';
  const S = track.samples, n = track.n, L = track.length, hw = track.halfWidth;
  const rng = mulberry32(2024);
  const wrapD = (d: number) => ((d % L) + L) % L;
  const idxAt = (d: number) => track.wrap(Math.round(wrapD(d) / track.spacing));
  /** d 是否落在 [a, b]（可以跨過起點） */
  const inR = (d: number, a: number, b: number) => wrapD(d - a) <= b - a;
  const rel = (a: number, b: number) => { let x = wrapD(a - b); if (x > L / 2) x -= L; return x; };
  const updaters: ((dt: number, time: number) => void)[] = [];
  const hazards = track.def.hazards ?? [];
  const crossings = hazards.filter((h) => h.kind === 'scooter' && !h.len).map((h) => h.dist);
  const train = hazards.find((h) => h.kind === 'tram' && h.train);
  const fireZone = hazards.find((h) => h.kind === 'firecracker');
  const gust = hazards.find((h) => h.kind === 'gust');
  const branches: Branch[] = track.branches;

  // ---------- 這條賽道的分區（距起點的公尺數） ----------
  const Z = {
    start: [-95, 200] as [number, number],
    market: [270, 572] as [number, number],
    templeR: [612, 842] as [number, number],
    plaza: [662, 812] as [number, number],
    levee: [1235, 1745] as [number, number],
    lowerR: [1745, 1990] as [number, number],
    old: [1975, 2228] as [number, number],
    marketGate: 296,
    templeGate: 651,
    temple: 737,
  };

  // ---------- 河：沿河堤的折線（兩端沿切線延長），右側（往河）是水面 ----------
  const WATER_Y = 5.0;
  const RIVER_NEAR = hw + 6, RIVER_FAR = 420;
  const riverLine: { x: number; z: number; nx: number; nz: number }[] = [];
  {
    const levee0 = Z.levee[0] + 60, levee1 = Z.levee[1] - 30, ext = 700;
    const p0 = track.pointAt(levee0), p1 = track.pointAt(levee1);
    riverLine.push({ x: p0.x - p0.tx * ext, z: p0.z - p0.tz * ext, nx: p0.nx, nz: p0.nz });
    for (let d = levee0; d <= levee1; d += 12) { const p = track.pointAt(d); riverLine.push({ x: p.x, z: p.z, nx: p.nx, nz: p.nz }); }
    riverLine.push({ x: p1.x + p1.tx * ext, z: p1.z + p1.tz * ext, nx: p1.nx, nz: p1.nz });
  }
  /** (x,z) 是不是在河面上（含岸邊 margin 公尺） */
  const inRiver = (x: number, z: number, margin = 0): boolean => {
    let best = Infinity, lat = 0;
    for (let k = 0; k < riverLine.length - 1; k++) {
      const a = riverLine[k], b = riverLine[k + 1];
      const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
      const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
      const px = a.x + ex * t, pz = a.z + ez * t, d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) { best = d; const nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t; lat = (x - px) * nx + (z - pz) * nz; }
    }
    return -lat > RIVER_NEAR - margin && -lat < RIVER_FAR + margin;
  };

  // ---------- 材質 ----------
  const facades = Array.from({ length: STYLE_COUNT }, (_, s) => facadeTex(s, 100 + s));
  const facadeMats = facades.map((f) => new THREE.MeshLambertMaterial({ map: f.map, emissiveMap: f.glow, emissive: 0xffffff, emissiveIntensity: 1.15 }));
  const shop = shopTex();
  const shopMat = new THREE.MeshLambertMaterial({ map: shop.map, emissiveMap: shop.glow, emissive: 0xffffff, emissiveIntensity: 1.2 });
  const solidMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const signTex = signAtlas();
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, color: new THREE.Color(1.25, 1.25, 1.25) });
  const walkTex = canvas(256, 256, (c) => {
    // 騎樓與人行道的地磚：紅磚與灰磚交錯
    const r = mulberry32(5);
    for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 32) {
      const k = r();
      c.fillStyle = k < 0.5 ? '#8a4a3c' : k < 0.8 ? '#6e6a66' : '#9a5a48';
      c.fillRect(x, y, 32, 32);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(x, y, 32, 2);
      c.fillRect(x, y, 2, 32);
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)';
      c.fillRect(r() * 256, r() * 256, 2, 2);
    }
  });
  const walkMat = new THREE.MeshLambertMaterial({ map: walkTex });
  const MATS = { f0: facadeMats[0], f1: facadeMats[1], f2: facadeMats[2], f3: facadeMats[3], shop: shopMat, solid: solidMat, glow: glowMat, sign: signMat, walk: walkMat };
  type MatKey = keyof typeof MATS;
  const fKey = (s: number) => (['f0', 'f1', 'f2', 'f3'] as const)[s];

  // ---------- 依區塊合併 ----------
  // 區塊越大 draw call 越少（但視錐剔除比較粗）：手機／低畫質用大區塊
  const CELL = tier > 1 ? 200 : tier > 0 ? 250 : 340;
  const chunks = new Map<string, Map<MatKey, Geo>>();
  const geo = (x: number, z: number, k: MatKey): Geo => {
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let m = chunks.get(key);
    if (!m) chunks.set(key, (m = new Map()));
    let g = m.get(k);
    if (!g) m.set(k, (g = new Geo()));
    return g;
  };

  // ---------- 碰撞檢查：離主線（含緩衝區與屏障）、捷徑多遠 ----------
  const GRID = 24;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(S[i].x / GRID)},${Math.floor(S[i].z / GRID)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  /** 最近的主線取樣點與橫向偏移（找不到 = 很遠） */
  const nearMain = (x: number, z: number, reach = 3): { i: number; d: number; lat: number } => {
    const gx = Math.floor(x / GRID), gz = Math.floor(z / GRID);
    let best = -1, bd = Infinity;
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
      const arr = grid.get(`${gx + a},${gz + b}`);
      if (!arr) continue;
      for (const i of arr) {
        const dx = x - S[i].x, dz = z - S[i].z, d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0) return { i: -1, d: Infinity, lat: 0 };
    const s = S[best];
    return { i: best, d: Math.sqrt(bd), lat: (x - s.x) * s.nx + (z - s.z) * s.nz };
  };
  /** 主線佔用的寬度（路面 + 緩衝區 + 屏障）在某個取樣點、某一側 */
  const usedW = (i: number, sg: number) => { const w = track.runoffW(i, sg); return w > 0 ? hw + w + runoffPad(w) : hw + 1.0; };
  /** 這個點會不會壓到主線（own = 自己所屬的取樣點，附近的取樣點不算「別段路」） */
  const hitsMain = (x: number, z: number, margin: number, own = -1): boolean => {
    const m = nearMain(x, z);
    if (m.i < 0) return false;
    if (own >= 0) {
      let k = Math.abs(m.i - own);
      k = Math.min(k, n - k);
      if (k < 40 && Math.abs(m.lat) > hw) return Math.abs(m.lat) < usedW(m.i, Math.sign(m.lat)) + margin * 0.3;
    }
    return Math.abs(m.lat) < usedW(m.i, Math.sign(m.lat) || 1) + margin;
  };
  const nearBranch = (x: number, z: number): number => {
    let best = Infinity;
    for (const b of branches) {
      if (!b.inBox(x, z)) continue;
      for (const s of b.samples) best = Math.min(best, Math.hypot(x - s.x, z - s.z) - b.halfWidth);
    }
    return best;
  };
  // 鐵道：火車的軌道線（平交道兩側各延伸 170 公尺）
  const rail = train ? (() => {
    const p = track.pointAt(train.dist);
    return { x: p.x, z: p.z, y: p.y, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz, reach: 175 };
  })() : null;
  const nearRail = (x: number, z: number): number => {
    if (!rail) return Infinity;
    const dx = x - rail.x, dz = z - rail.z;
    const along = dx * rail.nx + dz * rail.nz;
    if (Math.abs(along) > rail.reach + 10) return Infinity;
    return Math.abs(dx * rail.tx + dz * rail.tz);
  };
  /** 一塊地（四角 + 中心）能不能蓋房子 */
  const footprintOk = (pts: [number, number][], margin: number, own: number, branchGap: number, railGap = 9): boolean => {
    for (const [x, z] of pts) {
      if (hitsMain(x, z, margin, own)) return false;
      if (nearBranch(x, z) < branchGap) return false;
      if (nearRail(x, z) < railGap) return false;
    }
    return true;
  };
  const occupied: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, r: number) => occupied.every((o) => (o.x - x) ** 2 + (o.z - z) ** 2 > (o.r + r) ** 2);

  // =================================================================
  // 透天厝（臨街的一排，有騎樓）
  // =================================================================
  interface House {
    fl: [number, number]; fr: [number, number]; ox: number; oz: number; depth: number; yb: number;
    floors: number; style: number; arcade: boolean; sign: number; hsign: number; leftCol: boolean; rightCol: boolean;
  }
  const ARC = 2.8, ARC_H = 3.4, FLOOR = 3.2;
  const house = (h: House) => {
    const { fl, fr, ox, oz, depth, yb, floors, style } = h;
    const ax = fr[0] - fl[0], az = fr[1] - fl[1], w = Math.hypot(ax, az);
    if (w < 1) return;
    const ux = ax / w, uz = az / w;
    const cx = (fl[0] + fr[0]) / 2 + ox * depth / 2, cz = (fl[1] + fr[1]) / 2 + oz * depth / 2;
    const top = yb + ARC_H + (floors - 1) * FLOOR;
    const y0 = yb - 4;
    const F = (p: [number, number], o: number, y: number): V3 => [p[0] + ox * o, y, p[1] + oz * o];
    const fk = fKey(style);
    const g = geo(cx, cz, fk), gs = geo(cx, cz, 'solid'), gg = geo(cx, cz, 'glow');
    const u0 = Math.floor(rng() * 4) * 0.25;
    const uw = w / 16;
    const upperY = h.arcade ? yb + ARC_H : yb;
    const vTop = (top - upperY) / 12.8;
    const vOff = h.arcade ? 0 : 0.75;
    // 正面（樓上）
    g.quad(F(fl, 0, upperY), F(fr, 0, upperY), F(fr, 0, top), F(fl, 0, top), [u0, vOff, u0 + uw, vOff + vTop], [1, 1, 1], [-ox, 0, -oz]);
    // 背面與兩側
    g.quad(F(fr, depth, y0), F(fl, depth, y0), F(fl, depth, top), F(fr, depth, top), [u0, 0, u0 + uw, (top - y0) / 12.8], [0.8, 0.8, 0.8], [ox, 0, oz]);
    const sideFrom = h.arcade ? ARC : 0;
    g.quad(F(fl, depth, y0), F(fl, sideFrom, y0), F(fl, sideFrom, top), F(fl, depth, top), [0, 0, depth / 16, (top - y0) / 12.8], [0.75, 0.75, 0.75], [-ux, 0, -uz]);
    g.quad(F(fr, sideFrom, y0), F(fr, depth, y0), F(fr, depth, top), F(fr, sideFrom, top), [0, 0, depth / 16, (top - y0) / 12.8], [0.75, 0.75, 0.75], [ux, 0, uz]);
    if (h.arcade) {
      g.quad(F(fl, 0, yb + ARC_H), F(fl, ARC, yb + ARC_H), F(fl, ARC, top), F(fl, 0, top), [0, 0, ARC / 16, (top - yb - ARC_H) / 12.8], [0.75, 0.75, 0.75], [-ux, 0, -uz]);
      g.quad(F(fr, ARC, yb + ARC_H), F(fr, 0, yb + ARC_H), F(fr, 0, top), F(fr, ARC, top), [0, 0, ARC / 16, (top - yb - ARC_H) / 12.8], [0.75, 0.75, 0.75], [ux, 0, uz]);
      // 騎樓：店面、天花板與日光燈、柱子
      const su = Math.floor(rng() * 8) / 8;
      geo(cx, cz, 'shop').quad(F(fl, ARC, yb - 0.1), F(fr, ARC, yb - 0.1), F(fr, ARC, yb + ARC_H), F(fl, ARC, yb + ARC_H), [su, 0, su + w / 32, 1], [1, 1, 1], [-ox, 0, -oz]);
      gs.quad(F(fl, ARC, yb + ARC_H), F(fr, ARC, yb + ARC_H), F(fr, 0, yb + ARC_H), F(fl, 0, yb + ARC_H), [0, 0, 1, 1], [0.2, 0.19, 0.18], [0, -1, 0]);
      const t0 = 0.15, t1 = 0.85;
      const lx0 = fl[0] + ax * t0, lz0 = fl[1] + az * t0, lx1 = fl[0] + ax * t1, lz1 = fl[1] + az * t1;
      gg.quad([lx0 + ox * 1.3, yb + ARC_H - 0.03, lz0 + oz * 1.3], [lx1 + ox * 1.3, yb + ARC_H - 0.03, lz1 + oz * 1.3], [lx1 + ox * 1.5, yb + ARC_H - 0.03, lz1 + oz * 1.5], [lx0 + ox * 1.5, yb + ARC_H - 0.03, lz0 + oz * 1.5], [0, 0, 1, 1], [1.7, 1.9, 2.0], [0, -1, 0]);
      const colC = STYLE_CAP[style];
      if (h.leftCol) gs.box(fl[0] + ux * 0.32 + ox * 0.3, yb - 0.2, fl[1] + uz * 0.32 + oz * 0.3, ux, uz, 0.6, 0.6, ARC_H + 0.2, colC, false);
      if (h.rightCol) gs.box(fr[0] - ux * 0.32 + ox * 0.3, yb - 0.2, fr[1] - uz * 0.32 + oz * 0.3, ux, uz, 0.6, 0.6, ARC_H + 0.2, colC, false);
    }
    // 女兒牆與屋頂
    const cap = STYLE_CAP[style];
    gs.quad(F(fl, -0.05, top), F(fr, -0.05, top), F(fr, -0.05, top + 0.6), F(fl, -0.05, top + 0.6), [0, 0, 1, 1], cap, [-ox, 0, -oz]);
    gs.quad(F(fl, 0, top + 0.02), F(fr, 0, top + 0.02), F(fr, depth, top + 0.02), F(fl, depth, top + 0.02), [0, 0, 1, 1], [0.22, 0.21, 0.21], [0, 1, 0]);
    // 屋頂加蓋的鐵皮屋、水塔
    if (tier > 0 || rng() < 0.5) {
      if (rng() < 0.55 && depth > 7) {
        const col = hex([0x3b6ea8, 0x4f8c5a, 0x9a5a38, 0xd2d0c8, 0x2f7f8a][Math.floor(rng() * 5)], 0.9);
        const sw = w * (0.6 + rng() * 0.35), sd = depth * (0.45 + rng() * 0.3);
        const sx = (fl[0] + fr[0]) / 2 + ox * (2 + sd / 2), sz = (fl[1] + fr[1]) / 2 + oz * (2 + sd / 2);
        gs.box(sx, top, sz, ux, uz, sw, sd, 2.4 + rng() * 0.6, col);
        // 鐵皮屋的小窗（有時亮燈）
        if (rng() < 0.5) gg.quad(F([sx - ox * sd / 2 - ux * 0.6, sz - oz * sd / 2 - uz * 0.6], -0.03, top + 0.9), F([sx - ox * sd / 2 + ux * 0.6, sz - oz * sd / 2 + uz * 0.6], -0.03, top + 0.9), F([sx - ox * sd / 2 + ux * 0.6, sz - oz * sd / 2 + uz * 0.6], -0.03, top + 1.8), F([sx - ox * sd / 2 - ux * 0.6, sz - oz * sd / 2 - uz * 0.6], -0.03, top + 1.8), [0, 0, 1, 1], [1.5, 1.15, 0.6], [-ox, 0, -oz]);
      }
      if (rng() < 0.6) {
        const tx = cx + ux * (rng() - 0.5) * w * 0.5 + ox * depth * 0.2, tz = cz + uz * (rng() - 0.5) * w * 0.5 + oz * depth * 0.2;
        gs.box(tx, top, tz, ux, uz, 1.2, 1.2, 0.8, [0.3, 0.3, 0.32], false);
        gs.cyl(tx, top + 0.8, tz, 0.62, 1.3, tier > 1 ? 10 : 7, rng() < 0.6 ? [0.78, 0.8, 0.84] : [0.24, 0.42, 0.72]);
      }
    }
    // 冷氣（外牆上凸出來的室外機）
    if (tier > 1) for (let f = 1; f < floors; f++) {
      if (rng() > 0.45) continue;
      const t = 0.2 + rng() * 0.6;
      const x = fl[0] + ax * t - ox * 0.25, z = fl[1] + az * t - oz * 0.25;
      gs.box(x, yb + ARC_H + (f - 1) * FLOOR + 0.3, z, ux, uz, 0.8, 0.45, 0.55, [0.85, 0.85, 0.82]);
    }
    // 直立招牌：從外牆往路面凸出來
    if (h.sign >= 0 && floors >= 2) {
      const sh = Math.min(6.5, top - yb - ARC_H - 0.6, 3 + rng() * 3.5);
      const sx = fl[0] + ux * 0.55 - ox * 0.85, sz = fl[1] + uz * 0.55 - oz * 0.85;
      const ys = yb + ARC_H + 0.4;
      const uv = vSign(h.sign);
      const gsn = geo(cx, cz, 'sign');
      const half = 0.85, th = 0.17;
      const P = (s: number, t: number, y: number): V3 => [sx + ux * t + ox * s, y, sz + uz * t + oz * s];
      gsn.quad(P(half, -th, ys), P(-half, -th, ys), P(-half, -th, ys + sh), P(half, -th, ys + sh), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [-ux, 0, -uz]);
      gsn.quad(P(-half, th, ys), P(half, th, ys), P(half, th, ys + sh), P(-half, th, ys + sh), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [ux, 0, uz]);
      gs.quad(P(-half, -th, ys), P(-half, th, ys), P(-half, th, ys + sh), P(-half, -th, ys + sh), [0, 0, 1, 1], [0.3, 0.3, 0.3], [-ox, 0, -oz]);
      gs.quad(P(-half, -th, ys + sh), P(half, -th, ys + sh), P(half, th, ys + sh), P(-half, th, ys + sh), [0, 0, 1, 1], [0.3, 0.3, 0.3], [0, 1, 0]);
    }
    // 騎樓上方的橫招牌
    if (h.hsign >= 0 && h.arcade) {
      const uv = hSign(h.hsign);
      const inset = Math.min(0.4, w * 0.08);
      const a0: [number, number] = [fl[0] + ux * inset, fl[1] + uz * inset], a1: [number, number] = [fr[0] - ux * inset, fr[1] - uz * inset];
      geo(cx, cz, 'sign').quad(F(a0, -0.12, yb + ARC_H + 0.1), F(a1, -0.12, yb + ARC_H + 0.1), F(a1, -0.12, yb + ARC_H + 1.0), F(a0, -0.12, yb + ARC_H + 1.0), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [-ox, 0, -oz]);
    }
  };

  /** 一般的方塊樓（後排、遠處）：每面一個四邊形，貼圖重複 */
  const block = (x: number, z: number, yaw: number, w: number, d: number, floors: number, style: number, yb: number) => {
    const ux = Math.cos(yaw), uz = Math.sin(yaw), ox = -uz, oz = ux;
    const top = yb + 0.6 + floors * FLOOR;
    const P = (s: number, t: number, y: number): V3 => [x + ux * s + ox * t, y, z + uz * s + oz * t];
    const g = geo(x, z, fKey(style)), gs = geo(x, z, 'solid');
    const v1 = (top - yb) / 12.8, u0 = Math.floor(rng() * 4) * 0.25, uo = rng() < 0.5 ? 0 : 0.5;
    const hw2 = w / 2, hd = d / 2;
    g.quad(P(-hw2, -hd, yb), P(hw2, -hd, yb), P(hw2, -hd, top), P(-hw2, -hd, top), [u0, uo, u0 + w / 16, uo + v1], [1, 1, 1], [-ox, 0, -oz]);
    g.quad(P(hw2, hd, yb), P(-hw2, hd, yb), P(-hw2, hd, top), P(hw2, hd, top), [u0, uo, u0 + w / 16, uo + v1], [0.85, 0.85, 0.85], [ox, 0, oz]);
    g.quad(P(-hw2, hd, yb), P(-hw2, -hd, yb), P(-hw2, -hd, top), P(-hw2, hd, top), [u0, uo, u0 + d / 16, uo + v1], [0.75, 0.75, 0.75], [-ux, 0, -uz]);
    g.quad(P(hw2, -hd, yb), P(hw2, hd, yb), P(hw2, hd, top), P(hw2, -hd, top), [u0, uo, u0 + d / 16, uo + v1], [0.75, 0.75, 0.75], [ux, 0, uz]);
    gs.quad(P(-hw2, -hd, top), P(hw2, -hd, top), P(hw2, hd, top), P(-hw2, hd, top), [0, 0, 1, 1], [0.2, 0.2, 0.2], [0, 1, 0]);
    if (tier > 0 && rng() < 0.5) gs.cyl(x + ux * (rng() - 0.5) * w * 0.4, top, z + uz * (rng() - 0.5) * w * 0.4, 0.7, 1.4, 7, [0.78, 0.8, 0.84]);
    if (tier > 0 && rng() < 0.4) gs.box(x + ox * d * 0.15, top, z + oz * d * 0.15, ux, uz, w * 0.6, d * 0.5, 2.5, hex([0x3b6ea8, 0x4f8c5a, 0x9a5a38, 0xd2d0c8][Math.floor(rng() * 4)], 0.85));
    // 高樓頂上的發光招牌
    if (floors >= 8 && rng() < 0.6) {
      const uv = vSign(Math.floor(rng() * V_WORDS.length));
      const sx = x - ox * (hd + 0.1), sz = z - oz * (hd + 0.1);
      geo(x, z, 'sign').quad([sx - ux * 1.2, top - 7, sz - uz * 1.2], [sx + ux * 1.2, top - 7, sz + uz * 1.2], [sx + ux * 1.2, top - 0.5, sz + uz * 1.2], [sx - ux * 1.2, top - 0.5, sz - uz * 1.2], [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [-ox, 0, -oz]);
    }
  };

  // ---------- 臨街的透天厝：沿主線兩側一間一間排 ----------
  interface ZoneOpt { walk: number; floors: [number, number]; styles: number[]; arcade: boolean; depth: [number, number] }
  const zoneAt = (d: number, sg: number): ZoneOpt | null => {
    if (inR(d, Z.start[0], Z.start[1])) return { walk: 30, floors: [3, 6], styles: [0, 1, 2], arcade: true, depth: [10, 14] };
    if (inR(d, Z.market[0], Z.market[1])) return { walk: 5.6, floors: [3, 4], styles: [0, 1, 0, 2], arcade: true, depth: [11, 14] };
    if (sg < 0 && inR(d, Z.templeR[0], Z.templeR[1])) return null;
    if (inR(d, Z.levee[0], Z.levee[1])) return null;
    if (sg < 0 && inR(d, Z.lowerR[0], Z.lowerR[1])) return null;
    if (inR(d, Z.old[0], Z.old[1])) return { walk: 2.4, floors: [2, 3], styles: [3], arcade: true, depth: [11, 14] };
    return { walk: 3.2, floors: [3, 5], styles: [0, 1, 2, 2], arcade: true, depth: [10, 14] };
  };
  // 每個取樣點、每一側的人行道外緣（給人行道地磚、攤販、機車用）：0 = 這裡沒有臨街的房子
  const walkIn = { 1: new Float32Array(n), [-1]: new Float32Array(n) } as Record<number, Float32Array>;
  const walkOut = { 1: new Float32Array(n), [-1]: new Float32Array(n) } as Record<number, Float32Array>;
  const fronts: { d: number; sg: number; w: number; front: number; zone: ZoneOpt; floors: number }[] = [];
  const frontLat = (d: number, sg: number) => {
    let u = 0;
    for (let k = -3; k <= 3; k++) u = Math.max(u, usedW(idxAt(d + k * 1.5), sg));
    return u;
  };
  for (const sg of [1, -1]) {
    let d = -90;
    let prevOk = false;
    while (d < L - 95) {
      const w = 4.2 + rng() * 3.4;
      const mid = d + w / 2;
      const zone = zoneAt(mid, sg);
      const nearCross = crossings.some((c) => Math.abs(rel(mid, c)) < w / 2 + 6.5);
      const nearTrain = train && Math.abs(rel(mid, train.dist)) < w / 2 + 11;
      const nearGate = Math.abs(rel(mid, Z.templeGate)) < w / 2 + 4 || Math.abs(rel(mid, Z.marketGate)) < w / 2 + 4;
      if (!zone || nearCross || nearTrain || nearGate) { d += zone ? w : 4; prevOk = false; continue; }
      const p0 = track.pointAt(d), p1 = track.pointAt(d + w);
      const b0 = frontLat(d, sg) - 0.95 + zone.walk, b1 = frontLat(d + w, sg) - 0.95 + zone.walk;
      const bl = Math.max(b0, b1);
      const fl: [number, number] = [p0.x + p0.nx * sg * bl, p0.z + p0.nz * sg * bl];
      const fr: [number, number] = [p1.x + p1.nx * sg * bl, p1.z + p1.nz * sg * bl];
      let ox = (p0.nx + p1.nx) * sg, oz = (p0.nz + p1.nz) * sg;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol; oz /= ol;
      let depth = zone.depth[0] + rng() * (zone.depth[1] - zone.depth[0]);
      const own = idxAt(mid);
      const frontPts: [number, number][] = [fl, fr, [(fl[0] + fr[0]) / 2, (fl[1] + fr[1]) / 2]];
      if (!footprintOk(frontPts, 1.5, own, 3)) { d += w; prevOk = false; continue; }
      // 後面碰到別段路就縮淺一點
      while (depth > 6 && !footprintOk([[fl[0] + ox * depth, fl[1] + oz * depth], [fr[0] + ox * depth, fr[1] + oz * depth], [(fl[0] + fr[0]) / 2 + ox * depth, (fl[1] + fr[1]) / 2 + oz * depth]], 3, -1, 4)) depth -= 1.5;
      if (depth <= 6) { d += w; prevOk = false; continue; }
      const floors = zone.floors[0] + Math.floor(rng() * (zone.floors[1] - zone.floors[0] + 1));
      const style = zone.styles[Math.floor(rng() * zone.styles.length)];
      const yb = Math.max(p0.y, p1.y) + 0.12;
      const nextZone = zoneAt(d + w * 1.5, sg);
      house({
        fl, fr, ox, oz, depth, yb, floors, style, arcade: zone.arcade,
        sign: rng() < (tier > 0 ? 0.55 : 0.4) ? Math.floor(rng() * V_WORDS.length) : -1,
        hsign: rng() < 0.6 ? Math.floor(rng() * STALL_SIGNS) : -1,
        leftCol: true, rightCol: !nextZone || !prevOk,
      });
      occupied.push({ x: (fl[0] + fr[0]) / 2 + ox * depth / 2, z: (fl[1] + fr[1]) / 2 + oz * depth / 2, r: Math.max(w, depth) * 0.6 });
      fronts.push({ d, sg, w, front: bl, zone, floors });
      // 人行道：從屏障外側到店面（騎樓裡面）
      for (let dd = d; dd <= d + w + 0.01; dd += track.spacing) {
        const i = idxAt(dd);
        walkIn[sg][i] = usedW(i, sg) - (track.runoffW(i, sg) > 0 ? 1.4 : 0.05);
        walkOut[sg][i] = bl + (zone.arcade ? ARC + 0.2 : 0.3);
      }
      prevOk = true;
      d += w;
    }
  }

  // ---------- 人行道地磚（房子前面那一條） ----------
  {
    const gw = new Geo();
    for (const sg of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!walkOut[sg][i] || !walkOut[sg][j]) continue;
        const a = S[i], b = S[j];
        const clampIn = (s: typeof a, lat: number) => (s.curv * lat * sg > 0 && Math.abs(lat) > 0.9 / Math.abs(s.curv) ? 0.9 / Math.abs(s.curv) : lat);
        const ai = clampIn(a, walkIn[sg][i]), ao = clampIn(a, walkOut[sg][i]), bi = clampIn(b, walkIn[sg][j]), bo = clampIn(b, walkOut[sg][j]);
        const P = (s: typeof a, lat: number): V3 => [s.x + s.nx * sg * lat, s.y + 0.1, s.z + s.nz * sg * lat];
        gw.quad(P(a, ai), P(b, bi), P(b, bo), P(a, ao), [ai / 3, a.dist / 3, ao / 3, (a.dist + track.spacing) / 3], [1, 1, 1], [0, 1, 0]);
        // 人行道邊緣（路緣）往下接到地面
        const yd = -2.5;
        gw.quad([a.x + a.nx * sg * ao, a.y + 0.1 + yd, a.z + a.nz * sg * ao], [b.x + b.nx * sg * bo, b.y + 0.1 + yd, b.z + b.nz * sg * bo], P(b, bo), P(a, ao), [0, 0, 1, 0.3], [0.5, 0.5, 0.5], [a.nx * sg, 0, a.nz * sg]);
      }
    }
    if (!gw.empty) {
      const m = new THREE.Mesh(gw.build(), walkMat);
      m.receiveShadow = shadows;
      group.add(m);
    }
  }

  // =================================================================
  // 夜市：攤車、燈籠、燈泡、人潮
  // =================================================================
  const bulbs = { pos: [] as number[], col: [] as number[], size: [] as number[] };
  const bulb = (x: number, y: number, z: number, s = 0.35, c: RGB = [1.0, 0.72, 0.35]) => { bulbs.pos.push(x, y, z); bulbs.col.push(...c); bulbs.size.push(s); };
  const steam: { x: number; y: number; z: number }[] = [];
  const people: THREE.Matrix4[] = [];
  const peopleCol: number[] = [];
  const parked: THREE.Matrix4[] = [];
  const parkedCol: number[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const SHIRTS = [0xe8e4dc, 0x2f3542, 0xd94848, 0x3a7bd5, 0xf2c94c, 0x46a36a, 0xf08ab0, 0x8a6ad0, 0xffffff, 0xff8a3a];
  const BODY = [0xe8e6e2, 0x1e1e22, 0xc8302a, 0x2a5cb0, 0x8fbf3a, 0xf2c230, 0xff8ab0, 0x7a7f88, 0x3ab0b0, 0xf4f4f0];
  const person = (x: number, z: number, y: number, yaw: number) => {
    const s = 0.9 + rng() * 0.22;
    q.setFromAxisAngle(up, yaw);
    people.push(new THREE.Matrix4().compose(v3.set(x, y, z), q, new THREE.Vector3(s, s, s)));
    peopleCol.push(SHIRTS[Math.floor(rng() * SHIRTS.length)]);
  };
  const parkScooter = (x: number, z: number, y: number, yaw: number) => {
    q.setFromAxisAngle(up, yaw);
    parked.push(new THREE.Matrix4().compose(v3.set(x, y, z), q, one));
    parkedCol.push(BODY[Math.floor(rng() * BODY.length)]);
  };

  /** 一台攤車：(x,z) = 攤車前緣中心，(ax,az) = 沿街方向，(ox,oz) = 往後（離開馬路）的方向 */
  const stall = (x: number, z: number, y: number, ax: number, az: number, ox: number, oz: number, k: number) => {
    const gs = geo(x, z, 'solid'), gg = geo(x, z, 'glow'), gn = geo(x, z, 'sign');
    const cx = x + ox * 0.7, cz = z + oz * 0.7;
    const body = hex([0xc8ccd2, 0xb02a24, 0xd8a030, 0x2a6ab0, 0x2f8a52, 0xe8e2d0][k % 6], 0.95);
    gs.box(cx, y, cz, ax, az, 2.0, 1.2, 0.95, body);
    // 玻璃櫃（裡面的食物被燈照亮）
    gg.box(cx - ox * 0.25, y + 0.95, cz - oz * 0.25, ax, az, 1.8, 0.55, 0.42, [1.25, 0.82, 0.45]);
    // 四根柱子與雨棚
    for (const [s, t] of [[-0.95, -0.55], [0.95, -0.55], [-0.95, 0.6], [0.95, 0.6]]) gs.box(cx + ax * s + ox * t, y + 0.95, cz + az * s + oz * t, ax, az, 0.06, 0.06, 1.5, [0.5, 0.5, 0.52], false);
    const can = hex([0xd8231c, 0xf2c230, 0x2a6ab0, 0x2f8a52, 0xff7a1a, 0xe8e2d0][(k * 5 + 1) % 6], 0.9);
    const yA = y + 2.55, yB = y + 2.3;
    const P = (s: number, t: number, yy: number): V3 => [cx + ax * s + ox * t, yy, cz + az * s + oz * t];
    gs.quad(P(-1.15, -1.0, yB), P(1.15, -1.0, yB), P(1.15, 0.8, yA), P(-1.15, 0.8, yA), [0, 0, 1, 1], can, [0, 1, 0]);
    gs.quad(P(1.15, -1.0, yB - 0.03), P(-1.15, -1.0, yB - 0.03), P(-1.15, 0.8, yA - 0.03), P(1.15, 0.8, yA - 0.03), [0, 0, 1, 1], [can[0] * 0.5, can[1] * 0.5, can[2] * 0.5], [0, -1, 0]);
    // 招牌（兩面）
    const uv = hSign(k % STALL_SIGNS);
    gn.quad(P(-1.05, -1.02, yB + 0.05), P(1.05, -1.02, yB + 0.05), P(1.05, -1.02, yB + 0.62), P(-1.05, -1.02, yB + 0.62), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [-ox, 0, -oz]);
    gn.quad(P(1.05, -0.98, yB + 0.05), P(-1.05, -0.98, yB + 0.05), P(-1.05, -0.98, yB + 0.62), P(1.05, -0.98, yB + 0.62), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [ox, 0, oz]);
    // 燈泡
    for (const s of [-0.7, 0, 0.7]) bulb(cx + ax * s - ox * 0.6, yB - 0.25, cz + az * s - oz * 0.6, 0.32);
    if (rng() < (tier > 1 ? 0.35 : 0.2)) steam.push({ x: cx + ox * 0.1, y: y + 1.5, z: cz + oz * 0.1 });
  };

  // 夜市街兩側：屏障後面一排攤車（面向馬路），攤車後面是逛夜市的人，騎樓前停機車
  const STALL_STEP = tier > 0 ? 2.6 : 3.4;
  let stallNo = 0;
  for (const sg of [1, -1]) {
    for (let d = Z.market[0] + 6; d < Z.market[1] - 4; d += STALL_STEP) {
      if (crossings.some((c) => Math.abs(rel(d, c)) < 7) || Math.abs(rel(d, Z.marketGate)) < 4) continue;
      const i = idxAt(d);
      if (!walkOut[sg][i]) continue;
      const p = track.pointAt(d);
      const lat = usedW(i, sg) + 0.45;
      const ox = p.nx * sg, oz = p.nz * sg;
      stall(p.x + ox * lat, p.z + oz * lat, p.y + 0.1, p.tx, p.tz, ox, oz, stallNo++);
      // 人：站在攤車後面、面向攤車或馬路
      if (rng() < (tier > 0 ? 0.85 : 0.45)) {
        const t = lat + 2.4 + rng() * 1.6;
        person(p.x + ox * t + p.tx * (rng() - 0.5) * 2, p.z + oz * t + p.tz * (rng() - 0.5) * 2, p.y + 0.1, Math.atan2(-ox, -oz) + (rng() - 0.5) * 1.6);
      }
    }
  }
  // 其他街道：騎樓前一排停好的機車，偶爾有人
  for (const f of fronts) {
    if (inR(f.d, Z.market[0], Z.market[1]) || inR(f.d, Z.start[0], Z.start[1])) continue;
    if (rng() > (tier > 1 ? 0.75 : tier > 0 ? 0.55 : 0.3)) continue;
    for (let dd = f.d + 0.6; dd < f.d + f.w - 0.5; dd += 0.95) {
      const p = track.pointAt(dd);
      const lat = f.front - 1.1;
      const ox = p.nx * f.sg, oz = p.nz * f.sg;
      // 車頭朝馬路、稍微斜停
      parkScooter(p.x + ox * lat, p.z + oz * lat, p.y + 0.1, Math.atan2(-ox, -oz) + 0.25);
    }
    if (rng() < 0.4) {
      const p = track.pointAt(f.d + f.w / 2), t = f.front + 1.2;
      person(p.x + p.nx * f.sg * t, p.z + p.nz * f.sg * t, p.y + 0.1, Math.atan2(-p.nx * f.sg, -p.nz * f.sg));
    }
  }

  // ---------- 紅燈籠串：橫越夜市街（兩側騎樓的二樓之間） ----------
  const lanterns: THREE.Matrix4[] = [];
  const lanternCol: RGB[] = [];
  const wires: number[] = [];
  const lantern = (x: number, y: number, z: number, s: number, col: RGB) => {
    lanterns.push(new THREE.Matrix4().compose(v3.set(x, y, z), q.identity(), new THREE.Vector3(s, s, s)));
    lanternCol.push(col);
  };
  // 色調映射會把太亮的紅色洗成粉紅：亮度壓在 1 附近，維持燈籠的正紅
const RED: RGB = [1.0, 0.07, 0.03], YEL: RGB = [1.05, 0.66, 0.1], ORG: RGB = [1.1, 0.34, 0.05];
  const string = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number, step: number, s: number, pick: (k: number) => RGB | null) => {
    const len = Math.hypot(bx - ax, bz - az);
    const N = Math.max(2, Math.round(len / 1.6));
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= N; k++) {
      const t = k / N;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      wires.push(px, py, pz, x, y, z);
      px = x; py = y; pz = z;
    }
    const M = Math.max(1, Math.floor(len / step));
    for (let k = 1; k < M; k++) {
      const t = k / M;
      const col = pick(k);
      if (!col) continue;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      lantern(x, y - 0.55 * s, z, s, col);
    }
  };
  {
    const step = tier > 0 ? 10 : 15;
    for (let d = Z.market[0] + 12; d < Z.market[1] - 8; d += step) {
      const i = idxAt(d);
      if (!walkOut[1][i] || !walkOut[-1][i]) continue;
      const p = track.pointAt(d);
      const la = walkOut[1][i] - ARC - 0.3, lb = walkOut[-1][i] - ARC - 0.3;
      // 燈籠的高度要高過賽車的鏡頭（約離地 4.5~6 公尺）
      const y = p.y + 9.6;
      string(p.x + p.nx * la, y, p.z + p.nz * la, p.x - p.nx * lb, y, p.z - p.nz * lb, 1.0, 2.1, 1, (k) => (k % 6 === 3 ? YEL : RED));
    }
    // 老街：小一點的黃燈籠
    for (let d = Z.old[0] + 14; d < Z.old[1] - 10; d += tier > 0 ? 14 : 21) {
      const i = idxAt(d);
      if (!walkOut[1][i] || !walkOut[-1][i]) continue;
      const p = track.pointAt(d);
      const la = walkOut[1][i] - ARC - 0.3, lb = walkOut[-1][i] - ARC - 0.3;
      string(p.x + p.nx * la, p.y + 9, p.z + p.nz * la, p.x - p.nx * lb, p.y + 9, p.z - p.nz * lb, 0.9, 2.6, 0.8, (k) => (k % 2 ? ORG : YEL));
    }
  }

  // =================================================================
  // 牌樓與廟
  // =================================================================
  const tOpts = { lowDetail: tier === 0, shadows };
  const gateSpan = 2 * (hw + 1.75);
  const placeGate = (d: number, title: string) => {
    const p = track.pointAt(d);
    // 放大 1.15 倍比較氣派（柱子的位置不變）
    const g = buildPaifang(gateSpan / 1.15, tOpts, title);
    g.scale.setScalar(1.15);
    g.position.set(p.x, p.y, p.z);
    g.rotation.y = Math.atan2(p.tx, p.tz);
    group.add(g);
  };
  placeGate(Z.marketGate, '廟口夜市');
  placeGate(Z.templeGate, '福安宮');
  let templeUpdate: ((t: number) => void) | null = null;
  const smokeAt: THREE.Vector3[] = [];
  {
    const p = track.pointAt(Z.temple);
    const i = idxAt(Z.temple);
    const lat = usedW(i, -1) + 4.6;
    const tx = p.x - p.nx * lat, tz = p.z - p.nz * lat;
    const tp = buildTemple(tOpts);
    // 放大一點，從賽道上看起來比較有份量
    tp.group.scale.setScalar(1.15);
    tp.group.position.set(tx, p.y + 0.05, tz);
    // 廟的正面（+Z）朝向馬路
    tp.group.rotation.y = Math.atan2(p.nx, p.nz);
    group.add(tp.group);
    tp.group.updateMatrixWorld(true);
    for (const s of tp.smoke) smokeAt.push(s.clone().applyMatrix4(tp.group.matrixWorld));
    templeUpdate = tp.update;
    occupied.push({ x: tx - p.nx * 13, z: tz - p.nz * 13, r: 26 });
    // 廟埕：屏障外到廟前的石板地
    const plazaTex = canvas(256, 256, (c) => {
      const r = mulberry32(9);
      for (let y = 0; y < 256; y += 64) for (let x = 0; x < 256; x += 64) {
        const v = 120 + r() * 30;
        c.fillStyle = `rgb(${v},${v - 6},${v - 12})`;
        c.fillRect(x, y, 64, 64);
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.fillRect(x, y, 64, 2);
        c.fillRect(x, y, 2, 64);
      }
      // 鞭炮的紅色紙屑
      for (let k = 0; k < 500; k++) {
        c.fillStyle = r() < 0.8 ? 'rgba(200,30,25,0.8)' : 'rgba(240,200,60,0.8)';
        c.fillRect(r() * 256, r() * 256, 2 + r() * 3, 1 + r() * 2);
      }
    });
    const gp = new Geo();
    for (let d = Z.plaza[0] - 10; d < Z.plaza[1] + 10; d += track.spacing) {
      const a = track.pointAt(d), b = track.pointAt(d + track.spacing);
      // 廟埕的石板地從路緣石外面就開始鋪（蓋過緩衝區的水泥斜紋），一路鋪到廟前
      const a0 = hw + 1.05, b0 = hw + 1.05;
      const a1 = usedW(i, -1) + 30, b1 = a1;
      gp.quad([a.x - a.nx * a0, a.y + 0.08, a.z - a.nz * a0], [b.x - b.nx * b0, b.y + 0.08, b.z - b.nz * b0], [b.x - b.nx * b1, b.y + 0.08, b.z - b.nz * b1], [a.x - a.nx * a1, a.y + 0.08, a.z - a.nz * a1], [a0 / 4, d / 4, a1 / 4, (d + track.spacing) / 4], [1, 1, 1], [0, 1, 0]);
    }
    const plaza = new THREE.Mesh(gp.build(), new THREE.MeshLambertMaterial({ map: plazaTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    plaza.receiveShadow = shadows;
    group.add(plaza);
    // 香爐、神轎、燈籠架
    const burner = buildIncenseBurner(tOpts);
    const bl = lat - 2.4;
    burner.group.position.set(p.x - p.nx * bl, p.y + 0.08, p.z - p.nz * bl);
    burner.group.rotation.y = Math.atan2(p.nx, p.nz);
    group.add(burner.group);
    burner.group.updateMatrixWorld(true);
    smokeAt.push(burner.smoke.clone().applyMatrix4(burner.group.matrixWorld));
    for (const [dd, ll] of [[-20, 1.5], [-15, 3.2], [20, 2.2]] as [number, number][]) {
      const q2 = track.pointAt(Z.temple + dd);
      const pl = buildPalanquin(tOpts);
      const la = usedW(idxAt(Z.temple + dd), -1) + ll;
      pl.position.set(q2.x - q2.nx * la, q2.y + 0.08, q2.z - q2.nz * la);
      pl.rotation.y = Math.atan2(q2.tx, q2.tz) + (rng() - 0.5) * 0.4;
      group.add(pl);
    }
    // 廟埕前一排燈籠（沿著馬路）
    for (let d = Z.plaza[0] + 4; d < Z.plaza[1] - 4; d += 16) {
      const a = track.pointAt(d), b = track.pointAt(d + 16);
      const la = usedW(idxAt(d), -1) + 1.0, lb = usedW(idxAt(d + 16), -1) + 1.0;
      const gs = geo(a.x, a.z, 'solid');
      gs.box(a.x - a.nx * la, a.y, a.z - a.nz * la, 1, 0, 0.2, 0.2, 6.2, [0.55, 0.12, 0.1]);
      string(a.x - a.nx * la, a.y + 6, a.z - a.nz * la, b.x - b.nx * lb, b.y + 6, b.z - b.nz * lb, 0.9, 2, 1.1, () => RED);
    }
    // 廟埕上的人
    for (let k = 0; k < (tier > 0 ? 34 : 14); k++) {
      const dd = Z.temple + (rng() - 0.5) * 70, q2 = track.pointAt(dd);
      const la = usedW(idxAt(dd), -1) + 1 + rng() * 4.5;
      person(q2.x - q2.nx * la, q2.z - q2.nz * la, q2.y + 0.08, Math.atan2(q2.nx, q2.nz) + (rng() - 0.5) * 2.5);
    }
  }

  // =================================================================
  // 夜市小巷（捷徑）：兩旁的矮房子、攤販、燈籠；巷子裡的障礙物
  // =================================================================
  for (const b of branches) {
    const hb = b.halfWidth;
    // 兩側的房子（離主線太近的地方不蓋）
    for (const sg of [1, -1]) {
      let d = 6;
      while (d < b.length - 6) {
        const w = 3.6 + rng() * 2.6;
        const i0 = Math.round(d / b.spacing), i1 = Math.min(b.n - 1, Math.round((d + w) / b.spacing));
        const s0 = b.samples[i0], s1 = b.samples[i1];
        const front = hb + 0.95 + 2.3;
        const fl: [number, number] = [s0.x + s0.nx * sg * front, s0.z + s0.nz * sg * front];
        const fr: [number, number] = [s1.x + s1.nx * sg * front, s1.z + s1.nz * sg * front];
        let ox = (s0.nx + s1.nx) * sg, oz = (s0.nz + s1.nz) * sg;
        const ol = Math.hypot(ox, oz) || 1;
        ox /= ol; oz /= ol;
        const depth = 9 + rng() * 3;
        const pts: [number, number][] = [fl, fr, [fl[0] + ox * depth, fl[1] + oz * depth], [fr[0] + ox * depth, fr[1] + oz * depth]];
        let ok = true;
        for (const [x, z] of pts) if (hitsMain(x, z, 2.5)) ok = false;
        if (!ok) { d += w; continue; }
        house({
          fl, fr, ox, oz, depth, yb: (s0.y + s1.y) / 2 + 0.12, floors: 2 + Math.floor(rng() * 2), style: [0, 1, 2, 3][Math.floor(rng() * 4)], arcade: false,
          sign: rng() < 0.45 ? Math.floor(rng() * V_WORDS.length) : -1, hsign: -1, leftCol: false, rightCol: false,
        });
        occupied.push({ x: (fl[0] + fr[0]) / 2 + ox * depth / 2, z: (fl[1] + fr[1]) / 2 + oz * depth / 2, r: Math.max(w, depth) * 0.6 });
        // 巷子裡的攤販（貼著牆、面向巷子）
        if (rng() < 0.75) {
          const sm = b.samples[Math.round((i0 + i1) / 2)];
          const lat = hb + 1.05;
          stall(sm.x + sm.nx * sg * lat, sm.z + sm.nz * sg * lat, sm.y + 0.1, sm.tx, sm.tz, sm.nx * sg, sm.nz * sg, stallNo++);
          if (rng() < 0.6) person(sm.x + sm.nx * sg * (lat + 2.1), sm.z + sm.nz * sg * (lat + 2.1), sm.y + 0.1, Math.atan2(-sm.nx * sg, -sm.nz * sg));
        }
        d += w;
      }
    }
    // 巷子的地面：兩側的店面前面也鋪一條
    const ga = new Geo();
    for (let i = 0; i < b.n - 1; i++) {
      const a = b.samples[i], c = b.samples[i + 1];
      for (const sg of [1, -1]) {
        const i0 = hb + 0.95, i1 = hb + 3.3;
        ga.quad([a.x + a.nx * sg * i0, a.y + 0.08, a.z + a.nz * sg * i0], [c.x + c.nx * sg * i0, c.y + 0.08, c.z + c.nz * sg * i0], [c.x + c.nx * sg * i1, c.y + 0.08, c.z + c.nz * sg * i1], [a.x + a.nx * sg * i1, a.y + 0.08, a.z + a.nz * sg * i1], [0, a.dist / 3, 1, c.dist / 3], [1, 1, 1], [0, 1, 0]);
      }
    }
    const am = new THREE.Mesh(ga.build(), walkMat);
    am.receiveShadow = shadows;
    group.add(am);
    // 橫越巷子的燈籠與燈泡串
    for (let d = 10; d < b.length - 8; d += tier > 0 ? 7 : 11) {
      const s = b.samples[Math.round(d / b.spacing)];
      const la = hb + 3.0;
      if (hitsMain(s.x, s.z, 1)) continue;
      string(s.x + s.nx * la, s.y + 8, s.z + s.nz * la, s.x - s.nx * la, s.y + 8, s.z - s.nz * la, 0.5, 1.6, 0.85, (k) => (k % 3 === 1 ? YEL : RED));
    }
    // 巷子裡的障礙物：攤車、垃圾桶、機車（位置與半徑跟模擬一致）
    b.posts.forEach((p, k) => {
      const s = b.samples[Math.min(b.n - 1, Math.round(p.d / b.spacing))];
      const kind = k % 3;
      const gs = geo(p.x, p.z, 'solid'), gg = geo(p.x, p.z, 'glow');
      if (kind === 0) {
        // 推車攤（橫在巷子裡）
        gs.box(p.x, p.y, p.z, s.tx, s.tz, p.r * 1.7, p.r * 1.3, 0.95, [0.78, 0.8, 0.84]);
        gg.box(p.x, p.y + 0.95, p.z, s.tx, s.tz, p.r * 1.5, p.r * 0.9, 0.38, [1.3, 0.85, 0.45]);
        gs.box(p.x, p.y + 2.1, p.z, s.tx, s.tz, p.r * 2.1, p.r * 1.8, 0.08, [0.85, 0.15, 0.12]);
        for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) gs.box(p.x + s.tx * a * p.r * 0.8 + s.nx * c * p.r * 0.55, p.y + 0.95, p.z + s.tz * a * p.r * 0.8 + s.nz * c * p.r * 0.55, 1, 0, 0.06, 0.06, 1.15, [0.5, 0.5, 0.5], false);
        bulb(p.x, p.y + 1.9, p.z, 0.4);
      } else if (kind === 1) {
        // 綠色、橘色的大垃圾桶（一組）
        gs.cyl(p.x - s.tx * 0.45, p.y, p.z - s.tz * 0.45, p.r * 0.55, 1.15, 10, [0.18, 0.5, 0.28]);
        gs.cyl(p.x + s.tx * 0.45, p.y, p.z + s.tz * 0.45, p.r * 0.55, 1.15, 10, [0.85, 0.45, 0.12]);
        gs.box(p.x, p.y, p.z, s.tx, s.tz, p.r * 1.8, p.r * 1.4, 0.35, [0.3, 0.3, 0.32]);
      } else {
        // 違規停在巷子裡的兩台機車
        parkScooter(p.x - s.tx * 0.5, p.z - s.tz * 0.5, p.y, Math.atan2(s.nx, s.nz) + 0.3);
        parkScooter(p.x + s.tx * 0.5, p.z + s.tz * 0.5, p.y, Math.atan2(s.nx, s.nz) - 0.2);
      }
      // 障礙物上掛的小燈（暗巷裡看得到）
      bulb(p.x, p.y + 1.4, p.z, 0.3, [1.2, 0.35, 0.25]);
    });
  }

  // =================================================================
  // 平交道的鐵道（路面上的鐵軌、柵欄與火車在 streetHazards.ts）
  // =================================================================
  if (rail) {
    const railTex = canvas(64, 256, (c) => {
      c.fillStyle = '#4a4642';
      c.fillRect(0, 0, 64, 256);
      const r = mulberry32(3);
      for (let i = 0; i < 700; i++) {
        const v = 50 + r() * 70;
        c.fillStyle = `rgb(${v},${v - 4},${v - 8})`;
        c.fillRect(r() * 64, r() * 256, 2, 2);
      }
      // 枕木
      for (let y = 0; y < 256; y += 32) {
        c.fillStyle = '#5a5248';
        c.fillRect(6, y + 6, 52, 14);
      }
    });
    const gr = new Geo(), gsr = geo(rail.x, rail.z, 'solid');
    const W = 2.6, gap = hw + 4;
    for (const sg of [1, -1]) {
      const a = gap, b = rail.reach;
      const P = (t: number, s: number, y: number): V3 => [rail.x + rail.nx * sg * t + rail.tx * s, y, rail.z + rail.nz * sg * t + rail.tz * s];
      const y = rail.y + 0.05;
      gr.quad(P(a, -W, y), P(b, -W, y), P(b, W, y), P(a, W, y), [0, a / 8, 1, b / 8], [1, 1, 1], [0, 1, 0]);
      // 道碴的斜邊（往下接到地面）
      gr.quad(P(a, -W - 3, y - 2.5), P(b, -W - 3, y - 2.5), P(b, -W, y), P(a, -W, y), [0, a / 8, 0.2, b / 8], [0.7, 0.7, 0.7], [0, 1, 0]);
      gr.quad(P(a, W, y), P(b, W, y), P(b, W + 3, y - 2.5), P(a, W + 3, y - 2.5), [0, a / 8, 0.2, b / 8], [0.7, 0.7, 0.7], [0, 1, 0]);
      for (const s of [-0.75, 0.75]) {
        const cx = rail.x + rail.nx * sg * (a + b) / 2 + rail.tx * s, cz = rail.z + rail.nz * sg * (a + b) / 2 + rail.tz * s;
        gsr.box(cx, y, cz, rail.nx, rail.nz, b - a, 0.12, 0.16, [0.62, 0.64, 0.68]);
      }
      // 電車線的電桿（每 30 m 一根）
      for (let t = a + 10; t < b; t += 30) {
        const [px, , pz] = P(t, W + 1.6, 0);
        gsr.box(px, y - 0.5, pz, rail.nx, rail.nz, 0.3, 0.3, 7.5, [0.5, 0.52, 0.55]);
        const [qx, , qz] = P(t, 0, 0);
        gsr.box((px + qx) / 2, y + 6.6, (pz + qz) / 2, rail.tx, rail.tz, W + 1.6, 0.12, 0.12, [0.5, 0.52, 0.55]);
        wires.push(...P(t, 0, y + 6.3), ...P(Math.min(b, t + 30), 0, y + 6.3));
      }
    }
    const rm = new THREE.Mesh(gr.build(), new THREE.MeshLambertMaterial({ map: railTex }));
    rm.receiveShadow = shadows;
    group.add(rm);
    // 北側的小車站：月台、雨棚（火車停在雨棚下面看不到就好）
    for (const sg of [1, -1]) {
      const t0 = STATION_FROM, t1 = rail.reach;
      const P = (t: number, s: number): [number, number] => [rail.x + rail.nx * sg * t + rail.tx * s, rail.z + rail.nz * sg * t + rail.tz * s];
      const mid = P((t0 + t1) / 2, 0);
      const gs = geo(mid[0], mid[1], 'solid'), gg = geo(mid[0], mid[1], 'glow'), gf = geo(mid[0], mid[1], 'f2');
      const len = t1 - t0;
      const y = rail.y;
      // 月台（兩側）
      for (const s of [-4.6, 4.6]) {
        const c = P((t0 + t1) / 2, s);
        gs.box(c[0], y - 1, c[1], rail.nx, rail.nz, len, 3.4, 1.9, [0.55, 0.53, 0.5]);
        gs.box(c[0] - rail.tx * Math.sign(s) * 1.5, y + 0.9, c[1] - rail.tz * Math.sign(s) * 1.5, rail.nx, rail.nz, len, 0.25, 0.02, [1.0, 0.85, 0.1]);
      }
      // 雨棚：柱子＋屋頂（屋頂兩側垂下來，把火車遮住）
      for (let t = t0 + 2; t < t1; t += 8) for (const s of [-4.2, 4.2]) {
        const c = P(t, s);
        gs.box(c[0], y + 0.9, c[1], rail.nx, rail.nz, 0.3, 0.3, 4.2, [0.32, 0.36, 0.42]);
      }
      const r0 = P((t0 + t1) / 2, 0);
      gs.box(r0[0], y + 5.1, r0[1], rail.nx, rail.nz, len + 2, 12, 0.35, [0.3, 0.42, 0.55]);
      for (const s of [-5.9, 5.9]) {
        const c = P((t0 + t1) / 2, s);
        gf.quad([c[0] - rail.nx * sg * len / 2, y + 0.9, c[1] - rail.nz * sg * len / 2], [c[0] + rail.nx * sg * len / 2, y + 0.9, c[1] + rail.nz * sg * len / 2], [c[0] + rail.nx * sg * len / 2, y + 5.2, c[1] + rail.nz * sg * len / 2], [c[0] - rail.nx * sg * len / 2, y + 5.2, c[1] - rail.nz * sg * len / 2], [0, 0.75, len / 16, 1], [0.8, 0.8, 0.8], [rail.tx * Math.sign(s), 0, rail.tz * Math.sign(s)]);
      }
      // 靠平交道那一端的牆（火車從這裡鑽進去）
      const e0 = P(t0 - 0.2, 0);
      gs.box(e0[0], y + 3.6, e0[1], rail.tx, rail.tz, 12, 0.5, 1.6, [0.3, 0.42, 0.55]);
      // 月台燈
      for (let t = t0 + 4; t < t1; t += 6) {
        const c = P(t, 0);
        gg.box(c[0], y + 4.85, c[1], rail.nx, rail.nz, 1.4, 0.18, 0.08, [1.9, 2.0, 2.0]);
      }
      // 站名牌
      if (sg > 0) {
        const c = P(t0 + 6, -6.3);
        const tex = canvas(256, 64, (cx) => {
          cx.fillStyle = '#f4f4f0';
          cx.fillRect(0, 0, 256, 64);
          cx.fillStyle = '#1d4fc4';
          cx.fillRect(0, 0, 256, 10);
          cx.fillStyle = '#1a1a1a';
          cx.font = `bold 38px ${FONT}`;
          cx.textAlign = 'center';
          cx.textBaseline = 'middle';
          cx.fillText('福安站', 128, 38);
        }, false);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.2, 1.2, 1.2), side: THREE.DoubleSide }));
        sign.position.set(c[0], y + 3.8, c[1]);
        sign.rotation.y = Math.atan2(rail.tx, rail.tz) + Math.PI / 2;
        group.add(sign);
      }
    }
  }

  // =================================================================
  // 後排與遠處的房子（填滿街廓），避開馬路、鐵道、河、廟
  // =================================================================
  {
    const sp = tier > 1 ? 15 : tier > 0 ? 18 : 24;
    const { minX, maxX, minZ, maxZ } = ctx.bounds;
    const pad = 140;
    let count = 0;
    const maxCount = tier > 1 ? 700 : tier > 0 ? 480 : 220;
    for (let x = minX - pad; x < maxX + pad && count < maxCount; x += sp) {
      for (let z = minZ - pad; z < maxZ + pad && count < maxCount; z += sp) {
        const px = x + (rng() - 0.5) * sp * 0.5, pz = z + (rng() - 0.5) * sp * 0.5;
        const m = nearMain(px, pz, 8);
        if (m.d < hw + 24) continue;
        // 河堤外側（河那一邊）不蓋
        if (m.i >= 0 && inR(S[m.i].dist, Z.levee[0] - 60, Z.levee[1] + 40) && m.lat < 0) continue;
        if (m.i >= 0 && inR(S[m.i].dist, Z.lowerR[0], Z.lowerR[1]) && m.lat < 0) continue;
        const gy = terrainH(px, pz);
        if (inRiver(px, pz, 12)) continue;
        const w = 8 + rng() * 8, d = 8 + rng() * 8;
        const r = Math.hypot(w, d) / 2;
        if (m.d < hw + 14 + r + usedW(m.i, Math.sign(m.lat) || 1) - hw) continue;
        if (nearBranch(px, pz) < r + 9 || nearRail(px, pz) < r + 6 || !free(px, pz, r * 0.8)) continue;
        // 方向跟最近的路對齊（像棋盤式的街廓）
        const s = m.i >= 0 ? S[m.i] : S[0];
        const yaw = Math.atan2(s.tz, s.tx) + (rng() < 0.15 ? Math.PI / 2 : 0);
        const far = m.d > 120;
        const floors = far && rng() < 0.3 ? 8 + Math.floor(rng() * 7) : 3 + Math.floor(rng() * (far ? 5 : 3));
        const style = m.i >= 0 && inR(S[m.i].dist, Z.old[0], Z.old[1]) && rng() < 0.6 ? 3 : Math.floor(rng() * 3);
        block(px, pz, yaw, w, d, floors, style, gy - 0.4);
        occupied.push({ x: px, z: pz, r: r * 0.8 });
        count++;
      }
    }
  }

  // =================================================================
  // 電線桿與亂牽的電線（平交道街、老街、河濱路）
  // =================================================================
  {
    const poles: [number, number, number][] = [];
    for (const f of fronts) {
      if (inR(f.d, Z.market[0], Z.market[1]) || inR(f.d, Z.start[0], Z.start[1])) continue;
      const p = track.pointAt(f.d + f.w / 2);
      if (poles.length && Math.hypot(poles[poles.length - 1][0] - p.x, poles[poles.length - 1][2] - p.z) < 28) continue;
      const lat = f.front - 0.6;
      poles.push([p.x + p.nx * f.sg * lat, p.y, p.z + p.nz * f.sg * lat]);
    }
    let prev: [number, number, number] | null = null;
    for (const [x, y, z] of poles) {
      const gs = geo(x, z, 'solid');
      gs.cyl(x, y - 0.5, z, 0.2, 11.5, 6, [0.55, 0.53, 0.5], true, 0.15);
      gs.box(x, y + 9.6, z, 1, 0, 1.8, 0.14, 0.14, [0.35, 0.33, 0.3]);
      if (rng() < 0.5) gs.cyl(x + 0.35, y + 7.6, z, 0.32, 1.1, 7, [0.5, 0.52, 0.5]);
      if (prev && Math.hypot(prev[0] - x, prev[2] - z) < 60) {
        for (let k = 0; k < 4; k++) {
          const o = (k - 1.5) * 0.45, h = 9.7 - (k % 2) * 1.2;
          const ax = prev[0] + o, ay = prev[1] + h, az = prev[2], bx = x + o, by = y + h, bz = z;
          const N = 8;
          let px = ax, py = ay, pz = az;
          for (let s = 1; s <= N; s++) {
            const t = s / N, sag = 0.9 + k * 0.25;
            const xx = ax + (bx - ax) * t, yy = ay + (by - ay) * t - sag * 4 * t * (1 - t), zz = az + (bz - az) * t;
            wires.push(px, py, pz, xx, yy, zz);
            px = xx; py = yy; pz = zz;
          }
        }
      }
      prev = [x, y, z];
    }
  }

  // =================================================================
  // 路燈：灰色的燈桿、彎出去的燈臂，燈頭發光，路面上一圈暖色的光（取代一般的路燈模型，全部合併）
  // =================================================================
  const pools: THREE.Matrix4[] = [];
  {
    const step = 34;
    for (const sg of [1, -1]) {
      for (let d = (sg > 0 ? 0 : step / 2); d < L; d += step) {
        if (inR(d, Z.market[0] - 4, Z.market[1] + 4)) continue;
        if (sg < 0 && inR(d, Z.templeR[0], Z.templeR[1])) continue;
        if (crossings.some((c) => Math.abs(rel(d, c)) < 8) || (train && Math.abs(rel(d, train.dist)) < 14)) continue;
        if (Math.abs(rel(d, Z.templeGate)) < 8 || Math.abs(rel(d, Z.marketGate)) < 8) continue;
        const i = idxAt(d);
        if (track.cliffAt(i, sg)) continue;
        const p = track.pointAt(d);
        const base = usedW(i, sg) + 0.5;
        const x = p.x + p.nx * sg * base, z = p.z + p.nz * sg * base;
        if (hitsMain(x, z, 0.3, i) || nearBranch(x, z) < 2 || nearRail(x, z) < 4) continue;
        const gs = geo(x, z, 'solid'), gg = geo(x, z, 'glow');
        const y = p.y;
        gs.cyl(x, y - 0.5, z, 0.16, 9.6, 6, [0.55, 0.57, 0.6], true, 0.11);
        // 燈臂：往路面伸出 2.6 公尺
        const reach = 2.6;
        const hx = x - p.nx * sg * reach, hz = z - p.nz * sg * reach;
        gs.box((x + hx) / 2, y + 9.0, (z + hz) / 2, p.nx, p.nz, reach + 0.3, 0.12, 0.12, [0.55, 0.57, 0.6]);
        gs.box(hx, y + 8.75, hz, p.nx, p.nz, 0.9, 0.36, 0.3, [0.5, 0.52, 0.55]);
        gg.box(hx, y + 8.68, hz, p.nx, p.nz, 0.7, 0.26, 0.06, [2.2, 1.7, 1.0]);
        bulb(hx, y + 8.55, hz, 0.9, [1.0, 0.78, 0.45]);
        // 地上的光：照在路面（或緩衝區）上，貼著坡度
        const pl = Math.min(hw - 3, base - reach - 3);
        const nrm = new THREE.Vector3(-p.tx * S[i].slope, 1, -p.tz * S[i].slope).normalize();
        q.setFromUnitVectors(up, nrm);
        pools.push(new THREE.Matrix4().compose(v3.set(p.x + p.nx * sg * pl, y + 0.075, p.z + p.nz * sg * pl), q, one));
      }
    }
  }

  // =================================================================
  // 便利商店（起跑後第一個彎的外側）、檳榔攤（幾個路口）
  // =================================================================
  const neonMats: THREE.MeshBasicMaterial[] = [];
  {
    const shopAt = (d: number, sg: number, kind: 'conv' | 'betel') => {
      const p = track.pointAt(d);
      const lat = usedW(idxAt(d), sg) + 2.2;
      const ox = p.nx * sg, oz = p.nz * sg;
      const x = p.x + ox * lat, z = p.z + oz * lat;
      const W = kind === 'conv' ? 9 : 2.6, D = kind === 'conv' ? 8 : 2.4, H = kind === 'conv' ? 4.2 : 2.7;
      const cx = x + ox * D / 2, cz = z + oz * D / 2;
      if (!free(cx, cz, W * 0.5) || hitsMain(cx + ox * D / 2, cz + oz * D / 2, 2) || nearBranch(cx, cz) < W) return;
      occupied.push({ x: cx, z: cz, r: W * 0.6 });
      const gs = geo(cx, cz, 'solid'), gg = geo(cx, cz, 'glow');
      const y = p.y + 0.1;
      gs.box(cx, y - 1.5, cz, p.tx, p.tz, W, D, H + 1.5, [0.85, 0.85, 0.82]);
      const P = (s: number, t: number, yy: number): V3 => [x + p.tx * s + ox * t, yy, z + p.tz * s + oz * t];
      // 整面亮白的玻璃門面
      gg.quad(P(-W / 2 + 0.3, -0.03, y + 0.1), P(W / 2 - 0.3, -0.03, y + 0.1), P(W / 2 - 0.3, -0.03, y + H - 1.1), P(-W / 2 + 0.3, -0.03, y + H - 1.1), [0, 0, 1, 1], kind === 'conv' ? [1.9, 1.95, 1.9] : [1.6, 1.3, 1.0], [-ox, 0, -oz]);
      const uv = hSign(kind === 'conv' ? H_CONV : H_BETEL);
      geo(cx, cz, 'sign').quad(P(-W / 2, -0.06, y + H - 1.05), P(W / 2, -0.06, y + H - 1.05), P(W / 2, -0.06, y + H - 0.05), P(-W / 2, -0.06, y + H - 0.05), [uv[0], uv[1], uv[2], uv[3]], [1, 1, 1], [-ox, 0, -oz]);
      if (kind === 'conv') {
        // 招牌下的彩色條紋（不是任何一家的配色）
        gg.quad(P(-W / 2, -0.07, y + H - 1.2), P(W / 2, -0.07, y + H - 1.2), P(W / 2, -0.07, y + H - 1.05), P(-W / 2, -0.07, y + H - 1.05), [0, 0, 1, 1], [0.4, 0.9, 1.9], [-ox, 0, -oz]);
        for (let k = 0; k < 5; k++) parkScooter(x + p.tx * (W / 2 + 1 + k * 0.95) - ox * 0.5, z + p.tz * (W / 2 + 1 + k * 0.95) - oz * 0.5, y, Math.atan2(-ox, -oz) + 0.2);
        for (let k = 0; k < 3; k++) person(x + p.tx * (rng() - 0.5) * W - ox * 1.2, z + p.tz * (rng() - 0.5) * W - oz * 1.2, y, Math.atan2(ox, oz) + (rng() - 0.5));
      } else {
        // 檳榔攤：玻璃櫃周圍一圈會閃的霓虹燈管
        const mat = new THREE.MeshBasicMaterial({ color: 0xff3d9a });
        neonMats.push(mat);
        const tube = new Geo();
        const e = 0.07;
        for (const [a, b] of [[[-W / 2, y + 0.05], [W / 2, y + 0.05]], [[-W / 2, y + H - 0.05], [W / 2, y + H - 0.05]]] as [number, number][][]) {
          tube.quad(P(a[0], -0.08, a[1] - e), P(b[0], -0.08, b[1] - e), P(b[0], -0.08, b[1] + e), P(a[0], -0.08, a[1] + e), [0, 0, 1, 1], [1, 1, 1], [-ox, 0, -oz]);
        }
        for (const s of [-W / 2, W / 2]) tube.quad(P(s - e, -0.08, y + 0.05), P(s + e, -0.08, y + 0.05), P(s + e, -0.08, y + H), P(s - e, -0.08, y + H), [0, 0, 1, 1], [1, 1, 1], [-ox, 0, -oz]);
        const tm = new THREE.Mesh(tube.build(), mat);
        group.add(tm);
        person(x - ox * 0.2 + p.tx * 0.4, z - oz * 0.2 + p.tz * 0.4, y, Math.atan2(-ox, -oz));
      }
    };
    shopAt(240, -1, 'conv');
    shopAt(2238, -1, 'conv');
    shopAt(930, -1, 'betel');
    shopAt(1880, 1, 'betel');
    shopAt(2120, 1, 'betel');
    shopAt(1100, 1, 'betel');
  }

  // =================================================================
  // 路面標線：路口前的「慢」、平交道前的「停」
  // =================================================================
  {
    const markTex = canvas(256, 128, (c) => {
      c.clearRect(0, 0, 256, 128);
      c.fillStyle = '#f4f4f0';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `bold 110px ${FONT}`;
      c.fillText('慢', 64, 66);
      c.fillText('停', 192, 66);
    }, false);
    const gm = new Geo();
    const mark = (d: number, lat: number, which: 0 | 1) => {
      const p = track.pointAt(d);
      // 字的底部朝來車方向（從遠處看是正的）、拉長 2.5 倍
      const sx = 1.6, sz = 4.2;
      const P = (s: number, t: number): V3 => [p.x + p.nx * (lat + s) + p.tx * t, p.y + 0.055, p.z + p.nz * (lat + s) + p.tz * t];
      const u0 = which * 0.5, u1 = u0 + 0.5;
      gm.quad(P(sx, -sz), P(-sx, -sz), P(-sx, sz), P(sx, sz), [u0, 0, u1, 1], [1, 1, 1], [0, 1, 0]);
    };
    for (const c of crossings) for (const lat of [-6, 0, 6]) mark(c - 26, lat, 0);
    if (train) for (const lat of [-6, 0, 6]) mark(train.dist - 22, lat, 1);
    const mm = new THREE.Mesh(gm.build(), new THREE.MeshBasicMaterial({ map: markTex, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, color: new THREE.Color(0.8, 0.8, 0.8) }));
    mm.renderOrder = 2;
    group.add(mm);
  }

  // ---------- 巷口：從路邊延伸出去的小巷路面（機車從這裡出來） ----------
  {
    const gc = new Geo();
    for (const c of crossings) {
      const p = track.pointAt(c);
      for (const sg of [1, -1]) {
        const a = usedW(idxAt(c), sg) - 0.6, b = a + 34;
        const P = (t: number, s: number): V3 => [p.x + p.nx * sg * t + p.tx * s, p.y + 0.06, p.z + p.nz * sg * t + p.tz * s];
        gc.quad(P(a, -4.2), P(b, -4.2), P(b, 4.2), P(a, 4.2), [0, 0, 1, 1], [0.22, 0.22, 0.24], [0, 1, 0]);
        // 巷口的黃色閃光號誌
        const [lx, , lz] = P(a + 1.5, -4.8);
        geo(lx, lz, 'solid').box(lx, p.y, lz, 1, 0, 0.15, 0.15, 3.3, [0.3, 0.3, 0.3]);
        bulb(lx, p.y + 3.4, lz, 0.55, [2.0, 1.4, 0.2]);
      }
    }
    if (!gc.empty) group.add(new THREE.Mesh(gc.build(), new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  // =================================================================
  // 河、對岸山坡的燈火、遠方的橋、天燈
  // =================================================================
  {
    const gw = new Geo();
    const p0 = track.pointAt(Z.levee[0] + 60), p1 = track.pointAt(Z.levee[1] - 30);
    const line = riverLine, near = RIVER_NEAR, farW = RIVER_FAR;
    for (let k = 0; k < line.length - 1; k++) {
      const a = line[k], b = line[k + 1];
      gw.quad([a.x - a.nx * near, WATER_Y, a.z - a.nz * near], [b.x - b.nx * near, WATER_Y, b.z - b.nz * near], [b.x - b.nx * farW, WATER_Y, b.z - b.nz * farW], [a.x - a.nx * farW, WATER_Y, a.z - a.nz * farW], [0, 0, 1, 1], [1, 1, 1], [0, 1, 0]);
    }
    const water = new THREE.Mesh(gw.build(), new THREE.MeshStandardMaterial({ color: 0x0a1424, roughness: 0.45, metalness: 0.0, envMapIntensity: 0.22 }));
    water.renderOrder = -1;
    group.add(water);
    // 對岸：一排低矮的山（深色），山上一點一點的燈火
    const hill = new Geo();
    const lights = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const cxm = (p0.x + p1.x) / 2, czm = (p0.z + p1.z) / 2;
    const nx = -(p0.nx + p1.nx) / 2, nz = -(p0.nz + p1.nz) / 2; // 往河的方向
    const tx = -nz, tz = nx;
    const H = (u: number, v: number) => Math.max(0, (Math.sin(u * 0.006 + 1) * 0.5 + 0.5) * 70 + Math.sin(u * 0.017) * 22 + Math.sin(u * 0.041 + 2) * 9) * Math.min(1, v / 80);
    const U0 = -1300, U1 = 1300, V0 = 300, V1 = 600, du = 40, dv = 40;
    const at = (u: number, v: number): V3 => [cxm + nx * v + tx * u, WATER_Y - 1 + H(u, v - V0), czm + nz * v + tz * u];
    for (let u = U0; u < U1; u += du) for (let v = V0; v < V1; v += dv) {
      const shade = 0.12 + 0.08 * Math.sin(u * 0.01 + v);
      hill.quad(at(u, v), at(u + du, v), at(u + du, v + dv), at(u, v + dv), [0, 0, 1, 1], [shade * 0.6, shade * 0.6, shade * 0.9], [-nx, 1, -nz]);
    }
    const hm = new THREE.Mesh(hill.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
    group.add(hm);
    const nl = tier > 1 ? 2600 : tier > 0 ? 1700 : 800;
    for (let k = 0; k < nl; k++) {
      // 聚落：沿著幾條「山路」聚集
      const lane = Math.floor(rng() * 9);
      const u = U0 + 120 + rng() * (U1 - U0 - 240);
      const v = V0 + 10 + ((lane * 37 + u * 0.08 + Math.sin(u * 0.02 + lane) * 30) % (V1 - V0 - 60)) + rng() * 8;
      const [x, y, z] = at(u, v);
      lights.pos.push(x, y + 0.8, z);
      const w = rng();
      lights.col.push(...(w < 0.6 ? [1.0, 0.72, 0.38] : w < 0.85 ? [1.0, 0.92, 0.75] : w < 0.95 ? [0.75, 0.85, 1.0] : [1.0, 0.25, 0.2]) as RGB);
      lights.size.push(2.4 + rng() * 2.2);
    }
    // 河岸邊的路燈（對岸的濱河道路）
    for (let u = U0; u < U1; u += 22) {
      const [x, y, z] = at(u, V0 - 8);
      lights.pos.push(x, WATER_Y + 3, z);
      lights.col.push(1.0, 0.75, 0.4);
      lights.size.push(4);
    }
    group.add(glowPoints(lights.pos, lights.col, lights.size, 6));
    // 河面上的倒影：燈光拉長的光帶（加法混色的細長面）
    const refl = new Geo();
    for (let u = U0; u < U1; u += 44) {
      const [x, , z] = at(u, V0 - 8);
      const len = 60 + rng() * 60;
      const w2 = 0.9;
      refl.quad([x - tx * w2, WATER_Y + 0.05, z - tz * w2], [x + tx * w2, WATER_Y + 0.05, z + tz * w2], [x + tx * w2 - nx * len, WATER_Y + 0.05, z + tz * w2 - nz * len], [x - tx * w2 - nx * len, WATER_Y + 0.05, z - tz * w2 - nz * len], [0, 0, 1, 1], [0.5, 0.32, 0.14], [0, 1, 0]);
    }
    const rm = new THREE.Mesh(refl.build(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(rm);
    // 遠方橫跨河面的紅色拱橋（橋上兩排路燈）
    {
      const u = 900;
      const [bx0, , bz0] = at(u, -40);
      const [bx1, , bz1] = at(u, V0 + 30);
      const gb = new Geo();
      const len = Math.hypot(bx1 - bx0, bz1 - bz0);
      const ax = (bx1 - bx0) / len, az = (bz1 - bz0) / len;
      const deckY = WATER_Y + 9;
      gb.box((bx0 + bx1) / 2, deckY, (bz0 + bz1) / 2, ax, az, len, 14, 1.2, [0.25, 0.24, 0.25]);
      for (let t = 30; t < len; t += 60) gb.box(bx0 + ax * t, WATER_Y - 2, bz0 + az * t, ax, az, 3, 10, deckY - WATER_Y + 2, [0.3, 0.29, 0.3], false);
      const bl = { pos: [] as number[], col: [] as number[], size: [] as number[] };
      for (let t = 0; t < len; t += 12) for (const s of [-6.5, 6.5]) {
        bl.pos.push(bx0 + ax * t - az * s, deckY + 4, bz0 + az * t + ax * s);
        bl.col.push(1.0, 0.8, 0.45);
        bl.size.push(2.2);
      }
      // 拱
      const arch = new Geo();
      const A0 = len * 0.3, A1 = len * 0.7, AH = 34;
      for (const s of [-6.5, 6.5]) for (let k = 0; k < 24; k++) {
        const t0 = A0 + (A1 - A0) * (k / 24), t1 = A0 + (A1 - A0) * ((k + 1) / 24);
        const h0 = AH * Math.sin((Math.PI * k) / 24), h1 = AH * Math.sin((Math.PI * (k + 1)) / 24);
        const P = (t: number, h: number, o: number): V3 => [bx0 + ax * t - az * (s + o), deckY + h, bz0 + az * t + ax * (s + o)];
        arch.quad(P(t0, h0, -0.6), P(t1, h1, -0.6), P(t1, h1 + 1.6, -0.6), P(t0, h0 + 1.6, -0.6), [0, 0, 1, 1], [1.1, 0.18, 0.12], [-az * Math.sign(s), 0, ax * Math.sign(s)]);
        arch.quad(P(t1, h1, 0.6), P(t0, h0, 0.6), P(t0, h0 + 1.6, 0.6), P(t1, h1 + 1.6, 0.6), [0, 0, 1, 1], [1.1, 0.18, 0.12], [az * Math.sign(s), 0, -ax * Math.sign(s)]);
      }
      group.add(new THREE.Mesh(gb.build(), new THREE.MeshLambertMaterial({ vertexColors: true })));
      group.add(new THREE.Mesh(arch.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
      group.add(glowPoints(bl.pos, bl.col, bl.size, 5));
    }
  }

  // 河堤上：強風段的風向袋與「強風」告示牌、沒有欄杆那段的反光樁
  if (gust) {
    const tex = canvas(128, 128, (c) => {
      c.fillStyle = '#ffd200';
      c.beginPath();
      c.moveTo(64, 4); c.lineTo(124, 64); c.lineTo(64, 124); c.lineTo(4, 64);
      c.closePath();
      c.fill();
      c.strokeStyle = '#1a1a1a';
      c.lineWidth = 6;
      c.stroke();
      c.fillStyle = '#1a1a1a';
      c.font = `bold 30px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('強風', 64, 52);
      c.fillText('注意', 64, 84);
    }, false);
    const signMat2 = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, color: new THREE.Color(1.15, 1.15, 1.15) });
    for (const dd of [-40, gust.len ?? 0]) {
      const p = track.pointAt(gust.dist + dd);
      const lat = usedW(idxAt(gust.dist + dd), 1) + 1;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), signMat2);
      m.position.set(p.x + p.nx * lat, p.y + 3.2, p.z + p.nz * lat);
      m.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;
      group.add(m);
      geo(m.position.x, m.position.z, 'solid').box(m.position.x, p.y, m.position.z, 1, 0, 0.12, 0.12, 2, [0.5, 0.5, 0.5]);
    }
  }

  // ---------- 天燈：從河對岸慢慢飄上去 ----------
  const skyLanterns: { mesh: THREE.InstancedMesh; base: { x: number; z: number; ph: number; sp: number }[] } | null = (() => {
    const cnt = tier > 1 ? 26 : tier > 0 ? 18 : 10;
    const g = new Geo();
    g.box(0, -0.6, 0, 1, 0, 0.9, 0.9, 1.25, [1, 1, 1]);
    const mesh = new THREE.InstancedMesh(g.build(), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.1, 0.4), fog: false }), cnt);
    const base: { x: number; z: number; ph: number; sp: number }[] = [];
    const p = track.pointAt((Z.levee[0] + Z.levee[1]) / 2);
    for (let k = 0; k < cnt; k++) {
      const v = 120 + rng() * 380, u = (rng() - 0.5) * 900;
      base.push({ x: p.x - p.nx * v + p.tx * u, z: p.z - p.nz * v + p.tz * u, ph: rng() * 200, sp: 1.2 + rng() * 1.2 });
    }
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, base };
  })();

  // =================================================================
  // 合併區塊、加上 Instanced 的東西
  // =================================================================
  let meshCount = 0;
  for (const m of chunks.values()) {
    for (const [k, g] of m) {
      if (g.empty) continue;
      const mesh = new THREE.Mesh(g.build(), MATS[k]);
      const castable = k === 'solid' || k.startsWith('f');
      mesh.castShadow = shadows && castable && tier > 1;
      mesh.receiveShadow = shadows && k !== 'glow' && k !== 'sign';
      group.add(mesh);
      meshCount++;
    }
  }
  group.userData.townMeshes = meshCount;

  /** 大量重複的東西依位置分成幾塊 InstancedMesh，每塊各自做視錐剔除 */
  const instChunks = (geoI: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], color: ((k: number, c: THREE.Color) => void) | null, cast = false) => {
    const by = new Map<string, number[]>();
    list.forEach((m, k) => {
      const key = `${Math.floor(m.elements[12] / CELL)},${Math.floor(m.elements[14] / CELL)}`;
      let a = by.get(key);
      if (!a) by.set(key, (a = []));
      a.push(k);
    });
    const c = new THREE.Color();
    for (const idx of by.values()) {
      const im = new THREE.InstancedMesh(geoI, mat, idx.length);
      idx.forEach((k, j) => {
        im.setMatrixAt(j, list[k]);
        if (color) { color(k, c); im.setColorAt(j, c); }
      });
      im.computeBoundingSphere();
      im.castShadow = cast;
      group.add(im);
    }
  };

  // 燈籠：六角的燈籠（上下深色的蓋子），輕輕擺動
  if (lanterns.length) {
    const seg = tier > 0 ? 6 : 5;
    const prof: [number, number, RGB][] = [[0.0, -0.66, [0.3, 0.2, 0.08]], [0.16, -0.58, [0.3, 0.2, 0.08]], [0.3, -0.45, [1, 1, 1]], [0.44, -0.18, [1, 1, 1]], [0.46, 0.08, [1, 1, 1]], [0.38, 0.36, [1, 1, 1]], [0.2, 0.5, [0.3, 0.2, 0.08]], [0.0, 0.58, [0.3, 0.2, 0.08]]];
    const lg = new Geo();
    for (let k = 0; k < prof.length - 1; k++) {
      const [r0, y0, c0] = prof[k], [r1, y1] = prof[k + 1];
      for (let j = 0; j < seg; j++) {
        const a0 = (j / seg) * TAU, a1 = ((j + 1) / seg) * TAU;
        lg.quad([Math.cos(a0) * r0, y0, Math.sin(a0) * r0], [Math.cos(a1) * r0, y0, Math.sin(a1) * r0], [Math.cos(a1) * r1, y1, Math.sin(a1) * r1], [Math.cos(a0) * r1, y1, Math.sin(a0) * r1], [0, 0, 1, 1], c0, [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]);
      }
    }
    const time = { value: 0 };
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
          transformed.x += sin(uTime * 1.4 + ph) * 0.12 * (0.6 - position.y);
          transformed.z += cos(uTime * 1.1 + ph) * 0.08 * (0.6 - position.y);
        #endif`);
    };
    instChunks(lg.build(), mat, lanterns, (k, c) => c.setRGB(...lanternCol[k]));
    updaters.push((_dt, t) => { time.value = t; });
  }
  // 電線
  if (wires.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x15130f })));
  }
  // 燈泡
  if (bulbs.pos.length) group.add(glowPoints(bulbs.pos, bulbs.col, bulbs.size, 3.5));
  // 人
  if (people.length) {
    const pg = personGeos();
    instChunks(pg.shirt, new THREE.MeshLambertMaterial({ vertexColors: true }), people, (k, c) => c.setHex(peopleCol[k]));
    instChunks(pg.rest, new THREE.MeshLambertMaterial({ vertexColors: true }), people, null);
  }
  // 停在路邊的機車（太多的話隨機抽掉一些）
  if (parked.length) {
    const cap = tier > 1 ? 460 : tier > 0 ? 300 : 120;
    const keep: number[] = [];
    parked.forEach((_m, k) => keep.push(k));
    while (keep.length > cap) keep.splice(Math.floor(rng() * keep.length), 1);
    instChunks(scooterGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), keep.map((k) => parked[k]), (k, c) => c.setHex(parkedCol[keep[k]]));
  }
  // 路燈照在路面上的光
  if (pools.length) {
    const poolTex = canvas(64, 64, (c) => {
      const gr = c.createRadialGradient(32, 32, 2, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,214,150,0.32)');
      gr.addColorStop(1, 'rgba(255,214,150,0)');
      c.fillStyle = gr;
      c.fillRect(0, 0, 64, 64);
    }, false);
    const pm = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    instChunks(new THREE.PlaneGeometry(22, 22).rotateX(-Math.PI / 2), pm, pools, null);
  }

  // ---------- 會動的東西：蒸氣、香煙、天燈、檳榔攤的霓虹 ----------
  const puffs = (() => {
    const max = tier > 1 ? 420 : tier > 0 ? 260 : 120;
    const pos = new Float32Array(max * 3), life = new Float32Array(max), vel = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uCol: { value: new THREE.Color(0.75, 0.66, 0.6) } },
      vertexShader: /* glsl */ `attribute float aSize; attribute float aAlpha; uniform float uScale; varying float vA;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / max(0.5, -mv.z); }`,
      fragmentShader: /* glsl */ `uniform vec3 uCol; varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uCol, vA * (1.0 - r * r) * 0.5); }`,
      transparent: true, depthWrite: false,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    pts.onBeforeRender = (renderer, _s, camera) => {
      const cam = camera as THREE.PerspectiveCamera;
      mat.uniforms.uScale.value = renderer.getContext().drawingBufferHeight / (2 * Math.tan((cam.fov * Math.PI) / 360));
    };
    group.add(pts);
    const src = [...steam.map((s) => ({ ...s, k: 0 })), ...smokeAt.map((s) => ({ x: s.x, y: s.y, z: s.z, k: 1 }))];
    let cur = 0, acc = 0;
    return (dt: number) => {
      acc += dt * (tier > 1 ? 40 : tier > 0 ? 26 : 12);
      while (acc >= 1 && src.length) {
        acc -= 1;
        const s = src[Math.floor(Math.random() * src.length)];
        const i = cur;
        cur = (cur + 1) % max;
        pos[i * 3] = s.x + (Math.random() - 0.5) * 0.5;
        pos[i * 3 + 1] = s.y;
        pos[i * 3 + 2] = s.z + (Math.random() - 0.5) * 0.5;
        vel[i * 3] = (Math.random() - 0.5) * 0.4 + 0.25;
        vel[i * 3 + 1] = s.k ? 0.9 + Math.random() * 0.5 : 1.4 + Math.random() * 0.6;
        vel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
        life[i] = s.k ? 4 + Math.random() * 2 : 1.6 + Math.random() * 0.8;
        size[i] = s.k ? 1.2 : 0.8;
      }
      for (let i = 0; i < max; i++) {
        if (life[i] <= 0) { alpha[i] = 0; continue; }
        life[i] -= dt;
        pos[i * 3] += vel[i * 3] * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        size[i] += dt * 1.1;
        alpha[i] = Math.min(1, life[i] * 0.6) * 0.8;
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aAlpha.needsUpdate = true;
    };
  })();
  const NEON = [0xff3d9a, 0x3dff8a, 0x40c8ff, 0xffe14d];
  const lm = new THREE.Matrix4();
  updaters.push((dt, t) => {
    puffs(dt);
    templeUpdate?.(t);
    // 檳榔攤的霓虹：一閃一閃換顏色
    neonMats.forEach((m, k) => {
      const s = Math.floor(t * 2.5 + k * 1.3);
      m.color.setHex(NEON[(s + k) % NEON.length]).multiplyScalar(s % 5 === 0 ? 0.3 : 2.2);
    });
    if (skyLanterns) {
      const { mesh, base } = skyLanterns;
      base.forEach((b, k) => {
        const h = ((t * b.sp + b.ph) % 260);
        lm.makeTranslation(b.x + Math.sin(t * 0.1 + k) * 6 + h * 0.3, WATER_Y + 10 + h, b.z + Math.cos(t * 0.13 + k) * 6);
        mesh.setMatrixAt(k, lm);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  });

  return {
    group,
    update(dt, time) {
      for (const u of updaters) u(dt, time);
    },
  };
}
