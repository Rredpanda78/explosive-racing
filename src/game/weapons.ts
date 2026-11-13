export type PrimaryId = 'mg' | 'vulcan' | 'flame' | 'laser';
export type SecondaryId = 'rocket' | 'grenade' | 'mine' | 'cluster' | 'missile' | 'shield';
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
  /** 升到 Lv.5 解鎖的特性 */
  perk: string;
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
  /** 升到 Lv.5 解鎖的特性 */
  perk: string;
}

/** 主武器：裝在車身兩側。全部朝車頭正前方，沒有輔助瞄準。 */
export const PRIMARY: Record<PrimaryId, PrimaryDef> = {
  mg: { id: 'mg', kind: 'gun', name: '.50 機槍', desc: '射速穩定、準度高、不易過熱', rate: 9, pellets: 1, dmg: 3.6, spread: 0.012, heat: 0.034, range: 150, spinUp: 0, price: 0, perk: '穿甲彈：子彈打穿第一台車後繼續飛' },
  vulcan: { id: 'vulcan', kind: 'gun', name: '六管機槍', desc: '六根槍管旋轉射擊：要先預熱，火力最猛但容易過熱', rate: 28, pellets: 1, dmg: 2.4, spread: 0.024, heat: 0.0165, range: 130, spinUp: 0.35, price: 2500, perk: '快速預熱：幾乎不用等，過熱再慢 20%' },
  flame: { id: 'flame', kind: 'flame', name: '火焰發射器', desc: '近距離扇形噴火，被燒到會持續燃燒；也能引燃油桶', rate: 15, pellets: 1, dmg: 1.0, spread: 0.2, heat: 0.028, range: 26, spinUp: 0, price: 2800, perk: '烈焰：射程 +30%，燃燒時間變成 4 秒' },
  laser: { id: 'laser', kind: 'laser', name: '雷射槍', desc: '蓄力一下射出貫穿光束：正前方第一台車直接打爆，穿過去之後每打中一台威力就衰減；冷卻很長', rate: 1, pellets: 1, dmg: 0, spread: 0, heat: 1, range: 180, spinUp: 0, price: 3200, perk: '過載光束：光束加寬 30%，更容易打中' },
};

/** 雷射槍：蓄力秒數、冷卻（隨等級縮短，Lv.3 再快 15%）、貫穿後保留的威力（隨等級提高）、光束半寬 */
export const LASER_CHARGE = 0.3;
export const laserCooldown = (lvl: number) => (7.2 - 0.6 * (lvl - 1)) * lvl3Mul(lvl);
export const laserKeep = (lvl: number) => 0.3 + 0.08 * (lvl - 1);
export const laserWidth = (lvl: number) => (lvl >= PERK_LVL5 ? 1.7 : 1.3);

/** 被火焰燒到後每秒的燃燒傷害與持續秒數 */
export const BURN_DPS = 4;
export const BURN_TIME = 2.5;

/** 副武器：裝在引擎蓋上（地雷類從車尾放出） */
export const SECONDARY: Record<SecondaryId, SecondaryDef> = {
  rocket: { id: 'rocket', name: '火箭炮', desc: '朝正前方直線飛行，命中或撞牆時爆炸', dmg: 56, radius: 6.5, cooldown: 2.3, count: 1, price: 0, perk: '雙聯裝：一次射出兩枚火箭' },
  grenade: { id: 'grenade', name: '榴彈發射器', desc: '自動預判前方對手的位置拋射，落地或碰到車就大範圍爆炸並震退敵車（不會炸到自己）', dmg: 18, radius: 11, cooldown: 4, count: 1, price: 2500, perk: '子母彈：爆炸後再彈出 3 顆小榴彈' },
  mine: { id: 'mine', name: '地雷', desc: '往車尾放下地雷，啟動後有車經過就爆炸（最多同時 3 顆）', dmg: 58, radius: 6, cooldown: 2.2, count: 1, price: 2200, perk: '重型地雷：爆炸範圍 +40%，可以同時留 5 顆' },
  cluster: { id: 'cluster', name: '集束圓雷', desc: '往後撒出 5 顆圓形小地雷，碰到就炸，沒碰到 6 秒後自己引爆（威力小、不會把車炸飛）', dmg: 14, radius: 3.8, cooldown: 4.3, count: 5, price: 3000, perk: '加量：一次撒出 7 顆' },
  shield: { id: 'shield', name: '後方護盾', desc: '在車尾展開弧形能量護盾，擋下從後方來的子彈、雷射、火焰、火箭、導彈與爆炸；擋下的傷害太多會碎掉（正面的攻擊、壓到的地雷擋不住）', dmg: 0, radius: 0, cooldown: 11, count: 1, price: 2600, perk: '全包護盾：護住的角度從 150° 加大到 220°（側面也擋得住）' },
  missile: { id: 'missile', name: '追蹤導彈', desc: '隨機鎖定一台對手並追蹤；被鎖定的人會收到警告，急轉可以甩掉', dmg: 23, radius: 5.5, cooldown: 7, count: 1, price: 4000, perk: '雙彈頭：同時射出兩枚（每枚威力 55%），分別鎖定不同對手' },
};

export const PRIMARY_IDS = Object.keys(PRIMARY) as PrimaryId[];
export const SECONDARY_IDS = Object.keys(SECONDARY) as SecondaryId[];

/** 後方護盾：持續秒數（隨等級變長）與護住的半角（弧度；Lv.5 加大） */
export const shieldTime = (lvl: number) => 4 + 0.5 * (lvl - 1);
/** 護盾耐久：擋下的傷害累積超過這個就碎掉（雷射一發大約 100～145） */
export const shieldHp = (lvl: number) => 70 + 15 * (lvl - 1);
export const shieldHalfArc = (lvl: number) => ((lvl >= PERK_LVL5 ? 220 : 150) / 2) * (Math.PI / 180);

export const MAX_WEAPON_LVL = 5;
export const MAX_CAR_LVL = 5;

export const isPrimary = (id: WeaponId): id is PrimaryId => id in PRIMARY;
export const weaponDef = (id: WeaponId) => (isPrimary(id) ? PRIMARY[id] : SECONDARY[id as SecondaryId]);
export const weaponLvlMul = (lvl: number) => 1 + 0.15 * (lvl - 1);
/** Lv.3 起：主武器過熱慢 15%、副武器冷卻快 15% */
export const PERK_LVL3 = 3;
export const PERK_LVL5 = 5;
export const lvl3Mul = (lvl: number) => (lvl >= PERK_LVL3 ? 0.85 : 1);
/** 從 lvl 升到 lvl+1 的費用 */
export const weaponUpgradeCost = (id: WeaponId, lvl: number) => (isPrimary(id) ? 450 : 550) * lvl;

export const CAR_UPGRADES: Record<CarUpgradeId, { name: string; desc: string }> = {
  engine: { name: '引擎', desc: '每級極速 +1.5%、加速 +3%' },
  n2o: { name: 'N2O 系統', desc: '每級加速時間 +0.2 秒' },
  armor: { name: '裝甲', desc: '每級耐久 +12' },
};
export const carUpgradeCost = (lvl: number) => 500 * (lvl + 1);
