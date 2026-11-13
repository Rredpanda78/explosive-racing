/**
 * 帳號＋雲端存檔的網頁這一邊（伺服器 server/src/account.ts；畫面 src/ui/accountPanel.ts）。不碰 DOM 畫面。
 *
 * 這台記的（ACCT_KEY）：登入憑證、名稱、上次跟雲端對齊時的版本 v 和存檔雜湊 h（h 空的 = 登入後還沒對齊過）。
 * 存檔本身就是遊戲的 SAVE_KEY（src/game/save.ts 的 Profile JSON），雲端存一份一樣的。
 *
 * 同步：
 * - 第一次登入（firstSync）：雲端沒有 → 上傳；一樣 → 記下版本；這台是全新的（沒比賽、沒錢）→ 直接用雲端的；
 *   雲端是全新的 → 用這台的蓋掉；都有進度又不一樣 → onConflict(這台, 雲端) 讓玩家選
 * - 每 5 秒在本機算一次存檔的雜湊（不連線），變了 4 秒後上傳（兩次上傳至少隔 15 秒）；分頁切到背景、關掉時馬上送（keepalive）
 * - 帶版本號上傳：雲端比這台上次拿到的新 = 衝突 → 問玩家
 * - 開始時、每 120 秒、分頁回到前景問一次雲端：雲端比較新、這台沒改過 → 寫進 localStorage、叫 onRemoteSave（遊戲重讀進度）；
 *   遊戲正在比賽（canApply() = false）就先等
 * - 連不上 = 退避重試（10 秒起，最多 2 分鐘）
 */
import { SERVER } from './room';

export const ACCT_KEY = 'explosive-racing-acct';
/** 遊戲的存檔（src/game/save.ts 的 KEY） */
export const SAVE_KEY = 'explosive-racing-save-v1';
/** 新帳號禮：註冊成功送的遊戲幣 */
export const SIGNUP_GIFT = 15000;
/** wss:// → https://、ws:// → http:// */
export const ACCOUNT_API = SERVER.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') + '/account';

const LOCAL_MS = 5_000;
const SAVE_DELAY_MS = 4_000;
const SAVE_GAP_MS = 15_000;
const PULL_MS = 120_000;
const BACKOFF_MAX_MS = 120_000;
/** 這台沒有存檔時的「雜湊」 */
const NONE = 'none';

export type AcctStatus = 'guest' | 'syncing' | 'synced' | 'offline' | 'conflict';
/** 存檔摘要（衝突時給玩家比）：at = 雲端存的時間（這台 = 0） */
export interface SaveSummary {
  cash: number;
  races: number;
  wins: number;
  karts: number;
  at: number;
}
export interface CloudSave {
  v: number;
  at: number;
  h: string;
  sum: SaveSummary;
}
export interface AccountInfo {
  name: string;
  made: number;
  devices: number;
  save: CloudSave | null;
}
export interface AcctErr {
  ok: false;
  /** 伺服器的 err（auth、taken、name、weakpw、badpw、locked、slow…）或網頁自己的 net、store */
  err: string;
  why?: string;
  ms?: number;
  key?: string;
}
export type Res<T = object> = ({ ok: true } & T) | AcctErr;
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface AccountClientOpts {
  api?: string;
  fetch?: typeof fetch;
  storage?: KV | null;
}

interface Local {
  tok: string;
  name: string;
  v: number;
  h: string;
}
interface Reply {
  status: number;
  data: Record<string, unknown>;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** 鍵排序過的 JSON（跟伺服器 canonJson 一樣：同樣的內容 = 同樣的雜湊） */
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
async function hashOf(data: unknown): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonJson(data)));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}
/** 存檔 → 摘要（金錢、比賽、冠軍、擁有幾台車） */
export function summarize(d: unknown, at = 0): SaveSummary {
  const o = isObj(d) ? d : {};
  const karts = isObj(o.karts) ? Object.values(o.karts).filter((x) => x === true).length : 0;
  return { cash: num(o.cash), races: num(o.races), wins: num(o.wins), karts, at };
}
const sumIn = (x: unknown, at: number): SaveSummary => {
  const o = isObj(x) ? x : {};
  return { cash: num(o.cash), races: num(o.races), wins: num(o.wins), karts: num(o.karts), at };
};
/** 全新的進度（沒比過賽、沒有錢）：第一次登入不用問 */
const isFresh = (s: SaveSummary): boolean => s.races === 0 && s.cash === 0;
const cloudIn = (x: unknown): CloudSave | null =>
  isObj(x) && num(x.v) >= 1 ? { v: num(x.v), at: num(x.at), h: typeof x.h === 'string' ? x.h : '', sum: sumIn(x.sum, num(x.at)) } : null;
const errOf = (r: Reply | null): string =>
  !r ? 'net' : typeof r.data.err === 'string' ? r.data.err : r.status === 404 ? 'gone' : r.status >= 500 ? 'later' : 'net';
const fail = (r: Reply | null): AcctErr => ({
  ok: false,
  err: errOf(r),
  ...(typeof r?.data.why === 'string' ? { why: r.data.why } : {}),
  ...(typeof r?.data.ms === 'number' ? { ms: r.data.ms } : {}),
  ...(typeof r?.data.key === 'string' ? { key: r.data.key } : {}),
});

function defaultStore(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 有些瀏覽器的私密模式碰 localStorage 會丟錯
  }
}

export class AccountClient {
  status: AcctStatus;
  /** 最後一次出錯的原因（offline、guest 的時候看；空的 = 沒有） */
  lastErr = '';
  /** 最後一次 me 拿到的帳號資訊 */
  info: AccountInfo | null = null;
  onStatus: ((s: AcctStatus) => void) | null = null;
  /** 兩邊都有進度又不一樣：讓玩家選（UI：openConflictDialog）；沒設 = 停在 conflict 等 */
  onConflict: ((local: SaveSummary, cloud: SaveSummary) => Promise<'local' | 'cloud'>) | null = null;
  /** 雲端的存檔寫進 localStorage 了：遊戲重讀進度（profileJson = 寫進去的字串） */
  onRemoteSave: ((profileJson: string) => void) | null = null;
  /** 註冊成功（送新帳號禮用；在第一次同步之前呼叫） */
  onRegistered: (() => void) | null = null;
  /** 憑證失效（過期、別台按了登出所有裝置、重設密碼）：這台已經登出 */
  onLoggedOut: (() => void) | null = null;
  /** 現在可以換掉這台的進度／跳出選擇視窗嗎（比賽中、線上房間裡 = false，先等） */
  canApply: () => boolean = () => true;
  /** 先不要同步（畫面正在顯示救援碼）；放開後叫 syncNow() */
  hold = false;

  private api: string;
  private fetchFn: typeof fetch;
  private store: KV | null;
  private local: Local | null;
  private listeners = new Set<(s: AcctStatus) => void>();
  private busy = false;
  private asking = false;
  private pending: { cloudV: number; local: SaveSummary; cloud: SaveSummary } | null = null;
  /** 雲端比較新、這台沒改過，但現在不能換（canApply false）：等 */
  private remoteWaiting = false;
  private dirtySince = 0;
  private lastChange = 0;
  private lastH = '';
  private lastUpload = 0;
  private lastPull = 0;
  private fails = 0;
  private nextTry = 0;
  /** 伺服器不收的內容（太大、數字不對）的雜湊：內容變了才再試 */
  private badH = '';
  /** 上次算過的存檔字串 → 雜湊（字串沒變就不重算） */
  private memo: { raw: string; h: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private unhook: (() => void) | null = null;

  constructor(o: AccountClientOpts = {}) {
    this.api = o.api ?? ACCOUNT_API;
    this.fetchFn = o.fetch ?? ((i, init) => fetch(i, init));
    this.store = o.storage === undefined ? defaultStore() : o.storage;
    this.local = this.readAcct();
    this.status = this.local ? 'syncing' : 'guest';
  }

  get loggedIn(): boolean {
    return !!this.local;
  }
  get name(): string {
    return this.local?.name ?? '';
  }

  /** 狀態變了就叫 fn（面板用；onStatus 留給遊戲）；回傳取消 */
  watch(fn: (s: AcctStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: AcctStatus, err = ''): void {
    if (s === this.status && err === this.lastErr) return;
    this.status = s;
    this.lastErr = err;
    this.onStatus?.(s);
    for (const f of this.listeners) f(s);
  }

  // ---------- 這台記的 ----------

  private readAcct(): Local | null {
    try {
      const o = JSON.parse(this.store?.getItem(ACCT_KEY) ?? 'null') as unknown;
      if (!isObj(o) || typeof o.tok !== 'string' || typeof o.name !== 'string' || o.tok.length > 120) return null;
      return { tok: o.tok, name: o.name.slice(0, 20), v: num(o.v), h: typeof o.h === 'string' ? o.h : '' };
    } catch {
      return null;
    }
  }
  private remember(l: Local | null): void {
    this.local = l;
    try {
      if (l) this.store?.setItem(ACCT_KEY, JSON.stringify(l));
      else this.store?.removeItem(ACCT_KEY);
    } catch {
      /* 存不進去：這一頁照樣用記憶體裡的 */
    }
  }
  private readSave(): { raw: string | null; data: Record<string, unknown> | null } {
    let raw: string | null = null;
    try {
      raw = this.store?.getItem(SAVE_KEY) ?? null;
    } catch {
      raw = null;
    }
    if (raw === null) return { raw, data: null };
    try {
      const d = JSON.parse(raw) as unknown;
      return { raw, data: isObj(d) ? d : null };
    } catch {
      return { raw, data: null };
    }
  }
  /** 這台的存檔＋雜湊（沒有 = NONE） */
  private async mine(): Promise<{ data: Record<string, unknown> | null; h: string }> {
    const { raw, data } = this.readSave();
    if (!data || raw === null) return { data: null, h: NONE };
    if (this.memo?.raw === raw) return { data, h: this.memo.h };
    const h = await hashOf(data);
    this.memo = { raw, h };
    return { data, h };
  }
  /** 同一個瀏覽器的另一個分頁可能已經上傳過、登出了、換了帳號：先讀一次這台記的。回傳還有沒有登入 */
  private reloadLocal(): boolean {
    const s = this.readAcct();
    if (!s) {
      if (this.local) this.clear('');
      return false;
    }
    const l = this.local;
    if (!l || s.tok !== l.tok) {
      this.local = s;
      this.info = null;
      this.pending = null;
      this.remoteWaiting = false;
      this.badH = '';
    } else if (s.v !== l.v || s.h !== l.h) this.local = s;
    return true;
  }
  private clear(err: string): void {
    this.remember(null);
    this.info = null;
    this.pending = null;
    this.remoteWaiting = false;
    this.badH = '';
    this.dirtySince = 0;
    this.fails = 0;
    this.nextTry = 0;
    this.setStatus('guest', err);
  }

  // ---------- 連線 ----------

  /** POST /account（text/plain：簡單請求，不用 CORS 預檢）；連不上 = null */
  private async post(body: Record<string, unknown>, keepalive = false): Promise<Reply | null> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl?.abort(), 12_000);
    try {
      const text = JSON.stringify(body);
      const r = await this.fetchFn(this.api, { method: 'POST', body: text, cache: 'no-store', keepalive: keepalive && text.length < 60_000, signal: ctl?.signal });
      const data = (await r.json().catch(() => ({}))) as unknown;
      return { status: r.status, data: isObj(data) ? data : {} };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  /** 帶登入憑證的；憑證失效 = 這台登出 */
  private async authed(body: Record<string, unknown>, keepalive = false): Promise<Reply | null> {
    const l = this.local;
    if (!l) return { status: 403, data: { err: 'auth' } };
    const r = await this.post({ ...body, tok: l.tok }, keepalive);
    if (r?.status === 403 && r.data.err === 'auth' && this.local?.tok === l.tok) {
      this.clear('auth');
      this.onLoggedOut?.();
    }
    return r;
  }
  private failNet(r: Reply | null): void {
    this.fails++;
    this.nextTry = Date.now() + Math.min(BACKOFF_MAX_MS, LOCAL_MS * 2 ** Math.min(this.fails, 5));
    if (this.local) this.setStatus('offline', errOf(r));
  }

  // ---------- 帳號的操作 ----------

  /** 登入成功（註冊、登入、重設）：記下來，開始第一次同步（hold 的話等放開） */
  private signedIn(r: Reply, fallback: string): void {
    this.remember({ tok: r.data.tok as string, name: typeof r.data.name === 'string' ? r.data.name : fallback.trim().toLowerCase(), v: 0, h: '' });
    this.info = null;
    this.pending = null;
    this.remoteWaiting = false;
    this.badH = '';
    this.fails = 0;
    this.nextTry = 0;
    this.setStatus('syncing');
    if (!this.hold) void this.syncNow();
  }

  /** 註冊：rc = 救援碼（只給這一次；畫面顯示時先設 hold = true） */
  async register(name: string, pw: string): Promise<Res<{ rc: string }>> {
    const r = await this.post({ op: 'reg', name: name.trim(), pw });
    if (r?.status !== 200 || typeof r.data.tok !== 'string') return fail(r);
    // 新帳號禮：先加進這台的進度，接下來第一次同步就會帶上雲端
    this.onRegistered?.();
    this.signedIn(r, name);
    return { ok: true, rc: String(r.data.rc ?? '') };
  }
  async login(name: string, pw: string): Promise<Res> {
    const r = await this.post({ op: 'login', name: name.trim(), pw });
    if (r?.status !== 200 || typeof r.data.tok !== 'string') return fail(r);
    this.signedIn(r, name);
    return { ok: true };
  }
  /** 用救援碼重設密碼：所有裝置登出、這台登入、rc = 新的救援碼 */
  async reset(name: string, rc: string, pw: string): Promise<Res<{ rc: string }>> {
    const r = await this.post({ op: 'reset', name: name.trim(), rc, pw });
    if (r?.status !== 200 || typeof r.data.tok !== 'string') return fail(r);
    this.signedIn(r, name);
    return { ok: true, rc: String(r.data.rc ?? '') };
  }
  /** 登出這台（伺服器連不上也照樣登出；這台的進度留著） */
  async logout(): Promise<Res> {
    if (this.local) await this.post({ op: 'logout', tok: this.local.tok });
    this.clear('');
    return { ok: true };
  }
  /** 登出所有裝置（包括這台）：伺服器要收到才算 */
  async logoutAll(): Promise<Res> {
    const r = await this.authed({ op: 'logoutAll' });
    if (r?.status === 200 || (r?.status === 403 && r.data.err === 'auth')) {
      if (this.local) this.clear('');
      return { ok: true };
    }
    return fail(r);
  }
  /** 改密碼（要目前的密碼）：其他裝置登出、這台留著 */
  async changePassword(old: string, pw: string): Promise<Res> {
    const r = await this.authed({ op: 'pw', old, pw });
    return r?.status === 200 ? { ok: true } : fail(r);
  }
  /** 重新產生救援碼（要密碼；舊的作廢） */
  async newRecoveryCode(pw: string): Promise<Res<{ rc: string }>> {
    const r = await this.authed({ op: 'rc', pw });
    return r?.status === 200 && typeof r.data.rc === 'string' ? { ok: true, rc: r.data.rc } : fail(r);
  }
  /** 帳號資訊（名稱、建立時間、雲端存檔、幾台裝置登入著） */
  async me(): Promise<Res<AccountInfo>> {
    const r = await this.authed({ op: 'me' });
    if (r?.status !== 200) return fail(r);
    const info: AccountInfo = { name: String(r.data.name ?? this.name), made: num(r.data.made), devices: num(r.data.devices), save: cloudIn(r.data.save) };
    this.info = info;
    return { ok: true, ...info };
  }

  // ---------- 同步 ----------

  /** 開始自動同步（遊戲啟動後叫一次）：登入著 = 馬上問一次雲端 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), LOCAL_MS);
    if (typeof document !== 'undefined' && typeof addEventListener === 'function') {
      const vis = () => (document.hidden ? this.beacon() : void this.pull(true));
      const hide = () => this.beacon();
      document.addEventListener('visibilitychange', vis);
      addEventListener('pagehide', hide);
      this.unhook = () => {
        document.removeEventListener('visibilitychange', vis);
        removeEventListener('pagehide', hide);
      };
    }
    if (this.local) void this.syncNow();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.timer = this.soonTimer = null;
    this.unhook?.();
    this.unhook = null;
  }

  /** 一次只做一件同步的事 */
  private async locked(f: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await f();
    } catch {
      this.failNet(null);
    } finally {
      this.busy = false;
    }
  }
  private soon(ms: number): void {
    if (!this.timer) return;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.tick();
    }, ms + 50);
  }

  /** 每 5 秒：存檔變了沒（本機算），變了就延遲上傳；等著的雲端進度、每 120 秒問一次雲端 */
  async tick(): Promise<void> {
    if (!this.local || this.busy || this.hold || this.asking) return;
    if (!this.reloadLocal()) return;
    if (this.pending) return this.locked(() => this.askConflict());
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = Date.now();
    if (now < this.nextTry) return;
    await this.locked(async () => {
      const l = this.local!;
      if (!l.h) return this.firstSync();
      const m = await this.mine();
      if (m.h === l.h || m.h === this.badH) {
        if (m.h === l.h) this.dirtySince = 0;
        if ((this.remoteWaiting && this.canApply()) || now - this.lastPull >= PULL_MS) return this.pullNow();
        if (m.h === l.h && this.status === 'syncing' && !this.remoteWaiting) this.setStatus('synced');
        return;
      }
      if (!this.dirtySince) this.dirtySince = now;
      if (m.h !== this.lastH) {
        this.lastH = m.h;
        this.lastChange = now;
      }
      this.setStatus('syncing');
      const settled = now - this.lastChange >= SAVE_DELAY_MS || now - this.dirtySince >= SAVE_GAP_MS;
      const wait = Math.max(settled ? 0 : this.lastChange + SAVE_DELAY_MS - now, this.lastUpload + SAVE_GAP_MS - now);
      if (wait <= 0) return this.upload(m.data, m.h, l.v);
      this.soon(wait);
    });
  }

  /** 馬上同步（面板的「立即同步」、剛登入）：改過就上傳，沒改過就問雲端 */
  async syncNow(): Promise<void> {
    if (!this.local || this.hold || this.asking) return;
    if (!this.reloadLocal()) return;
    this.nextTry = 0;
    await this.locked(async () => {
      if (this.pending) return this.askConflict();
      const l = this.local!;
      if (!l.h) return this.firstSync();
      const m = await this.mine();
      if (m.h !== l.h && m.h !== this.badH) return this.upload(m.data, m.h, l.v);
      return this.pullNow();
    });
  }

  /** 問雲端（force = 不管上次問的時間；分頁回到前景） */
  async pull(force = false): Promise<void> {
    if (!this.local || this.busy || this.hold || this.asking) return;
    if (!force && Date.now() - this.lastPull < PULL_MS) return;
    if (!this.reloadLocal()) return;
    await this.locked(async () => (this.pending ? this.askConflict() : !this.local!.h ? this.firstSync() : this.pullNow()));
  }

  /**
   * 分頁切到背景、關掉：存檔改過就馬上送（keepalive；同步地發出請求，不等雜湊 —— 頁面可能馬上就沒了）。
   * 字串跟上次對齊時一樣 = 沒改過
   */
  private beacon(): void {
    const l = this.local;
    if (!l || !l.h || this.busy || this.hold || this.pending) return;
    const { raw, data } = this.readSave();
    if (!data || raw === null || (this.memo?.raw === raw && (this.memo.h === l.h || this.memo.h === this.badH))) return;
    this.busy = true;
    this.lastUpload = Date.now();
    void (async () => {
      try {
        const r = await this.authed({ op: 'save', base: l.v, data }, true);
        await this.afterSave(r, l.tok, data, await hashOf(data));
      } catch {
        this.failNet(null);
      } finally {
        this.busy = false;
      }
    })();
  }

  private async fetchInfo(): Promise<AccountInfo | null> {
    const r = await this.me();
    if (!this.local) return null;
    if (!r.ok) {
      this.failNet(null);
      if (this.local) this.setStatus('offline', r.err);
      return null;
    }
    this.fails = 0;
    return this.info;
  }

  /** 登入後第一次對齊 */
  private async firstSync(): Promise<void> {
    const info = await this.fetchInfo();
    if (!info || !this.local) return;
    const cloud = info.save;
    const m = await this.mine();
    const l = this.local;
    if (!cloud) {
      if (m.data) return this.upload(m.data, m.h, 0);
      this.remember({ ...l, v: 0, h: m.h });
      return this.setStatus('synced');
    }
    if (cloud.h === m.h) {
      this.remember({ ...l, v: cloud.v, h: m.h });
      return this.setStatus('synced');
    }
    const ls = summarize(m.data);
    if (isFresh(ls)) {
      // 這台是全新的：直接用雲端的（不用問）
      this.remember({ ...l, v: 0, h: m.h });
      return this.newer();
    }
    if (isFresh(cloud.sum)) return this.upload(m.data, m.h, cloud.v); // 雲端是全新的：用這台的
    this.pending = { cloudV: cloud.v, local: ls, cloud: cloud.sum };
    this.setStatus('conflict');
    return this.askConflict();
  }

  /** 問雲端的版本 */
  private async pullNow(): Promise<void> {
    this.lastPull = Date.now();
    const info = await this.fetchInfo();
    if (!info || !this.local) return;
    const cloud = info.save;
    const m = await this.mine();
    const l = this.local;
    if (!cloud) {
      this.remoteWaiting = false;
      if (m.data) return this.upload(m.data, m.h, 0);
      this.remember({ ...l, v: 0, h: m.h });
      return this.setStatus('synced');
    }
    if (cloud.v <= l.v) {
      this.remoteWaiting = false;
      return this.setStatus(m.h === l.h ? 'synced' : m.h === this.badH ? this.status : 'syncing');
    }
    if (cloud.h === m.h) {
      this.remoteWaiting = false;
      this.remember({ ...l, v: cloud.v, h: m.h });
      return this.setStatus('synced');
    }
    if (m.h !== l.h) {
      // 兩邊都改過
      this.remoteWaiting = false;
      this.pending = { cloudV: cloud.v, local: summarize(m.data), cloud: cloud.sum };
      this.setStatus('conflict');
      return this.askConflict();
    }
    return this.newer();
  }

  /** 雲端比較新、這台沒改過：能換就換，不能（比賽中）就等 */
  private async newer(): Promise<void> {
    if (!this.canApply()) {
      this.remoteWaiting = true;
      return this.setStatus('syncing');
    }
    return this.applyCloud();
  }

  private async askConflict(): Promise<void> {
    const p = this.pending;
    if (!p || this.asking || this.hold || !this.onConflict || !this.canApply()) return;
    const tok = this.local?.tok;
    this.asking = true;
    let choice: 'local' | 'cloud';
    try {
      choice = await this.onConflict(p.local, p.cloud);
    } finally {
      this.asking = false;
    }
    if (!this.local || this.local.tok !== tok || this.pending !== p) return;
    this.pending = null;
    if (choice === 'cloud') return this.applyCloud();
    const m = await this.mine();
    return this.upload(m.data, m.h, p.cloudV); // 用這台的：蓋掉雲端
  }

  /** 雲端的存檔寫進這台、叫 onRemoteSave */
  private async applyCloud(): Promise<void> {
    const l = this.local;
    if (!l) return;
    this.setStatus('syncing');
    const r = await this.authed({ op: 'load' });
    if (!this.local || this.local.tok !== l.tok) return;
    if (r?.status !== 200) return this.failNet(r);
    this.remoteWaiting = false;
    const data = isObj(r.data.data) ? r.data.data : null;
    if (!data) {
      // 雲端其實是空的：照一般的規則上傳這台的
      this.remember({ ...this.local, v: 0, h: '' });
      return this.firstSync();
    }
    const json = JSON.stringify(data);
    try {
      if (!this.store) throw new Error('no storage');
      this.store.setItem(SAVE_KEY, json);
    } catch {
      return this.setStatus('offline', 'store');
    }
    const h = await hashOf(data);
    this.memo = { raw: json, h };
    this.dirtySince = 0;
    this.remember({ ...this.local, v: num(r.data.v), h });
    this.setStatus('synced');
    try {
      this.onRemoteSave?.(json);
    } catch {
      /* 遊戲那邊出錯不影響同步 */
    }
  }

  /** 上傳（base = 這台上次拿到的版本） */
  private async upload(data: Record<string, unknown> | null, h: string, base: number): Promise<void> {
    const l = this.local;
    if (!l) return;
    if (!data) {
      // 這台沒有存檔：沒東西可傳
      this.remember({ ...l, v: base, h });
      return this.setStatus('synced');
    }
    this.setStatus('syncing');
    this.lastUpload = Date.now();
    const r = await this.authed({ op: 'save', base, data });
    return this.afterSave(r, l.tok, data, h);
  }

  private async afterSave(r: Reply | null, tok: string, data: Record<string, unknown>, h: string): Promise<void> {
    if (!this.local || this.local.tok !== tok) return;
    if (r?.status === 200 && typeof r.data.v === 'number') {
      const at = num(r.data.at);
      this.fails = 0;
      this.nextTry = 0;
      this.dirtySince = 0;
      this.badH = '';
      this.remoteWaiting = false;
      this.remember({ ...this.local, v: r.data.v, h });
      if (this.info) this.info.save = { v: r.data.v, at, h, sum: summarize(data, at) };
      return this.setStatus('synced');
    }
    if (r?.status === 409 && r.data.err === 'conflict') {
      this.pending = { cloudV: num(r.data.v), local: summarize(data), cloud: sumIn(r.data.sum, num(r.data.at)) };
      this.setStatus('conflict');
      return this.askConflict();
    }
    if (r && (r.status === 400 || r.status === 413 || r.status === 422)) {
      this.badH = h; // 這一份伺服器不收：內容變了才再試
      return this.setStatus('offline', errOf(r));
    }
    if (r?.status === 403 && r.data.err === 'auth') return; // 已經登出了（authed）
    return this.failNet(r);
  }
}
