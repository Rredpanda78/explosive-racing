/**
 * Explosive Racing 線上房間伺服器（Cloudflare Worker + Durable Object）。
 * 一個房間代碼 = 一個 Room 物件，最多 8 人。伺服器負責：
 * 1. 房間的建立／加入（滿了、不存在、比賽中會回錯誤代碼）
 * 2. 座位：每個人有固定的玩家編號；斷線 25 秒內用同一個 cid 連回來就回到原本的座位（比賽中也可以）
 * 3. 房主：由伺服器記住，房主斷線或離開才換人（編號最小的人），回來的人不會搶回房主
 * 4. 轉發遊戲訊息（伺服器蓋上發送者編號，不能冒充別人）：
 *    JSON（事件、P2P 連線交握）與二進位（每秒 20 次的車輛狀態，第一個位元組是收件人遮罩）
 * 能直連（WebRTC）的玩家之間不經過伺服器，伺服器只是備援。遊戲本身的模擬在各玩家的瀏覽器裡跑。
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  /** 允許連線的網頁（逗號分隔） */
  ALLOWED_ORIGINS: string;
  /** 本機開發（wrangler dev --var DEV_ORIGINS:1）另外允許 localhost */
  DEV_ORIGINS?: string;
  /**
   * 直連的中轉（TURN，Cloudflare Realtime，跟羽球對決同一種做法）：直連連不上時改經 turn.cloudflare.com，
   * 入口在台北（晚上我們網域的入口會被繞到美國，TURN 不會）。用 npx wrangler secret put 設定；沒設 = 只用 STUN
   */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

// ---------------- TURN 帳密（GET /turn） ----------------
const TURN_TTL_S = 6 * 3600;
const TURN_REFRESH_S = 3600;
interface IceServer { urls: string[]; username?: string; credential?: string }
let turnCache: { at: number; servers: IceServer[] } | null = null;

/** Cloudflare 回的 iceServers → 乾淨的陣列（瀏覽器擋 53 埠，拿掉） */
function cleanIce(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    const o = s as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(o?.urls) ? o.urls : [o?.urls]).filter((u): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const e: IceServer = { urls };
    if (typeof o.username === 'string') e.username = o.username;
    if (typeof o.credential === 'string') e.credential = o.credential;
    out.push(e);
  }
  return out;
}

/** 短期的 TURN 帳密（大家共用一組，快到期才換新的） */
async function turnServers(env: Env): Promise<IceServer[]> {
  const id = env.TURN_KEY_ID, token = env.TURN_KEY_API_TOKEN;
  if (!id || !token) return [];
  const now = Date.now() / 1000;
  if (turnCache && now - turnCache.at < TURN_TTL_S - TURN_REFRESH_S) return turnCache.servers;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    });
    if (!r.ok) return turnCache?.servers ?? [];
    const servers = cleanIce(((await r.json()) as { iceServers?: unknown })?.iceServers);
    if (servers.length) turnCache = { at: now, servers };
    return servers;
  } catch {
    return turnCache?.servers ?? [];
  }
}

const MAX_PLAYERS = 8;
const MAX_MSG = 8192;
/** 每個連線每秒最多幾則訊息（狀態同步 20 次／秒 + 事件 + 交握，留足夠餘裕） */
const RATE = 120;
/** 斷線後保留座位的時間 */
const AWAY_MS = 25000;

function originAllowed(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  const list = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (list.includes(origin)) return true;
  if (env.DEV_ORIGINS === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/turn') {
      // 只給我們的網頁
      const origin = req.headers.get('Origin');
      if (!originAllowed(origin, env)) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ iceServers: await turnServers(env) }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin!, 'Cache-Control': 'no-store', Vary: 'Origin' },
      });
    }
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,6})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (!originAllowed(req.headers.get('Origin'), env)) return new Response('forbidden', { status: 403 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    // 玩家連進來的 Cloudflare 機房（例如 TPE、HKG、LAX），讓網頁顯示「伺服器入口」
    const colo = (req as Request & { cf?: { colo?: string } }).cf?.colo ?? '';
    const fwd = new URL(req.url);
    fwd.searchParams.set('colo', colo);
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(new Request(fwd.toString(), req));
  },
};

interface Attach { pid: number; cid: string; joined: boolean }
interface Seat { pid: number; info: unknown; away: number }
type Seats = Record<string, Seat>;

export class Room {
  private state: DurableObjectState;
  /** 每個連線的訊息計數（休眠後清掉沒關係） */
  private rate = new Map<number, { t: number; n: number }>();

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  private peers(): { ws: WebSocket; a: Attach }[] {
    const out: { ws: WebSocket; a: Attach }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a && a.joined) out.push({ ws, a });
    }
    return out;
  }

  private async seats(): Promise<Seats> {
    return (await this.state.storage.get<Seats>('seats')) ?? {};
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* 對方已斷線 */ }
  }

  private broadcast(msg: unknown, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const p of this.peers()) {
      if (p.ws === except) continue;
      try { p.ws.send(s); } catch { /* 對方已斷線 */ }
    }
  }

  /** 房主不在了（離開或斷線）：交給目前在線、編號最小的人 */
  private async fixHost(seats: Seats): Promise<number> {
    let host = (await this.state.storage.get<number>('host')) ?? 0;
    const online = Object.values(seats).filter((s) => !s.away).map((s) => s.pid);
    if (!online.includes(host)) {
      const next = online.length ? Math.min(...online) : 0;
      if (next !== host) {
        host = next;
        await this.state.storage.put('host', host);
        if (host) this.broadcast({ t: 'host', pid: host });
      }
    }
    return host;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const create = url.searchParams.get('create') === '1';
    const cid = (url.searchParams.get('cid') ?? '').slice(0, 40);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    const fail = (code: string) => {
      server.serializeAttachment({ pid: 0, cid: '', joined: false } satisfies Attach);
      this.send(server, { t: 'err', code });
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!cid) return fail('closed');
    const colo = url.searchParams.get('colo') ?? '';
    let seats = await this.seats();
    const mine = seats[cid];
    if (mine) {
      // 斷線重連：回到原本的座位（比賽中也可以）。舊的連線如果還掛著就關掉
      for (const p of this.peers()) {
        if (p.a.cid !== cid) continue;
        p.a.joined = false;
        p.ws.serializeAttachment(p.a);
        try { p.ws.close(4001, 'replaced'); } catch { /* 已關閉 */ }
      }
      server.serializeAttachment({ pid: mine.pid, cid, joined: false } satisfies Attach);
      // 舊連線還沒被發現斷掉時也算「回來」（其他人收到 back 而不是 join）
      if (!mine.away) {
        mine.away = Date.now();
        await this.state.storage.put('seats', seats);
      }
      await this.state.storage.put('colo:' + cid, colo);
      return new Response(null, { status: 101, webSocket: client });
    }
    const taken = Object.keys(seats).length;
    if (create && taken > 0) return fail('taken');
    if (!create && taken === 0) return fail('noroom');
    if (taken >= MAX_PLAYERS) return fail('full');
    if (!create && (await this.state.storage.get<boolean>('started')) === true) return fail('started');
    if (create) {
      // 新房間：清掉舊資料
      await this.state.storage.deleteAll();
      seats = {};
    }
    const used = new Set(Object.values(seats).map((s) => s.pid));
    let pid = 1;
    while (used.has(pid)) pid++;
    seats[cid] = { pid, info: null, away: 0 };
    await this.state.storage.put('seats', seats);
    await this.state.storage.put('colo:' + cid, colo);
    server.serializeAttachment({ pid, cid, joined: false } satisfies Attach);
    return new Response(null, { status: 101, webSocket: client });
  }

  private limited(pid: number): boolean {
    const now = Date.now();
    const r = this.rate.get(pid) ?? { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    r.n++;
    this.rate.set(pid, r);
    return r.n > RATE;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || a.pid === 0) return;
    // 二進位：車輛狀態。第一個位元組 = 收件人遮罩（第 n 位 = 玩家 n+1，0 = 全部），轉發時換成發送者編號
    if (typeof raw !== 'string') {
      if (!a.joined || raw.byteLength < 2 || raw.byteLength > MAX_MSG || this.limited(a.pid)) return;
      const out = new Uint8Array(raw.slice(0));
      const mask = out[0];
      out[0] = a.pid;
      for (const p of this.peers()) {
        if (p.ws === ws) continue;
        if (mask !== 0 && !(mask & (1 << (p.a.pid - 1)))) continue;
        try { p.ws.send(out); } catch { /* 對方已斷線 */ }
      }
      return;
    }
    if (raw.length > MAX_MSG || this.limited(a.pid)) return;
    let msg: { t?: string; info?: unknown; d?: unknown; to?: number | number[] };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hi': {
        // 進房（或重連）：記下車手資料，回傳名單，通知其他人
        const seats = await this.seats();
        const seat = seats[a.cid];
        if (!seat) return;
        const wasAway = seat.away > 0;
        const first = !a.joined;
        seat.info = msg.info ?? null;
        seat.away = 0;
        await this.state.storage.put('seats', seats);
        a.joined = true;
        ws.serializeAttachment(a);
        if (first) {
          let host = (await this.state.storage.get<number>('host')) ?? 0;
          if (!host) {
            host = a.pid;
            await this.state.storage.put('host', host);
          }
          host = await this.fixHost(seats);
          const peers = Object.entries(seats).filter(([c]) => c !== a.cid).map(([, s]) => ({ pid: s.pid, info: s.info, away: s.away > 0 }));
          const started = (await this.state.storage.get<boolean>('started')) === true;
          const colo = (await this.state.storage.get<string>('colo:' + a.cid)) ?? '';
          this.send(ws, { t: 'welcome', pid: a.pid, host, peers, started, rejoin: wasAway, colo });
          this.broadcast(wasAway ? { t: 'back', pid: a.pid, info: seat.info } : { t: 'join', pid: a.pid, info: seat.info }, ws);
        } else {
          this.broadcast({ t: 'info', pid: a.pid, info: seat.info }, ws);
        }
        break;
      }
      case 'r': {
        // 遊戲訊息：轉發給其他人（或指定的人），蓋上發送者
        if (!a.joined) return;
        const to = msg.to;
        const out = JSON.stringify({ t: 'r', from: a.pid, d: msg.d });
        for (const p of this.peers()) {
          if (p.ws === ws) continue;
          if (typeof to === 'number' && p.a.pid !== to) continue;
          if (Array.isArray(to) && !to.includes(p.a.pid)) continue;
          try { p.ws.send(out); } catch { /* 對方已斷線 */ }
        }
        break;
      }
      case 'start': {
        // 只有房主能開始；開始後新的人進不來（斷線的人可以回來）
        if (a.pid !== (await this.state.storage.get<number>('host'))) return;
        await this.state.storage.put('started', true);
        this.broadcast({ t: 'start', d: msg.d }, ws);
        break;
      }
      case 'lobby':
        if (a.pid !== (await this.state.storage.get<number>('host'))) return;
        await this.state.storage.put('started', false);
        this.broadcast({ t: 'lobby' }, ws);
        break;
      case 'bye':
        // 按「離開房間」：馬上讓出座位
        await this.remove(a.cid);
        a.joined = false;
        ws.serializeAttachment(a);
        try { ws.close(1000, 'bye'); } catch { /* 已關閉 */ }
        break;
      case 'ping':
        this.send(ws, { t: 'pong', d: msg.d });
        break;
    }
  }

  /** 讓出座位並通知大家 */
  private async remove(cid: string): Promise<void> {
    const seats = await this.seats();
    const seat = seats[cid];
    if (!seat) return;
    delete seats[cid];
    await this.state.storage.put('seats', seats);
    await this.state.storage.delete('colo:' + cid);
    this.broadcast({ t: 'leave', pid: seat.pid });
    if (Object.keys(seats).length === 0) {
      await this.state.storage.deleteAll();
      return;
    }
    await this.fixHost(seats);
  }

  /** 斷線：座位先保留，AWAY_MS 後還沒回來才讓出 */
  private async dropped(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || !a.joined) return;
    a.joined = false;
    ws.serializeAttachment(a);
    this.rate.delete(a.pid);
    const seats = await this.seats();
    const seat = seats[a.cid];
    if (!seat) return;
    seat.away = Date.now();
    await this.state.storage.put('seats', seats);
    this.broadcast({ t: 'away', pid: a.pid });
    await this.fixHost(seats);
    const cur = await this.state.storage.getAlarm();
    if (cur === null) await this.state.storage.setAlarm(Date.now() + AWAY_MS + 200);
  }

  async alarm(): Promise<void> {
    const seats = await this.seats();
    const now = Date.now();
    let next = 0;
    for (const [cid, s] of Object.entries(seats)) {
      if (!s.away) continue;
      if (now - s.away >= AWAY_MS) await this.remove(cid);
      else next = next ? Math.min(next, s.away + AWAY_MS) : s.away + AWAY_MS;
    }
    if (next) await this.state.storage.setAlarm(next + 200);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
    try { ws.close(1000, 'bye'); } catch { /* 已關閉 */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws);
  }
}
