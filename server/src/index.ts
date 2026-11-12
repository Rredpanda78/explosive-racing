/**
 * Explosive Racing 線上房間伺服器（Cloudflare Worker + Durable Object）。
 * 一個房間代碼 = 一個 Room 物件，最多 8 人。伺服器只負責：
 * 1. 房間的建立／加入（滿了、不存在、比賽中會回錯誤代碼）
 * 2. 名單（誰在房間、誰是房主＝編號最小的人，房主離開自動換人）
 * 3. 轉發遊戲訊息（伺服器蓋上發送者編號，不能冒充別人）
 * 遊戲本身的模擬在各玩家的瀏覽器裡跑。
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  /** 允許連線的網頁（逗號分隔） */
  ALLOWED_ORIGINS: string;
  /** 本機開發（wrangler dev --var DEV_ORIGINS:1）另外允許 localhost */
  DEV_ORIGINS?: string;
}

const MAX_PLAYERS = 8;
const MAX_MSG = 8192;
/** 每個連線每秒最多幾則訊息（狀態同步 20 次／秒 + 事件，留足夠餘裕） */
const RATE = 90;

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
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,6})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (!originAllowed(req.headers.get('Origin'), env)) return new Response('forbidden', { status: 403 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  },
};

interface Attach { pid: number; info: unknown; joined: boolean }

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
      if (a) out.push({ ws, a });
    }
    return out;
  }

  private host(): number {
    let h = 0;
    for (const p of this.peers()) if (p.a.joined && (h === 0 || p.a.pid < h)) h = p.a.pid;
    return h;
  }

  private send(ws: WebSocket, msg: unknown): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* 對方已斷線 */ }
  }

  private broadcast(msg: unknown, except?: WebSocket): void {
    const s = JSON.stringify(msg);
    for (const p of this.peers()) {
      if (p.ws === except || !p.a.joined) continue;
      try { p.ws.send(s); } catch { /* 對方已斷線 */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const create = url.searchParams.get('create') === '1';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    const others = this.peers().filter((p) => p.ws !== server && p.a.joined);
    const started = (await this.state.storage.get<boolean>('started')) === true && others.length > 0;
    const fail = (code: string) => {
      server.serializeAttachment({ pid: 0, info: null, joined: false } satisfies Attach);
      this.send(server, { t: 'err', code });
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (create && others.length > 0) return fail('taken');
    if (!create && others.length === 0) return fail('noroom');
    if (others.length >= MAX_PLAYERS) return fail('full');
    if (started) return fail('started');
    if (others.length === 0) await this.state.storage.put('started', false);
    const used = new Set(others.map((p) => p.a.pid));
    let pid = 1;
    while (used.has(pid)) pid++;
    server.serializeAttachment({ pid, info: null, joined: false } satisfies Attach);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || a.pid === 0) return;
    // 簡單的流量限制：超過就丟掉
    const now = Date.now();
    const r = this.rate.get(a.pid) ?? { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    if (++r.n > RATE) { this.rate.set(a.pid, r); return; }
    this.rate.set(a.pid, r);
    let msg: { t?: string; info?: unknown; d?: unknown; to?: number };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'hi': {
        // 進房：記下車手資料，回傳名單，通知其他人
        a.info = msg.info ?? null;
        const first = !a.joined;
        a.joined = true;
        ws.serializeAttachment(a);
        if (first) {
          const peers = this.peers().filter((p) => p.ws !== ws && p.a.joined).map((p) => ({ pid: p.a.pid, info: p.a.info }));
          this.send(ws, { t: 'welcome', pid: a.pid, host: this.host(), peers });
          this.broadcast({ t: 'join', pid: a.pid, info: a.info }, ws);
        } else {
          this.broadcast({ t: 'info', pid: a.pid, info: a.info }, ws);
        }
        break;
      }
      case 'r': {
        // 遊戲訊息：轉發給其他人（或指定的人），蓋上發送者
        if (!a.joined) return;
        const out = JSON.stringify({ t: 'r', from: a.pid, d: msg.d });
        for (const p of this.peers()) {
          if (p.ws === ws || !p.a.joined) continue;
          if (typeof msg.to === 'number' && p.a.pid !== msg.to) continue;
          try { p.ws.send(out); } catch { /* 對方已斷線 */ }
        }
        break;
      }
      case 'start':
        // 只有房主能開始；開始後新的人進不來
        if (a.pid !== this.host()) return;
        await this.state.storage.put('started', true);
        this.broadcast({ t: 'start', d: msg.d }, ws);
        break;
      case 'lobby':
        if (a.pid !== this.host()) return;
        await this.state.storage.put('started', false);
        this.broadcast({ t: 'lobby' }, ws);
        break;
      case 'ping':
        this.send(ws, { t: 'pong', d: msg.d });
        break;
    }
  }

  private async left(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a || !a.joined) return;
    const before = this.host();
    a.joined = false;
    ws.serializeAttachment(a);
    this.rate.delete(a.pid);
    this.broadcast({ t: 'leave', pid: a.pid }, ws);
    const h = this.host();
    if (h !== before && h !== 0) this.broadcast({ t: 'host', pid: h }, ws);
    if (h === 0) await this.state.storage.put('started', false);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws);
    try { ws.close(1000, 'bye'); } catch { /* 已關閉 */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }
}
