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
      [0, -60, 11.13], [0, 40, 11.13], [0, 140, 10.43],
      // 上坡大左彎
      [25, 225, 10.78], [95, 280, 19.35], [190, 285, 28.57], [265, 240, 21.93],
      // 山頂髮夾彎
      [285, 170, 27.94], [290, 105, 22.05], [325, 68, 25.48], [360, 105, 25.75],
      // 下坡直線接右彎
      [365, 175, 20.91], [385, 250, 16.57], [435, 305, 12.55], [510, 318, 7.62], [565, 275, 13.79],
      // 連續 S 彎
      [578, 200, 6.38], [548, 140, 5.02], [578, 80, 2.45], [548, 20, 3.45], [575, -45, 5.89],
      // 第二段爬坡與山脊
      [548, -118, 13.18], [482, -165, 12.3], [400, -158, 20.96], [332, -118, 29.81], [268, -148, 30.69],
      // 長下坡回到終點
      [205, -195, 30.53], [150, -262, 27.03], [78, -300, 23.62], [12, -268, 15.3], [-4, -195, 12.04], [0, -128, 11.17],
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
    points: [[0, 0, 8.5], [0, 95, 8.47], [0, 190, 8.75], [-19, 268, 5.74], [-89, 308, 13.03], [-173, 308, 5.92], [-250, 345, 13.86], [-327, 308, 20.96], [-411, 308, 30.64], [-481, 268, 38.49], [-503, 191, 32.77], [-503, 69, 26.67], [-503, -53, 19.01], [-503, -175, 5.72], [-499, -241, 2.84], [-462, -279, 2.63], [-424, -241, 3.03], [-421, -175, 5.78], [-405, -115, 9.1], [-354, -80, 12.03], [-292, -87, 13.92], [-236, -135, 13.98], [-179, -182, 10.49], [-121, -213, 9.62], [-56, -204, 15.76], [-11, -155, 9.87], [0, -90, 8.35]],
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
      [0, 0, 4.01], [0, 72, 4], [0, 147, 4.02], [0, 205, 5.02],
      // 第一個直角彎，接港邊直線（第一座跳台）
      [25, 230, 5.44], [83, 230, 5.71], [190, 230, 4.95],
      // 減速彎
      [250, 230, 9.63], [285, 260, 9.56], [345, 260, 14.73],
      // 直角右彎往南
      [405, 260, 9.03], [433, 232, 11.01], [433, 175.5, 16.2],
      // 直角左彎往東
      [433, 119, 11], [459, 93, 11.95], [519, 93, 9.6],
      // 第二座跳台直線，接髮夾彎
      [625, 93, 7.7], [690, 93, 7.53], [728, 55, 9.28], [690, 17, 3.58], [633, 17, 6.12], [576, 17, 11.35],
      // 直角右彎往南
      [516, 17, 6.13], [490, -9, 7.62], [490, -65.5, 7.79],
      // 直角右彎往西
      [490, -122, 8.4], [462, -150, 4.12],
      // 跨海大橋
      [402, -150, 6.68], [323.25, -150, 10.91], [244.5, -150, 14.86], [165.75, -150, 21.15], [87, -150, 14.87],
      // 最後一個直角彎回到起跑直線
      [27, -150, 8.47], [0, -123, 4.83], [0, -63, 4.06],
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
      [0, 0, 3], [0, 22, 3], [0, 43.9, 3], [0, 65.9, 3], [0, 87.9, 3], [0, 109.8, 3.01],
      [-0.1, 131.8, 2.98], [4, 153.1, 3.18], [21.9, 164.7, 3.7], [43.9, 165.2, 4.14], [66, 165.2, 4.97], [87.9, 166.3, 5.81],
      [106.5, 177.4, 6.04], [121.5, 193.5, 5.85], [142, 199.6, 5.57], [161.5, 190.4, 5.18], [176.3, 174.1, 4.81], [196.1, 165.6, 4.16],
      [218.1, 165.3, 3.86], [240.1, 165.3, 3.68], [262.1, 165.2, 3.48], [284.1, 165.2, 3.24], [306, 165.2, 2.99], [328, 165.2, 2.96],
      [350, 165.2, 4.91], [371.9, 163.6, 5.14], [387.3, 149, 5.87], [389.3, 127.2, 5.98], [389.3, 105.2, 8.56], [389.3, 83.2, 11.02],
      [389.8, 61.2, 13.71], [401, 43.1, 15.71], [422.2, 38.7, 18.45], [444.2, 38.8, 20.02], [466.2, 38.8, 18.92], [488.1, 40.3, 16.56],
      [503.6, 54.8, 16.74], [505.8, 76.5, 18.54], [505.8, 98.5, 19.71], [505.8, 120.5, 20.94], [505.8, 142.4, 22.1], [505.8, 164.4, 23.32],
      [505.8, 186.4, 23.92], [505.8, 208.3, 26.38], [505.9, 230.3, 28.95], [511.4, 251.4, 31.39], [526, 267.5, 31.72], [546.5, 274.8, 32.05],
      [568.1, 271.7, 31.99], [585.6, 258.8, 31.96], [595.1, 239.2, 32.1], [596.2, 217.3, 31.61], [596.2, 195.3, 30.48], [596.2, 173.4, 29.27],
      [596.2, 151.4, 28.21], [596.3, 129.4, 26.94], [596.3, 107.5, 26.83], [596.2, 85.5, 24.51], [596.2, 63.5, 21.91], [596.2, 41.6, 19.36],
      [596.2, 19.5, 16.75], [595, -2.4, 14.53], [581.4, -18.6, 14.09], [559.7, -21.3, 16.19], [537.7, -21.2, 17.79], [515.7, -21.3, 16.78],
      [493.7, -21.5, 13.99], [474.4, -31, 11.91], [468, -51.4, 9.18], [478.5, -70.1, 7.36], [499.2, -76, 6.88], [521.2, -76, 9.12],
      [543.2, -76, 10.41], [565.2, -76, 9.08], [586.9, -78.6, 6.17], [601.6, -94.3, 5.34], [600.2, -115.6, 4.56], [583.8, -129.3, 4.05],
      [561.9, -130.8, 3.99], [539.9, -130.8, 4.01], [517.9, -130.8, 3.99], [495.9, -130.8, 4.04], [473.9, -130.8, 4.18], [451.9, -130.8, 4.38],
      [430, -131.8, 4.79], [413.2, -144.9, 5.04], [406.7, -165.9, 6.83], [394.6, -183.6, 7.17], [373.3, -187.8, 7.85], [351.3, -187.7, 8.08],
      [329.3, -187.7, 7.4], [307.5, -185.7, 6.3], [292.6, -170.5, 5.8], [286.4, -149.4, 5.3], [272.3, -133.4, 4.99], [250.7, -130.8, 5.01],
      [228.7, -130.8, 5], [206.7, -130.8, 5], [184.7, -130.8, 5], [162.8, -131.8, 5], [142.3, -139.7, 5.03], [120.8, -139.1, 5.46],
      [100.4, -131.4, 4.62], [78.4, -130.8, 6.85], [56.4, -130.8, 8.14], [34.4, -130.9, 6.77], [13, -127.3, 4.07], [0.7, -109.9, 3.3],
      [0, -87.9, 2.99], [0, -65.9, 3.01], [0, -43.9, 3], [0, -22, 3],
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
      [0, 0, 7.87], [0, 34.9, 7.66], [0, 69.9, 7.83], [0, 104.8, 8.08], [-1.8, 133.4, 7.84], [-17.1, 157.2, 9.17],
      [-43.2, 168.2, 12.58], [-71.9, 170.3, 15.1], [-92.2, 171.8, 14.52], [-112.3, 170.4, 12.32], [-128.4, 158.5, 9.95], [-135, 139.5, 10.2],
      [-135, 119.2, 10.79], [-135, 103, 11], [-136.2, 86.9, 13.18], [-145.3, 73.8, 13.75], [-160.1, 68.1, 15.4], [-175.6, 71.7, 17.68],
      [-186.4, 83.4, 17.91], [-189, 99.2, 20.47], [-189, 115.4, 21.13], [-189, 131.6, 20.89], [-190.7, 151.7, 18.41], [-202.4, 168, 18.39],
      [-221.2, 175, 19.69], [-241.5, 175.8, 22.17], [-259.6, 184.7, 24.42], [-276.6, 201.6, 27.27], [-294, 218, 30.09], [-316.6, 225, 32.85],
      [-340.5, 225, 35.34], [-371.7, 225, 34.39], [-405.9, 225, 32.93], [-432.2, 225, 31.98], [-447.8, 225, 31.2], [-463.3, 225, 30.4],
      [-478.7, 223.1, 29.32], [-490.6, 213.5, 27.76], [-495, 198.8, 26.21], [-490.4, 184.2, 24.12], [-478.3, 174.7, 22.93], [-462.9, 172.9, 22.56],
      [-448.1, 168.6, 20], [-436.6, 158.4, 18.98], [-430.2, 141.8, 17.56], [-429.3, 123.9, 16.15], [-420.5, 108.5, 14.71], [-407.8, 95.8, 13.25],
      [-398.4, 80.7, 11.82], [-399.1, 63.1, 10.44], [-409.4, 48.6, 9.11], [-422.1, 35.9, 7.82], [-429.7, 19.9, 6.25], [-430, 1.9, 5.89],
      [-430, -16.1, 5.22], [-430, -39.4, 5.44], [-430, -69.8, 5.09], [-430, -104.7, 4.6], [-427, -131.3, 5.1], [-410.5, -152.1, 6.26],
      [-385.1, -160, 8.13], [-359.7, -152.2, 10.31], [-343.1, -131.5, 11.91], [-340, -105, 14.46], [-340, -84, 14.29], [-338, -63.3, 12.16],
      [-325.6, -46.7, 10.93], [-306.1, -40, 10.58], [-285.1, -40, 9.52], [-264.2, -40, 8.83], [-236.9, -40, 7.95], [-202, -40, 6.59],
      [-181, -40, 5.99], [-160.2, -41.4, 6.03], [-143, -52.8, 6.32], [-135.1, -71.9, 6.77], [-135, -92.8, 8.17], [-135, -113.8, 9.26],
      [-135, -141.1, 9.36], [-135, -176, 9.35], [-135, -198.8, 9.27], [-133.8, -221.4, 12.3], [-122.1, -240.5, 12.94], [-108.7, -248.2, 13.38],
      [-93.3, -250, 13.77], [-77.8, -251.3, 14.27], [-65.3, -260.2, 14.82], [-60, -274.6, 15.45], [-56.7, -289.6, 16.09], [-45.7, -300.2, 16.77],
      [-30.5, -302.8, 17.41], [-16.6, -296.3, 18.11], [-8.7, -283.2, 18.57], [-6.7, -267.8, 19.35], [2.2, -255.3, 19.2], [16.6, -250, 20.18],
      [32.2, -250, 20.08], [47.8, -250, 20.33], [68, -250, 20.5], [94.3, -250, 20.47], [128.6, -250, 20.16], [155.2, -247.4, 19.83],
      [176.4, -231.4, 19.09], [185, -206.3, 18.1], [185, -182.3, 17.09], [183.3, -158.5, 16.23], [170.2, -138.9, 14.62], [148.3, -130.1, 13.86],
      [124.3, -130, 16.2], [100.4, -130, 16.58], [69.2, -130, 13.37], [45.3, -130, 12.01], [22, -125.7, 8.95], [5, -109.3, 7.48],
      [0, -86.2, 7.74], [0, -62.3, 7.64], [0, -31.1, 7.64],
    ],
    pads: [{dist: 210, lat: -4}, {dist: 450, lat: 0}, {dist: 686, lat: 0}, {dist: 1110, lat: 3}, {dist: 1360, lat: 4}, {dist: 1482, lat: 0}, {dist: 1668, lat: 0}, {dist: 2022, lat: -4}, {dist: 2325, lat: 3}],
    ramps: [715, 1140, 1509, 1698],
    barrels: [{dist: 240, lat: 9.2}, {dist: 320, lat: -9.2}, {dist: 395, lat: -9.2}, {dist: 500, lat: 9.2}, {dist: 640, lat: 9.2}, {dist: 775, lat: -9.2}, {dist: 890, lat: 9.2}, {dist: 1000, lat: -9.2}, {dist: 1070, lat: 9.2}, {dist: 1195, lat: -9.2}, {dist: 1285, lat: 9.2}, {dist: 1415, lat: -9.2}, {dist: 1555, lat: 9.2}, {dist: 1745, lat: -9.2}, {dist: 1925, lat: 9.2}, {dist: 2150, lat: -9.2}, {dist: 2250, lat: 9.2}, {dist: 2360, lat: -9.2}],
    hazards: [{kind: 'hammer', dist: 2040, period: 3.4}, {kind: 'hammer', dist: 2090, period: 3.4, phase: 0.3}],
    shortcuts: [{from: 1840, to: 2010, lat: -6.2, via: [[-31.6, -231.7]], halfWidth: 5.5}],
  },
  {
    id: 'canyon-rush',
    name: '烈日台地',
    desc: '長坡攀上紅岩台地、三髮夾彎與四道駝峰，飛石俯衝後有峽谷捷徑',
    theme: 'desert',
    scenery: {stands: [{from: -70, to: 110, side: 1}, {from: 829, to: 898, side: -1}, {from: 1187, to: 1222, side: 1}, {from: 2004, to: 2081, side: -1}], pits: [{from: 12, to: 140, side: -1}], tents: [{from: 194, to: 274, side: -1}, {from: 908, to: 990, side: 1}, {from: 2066, to: 2115, side: -1}], arches: [584, 1682, 2687]},
    laps: 2,
    halfWidth: 12,
    points: [
      [0, 0, 6], [0, 11, 6], [0, 22, 5.99], [0, 33, 6.01], [0, 44, 5.99], [0, 55, 6.01],
      [0, 66, 5.99], [0, 77, 6.01], [0, 87.9, 5.99], [0, 98.9, 6], [0, 109.9, 6.02], [0, 120.9, 5.96],
      [-0.4, 131.9, 6.09], [-3.5, 142.4, 6.19], [-10.1, 151.1, 6.24], [-19.4, 156.9, 6.37], [-30.1, 159.1, 6.44], [-41.1, 159.3, 6.47],
      [-52.1, 159.3, 6.85], [-63.1, 159.3, 6.95], [-74.1, 159.3, 7.26], [-85.1, 159.3, 7.41], [-96.1, 159.3, 7.69], [-107.1, 159.3, 7.86],
      [-118, 159.3, 8.11], [-129, 159.3, 8.34], [-140, 159.3, 8.46], [-151, 159.8, 9.02], [-161.7, 162.2, 9.3], [-171.5, 167.1, 9.72],
      [-179.9, 174.1, 10.11], [-186.4, 183, 10.47], [-190.6, 193.1, 10.87], [-192.4, 204, 11.27], [-192.6, 214.9, 11.64], [-192.6, 225.9, 12.03],
      [-192.6, 236.9, 12.41], [-192.6, 247.9, 12.82], [-192.6, 258.9, 13.13], [-193.1, 269.9, 13.7], [-196.1, 280.4, 14.18], [-201.9, 289.8, 14.65],
      [-208.9, 298.2, 15.17], [-214.8, 307.5, 15.67], [-217.4, 318.1, 16.1], [-216, 329, 16.73], [-210.9, 338.7, 17.05], [-204, 347.2, 17.79],
      [-197.7, 356.2, 17.92], [-193.7, 366.4, 18.91], [-192.6, 377.3, 18.8], [-192.6, 388.3, 19.87], [-192.6, 399.3, 21.33], [-192.6, 410.3, 21.95],
      [-192.6, 421.3, 23.54], [-192.6, 432.3, 24.2], [-192.6, 443.3, 25.65], [-192.6, 454.3, 26.54], [-192, 465.2, 27.53], [-189.8, 476, 28.66],
      [-185.9, 486.3, 29.43], [-180.9, 496, 30.66], [-176.1, 505.9, 31.41], [-172.8, 516.4, 32.59], [-171.2, 527.3, 33.48], [-171, 538.3, 34.43],
      [-171, 549.2, 35.69], [-171, 560.2, 36.52], [-171, 571.2, 38.06], [-171, 582.2, 38.49], [-171, 593.2, 40.48], [-171, 604.2, 40.64],
      [-171, 615.2, 41], [-171, 626.2, 40.08], [-171, 637.2, 39.18], [-171, 648.2, 38.12], [-170.6, 659.2, 38.5], [-168.1, 669.8, 38.49],
      [-162.8, 679.4, 38.28], [-155.1, 687.2, 38.58], [-145.6, 692.6, 38.26], [-134.9, 695.3, 38.57], [-123.9, 695.7, 38.29], [-112.9, 695.7, 38.55],
      [-102, 695.7, 38.48], [-91, 695.7, 38.6], [-80, 695.7, 38.63], [-69, 695.7, 38.69], [-58, 695.7, 38.75], [-47, 695.7, 38.8],
      [-36, 695.7, 38.86], [-25, 695.7, 38.91], [-14.2, 693.9, 38.99], [-4.4, 689, 39.04], [3.8, 681.7, 39.12], [11.9, 674.2, 39.17],
      [21.3, 668.7, 39.25], [32.1, 667, 39.31], [42.8, 669.2, 39.37], [52.1, 675, 39.46], [60.1, 682.6, 39.48], [68.4, 689.7, 39.61],
      [78.4, 694.2, 39.6], [89.2, 695.7, 39.74], [100.2, 695.7, 39.76], [111.2, 695.7, 39.68], [122.2, 695.7, 39.81], [133.1, 697.1, 39.63],
      [142.4, 702.7, 39.87], [148, 712.1, 39.57], [148.3, 723, 39.93], [143.4, 732.7, 39.53], [134.5, 738.9, 39.91], [123.6, 740.6, 39.7],
      [112.7, 740.7, 39.44], [101.7, 740.7, 42.1], [90.7, 740.7, 41.06], [79.7, 740.7, 42.06], [68.7, 740.7, 40.36], [57.7, 740.7, 39.22],
      [46.8, 741.5, 40.14], [36.9, 746.2, 39.46], [30.5, 755, 39.9], [29, 765.8, 39.66], [32.9, 775.9, 39.75], [41.2, 783, 39.73],
      [51.9, 785.5, 39.79], [62.9, 785.6, 39.53], [73.9, 785.6, 40.65], [84.8, 785.7, 40.58], [95.8, 785.7, 41.19], [106.8, 785.7, 42.01],
      [117.8, 785.7, 40.86], [128.8, 785.7, 40.91], [139.8, 785.6, 40.53], [150.8, 785.6, 39.9], [161.8, 785.5, 40.04], [172.7, 784.3, 39.97],
      [183.1, 780.7, 40.07], [192.4, 775, 39.9], [200.3, 767.4, 40.16], [206.4, 758.2, 39.83], [210.3, 747.9, 40.18], [211.9, 737.1, 39.93],
      [212.1, 726.1, 39.85], [212.1, 715.1, 40.92], [212.1, 704.1, 42.15], [212.1, 693.1, 42.53], [212.1, 682.1, 42.22], [212.1, 671.1, 41.81],
      [212.1, 660.1, 39.64], [212.1, 649.1, 39.11], [212.1, 638.2, 37.35], [212.1, 627.2, 36.39], [212.1, 616.2, 34.97], [212.1, 605.2, 33.75],
      [212.1, 594.2, 32.51], [212.1, 583.2, 31.18], [212.1, 572.2, 30], [211.9, 561.2, 28.65], [211.2, 550.2, 27.46], [209.5, 539.4, 26.13],
      [207, 528.7, 24.93], [203.5, 518.3, 23.63], [199.2, 508.1, 22.37], [194.6, 498.2, 21.14], [190.2, 488.1, 19.79], [186.6, 477.7, 18.68],
      [183.8, 467.1, 17.18], [182, 456.2, 16.24], [181.1, 445.3, 14.57], [180.9, 434.3, 13.77], [180.9, 423.3, 12.09], [180.9, 412.3, 10.95],
      [180.9, 401.3, 10.99], [180.9, 390.3, 9.81], [180.9, 379.3, 9.66], [180.9, 368.3, 8.7], [180.9, 357.3, 8.39], [180.9, 346.3, 7.51],
      [180.9, 335.4, 7.19], [180.9, 324.4, 6.29], [180.9, 313.4, 5.98], [180.4, 302.4, 5.16], [178, 291.7, 4.82], [173, 281.9, 4.31],
      [165.8, 273.6, 3.13], [156.9, 267.3, 4.69], [146.6, 263.4, 4.14], [135.8, 261.9, 4.95], [124.8, 261.8, 5.24], [113.8, 261.8, 4.84],
      [102.8, 261.7, 5.26], [91.9, 260.5, 4.87], [81.8, 256.4, 5.21], [73.4, 249.3, 4.95], [67.7, 239.9, 5.07], [65, 229.3, 5.18],
      [64.7, 218.3, 4.71], [64.7, 207.3, 5.91], [64.7, 196.3, 7.11], [64.7, 185.3, 7.4], [64.7, 174.4, 7.26], [64.7, 163.4, 6.47],
      [64.7, 152.4, 4.91], [64.8, 141.4, 4.98], [66.5, 130.5, 5.26], [71.3, 120.7, 4.96], [79, 113, 5.28], [88.7, 107.8, 5.07],
      [99, 103.9, 5.26], [108.8, 99, 5.18], [116.3, 91, 5.26], [120.2, 80.8, 5.27], [119.8, 69.9, 5.29], [115.4, 59.9, 5.33],
      [107.4, 52.4, 5.34], [97.5, 47.7, 5.38], [87.2, 43.8, 5.39], [77.7, 38.3, 5.43], [70.4, 30.2, 5.44], [66, 20.2, 5.48],
      [64.7, 9.3, 5.5], [64.7, -1.7, 5.53], [64.7, -12.7, 5.55], [64.7, -23.7, 5.58], [64.7, -34.7, 5.6], [64.7, -45.7, 5.63],
      [64.7, -56.7, 5.65], [64.7, -67.7, 5.68], [64.7, -78.7, 5.7], [64.7, -89.7, 5.73], [64.4, -100.6, 5.75], [61.9, -111.3, 5.78],
      [56, -120.5, 5.8], [47.3, -127.2, 5.83], [36.9, -130.7, 5.85], [26, -130.4, 5.89], [15.8, -126.4, 5.9], [7.5, -119.2, 5.94],
      [2.2, -109.7, 5.95], [0.2, -98.9, 5.98], [0, -87.9, 6.02], [0, -77, 5.99], [0, -66, 6.01], [0, -55, 5.99],
      [0, -44, 6], [0, -33, 6], [0, -22, 6], [0, -11, 6],
    ],
    pads: [{dist: 193, lat: 0}, {dist: 375, lat: -3.5}, {dist: 559, lat: 3.5}, {dist: 906, lat: 0}, {dist: 1252, lat: 0}, {dist: 1397, lat: 0}, {dist: 1581, lat: -3.5}, {dist: 2087, lat: -3.5}, {dist: 2177, lat: 0}, {dist: 2664, lat: -3.5}],
    ramps: [231, 942, 1438, 1948, 2489],
    barrels: [{dist: 579, lat: 9.2}, {dist: 586, lat: -9.2}, {dist: 620, lat: -9.2}, {dist: 696, lat: 9.2}, {dist: 730, lat: 9.2}, {dist: 741, lat: -9.2}, {dist: 764, lat: 9.2}, {dist: 775, lat: -9.2}, {dist: 1275, lat: 9.2}, {dist: 1602, lat: -9.2}, {dist: 1609, lat: 9.2}, {dist: 1636, lat: -9.2}, {dist: 1643, lat: 9.2}, {dist: 2202, lat: 9.2}, {dist: 2209, lat: -9.2}, {dist: 2682, lat: -9.2}, {dist: 2689, lat: 9.2}],
    hazards: [{kind: 'boulder', dist: 1691, len: 215, period: 2.4}],
    shortcuts: [{from: 2258, to: 2434, lat: 6.2, halfWidth: 5.5}],
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
