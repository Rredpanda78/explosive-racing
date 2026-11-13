import { localize } from '../i18n';

/** 可購買的車款。id 是舊的 Kenney 卡丁車檔名（存檔沿用，模型載入失敗時也拿它當備用） */
export type CarId = 'kart-oobi' | 'kart-oodi' | 'kart-ooli' | 'kart-oopi' | 'kart-oozi';

/** 一款花色：色相旋轉（度）與白色車身的染色 */
export interface LiveryDef {
  name: string;
  hue: number;
  tint: number | null;
}

export interface CarDef {
  id: CarId;
  /** 車體模型（public/models 底下的檔名） */
  model: string;
  name: string;
  desc: string;
  price: number;
  /** 極速倍率 */
  speed: number;
  /** 加速倍率 */
  accel: number;
  /** 耐久加成 */
  hp: number;
  /** 集氣倍率 */
  gauge: number;
  /** 轉向／甩尾靈活度倍率 */
  handling: number;
  /** N2O 持續時間加成（秒） */
  boostTime: number;
  /** 衝撞傷害倍率 */
  ram: number;
  /** 質量：越重撞人時自己越不動 */
  mass: number;
  /** 專屬特性（顯示在車庫） */
  trait: string;
  /** 特性的數值：重生帶氣瓶、小噴時間倍率、尾流倍率、被炸飛的力道倍率、N2O 結束接小噴 */
  spareN2O?: boolean;
  miniMul?: number;
  draftMul?: number;
  blastMul?: number;
  afterburn?: boolean;
  /** 原廠色（車庫色票用）與三款花色 */
  color: number;
  liveries: LiveryDef[];
}

export const CARS: Record<CarId, CarDef> = {
  'kart-oobi': {
    id: 'kart-oobi', model: 'tripo/car1', name: '新星', desc: '各項均衡的入門車', price: 0, speed: 1, accel: 1, hp: 0, gauge: 1, handling: 1, boostTime: 0, ram: 1, mass: 1,
    trait: '備用氣瓶：每次重生都直接帶一瓶 N2O', spareN2O: true,
    color: 0xf2f2f2, liveries: [{ name: '原廠白', hue: 0, tint: null }, { name: '午夜藍', hue: 200, tint: 0x3d6cf0 }, { name: '賽道橘', hue: 30, tint: 0xff8a2a }],
  },
  'kart-ooli': {
    id: 'kart-ooli', model: 'tripo/car4', name: '甩尾王', desc: '轉向靈活，甩尾集氣特別快', price: 4000, speed: 0.99, accel: 1.04, hp: -5, gauge: 1.3, handling: 1.13, boostTime: 0, ram: 1, mass: 1,
    trait: '甩尾大師：小噴時間 +60%', miniMul: 1.6,
    color: 0xd7263d, liveries: [{ name: '黑紅', hue: 0, tint: null }, { name: '綠刃', hue: 120, tint: null }, { name: '冰藍', hue: 215, tint: null }],
  },
  'kart-oodi': {
    id: 'kart-oodi', model: 'tripo/car2', name: '疾風', desc: '極速最高，但起步慢、車身薄', price: 4500, speed: 1.045, accel: 0.93, hp: -12, gauge: 1, handling: 0.97, boostTime: 0, ram: 0.9, mass: 0.88,
    trait: '流線車身：跟在別人後面的尾流加速與集氣加倍', draftMul: 1.9,
    color: 0x2f6fe8, liveries: [{ name: '電光藍', hue: 0, tint: null }, { name: '火焰紅', hue: 140, tint: null }, { name: '毒液綠', hue: -100, tint: null }],
  },
  'kart-oopi': {
    id: 'kart-oopi', model: 'tripo/car5', name: '鐵牛', desc: '裝甲厚、撞人特別痛，極速略低', price: 4500, speed: 0.975, accel: 0.98, hp: 45, gauge: 0.95, handling: 0.95, boostTime: 0, ram: 1.7, mass: 1.45,
    trait: '重裝底盤：被爆炸與機關撞飛的力道減半', blastMul: 0.5,
    color: 0xd9d9d9, liveries: [{ name: '原廠灰', hue: 0, tint: null }, { name: '大黃蜂', hue: 200, tint: 0xffc42e }, { name: '紫電', hue: 280, tint: 0x8a5cff }],
  },
  'kart-oozi': {
    id: 'kart-oozi', model: 'tripo/car3', name: '噴射機', desc: 'N2O 燒得更久，適合直線多的賽道', price: 5500, speed: 1, accel: 1, hp: 0, gauge: 1.05, handling: 1, boostTime: 0.8, ram: 1, mass: 1,
    trait: '後燃器：每次 N2O 噴完自動接一次小噴', afterburn: true,
    color: 0xb8bcc4, liveries: [{ name: '銀灰', hue: 0, tint: null }, { name: '湖水綠', hue: 160, tint: 0x3fd0c0 }, { name: '櫻桃粉', hue: 280, tint: 0xff5a8a }],
  },
};

export const CAR_IDS = Object.keys(CARS) as CarId[];

/** 英文版的車名、說明、特性與花色名稱（中文就是上面原本的字） */
const EN: Record<CarId, { name: string; desc: string; trait: string; liveries: [string, string, string] }> = {
  'kart-oobi': { name: 'Nova', desc: 'A well-rounded starter kart', trait: 'Spare Tank: every respawn comes with an N2O tank', liveries: ['Factory White', 'Midnight Blue', 'Track Orange'] },
  'kart-ooli': { name: 'Drift King', desc: 'Nimble steering, fills the gauge fast when drifting', trait: 'Drift Master: mini-boosts last 60% longer', liveries: ['Black Red', 'Green Blade', 'Ice Blue'] },
  'kart-oodi': { name: 'Gale', desc: 'Highest top speed, but slow off the line and thin-skinned', trait: 'Streamlined: double slipstream boost and gauge when tailing', liveries: ['Electric Blue', 'Flame Red', 'Venom Green'] },
  'kart-oopi': { name: 'Iron Ox', desc: 'Heavy armor and brutal rams, slightly lower top speed', trait: 'Heavy Chassis: half the knockback from blasts and hazards', liveries: ['Factory Gray', 'Hornet', 'Violet Bolt'] },
  'kart-oozi': { name: 'Jet', desc: 'N2O burns longer — made for tracks with long straights', trait: 'Afterburner: every N2O ends with a free mini-boost', liveries: ['Silver', 'Lagoon', 'Cherry Pink'] },
};
for (const id of CAR_IDS) {
  const c = CARS[id], e = EN[id];
  localize(c, { name: e.name, desc: e.desc, trait: e.trait });
  c.liveries.forEach((l, i) => localize(l, { name: e.liveries[i] }));
}
