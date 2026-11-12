export interface Sample {
  x: number;
  z: number;
  /** 路面高度 */
  y: number;
  /** 沿前進方向的坡度 dy/ds */
  slope: number;
  /** 切線（前進方向） */
  tx: number;
  tz: number;
  /** 左側法線 */
  nx: number;
  nz: number;
  dist: number;
  /** 曲率，正值 = 左彎 */
  curv: number;
}

/** 加速帶：dist 為距起跑線的公尺數，lat 為橫向位置（左為正） */
export interface BoostPad {
  dist: number;
  lat: number;
}

export type ThemeId = 'meadow' | 'desert' | 'city';

/** 沿賽道的一段範圍（公尺）；side：1 = 行進方向左側，-1 = 右側，0 = 兩側 */
export interface SceneRange {
  from: number;
  to: number;
  side: number;
}

/** 賽道旁要擺哪些大型景物 */
export interface Scenery {
  stands: SceneRange[];
  pits: SceneRange[];
  tents: SceneRange[];
  /** 橫跨路面的拱門位置 */
  arches: number[];
}

export interface TrackDef {
  id: string;
  name: string;
  /** 選單上的一句話介紹 */
  desc: string;
  theme: ThemeId;
  scenery: Scenery;
  laps: number;
  halfWidth: number;
  /** 控制點 [x, z, 高度] */
  points: [number, number, number][];
  pads: BoostPad[];
  /** 跳台（距起跑線的公尺數，指跳台頂端的位置），整條路寬都是斜坡 */
  ramps: number[];
  /** 爆炸桶的位置 */
  barrels: BoostPad[];
  /** 捷徑：從主線分岔、抄近路再接回主線的窄路 */
  shortcuts?: ShortcutDef[];
  /** 賽道機關 */
  hazards?: HazardDef[];
}

/**
 * 捷徑：from / to 是在主線上分岔與接回的位置（公尺），lat 是兩端在主線上的橫向位置（正 = 左，
 * 一般靠彎道內側）。中間可以指定經過的點 [x, z]。兩端與主線相切，所以會先和主線重疊一段再分開。
 */
export interface ShortcutDef {
  from: number;
  to: number;
  lat: number;
  via?: [number, number][];
  halfWidth: number;
}

/**
 * 機關：
 * - hammer：吊在門架上左右擺盪的大鐵鎚
 * - boulder：從路邊滾進賽道、沿著下坡往前滾的巨石（len 為滾動的路段長度，period 為生成間隔）
 * - tram：橫越路口的電車，period 秒一班
 */
export interface HazardDef {
  kind: 'hammer' | 'boulder' | 'tram';
  dist: number;
  period: number;
  phase?: number;
  len?: number;
}

export const PAD_LENGTH = 9;
export const PAD_HALF_WIDTH = 3.2;

export const TRACKS: TrackDef[] = [
  {
    id: 'skyline-loop',
    name: '雲頂山道',
    desc: '長直線、山頂髮夾彎與連續 S 彎',
    theme: 'meadow',
    scenery: {
      stands: [{ from: -70, to: 170, side: 1 }, { from: 700, to: 830, side: 1 }, { from: 1395, to: 1440, side: 0 }],
      pits: [{ from: 12, to: 140, side: -1 }],
      tents: [{ from: 640, to: 690, side: -1 }, { from: 1300, to: 1560, side: 0 }],
      arches: [1010, 1720, 2400],
    },
    laps: 2,
    halfWidth: 12,
    points: [
      // 起跑直線
      [0, -60, 0], [0, 40, 0], [0, 140, 0],
      // 上坡大左彎
      [25, 225, 3], [95, 280, 8], [190, 285, 13], [265, 240, 16],
      // 山頂髮夾彎
      [285, 170, 17], [290, 105, 17], [325, 68, 16], [360, 105, 15],
      // 下坡直線接右彎
      [365, 175, 12], [385, 250, 9], [435, 305, 6], [510, 318, 4], [565, 275, 3],
      // 連續 S 彎
      [578, 200, 2], [548, 140, 2], [578, 80, 2], [548, 20, 2], [575, -45, 3],
      // 第二段爬坡與山脊
      [548, -118, 8], [482, -165, 13], [400, -158, 18], [332, -118, 20], [268, -148, 20],
      // 長下坡回到終點
      [205, -195, 16], [150, -262, 11], [78, -300, 6], [12, -268, 3], [-4, -195, 1], [0, -128, 0],
    ],
    pads: [
      { dist: 150, lat: 0 },
      { dist: 900, lat: -4 },
      { dist: 900, lat: 4 },
      { dist: 1290, lat: 4 },
      { dist: 1590, lat: 0 },
      { dist: 2040, lat: 0 },
      { dist: 2330, lat: -3 },
    ],
    ramps: [195, 965, 1650],
    barrels: [
      { dist: 330, lat: 9.2 }, { dist: 338, lat: -9.2 }, { dist: 520, lat: -9.2 }, { dist: 680, lat: 9.2 },
      { dist: 850, lat: 9.2 }, { dist: 856, lat: -9.2 }, { dist: 1130, lat: -9.2 }, { dist: 1240, lat: 9.2 },
      { dist: 1350, lat: 9.2 }, { dist: 1425, lat: -9.2 }, { dist: 1500, lat: 9.2 }, { dist: 1760, lat: 9.2 },
      { dist: 1766, lat: -9.2 }, { dist: 1980, lat: -9.2 }, { dist: 2120, lat: 9.2 }, { dist: 2126, lat: -9.2 },
      { dist: 2300, lat: 9.2 },
    ],
    // 山脊上兩座擺錘，過了之後左側是抄近路的林道
    hazards: [{ kind: 'hammer', dist: 1905, period: 3.4 }, { kind: 'hammer', dist: 1955, period: 3.4, phase: 0.3 }],
    shortcuts: [{ from: 2010, to: 2310, lat: 6.2, halfWidth: 5.5 }],
  },
  {
    id: 'red-canyon',
    name: '赤岩峽谷',
    desc: '大落差長下坡、峽谷 S 彎與谷底髮夾彎',
    theme: 'desert',
    scenery: {
      stands: [{ from: -70, to: 170, side: 1 }, { from: 1300, to: 1380, side: 1 }, { from: 730, to: 820, side: 1 }, { from: 480, to: 560, side: 1 }],
      pits: [{ from: 12, to: 140, side: -1 }],
      tents: [{ from: 600, to: 700, side: 0 }, { from: 1850, to: 1990, side: 0 }],
      arches: [880, 1180, 1800],
    },
    laps: 2,
    halfWidth: 12,
    // 控制點由賽道設計腳本產生：起跑直線 → 爬坡右彎 → 峽谷 S 彎 → 岩台右彎 → 長下坡 → 谷底髮夾彎 → 左彎爬坡 → 斜向下坡 → 長右彎回到起點
    points: [[0, 0, 3], [0, 95, 3], [0, 190, 3.4], [-19, 268, 6], [-89, 308, 9], [-173, 308, 12.5], [-250, 345, 16], [-327, 308, 19.5], [-411, 308, 22.5], [-481, 268, 24.3], [-503, 191, 24.5], [-503, 69, 20.5], [-503, -53, 15.5], [-503, -175, 10.5], [-499, -241, 6], [-462, -279, 3], [-424, -241, 1.2], [-421, -175, 1.5], [-405, -115, 4], [-354, -80, 7], [-292, -87, 9], [-236, -135, 7.5], [-179, -182, 5.5], [-121, -213, 4.2], [-56, -204, 3.4], [-11, -155, 3], [0, -90, 3]],
    pads: [
      { dist: 150, lat: 0 }, { dist: 400, lat: -3 }, { dist: 645, lat: 3 }, { dist: 860, lat: -3 },
      { dist: 1100, lat: 4 }, { dist: 1460, lat: -3 }, { dist: 1700, lat: 0 }, { dist: 2090, lat: 0 },
    ],
    ramps: [178, 950, 1720],
    barrels: [{ dist: 120, lat: 9.2 }, { dist: 200, lat: -9.2 }, { dist: 300, lat: 9.2 }, { dist: 380, lat: -9.2 }, { dist: 470, lat: 9.2 }, { dist: 560, lat: -9.2 }, { dist: 650, lat: 9.2 }, { dist: 740, lat: -9.2 }, { dist: 830, lat: 9.2 }, { dist: 1040, lat: -9.2 }, { dist: 1150, lat: 9.2 }, { dist: 1240, lat: -9.2 }, { dist: 1380, lat: 9.2 }, { dist: 1470, lat: -9.2 }, { dist: 1580, lat: 9.2 }, { dist: 1800, lat: -9.2 }, { dist: 1900, lat: 9.2 }, { dist: 2000, lat: -9.2 }],
    // 長下坡有落石滾下來；谷底髮夾彎出來後左側有一條穿過馬蹄彎的小路
    hazards: [{ kind: 'boulder', dist: 990, len: 270, period: 2.3 }],
    shortcuts: [{ from: 1400, to: 1690, lat: 6.2, halfWidth: 5.5 }],
  },
  {
    id: 'neon-bay',
    name: '霓虹灣岸',
    desc: '夜間街道賽：直角彎、減速彎、髮夾彎與跨海大橋',
    theme: 'city',
    scenery: {
      stands: [{ from: -70, to: 170, side: -1 }, { from: 1070, to: 1150, side: -1 }, { from: 1590, to: 1690, side: 1 }, { from: 470, to: 540, side: -1 }],
      pits: [{ from: 12, to: 140, side: 1 }],
      tents: [{ from: 600, to: 760, side: 0 }, { from: 1400, to: 1500, side: 0 }],
      arches: [700, 1758],
    },
    laps: 2,
    halfWidth: 12,
    points: [
      // 起跑直線
      [0, 0, 0.6], [0, 72, 0.6], [0, 147, 0.6], [0, 205, 0.6],
      // 第一個直角彎，接港邊直線（第一座跳台）
      [25, 230, 0.6], [83, 230, 0.6], [190, 230, 0.6],
      // 減速彎
      [250, 230, 0.6], [285, 260, 0.6], [345, 260, 0.6],
      // 直角右彎往南
      [405, 260, 0.6], [433, 232, 0.6], [433, 175.5, 0.6],
      // 直角左彎往東
      [433, 119, 0.6], [459, 93, 0.6], [519, 93, 0.6],
      // 第二座跳台直線，接髮夾彎
      [625, 93, 0.6], [690, 93, 0.6], [728, 55, 0.6], [690, 17, 0.6], [633, 17, 0.6], [576, 17, 0.6],
      // 直角右彎往南
      [516, 17, 0.6], [490, -9, 0.6], [490, -65.5, 0.6],
      // 直角右彎往西
      [490, -122, 0.6], [462, -150, 0.8],
      // 跨海大橋
      [402, -150, 2.4], [323.25, -150, 6.3], [244.5, -150, 9.3], [165.75, -150, 6.3], [87, -150, 2.4],
      // 最後一個直角彎回到起跑直線
      [27, -150, 0.8], [0, -123, 0.6], [0, -63, 0.6],
    ],
    pads: [
      { dist: 120, lat: 0 }, { dist: 420, lat: -4 }, { dist: 980, lat: 4 }, { dist: 1250, lat: 0 },
      { dist: 1440, lat: 3 }, { dist: 1600, lat: -3 }, { dist: 1880, lat: 3 }, { dist: 2090, lat: 0 },
    ],
    ramps: [320, 900, 1690],
    barrels: [{ dist: 150, lat: 9.2 }, { dist: 230, lat: -9.2 }, { dist: 400, lat: 9.2 }, { dist: 520, lat: -9.2 }, { dist: 600, lat: 9.2 }, { dist: 700, lat: -9.2 }, { dist: 760, lat: 9.2 }, { dist: 970, lat: -9.2 }, { dist: 1040, lat: 9.2 }, { dist: 1160, lat: -9.2 }, { dist: 1270, lat: 9.2 }, { dist: 1360, lat: -9.2 }, { dist: 1450, lat: 9.2 }, { dist: 1520, lat: -9.2 }, { dist: 1650, lat: 9.2 }, { dist: 1800, lat: -9.2 }, { dist: 1950, lat: 9.2 }, { dist: 2030, lat: -9.2 }],
    // 第二座跳台後的平交道會有電車通過；髮夾彎出來後右側有一條穿過街區的小巷
    hazards: [{ kind: 'tram', dist: 1000, period: 9, phase: 0.35 }],
    shortcuts: [{ from: 1170, to: 1480, lat: -6.2, halfWidth: 5.5 }],
  },
  {
    id: 'neon-heights',
    name: '星港高架',
    desc: '夜港高架：連續直角彎、S 彎、雙髮夾彎、四座跳台與後巷捷徑',
    theme: 'city',
    scenery: {stands: [{from: -70, to: 110, side: 1}, {from: 1633, to: 1679, side: -1}, {from: 472, to: 537, side: -1}], pits: [{from: 12, to: 140, side: -1}], tents: [{from: 402, to: 502, side: 1}, {from: 827, to: 947, side: -1}, {from: 1717, to: 1801, side: 0}], arches: [815, 1284, 2277]},
    laps: 2,
    halfWidth: 12,
    points: [
      [0, 0, 0.6], [0, 22, 0.6], [0, 43.9, 0.6], [0, 65.9, 0.6], [0, 87.9, 0.6], [0, 109.8, 0.6],
      [-0.1, 131.8, 0.6], [4, 153.1, 0.6], [21.9, 164.7, 0.6], [43.9, 165.2, 0.6], [66, 165.2, 0.6], [87.9, 166.3, 0.6],
      [106.5, 177.4, 0.6], [121.5, 193.5, 0.6], [142, 199.6, 0.6], [161.5, 190.4, 0.6], [176.3, 174.1, 0.6], [196.1, 165.6, 0.6],
      [218.1, 165.3, 0.6], [240.1, 165.3, 0.6], [262.1, 165.2, 0.6], [284.1, 165.2, 0.6], [306, 165.2, 0.6], [328, 165.2, 0.6],
      [350, 165.2, 0.6], [371.9, 163.6, 0.6], [387.3, 149, 0.6], [389.3, 127.2, 0.6], [389.3, 105.2, 0.6], [389.3, 83.2, 0.6],
      [389.8, 61.2, 0.6], [401, 43.1, 0.6], [422.2, 38.7, 0.6], [444.2, 38.8, 1.91], [466.2, 38.8, 3.23], [488.1, 40.3, 4.56],
      [503.6, 54.8, 5.89], [505.8, 76.5, 7.21], [505.8, 98.5, 8.54], [505.8, 120.5, 9.87], [505.8, 142.4, 11.19], [505.8, 164.4, 12.52],
      [505.8, 186.4, 13.85], [505.8, 208.3, 15.17], [505.9, 230.3, 16.05], [511.4, 251.4, 16.19], [526, 267.5, 16.33], [546.5, 274.8, 16.47],
      [568.1, 271.7, 16.61], [585.6, 258.8, 16.75], [595.1, 239.2, 16.89], [596.2, 217.3, 16.68], [596.2, 195.3, 15.16], [596.2, 173.4, 13.64],
      [596.2, 151.4, 12.13], [596.3, 129.4, 10.61], [596.3, 107.5, 9.09], [596.2, 85.5, 7.57], [596.2, 63.5, 6.06], [596.2, 41.6, 4.54],
      [596.2, 19.5, 3.02], [595, -2.4, 2.37], [581.4, -18.6, 2.17], [559.7, -21.3, 1.99], [537.7, -21.2, 1.96], [515.7, -21.3, 1.93],
      [493.7, -21.5, 1.89], [474.4, -31, 1.86], [468, -51.4, 1.83], [478.5, -70.1, 1.79], [499.2, -76, 1.76], [521.2, -76, 1.73],
      [543.2, -76, 1.69], [565.2, -76, 1.66], [586.9, -78.6, 1.63], [601.6, -94.3, 1.59], [600.2, -115.6, 1.56], [583.8, -129.3, 1.52],
      [561.9, -130.8, 1.49], [539.9, -130.8, 1.46], [517.9, -130.8, 1.43], [495.9, -130.8, 1.4], [473.9, -130.8, 1.37], [451.9, -130.8, 1.35],
      [430, -131.8, 1.32], [413.2, -144.9, 1.29], [406.7, -165.9, 1.26], [394.6, -183.6, 1.23], [373.3, -187.8, 1.2], [351.3, -187.7, 1.17],
      [329.3, -187.7, 1.14], [307.5, -185.7, 1.11], [292.6, -170.5, 1.08], [286.4, -149.4, 1.05], [272.3, -133.4, 1.02], [250.7, -130.8, 0.99],
      [228.7, -130.8, 0.96], [206.7, -130.8, 0.93], [184.7, -130.8, 0.9], [162.8, -131.8, 0.87], [142.3, -139.7, 0.84], [120.8, -139.1, 0.81],
      [100.4, -131.4, 0.77], [78.4, -130.8, 0.74], [56.4, -130.8, 0.71], [34.4, -130.9, 0.68], [13, -127.3, 0.65], [0.7, -109.9, 0.62],
      [0, -87.9, 0.6], [0, -65.9, 0.6], [0, -43.9, 0.6], [0, -22, 0.6],
    ],
    pads: [{dist: 396, lat: 0}, {dist: 712, lat: 3.5}, {dist: 835, lat: 0}, {dist: 1139, lat: 0}, {dist: 1390, lat: -3.5}, {dist: 1548, lat: 3.5}, {dist: 1721, lat: 0}, {dist: 2094, lat: 3.5}, {dist: 2254, lat: 3.5}, {dist: 2373, lat: -3.5}],
    ramps: [437, 867, 1179, 1755],
    barrels: [{dist: 150, lat: 9.2}, {dist: 272, lat: -9.2}, {dist: 382, lat: 9.2}, {dist: 516, lat: -9.2}, {dist: 638, lat: 9.2}, {dist: 760, lat: -9.2}, {dist: 906, lat: 9.2}, {dist: 1004, lat: -9.2}, {dist: 1126, lat: 9.2}, {dist: 1248, lat: -9.2}, {dist: 1370, lat: 9.2}, {dist: 1492, lat: -9.2}, {dist: 1614, lat: 9.2}, {dist: 1858, lat: -9.2}, {dist: 1980, lat: -9.2}, {dist: 2078, lat: -9.2}, {dist: 2224, lat: 9.2}, {dist: 2346, lat: -9.2}],
    hazards: [{kind: 'tram', dist: 2124, period: 9, phase: 0.6}],
    shortcuts: [{from: 1836, to: 2072, lat: 6.2, halfWidth: 5.5}],
  },
  {
    id: 'forest-jump',
    name: '金林飛躍',
    desc: '林間四連跳台、四個髮夾彎與連續 S 彎，Ω 彎口有林道捷徑',
    theme: 'meadow',
    scenery: {stands: [{from: -70, to: 170, side: 1}, {from: 800, to: 870, side: 1}, {from: 1225, to: 1335, side: 1}, {from: 1895, to: 1960, side: 1}], pits: [{from: 12, to: 140, side: -1}], tents: [{from: 540, to: 640, side: -1}, {from: 1395, to: 1470, side: 1}, {from: 2140, to: 2290, side: 0}], arches: [455, 770, 2340]},
    laps: 2,
    halfWidth: 12,
    points: [
      [0, 0, 4], [0, 34.9, 4.1], [0, 69.9, 4.2], [0, 104.8, 4.3], [-1.8, 133.4, 4.4], [-17.1, 157.2, 4.6],
      [-43.2, 168.2, 5.1], [-71.9, 170.3, 5.6], [-92.2, 171.8, 5.9], [-112.3, 170.4, 6.3], [-128.4, 158.5, 6.6], [-135, 139.5, 6.9],
      [-135, 119.2, 7.3], [-135, 103, 7.5], [-136.2, 86.9, 7.8], [-145.3, 73.8, 8], [-160.1, 68.1, 8.2], [-175.6, 71.7, 8.4],
      [-186.4, 83.4, 8.6], [-189, 99.2, 8.9], [-189, 115.4, 9.2], [-189, 131.6, 9.4], [-190.7, 151.7, 9.7], [-202.4, 168, 10.2],
      [-221.2, 175, 11.2], [-241.5, 175.8, 12.1], [-259.6, 184.7, 13.1], [-276.6, 201.6, 14.1], [-294, 218, 15.1], [-316.6, 225, 16.4],
      [-340.5, 225, 17.7], [-371.7, 225, 17.4], [-405.9, 225, 16.5], [-432.2, 225, 15.9], [-447.8, 225, 15.5], [-463.3, 225, 15.1],
      [-478.7, 223.1, 14.8], [-490.6, 213.5, 14.4], [-495, 198.8, 14.2], [-490.4, 184.2, 14.1], [-478.3, 174.7, 13.9], [-462.9, 172.9, 13.7],
      [-448.1, 168.6, 13.6], [-436.6, 158.4, 13.4], [-430.2, 141.8, 13], [-429.3, 123.9, 12.6], [-420.5, 108.5, 12.3], [-407.8, 95.8, 12],
      [-398.4, 80.7, 11.6], [-399.1, 63.1, 11.4], [-409.4, 48.6, 11.3], [-422.1, 35.9, 11.1], [-429.7, 19.9, 11], [-430, 1.9, 11],
      [-430, -16.1, 11], [-430, -39.4, 9.9], [-430, -69.8, 8.6], [-430, -104.7, 7], [-427, -131.3, 5.8], [-410.5, -152.1, 5],
      [-385.1, -160, 5], [-359.7, -152.2, 5], [-343.1, -131.5, 5.6], [-340, -105, 6.5], [-340, -84, 7.3], [-338, -63.3, 8],
      [-325.6, -46.7, 8.7], [-306.1, -40, 9.3], [-285.1, -40, 9.9], [-264.2, -40, 10.5], [-236.9, -40, 10.3], [-202, -40, 10],
      [-181, -40, 9.8], [-160.2, -41.4, 9.6], [-143, -52.8, 9.4], [-135.1, -71.9, 8.6], [-135, -92.8, 7.9], [-135, -113.8, 7.1],
      [-135, -141.1, 6.1], [-135, -176, 4.9], [-135, -198.8, 4.1], [-133.8, -221.4, 3.2], [-122.1, -240.5, 2.5], [-108.7, -248.2, 2.4],
      [-93.3, -250, 2.2], [-77.8, -251.3, 2.1], [-65.3, -260.2, 2], [-60, -274.6, 2], [-56.7, -289.6, 2], [-45.7, -300.2, 2],
      [-30.5, -302.8, 2], [-16.6, -296.3, 2], [-8.7, -283.2, 2], [-6.7, -267.8, 2], [2.2, -255.3, 2], [16.6, -250, 1.9],
      [32.2, -250, 1.9], [47.8, -250, 1.9], [68, -250, 1.8], [94.3, -250, 1.7], [128.6, -250, 1.6], [155.2, -247.4, 1.6],
      [176.4, -231.4, 1.6], [185, -206.3, 2], [185, -182.3, 2.4], [183.3, -158.5, 2.7], [170.2, -138.9, 3], [148.3, -130.1, 3.2],
      [124.3, -130, 3.3], [100.4, -130, 3.5], [69.2, -130, 3.6], [45.3, -130, 3.8], [22, -125.7, 3.9], [5, -109.3, 4],
      [0, -86.2, 4], [0, -62.3, 4], [0, -31.1, 4],
    ],
    pads: [{dist: 210, lat: -4}, {dist: 450, lat: 0}, {dist: 686, lat: 0}, {dist: 1110, lat: 3}, {dist: 1360, lat: 4}, {dist: 1482, lat: 0}, {dist: 1668, lat: 0}, {dist: 2022, lat: -4}, {dist: 2325, lat: 3}],
    ramps: [715, 1140, 1509, 1698],
    barrels: [{dist: 240, lat: 9.2}, {dist: 320, lat: -9.2}, {dist: 395, lat: -9.2}, {dist: 500, lat: 9.2}, {dist: 640, lat: 9.2}, {dist: 775, lat: -9.2}, {dist: 890, lat: 9.2}, {dist: 1000, lat: -9.2}, {dist: 1070, lat: 9.2}, {dist: 1195, lat: -9.2}, {dist: 1285, lat: 9.2}, {dist: 1415, lat: -9.2}, {dist: 1555, lat: 9.2}, {dist: 1745, lat: -9.2}, {dist: 1925, lat: 9.2}, {dist: 2150, lat: -9.2}, {dist: 2250, lat: 9.2}, {dist: 2360, lat: -9.2}],
    hazards: [{kind: 'hammer', dist: 2040, period: 3.4}, {kind: 'hammer', dist: 2090, period: 3.4, phase: 0.3}],
    shortcuts: [{from: 1840, to: 2010, lat: -6.2, via: [[-31.6, -231.7]], halfWidth: 5.5}],
  },
];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 封閉賽道：把控制點平滑成等距取樣點，提供「最近點／橫向偏移／高度」查詢。 */
export class Track {
  samples: Sample[] = [];
  n = 0;
  length = 0;
  spacing = 1.5;
  halfWidth: number;
  laps: number;
  def: TrackDef;
  pads: BoostPad[];
  ramps: number[];
  /** 最近一次 locate() 算出的橫向偏移（左為正） */
  lat = 0;
  /** 最近一次 locate() 算出的沿切線偏移；明顯超過取樣間距表示找到的不是真正的最近點 */
  along = 0;
  branches: Branch[] = [];
  /** 封閉賽道（捷徑是不封閉的） */
  readonly closed = true;

  constructor(def: TrackDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.laps = def.laps;
    const P = def.points;
    const m = P.length;
    const dense: [number, number, number][] = [];
    const SUB = 32;
    for (let i = 0; i < m; i++) {
      const a = P[(i - 1 + m) % m], b = P[i], c = P[(i + 1) % m], d = P[(i + 2) % m];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB;
        dense.push([catmull(a[0], b[0], c[0], d[0], t), catmull(a[1], b[1], c[1], d[1], t), catmull(a[2], b[2], c[2], d[2], t)]);
      }
    }
    const L = dense.length;
    const cum = new Float64Array(L + 1);
    for (let j = 0; j < L; j++) {
      const p = dense[j], q = dense[(j + 1) % L];
      cum[j + 1] = cum[j] + Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
    this.length = cum[L];
    this.n = Math.round(this.length / 1.5);
    this.spacing = this.length / this.n;
    const pts: [number, number, number][] = [];
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const d = i * this.spacing;
      while (j < L - 1 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = (d - cum[j]) / seg;
      const p = dense[j], q = dense[(j + 1) % L];
      pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
    }
    const n = this.n;

    // 高度做幾次平滑，避免曲線過衝造成路面抖動
    let ys = pts.map((p) => p[2]);
    for (let pass = 0; pass < 3; pass++) {
      const out = new Array<number>(n);
      const R = 6;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -R; k <= R; k++) s += ys[(i + k + n) % n];
        out[i] = s / (2 * R + 1);
      }
      ys = out;
    }

    const ang: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      ang.push(Math.atan2(tx, tz));
      const slope = (ys[(i + 1) % n] - ys[(i - 1 + n) % n]) / (2 * this.spacing);
      this.samples.push({ x: pts[i][0], z: pts[i][1], y: ys[i], slope, tx, tz, nx: tz, nz: -tx, dist: i * this.spacing, curv: 0 });
    }
    const raw: number[] = [];
    for (let i = 0; i < n; i++) {
      let da = ang[(i + 1) % n] - ang[(i - 1 + n) % n];
      da = Math.atan2(Math.sin(da), Math.cos(da));
      raw.push(da / (2 * this.spacing));
    }
    const R = 4;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += raw[(i + k + n) % n];
      this.samples[i].curv = s / (2 * R + 1);
    }
    this.ramps = def.ramps.map((d) => ((d % this.length) + this.length) % this.length);
    this.pads = def.pads.map((p) => ({ dist: ((p.dist % this.length) + this.length) % this.length, lat: p.lat }));
    this.branches = (def.shortcuts ?? []).map((sc) => new Branch(this, sc));
  }

  /**
   * 爆炸桶實際擺放的位置：放在彎道（尤其內側）上會讓人避不開，
   * 所以往前後找最近的直線段；也避開跳台、機關與捷徑出入口，找不到就不放。
   */
  barrelSpots(): BoostPad[] {
    const L = this.length;
    const rel = (a: number, b: number) => {
      let d = (a - b) % L;
      if (d > L / 2) d -= L;
      else if (d < -L / 2) d += L;
      return d;
    };
    const curvAt = (d: number) => this.samples[this.wrap(Math.round(d / this.spacing))].curv;
    // 直線段；或是緩彎的外側（彎道內側一律不放）
    const fits = (d: number, lat: number) => {
      for (let k = -32; k <= 32; k += 3) {
        const c = curvAt(d + k);
        if (Math.abs(c) <= 0.008) continue;
        if (Math.abs(c) > 0.016 || Math.sign(c) === Math.sign(lat)) return false;
      }
      return true;
    };
    const avoid: [number, number][] = this.ramps.map((r) => [r, 32]);
    for (const h of this.def.hazards ?? []) avoid.push([h.dist + (h.len ?? 0) / 2, 22 + (h.len ?? 0) / 2]);
    for (const sc of this.def.shortcuts ?? []) avoid.push([sc.from, 28], [sc.to, 28]);
    avoid.push([0, 30]);
    const out: BoostPad[] = [];
    const taken = (d: number, lat: number) => out.some((o) => Math.abs(rel(o.dist, d)) < 14 && Math.sign(o.lat) === Math.sign(lat));
    const ok = (d: number, lat: number) => fits(d, lat) && !avoid.some(([c, r]) => Math.abs(rel(d, c)) < r) && !taken(d, lat);
    for (const b of this.def.barrels) {
      let found: number | null = null;
      for (let k = 0; k <= 120 && found === null; k += 5) {
        for (const sg of [1, -1]) {
          const d = b.dist + sg * k;
          if (ok(d, b.lat)) { found = d; break; }
        }
      }
      if (found !== null) out.push({ dist: ((found % L) + L) % L, lat: b.lat });
    }
    return out;
  }

  /** 主線上任意距離的位置（在取樣點之間內插） */
  pointAt(dist: number): { x: number; z: number; y: number; tx: number; tz: number; nx: number; nz: number } {
    const L = this.length;
    const f = ((((dist % L) + L) % L) / this.spacing);
    const i = Math.floor(f) % this.n, u = f - Math.floor(f);
    const a = this.samples[i], b = this.samples[(i + 1) % this.n];
    let tx = a.tx + (b.tx - a.tx) * u, tz = a.tz + (b.tz - a.tz) * u;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, y: a.y + (b.y - a.y) * u, tx, tz, nx: tz, nz: -tx };
  }

  /** 位置落在哪一條捷徑的範圍框內（只是粗略篩選） */
  branchNear(x: number, z: number): Branch | null {
    for (const b of this.branches) if (b.inBox(x, z)) return b;
    return null;
  }

  /**
   * 子彈、火箭、地雷這類物件用的路面查詢：回傳離 (x,z) 最近的主線取樣點，
   * 並把「是否在路面上（主線或捷徑）」與路面高度寫進 this.probeOn / this.probeY。
   */
  probeOn = true;
  probeY = 0;
  probe(x: number, z: number, hint: number, margin = 0.4): number {
    const idx = this.locate(x, z, hint, 45);
    const lat = this.lat;
    const onMain = Math.abs(lat) <= this.halfWidth + margin && Math.abs(this.along) < this.spacing * 2;
    this.probeOn = onMain;
    this.probeY = this.heightAt(idx, x, z);
    if (!onMain) {
      const b = this.branchNear(x, z);
      if (b) {
        const bi = b.locate(x, z);
        if (Math.abs(b.lat) <= b.halfWidth + margin && b.inside()) {
          this.probeOn = true;
          this.probeY = b.heightAt(bi, x, z);
        }
      }
    }
    this.lat = lat;
    return idx;
  }

  wrap(i: number): number {
    const n = this.n;
    return ((i % n) + n) % n;
  }

  /** 找離 (x,z) 最近的取樣點索引；hint < 0 時做全域搜尋。橫向偏移寫入 this.lat。 */
  locate(x: number, z: number, hint: number, win = 30): number {
    const n = this.n;
    const S = this.samples;
    let best = 0;
    let bd = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let k = -win; k <= win; k++) {
        const i = (((hint + k) % n) + n) % n;
        const dx = x - S[i].x, dz = z - S[i].z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    const s = S[best];
    this.lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    this.along = (x - s.x) * s.tx + (z - s.z) * s.tz;
    return best;
  }

  /** 已知最近取樣點 idx 時，(x,z) 處的路面高度 */
  heightAt(idx: number, x: number, z: number): number {
    const s = this.samples[idx];
    return s.y + ((x - s.x) * s.tx + (z - s.z) * s.tz) * s.slope;
  }

  /** 與某個距離點的有號差距（考慮賽道首尾相接） */
  private rel(idx: number, dist: number): number {
    let d = this.samples[idx].dist - dist;
    if (d > this.length / 2) d -= this.length;
    else if (d < -this.length / 2) d += this.length;
    return d;
  }

  /**
   * 跳台：回傳 0~1 表示車在斜坡上的進度（1 = 頂端，該起跳了），不在斜坡上回傳 -1。
   * rampLen 為斜坡長度。
   */
  rampProgress(idx: number, rampLen: number): number {
    for (const r of this.ramps) {
      const d = this.rel(idx, r);
      if (d > -rampLen && d <= 1.6) return Math.min(1, (d + rampLen) / rampLen);
    }
    return -1;
  }

  /** 車輛（idx, lat）是否踩在加速帶上 */
  onPad(idx: number, lat: number): boolean {
    const d = this.samples[idx].dist;
    for (const p of this.pads) {
      let dd = d - p.dist;
      if (dd > this.length / 2) dd -= this.length;
      else if (dd < -this.length / 2) dd += this.length;
      if (Math.abs(dd) < PAD_LENGTH / 2 && Math.abs(lat - p.lat) < PAD_HALF_WIDTH + 0.6) return true;
    }
    return false;
  }
}

/** 捷徑的路面：一條不封閉的窄路，兩端接在主線上 */
export class Branch {
  readonly closed = false;
  samples: Sample[] = [];
  n = 0;
  length = 0;
  spacing = 1.5;
  halfWidth: number;
  def: ShortcutDef;
  /** 分岔點在主線上的取樣索引，以及到接回點之間隔了幾個主線取樣點 */
  fromIdx: number;
  span: number;
  /** 最近一次 locate() 的橫向偏移與沿切線偏移 */
  lat = 0;
  along = 0;
  private lastIdx = 0;
  private box = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  constructor(track: Track, def: ShortcutDef) {
    this.def = def;
    this.halfWidth = def.halfWidth;
    this.fromIdx = track.wrap(Math.round(def.from / track.spacing));
    this.span = Math.round((def.to - def.from) / track.spacing);
    const A = track.pointAt(def.from), B = track.pointAt(def.to);
    const pts: { x: number; z: number }[] = [
      { x: A.x + A.nx * def.lat, z: A.z + A.nz * def.lat },
      ...(def.via ?? []).map(([x, z]) => ({ x, z })),
      { x: B.x + B.nx * def.lat, z: B.z + B.nz * def.lat },
    ];
    // 各點的切線方向：兩端跟主線一致，中間點取前後兩點的方向
    const tan = pts.map((p, i) => {
      if (i === 0) return { x: A.tx, z: A.tz };
      if (i === pts.length - 1) return { x: B.tx, z: B.tz };
      const dx = pts[i + 1].x - pts[i - 1].x, dz = pts[i + 1].z - pts[i - 1].z;
      const l = Math.hypot(dx, dz) || 1;
      return { x: dx / l, z: dz / l };
    });
    // 分段三次 Hermite 曲線，切線長度取該段的弦長
    const dense: { x: number; z: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const c = Math.hypot(q.x - p.x, q.z - p.z);
      const m0 = tan[i], m1 = tan[i + 1];
      for (let k = 0; k < 64; k++) {
        const t = k / 64, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        dense.push({ x: h00 * p.x + h10 * c * m0.x + h01 * q.x + h11 * c * m1.x, z: h00 * p.z + h10 * c * m0.z + h01 * q.z + h11 * c * m1.z });
      }
    }
    dense.push(pts[pts.length - 1]);
    const cum = [0];
    for (let j = 1; j < dense.length; j++) cum.push(cum[j - 1] + Math.hypot(dense[j].x - dense[j - 1].x, dense[j].z - dense[j - 1].z));
    this.length = cum[cum.length - 1];
    this.n = Math.max(2, Math.round(this.length / 1.5) + 1);
    this.spacing = this.length / (this.n - 1);
    const P: { x: number; z: number }[] = [];
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const d = i * this.spacing;
      while (j < dense.length - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      const t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
      P.push({ x: dense[j].x + (dense[j + 1].x - dense[j].x) * t, z: dense[j].z + (dense[j + 1].z - dense[j].z) * t });
    }
    const ang: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(this.n - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      ang.push(Math.atan2(tx, tz));
      // 高度：兩端接主線，中間平順過渡
      const u = i / (this.n - 1);
      const y = A.y + (B.y - A.y) * u * u * (3 - 2 * u);
      this.samples.push({ x: P[i].x, z: P[i].z, y, slope: 0, tx, tz, nx: tz, nz: -tx, dist: i * this.spacing, curv: 0 });
    }
    for (let i = 0; i < this.n; i++) {
      const a = this.samples[Math.max(0, i - 1)], b = this.samples[Math.min(this.n - 1, i + 1)];
      this.samples[i].slope = (b.y - a.y) / (b.dist - a.dist || 1);
      let da = ang[Math.min(this.n - 1, i + 1)] - ang[Math.max(0, i - 1)];
      da = Math.atan2(Math.sin(da), Math.cos(da));
      this.samples[i].curv = da / (b.dist - a.dist || 1);
    }
    const m = def.halfWidth + 12;
    this.box = {
      minX: Math.min(...P.map((p) => p.x)) - m, maxX: Math.max(...P.map((p) => p.x)) + m,
      minZ: Math.min(...P.map((p) => p.z)) - m, maxZ: Math.max(...P.map((p) => p.z)) + m,
    };
  }

  inBox(x: number, z: number): boolean {
    const b = this.box;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  /** 最近的取樣點；橫向與沿切線偏移寫入 lat / along */
  locate(x: number, z: number): number {
    const S = this.samples;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      const dx = x - S[i].x, dz = z - S[i].z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    const s = S[best];
    this.lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
    this.along = (x - s.x) * s.tx + (z - s.z) * s.tz;
    this.lastIdx = best;
    return best;
  }

  /** 最近一次 locate() 的點是否在捷徑兩端之間（超出端點的地方不算捷徑路面） */
  inside(): boolean {
    const d = this.lastIdx * this.spacing + this.along;
    return d > 0 && d < this.length;
  }

  heightAt(idx: number, x: number, z: number): number {
    const s = this.samples[idx];
    return s.y + ((x - s.x) * s.tx + (z - s.z) * s.tz) * s.slope;
  }

  /** 捷徑上的位置換算成主線的浮點進度（相對分岔點，單位為主線取樣點數） */
  progress(idx: number, along: number): number {
    const u = Math.min(1, Math.max(0, (idx * this.spacing + along) / this.length));
    return u * this.span;
  }
}
