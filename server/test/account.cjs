// 帳號伺服器測試：先 cd server && npx wrangler dev -c wrangler.account-test.toml --port 8790，再 node test/account.cjs [http://127.0.0.1:8790]
// 註冊、名稱／密碼規則、登入、打錯鎖住、me、存讀檔、版本衝突、內容一樣不寫、登出、登出所有裝置、改密碼、救援碼重設、存檔太大、別人的憑證
const crypto = require('node:crypto');
const BASE = process.argv[2] ?? 'http://127.0.0.1:8790';
const ORIGIN = 'http://localhost:5173';
const PROD_ORIGIN = 'https://racing-prod.invalid';
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL ' + msg); } else console.log('ok   ' + msg); };
const rnd = () => Math.random().toString(36).slice(2, 9);
/** POST /account（text/plain，跟網頁一樣）→ { status, data, headers, ms } */
async function call(body, origin = ORIGIN, extra = {}) {
  const t0 = performance.now();
  const r = await fetch(BASE + '/account', { method: 'POST', headers: { Origin: origin, 'content-type': 'text/plain;charset=UTF-8', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data, headers: r.headers, ms: performance.now() - t0 };
}
/** 跟伺服器一樣的鍵排序 JSON + SHA-256 */
function canon(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  return '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const profile = (cash, races = 3) => ({ cash, owned: { mg: true, rocket: true }, lvl: { mg: 2, rocket: 1 }, primary: 'mg', secondary: 'rocket', car: { engine: 1, n2o: 0, armor: 0 }, kart: 'kart-oobi', karts: { 'kart-oobi': true, 'kart-ooli': true }, bestLap: 0, track: 'skyline-loop', bestLaps: { 'skyline-loop': 41.2 }, races, wins: 1, weaponsV2: true, difficulty: 'normal', livery: {} });

(async () => {
  const name = 'T_' + rnd();
  const lower = name.toLowerCase();
  const pw = 'Correct-Horse-1';
  // ---------- 註冊 ----------
  const reg = await call({ op: 'reg', name, pw });
  ok(reg.status === 200 && typeof reg.data.tok === 'string', 'register -> 200 with token');
  ok(reg.data.name === lower, 'register stores lowercase name');
  ok(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/.test(reg.data.rc ?? ''), `register returns recovery code ${reg.data.rc}`);
  ok(reg.headers.get('access-control-allow-origin') === ORIGIN && /Origin/.test(reg.headers.get('vary') ?? ''), 'CORS echoes origin with Vary: Origin');
  const regMs = reg.ms;
  let tok = reg.data.tok;
  let rc = reg.data.rc;
  const dup = await call({ op: 'reg', name: name.toUpperCase(), pw: 'Another-pass-9' });
  ok(dup.status === 409 && dup.data.err === 'taken', 'duplicate name (case-insensitive) -> 409 taken');

  // ---------- 名稱、密碼規則 ----------
  const bad = async (body, err, why, msg) => { const r = await call({ op: 'reg', ...body }); ok(r.status === 400 && r.data.err === err && r.data.why === why, `${msg} -> 400 ${err}/${why} (got ${r.status} ${JSON.stringify(r.data)})`); };
  await bad({ name: 'ab', pw }, 'name', 'len', 'name too short');
  await bad({ name: 'x'.repeat(21), pw }, 'name', 'len', 'name too long');
  await bad({ name: 'bad name!', pw }, 'name', 'chars', 'name with bad chars');
  await bad({ name: '名字abc', pw }, 'name', 'chars', 'name with non-ASCII');
  await bad({ name: 'admin', pw }, 'name', 'reserved', 'reserved name');
  await bad({ name: 'Admin_x', pw }, 'name', 'reserved', 'reserved prefix');
  const n2 = 'u_' + rnd();
  await bad({ name: n2, pw: 'short1' }, 'weakpw', 'len', 'password too short');
  await bad({ name: n2, pw: 'x'.repeat(65) }, 'weakpw', 'len', 'password too long');
  await bad({ name: n2, pw: n2.toUpperCase() }, 'weakpw', 'same', 'password equals name');
  await bad({ name: n2, pw: 'Password' }, 'weakpw', 'weak', 'common password');
  await bad({ name: n2, pw: 'zzzzzzzzzz' }, 'weakpw', 'weak', 'one repeated char');
  await bad({ name: n2, pw: 'abc\u0001defgh' }, 'weakpw', 'ctrl', 'control char');
  const zh = await call({ op: 'reg', name: n2, pw: '我的密碼很長很安全' });
  ok(zh.status === 200, 'non-ASCII 9-char password accepted');

  // ---------- 登入 ----------
  const li = await call({ op: 'login', name: '  ' + name.toUpperCase() + ' ', pw });
  ok(li.status === 200 && typeof li.data.tok === 'string' && li.data.name === lower, 'login ok (case-insensitive name, trimmed)');
  const wrong = await call({ op: 'login', name, pw: 'wrong-password' });
  const ghost = await call({ op: 'login', name: 'nobody_' + rnd(), pw });
  ok(wrong.status === 403 && wrong.data.err === 'auth', 'wrong password -> 403 auth');
  ok(ghost.status === 403 && JSON.stringify(ghost.data) === JSON.stringify(wrong.data), 'unknown name -> identical generic auth error');
  const badName = await call({ op: 'login', name: 'a', pw });
  ok(badName.status === 403 && badName.data.err === 'auth', 'invalid name on login -> auth (not name)');

  // ---------- 打錯 10 次鎖住 ----------
  const lname = 'lk_' + rnd();
  await call({ op: 'reg', name: lname, pw });
  let last;
  for (let i = 0; i < 9; i++) last = await call({ op: 'login', name: lname, pw: 'nope-nope-' + i });
  ok(last.status === 403 && last.data.err === 'auth', '9 wrong -> still auth');
  last = await call({ op: 'login', name: lname, pw: 'nope-nope-x' });
  ok(last.status === 423 && last.data.err === 'locked' && last.data.ms > 14 * 60_000 && last.data.ms <= 15 * 60_000, `10th wrong -> 423 locked (ms ${last.data.ms})`);
  last = await call({ op: 'login', name: lname, pw });
  ok(last.status === 423 && last.data.err === 'locked', 'correct password while locked -> 423');

  // ---------- me ----------
  let me = await call({ op: 'me', tok });
  ok(me.status === 200 && me.data.name === lower && me.data.save === null && me.data.devices === 2 && me.data.made > 0, `me -> name, no save, 2 devices (${JSON.stringify(me.data)})`);
  const meMs = me.ms;

  // ---------- 存檔 ----------
  const p1 = profile(1500);
  let sv = await call({ op: 'save', tok, base: 0, data: p1 });
  ok(sv.status === 200 && sv.data.v === 1 && sv.data.at > 0, 'save base 0 -> v1');
  let ld = await call({ op: 'load', tok });
  ok(ld.status === 200 && ld.data.v === 1 && canon(ld.data.data) === canon(p1), 'load returns same data (round trip)');
  me = await call({ op: 'me', tok });
  ok(me.data.save && me.data.save.v === 1 && me.data.save.h === sha(canon(p1)), 'me.save.h = SHA-256 of canonical JSON');
  ok(me.data.save && me.data.save.sum.cash === 1500 && me.data.save.sum.races === 3 && me.data.save.sum.wins === 1 && me.data.save.sum.karts === 2, 'me.save.sum has cash/races/wins/karts');
  const stale = await call({ op: 'save', tok, base: 0, data: profile(2000) });
  ok(stale.status === 409 && stale.data.err === 'conflict' && stale.data.v === 1 && stale.data.sum.cash === 1500, 'stale base -> 409 conflict with cloud v + sum');
  const reordered = Object.fromEntries(Object.entries(p1).reverse());
  const same = await call({ op: 'save', tok, base: 1, data: reordered });
  ok(same.status === 200 && same.data.v === 1 && same.data.same === true, 'identical content (other key order) -> no-op, v unchanged');
  sv = await call({ op: 'save', tok, base: 1, data: profile(2500, 4) });
  ok(sv.status === 200 && sv.data.v === 2, 'save base 1 -> v2');
  const big = await call({ op: 'save', tok, base: 2, data: { ...profile(1), junk: 'x'.repeat(97 * 1024) } });
  ok(big.status === 413 && big.data.err === 'big', 'oversized save (>96 KB) -> 413 big');
  const bigBody = await call({ op: 'save', tok, base: 2, data: { ...profile(1), junk: 'x'.repeat(200 * 1024) } });
  ok(bigBody.status === 413, 'oversized body -> 413');
  const neg = await call({ op: 'save', tok, base: 2, data: profile(-5) });
  ok(neg.status === 422 && neg.data.err === 'odd' && neg.data.key === 'cash', 'negative cash -> 422 odd cash');
  const rich = await call({ op: 'save', tok, base: 2, data: profile(10_000_001) });
  ok(rich.status === 422 && rich.data.key === 'cash', 'cash > 10,000,000 -> 422 odd');
  const badRaces = await call({ op: 'save', tok, base: 2, data: { ...profile(5), races: 1.5 } });
  ok(badRaces.status === 422 && badRaces.data.key === 'races', 'non-integer races -> 422 odd races');
  const notObj = await call({ op: 'save', tok, base: 2, data: [1, 2] });
  ok(notObj.status === 400 && notObj.data.err === 'save', 'array save -> 400 save');
  const prodLoad = await call({ op: 'load', tok }, PROD_ORIGIN);
  ok(prodLoad.status === 200 && prodLoad.data.v === 0 && prodLoad.data.data === null, 'prod origin sees its own empty slot (dev save separate)');
  const smallBig = await call({ op: 'me', tok, pad: 'x'.repeat(5000) });
  ok(smallBig.status === 413, 'non-save op > 4 KB -> 413');

  // ---------- 登出 ----------
  const t2 = (await call({ op: 'login', name, pw })).data.tok;
  ok((await call({ op: 'logout', tok: t2 })).status === 200, 'logout -> 200');
  ok((await call({ op: 'me', tok: t2 })).status === 403, 'logged-out token rejected');
  ok((await call({ op: 'me', tok })).status === 200, 'other token still valid after logout');
  const t3 = (await call({ op: 'login', name, pw })).data.tok;
  const t4 = (await call({ op: 'login', name, pw })).data.tok;
  ok((await call({ op: 'logoutAll', tok: t3 })).status === 200, 'logoutAll -> 200');
  const after = await Promise.all([tok, t3, t4, li.data.tok].map((t) => call({ op: 'me', tok: t })));
  ok(after.every((r) => r.status === 403 && r.data.err === 'auth'), 'logoutAll invalidates every token');

  // ---------- 改密碼 ----------
  const t5 = (await call({ op: 'login', name, pw })).data.tok;
  const t6 = (await call({ op: 'login', name, pw })).data.tok;
  const pwBad = await call({ op: 'pw', tok: t5, old: 'not-my-password', pw: 'Brand-New-Pass-2' });
  ok(pwBad.status === 403 && pwBad.data.err === 'badpw', 'pw change with wrong old -> 403 badpw');
  const pwWeak = await call({ op: 'pw', tok: t5, old: pw, pw: '12345678' });
  ok(pwWeak.status === 400 && pwWeak.data.err === 'weakpw' && pwWeak.data.why === 'weak', 'pw change to weak -> 400 weakpw');
  const pw2 = 'Brand-New-Pass-2';
  const pwOk = await call({ op: 'pw', tok: t5, old: pw, pw: pw2 });
  ok(pwOk.status === 200, 'pw change -> 200');
  ok((await call({ op: 'me', tok: t5 })).status === 200, 'pw change keeps this device');
  ok((await call({ op: 'me', tok: t6 })).status === 403, 'pw change logs out other devices');
  ok((await call({ op: 'login', name, pw })).status === 403, 'old password no longer works');
  const t7 = (await call({ op: 'login', name, pw: pw2 })).data.tok;
  ok(typeof t7 === 'string', 'new password works');

  // ---------- 救援碼 ----------
  const rcBad = await call({ op: 'rc', tok: t5, pw: 'wrong-password' });
  ok(rcBad.status === 403 && rcBad.data.err === 'badpw', 'new recovery code needs password');
  const rcNew = await call({ op: 'rc', tok: t5, pw: pw2 });
  ok(rcNew.status === 200 && /^[2-9A-HJ-NP-Z-]{23}$/.test(rcNew.data.rc ?? '') && rcNew.data.rc !== rc, 'rc -> new recovery code');
  const oldRc = await call({ op: 'reset', name, rc, pw: 'Reset-Pass-333' });
  ok(oldRc.status === 403 && oldRc.data.err === 'auth', 'old recovery code no longer works');
  rc = rcNew.data.rc;
  const rcWeak = await call({ op: 'reset', name, rc: rc.toLowerCase().replace(/-/g, ' '), pw: 'password' });
  ok(rcWeak.status === 400 && rcWeak.data.err === 'weakpw', 'reset with right code but weak password -> 400 weakpw');
  const pw3 = 'Reset-Pass-333';
  const rs = await call({ op: 'reset', name, rc, pw: pw3 });
  ok(rs.status === 200 && typeof rs.data.tok === 'string' && rs.data.rc && rs.data.rc !== rc, 'reset (code still valid after weak attempt) -> token + new code');
  const gone = await Promise.all([t5, t7].map((t) => call({ op: 'me', tok: t })));
  ok(gone.every((r) => r.status === 403), 'reset logs out every device');
  ok((await call({ op: 'me', tok: rs.data.tok })).status === 200, 'token from reset works');
  ok((await call({ op: 'login', name, pw: pw2 })).status === 403, 'password before reset no longer works');
  ok((await call({ op: 'reset', name, rc, pw: 'Another-Reset-4' })).status === 403, 'used recovery code no longer works');
  tok = (await call({ op: 'login', name, pw: pw3 })).data.tok;
  ld = await call({ op: 'load', tok });
  ok(ld.data.v === 2 && ld.data.data.cash === 2500, 'cloud save survives password reset');

  // ---------- 別人的憑證 ----------
  const other = await call({ op: 'reg', name: 'o_' + rnd(), pw });
  const [aId, aTid, aSec] = tok.split('.');
  const [bId] = other.data.tok.split('.');
  ok((await call({ op: 'me', tok: `${bId}.${aTid}.${aSec}` })).status === 403, 'token with another account id -> 403');
  ok((await call({ op: 'me', tok: `${aId}.${aTid}.${'A'.repeat(32)}` })).status === 403, 'token with wrong secret -> 403');
  ok((await call({ op: 'me', tok: `${'f'.repeat(64)}.${aTid}.${aSec}` })).status === 403, 'token with forged object id -> 403');
  ok((await call({ op: 'me', tok: 'garbage' })).status === 403, 'garbage token -> 403');
  ok((await call({ op: 'save', tok: other.data.tok, base: 0, data: profile(1) })).status === 200, 'other account has its own save');
  ok((await call({ op: 'load', tok })).data.data.cash === 2500, "other account's save does not touch ours");

  // ---------- 其他 ----------
  const unk = await call({ op: 'frobnicate', tok });
  ok(unk.status === 400 && unk.data.err === 'op', 'unknown op -> 400 op');
  const notJson = await call('{not json');
  ok(notJson.status === 400 && notJson.data.err === 'bad', 'non-JSON body -> 400 bad');
  const evil = await call({ op: 'me', tok }, 'https://evil.example');
  ok(evil.status === 403, 'origin not allowed -> 403');
  const get = await fetch(BASE + '/account', { headers: { Origin: ORIGIN } });
  ok(get.status === 405, 'GET /account -> 405');
  // 每個 IP 的限速（假的 CF-Connecting-IP；wrangler dev 不一定照傳）：重設一次 5 個
  const ipName = 'ip_' + rnd();
  const fakeIp = { 'CF-Connecting-IP': `203.0.113.${Math.floor(Math.random() * 250) + 1}` };
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call({ op: 'reset', name: ipName, rc: 'X', pw }, ORIGIN, fakeIp)).status);
  if (codes.includes(429)) ok(codes.slice(0, 5).every((c) => c === 403) && codes[5] === 429, `per-IP reset cap (5 then 429): ${codes.join(',')}`);
  else console.log(`skip per-IP cap (dev server ignores CF-Connecting-IP header): ${codes.join(',')}`);

  console.log(`\ntiming (local wrangler dev): register ${regMs.toFixed(0)} ms, me ${meMs.toFixed(0)} ms (difference ~ PBKDF2 x1 + SHA-256)`);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
