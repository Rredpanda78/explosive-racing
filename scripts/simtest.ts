// 無畫面模擬測試：讓 8 台車（含玩家位）全由 AI 跑完比賽，檢查物理與比賽流程。
// 另外用腳本化的輸入測試玩家的甩尾／集氣／N2O。
import { CFG } from '../src/game/config';
import { emptyInput } from '../src/game/kart';
import { Race } from '../src/game/race';
import { defaultProfile } from '../src/game/save';
import { Track, TRACKS } from '../src/game/track';

const track = new Track(TRACKS[0]);
let kmax = 0;
for (const s of track.samples) kmax = Math.max(kmax, Math.abs(s.curv));
console.log(`track length ${track.length.toFixed(0)} m, samples ${track.n}, min radius ${(1 / kmax).toFixed(1)} m`);

// ---- 1. 全 AI 比賽 ----
{
  const race = new Race(track, defaultProfile(), 12345);
  race.autoPlayer = true;
  race.player.aiAssist = true;
  const dt = 1 / 60;
  const count: Record<string, number> = {};
  let t = 0;
  while (t < 400 && !race.karts.every((k) => k.finished)) {
    race.step(dt, emptyInput());
    for (const e of race.events) {
      const key = e.t === 'kart' ? `kart:${e.e}` : e.t;
      count[key] = (count[key] || 0) + 1;
    }
    race.events.length = 0;
    t += dt;
  }
  console.log('events', count);
  for (const k of race.results()) {
    console.log(
      `${k.rank}. ${k.name.padEnd(4)} finish ${k.finished ? k.finishTime.toFixed(1) : 'DNF'} laps [${k.lapTimes.map((x) => x.toFixed(1)).join(', ')}] kills ${k.kills} deaths ${k.deaths} ${k.primary}/${k.secondary}`,
    );
  }
  for (const k of race.karts) {
    if (!isFinite(k.x) || !isFinite(k.z)) throw new Error('NaN position');
    if (!k.finished) throw new Error(`${k.name} did not finish`);
  }
}

// ---- 2. 玩家甩尾測試：在超寬賽道上（不會撞牆）量測各種操作下甩尾能維持多久 ----
{
  const wide = new Track({ ...TRACKS[0], halfWidth: 2000 });
  const dt = 1 / 60;
  const scenario = (name: string, shiftT: number, after: number): number => {
    const race = new Race(wide, defaultProfile(), 1);
    for (const k of race.karts) if (!k.isPlayer) { k.x += 5000; }
    const k = race.player;
    const inp = emptyInput();
    while (race.state === 'countdown') race.step(dt, inp);
    inp.accel = 1;
    for (let i = 0; i < 60 * 5; i++) race.step(dt, inp);
    const h0 = k.heading, g0 = k.gauge, v0 = k.speed;
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
    let turned = (k.heading - h0) * 57.3;
    console.log(`${name.padEnd(26)} drift ${dur.toFixed(2)}s  maxSlip ${(maxSlip * 57.3).toFixed(0)}°  v ${v0.toFixed(1)}→min ${vMin.toFixed(1)}  gauge +${(k.gauge - g0).toFixed(2)}  heading Δ${turned.toFixed(0)}°  mini ${mini}`);
    return dur;
  };
  const hold = scenario('tap 0.3s + hold dir', 0.3, 1);
  const neutral = scenario('tap 0.3s + neutral', 0.3, 0);
  const counter = scenario('tap 0.3s + counter', 0.3, -1);
  scenario('hold 1.0s + hold dir', 1.0, 1);
  scenario('hold 1.0s + counter', 1.0, -1);
  if (!(hold > neutral && neutral > counter)) throw new Error('drift durations out of order');
  if (hold < 1.5) throw new Error('held drift too short');
}
console.log('SIM OK');
