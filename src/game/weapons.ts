import { isEn, localize } from '../i18n';

export type PrimaryId = 'mg' | 'vulcan' | 'flame' | 'laser' | 'arc' | 'freeze' | 'sonic' | 'harpoon';
export type SecondaryId = 'rocket' | 'grenade' | 'mine' | 'cluster' | 'missile' | 'shield';
export type WeaponId = PrimaryId | SecondaryId;
export type CarUpgradeId = 'engine' | 'n2o' | 'armor';
export type PrimaryKind = 'gun' | 'flame' | 'laser' | 'arc' | 'freeze' | 'sonic' | 'harpoon';

export interface PrimaryDef {
  id: PrimaryId;
  /**
   * gun = 實體子彈；flame = 近距離扇形噴火；laser = 瞬間命中的光束；
   * arc = 會在車與車之間跳躍的電弧；freeze = 讓對手結冰的持續光束；sonic = 往前推開對手的扇形震波；
   * harpoon = 叉中前車後把自己拉過去的魚叉
   */
  kind: PrimaryKind;
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
  // 以下四把是功能型武器：電弧槍在車群裡傷害跟其他主武器差不多，另外三把傷害低、但能讓對手打滑、推開對手或把自己拉近
  arc: { id: 'arc', kind: 'arc', name: '電弧槍', desc: '往正前方近距離放電：電到第一台車後，電流會跳到旁邊 12 m 內的車（最多再跳 2 台，每跳一次威力 ×0.6）。車越多越強，單挑偏弱', rate: 2.5, pellets: 1, dmg: 11, spread: 0.05, heat: 0.1, range: 30, spinUp: 0, price: 3000, perk: '超導：電流多跳一台（最多連 4 台），跳躍距離 +4 m' },
  freeze: { id: 'freeze', kind: 'freeze', name: '冷凍光束', desc: '持續照射的藍色光束，傷害很低但會讓對手結冰：照越久越滑（抓地力變差、轉不過彎）、極速也會降一點；放開後約 2 秒退冰', rate: 10, pellets: 1, dmg: 0.5, spread: 0, heat: 0.03, range: 35, spinUp: 0, price: 2800, perk: '絕對零度：凍得更深（更滑、極速 -15%），退冰要 3 秒' },
  sonic: { id: 'sonic', kind: 'sonic', name: '音波炮', desc: '按住每 0.45 秒往前方扇形打出一圈震波：傷害低，但會把車往旁邊、往前推開，越近推越遠——適合把人推去撞牆或推出路面', rate: 1 / 0.45, pellets: 1, dmg: 2.6, spread: 0.42, heat: 0.09, range: 22, spinUp: 0, price: 2600, perk: '共振：被震波推去撞牆的車額外受到 15 點傷害' },
  harpoon: { id: 'harpoon', kind: 'harpoon', name: '魚叉鉤', desc: '往正前方射出魚叉，叉中前車就用繩子把自己拉過去（按住最多約 2 秒）：加速到比對方快一截，對方也會被拖慢一點。放開、追上對方、撞牆或繩子被擋住就斷；一發很耗熱量', rate: 1.25, pellets: 1, dmg: 6, spread: 0, heat: 0.42, range: 60, spinUp: 0, price: 3000, perk: '甩射：收線追上對方的瞬間自動小噴一次' },
};

// ---- 電弧槍 ----
/** 第一台車：槍口前方的窄錐（半寬 = ARC_W + 距離 × spread） */
export const ARC_W = 1.4;
/** 每跳一次保留的威力 */
export const ARC_KEEP = 0.6;
/** 打中第一台後還能再跳幾台、跳躍距離（Lv.5 多跳一台、遠 4 m） */
export const arcHops = (lvl: number) => (lvl >= PERK_LVL5 ? 3 : 2);
export const arcJump = (lvl: number) => (lvl >= PERK_LVL5 ? 16 : 12);

// ---- 冷凍光束 ----
/** 光束半寬（打中判定） */
export const FREEZE_W = 1.25;
/** 每次判定（每秒 10 次）增加的結冰程度（滿 = 1）：Lv.1 約 1.8 秒凍滿、Lv.5 約 1.3 秒 */
export const chillRate = (lvl: number) => 0.055 + 0.006 * (lvl - 1);
/** 結冰：抓地力最多降到 40%（深度凍結 25%）、轉向變鈍、極速 -10%（深度凍結 -15%） */
export const CHILL_GRIP = 0.6;
export const CHILL_GRIP_DEEP = 0.75;
export const CHILL_TURN = 0.3;
export const CHILL_SPEED = 0.1;
export const CHILL_SPEED_DEEP = 0.15;
/** 沒被照到 0.15 秒後開始退冰；從全凍到退完的秒數 */
export const CHILL_HOLD = 0.15;
export const CHILL_DECAY = 2;
export const CHILL_DECAY_DEEP = 3;

// ---- 音波炮 ----
/** 推力（m/s，往旁邊與前方；越遠越弱），隨等級提高 */
export const sonicPush = (lvl: number) => 7.5 * (1 + 0.08 * (lvl - 1));
/** 被推開後抓地力變差的秒數與這段時間的抓地力（才推得動） */
export const SHOVE_T = 0.35;
export const SHOVE_GRIP = 1.2;
/** Lv.5 共振：被推去撞牆的額外傷害 */
export const SONIC_SLAM = 15;

// ---- 魚叉鉤 ----
export const HOOK_SPEED = 150;
/** 拉扯秒數與追速（比對方快多少 m/s），隨等級提高 */
export const tetherTime = (lvl: number) => 2 + 0.15 * (lvl - 1);
export const pullBonus = (lvl: number) => 7 + (lvl - 1);
/** 繩子最長幾公尺（超過就斷）、拉扯的加速度與往目標方向的拉力 */
export const ROPE_MAX = 75;
export const PULL_ACCEL = 30;
export const ROPE_PULL = 9;
/** 被叉中的車：極速倍率 */
export const TOW_SLOW = 0.9;

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
  grenade: { id: 'grenade', name: '榴彈發射器', desc: '自動預判前方對手的位置拋射，落地或碰到車就大範圍爆炸並震退敵車（不會炸到自己）', dmg: 54, radius: 11, cooldown: 8, count: 1, price: 2500, perk: '子母彈：爆炸後再彈出 3 顆小榴彈' },
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

// ---------- 英文名稱與說明（中文就是上面原本的字） ----------

const EN_PRIMARY: Record<PrimaryId, { name: string; desc: string; perk: string }> = {
  mg: { name: '.50 MG', desc: 'Steady rate of fire, accurate and slow to overheat', perk: 'AP Rounds: bullets punch through the first car and keep flying' },
  vulcan: { name: 'Vulcan', desc: 'Six spinning barrels: needs to spin up first, hits hardest of all but overheats easily', perk: 'Quick Spin: almost no spin-up, and overheats 20% slower' },
  flame: { name: 'Flamethrower', desc: 'Close-range cone of fire that sets cars burning; also ignites barrels', perk: 'Inferno: +30% range, burning lasts 4 s' },
  laser: { name: 'Rail Laser', desc: 'Charge for a moment, then fire a piercing beam: the first car straight ahead is wrecked outright, and every car after it takes less; long cooldown', perk: 'Overload Beam: 30% wider beam, easier to land' },
  arc: { name: 'Arc Gun', desc: 'Short-range discharge straight ahead: after the first car, the current jumps to cars within 12 m (up to 2 more, ×0.6 power per hop). Stronger in a pack, weak one-on-one', perk: 'Superconductor: one extra hop (up to 4 cars), +4 m hop range' },
  freeze: { name: 'Freeze Beam', desc: 'A steady blue beam with very low damage that ices rivals up: the longer it stays on, the more they slide (less grip, can’t turn in) and the slower they go; thaws about 2 s after you let go', perk: 'Absolute Zero: deeper freeze (slipperier, −15% top speed), takes 3 s to thaw' },
  sonic: { name: 'Sonic Cannon', desc: 'Hold to fire a cone-shaped shockwave every 0.45 s: low damage, but it shoves cars sideways and forward — the closer, the harder. Perfect for pushing rivals into walls or off the road', perk: 'Resonance: cars shoved into a wall take an extra 15 damage' },
  harpoon: { name: 'Harpoon', desc: 'Fires a harpoon straight ahead; hook the car in front and the line reels you in (hold for up to ~2 s): you surge past their speed and drag them back a little. Breaks when you let go, catch them, hit a wall or the line is blocked; each shot costs a lot of heat', perk: 'Slingshot: automatic mini-boost the moment you reel them in' },
};
const EN_SECONDARY: Record<SecondaryId, { name: string; desc: string; perk: string }> = {
  rocket: { name: 'Rocket', desc: 'Flies straight ahead and explodes on impact or when it hits a wall', perk: 'Twin Pod: fires two rockets at once' },
  grenade: { name: 'Grenade Launcher', desc: 'Auto-leads the rival ahead and lobs a shell that blows up on landing or on contact — a big blast that knocks cars back (and never hurts you)', perk: 'Cluster Shell: bursts into 3 more small grenades' },
  mine: { name: 'Mine', desc: 'Drops a mine behind you that explodes when a car drives over it once armed (up to 3 at a time)', perk: 'Heavy Mine: +40% blast radius, up to 5 at a time' },
  cluster: { name: 'Cluster Mines', desc: 'Scatters 5 small round mines behind you that blow on contact, or on their own after 6 s (weak, won’t launch cars)', perk: 'Extra Load: scatters 7 at a time' },
  shield: { name: 'Rear Shield', desc: 'Deploys a curved energy shield behind you that blocks bullets, lasers, flames, rockets, missiles and blasts from behind; it shatters if it soaks up too much (no help against attacks from the front or mines you drive over)', perk: 'Full Cover: coverage widens from 150° to 220° (blocks from the sides too)' },
  missile: { name: 'Homing Missile', desc: 'Locks onto a random rival and chases them; the target gets a warning and can shake it with a hard turn', perk: 'Twin Warhead: fires two at once (55% power each), each locking a different rival' },
};
/** 英文的短名：HUD 與手機開火鈕的空間比較小 */
const EN_SHORT: Record<WeaponId, string> = {
  mg: '.50 MG', vulcan: 'Vulcan', flame: 'Flamer', laser: 'Laser', arc: 'Arc Gun', freeze: 'Freeze', sonic: 'Sonic', harpoon: 'Harpoon',
  rocket: 'Rocket', grenade: 'Grenade', mine: 'Mine', cluster: 'Cluster', missile: 'Homing', shield: 'Shield',
};
for (const id of PRIMARY_IDS) localize(PRIMARY[id], EN_PRIMARY[id]);
for (const id of SECONDARY_IDS) localize(SECONDARY[id], EN_SECONDARY[id]);
localize(CAR_UPGRADES.engine, { name: 'Engine', desc: 'Top speed +1.5% and acceleration +3% per level' });
localize(CAR_UPGRADES.n2o, { name: 'N2O System', desc: 'N2O lasts +0.2 s longer per level' });
localize(CAR_UPGRADES.armor, { name: 'Armor', desc: 'Durability +12 per level' });

/** HUD 與手機開火鈕上的武器名稱：中文用全名，英文用短名 */
export const weaponLabel = (id: WeaponId): string => (isEn() ? EN_SHORT[id] : weaponDef(id).name);
