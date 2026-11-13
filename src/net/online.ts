import type { DifficultyId } from '../game/difficulty';
import type { Kart } from '../game/kart';
import type { NetRacer, OnlineSetup, SecParams } from '../game/net';
import type { Race, RaceMode } from '../game/race';
import { clamp, lerp, lerpAngle } from '../game/util';
import { Mesh, type RtcSignal } from './mesh';
import { decodeStates, encodeStates, type Pack } from './pack';
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

/** 狀態同步：每秒 20 次；遠端的車晚 110 毫秒顯示（在兩筆資料之間內插），再沿弧線外推回「現在」 */
const SEND_MS = 50;
const DELAY_MS = 110;
/** 每 2 秒量一次跟每個人的延遲（走實際使用的路徑：直連或伺服器） */
const PING_MS = 2000;

interface Snap { t: number; a: Pack }

/** 跟一位玩家之間的連線狀況（介面顯示用） */
export interface LinkInfo { direct: boolean; rtt: number; away: boolean }

/**
 * 一次連線：房間名單、房主設定，比賽中同步每台車的狀態與事件。
 * 架構：每個人自己的車在自己的電腦上跑物理、判定自己有沒有被打中（不會有「明明閃過還被打到」）；
 * 電腦車手由房主的電腦控制；副武器發射時把參數傳給大家，讓每個畫面生出一樣的砲彈。
 * 傳輸：能直連（WebRTC）的人之間直接傳，其他走 Cloudflare 伺服器中轉；狀態用二進位封包。
 */
export class OnlineSession {
  client = new RoomClient();
  mesh: Mesh;
  code = '';
  me = 0;
  hostPid = 0;
  /** 自己連進的 Cloudflare 機房（TPE、HKG、LAX…） */
  colo = '';
  /** 房間裡的人（包含自己），照玩家編號排序 */
  peers = new Map<number, NetRacer>();
  /** 暫時斷線（伺服器還替他保留座位）的人 */
  away = new Set<number>();
  cfg: RoomConfig;
  status: 'connecting' | 'lobby' | 'racing' | 'closed' = 'connecting';
  onChange: () => void = () => {};
  /** 只有連線狀況（延遲、直連）變了：介面只更新小字，不重畫整頁 */
  onLinks: () => void = () => {};
  onStart: (s: StartMsg) => void = () => {};
  onClosed: (code: string) => void = () => {};
  private info: () => Omit<NetRacer, 'pid'>;
  private race: Race | null = null;
  private buf = new Map<number, Snap[]>();
  private hits = new Map<string, number>();
  private lastSend = 0;
  private rtt = new Map<number, number>();
  private pingTimer = 0;

  constructor(info: () => Omit<NetRacer, 'pid'>, cfg: RoomConfig) {
    this.info = info;
    this.cfg = cfg;
    this.mesh = new Mesh(this.client, () => this.me, (from, d) => this.relayed(from, d as { e: string }), (from, b) => this.states(from, b));
    this.mesh.onStatus = () => this.onLinks();
    this.client.onMsg = (m) => this.handle(m);
    this.client.onBinary = (from, b) => this.states(from, b);
    this.client.onReconnecting = () => {
      this.mesh.dropAll();
      this.onChange();
    };
    this.client.onClose = (code) => {
      this.status = 'closed';
      this.stopPing();
      this.mesh.dropAll();
      this.onClosed(code);
    };
  }

  get isHost(): boolean {
    return this.me !== 0 && this.me === this.hostPid;
  }

  get reconnecting(): boolean {
    return this.client.reconnecting;
  }

  get list(): NetRacer[] {
    return [...this.peers.values()].sort((a, b) => a.pid - b.pid);
  }

  /** 其他在線的人 */
  private others(): number[] {
    const out: number[] = [];
    for (const pid of this.peers.keys()) if (pid !== this.me && !this.away.has(pid)) out.push(pid);
    return out;
  }

  link(pid: number): LinkInfo {
    return { direct: this.mesh.direct(pid), rtt: this.rtt.get(pid) ?? 0, away: this.away.has(pid) };
  }

  /** 跟這台車的車主之間的延遲（電腦車手看房主） */
  private ownerRtt(k: Kart): number {
    const pid = k.owner || this.hostPid;
    return this.rtt.get(pid) ?? this.client.rtt;
  }

  open(code: string, create: boolean): void {
    this.code = code;
    this.status = 'connecting';
    this.client.connect(code, create, this.info());
  }

  leave(): void {
    this.stopPing();
    this.mesh.dropAll();
    this.client.close();
    this.status = 'closed';
    this.race = null;
  }

  /** 換了車或武器：告訴房間裡的人 */
  refreshInfo(): void {
    const me = this.peers.get(this.me);
    if (!me) return;
    Object.assign(me, this.info());
    this.client.setInfo(this.info());
    this.client.send({ t: 'hi', info: this.info() });
    this.onChange();
  }

  private send(d: unknown, to?: number[]): void {
    this.mesh.sendJson(d, this.others(), to);
  }

  setCfg(c: Partial<RoomConfig>): void {
    if (!this.isHost) return;
    Object.assign(this.cfg, c);
    this.send({ e: 'cfg', cfg: this.cfg });
    this.onChange();
  }

  /** 房主按開始 */
  start(): void {
    if (!this.isHost) return;
    const msg: StartMsg = { cfg: { ...this.cfg }, seed: Math.floor(Math.random() * 2 ** 31), racers: this.list.filter((p) => !this.away.has(p.pid)) };
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

  private startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = window.setInterval(() => {
      const now = performance.now();
      for (const pid of this.others()) this.send({ e: 'pi', t: now }, [pid]);
    }, PING_MS);
  }

  private stopPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  /** 房主換人：新房主接手電腦車手，舊房主（回來了）放手 */
  private hostChanged(): void {
    const r = this.race;
    if (!r?.net) return;
    r.net.host = this.isHost;
    if (this.isHost) r.takeOverAI();
    else r.releaseAI();
  }

  private handle(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        // 重連後拿到不同的座位（太久沒回來，座位被收走了）：比賽中就當作斷線
        if (this.me !== 0 && m.pid !== this.me && this.race) {
          this.leave();
          this.onClosed('closed');
          return;
        }
        this.me = m.pid;
        this.hostPid = m.host;
        this.colo = m.colo ?? '';
        const mine = this.peers.get(m.pid);
        this.peers.clear();
        this.away.clear();
        this.peers.set(m.pid, mine ?? { ...this.info(), pid: m.pid });
        for (const p of m.peers) {
          if (!p.info) continue;
          this.peers.set(p.pid, { ...(p.info as NetRacer), pid: p.pid });
          if (p.away) this.away.add(p.pid);
          this.mesh.ensure(p.pid);
        }
        if (this.status !== 'racing') this.status = 'lobby';
        this.hostChanged();
        this.startPing();
        this.onChange();
        break;
      }
      case 'join':
      case 'back':
      case 'info':
        this.peers.set(m.pid, { ...(m.info as NetRacer), pid: m.pid });
        this.away.delete(m.pid);
        if (m.t !== 'info') {
          // 重連回來的人：舊的直連已經不能用，重新建立
          if (m.t === 'back') this.mesh.drop(m.pid);
          this.mesh.ensure(m.pid);
          // 新來的人要知道房主目前的設定
          if (this.isHost) this.send({ e: 'cfg', cfg: this.cfg }, [m.pid]);
        }
        this.onChange();
        break;
      case 'away':
        this.away.add(m.pid);
        this.mesh.drop(m.pid);
        this.onChange();
        break;
      case 'leave':
        this.peers.delete(m.pid);
        this.away.delete(m.pid);
        this.rtt.delete(m.pid);
        this.mesh.drop(m.pid);
        if (this.race) for (const k of this.race.karts) if (k.owner === m.pid && k.remote) this.race.dropKart(k);
        this.onChange();
        break;
      case 'host':
        this.hostPid = m.pid;
        this.hostChanged();
        this.onChange();
        break;
      case 'start':
        this.onStart(m.d as StartMsg);
        break;
      case 'lobby':
        this.onChange();
        break;
      case 'r': {
        const d = m.d as { e?: string };
        if (d && d.e === 'rtc') void this.mesh.signal(m.from, d as RtcSignal);
        else this.relayed(m.from, d as { e: string });
        break;
      }
    }
  }

  /** 這台車的資料只接受車主（電腦車手只接受房主）傳來的 */
  private owns(from: number, k: Kart | undefined): k is Kart {
    return !!k && k.remote && (k.owner !== 0 ? k.owner === from : from === this.hostPid);
  }

  private relayed(from: number, d: { e: string } & Record<string, unknown>): void {
    if (!d || typeof d.e !== 'string') return;
    switch (d.e) {
      case 'pi':
        this.send({ e: 'po', t: d.t }, [from]);
        return;
      case 'po': {
        const rtt = performance.now() - (d.t as number);
        const old = this.rtt.get(from);
        this.rtt.set(from, old === undefined ? rtt : old * 0.6 + rtt * 0.4);
        this.onLinks();
        return;
      }
      case 'cfg':
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

  /** 收到二進位的車輛狀態（直連或伺服器轉來） */
  private states(from: number, data: ArrayBuffer): void {
    const race = this.race;
    if (!race) return;
    const p = decodeStates(data);
    if (!p) return;
    const now = performance.now();
    const K = race.karts;
    for (const a of p.karts) {
      const k = K[a[0]];
      if (!this.owns(from, k)) continue;
      const b = this.buf.get(k.netId) ?? [];
      b.push({ t: now, a });
      if (b.length > 8) b.shift();
      this.buf.set(k.netId, b);
    }
    for (const [v, by, amt] of p.hits) if (K[v] && K[by]) race.remoteDamage(K[v], K[by], amt);
  }

  /** 比賽開始：接上 Race 的連線掛勾 */
  attach(race: Race): void {
    this.race = race;
    this.buf.clear();
    this.hits.clear();
    this.status = 'racing';
    race.net = {
      host: this.isHost,
      onSecondary: (k, p) => this.send({ e: 'sec', k: k.netId, p }),
      onDamage: (v, by, amount) => {
        if (!by) return;
        const key = v.netId + ':' + by.netId;
        this.hits.set(key, (this.hits.get(key) ?? 0) + amount);
      },
      onKill: (v, by) => this.send({ e: 'kill', v: v.netId, by: by ? by.netId : -1 }),
      onFinish: (k) => this.send({ e: 'fin', k: k.netId, time: k.finishTime, laps: k.lapTimes }),
      onElim: (k) => this.send({ e: 'elim', k: k.netId }),
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
      const lead = Math.min(0.35, DELAY_MS / 1000 + this.ownerRtt(k) / 2000 + late);
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

  /** 每幀在 race.step 之後：送出自己控制的車的狀態（二進位） */
  sendState(now: number): void {
    const race = this.race;
    if (!race || now - this.lastSend < SEND_MS) return;
    this.lastSend = now;
    const ks: Kart[] = [];
    for (const k of race.karts) if (!k.remote && !k.out) ks.push(k);
    const h: [number, number, number][] = [];
    for (const [key, amt] of this.hits) {
      const [v, by] = key.split(':').map(Number);
      h.push([v, by, amt]);
    }
    this.hits.clear();
    const peers = this.others();
    if (peers.length) this.mesh.sendBin(encodeStates(ks, h), peers);
  }
}
