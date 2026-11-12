import type { ThemeId } from '../game/track';

/** 一張地圖的整體風格：天空、光線、地面與周邊景物的種類 */
export interface Theme {
  id: ThemeId;
  night: boolean;
  skyTop: number;
  skyHorizon: number;
  fogNear: number;
  fogFar: number;
  /** 太陽（或月亮）的方向、顏色與強度 */
  sunDir: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  /** 太陽本體在天空中的亮度倍率（夜晚的月亮比較暗） */
  sunDisc: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  /** 泛光強度 */
  bloom: number;
  /** 地面貼圖的三個顏色（底色、亮斑、暗斑） */
  ground: [string, string, string];
  /** 地形頂點顏色：低處與高處的色調 */
  groundLow: [number, number, number];
  groundHigh: [number, number, number];
  shoulder: number;
  farGround: number;
  road: string;
  roadSpeck: number;
  /** 護欄的四個顏色 */
  walls: [string, string, string, string];
  mountain: number;
  mountainCap: number | null;
  cloud: number | null;
  vegetation: 'forest' | 'desert' | 'city';
  lake: boolean;
  lakeColor: number;
  turbines: boolean;
  flowers: boolean;
  /** 帳篷與看台的重點色 */
  accents: number[];
}

export const THEMES: Record<ThemeId, Theme> = {
  // 草原山道：黃金時段的暖色斜陽
  meadow: {
    id: 'meadow', night: false,
    skyTop: 0x4a90e8, skyHorizon: 0xffead4, fogNear: 280, fogFar: 1500,
    sunDir: [0.62, 0.5, 0.36], sunColor: 0xffe0b0, sunIntensity: 2.7, sunDisc: 1,
    hemiSky: 0xcfe3ff, hemiGround: 0x93a56c, hemiIntensity: 1.3,
    exposure: 1.08, bloom: 0.3,
    ground: ['#6dbb4c', 'rgba(140,215,95,0.45)', 'rgba(60,140,58,0.45)'],
    groundLow: [0.75, 0.78, 0.7], groundHigh: [1.06, 0.96, 0.78],
    shoulder: 0xcfe6bd, farGround: 0xd9e4cf,
    road: '#5a5f6c', roadSpeck: 66,
    walls: ['#ff5d8f', '#ffd23f', '#3bceac', '#4d9de0'],
    mountain: 0x8fa8c8, mountainCap: 0xfff6ec, cloud: 0xfff4e6,
    vegetation: 'forest', lake: true, lakeColor: 0x3fa9e6, turbines: true, flowers: true,
    accents: [0xe8545a, 0x3f8fe8, 0xffc93c, 0x39c48a, 0xb469ff],
  },
  // 沙漠峽谷：正午的強烈日照、紅色岩壁
  desert: {
    id: 'desert', night: false,
    skyTop: 0x2f86e6, skyHorizon: 0xf8e4c0, fogNear: 320, fogFar: 1700,
    sunDir: [0.3, 0.86, 0.34], sunColor: 0xfff3dc, sunIntensity: 3.1, sunDisc: 1,
    hemiSky: 0xdcecff, hemiGround: 0xd29a62, hemiIntensity: 1.25,
    exposure: 1.0, bloom: 0.26,
    ground: ['#d7ab6c', 'rgba(240,205,140,0.5)', 'rgba(176,122,70,0.45)'],
    groundLow: [0.86, 0.8, 0.72], groundHigh: [1.08, 0.92, 0.72],
    shoulder: 0xf0d9b0, farGround: 0xeed9b6,
    road: '#6c665f', roadSpeck: 78,
    walls: ['#ff7a1a', '#f4f1e8', '#2ec4b6', '#ffd23f'],
    mountain: 0xc0633a, mountainCap: 0xe09a5c, cloud: 0xffffff,
    vegetation: 'desert', lake: false, lakeColor: 0x3fa9e6, turbines: false, flowers: false,
    accents: [0xe8545a, 0xf4f1e8, 0x2ec4b6, 0xffc93c, 0xff7a1a],
  },
  // 霓虹夜城：月光下的街道賽，靠霓虹燈與路燈照明
  city: {
    id: 'city', night: true,
    skyTop: 0x040612, skyHorizon: 0x182048, fogNear: 240, fogFar: 1200,
    sunDir: [-0.45, 0.62, 0.4], sunColor: 0xa9c4ff, sunIntensity: 1.25, sunDisc: 0.35,
    hemiSky: 0x7f95d8, hemiGround: 0x3a3352, hemiIntensity: 1.05,
    exposure: 1.1, bloom: 0.36,
    ground: ['#2b3140', 'rgba(70,80,104,0.5)', 'rgba(20,24,34,0.5)'],
    groundLow: [0.8, 0.85, 1.0], groundHigh: [1.0, 1.0, 1.1],
    shoulder: 0x8c94a8, farGround: 0x5a6278,
    road: '#4c5162', roadSpeck: 60,
    walls: ['#ff3d9a', '#22e6ff', '#9b5cff', '#ffe14d'],
    mountain: 0x1a2140, mountainCap: null, cloud: null,
    vegetation: 'city', lake: true, lakeColor: 0x12305c, turbines: false, flowers: false,
    accents: [0xff3d9a, 0x22e6ff, 0x9b5cff, 0xffe14d, 0x39ffb0],
  },
};
