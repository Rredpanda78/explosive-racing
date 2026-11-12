import type { CarId } from './cars';
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
}

const KEY = 'explosive-racing-save-v1';

export function defaultProfile(): Profile {
  return {
    cash: 0,
    owned: { mg: true, vulcan: false, shotgun: false, rocket: true, howitzer: false, salvo: false },
    lvl: { mg: 1, vulcan: 1, shotgun: 1, rocket: 1, howitzer: 1, salvo: 1 },
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
  };
}

export function loadProfile(): Profile {
  const d = defaultProfile();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw);
    // 舊存檔：追蹤飛彈已改為火箭炮
    if (p.secondary === 'missile') p.secondary = 'rocket';
    if (p.lvl && p.lvl.missile) { p.lvl.rocket = p.lvl.missile; delete p.lvl.missile; }
    if (p.owned) delete p.owned.missile;
    return {
      ...d,
      ...p,
      owned: { ...d.owned, ...p.owned },
      lvl: { ...d.lvl, ...p.lvl },
      car: { ...d.car, ...p.car },
      karts: { ...d.karts, ...p.karts },
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
