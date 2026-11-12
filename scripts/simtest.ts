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

// ---- 2. 玩家甩尾測試：直線加速後左甩 1.2 秒，放開並小噴 ----
{
  const race = new Race(track, defaultProfile(), 1);
  const k = race.player;
  const inp = emptyInput();
  const dt = 1 / 60;
  const log: string[] = [];
  let t = 0;
  // 跳過倒數
  while (race.state === 'countdown') race.step(dt, inp);
  race.events.length = 0;
  inp.accel = 1;
  let maxSlip = 0, minSpeed = 99, gotMini = false;
  for (let i = 0; i < 60 * 9; i++) {
    t = i * dt;
    inp.drift = t > 5 && t < 5.5;
    inp.steer = t > 5 && t < 5.5 ? 1 : t >= 5.5 && t < 5.8 ? -0.7 : 0;
    // 甩尾結束後重按油門觸發小噴
    if (!k.drifting && k.miniWindowT > 0) inp.accel = inp.accel === 1 ? 0 : 1;
    else inp.accel = 1;
    race.step(dt, inp);
    for (const e of race.events) if (e.t === 'kart' && e.k === k && e.e === 'mini') gotMini = true;
    race.events.length = 0;
    if (t > 5) { maxSlip = Math.max(maxSlip, Math.abs(k.slip)); minSpeed = Math.min(minSpeed, k.speed); }
    if (i % 30 === 0 || (t > 5 && t < 6.6 && i % 6 === 0)) log.push(`t=${t.toFixed(1)} v=${k.speed.toFixed(1)} slip=${(k.slip * 57.3).toFixed(0)}° drift=${k.drifting} gauge=${k.gauge.toFixed(2)} lat=${k.lat.toFixed(1)}`);
  }
  console.log(log.join('\n'));
  console.log(`top speed cfg ${CFG.maxSpeed}, max slip ${(maxSlip * 57.3).toFixed(0)}°, min speed after drift ${minSpeed.toFixed(1)}, mini boost ${gotMini}`);
  if (maxSlip < 0.4) throw new Error('drift slip too small');
  if (k.gauge <= 0.05) throw new Error('gauge did not fill');
}
console.log('SIM OK');
