/**
 * 帳號＋雲端存檔（照羽球對決 server/src/account*.ts 的最小核心：只有名稱＋密碼、救援碼、登入憑證、一份雲端存檔）。
 *
 * POST /account：內容是 JSON 文字（網頁用 text/plain 送，簡單請求不用 CORS 預檢）{ op, ... }。
 * Origin 由呼叫的人先檢查過（index.ts 的允許名單），這裡照樣回 CORS（Vary: Origin）。
 *
 * 操作：
 * - reg { name, pw } → { tok, rc, name }（rc = 救援碼，只給這一次）；名稱有人用 = 409 taken
 * - login { name, pw } → { tok, name }；名稱不存在、密碼不對一律 403 auth；連續錯 10 次鎖 15 分鐘 = 423 locked { ms }
 * - reset { name, rc, pw } → { tok, rc }：用救援碼重設密碼（先驗救援碼才看新密碼）；所有裝置登出、換新的救援碼
 * - 帶 tok：me → { name, made, save: { v, at, h, sum } | null, devices }、load → { v, at, data }、
 *   save { base, data } → { v, at }（base = 這台上次拿到的版本；雲端比較新 = 409 conflict；內容一樣 = 不寫，same: true）、
 *   logout、logoutAll、pw { old, pw }（其他裝置登出、這台留著）、rc { pw } → { rc }
 * 憑證不對、過期 = 403 auth。
 *
 * 每個帳號一個 Durable Object（Account，idFromName('u:' + 小寫名稱)），同一個帳號的請求一次一個（run）。
 * 儲存：'acct' = AccountRec；'s:dev'、's:prod' = 存檔本身（JSON 字串）。
 * 槽位照 Origin：localhost／127.0.0.1 = dev，其他 = prod（本機測試不會蓋到正式的進度）。
 *
 * 要算密碼雜湊的操作（reg／login／reset／pw／rc）每個 IP 另外限速：Limiter（一個全域物件，記憶體裡的 token bucket；
 * IP 存加鹽 SHA-256，IPv6 取 /64）。本機（127.0.0.1、::1、沒有 CF-Connecting-IP）不限。
 */
import { DurableObject } from 'cloudflare:workers';

export interface AccountEnv {
  ACCOUNT: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  /** IP 雜湊的鹽（沒設用 DEFAULT_SALT） */
  IP_SALT?: string;
}

// ---------- 數字 ----------

export const NAME_MIN = 3;
export const NAME_MAX = 20;
export const PW_MIN = 8;
export const PW_MAX = 64;
/** PBKDF2-SHA256 次數：Workers 正式環境最多收 100,000（本機 wrangler dev 不擋，調高會部署後才壞）。存在每個帳號裡，以後改次數舊帳號照舊算、登入成功時換新 */
export const PBKDF2_ITER = 100_000;
export const SALT_BYTES = 16;
/** 救援碼：20 個字（去掉 0 O 1 I），約 100 位元，顯示成 5 個一組 */
export const RC_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const RC_LEN = 20;
/** 登入憑證：30 天沒用過期（用了延長，最多每小時寫一次）、每個帳號最多 10 個 */
export const TOKEN_TTL_MS = 30 * 86_400_000;
export const TOKEN_TOUCH_MS = 3_600_000;
export const TOKENS_MAX = 10;
/** 連續打錯 10 次鎖 15 分鐘（救援碼另外算） */
export const LOCK_FAILS = 10;
export const LOCK_MS = 15 * 60_000;
/** 存檔最大（JSON 的位元組）、其他操作的內容最大 */
export const SAVE_MAX = 96 * 1024;
export const SMALL_MAX = 4096;
const BODY_MAX = SAVE_MAX + 4096;

interface CapSpec {
  rate: number;
  burst: number;
}
/** 每個 IP 打 /account 的速度（Worker 的記憶體先擋一層） */
const EDGE_CAP: CapSpec = { rate: 2, burst: 60 };
/** 要算密碼雜湊的，每個 IP（Limiter 物件）：註冊一小時約 6 個、登入每 30 秒 1 次、重設每 5 分鐘 1 次、改密碼／救援碼每分鐘 1 次 */
const IP_CAPS: Record<string, CapSpec> = {
  reg: { rate: 1 / 600, burst: 5 },
  login: { rate: 1 / 30, burst: 20 },
  reset: { rate: 1 / 300, burst: 5 },
  pw: { rate: 1 / 60, burst: 10 },
};
/** 同一個帳號（帳號物件的記憶體）：帶憑證的請求、上傳存檔 */
const TOKEN_CAP: CapSpec = { rate: 1, burst: 60 };
const SAVE_CAP: CapSpec = { rate: 1 / 10, burst: 20 };

// ---------- 小工具 ----------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

export function randHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}
/** n 個字的亂數（多的丟掉重抽，不偏） */
export function randStr(n: number, abc: string): string {
  const lim = 256 - (256 % abc.length);
  let s = '';
  const b = new Uint8Array(Math.max(16, n * 2));
  while (s.length < n) {
    crypto.getRandomValues(b);
    for (const x of b) if (x < lim && s.length < n) s += abc[x % abc.length];
  }
  return s;
}
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 比對兩個字串（不管哪裡不一樣都比完） */
export function sameStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
/** 密碼雜湊：PBKDF2-SHA256 → 32 位元組（十六進位） */
export async function hashPw(pw: string, salt: string, iter = PBKDF2_ITER): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: iter }, key, 256);
  return hex(bits);
}

// ---------- 名稱、密碼 ----------

const NAME_RE = /^[a-z0-9_]+$/;
/** 不能註冊的名稱（小寫比）；另外這些開頭的也不行（RESERVED_PREFIX） */
export const RESERVED: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'root', 'system', 'sysop', 'support', 'help', 'helpdesk', 'staff', 'mod', 'moderator', 'owner', 'official',
  'server', 'api', 'www', 'mail', 'null', 'undefined', 'none', 'nobody', 'anonymous', 'guest', 'test', 'tester', 'me', 'self', 'you',
  'player', 'gm', 'dev', 'developer', 'security', 'account', 'accounts', 'login', 'logout', 'register', 'signup', 'racing', 'racer',
]);
export const RESERVED_PREFIX: readonly string[] = ['admin', 'official', 'support', 'staff', 'explosive'];

export type NameWhy = 'len' | 'chars' | 'reserved';
/** 名稱哪裡不對（null = 可以用）；先去掉前後空白、轉小寫 */
export function nameWhy(x: unknown): NameWhy | null {
  if (typeof x !== 'string') return 'chars';
  const s = x.trim().toLowerCase();
  if (s.length < NAME_MIN || s.length > NAME_MAX) return 'len';
  if (!NAME_RE.test(s)) return 'chars';
  if (RESERVED.has(s) || RESERVED_PREFIX.some((p) => s.startsWith(p))) return 'reserved';
  return null;
}
export function normName(x: unknown): string | null {
  return nameWhy(x) === null ? (x as string).trim().toLowerCase() : null;
}
export const acctObjName = (norm: string): string => `u:${norm}`;

/** 太常見的密碼（小寫比） */
export const COMMON_PW: ReadonlySet<string> = new Set([
  '12345678', '123456789', '1234567890', '0123456789', '87654321', '11111111', '00000000', '88888888', '66666666', '12341234', '11223344',
  'password', 'password1', 'passw0rd', 'qwertyui', 'qwertyuiop', 'qwerty123', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx',
  'abcd1234', 'abc12345', 'aaaaaaaa', 'iloveyou', 'letmein1', 'welcome1', 'sunshine', 'princess', 'racing12', 'racing123', 'explosive',
  'explosive1', 'gokart123', 'mariokart',
]);
export type PwWhy = 'len' | 'ctrl' | 'same' | 'weak';
/** 密碼哪裡不對（null = 可以用）：長度用字數算（中文、emoji 一個算一個） */
export function pwWhy(pw: unknown, name?: string | null): PwWhy | null {
  if (typeof pw !== 'string') return 'len';
  const n = [...pw].length;
  if (n < PW_MIN || n > PW_MAX) return 'len';
  if (/[\u0000-\u001f\u007f]/.test(pw)) return 'ctrl';
  const low = pw.toLowerCase();
  if (name && low === name.toLowerCase()) return 'same';
  if (COMMON_PW.has(low) || /^(.)\1+$/u.test(pw)) return 'weak';
  return null;
}

// ---------- 救援碼、登入憑證 ----------

export const makeRc = (): string => randStr(RC_LEN, RC_ABC);
export const fmtRc = (rc: string): string => (rc.match(/.{1,5}/g) ?? []).join('-');
/** 使用者打的救援碼 → 標準的 20 個字（空白、連字號、小寫都行）；不像 = null */
export function cleanRc(x: unknown): string | null {
  if (typeof x !== 'string' || x.length > 64) return null;
  const s = x.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== RC_LEN) return null;
  for (const ch of s) if (!RC_ABC.includes(ch)) return null;
  return s;
}
const rcHash = (rc: string, salt: string): Promise<string> => sha256Hex(`er-rc:${salt}:${rc}`);

const TOKEN_RE = /^([0-9a-f]{64})\.([0-9a-z]{10})\.([0-9A-Za-z]{32})$/;
export interface TokenParts {
  id: string;
  tid: string;
  sec: string;
}
export function parseToken(x: unknown): TokenParts | null {
  if (typeof x !== 'string' || x.length > 120) return null;
  const m = TOKEN_RE.exec(x);
  return m ? { id: m[1], tid: m[2], sec: m[3] } : null;
}
const tokenHash = (sec: string): Promise<string> => sha256Hex(`er-tok:${sec}`);

// ---------- 雲端存檔 ----------

export type Slot = 'dev' | 'prod';
/** 槽位照 Origin：本機開發 = dev（測試不會蓋到正式的進度） */
export const slotFor = (origin: string): Slot => (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin) ? 'dev' : 'prod');

/** 鍵排序過的 JSON（同樣的內容 = 同樣的字串；網頁 src/net/account.ts 有一份一樣的） */
export function canonJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map(canonJson).join(',')}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonJson(o[k])}`)
    .join(',')}}`;
}
export const saveHash = (data: unknown): Promise<string> => sha256Hex(canonJson(data));

/** 存檔摘要（衝突時兩邊比給玩家看） */
export interface SaveSum {
  cash: number;
  races: number;
  wins: number;
  karts: number;
}
export function saveSum(d: unknown): SaveSum {
  const o = isObj(d) ? d : {};
  const karts = isObj(o.karts) ? Object.values(o.karts).filter((x) => x === true).length : 0;
  return { cash: num(o.cash), races: num(o.races), wins: num(o.wins), karts };
}

const MONEY_MAX = 10_000_000;
const okNum = (x: unknown, max: number, int = false): boolean => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max && (!int || Number.isInteger(x));
const okMap = (x: unknown, keys: number, ok: (v: unknown) => boolean): boolean =>
  isObj(x) && Object.keys(x).length <= keys && Object.entries(x).every(([k, v]) => k.length <= 40 && ok(v));
const okStr = (x: unknown): boolean => typeof x === 'string' && x.length <= 64;
const depth = (x: unknown, d = 0): number => (x && typeof x === 'object' ? Math.max(d + 1, ...Object.values(x).map((v) => depth(v, d + 1))) : d);

/**
 * 存檔（src/game/save.ts Profile）看起來對不對：不對 = 哪一個欄位，對 = null。
 * 只有 cash 一定要有（舊存檔可能缺別的欄位，載入時補預設）；認得的欄位照型別、範圍檢查，不認得的放過（以後加欄位不用改伺服器）
 */
export function profileOdd(d: unknown): string | null {
  if (!isObj(d)) return 'data';
  if (Object.keys(d).length > 64 || depth(d) > 5) return 'data';
  if (!okNum(d.cash, MONEY_MAX)) return 'cash';
  for (const k of ['races', 'wins'] as const) if (d[k] !== undefined && !okNum(d[k], MONEY_MAX, true)) return k;
  if (d.bestLap !== undefined && !okNum(d.bestLap, 1e7)) return 'bestLap';
  for (const k of ['owned', 'karts'] as const) if (d[k] !== undefined && !okMap(d[k], 64, (v) => typeof v === 'boolean')) return k;
  for (const k of ['lvl', 'car', 'livery'] as const) if (d[k] !== undefined && !okMap(d[k], 64, (v) => okNum(v, 100))) return k;
  if (d.bestLaps !== undefined && !okMap(d.bestLaps, 256, (v) => okNum(v, 1e7))) return 'bestLaps';
  for (const k of ['primary', 'secondary', 'kart', 'track', 'difficulty'] as const) if (d[k] !== undefined && !okStr(d[k])) return k;
  if (d.weaponsV2 !== undefined && typeof d.weaponsV2 !== 'boolean') return 'weaponsV2';
  return null;
}

// ---------- 帳號的資料 ----------

interface TokenRec {
  h: string;
  at: number;
  used: number;
}
interface SlotMeta {
  v: number;
  at: number;
  h: string;
  n: number;
  sum: SaveSum;
}
interface AccountRec {
  v: 1;
  name: string;
  /** 密碼雜湊、鹽、次數 */
  ph: string;
  ps: string;
  pi: number;
  /** 救援碼雜湊、鹽、產生的時間 */
  rh: string;
  rs: string;
  rat: number;
  made: number;
  seen: number;
  fails: number;
  lockUntil: number;
  rcFails: number;
  rcLockUntil: number;
  tok: Record<string, TokenRec>;
  sm: Partial<Record<Slot, SlotMeta>>;
}
const REC_KEY = 'acct';
const slotKey = (s: Slot): string => `s:${s}`;

function asRec(x: unknown): AccountRec | null {
  if (!isObj(x) || x.v !== 1) return null;
  for (const k of ['name', 'ph', 'ps', 'rh', 'rs']) if (typeof x[k] !== 'string') return null;
  const tok: Record<string, TokenRec> = {};
  if (isObj(x.tok)) for (const [k, t] of Object.entries(x.tok)) if (/^[0-9a-z]{10}$/.test(k) && isObj(t) && typeof t.h === 'string') tok[k] = { h: t.h, at: num(t.at), used: num(t.used) };
  const sm: Partial<Record<Slot, SlotMeta>> = {};
  if (isObj(x.sm))
    for (const s of ['dev', 'prod'] as const) {
      const m = x.sm[s];
      if (!isObj(m) || typeof m.h !== 'string' || num(m.v) < 1) continue;
      const u = isObj(m.sum) ? m.sum : {};
      sm[s] = { v: num(m.v), at: num(m.at), h: m.h, n: num(m.n), sum: { cash: num(u.cash), races: num(u.races), wins: num(u.wins), karts: num(u.karts) } };
    }
  return {
    v: 1,
    name: x.name as string,
    ph: x.ph as string,
    ps: x.ps as string,
    pi: num(x.pi) || PBKDF2_ITER,
    rh: x.rh as string,
    rs: x.rs as string,
    rat: num(x.rat),
    made: num(x.made),
    seen: num(x.seen),
    fails: num(x.fails),
    lockUntil: num(x.lockUntil),
    rcFails: num(x.rcFails),
    rcLockUntil: num(x.rcLockUntil),
    tok,
    sm,
  };
}

/** 過期的憑證拿掉、太多的話留最近用的 TOKENS_MAX 個（keep = 剛發的那一個一定留） */
function pruneTokens(tok: Record<string, TokenRec>, now: number, keep?: string): Record<string, TokenRec> {
  const live = Object.entries(tok).filter(([k, t]) => k === keep || now - t.used < TOKEN_TTL_MS);
  live.sort((a, b) => (a[0] === keep ? -1 : b[0] === keep ? 1 : b[1].used - a[1].used));
  return Object.fromEntries(live.slice(0, TOKENS_MAX));
}
function failOnce(fails: number, now: number): { fails: number; lockUntil: number } {
  const n = fails + 1;
  return n >= LOCK_FAILS ? { fails: 0, lockUntil: now + LOCK_MS } : { fails: n, lockUntil: 0 };
}

// ---------- 限速 ----------

/** token bucket：每秒補 rate 個、最多 burst 個 */
class Bucket {
  private tokens: number;
  constructor(
    private spec: CapSpec,
    private at: number,
  ) {
    this.tokens = spec.burst;
  }
  private refill(now: number): void {
    if (now > this.at) {
      this.tokens = Math.min(this.spec.burst, this.tokens + ((now - this.at) / 1000) * this.spec.rate);
      this.at = now;
    }
  }
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.spec.burst;
  }
}
/** 很多個 key 的 bucket（記憶體；最多 4096 個，補滿的先丟） */
class RateMap {
  private m = new Map<string, Bucket>();
  constructor(private spec: CapSpec) {}
  allow(key: string, now: number): boolean {
    if (!key) return true;
    let b = this.m.get(key);
    if (!b) {
      if (this.m.size >= 256) for (const [k, x] of this.m) if (x.full(now)) this.m.delete(k);
      if (this.m.size >= 4096) for (const k of [...this.m.keys()].slice(0, this.m.size - 4095)) this.m.delete(k);
      this.m.set(key, (b = new Bucket(this.spec, now)));
    }
    return b.take(now);
  }
}

/** 限速用的 IP：IPv4 整個、IPv6 取 /64；本機（127.x、::1）、看不懂 = 空字串 = 不限 */
export function ipKey(ip: string | null | undefined): string {
  const s = (ip ?? '').trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1].startsWith('127.') ? '' : v4[1];
  if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return '';
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8 || groups.some((g) => !g || g.length > 4)) return '';
  if (groups.every((g, i) => (i < 7 ? /^0+$/.test(g) : g === '1' || g === '0001'))) return ''; // ::1
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':');
}
export const DEFAULT_SALT = 'explosive-racing-acct';
/** IP → 加鹽 SHA-256（前 16 個十六進位；不存 IP 原文）；空的 = 空字串 */
export async function hashKey(key: string, salt: string): Promise<string> {
  return key ? (await sha256Hex(`${salt}|ip|${key}`)).slice(0, 16) : '';
}

/** 每個 IP 的限速（一個全域物件 idFromName('ip')，記憶體裡；物件重開就歸零） */
export class Limiter extends DurableObject {
  private maps = new Map<string, RateMap>();
  /** kind = reg／login／reset／pw；ik = IP 的雜湊 */
  async gate(kind: string, ik: string): Promise<boolean> {
    const spec = IP_CAPS[kind];
    if (!spec) return false;
    let m = this.maps.get(kind);
    if (!m) this.maps.set(kind, (m = new RateMap(spec)));
    return m.allow(ik, Date.now());
  }
}

// ---------- 帳號物件 ----------

interface ApiCtx {
  now: number;
  slot: Slot;
}
interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}
const R = (status: number, body: Record<string, unknown>): ApiResult => ({ status, body });
const AUTH = (): ApiResult => R(403, { err: 'auth' });
/** 沒有這個帳號時也算一次雜湊用的鹽（花的時間一樣，看不出帳號存不存在） */
const DUMMY_SALT = '00112233445566778899aabbccddeeff';

export class Account extends DurableObject {
  private chain: Promise<unknown> = Promise.resolve();
  private tokLim: Bucket | null = null;
  private saveLim: Bucket | null = null;

  /** 同一個帳號的請求一次一個（算雜湊時別的請求不會插進來改同一份資料；前一個出錯照樣接著做） */
  private run<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f, f);
    this.chain = p.catch(() => {});
    return p;
  }

  /** RPC：回 JSON 字串（unknown 不能直接傳） */
  async api(b: Record<string, unknown>, cx: ApiCtx): Promise<{ status: number; json: string }> {
    return this.run(async () => {
      const r = await this.handle(b, cx);
      return { status: r.status, json: JSON.stringify(r.body) };
    });
  }

  private get st(): DurableObjectStorage {
    return this.ctx.storage;
  }
  private async rec(): Promise<AccountRec | null> {
    return asRec(await this.st.get(REC_KEY));
  }

  private async newToken(rec: AccountRec, now: number): Promise<string> {
    const tid = randStr(10, B36);
    const sec = randStr(32, B62);
    rec.tok[tid] = { h: await tokenHash(sec), at: now, used: now };
    rec.tok = pruneTokens(rec.tok, now, tid);
    return `${this.ctx.id.toString()}.${tid}.${sec}`;
  }

  private handle(b: Record<string, unknown>, cx: ApiCtx): Promise<ApiResult> {
    const op = typeof b.op === 'string' ? b.op : '';
    if (op === 'reg') return this.register(b, cx.now);
    if (op === 'login') return this.login(b, cx.now);
    if (op === 'reset') return this.reset(b, cx.now);
    return this.withToken(op, b, cx);
  }

  private async register(b: Record<string, unknown>, now: number): Promise<ApiResult> {
    const name = normName(b.name);
    if (!name) return R(400, { err: 'name', why: nameWhy(b.name) });
    const why = pwWhy(b.pw, name);
    if (why) return R(400, { err: 'weakpw', why });
    if ((await this.st.get(REC_KEY)) !== undefined) return R(409, { err: 'taken' });
    const ps = randHex(SALT_BYTES);
    const rs = randHex(SALT_BYTES);
    const rc = makeRc();
    const rec: AccountRec = {
      v: 1,
      name,
      ph: await hashPw(b.pw as string, ps),
      ps,
      pi: PBKDF2_ITER,
      rh: await rcHash(rc, rs),
      rs,
      rat: now,
      made: now,
      seen: now,
      fails: 0,
      lockUntil: 0,
      rcFails: 0,
      rcLockUntil: 0,
      tok: {},
      sm: {},
    };
    const tok = await this.newToken(rec, now);
    await this.st.put(REC_KEY, rec);
    return R(200, { tok, rc: fmtRc(rc), name });
  }

  /** 密碼對不對：鎖著 = locked（不算雜湊）；對 = ok（次數歸零、舊的次數順便換新）；錯 = bad（+1，到 LOCK_FAILS 就鎖）。rec 會被改，呼叫的人要寫回去 */
  private async checkPw(rec: AccountRec, pw: unknown, now: number): Promise<'ok' | 'bad' | 'locked'> {
    if (now < rec.lockUntil) return 'locked';
    if (typeof pw !== 'string' || pw.length > 256) {
      Object.assign(rec, failOnce(rec.fails, now));
      return 'bad';
    }
    if (!sameStr(await hashPw(pw, rec.ps, rec.pi), rec.ph)) {
      Object.assign(rec, failOnce(rec.fails, now));
      return 'bad';
    }
    rec.fails = 0;
    rec.lockUntil = 0;
    if (rec.pi !== PBKDF2_ITER) {
      rec.ps = randHex(SALT_BYTES);
      rec.ph = await hashPw(pw, rec.ps);
      rec.pi = PBKDF2_ITER;
    }
    return 'ok';
  }
  private locked(until: number, now: number): ApiResult {
    return R(423, { err: 'locked', ms: Math.max(0, until - now) });
  }

  private async login(b: Record<string, unknown>, now: number): Promise<ApiResult> {
    const rec = await this.rec();
    if (!rec || rec.name !== normName(b.name)) {
      await hashPw(typeof b.pw === 'string' ? b.pw.slice(0, 256) : '', DUMMY_SALT);
      return AUTH();
    }
    const r = await this.checkPw(rec, b.pw, now);
    if (r === 'locked') return this.locked(rec.lockUntil, now);
    if (r === 'bad') {
      await this.st.put(REC_KEY, rec);
      return now < rec.lockUntil ? this.locked(rec.lockUntil, now) : AUTH();
    }
    rec.seen = now;
    const tok = await this.newToken(rec, now);
    await this.st.put(REC_KEY, rec);
    return R(200, { tok, name: rec.name });
  }

  private async reset(b: Record<string, unknown>, now: number): Promise<ApiResult> {
    const rec = await this.rec();
    if (!rec || rec.name !== normName(b.name)) return AUTH();
    if (now < rec.rcLockUntil) return this.locked(rec.rcLockUntil, now);
    const rc = cleanRc(b.rc);
    if (!rc || !sameStr(await rcHash(rc, rec.rs), rec.rh)) {
      const f = failOnce(rec.rcFails, now);
      rec.rcFails = f.fails;
      rec.rcLockUntil = f.lockUntil;
      await this.st.put(REC_KEY, rec);
      return now < rec.rcLockUntil ? this.locked(rec.rcLockUntil, now) : AUTH();
    }
    // 救援碼對了才看新密碼（新密碼不行 = 救援碼還能再用）
    const why = pwWhy(b.pw, rec.name);
    if (why) return R(400, { err: 'weakpw', why });
    rec.ps = randHex(SALT_BYTES);
    rec.ph = await hashPw(b.pw as string, rec.ps);
    rec.pi = PBKDF2_ITER;
    const nrc = makeRc();
    rec.rs = randHex(SALT_BYTES);
    rec.rh = await rcHash(nrc, rec.rs);
    rec.rat = now;
    rec.rcFails = 0;
    rec.rcLockUntil = 0;
    rec.fails = 0;
    rec.lockUntil = 0;
    rec.tok = {}; // 所有裝置登出（可能是被別人改了密碼）
    rec.seen = now;
    const tok = await this.newToken(rec, now);
    await this.st.put(REC_KEY, rec);
    return R(200, { tok, rc: fmtRc(nrc), name: rec.name });
  }

  /** 憑證對不對（憑證裡的物件 id 要是自己）：對 = 帳號＋憑證編號（超過一小時沒記 = 更新最後使用時間，dirty） */
  private async auth(raw: unknown, now: number): Promise<{ rec: AccountRec; tid: string; dirty: boolean } | null> {
    const t = parseToken(raw);
    if (!t || t.id !== this.ctx.id.toString()) return null;
    const rec = await this.rec();
    const tr = rec?.tok[t.tid];
    if (!rec || !tr || now - tr.used >= TOKEN_TTL_MS) return null;
    if (!sameStr(await tokenHash(t.sec), tr.h)) return null;
    let dirty = false;
    if (now - tr.used >= TOKEN_TOUCH_MS) {
      tr.used = now;
      rec.seen = Math.max(rec.seen, now);
      dirty = true;
    }
    return { rec, tid: t.tid, dirty };
  }

  private async withToken(op: string, b: Record<string, unknown>, cx: ApiCtx): Promise<ApiResult> {
    const now = cx.now;
    const a = await this.auth(b.tok, now);
    if (!a) return AUTH();
    const { rec, tid } = a;
    let dirty = a.dirty;
    const done = async (r: ApiResult): Promise<ApiResult> => {
      if (dirty) await this.st.put(REC_KEY, rec);
      return r;
    };
    this.tokLim ??= new Bucket(TOKEN_CAP, now);
    if (!this.tokLim.take(now)) return done(R(429, { err: 'slow' }));

    // 要再打一次密碼的：先看新密碼的規則（不用白算一次雜湊），再驗目前的密碼
    if (op === 'pw' || op === 'rc') {
      if (op === 'pw') {
        const why = pwWhy(b.pw, rec.name);
        if (why) return done(R(400, { err: 'weakpw', why }));
      }
      const r = await this.checkPw(rec, op === 'pw' ? b.old : b.pw, now);
      dirty = true;
      if (r !== 'ok') return done(r === 'locked' || now < rec.lockUntil ? this.locked(rec.lockUntil, now) : R(403, { err: 'badpw' }));
    }

    const slot = cx.slot;
    switch (op) {
      case 'me': {
        const m = rec.sm[slot];
        return done(R(200, { name: rec.name, made: rec.made, devices: Object.keys(rec.tok).length, save: m ? { v: m.v, at: m.at, h: m.h, sum: m.sum } : null }));
      }
      case 'load': {
        const m = rec.sm[slot];
        if (!m) return done(R(200, { v: 0, at: 0, data: null }));
        const raw = await this.st.get<string>(slotKey(slot));
        let data: unknown = null;
        try {
          data = typeof raw === 'string' ? JSON.parse(raw) : null;
        } catch {
          data = null;
        }
        return done(R(200, { v: m.v, at: m.at, h: m.h, data }));
      }
      case 'save':
        return this.save(rec, b, cx, dirty);
      case 'logout':
        delete rec.tok[tid];
        dirty = true;
        return done(R(200, { ok: true }));
      case 'logoutAll':
        rec.tok = {};
        dirty = true;
        return done(R(200, { ok: true }));
      case 'pw':
        // 改密碼：這台留著、其他裝置登出
        rec.ps = randHex(SALT_BYTES);
        rec.ph = await hashPw(b.pw as string, rec.ps);
        rec.pi = PBKDF2_ITER;
        rec.tok = { [tid]: rec.tok[tid] };
        return done(R(200, { ok: true }));
      case 'rc': {
        const rc = makeRc();
        rec.rs = randHex(SALT_BYTES);
        rec.rh = await rcHash(rc, rec.rs);
        rec.rat = now;
        rec.rcFails = 0;
        rec.rcLockUntil = 0;
        return done(R(200, { rc: fmtRc(rc) }));
      }
      default:
        return done(R(400, { err: 'op' }));
    }
  }

  private async save(rec: AccountRec, b: Record<string, unknown>, cx: ApiCtx, dirty: boolean): Promise<ApiResult> {
    const now = cx.now;
    const done = async (r: ApiResult): Promise<ApiResult> => {
      if (dirty) await this.st.put(REC_KEY, rec);
      return r;
    };
    this.saveLim ??= new Bucket(SAVE_CAP, now);
    if (!this.saveLim.take(now)) return done(R(429, { err: 'slow' }));
    if (!isObj(b.data)) return done(R(400, { err: 'save' }));
    const json = JSON.stringify(b.data);
    const n = utf8Len(json);
    if (n > SAVE_MAX) return done(R(413, { err: 'big' }));
    const odd = profileOdd(b.data);
    if (odd) return done(R(422, { err: 'odd', key: odd }));
    const h = await saveHash(b.data);
    const cur = rec.sm[cx.slot];
    const curV = cur?.v ?? 0;
    // 內容一樣：不用寫（版本照舊；就算 base 舊了也沒有東西會被蓋掉）
    if (cur && cur.h === h) return done(R(200, { v: curV, at: cur.at, same: true }));
    if (b.base !== curV) return done(R(409, { err: 'conflict', v: curV, at: cur?.at ?? 0, h: cur?.h ?? '', sum: cur?.sum ?? null }));
    rec.sm[cx.slot] = { v: curV + 1, at: now, h, n, sum: saveSum(b.data) };
    rec.seen = Math.max(rec.seen, now);
    await this.st.put({ [REC_KEY]: rec, [slotKey(cx.slot)]: json }); // 帳號和存檔一起寫（同一次 put）
    return R(200, { v: curV + 1, at: now });
  }
}

// ---------- POST /account ----------

/** 一邊讀一邊數，超過 max 就停（不整包讀進記憶體）；超過 = null */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

const edge = new RateMap(EDGE_CAP);
const PW_OPS: ReadonlySet<string> = new Set(['pw', 'rc']);

/** POST /account（origin = 呼叫的人已經確認在允許名單上的 Origin） */
export async function handleAccount(req: Request, env: AccountEnv, origin: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin, vary: 'Origin' };
  const reply = (status: number, body: string) => new Response(body, { status, headers });
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...headers, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
  if (req.method !== 'POST') return reply(405, '{"err":"method"}');
  if (Number(req.headers.get('content-length') ?? 0) > BODY_MAX) return reply(413, '{"err":"big"}');
  const ik = await hashKey(ipKey(req.headers.get('CF-Connecting-IP')), env.IP_SALT || DEFAULT_SALT);
  if (!edge.allow(ik, Date.now())) return reply(429, '{"err":"slow"}');
  const text = await readCapped(req, BODY_MAX);
  if (text === null) return reply(413, '{"err":"big"}');
  let b: unknown = null;
  try {
    b = text ? JSON.parse(text) : null;
  } catch {
    b = null;
  }
  if (!isObj(b)) return reply(400, '{"err":"bad"}');
  const op = typeof b.op === 'string' ? b.op : '';
  if (op !== 'save' && utf8Len(text) > SMALL_MAX) return reply(413, '{"err":"big"}');

  const ns = env.ACCOUNT as unknown as DurableObjectNamespace<Account>;
  /** 每個 IP 的次數（Limiter 叫不到 = 先不給做：寧可擋也不放洗密碼） */
  const gate = async (kind: string): Promise<boolean | null> => {
    if (!ik) return true;
    try {
      const lim = env.LIMITER as unknown as DurableObjectNamespace<Limiter>;
      return await lim.get(lim.idFromName('ip')).gate(kind, ik);
    } catch {
      return null;
    }
  };
  let id: DurableObjectId;
  if (op === 'reg' || op === 'login' || op === 'reset') {
    const name = normName(b.name);
    // 名稱不合法：註冊 = 說哪裡不對；登入、重設 = 跟「名稱或密碼不對」一樣
    if (!name) return op === 'reg' ? reply(400, JSON.stringify({ err: 'name', why: nameWhy(b.name) })) : reply(403, '{"err":"auth"}');
    const g = await gate(op);
    if (g === null) return reply(503, '{"err":"later"}');
    if (!g) return reply(429, '{"err":"slow"}');
    id = ns.idFromName(acctObjName(name));
  } else {
    const t = parseToken(b.tok);
    if (!t) return reply(403, '{"err":"auth"}');
    try {
      id = ns.idFromString(t.id);
    } catch {
      return reply(403, '{"err":"auth"}');
    }
    if (PW_OPS.has(op)) {
      const g = await gate('pw');
      if (g === null) return reply(503, '{"err":"later"}');
      if (!g) return reply(429, '{"err":"slow"}');
    }
  }
  try {
    const r = await ns.get(id).api(b, { now: Date.now(), slot: slotFor(origin) });
    return reply(r.status, r.json);
  } catch (e) {
    console.log(`account ${op} failed: ${String(e).slice(0, 120)}`);
    return reply(503, '{"err":"later"}');
  }
}
