import type { CarUpgradeId, PrimaryId, SecondaryId, WeaponId } from './weapons';

export interface Profile {
  cash: number;
  owned: Record<WeaponId, boolean>;
  lvl: Record<WeaponId, number>;
  primary: PrimaryId;
  secondary: SecondaryId;
  car: Record<CarUpgradeId, number>;
  bestLap: number;
  races: number;
  wins: number;
}

const KEY = 'explosive-racing-save-v1';

export function defaultProfile(): Profile {
  return {
    cash: 0,
    owned: { mg: true, vulcan: false, missile: true, howitzer: false },
    lvl: { mg: 1, vulcan: 1, missile: 1, howitzer: 1 },
    primary: 'mg',
    secondary: 'missile',
    car: { engine: 0, n2o: 0, armor: 0 },
    bestLap: 0,
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
    return {
      ...d,
      ...p,
      owned: { ...d.owned, ...p.owned },
      lvl: { ...d.lvl, ...p.lvl },
      car: { ...d.car, ...p.car },
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
