export type DifficultyId = 'easy' | 'normal' | 'hard' | 'expert';

/** 電腦車手的難度參數 */
export interface Difficulty {
  id: DifficultyId;
  name: string;
  desc: string;
  /** 極速倍率（第一名到最後一名之間內插） */
  skill: [number, number];
  /** 過彎目標速度：v = corner / 曲率（越大越敢衝彎） */
  corner: number;
  /** 高速時的轉向率 */
  turn: number;
  /** 過彎集氣量 */
  gauge: number;
  /** 武器傷害倍率與武器等級範圍 */
  dmg: number;
  lvl: [number, number];
  /** 走捷徑的機率 */
  shortcut: number;
  /** 出彎時模擬小噴 */
  miniBoost: boolean;
  /** 跟玩家拉開距離時的速度調整（領先太多放慢、落後太多加速） */
  ahead: number;
  behind: number;
  /** 開火：連射秒數、停頓秒數、副武器的反應延遲 */
  burst: [number, number];
  pause: [number, number];
  secDelay: [number, number];
  /** N2O 的使用延遲 */
  boostDelay: [number, number];
  /** 走賽車線：彎前先靠外、彎中切內側（不再隨機換車道） */
  line?: boolean;
}

export const DIFFICULTY: Record<DifficultyId, Difficulty> = {
  easy: {
    id: 'easy', name: '簡單', desc: '電腦開得慢、很少開火',
    skill: [0.86, 0.95], corner: 1.25, turn: 1.5, gauge: 0.18, dmg: 0.5, lvl: [1, 1], shortcut: 0.1, miniBoost: false,
    ahead: 0.9, behind: 1.04, burst: [0.4, 0.8], pause: [1.5, 3.5], secDelay: [2.5, 6], boostDelay: [1.5, 5],
  },
  normal: {
    id: 'normal', name: '普通', desc: '會甩出小噴、會走捷徑',
    skill: [0.95, 1.02], corner: 1.38, turn: 1.62, gauge: 0.27, dmg: 0.8, lvl: [1, 3], shortcut: 0.4, miniBoost: true,
    ahead: 0.96, behind: 1.08, burst: [0.6, 1.2], pause: [0.7, 2], secDelay: [1, 3.5], boostDelay: [0.6, 2.5],
  },
  hard: {
    id: 'hard', name: '困難', desc: '電腦比你快、火力全開、帶著升級武器',
    skill: [1.0, 1.06], corner: 1.5, turn: 1.75, gauge: 0.34, dmg: 1.0, lvl: [2, 5], shortcut: 0.7, miniBoost: true,
    ahead: 1.0, behind: 1.12, burst: [0.9, 1.6], pause: [0.3, 1], secDelay: [0.4, 1.8], boostDelay: [0.2, 1.2],
  },
  expert: {
    id: 'expert', name: '極限', desc: '幾乎不犯錯：走賽車線切彎、滿級武器、火力不停，領先也不放水',
    skill: [1.03, 1.08], corner: 1.62, turn: 1.9, gauge: 0.42, dmg: 1.1, lvl: [4, 5], shortcut: 0.95, miniBoost: true,
    ahead: 1.0, behind: 1.16, burst: [1.2, 2], pause: [0.15, 0.6], secDelay: [0.15, 0.8], boostDelay: [0.1, 0.6], line: true,
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTY) as DifficultyId[];
