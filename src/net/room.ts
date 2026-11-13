/** 連線房間的 WebSocket 客戶端（伺服器在 server/：Cloudflare Worker + Durable Object） */

/** 本機開發連本機的伺服器（cd server && npm run dev），正式版連 Cloudflare */
const ENV = (import.meta as unknown as { env?: { VITE_SERVER?: string; DEV?: boolean } }).env ?? {};
export const SERVER: string = ENV.VITE_SERVER ?? (ENV.DEV ? 'ws://localhost:8787' : 'wss://explosive-racing-rooms.rredpanda78.workers.dev');

/** 一般 HTTP 請求用的網址（公開房間列表、TURN、帳號） */
export const HTTP_SERVER = SERVER.replace(/^ws/, 'http');

/** 公開房間列表的一筆 */
export interface PublicRoom { code: string; players: number; host: string; started: boolean; track: number; mode: 'race' | 'elim' }

export async function fetchRooms(): Promise<PublicRoom[] | null> {
  try {
    const r = await fetch(HTTP_SERVER + '/rooms', { cache: 'no-store' });
    if (!r.ok) return null;
    return ((await r.json()) as { rooms?: PublicRoom[] }).rooms ?? [];
  } catch {
    return null;
  }
}

/** 房間代碼：4 個字，去掉容易看錯的 I、O、0、1 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newRoomCode = (): string => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
export const cleanCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export type ServerMsg =
  | { t: 'welcome'; pid: number; host: number; peers: { pid: number; info: unknown; away?: boolean }[]; started?: boolean; rejoin?: boolean; colo?: string }
  | { t: 'join'; pid: number; info: unknown }
  | { t: 'back'; pid: number; info: unknown }
  | { t: 'info'; pid: number; info: unknown }
  | { t: 'away'; pid: number }
  | { t: 'leave'; pid: number }
  | { t: 'host'; pid: number }
  | { t: 'r'; from: number; d: unknown }
  | { t: 'start'; d: unknown }
  | { t: 'lobby' }
  | { t: 'err'; code: string };

export const ERR_TEXT: Record<string, string> = {
  noroom: '找不到這個房間（代碼打錯，或房間已經沒人了）',
  full: '房間已經滿了（最多 8 人）',
  started: '這個房間正在比賽，等他們回到房間再加入',
  taken: '房間代碼剛好重複，請再按一次建立',
  closed: '和伺服器的連線中斷了',
  failed: '連不上伺服器，請檢查網路',
};
/** 這些錯誤不用重試 */
const FATAL = new Set(['noroom', 'full', 'started', 'taken']);
/** 斷線後的重試間隔（伺服器替你保留座位 25 秒） */
const RETRY_MS = [300, 700, 1200, 2000, 3000, 4000, 4000, 4000, 4000];

/**
 * 房間連線：斷線會自動重連回原本的座位（同一個 cid），
 * 也會用 ping 偵測「看起來連著其實已經斷了」的連線（手機切換網路時常見）。
 */
export class RoomClient {
  /** 這次進房的身分：重連時用它找回座位 */
  readonly cid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  private ws: WebSocket | null = null;
  private code = '';
  private info: unknown = null;
  private want = false;
  private joined = false;
  private tries = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private lastPong = 0;
  private errCode = '';
  /** 到伺服器的來回延遲（毫秒） */
  rtt = 0;
  reconnecting = false;
  onMsg: (m: ServerMsg) => void = () => {};
  /** 伺服器轉來的二進位資料：from = 發送者編號 */
  onBinary: (from: number, data: ArrayBuffer) => void = () => {};
  onClose: (code: string) => void = () => {};
  onReconnecting: () => void = () => {};

  connect(code: string, create: boolean, info: unknown): void {
    this.close();
    this.code = code;
    this.info = info;
    this.want = true;
    this.joined = false;
    this.tries = 0;
    this.open(create);
  }

  /** 車手資料變了：重連時送新的 */
  setInfo(info: unknown): void {
    this.info = info;
  }

  private open(create: boolean): void {
    this.errCode = '';
    const ws = new WebSocket(`${SERVER}/room/${this.code}?cid=${this.cid}${create ? '&create=1' : ''}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.lastPong = performance.now();
      this.sendRaw(ws, { t: 'hi', info: this.info });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        // 6 秒沒有回應：連線其實已經斷了，關掉重連
        if (performance.now() - this.lastPong > 6000) {
          try { ws.close(); } catch { /* 已關閉 */ }
          return;
        }
        this.sendRaw(ws, { t: 'ping', d: performance.now() });
      }, 2000);
    };
    ws.onmessage = (e) => {
      this.lastPong = performance.now();
      if (typeof e.data !== 'string') {
        const buf = e.data as ArrayBuffer;
        if (buf.byteLength > 1) this.onBinary(new Uint8Array(buf)[0], buf);
        return;
      }
      let m: { t: string; d?: number; code?: string };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') {
        this.rtt = performance.now() - (m.d ?? 0);
        return;
      }
      if (m.t === 'err') this.errCode = m.code ?? 'closed';
      if (m.t === 'welcome') {
        this.joined = true;
        this.tries = 0;
        this.reconnecting = false;
      }
      this.onMsg(m as ServerMsg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.want) return;
      if (FATAL.has(this.errCode) || !this.joined || this.tries >= RETRY_MS.length) {
        this.want = false;
        this.reconnecting = false;
        this.onClose(this.errCode || (this.joined ? 'closed' : 'failed'));
        return;
      }
      // 自動重連回原本的座位
      this.reconnecting = true;
      this.onReconnecting();
      this.retryTimer = window.setTimeout(() => {
        if (this.want) this.open(false);
      }, RETRY_MS[this.tries++]);
    };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.joined;
  }

  private sendRaw(ws: WebSocket, m: object): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  send(m: object): void {
    if (this.ws) this.sendRaw(this.ws, m);
  }

  /** 遊戲訊息：轉發給房間裡其他人（to = 只給這些人） */
  relay(d: unknown, to?: number[]): void {
    this.send(to ? { t: 'r', d, to } : { t: 'r', d });
  }

  /** 二進位：第一個位元組是收件人遮罩（0 = 全部） */
  sendBin(buf: Uint8Array<ArrayBuffer>): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.joined) this.ws.send(buf);
  }

  close(): void {
    this.want = false;
    this.reconnecting = false;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      // 主動離開：讓伺服器馬上讓出座位
      this.sendRaw(ws, { t: 'bye' });
      try { ws.close(1000, 'leave'); } catch { /* 已關閉 */ }
    }
  }
}
