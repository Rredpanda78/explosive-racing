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
import { wrapAngle } from '../src/game/util';
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
  // 爆炸桶不能放在彎道上
  const spots = track.barrelSpots();
  for (const b of spots) {
    const c = track.samples[track.wrap(Math.round(b.dist / track.spacing))].curv;
    // 不能在急彎上，也不能在任何彎道的內側
    if (Math.abs(c) > 0.016 || (Math.abs(c) > 0.008 && Math.sign(c) === Math.sign(b.lat))) throw new Error(`barrel in a corner at ${b.dist.toFixed(0)} m`);
  }
  console.log(`barrels: ${spots.length}/${def.barrels.length} placed (straights or outside of gentle bends)`);
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
  if (mode === 'race' && def.ramps.length && !count['kart:jump']) throw new Error('nobody used a ramp');
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
  // 短漂：點一下就放開，就算繼續按方向也很快回正，而且沒有小噴
  const short = scenario('short tap 0.08s + hold dir', 0.08, 1);
  if (short > hold * 0.6) throw new Error('short drift drags too long');

  // 進階操作：照時間表給輸入，回報發生的事件
  const script = (name: string, plan: (t: number, inp: ReturnType<typeof emptyInput>) => void): { ev: string[]; k: import('../src/game/kart').Kart; vDrop: number } => {
    const race = new Race(wide, defaultProfile(), 'race', 1);
    for (const o of race.karts) if (!o.isPlayer) o.x += 5000;
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    inp.accel = 1;
    for (let i = 0; i < 60 * 5; i++) race.step(dt, inp);
    const ev: string[] = [];
    let vDrop = 0;
    for (let t = 0; t < 5; t += dt) {
      const v0 = k.speed;
      plan(t, inp);
      race.events.length = 0;
      race.step(dt, inp);
      if (inp.accel < 0) vDrop += Math.max(0, v0 - k.speed);
      for (const e of race.events) if (e.t === 'kart' && e.k === k && !ev.includes(e.e)) ev.push(e.e);
    }
    console.log(`${name.padEnd(26)} events: ${ev.join(' ')}`);
    return { ev, k, vDrop };
  };
  // 連噴：長漂右彎 → 不噴、直接甩左彎 → 第二次甩尾中途按 ↑ → 再甩完按 ↑
  const combo = script('combo', (t, inp) => {
    inp.drift = t < 0.3 || (t > 1.25 && t < 1.55);
    inp.steer = t < 0.3 ? 1 : t > 1.25 && t < 1.55 ? -1 : 0;
    // 第二次甩尾開始後，每 0.1 秒放開／再按一次 ↑
    inp.accel = t > 1.7 && t < 3.6 && Math.floor(t * 10) % 2 === 0 ? 0 : 1;
  });
  if (!combo.ev.includes('combo')) throw new Error('combo boost did not trigger');
  // 短接長：短漂後馬上接長漂
  const chain = script('short → long chain', (t, inp) => {
    inp.drift = t < 0.06 || (t > 0.65 && t < 1.05);
    inp.steer = t < 0.3 ? 1 : t > 0.65 && t < 1.8 ? -1 : 0;
    inp.accel = 1;
  });
  if (!chain.ev.includes('chain')) throw new Error('short-to-long chain did not trigger');
  // 斷飄：甩尾中點一下煞車，立刻結束甩尾而且幾乎不掉速
  const cancel = script('drift cancel', (t, inp) => {
    inp.drift = t < 0.3;
    inp.steer = t < 1.5 ? 1 : 0;
    inp.accel = t > 0.8 && t < 0.9 ? -1 : 1;
  });
  if (!cancel.ev.includes('driftCancel')) throw new Error('drift cancel did not trigger');
  if (cancel.vDrop > 1) throw new Error(`drift cancel lost ${cancel.vDrop.toFixed(1)} m/s`);

  // 重甩：甩尾中放開方向再快速按回同一邊，1.2 秒內要轉得明顯更多（髮夾彎用）
  const turnIn = (taps: boolean): { deg: number; ev: string[]; v: number } => {
    const race = new Race(wide, defaultProfile(), 'race', 1);
    for (const o of race.karts) if (!o.isPlayer) o.x += 5000;
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    inp.accel = 1;
    for (let i = 0; i < 60 * 5; i++) race.step(dt, inp);
    const ev: string[] = [];
    let turned = 0, prevH = k.heading;
    for (let t = 0; t < 1.2; t += dt) {
      inp.drift = t < 0.6;
      inp.steer = taps && t > 0.2 && t < 0.3 ? 0 : 1;
      race.events.length = 0;
      race.step(dt, inp);
      turned += wrapAngle(k.heading - prevH);
      prevH = k.heading;
      for (const e of race.events) if (e.t === 'kart' && e.k === k && !ev.includes(e.e)) ev.push(e.e);
    }
    return { deg: turned * 57.3, ev, v: k.speed };
  };
  const plain = turnIn(false), hard = turnIn(true);
  console.log(`hard drift: normal ${plain.deg.toFixed(0)}° (v ${plain.v.toFixed(1)}) vs double-tap ${hard.deg.toFixed(0)}° (v ${hard.v.toFixed(1)}) events: ${hard.ev.join(' ')}`);
  if (!hard.ev.includes('hardDrift')) throw new Error('double tap did not trigger a hard drift');
  // 使用者要求：比一般甩尾多轉一些就好（約 15~20%）
  if (hard.deg < plain.deg * 1.1 || hard.deg > plain.deg * 1.3) throw new Error('hard drift should turn 10-30% more than a normal drift');
}
// ---- 4. 後方護盾：後面來的爆炸、子彈擋得住，前面的擋不住 ----
{
  const race = new Race(new Track(TRACKS[0]), defaultProfile(), 'race', 3);
  for (const o of race.karts) if (!o.isPlayer) o.x += 5000;
  const k = race.player;
  while (race.state === 'countdown') race.step(1 / 60, emptyInput());
  const enemy = race.karts[0];
  k.secondary = 'shield';
  k.invulnT = 0;
  const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
  const shot = (from: number) => {
    k.shieldT = 3;
    k.shieldHp = k.shieldMax = 70;
    k.hp = k.maxHp;
    race.events.length = 0;
    // 從前方（from = 1）或後方（-1）飛來的一發子彈
    race.bullets.push({ x: k.x + fx * 8 * from, y: k.y + 0.95, z: k.z + fz * 8 * from, vx: -fx * 120 * from, vy: 0, vz: -fz * 120 * from, life: 1, dmg: 10, owner: enemy, pierce: 0, skip: null, idx: k.idx });
    for (let i = 0; i < 12; i++) race.step(1 / 60, emptyInput());
    const bullet = k.maxHp - k.hp;
    k.hp = k.maxHp;
    race.explodeAt(k.x + fx * 2.5 * from, k.y + 0.5, k.z + fz * 2.5 * from, k.y, 6, 30, enemy);
    const blast = k.maxHp - k.hp;
    const blocks = race.events.filter((e) => e.t === 'block').length;
    return { bullet, blast, blocks };
  };
  const back = shot(-1), front = shot(1);
  console.log(`shield: from behind bullet -${back.bullet.toFixed(0)} blast -${back.blast.toFixed(0)} (blocks ${back.blocks}); from front bullet -${front.bullet.toFixed(0)} blast -${front.blast.toFixed(0)}`);
  if (back.bullet > 0 || back.blast > 0 || back.blocks < 2) throw new Error('shield did not block attacks from behind');
  if (front.bullet <= 0 || front.blast <= 0) throw new Error('shield blocked attacks from the front');
  // 耐久快用完：這一下還是擋住，但護盾碎掉；下一下就打到車了
  k.shieldT = 3;
  k.shieldHp = 15;
  k.hp = k.maxHp;
  race.events.length = 0;
  race.explodeAt(k.x - fx * 2.5, k.y + 0.5, k.z - fz * 2.5, k.y, 6, 30, enemy);
  const shattered = race.events.some((e) => e.t === 'shatter') && k.shieldT === 0 && k.hp === k.maxHp;
  race.explodeAt(k.x - fx * 2.5, k.y + 0.5, k.z - fz * 2.5, k.y, 6, 30, enemy);
  console.log(`shield break: shattered ${shattered}, next blast -${(k.maxHp - k.hp).toFixed(0)}`);
  if (!shattered || k.hp >= k.maxHp) throw new Error('shield did not shatter correctly');
}
console.log('SIM OK');
