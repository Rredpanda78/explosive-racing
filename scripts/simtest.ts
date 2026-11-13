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
  // 軟邊界：整片緩衝區（路面高度）也不能被地形蓋住；懸崖外面的地面要真的掉下去
  if (track.hasRunoff) {
    let drop = Infinity;
    track.samples.forEach((s, i) => {
      for (const sg of [1, -1]) {
        const w = track.runoffW(i, sg);
        if (w <= 0) continue;
        for (const f of [0.5, 1]) {
          const lat = sg * (track.halfWidth + w * f);
          worst = Math.min(worst, s.y - terrain.height(s.x + s.nx * lat, s.z + s.nz * lat));
        }
        if (track.cliffAt(i, sg) && track.cliffAt(track.wrap(i - 12), sg) && track.cliffAt(track.wrap(i + 12), sg)) {
          const lat = sg * (track.halfWidth + w + 10);
          drop = Math.min(drop, s.y - terrain.height(s.x + s.nx * lat, s.z + s.nz * lat));
        }
      }
    });
    const ro = (A: Float32Array) => { let m = 0, on = 0; for (const w of A) { m = Math.max(m, w); if (w > 0) on++; } return `${(on / A.length * 100).toFixed(0)}% of the lap, max ${m.toFixed(1)} m`; };
    console.log(`run-off: left ${ro(track.runoffL)}, right ${ro(track.runoffR)}${isFinite(drop) ? `; cliff drop at least ${drop.toFixed(1)} m` : ''}`);
    if (isFinite(drop) && drop < 8) throw new Error('cliff edge does not drop off');
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

  // 重甩甩過頭不能突然停下來：同一次甩尾連續重甩兩次、N2O 中重甩（以前滑角超過 90 度會被當成倒車，速度一格歸零）
  const overRot = (boost: boolean): { minV: number; worst: number; v0: number } => {
    const race = new Race(wide, defaultProfile(), 'race', 1);
    for (const o of race.karts) if (!o.isPlayer) o.x += 5000;
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    inp.accel = 1;
    for (let i = 0; i < 60 * 5; i++) race.step(dt, inp);
    if (boost) { k.n2o = 2; inp.boost = true; race.step(dt, inp); inp.boost = false; }
    const v0 = Math.hypot(k.vx, k.vz);
    let minV = v0, worst = 0, prev = v0;
    for (let t = 0; t < 2.5; t += dt) {
      inp.drift = t < 2;
      inp.steer = (t > 0.2 && t < 0.3) || (t > 0.9 && t < 1.0) ? 0 : 1;
      race.step(dt, inp);
      const v = Math.hypot(k.vx, k.vz);
      minV = Math.min(minV, v);
      worst = Math.max(worst, prev - v);
      prev = v;
    }
    return { minV, worst, v0 };
  };
  for (const boost of [false, true]) {
    const r = overRot(boost);
    console.log(`hard drift over-rotation${boost ? ' (N2O)' : ''}: v0 ${r.v0.toFixed(1)} min ${r.minV.toFixed(1)} worst one-frame drop ${r.worst.toFixed(2)}`);
    if (r.worst > 2 || r.minV < r.v0 * 0.6) throw new Error('hard drift over-rotation stopped the kart');
  }
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

// ---- 5. 軟邊界：每條有緩衝區的賽道都檢查一次（路邊的緩衝區、外圍屏障、懸崖、AI） ----
for (const d of TRACKS) if (!d.runoff && new Track(d).hasRunoff) throw new Error(`${d.id} should keep its hard walls`);
for (const def of TRACKS) {
  if (!def.runoff) continue;
  const track = new Track(def);
  const hw = track.halfWidth;
  const dt = 1 / 60;
  const surf = CFG.runoffSurfaces[track.runoffSurface];
  console.log(`--- soft boundaries (${def.id}, ${track.runoffSurface}: top speed ×${surf.speed}, drag ${surf.drag}) ---`);
  if (!track.hasRunoff) throw new Error(`${def.id} has no run-off`);
  type K = import('../src/game/kart').Kart;
  type I = ReturnType<typeof emptyInput>;

  // 緩衝區裡任何一點都要找得到「自己這段路」的取樣點（不管從附近哪裡開始找，或是全域搜尋）
  {
    let bad = 0, checked = 0;
    for (let i = 0; i < track.n; i += 2) {
      for (const sg of [1, -1]) {
        const w = track.runoffW(i, sg);
        if (w <= 0) continue;
        const s = track.samples[i];
        for (const f of [0.3, 0.7, 1]) {
          const lat = sg * (hw + w * f);
          const x = s.x + s.nx * lat, z = s.z + s.nz * lat;
          for (const hint of [-1, track.wrap(i - 12), track.wrap(i + 12)]) {
            const j = track.locate(x, z, hint);
            let dd = Math.abs(j - i);
            dd = Math.min(dd, track.n - dd);
            checked++;
            if (dd > 4 || Math.abs(Math.abs(track.lat) - Math.abs(lat)) > 1) bad++;
          }
        }
      }
    }
    console.log(`locate in run-off: ${checked - bad}/${checked} map back to their own part of the track`);
    if (bad) throw new Error('a point in the run-off maps to another part of the track');
  }

  /** 把玩家放到賽道 dist 公尺處（全速），其他車退出比賽（移到遠處的話會被護欄推回賽道上） */
  const setup = (dist: number, lat = 0) => {
    const race = new Race(track, defaultProfile(), 'race', 5);
    for (const o of race.karts) if (!o.isPlayer) o.out = true;
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    const i = track.wrap(Math.round(dist / track.spacing));
    const s = track.samples[i];
    k.x = s.x + s.nx * lat; k.z = s.z + s.nz * lat; k.y = s.y; k.idx = i; k.lat = lat; k.prog = i; k.progFine = i;
    k.heading = Math.atan2(s.tx, s.tz);
    k.speed = k.topSpeed;
    k.vx = s.tx * k.speed; k.vz = s.tz * k.speed;
    k.invulnT = 1e9;
    k.lapCount = 0;
    k.lapStart = race.time;
    inp.accel = 1;
    return { race, k, inp };
  };
  /** 簡單的循線：開到橫向位置 lat（左為正） */
  const steerTo = (k: K, inp: I, lat: number) => {
    const s = track.samples[k.idx];
    const want = Math.atan2(s.tx, s.tz) + Math.max(-0.45, Math.min(0.45, (lat - k.lat) * 0.07));
    inp.steer = Math.max(-1, Math.min(1, wrapAngle(want - k.heading) * 3));
  };
  /** 照目標橫向位置開 secs 秒；回傳撞牆次數、第一次撞牆時的 |lat| 與那裡的緩衝區外緣 */
  const drive = (race: Race, k: K, inp: I, secs: number, lat: number, f?: () => void) => {
    let walls = 0, firstWall = 0, edgeAt = 0;
    for (let t = 0; t < secs; t += dt) {
      steerTo(k, inp, lat);
      f?.();
      race.events.length = 0;
      race.step(dt, inp);
      for (const e of race.events) if (e.t === 'kart' && e.k === k && e.e === 'wall' && !walls++) { firstWall = Math.abs(k.lat); edgeAt = track.edgeLat(k.idx, Math.sign(k.lat)); }
    }
    return { walls, firstWall, edgeAt };
  };

  // 找一段 200 m（街道賽找不到就 150 m）長、緩衝區至少 9.5 m、沒有急彎、懸崖與跳台（後面 260 m 內）的路段來測
  let at = -1, side = 1, best = 0;
  for (const [len, cmax] of [[200, 0.02], [150, 0.02], [100, 0.025]]) {
  if (at >= 0) break;
  const span = Math.round(len / track.spacing);
  for (let i = 0; i < track.n; i += 4) {
    if (track.ramps.some((r) => ((r - i * track.spacing) % track.length + track.length) % track.length < 260)) continue;
    for (const sg of [1, -1]) {
      let mn = Infinity;
      for (let j = 0; j <= span && mn >= 9.5; j++) {
        const q = track.wrap(i + j);
        if (track.cliffAt(q, sg) || Math.abs(track.samples[q].curv) > cmax) mn = 0;
        else mn = Math.min(mn, track.runoffW(q, sg));
      }
      if (mn >= 9.5 && mn > best) { best = mn; at = i * track.spacing; side = sg; }
    }
  }
  }
  if (at < 0) throw new Error('no 150 m stretch with run-off to test');
  console.log(`test stretch: ${at.toFixed(0)} m, ${side > 0 ? 'left' : 'right'}, run-off ≥ ${best.toFixed(1)} m`);

  // 1. 偏到緩衝區中間：不會撞牆，速度降到這種地面的極速倍率；再開回路面
  {
    // 從路邊出發（避開路中央的加速帶）
    const { race, k, inp } = setup(at, side * (hw - 2));
    let inT = 0;
    drive(race, k, inp, 0.4, side * (hw - 2));
    const r = drive(race, k, inp, 3, side * (hw + 6), () => { if (k.runoff) inT += dt; });
    const vIn = k.speed;
    console.log(`run-off: lat ${k.lat.toFixed(1)}, ${inT.toFixed(1)} s off the road, speed ${vIn.toFixed(1)} m/s = ${(vIn / k.topSpeed * 100).toFixed(0)}% of top speed, wall hits ${r.walls}`);
    if (inT < 1.5) throw new Error('kart never registered as being in the run-off');
    if (r.walls) throw new Error('hit a wall inside the run-off');
    if (Math.abs(vIn / k.topSpeed - surf.speed) > 0.03) throw new Error(`run-off speed should be ~${surf.speed * 100}% of top speed`);
    drive(race, k, inp, 2, 0);
    console.log(`back on track: lat ${k.lat.toFixed(1)}, speed ${k.speed.toFixed(1)} m/s, in run-off ${k.runoff}`);
    if (k.runoff || Math.abs(k.lat) > hw - 1 || k.speed < vIn + 1) throw new Error('could not drive back onto the road');
  }
  // 2. 甩尾：在緩衝區裡甩不集氣，在路面上同樣的甩尾會集氣
  const driftTest = (lat: number) => {
    const { race, k, inp } = setup(at);
    drive(race, k, inp, 2, lat);
    let gain = 0, frames = 0;
    const off = Math.abs(lat) > hw;
    for (let t = 0; t < 0.8; t += dt) {
      inp.drift = t < 0.4;
      inp.steer = -side;
      const g0 = k.driftGain, off0 = k.runoff;
      race.events.length = 0;
      race.step(dt, inp);
      // 只算整幀都在（或都不在）緩衝區裡的甩尾
      if (k.drifting && off0 === k.runoff && k.runoff === off) { gain += k.driftGain - g0; frames++; }
    }
    return { gain, frames };
  };
  const dOff = driftTest(side * (hw + 9)), dOn = driftTest(0);
  console.log(`drift: in run-off +${dOff.gain.toFixed(3)} gauge over ${dOff.frames} frames, on road +${dOn.gain.toFixed(3)} over ${dOn.frames} frames`);
  if (dOff.frames < 10 || dOn.frames < 10) throw new Error('drift test did not drift');
  if (dOff.gain > 1e-6) throw new Error('drifting in the run-off built gauge');
  if (dOn.gain <= 0.01) throw new Error('drifting on the road should build gauge');
  // 3. 一路往外開：直到緩衝區外緣才撞到外圍屏障（跟撞牆一樣：會有 wall 事件、甩尾集氣作廢）
  {
    const { race, k, inp } = setup(at);
    drive(race, k, inp, 0.4, 0);
    const r = drive(race, k, inp, 3, side * (hw + 30));
    console.log(`barrier: first hit at |lat| ${r.firstWall.toFixed(1)} (run-off edge there ${r.edgeAt.toFixed(1)}), hits ${r.walls}`);
    if (!r.walls || r.firstWall < r.edgeAt - 1.6) throw new Error('outer barrier missing or too close');
  }
  // 4. 起跑直線（維修區、看台）照樣是護欄
  {
    const { race, k, inp } = setup(20);
    const r = drive(race, k, inp, 2, -(hw + 30));
    console.log(`start straight: wall at |lat| ${r.firstWall.toFixed(1)}, hits ${r.walls}`);
    if (!r.walls || r.firstWall > hw) throw new Error('start straight should keep its hard walls');
  }
  // 5. 懸崖（有的話）：開出去會摔下去，然後回到賽道上，圈數與進度不受影響
  let cliffAt = -1;
  for (let i = 0; i < track.n && cliffAt < 0; i++) if (track.cliffAt(i, -1) && track.cliffAt(track.wrap(i - 20), -1) && track.cliffAt(track.wrap(i + 60), -1)) cliffAt = i * track.spacing;
  if (cliffAt >= 0) {
    const { race, k, inp } = setup(cliffAt);
    const prog0 = k.prog, lap0 = k.lapCount;
    let fell = false, respawned = false;
    for (let t = 0; t < 6 && !respawned; t += dt) {
      if (!fell) steerTo(k, inp, -(hw + 30));
      race.events.length = 0;
      race.step(dt, inp);
      for (const e of race.events) {
        if (e.t === 'kart' && e.k === k && e.e === 'fall') fell = true;
        if (e.t === 'respawn' && e.k === k) respawned = true;
      }
    }
    const dProg = (k.prog - prog0) * track.spacing;
    console.log(`cliff at ${cliffAt.toFixed(0)} m: fell ${fell}, respawned ${respawned} at lat ${k.lat.toFixed(1)}, progress +${dProg.toFixed(0)} m, lap ${k.lapCount} (was ${lap0})`);
    if (!fell || !respawned) throw new Error('driving off the plateau edge did not fall and reset');
    if (Math.abs(k.lat) > 0.5 || dProg < 0 || dProg > 80 || k.lapCount !== lap0) throw new Error('reset after the cliff fall put the kart in the wrong place');
  }
  // 6. AI 被擠進緩衝區：從近的那一側開回路面，不會卡住或去撞外圍屏障
  {
    const { race, k } = setup(at);
    k.out = true;
    const ai = race.karts.find((o) => !o.isPlayer)!;
    ai.out = false;
    const i = track.wrap(Math.round((at + 5) / track.spacing)), s = track.samples[i];
    ai.x = s.x + s.nx * side * (hw + 8); ai.z = s.z + s.nz * side * (hw + 8); ai.y = s.y; ai.idx = i; ai.prog = i; ai.lapCount = 0;
    ai.heading = Math.atan2(s.tx, s.tz); ai.speed = 30; ai.vx = s.tx * 30; ai.vz = s.tz * 30;
    let backT = -1, walls = 0;
    for (let t = 0; t < 4; t += dt) {
      race.events.length = 0;
      race.step(dt, emptyInput());
      for (const e of race.events) if (e.t === 'kart' && e.k === ai && e.e === 'wall') walls++;
      if (backT < 0 && Math.abs(ai.lat) < hw - 1) backT = t;
    }
    console.log(`AI pushed into the run-off: back on the road after ${backT.toFixed(1)} s, barrier hits ${walls}, speed ${ai.speed.toFixed(1)} m/s`);
    if (backT < 0 || backT > 2.5 || walls) throw new Error('AI did not recover from the run-off');
  }
  // 7. AI：照樣跑在路面上，完賽時間跟原本的硬護欄版本差不多（±10%）
  {
    const hard = new Track({ ...def, runoff: undefined, runoffZones: undefined });
    const aiRace = (tr: Track, seed: number) => {
      const race = new Race(tr, defaultProfile(), 'race', seed);
      race.autoPlayer = true;
      race.player.aiAssist = true;
      let t = 0, off = 0, total = 0;
      while (t < 500 && !race.karts.every((k) => k.finished)) {
        race.step(dt, emptyInput());
        race.events.length = 0;
        for (const k of race.karts) if (!k.finished && !k.dead) { total++; if (k.runoff) off++; }
        t += dt;
      }
      if (!race.karts.every((k) => k.finished)) throw new Error(`AI did not finish on ${def.id}`);
      const times = race.karts.map((k) => k.finishTime);
      return { mean: times.reduce((a, b) => a + b, 0) / times.length, off: off / Math.max(1, total) };
    };
    let soft = 0, wall = 0, offFrac = 0;
    const seeds = [12345, 777, 4242];
    for (const seed of seeds) {
      const a = aiRace(track, seed), b = aiRace(hard, seed);
      soft += a.mean / seeds.length;
      wall += b.mean / seeds.length;
      offFrac += a.off / seeds.length;
    }
    console.log(`AI mean finish (3 seeds): soft ${soft.toFixed(1)} s vs hard walls ${wall.toFixed(1)} s (${((soft / wall - 1) * 100).toFixed(1)}%), time spent in run-off ${(offFrac * 100).toFixed(1)}%`);
    if (Math.abs(soft / wall - 1) > 0.1) throw new Error('AI lap times changed by more than 10% with soft boundaries');
  }
}
// ---- 6. 蔚藍海廊（海底玻璃隧道）：查得到、圈數、AI 圈速、玻璃牆是硬護欄、斷管捷徑比較快但會摔 ----
{
  // 線上房間用索引指定賽道：原本的賽道順序不能變，新賽道接在後面
  const ORDER = ['skyline-loop', 'red-canyon', 'neon-bay', 'neon-heights', 'forest-jump', 'canyon-rush'];
  ORDER.forEach((id, i) => { if (TRACKS[i]?.id !== id) throw new Error(`track ${i} should still be ${id}`); });
  const ti = TRACKS.findIndex((t) => t.id === 'sea-tunnel');
  if (ti < ORDER.length) throw new Error('sea-tunnel must be appended after the existing tracks');
  const def = TRACKS[ti];
  const track = new Track(def);
  const hw = track.halfWidth;
  const dt = 1 / 60;
  console.log(`--- sea-tunnel (#${ti} ${def.name}): ${def.laps} laps, ${track.length.toFixed(0)} m, half width ${hw} ---`);
  if (def.laps !== 2) throw new Error('sea-tunnel should be 2 laps');
  if (!def.ramps.length || !def.shortcuts?.length) throw new Error('sea-tunnel needs its ramp and shortcut');

  // AI：三個種子，每圈時間要合理（入門圖：大約 50~70 秒一圈）
  const laps: number[] = [];
  for (const seed of [11, 22, 33]) {
    const race = new Race(track, defaultProfile(), 'race', seed);
    race.autoPlayer = true;
    race.player.aiAssist = true;
    let t = 0;
    while (t < 400 && !race.karts.every((k) => k.finished)) { race.step(dt, emptyInput()); race.events.length = 0; t += dt; }
    for (const k of race.karts) {
      if (!k.finished || k.lapTimes.length !== 2) throw new Error(`sea-tunnel: ${k.name} did not finish 2 laps`);
      laps.push(...k.lapTimes);
    }
  }
  laps.sort((a, b) => a - b);
  const mean = laps.reduce((a, b) => a + b, 0) / laps.length;
  console.log(`AI laps: best ${laps[0].toFixed(1)} s, mean ${mean.toFixed(1)} s, worst ${laps[laps.length - 1].toFixed(1)} s`);
  if (laps[0] < 40 || mean > 75) throw new Error('sea-tunnel AI lap times look wrong');

  type K = import('../src/game/kart').Kart;
  const setup = (dist: number, lat = 0, speed?: number) => {
    const race = new Race(track, defaultProfile(), 'race', 5);
    for (const o of race.karts) if (!o.isPlayer) o.out = true;
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    const i = track.wrap(Math.round(dist / track.spacing));
    const s = track.samples[i];
    k.x = s.x + s.nx * lat; k.z = s.z + s.nz * lat; k.y = s.y; k.idx = i; k.lat = lat; k.prog = i; k.progFine = i;
    k.heading = Math.atan2(s.tx, s.tz);
    k.speed = speed ?? k.topSpeed;
    k.vx = s.tx * k.speed; k.vz = s.tz * k.speed;
    k.invulnT = 1e9;
    k.lapCount = 0;
    k.lapStart = race.time;
    inp.accel = 1;
    return { race, k, inp };
  };
  /** 朝 (x, z) 開 */
  const aim = (k: K, inp: ReturnType<typeof emptyInput>, x: number, z: number) => {
    inp.steer = Math.max(-1, Math.min(1, wrapAngle(Math.atan2(x - k.x, z - k.z) - k.heading) * 2.2));
  };

  // 玻璃隧道：路邊就是牆（撞上去有 wall 事件，不會開出路面）
  {
    const { race, k, inp } = setup(430);
    let walls = 0, maxLat = 0;
    for (let t = 0; t < 2.5; t += dt) {
      const s = track.samples[k.idx];
      aim(k, inp, s.x + s.tx * 20 + s.nx * (hw + 30), s.z + s.tz * 20 + s.nz * (hw + 30));
      race.events.length = 0;
      race.step(dt, inp);
      maxLat = Math.max(maxLat, Math.abs(k.lat));
      for (const e of race.events) if (e.t === 'kart' && e.k === k && e.e === 'wall') walls++;
    }
    console.log(`glass tube wall: hits ${walls}, max |lat| ${maxLat.toFixed(1)} (half width ${hw})`);
    if (!walls || maxLat > hw) throw new Error('the glass tube should be a hard wall');
  }

  // 斷管捷徑：沿著窄底板開比走主線快；開出邊緣會掉進裂縫、回到主線，損失好幾秒
  const b = track.branches[0];
  const toDist = (b.def.to + 40) % track.length;
  const reached = (k: K) => {
    let d = track.samples[k.idx].dist - toDist;
    if (d < -track.length / 2) d += track.length;
    return !k.branch && d > -track.spacing * 2 && d < 30;
  };
  const run = (mode: 'main' | 'branch' | 'fall') => {
    const { race, k, inp } = setup(b.def.from - 60, b.def.lat, 33);
    let t = 0, fell = false, took = false;
    while (t < 25 && !reached(k)) {
      if (mode === 'main') {
        const s = track.samples[track.wrap(k.idx + Math.round(14 / track.spacing))];
        aim(k, inp, s.x, s.z);
      } else {
        // 沿著捷徑的中線開（捷徑的頭一段跟主線重疊，先靠到那一側），出了捷徑再沿主線開
        let tx: number, tz: number;
        const bi = k.branch ? k.bIdx : b.locate(k.x, k.z);
        const before = !took && track.samples[k.idx].dist < b.def.from;
        if (before) {
          const p = track.pointAt(track.samples[k.idx].dist + 14);
          tx = p.x + p.nx * b.def.lat; tz = p.z + p.nz * b.def.lat;
        } else if (bi < b.n - 3 && (k.branch || !took)) {
          const s = b.samples[Math.min(b.n - 1, bi + Math.round(12 / b.spacing))];
          tx = s.x; tz = s.z;
          if (mode === 'fall' && bi > b.n * 0.45) { tx += s.nx * 40; tz += s.nz * 40; }
        } else {
          const s = track.samples[track.wrap(k.idx + Math.round(14 / track.spacing))];
          tx = s.x; tz = s.z;
        }
        aim(k, inp, tx, tz);
      }
      race.events.length = 0;
      race.step(dt, inp);
      if (k.branch) took = true;
      for (const e of race.events) if (e.t === 'kart' && e.k === k && e.e === 'fall') fell = true;
      t += dt;
    }
    return { t, fell, took };
  };
  const main = run('main'), cut = run('branch'), fall = run('fall');
  console.log(`shortcut: main line ${main.t.toFixed(2)} s, shortcut ${cut.t.toFixed(2)} s (took ${cut.took}, fell ${cut.fell}), falling off ${fall.t.toFixed(2)} s (fell ${fall.fell})`);
  if (!cut.took || cut.fell) throw new Error('could not drive along the shortcut');
  if (main.t - cut.t < 1) throw new Error('the shortcut should save at least a second');
  if (!fall.fell || fall.t < cut.t + 1.5) throw new Error('falling off the broken tube should cost time');
}
console.log('SIM OK');

