import type { DifficultyId } from '../game/difficulty';
import type { Kart } from '../game/kart';
import type { NetRacer, OnlineSetup, SecParams } from '../game/net';
import type { Race, RaceMode } from '../game/race';
import { clamp, lerp, lerpAngle } from '../game/util';
import { RoomClient, type ServerMsg } from './room';

/** 房主決定的房間設定 */
export interface RoomConfig {
  track: number;
  mode: RaceMode;
  aiFill: boolean;
  difficulty: DifficultyId;
}

/** 開始比賽：每個人照同樣的設定、亂數種子與名單建立比賽 */
export interface StartMsg {
  cfg: RoomConfig;
  seed: number;
  racers: NetRacer[];
}

/** 狀態同步：每秒 20 次；遠端的車晚 110 毫秒顯示（在兩筆資料之間內插，比較平順） */
const SEND_MS = 50;
const DELAY_MS = 110;

/** 一台車的狀態（陣列比物件省流量） */
type Pack = number[];
interface Snap { t: number; a: Pack }

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function pack(k: Kart): Pack {
  const fl = (k.drifting ? 1 : 0) | (k.dead ? 2 : 0) | (k.netFire ? 4 : 0) | (k.driftDir > 0 ? 8 : 0) | (k.hop ? 16 : 0);
  return [
    k.netId, r2(k.x), r2(k.y), r2(k.z), r3(k.heading), r3(k.pitch), r2(k.speed), r3(k.slip), r2(k.steerVis), r2(k.air), fl,
    r2(k.boostT), r2(k.miniT), r2(k.padT), Math.round(k.hp), Math.round(k.maxHp), k.idx, k.prog, r2(k.progFine), k.lapCount, r2(Math.min(k.invulnT, 99)), r2(k.yawRate),
  ];
}

/**
 * 一次連線：房間名單、房主設定，比賽中同步每台車的狀態與事件。
 * 架構：每個人自己的車在自己的電腦上跑物理、判定自己有沒有被打中（不會有「明明閃過還被打到」）；
 * 電腦車手由房主的電腦控制；副武器發射時把參數傳給大家，讓每個畫面生出一樣的砲彈。
 */
export class OnlineSession {
  client = new RoomClient();
  code = '';
  me = 0;
  hostPid = 0;
  /** 房間裡的人（包含自己），照玩家編號排序 */
  peers = new Map<number, NetRacer>();
  cfg: RoomConfig;
  status: 'connecting' | 'lobby' | 'racing' | 'closed' = 'connecting';
  onChange: () => void = () => {};
  onStart: (s: StartMsg) => void = () => {};
  onClosed: (code: string) => void = () => {};
  private info: () => Omit<NetRacer, 'pid'>;
  private race: Race | null = null;
  private buf = new Map<number, Snap[]>();
  private hits = new Map<string, number>();
  private lastSend = 0;

  constructor(info: () => Omit<NetRacer, 'pid'>, cfg: RoomConfig) {
    this.info = info;
    this.cfg = cfg;
    this.client.onMsg = (m) => this.handle(m);
    this.client.onClose = (code) => {
      this.status = 'closed';
      this.onClosed(code);
    };
  }

  get isHost(): boolean {
    return this.me !== 0 && this.me === this.hostPid;
  }

  get list(): NetRacer[] {
    return [...this.peers.values()].sort((a, b) => a.pid - b.pid);
  }

  open(code: string, create: boolean): void {
    this.code = code;
    this.status = 'connecting';
    this.client.connect(code, create, this.info());
  }

  leave(): void {
    this.client.close();
    this.status = 'closed';
    this.race = null;
  }

  /** 換了車或武器：告訴房間裡的人 */
  refreshInfo(): void {
    const me = this.peers.get(this.me);
    if (!me) return;
    Object.assign(me, this.info());
    this.client.send({ t: 'hi', info: this.info() });
    this.onChange();
  }

  setCfg(c: Partial<RoomConfig>): void {
    if (!this.isHost) return;
    Object.assign(this.cfg, c);
    this.client.relay({ e: 'cfg', cfg: this.cfg });
    this.onChange();
  }

  /** 房主按開始 */
  start(): void {
    if (!this.isHost) return;
    const msg: StartMsg = { cfg: { ...this.cfg }, seed: Math.floor(Math.random() * 2 ** 31), racers: this.list };
    this.client.send({ t: 'start', d: msg });
    this.onStart(msg);
  }

  setup(msg: StartMsg): OnlineSetup {
    return { racers: msg.racers, me: this.me, host: this.isHost, aiFill: msg.cfg.aiFill, difficulty: msg.cfg.difficulty };
  }

  /** 比賽完回到房間；房主回去時伺服器會重新開放加入 */
  backToLobby(keepRace = false): void {
    // 房主先回房間時，比賽在背景繼續跑（電腦車手要繼續開、淘汰要繼續判定）
    if (!keepRace) {
      this.race = null;
      this.buf.clear();
    }
    if (this.status !== 'closed') this.status = 'lobby';
    if (this.isHost) this.client.send({ t: 'lobby' });
    this.onChange();
  }

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        this.me = m.pid;
        this.hostPid = m.host;
        this.peers.clear();
        this.peers.set(m.pid, { ...this.info(), pid: m.pid });
        for (const p of m.peers) this.peers.set(p.pid, { ...(p.info as NetRacer), pid: p.pid });
        this.status = 'lobby';
        this.onChange();
        break;
      }
      case 'join':
      case 'info':
        this.peers.set(m.pid, { ...(m.info as NetRacer), pid: m.pid });
        // 新來的人要知道房主目前的設定
        if (m.t === 'join' && this.isHost) this.client.relay({ e: 'cfg', cfg: this.cfg }, m.pid);
        this.onChange();
        break;
      case 'leave':
        this.peers.delete(m.pid);
        if (this.race) for (const k of this.race.karts) if (k.owner === m.pid && k.remote) this.race.dropKart(k);
        this.onChange();
        break;
      case 'host':
        this.hostPid = m.pid;
        if (this.race?.net) {
          this.race.net.host = this.isHost;
          if (this.isHost) this.race.takeOverAI();
        }
        this.onChange();
        break;
      case 'start':
        this.onStart(m.d as StartMsg);
        break;
      case 'lobby':
        this.onChange();
        break;
      case 'r':
        this.relayed(m.from, m.d as { e: string } & Record<string, unknown>);
        break;
    }
  }

  /** 這台車的資料只接受車主（電腦車手只接受房主）傳來的 */
  private owns(from: number, k: Kart | undefined): k is Kart {
    return !!k && k.remote && (k.owner !== 0 ? k.owner === from : from === this.hostPid);
  }

  private relayed(from: number, d: { e: string } & Record<string, unknown>): void {
    if (!d || typeof d.e !== 'string') return;
    if (d.e === 'cfg') {
      if (from === this.hostPid) {
        this.cfg = d.cfg as RoomConfig;
        this.onChange();
      }
      return;
    }
    const race = this.race;
    if (!race) return;
    const K = race.karts;
    switch (d.e) {
      case 's': {
        const now = performance.now();
        for (const a of d.k as Pack[]) {
          const k = K[a[0]];
          if (!this.owns(from, k)) continue;
          const b = this.buf.get(k.netId) ?? [];
          b.push({ t: now, a });
          if (b.length > 8) b.shift();
          this.buf.set(k.netId, b);
        }
        for (const [v, by, amt] of (d.h as number[][]) ?? []) {
          if (K[v] && K[by]) race.remoteDamage(K[v], K[by], amt);
        }
        break;
      }
      case 'sec': {
        const k = K[d.k as number];
        if (this.owns(from, k)) race.remoteSecondary(k, d.p as SecParams);
        break;
      }
      case 'kill': {
        const v = K[d.v as number];
        if (this.owns(from, v)) race.remoteKill(v, (d.by as number) >= 0 ? K[d.by as number] ?? null : null);
        break;
      }
      case 'fin': {
        const k = K[d.k as number];
        if (this.owns(from, k)) race.remoteFinish(k, d.time as number, d.laps as number[]);
        break;
      }
      case 'elim': {
        const k = K[d.k as number];
        if (from === this.hostPid && k) race.eliminate(k);
        break;
      }
    }
  }

  /** 比賽開始：接上 Race 的連線掛勾 */
  attach(race: Race): void {
    this.race = race;
    this.buf.clear();
    this.hits.clear();
    this.status = 'racing';
    const c = this.client;
    race.net = {
      host: this.isHost,
      onSecondary: (k, p) => c.relay({ e: 'sec', k: k.netId, p }),
      onDamage: (v, by, amount) => {
        if (!by) return;
        const key = v.netId + ':' + by.netId;
        this.hits.set(key, (this.hits.get(key) ?? 0) + amount);
      },
      onKill: (v, by) => c.relay({ e: 'kill', v: v.netId, by: by ? by.netId : -1 }),
      onFinish: (k) => c.relay({ e: 'fin', k: k.netId, time: k.finishTime, laps: k.lapTimes }),
      onElim: (k) => c.relay({ e: 'elim', k: k.netId }),
    };
  }

  /** 每幀在 race.step 之前：把遠端的車移到內插後的位置 */
  applyRemote(now: number): void {
    const race = this.race;
    if (!race) return;
    const rt = now - DELAY_MS;
    for (const k of race.karts) {
      if (!k.remote || k.out) continue;
      const b = this.buf.get(k.netId);
      if (!b || !b.length) continue;
      // 找 rt 前後兩筆
      let i = b.length - 1;
      while (i > 0 && b[i].t > rt) i--;
      const A = b[i], B = b[Math.min(i + 1, b.length - 1)];
      let u = B === A ? 0 : clamp((rt - A.t) / (B.t - A.t), 0, 1);
      const a = A.a, c = B.a;
      // 瞬移（重生、重置）就不要內插
      if (Math.hypot(c[1] - a[1], c[3] - a[3]) > 25) u = 1;
      k.x = lerp(a[1], c[1], u);
      k.y = lerp(a[2], c[2], u);
      k.z = lerp(a[3], c[3], u);
      k.heading = lerpAngle(a[4], c[4], u);
      k.pitch = lerp(a[5], c[5], u);
      k.speed = lerp(a[6], c[6], u);
      k.slip = lerp(a[7], c[7], u);
      k.steerVis = lerp(a[8], c[8], u);
      k.air = lerp(a[9], c[9], u);
      // 內插的位置是「過去」的：照速度與轉向角速度沿弧線往前推到「現在」
      // （顯示延遲 + 單程網路延遲，資料晚到時再多推一點，最多 0.35 秒）
      const late = B === A ? Math.max(0, (rt - A.t) / 1000) : 0;
      const lead = Math.min(0.35, DELAY_MS / 1000 + this.client.rtt / 2000 + late);
      const w = lerp(a[21], c[21], u);
      const dir = k.heading + k.slip;
      k.vx = Math.sin(dir) * k.speed;
      k.vz = Math.cos(dir) * k.speed;
      if (!k.dead && k.speed > 0.5) {
        if (Math.abs(w) < 0.05) {
          k.x += k.vx * lead;
          k.z += k.vz * lead;
        } else {
          const v = k.speed / w;
          k.x += v * (Math.cos(dir) - Math.cos(dir + w * lead));
          k.z += v * (Math.sin(dir + w * lead) - Math.sin(dir));
          k.heading += w * lead;
        }
      }
      const fl = c[10];
      k.drifting = (fl & 1) !== 0;
      k.driftDir = fl & 8 ? 1 : -1;
      k.netFire = (fl & 4) !== 0;
      k.hop = (fl & 16) !== 0;
      k.boostT = c[11];
      k.miniT = c[12];
      k.padT = c[13];
      k.maxHp = c[15];
      if (c[14] < k.hp) k.sinceDamage = 0;
      k.hp = c[14];
      k.idx = c[16];
      k.prog = c[17];
      k.progFine = c[18];
      k.lapCount = c[19];
      k.invulnT = c[20];
      k.yawRate = c[21];
      const dead = (fl & 2) !== 0;
      if (k.dead && !dead) {
        k.dead = false;
        this.buf.set(k.netId, [B]);
        race.events.push({ t: 'respawn', k });
      } else if (!k.dead && dead) {
        k.dead = true;
      }
    }
  }

  /** 每幀在 race.step 之後：送出自己控制的車的狀態 */
  sendState(now: number): void {
    const race = this.race;
    if (!race || now - this.lastSend < SEND_MS) return;
    this.lastSend = now;
    const ks: Pack[] = [];
    for (const k of race.karts) if (!k.remote && !k.out) ks.push(pack(k));
    const h: number[][] = [];
    for (const [key, amt] of this.hits) {
      const [v, by] = key.split(':').map(Number);
      h.push([v, by, Math.round(amt * 10) / 10]);
    }
    this.hits.clear();
    this.client.relay(h.length ? { e: 's', k: ks, h } : { e: 's', k: ks });
  }
}
