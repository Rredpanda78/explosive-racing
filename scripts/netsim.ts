export {};
declare const process: { argv: string[] };
// 兩個模擬玩家（房主 A、玩家 B）透過假的轉發（延遲 60 ms）一起跑一場，檢查兩邊看到的結果一致
let simNow = 0;
(globalThis as unknown as { performance: { now: () => number } }).performance.now = () => simNow;
(globalThis as unknown as { window: unknown }).window = { setInterval: () => 0, clearInterval: () => {} };

const { emptyInput } = await import('../src/game/kart');
const { Race } = await import('../src/game/race');
const { defaultProfile } = await import('../src/game/save');
const { Track, TRACKS } = await import('../src/game/track');
const { OnlineSession } = await import('../src/net/online');

const mode = (process.argv[2] ?? 'race') as 'race' | 'elim';
// 賽道：track=<賽道 id>，或第三個參數直接給 id（預設第 2 條，赤岩峽谷）
const trackArg = process.argv.find((a) => a.startsWith('track='))?.slice(6) ?? process.argv.slice(3).find((a) => a !== 'drop' && !a.includes('='));
const trackIdx = trackArg ? TRACKS.findIndex((t) => t.id === trackArg) : 1;
if (trackIdx < 0) throw new Error(`unknown track ${trackArg}`);
const LAT = 60;
// rtt 120 ms = 單程 60 ms
type Msg = { at: number; to: InstanceType<typeof OnlineSession>; m: unknown };
const queue: Msg[] = [];
const info = (name: string, car: string, primary: string, secondary: string) => () => ({
  name, car, livery: 0, primary, secondary, plvl: 3, slvl: 3, engine: 0, n2o: 0, armor: 0,
}) as never;
const cfg = { track: trackIdx, mode, aiFill: true, difficulty: 'normal' as const };
const A = new OnlineSession(info('A', 'kart-oobi', 'laser', 'grenade'), { ...cfg });
const B = new OnlineSession(info('B', 'kart-oodi', 'mg', 'missile'), { ...cfg });
const fake = (self: InstanceType<typeof OnlineSession>, other: InstanceType<typeof OnlineSession>, pid: number) => {
  const c = self.client as unknown as Record<string, unknown>;
  c.rtt = 120;
  c.send = (m: { t: string; d?: unknown }) => { if (m.t === 'start') queue.push({ at: simNow + LAT, to: other, m: { t: 'start', d: m.d } }); };
  c.relay = (d: unknown) => queue.push({ at: simNow + LAT, to: other, m: { t: 'r', from: pid, d } });
  // 二進位狀態：伺服器把第一個位元組換成發送者編號
  c.sendBin = (buf: Uint8Array) => {
    const out = buf.slice();
    out[0] = pid;
    queue.push({ at: simNow + LAT, to: other, m: { bin: out.buffer, from: pid } });
  };
};
fake(A, B, 1);
fake(B, A, 2);
const H = (s: InstanceType<typeof OnlineSession>, m: unknown) => (s as unknown as { handle: (m: unknown) => void }).handle(m);
H(A, { t: 'welcome', pid: 1, host: 1, peers: [] });
H(B, { t: 'welcome', pid: 2, host: 1, peers: [{ pid: 1, info: info('A', 'kart-oobi', 'laser', 'grenade')() }] });
H(A, { t: 'join', pid: 2, info: info('B', 'kart-oodi', 'mg', 'missile')() });

const races = new Map<unknown, InstanceType<typeof Race>>();
const track = new Track(TRACKS[trackIdx]);
for (const s of [A, B]) {
  s.onStart = (msg) => {
    const r = new Race(track, defaultProfile(), msg.cfg.mode, msg.seed, s.setup(msg));
    r.autoPlayer = true;
    r.player.aiAssist = true;
    s.attach(r);
    races.set(s, r);
  };
}
A.start();
const dt = 1 / 60;
// drop：比賽中 B 斷線 8 秒再連回（伺服器保留座位），期間兩邊的訊息都丟掉
const DROP = process.argv.includes('drop');
let dropAt = -1, dropping = false;
const deliver = () => {
  while (queue.length && queue[0].at <= simNow) {
    const q = queue.shift()!;
    if (dropping) continue;
    const bm = q.m as { bin?: ArrayBuffer; from?: number };
    if (bm.bin) (q.to.client as unknown as { onBinary: (f: number, b: ArrayBuffer) => void }).onBinary(bm.from!, bm.bin);
    else H(q.to, q.m);
  }
};
let maxErr = 0, errSum = 0, errN = 0;
const evCount: Record<string, number> = {};
for (let step = 0; step < 60 * 260; step++) {
  simNow += 1000 * dt;
  const r0 = races.get(A);
  if (DROP && r0 && r0.time > 40 && dropAt < 0) {
    dropAt = step;
    dropping = true;
    H(A, { t: 'away', pid: 2 });
  }
  if (DROP && dropAt >= 0 && step === dropAt + 60 * 8) {
    dropping = false;
    H(A, { t: 'back', pid: 2, info: info('B', 'kart-oodi', 'mg', 'missile')() });
    H(B, { t: 'welcome', pid: 2, host: 1, peers: [{ pid: 1, info: info('A', 'kart-oobi', 'laser', 'grenade')() }], rejoin: true, started: true });
  }
  deliver();
  for (const s of [A, B]) {
    const r = races.get(s);
    if (!r) continue;
    s.applyRemote(simNow);
    r.step(dt, emptyInput());
    for (const e of r.events) {
      const key = (s === A ? 'A:' : 'B:') + (e.t === 'kart' ? 'kart:' + e.e : e.t);
      evCount[key] = (evCount[key] ?? 0) + 1;
    }
    r.events.length = 0;
    s.sendState(simNow);
  }
  const ra = races.get(A), rb = races.get(B);
  if (ra && rb && ra.state !== 'countdown' && step % 30 === 0) {
    // B 的車：B 自己的位置 vs A 看到的位置；電腦車：A（房主）vs B 看到的
    for (let i = 0; i < ra.karts.length; i++) {
      const own = ra.karts[i].remote ? rb.karts[i] : ra.karts[i];
      const seen = ra.karts[i].remote ? ra.karts[i] : rb.karts[i];
      if (own.dead || seen.dead || own.out) continue;
      const e = Math.hypot(own.x - seen.x, own.z - seen.z);
      maxErr = Math.max(maxErr, e);
      errSum += e;
      errN++;
    }
  }
  if (ra && rb && ra.state === 'finished' && rb.state === 'finished' && ra.karts.every((k) => k.finished || k.out) && rb.karts.every((k) => k.finished || k.out)) break;
}
const ra = races.get(A)!, rb = races.get(B)!;
console.log(`track ${TRACKS[trackIdx].id}  mode ${mode}  time A ${ra.time.toFixed(1)} B ${rb.time.toFixed(1)}  state ${ra.state}/${rb.state}`);
console.log(`position error (own vs seen by other): avg ${(errSum / errN).toFixed(2)} m, max ${maxErr.toFixed(1)} m`);
const row = (r: InstanceType<typeof Race>) => r.karts.map((k) => `${k.name}:${k.kills}/${k.deaths}${k.out ? 'X' : ''}${k.finished ? '✓' : ''}`).join(' ');
console.log('A sees ' + row(ra));
console.log('B sees ' + row(rb));
console.log('A results: ' + ra.results().map((k) => k.name).join(' > '));
console.log('B results: ' + rb.results().map((k) => k.name).join(' > '));
console.log(Object.entries(evCount).filter(([k]) => /launch|kill|respawn|finish|elim|dmg|blast/.test(k)).sort().map(([k, v]) => `${k}=${v}`).join(' '));
const bots = (r: InstanceType<typeof Race>) => r.karts.filter((k) => k.bot).map((k) => k.owner).join('');
console.log(`AI owners  A sees ${bots(ra)}  B sees ${bots(rb)}${bots(ra) === bots(rb) ? '  (agree)' : '  (DISAGREE)'}`);
let mism = 0;
for (let i = 0; i < ra.karts.length; i++) if (ra.karts[i].kills !== rb.karts[i].kills || ra.karts[i].deaths !== rb.karts[i].deaths) mism++;
console.log(mism ? `kill/death mismatch on ${mism} karts` : 'kills/deaths consistent');
