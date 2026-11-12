import type { CarId } from './cars';
import type { DifficultyId } from './difficulty';
import type { CarUpgradeId, PrimaryId, SecondaryId, WeaponId } from './weapons';

export interface Profile {
  cash: number;
  owned: Record<WeaponId, boolean>;
  lvl: Record<WeaponId, number>;
  primary: PrimaryId;
  secondary: SecondaryId;
  car: Record<CarUpgradeId, number>;
  /** 目前使用的車款與已擁有的車款 */
  kart: CarId;
  karts: Partial<Record<CarId, boolean>>;
  bestLap: number;
  /** 目前選的地圖與各地圖的最快單圈 */
  track: string;
  bestLaps: Record<string, number>;
  races: number;
  wins: number;
  /** 已經換成新版武器清單（新存檔一開始就是） */
  weaponsV2?: boolean;
  /** 電腦車手難度 */
  difficulty: DifficultyId;
  /** 每款車選用的花色（0~2） */
  livery: Partial<Record<CarId, number>>;
}

const KEY = 'explosive-racing-save-v1';

export function defaultProfile(): Profile {
  return {
    cash: 0,
    owned: { mg: true, vulcan: false, flame: false, laser: false, rocket: true, grenade: false, mine: false, cluster: false, missile: false },
    lvl: { mg: 1, vulcan: 1, flame: 1, laser: 1, rocket: 1, grenade: 1, mine: 1, cluster: 1, missile: 1 },
    primary: 'mg',
    secondary: 'rocket',
    car: { engine: 0, n2o: 0, armor: 0 },
    kart: 'kart-oobi',
    karts: { 'kart-oobi': true },
    bestLap: 0,
    track: 'skyline-loop',
    bestLaps: {},
    races: 0,
    wins: 0,
    weaponsV2: true,
    difficulty: 'normal',
    livery: {},
  };
}

/** 舊版武器：榴彈砲改成榴彈發射器；下架的霰彈槍與多管火箭照購買和升級的花費退款 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateWeapons(p: any): void {
  if (!p.owned || p.weaponsV2) return;
  p.lvl = p.lvl || {};
  // 很早期的存檔把火箭炮叫做 missile；現在 missile 是新的追蹤導彈
  if (p.owned.missile) { p.owned.rocket = true; p.lvl.rocket = Math.max(p.lvl.rocket || 1, p.lvl.missile || 1); }
  if (p.owned.howitzer) { p.owned.grenade = true; p.lvl.grenade = p.lvl.howitzer || 1; }
  const refund = (id: string, price: number, step: number) => {
    if (!p.owned[id]) return;
    let sum = price;
    for (let l = 1; l < (p.lvl[id] || 1); l++) sum += step * l;
    p.cash = (p.cash || 0) + sum;
  };
  refund('shotgun', 2000, 450);
  refund('salvo', 3500, 550);
  for (const id of ['shotgun', 'howitzer', 'salvo', 'missile']) { delete p.owned[id]; delete p.lvl[id]; }
  if (p.primary === 'shotgun') p.primary = 'mg';
  if (p.secondary === 'howitzer') p.secondary = 'grenade';
  if (p.secondary === 'salvo' || p.secondary === 'missile') p.secondary = 'rocket';
  p.weaponsV2 = true;
}

export function loadProfile(): Profile {
  const d = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw);
    migrateWeapons(p);
    return {
      ...d,
      ...p,
      owned: { ...d.owned, ...p.owned },
      lvl: { ...d.lvl, ...p.lvl },
      car: { ...d.car, ...p.car },
      karts: { ...d.karts, ...p.karts },
      livery: { ...d.livery, ...p.livery },
      bestLaps: { ...(p.bestLap > 0 ? { 'skyline-loop': p.bestLap } : {}), ...p.bestLaps },
    };
  } catch {
    return d;
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 無痕模式等情況下無法存檔，直接略過 */
  }
}
