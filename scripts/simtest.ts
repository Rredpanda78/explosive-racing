// 無畫面模擬測試：
// 1. 地形不能蓋住路面（之前破圖的原因）
// 2. 8 台車全由 AI 跑完競速賽與淘汰賽
// 3. 玩家的甩尾／集氣在各種操作下的表現
import { CFG } from '../src/game/config';
import { emptyInput } from '../src/game/kart';
import { Race } from '../src/game/race';
import { defaultProfile } from '../src/game/save';
import { makeTerrain } from '../src/game/terrain';
import { Track, TRACKS } from '../src/game/track';
import { PRIMARY_IDS, SECONDARY_IDS } from '../src/game/weapons';

for (const def of TRACKS) {
const track = new Track(def);
let kmax = 0;
for (const s of track.samples) kmax = Math.max(kmax, Math.abs(s.curv));
console.log(`=== ${def.id}: length ${track.length.toFixed(0)} m, samples ${track.n}, min radius ${(1 / kmax).toFixed(1)} m ===`);

// ---- 1. 地形檢查 ----
{
  const terrain = makeTerrain(track);
  let worst = Infinity, minY = Infinity;
  for (const s of track.samples) {
    minY = Math.min(minY, s.y);
    // 路面中央、兩側邊緣與護欄外
    for (const lat of [0, -track.halfWidth, track.halfWidth, -(track.halfWidth + 6), track.halfWidth + 6]) {
      const gap = s.y - terrain.height(s.x + s.nx * lat, s.z + s.nz * lat);
      worst = Math.min(worst, gap);
    }
  }
  for (const b of track.branches) {
    for (const s of b.samples) for (const lat of [0, -b.halfWidth, b.halfWidth]) worst = Math.min(worst, s.y - terrain.height(s.x + s.nx * lat, s.z + s.nz * lat));
  }
  console.log(`shortcuts: ${track.branches.map((b) => `${b.def.from}-${b.def.to} m: ${b.length.toFixed(0)} m (saves ${(b.def.to - b.def.from - b.length).toFixed(0)} m)`).join(', ') || 'none'}`);
  console.log(`terrain: road is at least ${worst.toFixed(2)} m above grass; far plane at ${terrain.baseY.toFixed(1)}, lowest road ${minY.toFixed(1)}`);
  if (worst < 0.4) throw new Error('terrain pokes through the road');
  if (terrain.baseY > minY - 1) throw new Error('far ground plane would cover the lowest part of the track');
}

function runAll(mode: 'race' | 'elim', seed: number): void {
  const race = new Race(track, defaultProfile(), mode, seed);
  race.autoPlayer = true;
  race.player.aiAssist = true;
  // 每種武器都要有人用到
  race.karts.forEach((k, i) => {
    k.primary = PRIMARY_IDS[(i + seed) % PRIMARY_IDS.length];
    k.secondary = SECONDARY_IDS[(i + seed) % SECONDARY_IDS.length];
  });
  const dt = 1 / 60;
  const count: Record<string, number> = {};
  let t = 0;
  const done = () => (mode === 'race' ? race.karts.every((k) => k.finished) : race.state === 'finished');
  while (t < 500 && !done()) {
    race.step(dt, emptyInput());
    for (const e of race.events) {
      const key = e.t === 'kart' ? `kart:${e.e}` : e.t;
      count[key] = (count[key] || 0) + 1;
    }
    race.events.length = 0;
    t += dt;
  }
  console.log(`--- ${mode} (${t.toFixed(0)} s) ---`);
  console.log(Object.entries(count).filter(([k]) => !['shot', 'hit', 'count', 'go'].includes(k)).map(([k, v]) => `${k}:${v}`).join(' '));
  for (const k of race.results()) {
    console.log(
      `${k.rank}. ${k.name.padEnd(4)} ${k.out ? 'OUT' : k.finished ? k.finishTime.toFixed(1) : 'running'} laps [${k.lapTimes.map((x) => x.toFixed(1)).join(', ')}] K${k.kills}/D${k.deaths} n2o×${k.stats.n2oUsed} air ${k.stats.airTime.toFixed(1)}s draft ${k.stats.draftTime.toFixed(1)}s barrel ${k.stats.barrels} ${k.car.slice(5)}/${k.primary}/${k.secondary}`,
    );
  }
  for (const k of race.karts) {
    if (!isFinite(k.x) || !isFinite(k.z) || !isFinite(k.y)) throw new Error('NaN position');
    if (mode === 'race' && !k.finished) throw new Error(`${k.name} did not finish`);
  }
  if (!done()) throw new Error(`${mode} did not end`);
  if (!count['kart:jump']) throw new Error('nobody used a ramp');
  if (mode === 'race' && track.branches.length && !count.shortcut) throw new Error('nobody took the shortcut');
  if (mode === 'race' && (def.hazards ?? []).length && !count.hazard && !count.tram && !count.rock) throw new Error('hazards never did anything');
}
runAll('race', 12345);
runAll('elim', 777);
}

// ---- 3. 玩家甩尾測試：在超寬賽道上（不會撞牆）量測各種操作下甩尾能維持多久 ----
{
  const wide = new Track({ ...TRACKS[0], halfWidth: 2000, ramps: [], barrels: [], pads: [] });
  const dt = 1 / 60;
  const scenario = (name: string, shiftT: number, after: number): number => {
    const race = new Race(wide, defaultProfile(), 'race', 1);
    for (const k of race.karts) if (!k.isPlayer) { k.x += 5000; }
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    inp.accel = 1;
    for (let i = 0; i < 60 * 5; i++) race.step(dt, inp);
    const h0 = k.heading, g0 = k.gauge + k.n2o, v0 = k.speed;
    let t = 0, maxSlip = 0, dur = 0, vMin = 99, mini = false, started = false;
    while (t < 8) {
      inp.drift = t < shiftT;
      inp.steer = t < shiftT ? 1 : after;
      if (started && !k.drifting && k.miniWindowT > 0) inp.accel = inp.accel === 1 ? 0 : 1; else inp.accel = 1;
      race.events.length = 0;
      race.step(dt, inp);
      for (const e of race.events) if (e.t === 'kart' && e.k === k && e.e === 'mini') mini = true;
      if (k.drifting) { started = true; dur = t + dt; maxSlip = Math.max(maxSlip, Math.abs(k.slip)); vMin = Math.min(vMin, k.speed); }
      else if (started && t > dur + 1) break;
      t += dt;
    }
    const turned = (k.heading - h0) * 57.3;
    console.log(`${name.padEnd(26)} drift ${dur.toFixed(2)}s  maxSlip ${(maxSlip * 57.3).toFixed(0)}°  v ${v0.toFixed(1)}→min ${vMin.toFixed(1)}  gauge +${(k.gauge + k.n2o - g0).toFixed(2)}  heading Δ${turned.toFixed(0)}°  mini ${mini}`);
    return dur;
  };
  console.log(`--- drift (top speed ${CFG.maxSpeed}) ---`);
  const hold = scenario('tap 0.3s + hold dir', 0.3, 1);
  const neutral = scenario('tap 0.3s + neutral', 0.3, 0);
  const counter = scenario('tap 0.3s + counter', 0.3, -1);
  scenario('hold 1.0s + hold dir', 1.0, 1);
  scenario('hold 1.0s + counter', 1.0, -1);
  if (!(hold > neutral && neutral > counter)) throw new Error('drift durations out of order');
  if (hold < 1.5) throw new Error('held drift too short');
}
console.log('SIM OK');
