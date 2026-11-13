import type { RoomClient } from './room';

/**
 * 玩家之間的直連（WebRTC DataChannel）。能直連的兩個人互傳資料不經過伺服器：
 * 延遲最低，也不受 Cloudflare 晚上把台灣的連線繞到國外機房影響。
 * 連不上（例如某些手機網路）就自動改走伺服器中轉。
 *
 * 每一對玩家由編號小的一方發起；交握訊息（SDP、ICE）透過伺服器轉送。
 * 兩條通道：r = 可靠有序（事件），u = 不可靠無序（每秒 20 次的狀態，掉一包就算了，不會卡住後面的）。
 */
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
/** 這麼久還沒連上就先走伺服器，背景繼續等 */
const CONNECT_MS = 8000;

interface Link {
  pc: RTCPeerConnection;
  rel: RTCDataChannel | null;
  unrel: RTCDataChannel | null;
  failed: boolean;
  pending: RTCIceCandidateInit[];
  timer: number;
}

export type RtcSignal = { e: 'rtc'; sdp?: RTCSessionDescriptionInit; cand?: RTCIceCandidateInit };

export class Mesh {
  static readonly supported = typeof RTCPeerConnection !== 'undefined';
  private links = new Map<number, Link>();
  private client: RoomClient;
  private me: () => number;
  private onJson: (from: number, d: unknown) => void;
  private onBin: (from: number, data: ArrayBuffer) => void;
  /** 直連狀態改變（介面顯示用） */
  onStatus: () => void = () => {};

  constructor(client: RoomClient, me: () => number, onJson: (from: number, d: unknown) => void, onBin: (from: number, data: ArrayBuffer) => void) {
    this.client = client;
    this.me = me;
    this.onJson = onJson;
    this.onBin = onBin;
  }

  /** 認識一位玩家：編號比他小就主動發起直連，比他大就等對方 */
  ensure(pid: number): void {
    const me = this.me();
    if (!Mesh.supported || pid === me || me === 0 || this.links.has(pid)) return;
    if (me < pid) this.create(pid, true);
  }

  /** 對方離開或重連：拆掉舊的直連（之後可以重新建立） */
  drop(pid: number): void {
    const l = this.links.get(pid);
    if (!l) return;
    window.clearTimeout(l.timer);
    try { l.pc.close(); } catch { /* 已關閉 */ }
    this.links.delete(pid);
    this.onStatus();
  }

  dropAll(): void {
    for (const pid of [...this.links.keys()]) this.drop(pid);
  }

  direct(pid: number): boolean {
    return this.links.get(pid)?.rel?.readyState === 'open';
  }

  private create(pid: number, initiator: boolean): Link {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const link: Link = { pc, rel: null, unrel: null, failed: false, pending: [], timer: 0 };
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
          try { this.onJson(pid, JSON.parse(e.data)); } catch { /* 壞資料 */ }
        } else this.onBin(pid, e.data as ArrayBuffer);
      };
      ch.onopen = () => this.onStatus();
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

  /** 收到對方（經伺服器轉來）的交握訊息 */
  async signal(from: number, d: RtcSignal): Promise<void> {
    if (!Mesh.supported) return;
    try {
      if (d.sdp) {
        if (d.sdp.type === 'offer') {
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
      /* 交握失敗：繼續走伺服器 */
    }
  }

  /** 事件：能直連的直接送，其他人一次經伺服器送（to 省略 = 所有人） */
  sendJson(d: unknown, peers: number[], to?: number[]): void {
    const targets = to ?? peers;
    const via: number[] = [];
    let s = '';
    for (const p of targets) {
      const ch = this.links.get(p)?.rel;
      if (ch && ch.readyState === 'open') {
        s ||= JSON.stringify(d);
        try { ch.send(s); continue; } catch { /* 改走伺服器 */ }
      }
      via.push(p);
    }
    if (!via.length) return;
    this.client.relay(d, !to && via.length === peers.length ? undefined : via);
  }

  /** 狀態：能直連的走不可靠通道，其他人用收件人遮罩一次經伺服器送 */
  sendBin(buf: Uint8Array<ArrayBuffer>, peers: number[]): void {
    let mask = 0;
    for (const p of peers) {
      const ch = this.links.get(p)?.unrel;
      if (ch && ch.readyState === 'open' && ch.bufferedAmount < 64000) {
        try { ch.send(buf); continue; } catch { /* 改走伺服器 */ }
      }
      mask |= 1 << (p - 1);
    }
    if (!mask) return;
    const out = buf.slice();
    out[0] = mask;
    this.client.sendBin(out);
  }
}
