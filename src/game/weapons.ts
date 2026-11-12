export type PrimaryId = 'mg' | 'vulcan' | 'flame' | 'laser';
export type SecondaryId = 'rocket' | 'grenade' | 'mine' | 'cluster' | 'missile';
export type WeaponId = PrimaryId | SecondaryId;
export type CarUpgradeId = 'engine' | 'n2o' | 'armor';

export interface PrimaryDef {
  id: PrimaryId;
  /** gun = 實體子彈；flame = 近距離扇形噴火；laser = 瞬間命中的光束 */
  kind: 'gun' | 'flame' | 'laser';
  name: string;
  desc: string;
  /** 每秒發數（火焰與雷射是每秒判定次數） */
  rate: number;
  /** 每次開火射出的彈丸數 */
  pellets: number;
  dmg: number;
  /** 散布（弧度）；火焰是扇形的半角 */
  spread: number;
  /** 每次開火增加的熱量，滿 1 過熱 */
  heat: number;
  range: number;
  /** 預熱秒數（六管機槍） */
  spinUp: number;
  price: number;
}

export interface SecondaryDef {
  id: SecondaryId;
  name: string;
  desc: string;
  dmg: number;
  radius: number;
  cooldown: number;
  /** 一次發射的枚數（集束圓雷 > 1） */
  count: number;
  price: number;
}

/** 主武器：裝在車身兩側。全部朝車頭正前方，沒有輔助瞄準。 */
export const PRIMARY: Record<PrimaryId, PrimaryDef> = {
  mg: { id: 'mg', kind: 'gun', name: '.50 機槍', desc: '射速穩定、準度高、不易過熱', rate: 9, pellets: 1, dmg: 3.6, spread: 0.012, heat: 0.034, range: 150, spinUp: 0, price: 0 },
  vulcan: { id: 'vulcan', kind: 'gun', name: '六管機槍', desc: '六根槍管旋轉射擊：要先預熱，火力最猛但容易過熱', rate: 28, pellets: 1, dmg: 1.7, spread: 0.03, heat: 0.0165, range: 130, spinUp: 0.45, price: 2500 },
  flame: { id: 'flame', kind: 'flame', name: '火焰發射器', desc: '近距離扇形噴火，被燒到會持續燃燒；也能引燃油桶', rate: 15, pellets: 1, dmg: 2.3, spread: 0.2, heat: 0.028, range: 26, spinUp: 0, price: 2800 },
  laser: { id: 'laser', kind: 'laser', name: '雷射槍', desc: '光束瞬間命中正前方第一個目標，射程最遠，要持續照住才有傷害', rate: 20, pellets: 1, dmg: 1.35, spread: 0, heat: 0.021, range: 180, spinUp: 0, price: 3200 },
};

/** 被火焰燒到後每秒的燃燒傷害與持續秒數 */
export const BURN_DPS = 6;
export const BURN_TIME = 2.5;

/** 副武器：裝在引擎蓋上（地雷類從車尾放出） */
export const SECONDARY: Record<SecondaryId, SecondaryDef> = {
  rocket: { id: 'rocket', name: '火箭炮', desc: '朝正前方直線飛行，命中或撞牆時爆炸', dmg: 38, radius: 5.5, cooldown: 3.2, count: 1, price: 0 },
  grenade: { id: 'grenade', name: '榴彈發射器', desc: '朝前方拋射，落地或碰到車就大範圍爆炸並震退敵車', dmg: 42, radius: 8, cooldown: 3.0, count: 1, price: 2500 },
  mine: { id: 'mine', name: '地雷', desc: '往車尾放下地雷，啟動後有車經過就爆炸（最多同時 3 顆）', dmg: 44, radius: 6, cooldown: 2.6, count: 1, price: 2200 },
  cluster: { id: 'cluster', name: '集束圓雷', desc: '往後撒出 5 顆圓形小地雷，碰到就炸，沒碰到 6 秒後自己引爆', dmg: 22, radius: 4.5, cooldown: 6, count: 5, price: 3000 },
  missile: { id: 'missile', name: '追蹤導彈', desc: '隨機鎖定一台對手並追蹤；被鎖定的人會收到警告，急轉可以甩掉', dmg: 36, radius: 5.5, cooldown: 6.5, count: 1, price: 4000 },
};

export const PRIMARY_IDS = Object.keys(PRIMARY) as PrimaryId[];
export const SECONDARY_IDS = Object.keys(SECONDARY) as SecondaryId[];

export const MAX_WEAPON_LVL = 5;
export const MAX_CAR_LVL = 5;

export const isPrimary = (id: WeaponId): id is PrimaryId => id in PRIMARY;
export const weaponDef = (id: WeaponId) => (isPrimary(id) ? PRIMARY[id] : SECONDARY[id as SecondaryId]);
export const weaponLvlMul = (lvl: number) => 1 + 0.15 * (lvl - 1);
/** 從 lvl 升到 lvl+1 的費用 */
export const weaponUpgradeCost = (id: WeaponId, lvl: number) => (isPrimary(id) ? 450 : 550) * lvl;

export const CAR_UPGRADES: Record<CarUpgradeId, { name: string; desc: string }> = {
  engine: { name: '引擎', desc: '每級極速 +1.5%、加速 +3%' },
  n2o: { name: 'N2O 系統', desc: '每級加速時間 +0.2 秒' },
  armor: { name: '裝甲', desc: '每級耐久 +12' },
};
export const carUpgradeCost = (lvl: number) => 500 * (lvl + 1);
