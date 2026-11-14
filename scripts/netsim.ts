export {};
declare const process: { argv: string[] };
// 兩個模擬玩家（房主 A、玩家 B）透過假的轉發（延遲 60 ms）一起跑一場，檢查兩邊看到的結果一致
let simNow = 0;
/**
 * 兩台電腦的時鐘本來就不一樣（performance.now 的起點不同）：處理 B 的事情時，B 的時鐘比 A 快（預設 7 秒）。
 * 開賽同步要靠量出來的時鐘差，讓兩邊在同一刻 GO。可用 skew=<毫秒>、load=<毫秒> 調整。
 */
let skew = 0;
const argNum = (k: string, d: number) => Number(process.argv.find((a) => a.startsWith(k + '='))?.slice(k.length + 1) ?? d);
const SKEW_B = argNum('skew', 7000);
(globalThis as unknown as { performance: { now: () => number } }).performance.now = () => simNow + skew;
// 計時器也跑在模擬時間裡（連線的 ping 每 2 秒一次、開賽時的補量），用註冊當時那台電腦的時鐘差
type Timer = { at: number; every: number; fn: () => void; skew: number; id: number };
const timers: Timer[] = [];
let timerId = 0;
const addTimer = (fn: () => void, ms: number, every: number) => { timers.push({ at: simNow + ms, every, fn, skew, id: ++timerId }); return timerId; };
(globalThis as unknown as { window: unknown }).window = {
  setInterval: (fn: () => void, ms: number) => addTimer(fn, ms, ms),
  setTimeout: (fn: () => void, ms: number) => addTimer(fn, ms, 0),
  clearInterval: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
};
const runTimers = () => {
  for (const t of [...timers]) {
    if (t.at > simNow) continue;
    skew = t.skew;
    t.fn();
    skew = 0;
    if (t.every > 0) t.at += t.every;
    else timers.splice(timers.indexOf(t), 1);
  }
};

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
// 競速賽：A 雷射、B 魚叉鉤；淘汰賽：A 電弧槍、B 機槍（電腦車手的武器隨機，新舊武器都會用到）
const wA = mode === 'race' ? 'laser' : 'arc', wB = mode === 'race' ? 'harpoon' : 'mg';
const A = new OnlineSession(info('A', 'kart-oobi', wA, 'grenade'), { ...cfg });
const B = new OnlineSession(info('B', 'kart-oodi', wB, 'missile'), { ...cfg });
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
skew = SKEW_B; H(B, { t: 'welcome', pid: 2, host: 1, peers: [{ pid: 1, info: info('A', 'kart-oobi', wA, 'grenade')() }] }); skew = 0;
H(A, { t: 'join', pid: 2, info: info('B', 'kart-oodi', wB, 'missile')() });

const races = new Map<unknown, InstanceType<typeof Race>>();
const track = new Track(TRACKS[trackIdx]);
/** B 的電腦比較慢：收到開賽後才花這麼久載完（真實情況：手機載場景、車子；預設 1.5 秒） */
const LOAD_B = argNum('load', 1500);
const later: { at: number; fn: () => void }[] = [];
for (const s of [A, B]) {
  s.onStart = (msg) => {
    const build = () => {
      skew = s === B ? SKEW_B : 0;
      const r = new Race(track, defaultProfile(), msg.cfg.mode, msg.seed, s.setup(msg));
      r.autoPlayer = true;
      r.player.aiAssist = true;
      s.attach(r);
      races.set(s, r);
      skew = 0;
    };
    if (s === B) later.push({ at: simNow + LOAD_B, fn: build });
    else build();
  };
}
// 先在房間裡等 5 秒（兩邊互相 ping 幾次），再由房主開始
for (let i = 0; i < 60 * 5; i++) {
  simNow += 1000 / 60;
  runTimers();
  while (queue.length && queue[0].at <= simNow) {
    const q = queue.shift()!;
    skew = q.to === B ? SKEW_B : 0;
    if (!(q.m as { bin?: ArrayBuffer }).bin) H(q.to, q.m);
    skew = 0;
  }
}
A.start();
const goAt = new Map<unknown, number>();
const dt = 1 / 60;
// drop：比賽中 B 斷線 8 秒再連回（伺服器保留座位），期間兩邊的訊息都丟掉
const DROP = process.argv.includes('drop');
let dropAt = -1, dropping = false;
const deliver = () => {
  while (queue.length && queue[0].at <= simNow) {
    const q = queue.shift()!;
    if (dropping) continue;
    const bm = q.m as { bin?: ArrayBuffer; from?: number };
    skew = q.to === B ? SKEW_B : 0;
    if (bm.bin) (q.to.client as unknown as { onBinary: (f: number, b: ArrayBuffer) => void }).onBinary(bm.from!, bm.bin);
    else H(q.to, q.m);
    skew = 0;
  }
};
let maxErr = 0, errSum = 0, errN = 0;
const evCount: Record<string, number> = {};
// 魚叉鉤：自己的車叉住（own）與別人的車叉住、畫面上照車主的訊息畫繩子（seen）；被別人的魚叉拖慢的幀數（被打的人自己判定）
const tetherOwn = [0, 0], tetherSeen = [0, 0];
let towFrames = 0;
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
    H(A, { t: 'back', pid: 2, info: info('B', 'kart-oodi', wB, 'missile')() });
    skew = SKEW_B; H(B, { t: 'welcome', pid: 2, host: 1, peers: [{ pid: 1, info: info('A', 'kart-oobi', wA, 'grenade')() }], rejoin: true, started: true }); skew = 0;
  }
  runTimers();
  for (const l of [...later]) if (l.at <= simNow) { later.splice(later.indexOf(l), 1); l.fn(); }
  deliver();
  for (const s of [A, B]) {
    const r = races.get(s);
    if (!r) continue;
    skew = s === B ? SKEW_B : 0;
    s.applyRemote(simNow + skew);
    const wasCount = r.state === 'countdown';
    r.step(dt, emptyInput());
    if (wasCount && r.state !== 'countdown' && !goAt.has(s)) goAt.set(s, simNow);
    for (const e of r.events) {
      const key = (s === A ? 'A:' : 'B:') + (e.t === 'kart' ? 'kart:' + e.e : e.t);
      evCount[key] = (evCount[key] ?? 0) + 1;
      if (e.t === 'tether' && e.on) (e.k.remote ? tetherSeen : tetherOwn)[s === A ? 0 : 1]++;
    }
    r.events.length = 0;
    for (const k of r.karts) if (!k.remote && k.towT > 0 && k.towBy?.remote) towFrames++;
    s.sendState(simNow + skew);
    skew = 0;
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
// 開賽同步：B 的時鐘不一樣、又比較晚載完，兩邊還是要在同一刻 GO
const goA = goAt.get(A) ?? NaN, goB = goAt.get(B) ?? NaN;
console.log(`start sync: GO at A ${goA.toFixed(0)} ms, B ${goB.toFixed(0)} ms (diff ${(goB - goA).toFixed(0)} ms; B's clock +${SKEW_B} ms, B loads ${LOAD_B} ms later)`);
if (!(Math.abs(goB - goA) <= 40)) throw new Error('players did not start at the same moment');
console.log(`track ${TRACKS[trackIdx].id}  mode ${mode}  time A ${ra.time.toFixed(1)} B ${rb.time.toFixed(1)}  state ${ra.state}/${rb.state}`);
console.log(`position error (own vs seen by other): avg ${(errSum / errN).toFixed(2)} m, max ${maxErr.toFixed(1)} m`);
const row = (r: InstanceType<typeof Race>) => r.karts.map((k) => `${k.name}:${k.kills}/${k.deaths}${k.out ? 'X' : ''}${k.finished ? '✓' : ''}`).join(' ');
console.log('A sees ' + row(ra));
console.log('B sees ' + row(rb));
console.log('A results: ' + ra.results().map((k) => k.name).join(' > '));
console.log('B results: ' + rb.results().map((k) => k.name).join(' > '));
console.log(Object.entries(evCount).filter(([k]) => /launch|kill|respawn|finish|elim|dmg|blast|zap|pulse|hook|tether/.test(k)).sort().map(([k, v]) => `${k}=${v}`).join(' '));
console.log(`harpoon: latched by own cars A ${tetherOwn[0]} B ${tetherOwn[1]}, ropes shown for the other side's cars A ${tetherSeen[0]} B ${tetherSeen[1]}, frames a car was slowed by a remote harpoon ${towFrames}`);
if ((tetherOwn[1] >= 3 && tetherSeen[0] === 0) || (tetherOwn[0] >= 3 && tetherSeen[1] === 0)) throw new Error('harpoon tethers are not shown on the other side');
for (const r of [ra, rb]) for (const k of r.karts) if (!isFinite(k.x) || !isFinite(k.z) || !isFinite(k.chill)) throw new Error('NaN in kart state');
const bots = (r: InstanceType<typeof Race>) => r.karts.filter((k) => k.bot).map((k) => k.owner).join('');
console.log(`AI owners  A sees ${bots(ra)}  B sees ${bots(rb)}${bots(ra) === bots(rb) ? '  (agree)' : '  (DISAGREE)'}`);
let mism = 0;
for (let i = 0; i < ra.karts.length; i++) if (ra.karts[i].kills !== rb.karts[i].kills || ra.karts[i].deaths !== rb.karts[i].deaths) mism++;
console.log(mism ? `kill/death mismatch on ${mism} karts` : 'kills/deaths consistent');
