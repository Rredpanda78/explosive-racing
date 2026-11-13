// 房間伺服器協定測試：node server/test/protocol.cjs [ws://127.0.0.1:8787] [origin]
// 建房、加入、轉發、開始後拒絕新人、斷線重連回原座位、房主斷線換人且回來不搶回、二進位轉發、離開、座位逾時
const WebSocket = require('../node_modules/ws');
const BASE = (process.argv[2] ?? 'ws://127.0.0.1:8787') + '/room/';
const ORIGIN = process.argv[3] ?? 'http://localhost:5173';
const code = 'T' + Math.floor(Math.random() * 90000 + 10000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL ' + msg); } else console.log('ok   ' + msg); };
const open = (cid, name, create = false) => new Promise((res) => {
  const ws = new WebSocket(`${BASE}${code}?cid=${cid}${create ? '&create=1' : ''}`, { origin: ORIGIN });
  const c = { ws, msgs: [], bins: [], name };
  ws.on('open', () => { ws.send(JSON.stringify({ t: 'hi', info: { name } })); res(c); });
  ws.on('message', (d, isBin) => { if (isBin) c.bins.push(Buffer.from(d)); else c.msgs.push(JSON.parse(d.toString())); });
  ws.on('unexpected-response', (_, r) => { c.msgs.push({ t: 'http', status: r.statusCode }); res(c); });
  ws.on('error', () => {});
});
const has = (c, f) => c.msgs.some(f);
(async () => {
  const bad = await open('x0', 'nobody');
  await wait(400);
  ok(has(bad, (m) => m.t === 'err' && m.code === 'noroom'), 'join missing room -> noroom');
  const A = await open('a1', 'A', true);
  await wait(400);
  const wA = A.msgs.find((m) => m.t === 'welcome');
  ok(wA && wA.pid === 1 && wA.host === 1, 'creator gets pid 1 and is host');
  ok(wA && typeof wA.colo === 'string', `welcome reports entry colo (${wA && wA.colo})`);
  let B = await open('b1', 'B');
  await wait(400);
  const wB = B.msgs.find((m) => m.t === 'welcome');
  ok(wB && wB.pid === 2 && wB.peers.length === 1 && wB.peers[0].info.name === 'A', 'joiner sees roster');
  ok(has(A, (m) => m.t === 'join' && m.pid === 2), 'host notified of join');
  A.ws.send(JSON.stringify({ t: 'r', d: { e: 'cfg' } }));
  B.ws.send(JSON.stringify({ t: 'r', d: { e: 'x' }, to: [1] }));
  await wait(400);
  ok(has(B, (m) => m.t === 'r' && m.from === 1 && m.d.e === 'cfg'), 'relay A -> B stamped from=1');
  ok(has(A, (m) => m.t === 'r' && m.from === 2 && m.d.e === 'x'), 'directed relay (array) B -> A');
  // 二進位：A 送給玩家 2（遮罩 0b10），B 收到時第一個位元組是 1
  A.ws.send(Buffer.from([0b10, 1, 0, 0]));
  await wait(400);
  ok(B.bins.length === 1 && B.bins[0][0] === 1 && B.bins[0][1] === 1, 'binary relay with mask, sender stamped');
  B.ws.send(JSON.stringify({ t: 'start', d: {} }));
  await wait(300);
  ok(!has(A, (m) => m.t === 'start'), 'non-host cannot start');
  A.ws.send(JSON.stringify({ t: 'start', d: { seed: 5 } }));
  await wait(400);
  ok(has(B, (m) => m.t === 'start' && m.d.seed === 5), 'host start broadcast');
  const C = await open('c1', 'C');
  await wait(400);
  ok(has(C, (m) => m.t === 'err' && m.code === 'started'), 'new player during race -> started');
  // 比賽中 B 斷線再連回：回到 2 號座位
  B.ws.terminate();
  await wait(800);
  ok(has(A, (m) => m.t === 'away' && m.pid === 2), 'drop -> others get away');
  B = await open('b1', 'B');
  await wait(500);
  const rB = B.msgs.find((m) => m.t === 'welcome');
  ok(rB && rB.pid === 2 && rB.rejoin === true && rB.started === true, 'reconnect during race -> same seat, rejoin');
  ok(has(A, (m) => m.t === 'back' && m.pid === 2), 'others get back');
  // 房主斷線：B 接手；房主回來不搶回
  A.ws.terminate();
  await wait(800);
  ok(has(B, (m) => m.t === 'host' && m.pid === 2), 'host drop -> B becomes host');
  const A2 = await open('a1', 'A');
  await wait(500);
  const rA = A2.msgs.find((m) => m.t === 'welcome');
  ok(rA && rA.pid === 1 && rA.host === 2, 'old host returns as pid 1 but host stays 2');
  // 主動離開：馬上讓出座位
  A2.ws.send(JSON.stringify({ t: 'bye' }));
  await wait(500);
  ok(has(B, (m) => m.t === 'leave' && m.pid === 1), 'bye -> leave immediately');
  B.ws.send(JSON.stringify({ t: 'lobby' }));
  const D = await open('d1', 'D');
  await wait(400);
  ok(has(D, (m) => m.t === 'welcome' && m.pid === 1), 'freed seat 1 reused after lobby');
  // 座位逾時：D 斷線 25 秒沒回來
  D.ws.terminate();
  console.log('     (waiting 27 s for the seat timeout)');
  await wait(27000);
  ok(has(B, (m) => m.t === 'leave' && m.pid === 1 && B.msgs.indexOf(m) > B.msgs.findIndex((x) => x.t === 'away' && x.pid === 1)), 'away seat released after timeout');
  B.ws.close();
  await wait(300);
  console.log(fails ? `${fails} FAILED` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();
