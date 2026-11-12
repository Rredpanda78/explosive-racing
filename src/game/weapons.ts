export type PrimaryId = 'mg' | 'vulcan';
export type SecondaryId = 'missile' | 'howitzer';
export type WeaponId = PrimaryId | SecondaryId;
export type CarUpgradeId = 'engine' | 'n2o' | 'armor';

export interface PrimaryDef {
  id: PrimaryId;
  name: string;
  desc: string;
  /** 每秒發數 */
  rate: number;
  dmg: number;
  /** 散布（弧度） */
  spread: number;
  /** 每發增加的熱量，滿 1 過熱 */
  heat: number;
  range: number;
  /** 預熱秒數（火神機槍） */
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
  price: number;
}

/** 主武器：裝在車身兩側 */
export const PRIMARY: Record<PrimaryId, PrimaryDef> = {
  mg: { id: 'mg', name: '.50 機槍', desc: '射速穩定、準度高、不易過熱', rate: 9, dmg: 3.6, spread: 0.012, heat: 0.034, range: 150, spinUp: 0, price: 0 },
  vulcan: { id: 'vulcan', name: '火神機槍', desc: '需要預熱，火力猛但容易過熱', rate: 28, dmg: 1.7, spread: 0.03, heat: 0.0165, range: 130, spinUp: 0.45, price: 2500 },
};

/** 副武器：裝在引擎蓋上 */
export const SECONDARY: Record<SecondaryId, SecondaryDef> = {
  missile: { id: 'missile', name: '追蹤飛彈', desc: '鎖定前方目標後自動追蹤', dmg: 34, radius: 5, cooldown: 4.2, price: 0 },
  howitzer: { id: 'howitzer', name: '榴彈砲', desc: '拋射砲彈，大範圍爆炸並震退敵車', dmg: 46, radius: 9, cooldown: 3.4, price: 3000 },
};

export const MAX_WEAPON_LVL = 5;
export const MAX_CAR_LVL = 5;

export const isPrimary = (id: WeaponId): id is PrimaryId => id === 'mg' || id === 'vulcan';
export const weaponDef = (id: WeaponId) => (isPrimary(id) ? PRIMARY[id] : SECONDARY[id]);
export const weaponLvlMul = (lvl: number) => 1 + 0.15 * (lvl - 1);
/** 從 lvl 升到 lvl+1 的費用 */
export const weaponUpgradeCost = (id: WeaponId, lvl: number) => (isPrimary(id) ? 450 : 550) * lvl;

export const CAR_UPGRADES: Record<CarUpgradeId, { name: string; desc: string }> = {
  engine: { name: '引擎', desc: '每級極速 +1.5%、加速 +3%' },
  n2o: { name: 'N2O 系統', desc: '每級加速時間 +0.2 秒' },
  armor: { name: '裝甲', desc: '每級耐久 +12' },
};
export const carUpgradeCost = (lvl: number) => 500 * (lvl + 1);
