import { SERVER, type RoomClient } from './room';

/**
 * 玩家之間的連線網：每一對玩家依序嘗試三種路，資料都不經過我們的伺服器（晚上被繞到美國也不影響）：
 * 1. 直連（WebRTC DataChannel，STUN 打洞）
 * 2. TURN 中轉（Cloudflare Realtime，入口在台北；跟羽球對決同一種做法，伺服器有設 TURN key 才有）
 *    —— 1、2 由瀏覽器自動選，連上後用 getStats 看實際走哪一條
 * 3. 隊友轉送：兩個人連不上、但都跟第三個人連得上，就請他轉送（優先選連線最好的「主力」玩家）
 * 都不行才走 Cloudflare 伺服器中轉。
 *
 * 每一對玩家由編號小的一方發起；交握訊息（SDP、ICE）透過伺服器轉送。
 * 兩條通道：r = 可靠有序（事件），u = 不可靠無序（每秒 20 次的狀態，掉一包就算了，不會卡住後面的）。
 */
const STUN: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
/** 這麼久還沒連上就先走別條路，背景繼續等 */
const CONNECT_MS = 9000;

/** 二進位封包種類：1 = 狀態；2 = 請隊友轉送；3 = 隊友轉送來的 */
const BIN_FWD = 2;
const BIN_FWDED = 3;

export type Path = 'direct' | 'turn' | 'peer' | 'server';

interface Link {
  pc: RTCPeerConnection;
  rel: RTCDataChannel | null;
  unrel: RTCDataChannel | null;
  failed: boolean;
  pending: RTCIceCandidateInit[];
  timer: number;
  /** 實際走的路：直連或 TURN 中轉（連上後才知道） */
  path: 'direct' | 'turn' | null;
}

export type RtcSignal = { e: 'rtc'; sdp?: RTCSessionDescriptionInit; cand?: RTCIceCandidateInit };

// ---------- TURN 帳密：整個網頁共用一份，6 小時內不重拿 ----------
let turnIce: RTCIceServer[] = [];
let turnAt = -1e12;
let turnLoading: Promise<void> | null = null;
function loadTurn(): Promise<void> {
  if (performance.now() - turnAt < 5 * 3600e3) return Promise.resolve();
  if (!turnLoading) {
    const url = SERVER.replace(/^ws/, 'http') + '/turn';
    turnLoading = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { iceServers?: RTCIceServer[] } | null) => {
        turnIce = (j?.iceServers ?? []).filter((s) => s && s.urls);
        turnAt = performance.now();
      })
      .catch(() => {})
      .finally(() => { turnLoading = null; });
  }
  return turnLoading;
}
/** 等 TURN 帳密（最多 2.5 秒，拿不到就只用 STUN） */
const turnReady = () => Promise.race([loadTurn(), new Promise<void>((r) => setTimeout(r, 2500))]);
export const hasTurn = () => turnIce.length > 0;

export class Mesh {
  static readonly supported = typeof RTCPeerConnection !== 'undefined';
  private links = new Map<number, Link>();
  /** 其他人回報「我跟誰連得上」（隊友轉送用） */
  private tables = new Map<number, Set<number>>();
  private client: RoomClient;
  private me: () => number;
  private onJson: (from: number, d: unknown) => void;
  private onBin: (from: number, data: ArrayBuffer) => void;
  /** 選轉送人時的偏好：延遲（毫秒），越小越好；主力玩家另外加分 */
  rttOf: (pid: number) => number = () => 0;
  preferred: (pid: number) => boolean = () => false;
  /** 測試用：不跟這些人建立連線（模擬連不上） */
  readonly block = new Set<number>();
  /** 連線狀態改變（介面顯示用） */
  onStatus: () => void = () => {};

  constructor(client: RoomClient, me: () => number, onJson: (from: number, d: unknown) => void, onBin: (from: number, data: ArrayBuffer) => void) {
    this.client = client;
    this.me = me;
    this.onJson = onJson;
    this.onBin = onBin;
    if (Mesh.supported) void loadTurn();
  }

  /** 認識一位玩家：編號比他小就主動發起連線，比他大就等對方 */
  ensure(pid: number): void {
    const me = this.me();
    if (!Mesh.supported || pid === me || me === 0 || this.links.has(pid) || this.block.has(pid)) return;
    if (me < pid) void turnReady().then(() => {
      if (!this.links.has(pid)) this.create(pid, true);
    });
  }

  /** 對方離開或重連：拆掉舊的連線（之後可以重新建立） */
  drop(pid: number): void {
    this.tables.delete(pid);
    const l = this.links.get(pid);
    if (!l) return;
    window.clearTimeout(l.timer);
    try { l.pc.close(); } catch { /* 已關閉 */ }
    this.links.delete(pid);
    this.onStatus();
  }

  dropAll(): void {
    for (const pid of [...this.links.keys()]) this.drop(pid);
    this.tables.clear();
  }

  /** 有沒有自己的通道（直連或 TURN） */
  direct(pid: number): boolean {
    return this.links.get(pid)?.rel?.readyState === 'open';
  }

  /** 我自己連得上的人（定期告訴大家，讓大家知道可以請誰轉送） */
  myLinks(): number[] {
    return [...this.links.keys()].filter((p) => this.direct(p));
  }

  setTable(pid: number, list: number[]): void {
    this.tables.set(pid, new Set(list));
  }

  linksOf(pid: number): number {
    return this.tables.get(pid)?.size ?? 0;
  }

  /** 送給 t 的資料走哪一條路；peer = 經由 via 轉送 */
  route(t: number): { path: Path; via?: number } {
    const l = this.links.get(t);
    if (l?.rel?.readyState === 'open') return { path: l.path ?? 'direct' };
    let best = 0, score = Infinity;
    for (const [c, set] of this.tables) {
      if (c === t || !set.has(t) || !this.direct(c)) continue;
      const s = this.rttOf(c) - (this.preferred(c) ? 40 : 0);
      if (s < score) { score = s; best = c; }
    }
    return best ? { path: 'peer', via: best } : { path: 'server' };
  }

  private create(pid: number, initiator: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: [...STUN, ...turnIce] });
    const link: Link = { pc, rel: null, unrel: null, failed: false, pending: [], timer: 0, path: null };
    this.links.set(pid, link);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.client.relay({ e: 'rtc', cand: e.candidate.toJSON() } satisfies RtcSignal, [pid]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        link.failed = true;
        this.onStatus();
      }
    };
    const setup = (ch: RTCDataChannel) => {
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (e) => {
        if (typeof e.data === 'string') {
          let d: unknown;
          try { d = JSON.parse(e.data); } catch { return; }
          this.json(pid, d);
        } else this.bin(pid, e.data as ArrayBuffer);
      };
      ch.onopen = () => {
        void this.detectPath(link);
        this.onStatus();
      };
      ch.onclose = () => this.onStatus();
      if (ch.label === 'r') link.rel = ch;
      else link.unrel = ch;
    };
    if (initiator) {
      setup(pc.createDataChannel('r', { ordered: true }));
      setup(pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      void pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.client.relay({ e: 'rtc', sdp: pc.localDescription!.toJSON() } satisfies RtcSignal, [pid]))
        .catch(() => { link.failed = true; });
    } else {
      pc.ondatachannel = (e) => setup(e.channel);
    }
    link.timer = window.setTimeout(() => {
      if (!this.direct(pid)) {
        link.failed = true;
        this.onStatus();
      }
    }, CONNECT_MS);
    return link;
  }

  /** 連上之後看實際走的是直連還是 TURN 中轉 */
  private async detectPath(link: Link): Promise<void> {
    try {
      const stats = await link.pc.getStats();
      let pairId = '';
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      });
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((s) => {
        if (s.type !== 'candidate-pair') return;
        if ((pairId && s.id === pairId) || (!pairId && s.nominated && s.state === 'succeeded')) pair = s as RTCIceCandidatePairStats;
      });
      if (!pair) return;
      const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
      const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
      link.path = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'direct';
      this.onStatus();
    } catch {
      /* 看不到就算直連 */
    }
  }

  /** 收到對方（經伺服器轉來）的交握訊息 */
  async signal(from: number, d: RtcSignal): Promise<void> {
    if (!Mesh.supported || this.block.has(from)) return;
    try {
      if (d.sdp) {
        if (d.sdp.type === 'offer') {
          await turnReady();
          // 對方重新發起：丟掉舊的
          if (this.links.has(from)) this.drop(from);
          const link = this.create(from, false);
          await link.pc.setRemoteDescription(d.sdp);
          for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
          const ans = await link.pc.createAnswer();
          await link.pc.setLocalDescription(ans);
          this.client.relay({ e: 'rtc', sdp: link.pc.localDescription!.toJSON() } satisfies RtcSignal, [from]);
        } else {
          const link = this.links.get(from);
          if (!link) return;
          await link.pc.setRemoteDescription(d.sdp);
          for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
        }
      } else if (d.cand) {
        const link = this.links.get(from);
        if (!link) return;
        if (link.pc.remoteDescription) await link.pc.addIceCandidate(d.cand).catch(() => {});
        else link.pending.push(d.cand);
      }
    } catch {
      /* 交握失敗：改走別條路 */
    }
  }

  // ---------------- 收：處理隊友轉送 ----------------

  /** 通道上收到的 JSON（也處理隊友轉送的信封） */
  json(from: number, d: unknown): void {
    const m = d as { e?: string; to?: number[]; o?: number; d?: unknown };
    if (m && m.e === 'fw' && Array.isArray(m.to)) {
      // 請我轉送：寫上原始發送者，轉給每個收件人（我連不上的就經伺服器）
      const env = { e: 'fwd', o: from, d: m.d };
      const via: number[] = [];
      for (const t of m.to) {
        const ch = this.links.get(t)?.rel;
        if (t !== this.me() && ch?.readyState === 'open') ch.send(JSON.stringify(env));
        else if (t !== this.me()) via.push(t);
      }
      if (via.length) this.client.relay(env, via);
      return;
    }
    if (m && m.e === 'fwd' && typeof m.o === 'number') {
      this.onJson(m.o, m.d);
      return;
    }
    this.onJson(from, d);
  }

  /** 通道（或伺服器）上收到的二進位 */
  bin(from: number, data: ArrayBuffer): void {
    const u = new Uint8Array(data);
    if (u.length < 3) return;
    if (u[1] === BIN_FWD) {
      // [0][2][原始發送者][收件人遮罩][封包內容…]：只轉送發送者自己的資料
      if (u[2] !== from || u.length < 5) return;
      const mask = u[3];
      const out = new Uint8Array(u.length - 1);
      out[0] = 0;
      out[1] = BIN_FWDED;
      out[2] = from;
      out.set(u.subarray(4), 3);
      for (let p = 1; p <= 8; p++) {
        if (!(mask & (1 << (p - 1))) || p === this.me()) continue;
        const ch = this.links.get(p)?.unrel;
        if (ch?.readyState === 'open') try { ch.send(out); } catch { /* 掉了就算了 */ }
      }
      return;
    }
    if (u[1] === BIN_FWDED) {
      // [0][3][原始發送者][封包內容…] → 還原成一般封包交給上層
      const origin = u[2];
      const out = new Uint8Array(u.length - 2);
      out[0] = origin;
      out.set(u.subarray(3), 1);
      this.onBin(origin, out.buffer);
      return;
    }
    this.onBin(from, data);
  }

  // ---------------- 送 ----------------

  /** 事件：自己的通道、隊友轉送、伺服器中轉三種一起用，每個人只收到一次（to 省略 = 所有人） */
  sendJson(d: unknown, peers: number[], to?: number[]): void {
    const targets = to ?? peers;
    const viaServer: number[] = [];
    const viaPeer = new Map<number, number[]>();
    let s = '';
    for (const t of targets) {
      const r = this.route(t);
      if (r.path === 'direct' || r.path === 'turn') {
        s ||= JSON.stringify(d);
        try { this.links.get(t)!.rel!.send(s); continue; } catch { /* 改走伺服器 */ }
      } else if (r.path === 'peer') {
        const list = viaPeer.get(r.via!) ?? [];
        list.push(t);
        viaPeer.set(r.via!, list);
        continue;
      }
      viaServer.push(t);
    }
    for (const [c, list] of viaPeer) {
      try { this.links.get(c)!.rel!.send(JSON.stringify({ e: 'fw', to: list, d })); } catch { viaServer.push(...list); }
    }
    if (!viaServer.length) return;
    this.client.relay(d, !to && viaServer.length === peers.length ? undefined : viaServer);
  }

  /** 狀態：自己的不可靠通道、隊友轉送、伺服器（用收件人遮罩一次送） */
  sendBin(buf: Uint8Array<ArrayBuffer>, peers: number[]): void {
    let serverMask = 0;
    const peerMask = new Map<number, number>();
    for (const p of peers) {
      const r = this.route(p);
      if (r.path === 'direct' || r.path === 'turn') {
        const ch = this.links.get(p)!.unrel;
        if (ch && ch.readyState === 'open' && ch.bufferedAmount < 64000) {
          try { ch.send(buf); continue; } catch { /* 改走伺服器 */ }
        }
      } else if (r.path === 'peer') {
        peerMask.set(r.via!, (peerMask.get(r.via!) ?? 0) | (1 << (p - 1)));
        continue;
      }
      serverMask |= 1 << (p - 1);
    }
    for (const [c, mask] of peerMask) {
      const ch = this.links.get(c)?.unrel;
      if (!ch || ch.readyState !== 'open') { serverMask |= mask; continue; }
      // [0][2][我][收件人遮罩][封包內容（第 1 個位元組以後）]
      const out = new Uint8Array(buf.length + 3);
      out[1] = BIN_FWD;
      out[2] = this.me();
      out[3] = mask;
      out.set(buf.subarray(1), 4);
      try { ch.send(out); } catch { serverMask |= mask; }
    }
    if (!serverMask) return;
    const out = buf.slice();
    out[0] = serverMask;
    this.client.sendBin(out);
  }
}
