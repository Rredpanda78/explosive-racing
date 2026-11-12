/** 連線房間的 WebSocket 客戶端（伺服器在 server/：Cloudflare Worker + Durable Object） */

/** 本機開發連本機的伺服器（cd server && npm run dev），正式版連 Cloudflare */
const ENV = (import.meta as unknown as { env?: { VITE_SERVER?: string; DEV?: boolean } }).env ?? {};
export const SERVER: string = ENV.VITE_SERVER ?? (ENV.DEV ? 'ws://localhost:8787' : 'wss://explosive-racing-rooms.rredpanda78.workers.dev');

/** 房間代碼：4 個字，去掉容易看錯的 I、O、0、1 */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newRoomCode = (): string => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
export const cleanCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

export type ServerMsg =
  | { t: 'welcome'; pid: number; host: number; peers: { pid: number; info: unknown }[] }
  | { t: 'join'; pid: number; info: unknown }
  | { t: 'info'; pid: number; info: unknown }
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

export class RoomClient {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private errCode = '';
  private opened = false;
  /** 來回延遲（毫秒） */
  rtt = 0;
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: (code: string) => void = () => {};

  connect(code: string, create: boolean, info: unknown): void {
    this.close();
    this.errCode = '';
    this.opened = false;
    const ws = new WebSocket(`${SERVER}/room/${code}${create ? '?create=1' : ''}`);
    this.ws = ws;
    ws.onopen = () => {
      this.opened = true;
      this.send({ t: 'hi', info });
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', d: performance.now() }), 2000);
    };
    ws.onmessage = (e) => {
      let m: { t: string; d?: number; code?: string };
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.t === 'pong') {
        this.rtt = performance.now() - (m.d ?? 0);
        return;
      }
      if (m.t === 'err') this.errCode = m.code ?? 'closed';
      this.onMsg(m as ServerMsg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.onClose(this.errCode || (this.opened ? 'closed' : 'failed'));
    };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** 遊戲訊息：轉發給房間裡其他人（to = 只給某一個人） */
  relay(d: unknown, to?: number): void {
    this.send(to ? { t: 'r', d, to } : { t: 'r', d });
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try { ws.close(1000, 'leave'); } catch { /* 已關閉 */ }
    }
  }
}
