import { localize, t } from '../i18n';
import type { Kart } from './kart';

/** 每場比賽隨機抽三個任務，完成可以多拿獎金 */
export interface Mission {
  id: string;
  text: string;
  reward: number;
  /** 只適用於某個模式；不填表示都適用 */
  mode?: 'race' | 'elim';
  /** 進度文字（例如 2/4） */
  progress(p: Kart): string;
  done(p: Kart, rank: number): boolean;
}

const count = (get: (p: Kart) => number, goal: number, digits = 0) => ({
  progress: (p: Kart) => `${Math.min(goal, get(p)).toFixed(digits)}/${goal}`,
  done: (p: Kart) => get(p) >= goal,
});

const POOL: Mission[] = [
  { id: 'kill2', text: '擊毀 2 台對手', reward: 300, ...count((p) => p.kills, 2) },
  { id: 'kill4', text: '擊毀 4 台對手', reward: 650, ...count((p) => p.kills, 4) },
  { id: 'streak2', text: '連續擊毀 2 台（中途不被擊毀）', reward: 400, ...count((p) => p.stats.bestStreak, 2) },
  { id: 'n2o5', text: '使用 5 次 N2O', reward: 250, ...count((p) => p.stats.n2oUsed, 5) },
  { id: 'drift20', text: '累積甩尾 20 秒', reward: 250, ...count((p) => p.stats.driftTime, 20) },
  { id: 'draft6', text: '累積尾流 6 秒', reward: 250, ...count((p) => p.stats.draftTime, 6) },
  { id: 'barrel3', text: '引爆 3 個爆炸桶', reward: 200, ...count((p) => p.stats.barrels, 3) },
  { id: 'cut2', text: '走捷徑 2 次', reward: 250, ...count((p) => p.stats.shortcuts, 2) },
  { id: 'jump3', text: '飛越跳台 3 次', reward: 200, ...count((p) => p.stats.jumps, 3) },
  { id: 'dmg200', text: '造成 200 點傷害', reward: 300, ...count((p) => p.stats.damage, 200) },
  { id: 'start', text: '完成起跑衝刺', reward: 150, progress: (p) => (p.stats.perfectStart ? t.mDone : t.mNotYet), done: (p) => p.stats.perfectStart },
  { id: 'nodeath', text: '全程不被擊毀', reward: 350, progress: (p) => (p.deaths === 0 ? t.mKeep : t.mFail), done: (p) => p.deaths === 0 },
  { id: 'top3', text: '以前三名完賽', reward: 300, mode: 'race', progress: (p) => t.mRank(p.rank), done: (_p, rank) => rank <= 3 },
  { id: 'win', text: '奪得冠軍', reward: 700, progress: (p) => t.mRank(p.rank), done: (_p, rank) => rank === 1 },
  { id: 'surv4', text: '撐到剩下 4 台', reward: 300, mode: 'elim', progress: (p) => t.mRank(p.rank), done: (_p, rank) => rank <= 4 },
];

/** 英文的任務說明（中文就是上面原本的字） */
const EN: Record<string, string> = {
  kill2: 'Wreck 2 rivals',
  kill4: 'Wreck 4 rivals',
  streak2: 'Wreck 2 in a row (without getting wrecked)',
  n2o5: 'Use N2O 5 times',
  drift20: 'Drift for 20 s in total',
  draft6: 'Slipstream for 6 s in total',
  barrel3: 'Blow up 3 barrels',
  cut2: 'Take a shortcut 2 times',
  jump3: 'Clear 3 jumps',
  dmg200: 'Deal 200 damage',
  start: 'Nail a rocket start',
  nodeath: 'Don’t get wrecked all race',
  top3: 'Finish in the top 3',
  win: 'Win the race',
  surv4: 'Survive to the final 4',
};
for (const m of POOL) localize(m, { text: EN[m.id] });

/** skip：這場做不到的任務（沒有爆炸桶、沒有跳台、沒有捷徑） */
export function pickMissions(rng: () => number, mode: 'race' | 'elim', skip: string[] = []): Mission[] {
  const pool = POOL.filter((m) => (!m.mode || m.mode === mode) && !skip.includes(m.id));
  const out: Mission[] = [];
  while (out.length < 3 && pool.length) {
    const m = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    // 同一類只留一個（例如擊毀 2 台與擊毀 4 台不同時出現）
    const kind = m.id.replace(/\d+$/, '');
    if (out.some((o) => o.id.replace(/\d+$/, '') === kind)) continue;
    out.push(m);
  }
  return out;
}
