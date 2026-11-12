import { AIController } from './ai';
import { CAR_IDS, CARS } from './cars';
import { CFG } from './config';
import { Kart, type KartEvent, type KartInput } from './kart';
import { pickMissions, type Mission } from './missions';
import type { Profile } from './save';
import type { HazardDef, Track } from './track';
import { clamp, mulberry32, wrapAngle } from './util';
import { BURN_DPS, BURN_TIME, lvl3Mul, PERK_LVL5, PRIMARY, PRIMARY_IDS, SECONDARY, SECONDARY_IDS, weaponLvlMul, type PrimaryDef, type SecondaryId } from './weapons';
import { DIFFICULTY } from './difficulty';

export type RaceMode = 'race' | 'elim';

/** pierce > 0 表示穿甲彈，打中後還能繼續飛；skip 是剛被打穿的那台車 */
export interface Bullet { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; dmg: number; owner: Kart; pierce: number; skip: Kart | null; idx: number }
/** 火箭與追蹤導彈：homing 為 true 時會轉向 target */
export interface Missile {
  x: number; y: number; z: number; a: number; idx: number; speed: number; life: number; dmg: number; radius: number; owner: Kart;
  homing: boolean; target: Kart | null; age: number;
}
/** y 為離地高度，gy 為砲彈下方的路面高度 */
export interface Shell { x: number; y: number; z: number; gy: number; idx: number; vx: number; vy: number; vz: number; dmg: number; radius: number; owner: Kart; /** 子母彈彈出的小榴彈 */ sub: boolean }
/** 爆炸桶：respawnT > 0 表示已引爆等待重生；fuse > 0 表示被旁邊的爆炸波及、即將連鎖引爆 */
export interface Barrel { x: number; y: number; z: number; respawnT: number; fuse: number; by: Kart | null }
/**
 * 地雷：armT 倒數完才會被觸發（放的人自己不會觸發）。
 * 集束圓雷的 life 倒數到 0 會自己引爆；一般地雷到時間就失效。
 */
export interface Mine {
  x: number; y: number; z: number; vx: number; vz: number; idx: number; owner: Kart; by: Kart;
  kind: 'mine' | 'cluster'; armT: number; life: number; fuse: number; dmg: number; radius: number; trigger: number; dead: boolean;
}
/** 滾石：沿賽道往前滾，d 是在賽道上的距離 */
export interface Boulder {
  d: number; lat: number; lat0: number; lat1: number; x: number; y: number; z: number; v: number; r: number; hp: number;
  enterT: number; roll: number; end: number; dead: boolean;
}
/** 機關的即時狀態（畫面依這些值擺放模型） */
export interface HazardState {
  def: HazardDef;
  /** 機關所在位置的主線座標 */
  x: number; y: number; z: number; tx: number; tz: number; nx: number; nz: number;
  /** 鐵鎚：擺角、鎚頭的橫向位置與離地高度、橫向速度 */
  theta: number; lat: number; hy: number; vlat: number;
  /** 電車：中心的橫向位置、方向、是否正在警示、是否正在通過 */
  c: number; dir: number; warn: boolean; moving: boolean;
  /** 滾石：距離下一顆的秒數 */
  spawnT: number;
  cycle: number;
}

export type HitWeapon = 'gun' | 'flame' | 'laser';

export type RaceEvent =
  | { t: 'shot'; k: Kart; x: number; y: number; z: number; side: number }
  | { t: 'hit'; k: Kart; by: Kart; x: number; y: number; z: number; w: HitWeapon }
  | { t: 'dmg'; k: Kart; by: Kart | null; amount: number; fatal: boolean }
  | { t: 'impact'; x: number; y: number; z: number }
  | { t: 'blast'; x: number; y: number; z: number; r: number; gy: number; kart: boolean }
  | { t: 'kill'; killer: Kart | null; victim: Kart; streak: number }
  | { t: 'launch'; k: Kart; kind: SecondaryId }
  | { t: 'lock'; k: Kart; by: Kart }
  | { t: 'hazard'; k: Kart; kind: HazardDef['kind']; x: number; y: number; z: number }
  | { t: 'rock'; x: number; y: number; z: number; r: number }
  | { t: 'tram'; x: number; y: number; z: number }
  | { t: 'shortcut'; k: Kart }
  | { t: 'kart'; k: Kart; e: KartEvent }
  | { t: 'lap'; k: Kart; lap: number; time: number }
  | { t: 'finish'; k: Kart }
  | { t: 'respawn'; k: Kart }
  | { t: 'ram'; a: Kart; b: Kart; x: number; y: number; z: number; power: number }
  | { t: 'start'; k: Kart }
  | { t: 'elim'; k: Kart }
  | { t: 'count'; n: number }
  | { t: 'go' };

const AI_NAMES = ['閃電凱', '火球妮', '鐵頭', '小旋風', '爆米花', '夜貓', '轟隆隆'];
const AI_COLORS = [0xff4d5a, 0xff9f1c, 0x35c46a, 0x29b6f6, 0xb05cff, 0xff7ac8, 0xa8b4c4];
export const PLAYER_COLOR = 0xffd400;

const SHELL_GRAVITY = 28;
const SHELL_VY = 13;
/** 追蹤導彈的轉向速度（弧度／秒）：比急轉彎的車慢，所以甩得掉 */
const HOMING_TURN = 2.3;
const MAX_MINES = 3;
const MAX_MINES_PERK = 5;

// 機關的尺寸與威力
export const HAMMER = { pivot: 11, arm: 9.5, amp: 1.15, headR: 1.3, headHalf: 1.8, dmg: 22 };
export const TRAM = { half: 8, width: 1.6, speed: 24, warn: 2.5, reach: 38, dmg: 40 };
export const BOULDER = { r: 2.2, hp: 50, dmg: 28, enter: 0.9 };

/** 一場比賽的完整模擬。不依賴畫面，之後連線對戰可直接由主機端跑這份。 */
export class Race {
  track: Track;
  mode: RaceMode;
  karts: Kart[] = [];
  player: Kart;
  ais = new Map<Kart, AIController>();
  bullets: Bullet[] = [];
  missiles: Missile[] = [];
  shells: Shell[] = [];
  barrels: Barrel[] = [];
  mines: Mine[] = [];
  boulders: Boulder[] = [];
  hazards: HazardState[] = [];
  missions: Mission[];
  events: RaceEvent[] = [];
  state: 'countdown' | 'racing' | 'finished' = 'countdown';
  countdown = 3.4;
  time = 0;
  /** 包含倒數在內的時鐘（機關照這個動） */
  clock = 0;
  /** 淘汰賽：距離下一次淘汰的秒數 */
  elimT = CFG.elimFirst;
  /** 測試用：玩家也交給 AI 開 */
  autoPlayer = false;
  private lastCount = 4;
  private outCount = 0;
  /** 第一台車完賽的時間；之後再過一段時間還沒跑完的直接依進度排名 */
  private firstFinishT = -1;
  private rng: () => number;

  constructor(track: Track, profile: Profile, mode: RaceMode = 'race', seed = (Date.now() & 0x7fffffff)) {
    this.track = track;
    this.mode = mode;
    const rng = (this.rng = mulberry32(seed));
    const total = CFG.racers;
    const D = DIFFICULTY[profile.difficulty ?? 'normal'];
    let player!: Kart;
    for (let j = 0; j < total; j++) {
      const isP = j === total - 1;
      const k = new Kart(j, isP ? '你' : AI_NAMES[j % AI_NAMES.length], isP ? PLAYER_COLOR : AI_COLORS[j % AI_COLORS.length]);
      const row = Math.floor(j / 2);
      const side = j % 2 === 0 ? 1 : -1;
      const back = Math.round((9 + row * 8 + (j % 2) * 3) / track.spacing);
      const idx = track.wrap(-back);
      const s = track.samples[idx];
      k.x = s.x + s.nx * side * 4.5;
      k.z = s.z + s.nz * side * 4.5;
      k.y = s.y;
      k.heading = Math.atan2(s.tx, s.tz);
      k.idx = idx;
      k.prog = -back;
      k.progFine = -back;
      k.lat = side * 4.5;
      if (isP) {
        k.isPlayer = true;
        k.car = profile.kart;
        k.primary = profile.primary;
        k.secondary = profile.secondary;
        k.primaryLvl = profile.lvl[profile.primary];
        k.secondaryLvl = profile.lvl[profile.secondary];
        this.ais.set(k, new AIController(rng, 1, D));
        player = k;
      } else {
        k.aiAssist = true;
        k.car = CAR_IDS[Math.floor(rng() * CAR_IDS.length)];
        k.primary = PRIMARY_IDS[Math.floor(rng() * PRIMARY_IDS.length)];
        k.secondary = SECONDARY_IDS[Math.floor(rng() * SECONDARY_IDS.length)];
        k.dmgMul = D.dmg;
        k.aiTurn = D.turn;
        k.aiGauge = D.gauge;
        // 電腦的武器等級隨難度提高（困難時常常帶著 Lv.5 特性）
        k.primaryLvl = D.lvl[0] + Math.floor(rng() * (D.lvl[1] - D.lvl[0] + 1));
        k.secondaryLvl = D.lvl[0] + Math.floor(rng() * (D.lvl[1] - D.lvl[0] + 1));
        const skill = D.skill[0] + (D.skill[1] - D.skill[0]) * (1 - j / Math.max(1, total - 2));
        this.ais.set(k, new AIController(rng, skill, D));
      }
      // 車款係數（玩家再疊上車庫的升級）
      const car = CARS[k.car];
      const eng = isP ? profile.car.engine : 0;
      k.maxSpeedMul = car.speed * (1 + 0.015 * eng);
      k.accelMul = car.accel * (1 + 0.03 * eng);
      k.boostTimeAdd = car.boostTime + (isP ? 0.2 * profile.car.n2o : 0);
      k.maxHp = CFG.hp + car.hp + (isP ? 12 * profile.car.armor : 0);
      k.hp = k.maxHp;
      k.gaugeMul = car.gauge;
      k.handling = car.handling;
      k.ramMul = car.ram;
      k.mass = car.mass;
      k.spareN2O = !!car.spareN2O;
      k.miniMul = car.miniMul ?? 1;
      k.draftMul = car.draftMul ?? 1;
      k.blastMul = car.blastMul ?? 1;
      k.afterburn = !!car.afterburn;
      // 花色：玩家用車庫選的，電腦隨機
      k.livery = isP ? (profile.livery?.[k.car] ?? 0) : Math.floor(rng() * car.liveries.length);
      this.ais.get(k)!.baseSpeedMul = k.maxSpeedMul;
      this.karts.push(k);
    }
    this.player = player;

    // 爆炸桶
    for (const b of track.def.barrels) {
      const s = track.samples[track.wrap(Math.round(b.dist / track.spacing))];
      this.barrels.push({ x: s.x + s.nx * b.lat, y: s.y, z: s.z + s.nz * b.lat, respawnT: 0, fuse: 0, by: null });
    }
    // 機關
    for (const def of track.def.hazards ?? []) {
      const p = track.pointAt(def.dist);
      this.hazards.push({
        def, x: p.x, y: p.y, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz,
        theta: 0, lat: 0, hy: HAMMER.pivot - HAMMER.arm, vlat: 0,
        c: -TRAM.reach, dir: 1, warn: false, moving: false,
        spawnT: 1 + rng() * def.period, cycle: -1,
      });
    }
    this.updateHazards(0);
    this.missions = pickMissions(rng, mode);
  }

  step(dt: number, pin: KartInput): void {
    const ev = this.events;
    const track = this.track;
    const n = track.n;
    this.clock += dt;

    if (this.state === 'countdown') {
      this.countdown -= dt;
      for (const k of this.karts) {
        if (k.isPlayer && !this.autoPlayer) k.preStart(pin, this.countdown);
      }
      const c = Math.ceil(this.countdown);
      if (c < this.lastCount && c > 0 && c <= 3) {
        this.lastCount = c;
        ev.push({ t: 'count', n: c });
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        ev.push({ t: 'go' });
        // 起跑衝刺：玩家要抓準時機按油門；電腦車手隨機成功
        for (const k of this.karts) {
          const ok = k.isPlayer && !this.autoPlayer ? k.launchT > 0 && k.launchT <= CFG.startWindow : this.rng() < 0.3;
          if (ok) {
            k.padT = CFG.startBoostTime;
            k.stats.perfectStart = true;
            ev.push({ t: 'start', k });
          }
        }
      }
    } else {
      this.time += dt;
    }
    const racing = this.state !== 'countdown';

    for (const k of this.karts) {
      if (k.out) continue;
      const ai = this.ais.get(k)!;
      const useAI = !k.isPlayer || k.finished || this.autoPlayer;
      if (!k.isPlayer) ai.rubberBand(k, this.player, this);
      k.firing = Math.max(0, k.firing - dt);
      k.lockT = Math.max(0, k.lockT - dt);
      k.hazardCd = Math.max(0, k.hazardCd - dt);
      if (k.dead) {
        k.respawnT -= dt;
        if (k.respawnT <= 0) {
          this.resetToTrack(k);
          k.dead = false;
          k.hp = k.maxHp;
          k.invulnT = CFG.invulnTime;
          // 重生時武器狀態歸零，連續擊毀也重新計算
          k.streak = 0;
          k.secCd = 0;
          k.heat = 0;
          k.overheated = false;
          k.burnT = 0;
          if (k.spareN2O) k.n2o = Math.max(k.n2o, 1);
          ev.push({ t: 'respawn', k });
        }
        continue;
      }
      if (!k.finished) k.invulnT = Math.max(0, k.invulnT - dt);
      k.sinceDamage += dt;
      if (k.sinceDamage > CFG.regenDelay && k.hp < k.maxHp) k.hp = Math.min(k.maxHp, k.hp + CFG.regenRate * dt);
      // 燃燒：持續扣血，算在點火的人頭上
      if (k.burnT > 0) {
        k.burnT -= dt;
        this.damage(k, BURN_DPS * dt, k.burnBy, true);
        if (k.dead) continue;
      }
      if (!racing) continue;

      const inp = useAI ? ai.think(k, this, dt) : pin;
      const prevIdx = k.idx;
      const wasBranch = k.branch;
      k.update(dt, inp, track, (e) => ev.push({ t: 'kart', k, e }));
      if (k.branch && !wasBranch) {
        if (!k.finished) k.stats.shortcuts++;
        ev.push({ t: 'shortcut', k });
      }

      // 進度與圈數
      let d = k.idx - prevIdx;
      if (d > n / 2) d -= n;
      else if (d < -n / 2) d += n;
      k.prog += d;
      if (k.branch) {
        k.progFine = k.prog + k.branchFrac;
      } else {
        const sp = track.samples[k.idx];
        k.progFine = k.prog + ((k.x - sp.x) * sp.tx + (k.z - sp.z) * sp.tz) / track.spacing;
      }
      const lc = Math.floor(k.prog / n);
      if (lc > k.lapCount && !k.finished) {
        if (k.lapCount >= 0) {
          const lt = this.time - k.lapStart;
          k.lapTimes.push(lt);
          ev.push({ t: 'lap', k, lap: lc, time: lt });
        }
        k.lapCount = lc;
        k.lapStart = this.time;
        if (this.mode === 'race' && lc >= track.laps && !k.finished) this.finish(k);
      }
      const sm = k.surface(track);
      if (k.vx * sm.tx + k.vz * sm.tz < -3) k.wrongWayT += dt;
      else k.wrongWayT = 0;

      if (!k.finished) this.updateWeapons(k, inp, dt);
    }

    this.updateHazards(dt);
    if (racing) {
      this.collideKarts();
      this.updateDraft(dt);
      this.updateBarrels(dt);
      this.updateBullets(dt);
      this.updateMissiles(dt);
      this.updateShells(dt);
      this.updateMines(dt);
      this.updateBoulders(dt);
      if (this.mode === 'elim' && this.state === 'racing') this.updateElimination(dt);
    }
    // 第一台完賽後 30 秒還沒跑完的，直接依目前進度排名（避免比賽永遠不結束）
    if (this.mode === 'race' && this.firstFinishT >= 0 && this.time > this.firstFinishT + 30) {
      const rest = this.karts.filter((k) => !k.finished).sort((a, b) => b.progFine - a.progFine);
      rest.forEach((k, i) => {
        this.finish(k);
        k.finishTime = this.time + i * 0.01;
      });
    }
    this.updateRanks();
    if (this.state === 'racing' && this.player.finished) this.state = 'finished';
  }

  private finish(k: Kart): void {
    k.finished = true;
    k.finishTime = this.time;
    k.aiAssist = true;
    k.drifting = false;
    k.invulnT = 1e9;
    k.burnT = 0;
    if (this.firstFinishT < 0) this.firstFinishT = this.time;
    this.events.push({ t: 'finish', k });
  }

  /** 找車頭前方圓錐內最近的車。只給 AI 判斷開火時機用，武器本身不會自動瞄準 */
  pickTarget(k: Kart, cone: number, range: number, minDist = 2, back = false): Kart | null {
    let best: Kart | null = null;
    let bs = Infinity;
    const dir = k.heading + (back ? Math.PI : 0);
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - k.x, dz = o.z - k.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < minDist) continue;
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - dir));
      if (ang > cone) continue;
      const score = d * (1 + (ang / cone) * 1.5);
      if (score < bs) { bs = score; best = o; }
    }
    return best;
  }

  resetToTrack(k: Kart): void {
    const s = this.track.samples[k.idx];
    k.branch = null;
    k.x = s.x;
    k.z = s.z;
    k.y = s.y;
    k.lat = 0;
    k.heading = Math.atan2(s.tx, s.tz);
    k.vx = k.vz = 0;
    k.speed = 0;
    k.slip = 0;
    k.air = 0;
    k.vy = 0;
    k.drifting = false;
    k.boostT = 0;
    k.miniT = 0;
    k.padT = 0;
  }

  /** dot = true 表示持續傷害（燃燒），不算進「打中人集氣」 */
  damage(v: Kart, amount: number, attacker: Kart | null, dot = false): void {
    if (v.dead || v.out || v.invulnT > 0 || this.state === 'countdown' || amount <= 0) return;
    v.hp -= amount;
    v.sinceDamage = 0;
    // 給 HUD 顯示傷害數字（只有跟玩家有關的才需要）
    if (v.isPlayer || (attacker && attacker.isPlayer)) this.events.push({ t: 'dmg', k: v, by: attacker, amount, fatal: v.hp <= 0 });
    if (attacker && attacker !== v) {
      attacker.stats.damage += amount;
      // 打中人也會集氣
      if (!dot) attacker.addGauge(amount * CFG.gaugePerDamage, (e) => this.events.push({ t: 'kart', k: attacker, e }));
    }
    if (v.hp <= 0) this.destroy(v, attacker);
  }

  private destroy(v: Kart, attacker: Kart | null): void {
    v.hp = 0;
    v.dead = true;
    v.deaths++;
    v.streak = 0;
    v.respawnT = CFG.respawnTime;
    v.drifting = false;
    v.boostT = 0;
    v.spinVel = 0;
    v.tumble = 0;
    v.burnT = 0;
    const gy = v.y - v.air;
    v.air = 0;
    v.vy = 0;
    v.vx = v.vz = 0;
    v.speed = 0;
    let streak = 0;
    if (attacker && attacker !== v) {
      attacker.kills++;
      attacker.streak++;
      attacker.stats.bestStreak = Math.max(attacker.stats.bestStreak, attacker.streak);
      streak = attacker.streak;
      // 擊毀獎勵：直接送一瓶 N2O
      if (attacker.n2o < CFG.maxN2O) attacker.n2o++;
      else attacker.gauge = 1;
    }
    this.events.push({ t: 'blast', x: v.x, y: v.y + 1, z: v.z, r: 8, gy, kart: true });
    this.events.push({ t: 'kill', killer: attacker, victim: v, streak });
  }

  /** 把車撞飛：往 (dx,dz) 方向推、離地、翻滾 */
  private knock(k: Kart, dx: number, dz: number, push: number, lift: number): void {
    if (k.dead || k.invulnT > 0) return;
    push *= k.blastMul;
    lift *= 0.4 + 0.6 * k.blastMul;
    k.vx = k.vx * 0.5 + dx * push;
    k.vz = k.vz * 0.5 + dz * push;
    if (k.air <= 0) k.jumped = false;
    k.air = Math.max(k.air, 0.05);
    k.vy = Math.max(k.vy, lift);
    k.spinVel += (this.rng() - 0.5) * 6;
    k.tumble = (this.rng() > 0.5 ? 1 : -1) * 6;
    k.drifting = false;
  }

  /** owner 為 null 表示沒有人該被算擊毀（例如自己撞到爆炸桶），這時所有人都會受傷 */
  explodeAt(x: number, y: number, z: number, gy: number, radius: number, dmg: number, owner: Kart | null): void {
    this.events.push({ t: 'blast', x, y, z, r: radius, gy, kart: false });
    for (const k of this.karts) {
      if (k === owner || k.dead || k.out) continue;
      const dx = k.x - x, dz = k.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius + 1.2) continue;
      const f = clamp(1 - 0.6 * (d / radius), 0.3, 1);
      const immune = k.invulnT > 0;
      this.damage(k, dmg * f, owner);
      if (!k.dead && !immune) {
        // 衝擊波：往外推、炸離地面、打轉
        const inv = d > 0.01 ? 1 / d : 0;
        const bm = k.blastMul;
        k.vx = k.vx * 0.7 + dx * inv * 9 * f * bm;
        k.vz = k.vz * 0.7 + dz * inv * 9 * f * bm;
        if (k.air <= 0) k.jumped = false;
        k.air = Math.max(k.air, 0.05);
        k.vy = Math.max(k.vy, CFG.blastLift * (0.45 + 0.55 * f) * (0.4 + 0.6 * bm));
        k.spinVel += (this.rng() - 0.5) * 5 * f;
        k.tumble = (this.rng() > 0.5 ? 1 : -1) * (4 + 5 * f);
        k.drifting = false;
      }
    }
    const r2 = (radius + 1.5) * (radius + 1.5);
    // 波及附近的爆炸桶與地雷：延遲一點點引爆，形成連鎖
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < r2) {
        b.fuse = 0.12 + this.rng() * 0.1;
        b.by = owner;
      }
    }
    for (const m of this.mines) {
      if (m.dead || m.fuse > 0) continue;
      const dx = m.x - x, dz = m.z - z;
      if (dx * dx + dz * dz < r2) {
        m.fuse = 0.1 + this.rng() * 0.12;
        if (owner) m.by = owner;
      }
    }
    for (const b of this.boulders) {
      if (b.dead) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (radius + b.r) * (radius + b.r)) this.hurtBoulder(b, dmg, owner);
    }
  }

  /** 名次排序：競速看完賽時間與進度；淘汰賽被淘汰的排在後面（越晚淘汰名次越好） */
  results(): Kart[] {
    return [...this.karts].sort((a, b) => {
      if (a.out !== b.out) return a.out ? 1 : -1;
      if (a.out && b.out) return b.outOrder - a.outOrder;
      if (this.mode === 'race') {
        if (a.finished && b.finished) return a.finishTime - b.finishTime || b.progFine - a.progFine;
        if (a.finished) return -1;
        if (b.finished) return 1;
      }
      return b.progFine - a.progFine;
    });
  }

  /** 淘汰賽：仍在場上的車數 */
  get aliveCount(): number {
    let c = 0;
    for (const k of this.karts) if (!k.out) c++;
    return c;
  }

  // ------------------------------------------------------------------

  private updateRanks(): void {
    const order = this.results();
    for (let i = 0; i < order.length; i++) order[i].rank = i + 1;
  }

  private updateElimination(dt: number): void {
    this.elimT -= dt;
    if (this.elimT > 0) return;
    this.elimT = CFG.elimInterval;
    const order = this.results().filter((k) => !k.out);
    const victim = order[order.length - 1];
    if (!victim) return;
    victim.out = true;
    victim.outOrder = ++this.outCount;
    victim.dead = true;
    victim.speed = 0;
    victim.vx = victim.vz = 0;
    victim.burnT = 0;
    const gy = victim.y - victim.air;
    victim.air = 0;
    victim.vy = 0;
    this.events.push({ t: 'blast', x: victim.x, y: gy + 1, z: victim.z, r: 9, gy, kart: true });
    this.events.push({ t: 'elim', k: victim });
    const p = this.player;
    if (victim === p) {
      p.finished = true;
      p.finishTime = this.time;
    } else if (order.length === 2 && order[0] === p) {
      this.finish(p); // 只剩玩家：獲勝
    }
  }

  private updateDraft(dt: number): void {
    const C = CFG;
    for (const k of this.karts) {
      let inWake = false;
      if (!k.dead && !k.out && k.speed > 14 && k.air <= 0) {
        for (const o of this.karts) {
          if (o === k || o.dead || o.out || o.speed < 14) continue;
          const dx = o.x - k.x, dz = o.z - k.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < C.draftMin * C.draftMin || d2 > C.draftMax * C.draftMax) continue;
          if (Math.abs(wrapAngle(Math.atan2(dx, dz) - k.heading)) > C.draftCone) continue;
          if (Math.abs(wrapAngle(o.heading - k.heading)) > 0.5) continue;
          inWake = true;
          break;
        }
      }
      k.draftT = inWake ? Math.min(C.draftDelay + 0.6, k.draftT + dt) : Math.max(0, k.draftT - dt * 2);
      k.drafting = k.draftT >= C.draftDelay;
    }
  }

  private detonate(b: Barrel, by: Kart | null): void {
    b.respawnT = CFG.barrelRespawn;
    b.fuse = 0;
    if (by) by.stats.barrels++;
    this.explodeAt(b.x, b.y + 1, b.z, b.y, CFG.barrelRadius, CFG.barrelDamage, by);
  }

  private updateBarrels(dt: number): void {
    for (const b of this.barrels) {
      if (b.respawnT > 0) {
        b.respawnT -= dt;
        continue;
      }
      if (b.fuse > 0) {
        b.fuse -= dt;
        if (b.fuse <= 0) this.detonate(b, b.by);
        continue;
      }
      // 被車撞到：沒有人得分，撞的人自己也會受傷
      for (const k of this.karts) {
        if (k.dead || k.out || k.air > 1.5) continue;
        const dx = k.x - b.x, dz = k.z - b.z;
        if (dx * dx + dz * dz < 4.4) {
          this.detonate(b, null);
          break;
        }
      }
    }
  }

  /** 打到爆炸桶、地雷或滾石：回傳 true 表示被擋下 */
  private hitObject(x: number, z: number, r: number, by: Kart, dmg: number): boolean {
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (r + 0.8) * (r + 0.8)) { this.detonate(b, by); return true; }
    }
    for (const m of this.mines) {
      if (m.dead || m.fuse > 0) continue;
      const dx = m.x - x, dz = m.z - z;
      if (dx * dx + dz * dz < (r + 0.5) * (r + 0.5)) { m.by = by; this.explodeMine(m); return true; }
    }
    for (const b of this.boulders) {
      if (b.dead || b.enterT > 0.45) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (r + b.r) * (r + b.r)) { this.hurtBoulder(b, dmg, by); return true; }
    }
    return false;
  }

  private updateWeapons(k: Kart, inp: KartInput, dt: number): void {
    const P = PRIMARY[k.primary];
    const top = k.primaryLvl >= PERK_LVL5;
    k.fireCd -= dt;
    const spinUp = top && k.primary === 'vulcan' ? 0.12 : P.spinUp;
    if (spinUp > 0) k.spin = clamp(k.spin + (inp.firePrimary && !k.overheated ? dt : -dt * 1.5) / spinUp, 0, 1);
    else k.spin = inp.firePrimary ? 1 : 0;
    const canFire = inp.firePrimary && !k.overheated && (spinUp <= 0 || k.spin >= 1);
    const heatMul = lvl3Mul(k.primaryLvl) * (top && k.primary === 'vulcan' ? 0.8 : 1);
    if (canFire) {
      let guard = 0;
      while (k.fireCd <= 0 && guard++ < 4) {
        this.firePrimary(k, P);
        k.fireCd += 1 / P.rate;
        k.heat += P.heat * heatMul;
      }
      if (P.kind !== 'gun') k.firing = 0.1;
    } else if (k.fireCd < 0) {
      k.fireCd = 0;
    }
    if (!inp.firePrimary || k.overheated) k.heat = Math.max(0, k.heat - 0.4 * dt);
    if (k.heat >= 1) { k.heat = 1; k.overheated = true; }
    if (k.overheated && k.heat < 0.35) k.overheated = false;

    k.secCd = Math.max(0, k.secCd - dt);
    if (inp.fireSecondary && k.secCd <= 0) {
      const S = SECONDARY[k.secondary];
      k.secCd = S.cooldown * lvl3Mul(k.secondaryLvl);
      switch (k.secondary) {
        case 'rocket': this.fireRocket(k); break;
        case 'grenade': this.fireShell(k); break;
        case 'mine': this.dropMine(k); break;
        case 'cluster': this.dropCluster(k); break;
        case 'missile': this.fireHoming(k); break;
      }
      this.events.push({ t: 'launch', k, kind: k.secondary });
    }
  }

  private secDmg(k: Kart): number {
    return SECONDARY[k.secondary].dmg * weaponLvlMul(k.secondaryLvl) * k.dmgMul;
  }

  /** 主武器：全部沿車頭方向（沒有輔助瞄準） */
  private firePrimary(k: Kart, P: PrimaryDef): void {
    const dmg = P.dmg * weaponLvlMul(k.primaryLvl) * k.dmgMul;
    if (P.kind === 'flame') return this.fireFlame(k, P, dmg);
    if (P.kind === 'laser') return this.fireLaser(k, P, dmg);
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const lx = fz, lz = -fx;
    k.gunSide = -k.gunSide;
    const ox = k.x + lx * 0.7 * k.gunSide + fx * 1.2;
    const oz = k.z + lz * 0.7 * k.gunSide + fz * 1.2;
    const oy = k.y + 0.95;
    for (let i = 0; i < P.pellets; i++) {
      const a = k.heading + (this.rng() * 2 - 1) * P.spread;
      const sp = CFG.bulletSpeed;
      this.bullets.push({
        x: ox, y: oy, z: oz,
        vx: Math.sin(a) * sp, vy: Math.tan(k.pitch) * sp, vz: Math.cos(a) * sp,
        life: P.range / sp, dmg, owner: k, idx: k.idx, pierce: k.primary === 'mg' && k.primaryLvl >= PERK_LVL5 ? 1 : 0, skip: null,
      });
    }
    this.events.push({ t: 'shot', k, x: ox, y: oy, z: oz, side: k.gunSide });
  }

  /** 火焰：車頭前方扇形範圍內的車、油桶、地雷、滾石都會被燒到 */
  private fireFlame(k: Kart, P: PrimaryDef, dmg: number): void {
    const h = k.heading;
    const top = k.primaryLvl >= PERK_LVL5;
    const range = P.range * (top ? 1.3 : 1);
    const inCone = (x: number, z: number, y: number, w: number): number => {
      const dx = x - k.x, dz = z - k.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.3 || Math.abs(y - k.y) > 2.6) return -1;
      if (dx * Math.sin(h) + dz * Math.cos(h) <= 0) return -1;
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - h));
      return ang <= P.spread + Math.atan2(w, d) ? d : -1;
    };
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const d = inCone(o.x, o.z, o.y, 1.1);
      if (d < 0) continue;
      this.damage(o, dmg * (1 - 0.4 * (d / range)), k);
      o.burnT = top ? 4 : BURN_TIME;
      o.burnBy = k;
      this.events.push({ t: 'hit', k: o, by: k, x: o.x, y: o.y + 0.9, z: o.z, w: 'flame' });
    }
    for (const b of this.barrels) if (b.respawnT <= 0 && b.fuse <= 0 && inCone(b.x, b.z, b.y, 0.8) >= 0) { b.fuse = 0.15; b.by = k; }
    for (const m of this.mines) if (!m.dead && m.fuse <= 0 && inCone(m.x, m.z, m.y, 0.5) >= 0) { m.fuse = 0.15; m.by = k; }
    for (const b of this.boulders) if (!b.dead && b.enterT <= 0.45 && inCone(b.x, b.z, b.y - b.r, b.r) >= 0) this.hurtBoulder(b, dmg, k);
  }

  /** 雷射：沿車頭方向的光束，打到第一個目標或離開路面就停住 */
  private fireLaser(k: Kart, P: PrimaryDef, dmg: number): void {
    const track = this.track;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const ox = k.x + fx * 1.3, oz = k.z + fz * 1.3, oy = k.y + 0.95;
    const tp = Math.tan(k.pitch);
    // 先找光束離開路面（打到護欄或坡面）的距離
    let len = P.range;
    let hint = k.idx;
    for (let t = 4; t < P.range; t += 4) {
      const x = ox + fx * t, z = oz + fz * t;
      hint = track.probe(x, z, hint, 0.6);
      if (!track.probeOn || oy + tp * t < track.probeY - 0.2) { len = Math.max(2, t - 2); break; }
    }
    let best = len;
    let hitK: Kart | null = null;
    let obj: (() => void) | null = null;
    const ray = (x: number, z: number, w: number): number => {
      const dx = x - ox, dz = z - oz;
      const t = dx * fx + dz * fz;
      if (t < 0 || t > best) return -1;
      return Math.abs(dx * fz - dz * fx) < w ? t : -1;
    };
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const t = ray(o.x, o.z, 1.3);
      if (t >= 0 && Math.abs(o.y + 0.9 - (oy + tp * t)) < 2) { best = t; hitK = o; obj = null; }
    }
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const t = ray(b.x, b.z, 0.9);
      if (t >= 0) { best = t; hitK = null; obj = () => this.detonate(b, k); }
    }
    for (const m of this.mines) {
      if (m.dead || m.fuse > 0) continue;
      const t = ray(m.x, m.z, 0.7);
      if (t >= 0) { best = t; hitK = null; obj = () => { m.by = k; this.explodeMine(m); }; }
    }
    for (const b of this.boulders) {
      if (b.dead || b.enterT > 0.45) continue;
      const t = ray(b.x, b.z, b.r);
      if (t >= 0) { best = t; hitK = null; obj = () => this.hurtBoulder(b, dmg, k); }
    }
    // 貫穿光束：打穿第一台車，再找後面的第二台
    let hit2: Kart | null = null;
    if (hitK && k.primaryLvl >= PERK_LVL5) {
      const first = best;
      best = len;
      for (const o of this.karts) {
        if (o === k || o === hitK || o.dead || o.out || o.invulnT > 0) continue;
        const t = ray(o.x, o.z, 1.3);
        if (t > first && Math.abs(o.y + 0.9 - (oy + tp * t)) < 2) { best = t; hit2 = o; }
      }
      if (!hit2) best = Math.min(len, first + 30);
      else this.damage(hit2, dmg * 0.8, k);
      if (hit2) this.events.push({ t: 'hit', k: hit2, by: k, x: hit2.x, y: hit2.y + 0.9, z: hit2.z, w: 'laser' });
    }
    k.beamLen = best + 1.3;
    k.beamHit = !!hitK || !!obj;
    if (hitK) {
      this.damage(hitK, dmg, k);
      this.events.push({ t: 'hit', k: hitK, by: k, x: hitK.x, y: hitK.y + 0.9, z: hitK.z, w: 'laser' });
    } else if (obj) obj();
  }

  /** 火箭：朝正前方直線飛行 */
  private fireRocket(k: Kart): void {
    const S = SECONDARY.rocket;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const twin = k.secondaryLvl >= PERK_LVL5;
    for (const off of twin ? [-0.45, 0.45] : [0]) {
      this.missiles.push({
        x: k.x + fx * 1.6 + fz * off, y: k.y + 0.95, z: k.z + fz * 1.6 - fx * off, a: k.heading, idx: k.idx,
        speed: Math.max(30, k.speed) + 25, life: 3.5, dmg: this.secDmg(k), radius: S.radius, owner: k,
        homing: false, target: null, age: 0,
      });
    }
  }

  /** 追蹤導彈：從附近的對手裡隨機挑一台鎖定 */
  private fireHoming(k: Kart): void {
    const S = SECONDARY.missile;
    const cands = this.karts.filter((o) => o !== k && !o.dead && !o.out && !o.finished && Math.hypot(o.x - k.x, o.z - k.z) < 260);
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const n = k.secondaryLvl >= PERK_LVL5 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const target = cands.length ? cands.splice(Math.floor(this.rng() * cands.length), 1)[0] : null;
      const off = n > 1 ? (i ? 0.4 : -0.4) : 0;
      this.missiles.push({
        x: k.x + fx * 1.6 + fz * off, y: k.y + 1.2, z: k.z + fz * 1.6 - fx * off, a: k.heading + off * 0.3, idx: k.idx,
        speed: Math.max(30, k.speed) + 12, life: 6, dmg: this.secDmg(k), radius: S.radius, owner: k,
        homing: true, target, age: 0,
      });
      if (target) {
        target.lockT = 2;
        this.events.push({ t: 'lock', k: target, by: k });
      }
    }
  }

  /** 榴彈發射器：固定仰角朝前拋射，落點約在車前 45 公尺（隨車速往前帶） */
  private fireShell(k: Kart): void {
    const S = SECONDARY.grenade;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hv = Math.max(0, k.speed) + 46;
    this.shells.push({
      x: k.x + fx * 1.4, y: 1 + k.air, z: k.z + fz * 1.4, gy: k.y - k.air, idx: k.idx, vx: fx * hv, vy: SHELL_VY, vz: fz * hv,
      dmg: this.secDmg(k), radius: S.radius, owner: k, sub: false,
    });
  }

  private newMine(k: Kart, kind: 'mine' | 'cluster', x: number, z: number, vx: number, vz: number): Mine {
    const S = SECONDARY[kind];
    const idx = this.track.probe(x, z, k.idx);
    return {
      x, y: this.track.probeY, z, vx, vz, idx, owner: k, by: k, kind,
      armT: kind === 'mine' ? 0.8 : 0.35, life: kind === 'mine' ? 45 : 6 + this.rng() * 0.8, fuse: 0,
      dmg: this.secDmg(k), radius: S.radius * (kind === 'mine' && k.secondaryLvl >= PERK_LVL5 ? 1.4 : 1), trigger: kind === 'mine' ? 2.6 : 2.1, dead: false,
    };
  }

  /** 地雷：放在車尾後方；同一個人最多同時留 3 顆，超過就收回最舊的 */
  private dropMine(k: Kart): void {
    const own = this.mines.filter((m) => !m.dead && m.owner === k && m.kind === 'mine');
    if (own.length >= (k.secondaryLvl >= PERK_LVL5 ? MAX_MINES_PERK : MAX_MINES)) own[0].dead = true;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    this.mines.push(this.newMine(k, 'mine', k.x - fx * 2.4, k.z - fz * 2.4, k.vx * 0.12, k.vz * 0.12));
  }

  /** 集束圓雷：往車尾扇形撒出 5 顆，會在路面上滾一小段 */
  private dropCluster(k: Kart): void {
    const S = SECONDARY.cluster;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const count = S.count + (k.secondaryLvl >= PERK_LVL5 ? 2 : 0);
    for (let i = 0; i < count; i++) {
      const a = k.heading + Math.PI + (i - (count - 1) / 2) * (count > 5 ? 0.28 : 0.36);
      const sp = 9 + this.rng() * 5;
      this.mines.push(this.newMine(k, 'cluster', k.x - fx * 2, k.z - fz * 2, k.vx * 0.42 + Math.sin(a) * sp, k.vz * 0.42 + Math.cos(a) * sp));
    }
  }

  private explodeMine(m: Mine): void {
    if (m.dead) return;
    m.dead = true;
    this.explodeAt(m.x, m.y + 0.5, m.z, m.y, m.radius, m.dmg, m.by);
  }

  private updateMines(dt: number): void {
    const track = this.track;
    const lim = track.halfWidth - 0.6;
    for (const m of this.mines) {
      if (m.dead) continue;
      // 滑動與停下，不會滾出護欄
      if (m.vx !== 0 || m.vz !== 0) {
        m.x += m.vx * dt;
        m.z += m.vz * dt;
        const f = Math.exp(-3.2 * dt);
        m.vx *= f;
        m.vz *= f;
        if (m.vx * m.vx + m.vz * m.vz < 0.04) m.vx = m.vz = 0;
        m.idx = track.probe(m.x, m.z, m.idx);
        if (!track.probeOn && Math.abs(track.lat) > lim) {
          const s = track.samples[m.idx];
          const sg = Math.sign(track.lat);
          m.x -= s.nx * sg * (Math.abs(track.lat) - lim);
          m.z -= s.nz * sg * (Math.abs(track.lat) - lim);
          m.vx = m.vz = 0;
          m.idx = track.probe(m.x, m.z, m.idx);
        }
        m.y = track.probeY;
      }
      m.armT -= dt;
      m.life -= dt;
      if (m.fuse > 0) {
        m.fuse -= dt;
        if (m.fuse <= 0) this.explodeMine(m);
        continue;
      }
      if (m.life <= 0) {
        // 集束圓雷時間到自己引爆；一般地雷失效消失
        if (m.kind === 'cluster') this.explodeMine(m);
        else m.dead = true;
        continue;
      }
      if (m.armT > 0) continue;
      for (const k of this.karts) {
        if (k === m.owner || k.dead || k.out || k.air > 1.2) continue;
        const dx = k.x - m.x, dz = k.z - m.z;
        if (dx * dx + dz * dz < m.trigger * m.trigger) {
          this.explodeMine(m);
          break;
        }
      }
    }
    if (this.mines.some((m) => m.dead)) this.mines = this.mines.filter((m) => !m.dead);
  }

  /**
   * 車與車的碰撞：
   * - 依質量分配推開的距離與速度變化（重車撞輕車，輕車被撞飛）
   * - 接觸面有摩擦：側面擦撞會讓雙方打轉
   * - 相對速度夠大才有傷害；噴射中的車撞人更痛、自己幾乎不受傷
   */
  private collideKarts(): void {
    const K = this.karts;
    const C = CFG;
    const R = C.kartRadius * 1.9;
    for (let i = 0; i < K.length; i++) {
      const a = K[i];
      if (a.dead || a.out) continue;
      for (let j = i + 1; j < K.length; j++) {
        const b = K[j];
        if (b.dead || b.out) continue;
        if (Math.abs(a.y - b.y) > 1.6) continue; // 一台在空中就撞不到
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
        const pen = R - d;
        a.x -= nx * pen * wa; a.z -= nz * pen * wa;
        b.x += nx * pen * wb; b.z += nz * pen * wb;
        const rvx = a.vx - b.vx, rvz = a.vz - b.vz;
        const rvn = rvx * nx + rvz * nz;
        if (rvn <= 0) continue;
        // 法線方向：帶一點彈性的衝量
        const jn = rvn * 1.25;
        a.vx -= nx * jn * wa; a.vz -= nz * jn * wa;
        b.vx += nx * jn * wb; b.vz += nz * jn * wb;
        // 切線方向：摩擦力，同時造成打轉
        const tx = -nz, tz = nx;
        const rvt = rvx * tx + rvz * tz;
        const jt = clamp(rvt, -jn * C.kartFriction, jn * C.kartFriction);
        a.vx -= tx * jt * wa * 0.5; a.vz -= tz * jt * wa * 0.5;
        b.vx += tx * jt * wb * 0.5; b.vz += tz * jt * wb * 0.5;
        const spin = (jt * C.kartRadius) / C.spinInertia;
        a.spinVel += spin * wa * 2;
        b.spinVel += spin * wb * 2;
        const power = Math.max(0, rvn - 2);
        if (power > 0) this.events.push({ t: 'ram', a, b, x: a.x + nx * R * 0.5, y: a.y + 0.7, z: a.z + nz * R * 0.5, power });
        // 剛重生或已完賽（無敵）的車不造成也不承受衝撞傷害
        if (rvn > C.ramMinSpeed && a.invulnT <= 0 && b.invulnT <= 0) {
          const base = Math.min(30, (rvn - C.ramMinSpeed) * C.ramDamage);
          const aFast = a.boostT > 0 || a.padT > 0, bFast = b.boostT > 0 || b.padT > 0;
          this.damage(b, base * a.ramMul * (aFast ? C.ramBoostMul : 1) * (bFast ? 0.25 : 1), a);
          this.damage(a, base * b.ramMul * (bFast ? C.ramBoostMul : 1) * (aFast ? 0.25 : 1), b);
        }
      }
    }
  }

  private updateBullets(dt: number): void {
    const B = this.bullets;
    for (let i = B.length - 1; i >= 0; i--) {
      const b = B[i];
      const sx = b.vx * dt, sz = b.vz * dt;
      const sl2 = sx * sx + sz * sz;
      let hit: Kart | null = null;
      let ht = 2;
      for (const k of this.karts) {
        if (k === b.owner || k === b.skip || k.dead || k.out || k.invulnT > 0) continue;
        const t = clamp(((k.x - b.x) * sx + (k.z - b.z) * sz) / sl2, 0, 1);
        const cx = b.x + sx * t - k.x, cz = b.z + sz * t - k.z;
        if (cx * cx + cz * cz < 2.1 && t < ht && Math.abs(b.y - (k.y + 0.9)) < 2.2) { ht = t; hit = k; }
      }
      if (!hit && this.hitObject(b.x + sx, b.z + sz, 0.45, b.owner, b.dmg)) {
        B[i] = B[B.length - 1];
        B.pop();
        continue;
      }
      if (hit) {
        this.events.push({ t: 'hit', k: hit, by: b.owner, x: b.x + sx * ht, y: b.y + b.vy * dt * ht, z: b.z + sz * ht, w: 'gun' });
        this.damage(hit, b.dmg, b.owner);
        if (b.pierce > 0) {
          // 穿甲彈：打穿後繼續飛，傷害打七折
          b.pierce--;
          b.skip = hit;
          b.dmg *= 0.7;
        } else {
          B[i] = B[B.length - 1];
          B.pop();
          continue;
        }
      }
      b.x += sx;
      b.y += b.vy * dt;
      b.z += sz;
      b.life -= dt;
      // 打到護欄或地面：濺出火花後消失
      b.idx = this.track.probe(b.x, b.z, b.idx, 0.7);
      if (!this.track.probeOn || b.y < this.track.probeY) {
        this.events.push({ t: 'impact', x: b.x, y: Math.max(b.y, this.track.probeY + 0.2), z: b.z });
        B[i] = B[B.length - 1];
        B.pop();
        continue;
      }
      if (b.life <= 0) {
        B[i] = B[B.length - 1];
        B.pop();
      }
    }
  }

  private updateMissiles(dt: number): void {
    const M = this.missiles;
    const track = this.track;
    for (let i = M.length - 1; i >= 0; i--) {
      const m = M[i];
      m.age += dt;
      m.idx = track.probe(m.x, m.z, m.idx);
      const roadY = track.probeY;
      let boom = false;
      if (m.homing) {
        m.speed = Math.min(80, m.speed + 50 * dt);
        const tg = m.target;
        if (tg && (tg.dead || tg.out)) m.target = null;
        let wantY = roadY + 2.2;
        if (m.target && m.age > 0.25) {
          const t = m.target;
          const want = Math.atan2(t.x - m.x, t.z - m.z);
          m.a += clamp(wrapAngle(want - m.a), -HOMING_TURN * dt, HOMING_TURN * dt);
          t.lockT = Math.max(t.lockT, 0.3);
          const d = Math.hypot(t.x - m.x, t.z - m.z);
          if (d < 18) wantY = t.y + 0.9;
          if (d < 2.6 && Math.abs(t.y + 0.9 - m.y) < 2.5) boom = true;
        }
        m.y += (wantY - m.y) * Math.min(1, dt * 6);
      } else {
        m.speed = Math.min(95, m.speed + 70 * dt);
        // 火箭貼著路面飛，飛出護欄就爆炸
        m.y += (roadY + 0.95 - m.y) * Math.min(1, dt * 8);
        if (!track.probeOn) boom = true;
      }
      m.x += Math.sin(m.a) * m.speed * dt;
      m.z += Math.cos(m.a) * m.speed * dt;
      m.life -= dt;
      if (m.life <= 0) boom = true;
      if (!boom) {
        for (const k of this.karts) {
          if (k === m.owner || k.dead || k.out) continue;
          const dx = k.x - m.x, dz = k.z - m.z;
          if (dx * dx + dz * dz < 6.5 && Math.abs(k.y + 0.9 - m.y) < 2.5) { boom = true; break; }
        }
      }
      if (!boom && this.hitObject(m.x, m.z, 0.9, m.owner, m.dmg)) boom = true;
      if (boom) {
        this.explodeAt(m.x, m.y, m.z, roadY, m.radius, m.dmg, m.owner);
        M[i] = M[M.length - 1];
        M.pop();
      }
    }
  }

  private updateShells(dt: number): void {
    const S = this.shells;
    for (let i = S.length - 1; i >= 0; i--) {
      const s = S[i];
      s.vy -= SHELL_GRAVITY * dt;
      // 參考地面高度跟著砲彈下方的路面走
      s.idx = this.track.probe(s.x, s.z, s.idx);
      s.gy += (this.track.probeY - s.gy) * Math.min(1, dt * 10);
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      let boom = s.y <= 0.3;
      if (!boom && s.y < 2.2) {
        for (const k of this.karts) {
          if (k === s.owner || k.dead || k.out) continue;
          const dx = k.x - s.x, dz = k.z - s.z;
          if (dx * dx + dz * dz < 4) { boom = true; break; }
        }
      }
      if (boom) {
        this.explodeAt(s.x, s.gy + Math.max(0.5, s.y), s.z, s.gy, s.radius, s.dmg, s.owner);
        S[i] = S[S.length - 1];
        S.pop();
        // 子母彈：往四周彈出 3 顆小榴彈
        if (!s.sub && s.owner.secondary === 'grenade' && s.owner.secondaryLvl >= PERK_LVL5) {
          for (let j = 0; j < 3; j++) {
            const a = this.rng() * Math.PI * 2, sp = 7 + this.rng() * 5;
            S.push({
              x: s.x, y: 0.8, z: s.z, gy: s.gy, idx: s.idx, vx: s.vx * 0.15 + Math.cos(a) * sp, vy: 8 + this.rng() * 3, vz: s.vz * 0.15 + Math.sin(a) * sp,
              dmg: s.dmg * 0.4, radius: s.radius * 0.55, owner: s.owner, sub: true,
            });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 機關

  private updateHazards(dt: number): void {
    const t = this.clock;
    for (const h of this.hazards) {
      const P = h.def.period;
      const ph = t / P + (h.def.phase ?? 0);
      if (h.def.kind === 'hammer') {
        const w = (Math.PI * 2) / P;
        h.theta = HAMMER.amp * Math.sin(ph * Math.PI * 2);
        const om = HAMMER.amp * w * Math.cos(ph * Math.PI * 2);
        h.lat = HAMMER.arm * Math.sin(h.theta);
        h.vlat = HAMMER.arm * Math.cos(h.theta) * om;
        h.hy = HAMMER.pivot - HAMMER.arm * Math.cos(h.theta);
        if (dt > 0) this.hammerHits(h);
      } else if (h.def.kind === 'tram') {
        const cycle = Math.floor(ph);
        const tau = (ph - cycle) * P;
        const T = (2 * TRAM.reach) / TRAM.speed;
        h.dir = cycle % 2 ? 1 : -1;
        h.moving = tau >= TRAM.warn && tau < TRAM.warn + T;
        h.warn = tau < TRAM.warn + T;
        h.c = h.dir * (h.moving ? -TRAM.reach + TRAM.speed * (tau - TRAM.warn) : -TRAM.reach);
        if (cycle !== h.cycle) {
          if (h.cycle >= 0) this.events.push({ t: 'tram', x: h.x, y: h.y, z: h.z });
          h.cycle = cycle;
        }
        if (dt > 0 && h.moving) this.tramHits(h);
      } else if (dt > 0 && this.state !== 'countdown') {
        h.spawnT -= dt;
        if (h.spawnT <= 0) {
          h.spawnT = P * (0.75 + this.rng() * 0.5);
          this.spawnBoulder(h);
        }
      }
    }
  }

  /** 機關撞到車：沒有人得分 */
  private hazardHit(k: Kart, kind: HazardDef['kind'], dmg: number): void {
    k.hazardCd = 1.1;
    this.events.push({ t: 'hazard', k, kind, x: k.x, y: k.y + 1, z: k.z });
    this.damage(k, dmg, null);
  }

  private hammerHits(h: HazardState): void {
    const bottom = h.hy - HAMMER.headR;
    for (const k of this.karts) {
      if (k.dead || k.out || k.hazardCd > 0 || k.invulnT > 0) continue;
      const dx = k.x - h.x, dz = k.z - h.z;
      const along = dx * h.tx + dz * h.tz;
      const lat = dx * h.nx + dz * h.nz;
      if (Math.abs(along) > HAMMER.headR + 1.1 || Math.abs(lat - h.lat) > HAMMER.headHalf + 1.1) continue;
      if (bottom > k.air + 1.4) continue;
      const dir = Math.abs(h.vlat) > 1 ? Math.sign(h.vlat) : Math.sign(lat - h.lat) || 1;
      this.knock(k, h.nx * dir, h.nz * dir, 12 + Math.abs(h.vlat) * 0.6, 8);
      this.hazardHit(k, 'hammer', HAMMER.dmg);
    }
  }

  private tramHits(h: HazardState): void {
    for (const k of this.karts) {
      if (k.dead || k.out || k.hazardCd > 0 || k.invulnT > 0 || k.air > 3) continue;
      const dx = k.x - h.x, dz = k.z - h.z;
      const along = dx * h.tx + dz * h.tz;
      const lat = dx * h.nx + dz * h.nz;
      if (Math.abs(along) > TRAM.width + 1.1 || Math.abs(lat - h.c) > TRAM.half + 1.1) continue;
      this.knock(k, h.nx * h.dir, h.nz * h.dir, TRAM.speed * 1.1, 10);
      this.hazardHit(k, 'tram', TRAM.dmg);
    }
  }

  private spawnBoulder(h: HazardState): void {
    const hw = this.track.halfWidth;
    const side = this.rng() < 0.5 ? 1 : -1;
    this.boulders.push({
      d: h.def.dist + this.rng() * 25, lat: side * (hw + 5), lat0: side * (hw + 5), lat1: (this.rng() * 2 - 1) * (hw - 3.2),
      x: 0, y: 0, z: 0, v: 13 + this.rng() * 5, r: BOULDER.r, hp: BOULDER.hp, enterT: BOULDER.enter, roll: 0,
      end: h.def.dist + (h.def.len ?? 250), dead: false,
    });
  }

  private hurtBoulder(b: Boulder, dmg: number, by: Kart | null): void {
    if (b.dead) return;
    b.hp -= dmg;
    if (b.hp > 0) return;
    b.dead = true;
    this.events.push({ t: 'rock', x: b.x, y: b.y, z: b.z, r: b.r });
    if (by) by.addGauge(0.06, (e) => this.events.push({ t: 'kart', k: by, e }));
  }

  private updateBoulders(dt: number): void {
    const track = this.track;
    for (const b of this.boulders) {
      if (b.dead) continue;
      // 沿下坡越滾越快
      const sl = track.samples[track.wrap(Math.round(b.d / track.spacing))].slope;
      b.v = clamp(b.v - 9.8 * 0.5 * sl * dt, 10, 24);
      b.d += b.v * dt;
      b.roll += (b.v / b.r) * dt;
      let hop = 0;
      if (b.enterT > 0) {
        b.enterT = Math.max(0, b.enterT - dt);
        const u = 1 - b.enterT / BOULDER.enter;
        b.lat = b.lat0 + (b.lat1 - b.lat0) * u;
        hop = Math.sin(Math.PI * u) * 3.2 + (1 - u) * 2;
      }
      const p = track.pointAt(b.d);
      b.x = p.x + p.nx * b.lat;
      b.z = p.z + p.nz * b.lat;
      b.y = p.y + b.r + hop;
      if (b.d > b.end) {
        b.dead = true;
        this.events.push({ t: 'rock', x: b.x, y: b.y, z: b.z, r: b.r });
        continue;
      }
      if (b.enterT > 0.35) continue;
      for (const k of this.karts) {
        if (k.dead || k.out || k.hazardCd > 0 || k.invulnT > 0) continue;
        const dx = k.x - b.x, dz = k.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d > b.r + 1.1 || k.y + 0.6 > b.y + b.r) continue;
        if (k.boostT > 0) {
          // 開著 N2O 直接撞碎
          this.hurtBoulder(b, 999, k);
          k.spinVel += (this.rng() - 0.5) * 2;
          break;
        }
        const inv = d > 0.01 ? 1 / d : 0;
        this.knock(k, dx * inv + p.tx * 0.6, dz * inv + p.tz * 0.6, 11 + b.v * 0.3, 9);
        this.hazardHit(k, 'boulder', BOULDER.dmg);
      }
    }
    if (this.boulders.some((b) => b.dead)) this.boulders = this.boulders.filter((b) => !b.dead);
  }
}
