import { AIController } from './ai';
import { CAR_IDS, CARS } from './cars';
import { CFG } from './config';
import { emptyInput, Kart, type KartEvent, type KartInput } from './kart';
import type { NetRacer, OnlineSetup, RaceNet, SecParams } from './net';
import { pickMissions, type Mission } from './missions';
import type { Profile } from './save';
import type { HazardDef, Track } from './track';
import { initStreet, updateStreet, type CrackerMat, type StreetRider } from './street';
import { clamp, mulberry32, wrapAngle } from './util';
import {
  ARC_KEEP, ARC_W, arcHops, arcJump, BURN_DPS, BURN_TIME, CHILL_DECAY, CHILL_DECAY_DEEP, CHILL_HOLD, chillRate, FREEZE_W, HOOK_SPEED, LASER_CHARGE, laserCooldown, laserKeep, laserWidth,
  lvl3Mul, PERK_LVL5, PRIMARY, PRIMARY_IDS, pullBonus, ROPE_MAX, ROPE_PULL, SECONDARY, SECONDARY_IDS, shieldHalfArc, shieldHp, shieldTime, SHOVE_T, SONIC_SLAM, sonicPush,
  tetherTime, weaponLvlMul, type PrimaryDef, type SecondaryId,
} from './weapons';
import { DIFFICULTY } from './difficulty';
import { isEn, t } from '../i18n';

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
  /** 街頭機關（src/game/street.ts）：機車、鞭炮、強風的強度 0~1 */
  riders?: StreetRider[];
  mats?: CrackerMat[];
  gust?: number;
}

/** 魚叉鉤射出去還在飛的叉頭；side = 從哪一側的槍射出（畫繩子用） */
export interface Hook { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; dmg: number; owner: Kart; idx: number; side: number }

export type HitWeapon = 'gun' | 'flame' | 'laser' | 'arc' | 'freeze' | 'sonic' | 'harpoon';
/** 魚叉繩斷掉的原因：追上對方、放開（或時間到）、被扯斷（撞牆、被擋住、拉太遠） */
export type TetherEnd = 'catch' | 'release' | 'snap';

export type RaceEvent =
  | { t: 'shot'; k: Kart; x: number; y: number; z: number; side: number }
  | { t: 'hit'; k: Kart; by: Kart; x: number; y: number; z: number; w: HitWeapon }
  | { t: 'dmg'; k: Kart; by: Kart | null; amount: number; fatal: boolean }
  | { t: 'impact'; x: number; y: number; z: number }
  | { t: 'blast'; x: number; y: number; z: number; r: number; gy: number; kart: boolean }
  | { t: 'kill'; killer: Kart | null; victim: Kart; streak: number }
  | { t: 'launch'; k: Kart; kind: SecondaryId }
  /** 後方護盾擋下一次攻擊；shatter = 護盾被打碎 */
  | { t: 'block'; k: Kart; x: number; y: number; z: number }
  | { t: 'shatter'; k: Kart }
  /** 雷射射出：hits = 打中幾台車 */
  | { t: 'rail'; k: Kart; x: number; y: number; z: number; len: number; hits: number }
  /** 電弧槍放電：chain = 依序被電到的車（空 = 沒電到人，電弧停在槍口前方 len 公尺處） */
  | { t: 'zap'; k: Kart; x: number; y: number; z: number; chain: Kart[]; len: number }
  /** 音波炮打出一圈震波：a = 方向、r = 射程、w = 扇形半角 */
  | { t: 'pulse'; k: Kart; x: number; y: number; z: number; a: number; r: number; w: number }
  /** 魚叉射出（side = 哪一側的槍） */
  | { t: 'hook'; k: Kart; x: number; y: number; z: number; side: number }
  /** 魚叉繩叉住（on）或斷掉 */
  | { t: 'tether'; k: Kart; v: Kart; on: boolean; why?: TetherEnd }
  | { t: 'lock'; k: Kart; by: Kart }
  | { t: 'hazard'; k: Kart; kind: HazardDef['kind']; x: number; y: number; z: number }
  | { t: 'rock'; x: number; y: number; z: number; r: number }
  | { t: 'tram'; x: number; y: number; z: number }
  /** 街頭機關的聲音與特效：鞭炮炸開、巷口的機車按喇叭 */
  | { t: 'street'; kind: 'cracker' | 'horn'; x: number; y: number; z: number }
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
/** 電腦車手的英文名字（跟上面一一對應）。名字不經過網路：每台電腦依自己的語言顯示同一位車手 */
const AI_NAMES_EN = ['Blitz Kai', 'Fireball Nina', 'Ironhead', 'Twister', 'Popcorn', 'Night Owl', 'Rumble'];
/** 跟著語言的車手名字：ai:編號、you（單機的自己）、racer（沒取名字的玩家） */
function kartLabel(key: string): string {
  if (key.startsWith('ai:')) {
    const i = Number(key.slice(3)) % AI_NAMES.length;
    return (isEn() ? AI_NAMES_EN : AI_NAMES)[i];
  }
  return key === 'you' ? t.you : t.racer;
}
const AI_COLORS = [0xff4d5a, 0xff9f1c, 0x35c46a, 0x29b6f6, 0xb05cff, 0xff7ac8, 0xa8b4c4];
export const PLAYER_COLOR = 0xffd400;

const SHELL_GRAVITY = 28;
const SHELL_VY = 13;
/** 遠端車模擬主武器用的輸入（只有 firePrimary 會變） */
const REMOTE_INPUT = emptyInput();
/** 榴彈從離地 1 公尺射出到落地（0.3 公尺）的飛行時間 */
const SHELL_T = (SHELL_VY + Math.sqrt(SHELL_VY * SHELL_VY + 2 * SHELL_GRAVITY * 0.7)) / SHELL_GRAVITY;
/** 榴彈自動預判的範圍：車頭前方 ±40°、120 公尺內 */
const GRENADE_CONE = 0.7;
const GRENADE_RANGE = 120;
/** 追蹤導彈的轉向速度（弧度／秒）：比急轉彎的車慢，所以甩得掉 */
const HOMING_TURN = 2.3;
/** 追蹤導彈的飛行高度上限（離腳下路面幾公尺）：目標跳起來或被炸飛時不會一路追上天，飛越跳台可以躲掉 */
const HOMING_MAX_ALT = 4.5;
const MAX_MINES = 3;
const MAX_MINES_PERK = 5;

// 機關的尺寸與威力
export const HAMMER = { pivot: 11, arm: 9.5, amp: 1.15, headR: 1.3, headHalf: 1.8, dmg: 22 };
export const TRAM = { half: 8, width: 1.6, speed: 24, warn: 2.5, reach: 38, dmg: 40 };
/** 平交道的區間車：三節車廂，從遠處開過來 */
export const TRAIN = { half: 27, width: 1.6, speed: 30, warn: 2.6, reach: 92, dmg: 40 };
export const tramSpec = (def: HazardDef): typeof TRAM => (def.train ? TRAIN : TRAM);
export const BOULDER = { r: 2.2, hp: 50, dmg: 28, enter: 0.9 };

/** 一場比賽的完整模擬。不依賴畫面，之後連線對戰可直接由主機端跑這份。 */
export class Race {
  track: Track;
  mode: RaceMode;
  karts: Kart[] = [];
  player: Kart;
  ais = new Map<Kart, AIController>();
  bullets: Bullet[] = [];
  hooks: Hook[] = [];
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
  /** 連線對戰（null = 單機） */
  net: RaceNet | null = null;
  readonly online: boolean;
  private lastCount = 4;
  private outCount = 0;
  /** 第一台車完賽的時間；之後再過一段時間還沒跑完的直接依進度排名 */
  private firstFinishT = -1;
  private rng: () => number;

  constructor(track: Track, profile: Profile, mode: RaceMode = 'race', seed = (Date.now() & 0x7fffffff), setup?: OnlineSetup) {
    this.track = track;
    this.mode = mode;
    this.online = !!setup;
    const rng = (this.rng = mulberry32(seed));
    const D = DIFFICULTY[setup?.difficulty ?? profile.difficulty ?? 'normal'];
    // 參賽名單：單機 = 7 台電腦 + 玩家；連線 = 補位的電腦在前排、玩家照房間順序排在後面
    const slots: (NetRacer | 'ai' | 'me')[] = [];
    if (setup) {
      const humans = setup.racers.slice(0, CFG.racers);
      const nAi = setup.aiFill ? Math.max(0, CFG.racers - humans.length) : 0;
      for (let i = 0; i < nAi; i++) slots.push('ai');
      slots.push(...humans);
    } else {
      for (let i = 0; i < CFG.racers - 1; i++) slots.push('ai');
      slots.push('me');
    }
    const total = slots.length;
    let player!: Kart;
    let aiNo = 0;
    for (let j = 0; j < total; j++) {
      const slot = slots[j];
      const isAi = slot === 'ai';
      const r = typeof slot === 'object' ? slot : null;
      const isP = slot === 'me' || (r !== null && r.pid === setup?.me);
      const nameKey = isAi ? 'ai:' + (aiNo % AI_NAMES.length) : r ? (r.name ? null : 'racer') : 'you';
      const name = nameKey ? kartLabel(nameKey) : r!.name;
      const color = isAi ? AI_COLORS[aiNo % AI_COLORS.length] : isP ? PLAYER_COLOR : AI_COLORS[(r!.pid + 2) % AI_COLORS.length];
      if (isAi) aiNo++;
      const k = new Kart(j, name, color);
      k.nameKey = nameKey;
      k.netId = j;
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
      // 玩家（自己或房間裡的其他人）的車與裝備
      const src: Omit<NetRacer, 'pid' | 'name'> | null = r ?? (isP ? {
        car: profile.kart, livery: profile.livery?.[profile.kart] ?? 0, primary: profile.primary, secondary: profile.secondary,
        plvl: profile.lvl[profile.primary], slvl: profile.lvl[profile.secondary], engine: profile.car.engine, n2o: profile.car.n2o, armor: profile.car.armor,
      } : null);
      if (src) {
        k.isPlayer = isP;
        k.car = src.car;
        k.primary = src.primary;
        k.secondary = src.secondary;
        k.primaryLvl = src.plvl;
        k.secondaryLvl = src.slvl;
        if (r) {
          k.owner = r.pid;
          k.remote = !isP;
        }
        this.ais.set(k, new AIController(rng, 1, D));
        if (isP) player = k;
      } else {
        k.aiAssist = true;
        k.bot = true;
        // 連線時電腦車手分給幾位連線最好的玩家跑（aiOwners 輪流分）
        if (setup) {
          const owners = setup.aiOwners.length ? setup.aiOwners : [setup.racers[0]?.pid ?? setup.me];
          k.owner = owners[(aiNo - 1) % owners.length];
          k.remote = k.owner !== setup.me;
        }
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
      const eng = src ? src.engine : 0;
      k.maxSpeedMul = car.speed * (1 + 0.015 * eng);
      k.accelMul = car.accel * (1 + 0.03 * eng);
      k.boostTimeAdd = car.boostTime + (src ? 0.2 * src.n2o : 0);
      k.maxHp = CFG.hp + car.hp + (src ? 12 * src.armor : 0);
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
      k.livery = src ? src.livery : Math.floor(rng() * car.liveries.length);
      this.ais.get(k)!.baseSpeedMul = k.maxSpeedMul;
      this.karts.push(k);
    }
    this.player = player;

    // 爆炸桶（目前關閉：CFG.barrels）
    if (CFG.barrels) for (const b of track.barrelSpots()) {
      const s = track.samples[track.wrap(Math.round(b.dist / track.spacing))];
      this.barrels.push({ x: s.x + s.nx * b.lat, y: s.y, z: s.z + s.nz * b.lat, respawnT: 0, fuse: 0, by: null });
    }
    // 機關
    for (const def of track.def.hazards ?? []) {
      const p = track.pointAt(def.dist);
      const h: HazardState = {
        def, x: p.x, y: p.y, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz,
        theta: 0, lat: 0, hy: HAMMER.pivot - HAMMER.arm, vlat: 0,
        c: -tramSpec(def).reach, dir: 1, warn: false, moving: false,
        spawnT: 1 + rng() * def.period, cycle: -1,
      };
      initStreet(h, track);
      this.hazards.push(h);
    }
    this.updateHazards(0);
    // 這場做不到的任務不要抽
    const skip: string[] = [];
    if (!this.barrels.length) skip.push('barrel3');
    if (!track.ramps.length) skip.push('jump3');
    if (!track.branches.length) skip.push('cut2');
    this.missions = pickMissions(rng, mode, skip);
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
      this.updateStatus(k, dt);
      if (k.remote) {
        this.stepRemote(k, dt, racing);
        continue;
      }
      const ai = this.ais.get(k)!;
      const useAI = !k.isPlayer || k.finished || this.autoPlayer;
      // 連線時不做「領先放慢、落後加速」（每個人看到的玩家不一樣）
      if (!k.isPlayer && !this.online) ai.rubberBand(k, this.player, this);
      k.firing = Math.max(0, k.firing - dt);
      k.lockT = Math.max(0, k.lockT - dt);
      k.hazardCd = Math.max(0, k.hazardCd - dt);
      k.shieldT = Math.max(0, k.shieldT - dt);
      k.shieldBreakT = Math.max(0, k.shieldBreakT - dt);
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
          k.charge = 0;
          k.burnT = 0;
          if (k.spareN2O) k.n2o = Math.max(k.n2o, 1);
          ev.push({ t: 'respawn', k });
        }
        continue;
      }
      // 從沒有護欄的捷徑摔下去：往下掉一下，回到主線（停下來，要重新加速）
      if (k.fallT > 0) {
        k.fallT -= dt;
        k.vy -= 30 * dt;
        k.air = 1;
        k.y += k.vy * dt;
        k.x += k.vx * dt * 0.5;
        k.z += k.vz * dt * 0.5;
        if (k.fallT <= 0) {
          k.fallT = 0;
          this.resetToTrack(k);
          k.invulnT = Math.max(k.invulnT, 1.2);
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
      const e0 = ev.length;
      k.update(dt, inp, track, (e) => ev.push({ t: 'kart', k, e }));
      // 撞牆：魚叉繩扯斷；被音波炮推去撞牆（Lv.5）額外受傷
      for (let i = e0; i < ev.length; i++) {
        const e = ev[i];
        if (e.t === 'kart' && e.e === 'wall') { this.onWall(k); break; }
      }
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
      k.netFire = inp.firePrimary && !k.finished;
    }

    this.updateHazards(dt);
    if (racing) {
      this.collideKarts();
      this.updateDraft(dt);
      this.updateBarrels(dt);
      this.updateBullets(dt);
      this.updateHooks(dt);
      this.updateMissiles(dt);
      this.updateShells(dt);
      this.updateMines(dt);
      this.updateBoulders(dt);
      // 淘汰賽：自己被淘汰後也要繼續（連線時房主被淘汰了還是要幫大家判定）
      if (this.mode === 'elim' && this.aliveCount > 1) this.updateElimination(dt);
    }
    // 第一台完賽後 30 秒還沒跑完的，直接依目前進度排名（避免比賽永遠不結束）
    if (this.mode === 'race' && this.firstFinishT >= 0 && this.time > this.firstFinishT + 30) {
      // 連線時只處理自己控制的車（別人的由他們自己的電腦判定）
      const rest = this.karts.filter((k) => !k.finished && !k.remote && !k.out).sort((a, b) => b.progFine - a.progFine);
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
    if (!k.remote) this.net?.onFinish(k);
  }

  // ------------------------------------------------------------------
  // 連線：別台電腦傳來的事件

  /** 遠端車：主武器照「有沒有按著」在這裡模擬（只有打到自己控制的車才算傷害） */
  private stepRemote(k: Kart, dt: number, racing: boolean): void {
    k.firing = Math.max(0, k.firing - dt);
    k.shieldT = Math.max(0, k.shieldT - dt);
    k.shieldBreakT = Math.max(0, k.shieldBreakT - dt);
    k.lockT = Math.max(0, k.lockT - dt);
    k.sinceDamage += dt;
    if (!racing || k.dead || k.finished) {
      k.charge = 0;
      if (k.tether) this.breakTether(k, 'release');
      return;
    }
    // 魚叉繩（只是畫面）：車主放開、時間到，或車主的旗標說已經沒叉住了就收掉
    if (k.tether) {
      const t = k.tether;
      k.tetherT -= dt;
      k.tetherAge += dt;
      if (!k.netFire || k.tetherT <= 0) this.breakTether(k, 'release');
      else if (t.dead || t.out || (k.tetherAge > 0.6 && !k.netTether)) this.breakTether(k, Math.hypot(t.x - k.x, t.z - k.z) < 6 ? 'catch' : 'snap');
    }
    REMOTE_INPUT.firePrimary = k.netFire;
    this.updatePrimary(k, REMOTE_INPUT, dt);
  }

  /** 別人的車（由車主判定）叉住了某台車：畫面上的繩子以車主說的為準 */
  remoteTether(k: Kart, v: Kart): void {
    if (k.dead || k.out || v.dead || v.out || this.state === 'countdown') return;
    k.tetherAge = 0;
    if (k.tether === v) return;
    k.tether = v;
    k.tetherT = tetherTime(k.primaryLvl);
    this.events.push({ t: 'tether', k, v, on: true });
  }

  /** 別人發射了副武器：照同樣的參數生出砲彈 */
  remoteSecondary(k: Kart, p: SecParams): void {
    if (k.dead || k.out || this.state === 'countdown') return;
    this.fireSecondary(k, p);
  }

  /** 自己的車打中別人（由對方的電腦判定）：加集氣、顯示傷害數字 */
  remoteDamage(v: Kart, by: Kart, amount: number): void {
    v.sinceDamage = 0;
    if (by.remote) return;
    by.stats.damage += amount;
    by.addGauge(amount * CFG.gaugePerDamage, (e) => this.events.push({ t: 'kart', k: by, e }));
    if (by.isPlayer) this.events.push({ t: 'dmg', k: v, by, amount, fatal: false });
  }

  /**
   * 別人的車被擊毀（由車主的電腦判定）。
   * countOnly：斷線期間補送來的舊事件（例如電腦車手中途換人跑）——只算擊毀數，不去動現在還在跑的車
   */
  remoteKill(v: Kart, by: Kart | null, countOnly = false): void {
    if (countOnly) {
      v.deaths++;
      if (by && by !== v) by.kills++;
      return;
    }
    if (v.out) return;
    if (!v.dead) {
      v.dead = true;
      v.hp = 0;
      v.deaths++;
      v.streak = 0;
      v.respawnT = CFG.respawnTime;
      const gy = v.y - v.air;
      this.events.push({ t: 'blast', x: v.x, y: v.y + 1, z: v.z, r: 8, gy, kart: true });
    }
    let streak = 0;
    if (by && by !== v) {
      by.kills++;
      by.streak++;
      by.stats.bestStreak = Math.max(by.stats.bestStreak, by.streak);
      streak = by.streak;
      if (!by.remote) {
        if (by.n2o < CFG.maxN2O) by.n2o++;
        else by.gauge = 1;
      }
    }
    this.events.push({ t: 'kill', killer: by, victim: v, streak });
  }

  /** 別人跑完了 */
  remoteFinish(k: Kart, time: number, laps: number[]): void {
    if (k.finished) return;
    k.finished = true;
    k.finishTime = time;
    k.lapTimes = laps;
    if (this.firstFinishT < 0) this.firstFinishT = this.time;
    this.events.push({ t: 'finish', k });
  }

  /** 有人離開房間：車子退出比賽 */
  dropKart(k: Kart): void {
    if (k.out) return;
    k.out = true;
    k.outOrder = ++this.outCount;
    k.dead = true;
    if (k === this.player) return;
    if (this.mode === 'elim' && this.aliveCount === 1 && !this.player.out) this.finish(this.player);
  }

  /** 連線：換人跑這台電腦車手（me = 自己的玩家編號）。接手時從目前顯示的位置繼續開 */
  setBotOwner(k: Kart, owner: number, me: number): void {
    if (!k.bot || k.owner === owner) return;
    const wasRemote = k.remote;
    k.owner = owner;
    k.remote = owner !== me;
    if (wasRemote && !k.remote) {
      k.spinVel = 0;
      k.air = 0;
      k.vy = 0;
      k.yawRate = 0;
    }
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

  /** t 附近 r 公尺內還有幾台車（不算 t 與 not）：電腦判斷電弧槍值不值得開 */
  crowd(t: Kart, r: number, not: Kart): number {
    let n = 0;
    for (const o of this.karts) {
      if (o === t || o === not || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - t.x, dz = o.z - t.z;
      if (dx * dx + dz * dz < r * r) n++;
    }
    return n;
  }

  resetToTrack(k: Kart): void {
    if (k.tether) this.breakTether(k, 'snap');
    k.pullSpeed = 0;
    const s = this.track.samples[k.idx];
    k.branch = null;
    k.runoff = false;
    k.x = s.x;
    k.z = s.z;
    k.y = s.y;
    k.lat = 0;
    k.heading = Math.atan2(s.tx, s.tz);
    k.yawRate = 0;
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
    // 連線：別人的車由他自己的電腦扣血
    if (v.remote) return;
    v.hp -= amount;
    v.sinceDamage = 0;
    // 給 HUD 顯示傷害數字（只有跟玩家有關的才需要）
    if (v.isPlayer || (attacker && attacker.isPlayer)) this.events.push({ t: 'dmg', k: v, by: attacker, amount, fatal: v.hp <= 0 });
    if (attacker && attacker !== v) {
      if (!attacker.remote) {
        attacker.stats.damage += amount;
        // 打中人也會集氣
        if (!dot) attacker.addGauge(amount * CFG.gaugePerDamage, (e) => this.events.push({ t: 'kart', k: attacker, e }));
      } else this.net?.onDamage(v, attacker, amount);
    }
    if (v.hp <= 0) this.destroy(v, attacker);
  }

  private destroy(v: Kart, attacker: Kart | null): void {
    v.hp = 0;
    v.shieldT = 0;
    v.shieldHp = 0;
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
      // 擊毀獎勵：直接送一瓶 N2O（遠端的人由他自己的電腦給）
      if (!attacker.remote) {
        if (attacker.n2o < CFG.maxN2O) attacker.n2o++;
        else attacker.gauge = 1;
      }
    }
    this.events.push({ t: 'blast', x: v.x, y: v.y + 1, z: v.z, r: 8, gy, kart: true });
    this.events.push({ t: 'kill', killer: attacker, victim: v, streak });
    this.net?.onKill(v, attacker);
  }

  /**
   * 後方護盾：從 (sx, sz) 這個方向來的攻擊有沒有被 v 的護盾擋住。
   * 護盾是車尾的一段弧，攻擊來源在車尾方向的扇形（Lv.1 150°、Lv.5 220°）內就擋下
   */
  shieldBlocks(v: Kart, sx: number, sz: number): boolean {
    if (v.shieldT <= 0 || v.dead || v.out) return false;
    const dx = sx - v.x, dz = sz - v.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return false;
    const cos = -(dx * Math.sin(v.heading) + dz * Math.cos(v.heading)) / d;
    return cos > Math.cos(shieldHalfArc(v.secondaryLvl));
  }

  /**
   * 護盾擋下一次攻擊：在護盾上濺出火花，扣護盾耐久，扣光就碎掉（這一下還是擋住了）。
   * 連線時護盾耐久由車主的電腦判定，別人的畫面只顯示擋下的火花
   */
  private blockAt(v: Kart, sx: number, sz: number, dmg = 0, fx = true): void {
    const dx = sx - v.x, dz = sz - v.z;
    const d = Math.max(0.01, Math.hypot(dx, dz));
    if (fx) this.events.push({ t: 'block', k: v, x: v.x + (dx / d) * 2.1, y: v.y + 0.9, z: v.z + (dz / d) * 2.1 });
    if (v.remote || dmg <= 0) return;
    v.shieldHp -= dmg;
    if (v.shieldHp <= 0) this.shatter(v);
  }

  /** 護盾碎掉 */
  shatter(v: Kart): void {
    if (v.shieldT <= 0) return;
    v.shieldT = 0;
    v.shieldHp = 0;
    v.shieldBreakT = 0.5;
    this.events.push({ t: 'shatter', k: v });
  }

  /** 把車撞飛：往 (dx,dz) 方向推、離地、翻滾 */
  private knock(k: Kart, dx: number, dz: number, push: number, lift: number): void {
    if (k.dead || k.invulnT > 0 || k.remote) return;
    push *= k.blastMul;
    lift *= 0.4 + 0.6 * k.blastMul;
    k.vx = k.vx * 0.5 + dx * push;
    k.vz = k.vz * 0.5 + dz * push;
    if (k.air <= 0) k.jumped = false;
    k.hop = false;
    k.y += Math.max(0, 0.05 - k.air);
    k.air = Math.max(k.air, 0.05);
    k.vy = Math.max(k.vy, lift);
    k.spinVel += (this.rng() - 0.5) * 6;
    k.tumble = (this.rng() > 0.5 ? 1 : -1) * 6;
    k.drifting = false;
  }

  /** owner 為 null 表示沒有人該被算擊毀（例如自己撞到爆炸桶），這時所有人都會受傷 */
  /** force：衝擊波把車推開、炸飛的力道倍率（集束圓雷很小） */
  explodeAt(x: number, y: number, z: number, gy: number, radius: number, dmg: number, owner: Kart | null, force = 1): void {
    this.events.push({ t: 'blast', x, y, z, r: radius, gy, kart: false });
    for (const k of this.karts) {
      if (k === owner || k.dead || k.out) continue;
      const dx = k.x - x, dz = k.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius + 1.2) continue;
      // 爆炸中心在護盾後面：整個擋下
      if (this.shieldBlocks(k, x, z)) {
        this.blockAt(k, x, z, dmg * clamp(1 - 0.6 * (d / radius), 0.3, 1));
        continue;
      }
      const f = clamp(1 - 0.6 * (d / radius), 0.3, 1);
      const immune = k.invulnT > 0;
      this.damage(k, dmg * f, owner);
      if (!k.dead && !immune && !k.remote) {
        // 衝擊波：往外推、炸離地面、打轉
        const inv = d > 0.01 ? 1 / d : 0;
        const bm = k.blastMul * force;
        // 小爆炸（集束圓雷）只稍微晃一下、不減速也不炸飛
        const keep = force > 0.5 ? 0.7 : 0.97;
        k.vx = k.vx * keep + dx * inv * 9 * f * bm;
        k.vz = k.vz * keep + dz * inv * 9 * f * bm;
        if (force > 0.5) {
          if (k.air <= 0) k.jumped = false;
          k.hop = false;
          k.y += Math.max(0, 0.05 - k.air);
          k.air = Math.max(k.air, 0.05);
          k.vy = Math.max(k.vy, CFG.blastLift * (0.45 + 0.55 * f) * (0.4 + 0.6 * bm));
        }
        k.spinVel += (this.rng() - 0.5) * 5 * f * force;
        if (force > 0.5) {
          k.tumble = (this.rng() > 0.5 ? 1 : -1) * (4 + 5 * f);
          k.drifting = false;
        }
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
      // 集束圓雷不會被爆炸連鎖引爆（避免 5 顆一起炸）
      if (m.dead || m.fuse > 0 || m.kind === 'cluster') continue;
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

  /** 換介面語言：電腦車手、「你」、沒取名字的玩家換成目前語言的名字（只影響顯示） */
  relabel(): void {
    for (const k of this.karts) if (k.nameKey) k.name = kartLabel(k.nameKey);
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
    // 連線：只有房主決定淘汰誰，其他人等房主的通知
    if (this.net && !this.net.host) return;
    const order = this.results().filter((k) => !k.out);
    const victim = order[order.length - 1];
    if (!victim) return;
    this.eliminate(victim);
    this.net?.onElim(victim);
  }

  /** 淘汰一台車（連線時其他人收到房主的通知也呼叫這裡） */
  eliminate(victim: Kart): void {
    if (victim.out) return;
    this.elimT = CFG.elimInterval;
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
    } else if (this.aliveCount === 1 && !p.out) {
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

  /** 主武器：雷射（蓄力＋冷卻）、魚叉鉤（一次一發、叉住後拉扯），其他照射速連發 */
  private updatePrimary(k: Kart, inp: KartInput, dt: number): void {
    const P = PRIMARY[k.primary];
    if (P.kind === 'laser') this.updateLaser(k, inp, dt);
    else if (P.kind === 'harpoon') this.updateHarpoon(k, inp, P, dt);
    else this.updateGun(k, inp, P, dt);
  }

  private updateWeapons(k: Kart, inp: KartInput, dt: number): void {
    this.updatePrimary(k, inp, dt);

    k.secCd = Math.max(0, k.secCd - dt);
    if (inp.fireSecondary && k.secCd <= 0) {
      const S = SECONDARY[k.secondary];
      k.secCd = S.cooldown * lvl3Mul(k.secondaryLvl);
      const p = this.secParams(k);
      this.fireSecondary(k, p);
      this.net?.onSecondary(k, p);
    }
  }

  /** 副武器的發射參數：亂數種子、導彈鎖定的對象、榴彈預判的落點 */
  private secParams(k: Kart): SecParams {
    const p: SecParams = { seed: Math.floor(this.rng() * 1e9) };
    if (k.secondary === 'missile') {
      const cands = this.karts.filter((o) => o !== k && !o.dead && !o.out && !o.finished && Math.hypot(o.x - k.x, o.z - k.z) < 260);
      const n = k.secondaryLvl >= PERK_LVL5 ? 2 : 1;
      p.targets = [];
      for (let i = 0; i < n && cands.length; i++) p.targets.push(cands.splice(Math.floor(this.rng() * cands.length), 1)[0].netId);
    } else if (k.secondary === 'grenade') {
      const aim = this.grenadeAim(k);
      if (aim) {
        p.ax = aim.x;
        p.az = aim.z;
      }
    }
    return p;
  }

  private fireSecondary(k: Kart, p: SecParams): void {
    switch (k.secondary) {
      case 'rocket': this.fireRocket(k); break;
      case 'grenade': this.fireShell(k, p); break;
      case 'mine': this.dropMine(k); break;
      case 'cluster': this.dropCluster(k, p.seed); break;
      case 'missile': this.fireHoming(k, p.targets ?? []); break;
      case 'shield':
        k.shieldT = shieldTime(k.secondaryLvl);
        k.shieldMax = k.shieldHp = shieldHp(k.secondaryLvl);
        break;
    }
    this.events.push({ t: 'launch', k, kind: k.secondary });
  }

  /** 雷射：按一下開始蓄力，蓄滿自動射出；冷卻用熱量條表示（1 → 0） */
  private updateLaser(k: Kart, inp: KartInput, dt: number): void {
    if (k.overheated) {
      k.heat = Math.max(0, k.heat - dt / laserCooldown(k.primaryLvl));
      if (k.heat <= 0) k.overheated = false;
    }
    if (k.charge > 0) {
      k.charge += dt;
      k.beamLen = this.laserReach(k).len + 1.3;
      if (k.charge >= LASER_CHARGE) {
        k.charge = 0;
        this.fireRail(k);
        k.heat = 1;
        k.overheated = true;
        k.firing = 0.25;
      }
    } else if (inp.firePrimary && !k.overheated) {
      k.charge = dt;
    }
  }

  private updateGun(k: Kart, inp: KartInput, P: PrimaryDef, dt: number): void {
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
      // 持續噴射的武器（火焰、冷凍光束）：畫面上的噴流／光束跟著這個亮
      if (P.kind === 'flame' || P.kind === 'freeze') k.firing = 0.1;
    } else if (k.fireCd < 0) {
      k.fireCd = 0;
    }
    if (!inp.firePrimary || k.overheated) k.heat = Math.max(0, k.heat - 0.4 * dt);
    if (k.heat >= 1) { k.heat = 1; k.overheated = true; }
    if (k.overheated && k.heat < 0.35) k.overheated = false;
  }

  private secDmg(k: Kart): number {
    return SECONDARY[k.secondary].dmg * weaponLvlMul(k.secondaryLvl) * k.dmgMul;
  }

  /** 主武器：全部沿車頭方向（沒有輔助瞄準） */
  private firePrimary(k: Kart, P: PrimaryDef): void {
    const dmg = P.dmg * weaponLvlMul(k.primaryLvl) * k.dmgMul;
    switch (P.kind) {
      case 'flame': return this.fireFlame(k, P, dmg);
      case 'arc': return this.fireArc(k, P, dmg);
      case 'freeze': return this.fireFreeze(k, P, dmg);
      case 'sonic': return this.fireSonic(k, P, dmg);
    }
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
      if (this.shieldBlocks(o, k.x, k.z)) {
        this.blockAt(o, k.x, k.z, dmg, this.rng() < 0.15);
        continue;
      }
      this.damage(o, dmg * (1 - 0.4 * (d / range)), k);
      o.burnT = top ? 4 : BURN_TIME;
      o.burnBy = k;
      this.events.push({ t: 'hit', k: o, by: k, x: o.x, y: o.y + 0.9, z: o.z, w: 'flame' });
    }
    for (const b of this.barrels) if (b.respawnT <= 0 && b.fuse <= 0 && inCone(b.x, b.z, b.y, 0.8) >= 0) { b.fuse = 0.15; b.by = k; }
    for (const m of this.mines) if (!m.dead && m.fuse <= 0 && inCone(m.x, m.z, m.y, 0.5) >= 0) { m.fuse = 0.15; m.by = k; }
    for (const b of this.boulders) if (!b.dead && b.enterT <= 0.45 && inCone(b.x, b.z, b.y - b.r, b.r) >= 0) this.hurtBoulder(b, dmg, k);
  }

  /** 雷射（與冷凍光束、電弧）從槍口沿車頭方向射出，打到護欄或坡面就停住 */
  private laserReach(k: Kart, range = PRIMARY.laser.range): { ox: number; oy: number; oz: number; fx: number; fz: number; tp: number; len: number } {
    const track = this.track;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const ox = k.x + fx * 1.3, oz = k.z + fz * 1.3, oy = k.y + 0.95;
    const tp = Math.tan(k.pitch);
    let len = range;
    let hint = k.idx;
    for (let t = 4; t < range; t += 4) {
      const x = ox + fx * t, z = oz + fz * t;
      hint = track.probe(x, z, hint, 0.6);
      if (!track.probeOn || oy + tp * t < track.probeY - 0.2) { len = Math.max(2, t - 2); break; }
    }
    return { ox, oy, oz, fx, fz, tp, len };
  }

  /**
   * 雷射：貫穿光束。第一台車直接打爆（不管滿不滿血），
   * 之後每穿過一台車威力乘上 laserKeep（隨等級提高）；油桶、地雷、滾石也會被引爆，但不消耗威力。
   */
  private fireRail(k: Kart): void {
    const { ox, oy, oz, fx, fz, tp, len } = this.laserReach(k);
    const w = laserWidth(k.primaryLvl);
    const keep = laserKeep(k.primaryLvl);
    /** 回傳 1 = 打中車（消耗威力）、0 = 打中物件、-1 = 被護盾擋下（光束停在這裡） */
    const hits: { t: number; hit: (p: number) => number }[] = [];
    const ray = (x: number, z: number, r: number): number => {
      const dx = x - ox, dz = z - oz;
      const t = dx * fx + dz * fz;
      if (t < 0 || t > len) return -1;
      return Math.abs(dx * fz - dz * fx) < r ? t : -1;
    };
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const t = ray(o.x, o.z, w);
      if (t < 0 || Math.abs(o.y + 0.9 - (oy + tp * t)) > 2.2) continue;
      hits.push({ t, hit: (p) => {
        if (this.shieldBlocks(o, ox, oz)) {
          this.blockAt(o, ox, oz, o.maxHp * 1.02 * p);
          return -1;
        }
        this.damage(o, Math.min(o.hp + 0.5, o.maxHp * 1.02 * p), k);
        this.events.push({ t: 'hit', k: o, by: k, x: o.x, y: o.y + 0.9, z: o.z, w: 'laser' });
        return 1;
      } });
    }
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const t = ray(b.x, b.z, 0.9);
      if (t >= 0) hits.push({ t, hit: () => { this.detonate(b, k); return 0; } });
    }
    for (const m of this.mines) {
      if (m.dead || m.fuse > 0) continue;
      const t = ray(m.x, m.z, 0.7);
      if (t >= 0) hits.push({ t, hit: () => { m.by = k; this.explodeMine(m); return 0; } });
    }
    for (const b of this.boulders) {
      if (b.dead || b.enterT > 0.45) continue;
      const t = ray(b.x, b.z, b.r);
      if (t >= 0) hits.push({ t, hit: (p) => { this.hurtBoulder(b, 120 * p, k); return 0; } });
    }
    hits.sort((p, q) => p.t - q.t);
    // 電腦的傷害倍率（簡單／普通難度 < 1）也套用在雷射上，玩家永遠是一發打爆
    let power = Math.min(1, k.dmgMul), n = 0, end = len;
    for (const h of hits) {
      if (power < 0.05) break;
      const r = h.hit(power);
      if (r < 0) { end = h.t; break; }
      if (r > 0) { power *= keep; n++; }
    }
    k.beamLen = end + 1.3;
    k.beamHit = n > 0;
    this.events.push({ t: 'rail', k, x: ox, y: oy, z: oz, len: end, hits: n });
  }

  // ------------------------------------------------------------------
  // 功能型主武器：電弧槍、冷凍光束、音波炮、魚叉鉤
  // （遠端車開火也在這裡模擬；只有打到自己控制的車才扣血、結冰、被推、被拖慢——由被打的人自己判定）

  /**
   * 電弧槍：槍口前方窄錐內最近的一台車先被電到，接著電流跳到離它最近、還沒被電過的車（arcJump 公尺內），
   * 每跳一次威力 ×ARC_KEEP，最多再跳 arcHops 台。打到後方護盾：擋下、電流不再往下跳。
   */
  private fireArc(k: Kart, P: PrimaryDef, dmg: number): void {
    const lvl = k.primaryLvl;
    const { ox, oy, oz, fx, fz, tp, len } = this.laserReach(k, P.range);
    let first: Kart | null = null, bt = len;
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - ox, dz = o.z - oz;
      const t = dx * fx + dz * fz;
      if (t < -0.8 || t > bt) continue;
      if (Math.abs(dx * fz - dz * fx) > ARC_W + Math.max(0, t) * P.spread) continue;
      if (Math.abs(o.y + 0.9 - (oy + tp * t)) > 2.4) continue;
      bt = Math.max(0, t);
      first = o;
    }
    const chain: Kart[] = [];
    let cur = first, px = ox, pz = oz, power = 1;
    const jump = arcJump(lvl), maxN = 1 + arcHops(lvl);
    while (cur && chain.length < maxN) {
      chain.push(cur);
      if (this.shieldBlocks(cur, px, pz)) {
        this.blockAt(cur, px, pz, dmg * power);
        break;
      }
      this.events.push({ t: 'hit', k: cur, by: k, x: cur.x, y: cur.y + 0.9, z: cur.z, w: 'arc' });
      this.damage(cur, dmg * power, k);
      power *= ARC_KEEP;
      px = cur.x;
      pz = cur.z;
      // 下一台：離這台最近、還沒被電到的車（不會跳回開火的人）
      let next: Kart | null = null, bd = jump;
      for (const o of this.karts) {
        if (o === k || o.dead || o.out || o.invulnT > 0 || chain.includes(o) || Math.abs(o.y - cur.y) > 3) continue;
        const d = Math.hypot(o.x - cur.x, o.z - cur.z);
        if (d < bd) { bd = d; next = o; }
      }
      cur = next;
    }
    this.events.push({ t: 'zap', k, x: ox, y: oy, z: oz, chain, len: first ? bt : len });
  }

  /**
   * 冷凍光束：打到第一台車就停住；傷害很低，但每次判定都讓對方多結冰一點（chill 0~1），
   * 結冰會讓輪胎抓不住、轉向變鈍、極速降一點（見 Kart.update），沒被照到之後慢慢退冰。
   */
  private fireFreeze(k: Kart, P: PrimaryDef, dmg: number): void {
    const lvl = k.primaryLvl;
    const { ox, oy, oz, fx, fz, tp, len } = this.laserReach(k, P.range);
    let best: Kart | null = null, bt = len;
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - ox, dz = o.z - oz;
      const t = dx * fx + dz * fz;
      if (t < -0.8 || t > bt) continue;
      if (Math.abs(dx * fz - dz * fx) > FREEZE_W) continue;
      if (Math.abs(o.y + 0.9 - (oy + tp * t)) > 2.2) continue;
      bt = Math.max(0, t);
      best = o;
    }
    k.beamHit = !!best;
    k.beamLen = bt + 1.3;
    if (!best) return;
    if (this.shieldBlocks(best, ox, oz)) {
      this.blockAt(best, ox, oz, dmg, this.rng() < 0.2);
      return;
    }
    this.damage(best, dmg, k);
    // 結冰：遠端的車只是畫面（他自己的電腦會判定自己有沒有被照到）
    best.chill = Math.min(1, best.chill + chillRate(lvl) * Math.min(1, k.dmgMul));
    best.chillT = 0;
    if (lvl >= PERK_LVL5) best.chillDeep = true;
    this.events.push({ t: 'hit', k: best, by: k, x: best.x - fx * 0.9, y: best.y + 0.9, z: best.z - fz * 0.9, w: 'freeze' });
  }

  /**
   * 音波炮：車頭前方扇形內的車全部被震到——小傷害，並往旁邊（加一點往前）推開，越遠推得越輕。
   * 對方正好在正前方時，往他離得比較近的路邊推。被推的那一下抓地力變差（才推得動），Lv.5 推去撞牆額外受傷。
   */
  private fireSonic(k: Kart, P: PrimaryDef, dmg: number): void {
    const lvl = k.primaryLvl;
    const h = k.heading, fx = Math.sin(h), fz = Math.cos(h), lx = fz, lz = -fx;
    const range = P.range, half = P.spread;
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - k.x, dz = o.z - k.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < 0.5 || Math.abs(o.y - k.y) > 2.6) continue;
      if (dx * fx + dz * fz <= 0) continue;
      if (Math.abs(wrapAngle(Math.atan2(dx, dz) - h)) > half + Math.atan2(1.1, d)) continue;
      if (this.shieldBlocks(o, k.x, k.z)) {
        this.blockAt(o, k.x, k.z, dmg);
        continue;
      }
      const f = 1 - 0.55 * (d / range);
      this.events.push({ t: 'hit', k: o, by: k, x: o.x - (dx / d) * 1.1, y: o.y + 0.8, z: o.z - (dz / d) * 1.1, w: 'sonic' });
      this.damage(o, dmg * f, k);
      // 推開：只有自己控制的車真的被推（遠端車由他自己的電腦判定）
      if (o.remote || o.dead || o.air > 1.5) continue;
      const side = dx * lx + dz * lz;
      let px: number, pz: number;
      if (Math.abs(side) > 0.6 || o.branch) {
        const sg = Math.sign(side) || 1;
        px = lx * sg;
        pz = lz * sg;
      } else {
        const s = this.track.samples[o.idx], sg = Math.sign(o.lat) || 1;
        px = s.nx * sg;
        pz = s.nz * sg;
      }
      px += fx * 0.45;
      pz += fz * 0.45;
      const pl = Math.hypot(px, pz);
      const imp = (sonicPush(lvl) * f * Math.min(1, k.dmgMul) * o.blastMul) / pl;
      o.vx += px * imp;
      o.vz += pz * imp;
      // 車頭也被往推的方向扭一點（順著被推出去）
      o.spinVel += (px * fz - pz * fx > 0 ? 1 : -1) * 0.6 * f;
      o.shoveT = SHOVE_T;
      o.shoveBy = k;
      o.shoveDmg = lvl >= PERK_LVL5 ? SONIC_SLAM : 0;
    }
    this.events.push({ t: 'pulse', k, x: k.x + fx * 1.6, y: k.y + 0.95, z: k.z + fz * 1.6, a: h, r: range, w: half });
  }

  /** 撞牆：魚叉繩扯斷；剛被音波炮推過來（Lv.5 共振）額外受傷，算在推的人頭上 */
  private onWall(k: Kart): void {
    if (k.tether) this.breakTether(k, 'snap');
    if (k.shoveT > 0 && k.shoveDmg > 0 && k.shoveBy) {
      const by = k.shoveBy, amt = k.shoveDmg;
      k.shoveDmg = 0;
      this.events.push({ t: 'hit', k, by, x: k.x, y: k.y + 0.8, z: k.z, w: 'sonic' });
      this.damage(k, amt, by);
    }
  }

  /**
   * 魚叉鉤：沒叉住東西時按住就射（一次只有一支叉頭在飛）；叉住後按住維持拉扯。
   * 熱量只在放開時散掉，所以拉著繩子也很耗熱量。
   */
  private updateHarpoon(k: Kart, inp: KartInput, P: PrimaryDef, dt: number): void {
    k.fireCd = Math.max(0, k.fireCd - dt);
    const held = inp.firePrimary;
    if (k.tether) {
      // 遠端車的繩子只是畫面（在 stepRemote 處理）
      if (!k.remote) this.updateTether(k, held, dt);
    } else if (held && !k.overheated && k.fireCd <= 0 && !this.hooks.some((h) => h.owner === k)) {
      this.fireHook(k, P);
      k.fireCd = 1 / P.rate;
      k.heat += P.heat * lvl3Mul(k.primaryLvl);
    }
    if (!held || k.overheated) k.heat = Math.max(0, k.heat - 0.4 * dt);
    if (k.heat >= 1) { k.heat = 1; k.overheated = true; }
    if (k.overheated && k.heat < 0.35) k.overheated = false;
  }

  private fireHook(k: Kart, P: PrimaryDef): void {
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const lx = fz, lz = -fx;
    k.gunSide = -k.gunSide;
    const ox = k.x + lx * 0.7 * k.gunSide + fx * 1.6;
    const oz = k.z + lz * 0.7 * k.gunSide + fz * 1.6;
    const oy = k.y + 0.95;
    const sp = HOOK_SPEED + Math.max(0, k.speed);
    this.hooks.push({
      x: ox, y: oy, z: oz, vx: fx * sp, vy: Math.tan(k.pitch) * sp, vz: fz * sp, life: P.range / HOOK_SPEED,
      dmg: P.dmg * weaponLvlMul(k.primaryLvl) * k.dmgMul, owner: k, idx: k.idx, side: k.gunSide,
    });
    this.events.push({ t: 'hook', k, x: ox, y: oy, z: oz, side: k.gunSide });
  }

  /** 飛行中的叉頭：打到車就叉住（開火的人還按著的話），打到護欄或飛完射程就掉落 */
  private updateHooks(dt: number): void {
    const H = this.hooks;
    for (let i = H.length - 1; i >= 0; i--) {
      const h = H[i];
      const o = h.owner;
      const sx = h.vx * dt, sz = h.vz * dt;
      const sl2 = sx * sx + sz * sz;
      let hit: Kart | null = null;
      let ht = 2;
      for (const k of this.karts) {
        if (k === o || k.dead || k.out || k.invulnT > 0) continue;
        const t = clamp(((k.x - h.x) * sx + (k.z - h.z) * sz) / sl2, 0, 1);
        const cx = h.x + sx * t - k.x, cz = h.z + sz * t - k.z;
        if (cx * cx + cz * cz < 2.4 && t < ht && Math.abs(h.y - (k.y + 0.9)) < 2.2) { ht = t; hit = k; }
      }
      const remove = () => { H[i] = H[H.length - 1]; H.pop(); };
      if (!hit && this.hitObject(h.x + sx, h.z + sz, 0.4, o, h.dmg)) { remove(); continue; }
      if (hit) {
        if (this.shieldBlocks(hit, o.x, o.z)) {
          this.blockAt(hit, o.x, o.z, h.dmg);
        } else {
          this.events.push({ t: 'hit', k: hit, by: o, x: h.x + sx * ht, y: h.y, z: h.z + sz * ht, w: 'harpoon' });
          this.damage(hit, h.dmg, o);
          this.latch(o, hit);
        }
        remove();
        continue;
      }
      h.x += sx;
      h.y += h.vy * dt;
      h.z += sz;
      h.life -= dt;
      h.idx = this.track.probe(h.x, h.z, h.idx, 0.7);
      if (!this.track.probeOn || h.y < this.track.probeY) {
        this.events.push({ t: 'impact', x: h.x, y: Math.max(h.y, this.track.probeY + 0.2), z: h.z });
        remove();
        continue;
      }
      if (h.life <= 0) remove();
    }
  }

  /**
   * 叉中了：開火的人（還按著）開始被繩子拉過去；被叉中的人如果是自己控制的車就被拖慢。
   * 開火的人是遠端的車時，這裡的繩子只是畫面（車主會傳來他判定叉住的是誰）
   */
  private latch(s: Kart, v: Kart): void {
    if (!s.netFire || s.dead || s.out || s.finished || v.dead || v.out) return;
    const T = tetherTime(s.primaryLvl);
    if (!s.tether) {
      s.tether = v;
      s.tetherT = T;
      s.tetherAge = 0;
      this.events.push({ t: 'tether', k: s, v, on: true });
      if (!s.remote) this.net?.onTether(s, v);
    }
    if (!v.remote) {
      v.towT = T;
      v.towBy = s;
      v.towAge = 0;
    }
  }

  /** 自己控制的車拉著繩子：追速跟著對方車速，並往對方的方向拉；放開、追上、扯斷就結束 */
  private updateTether(k: Kart, held: boolean, dt: number): void {
    const t = k.tether!;
    k.tetherT -= dt;
    k.tetherAge += dt;
    const dx = t.x - k.x, dz = t.z - k.z;
    const d = Math.hypot(dx, dz);
    const ahead = dx * Math.sin(k.heading) + dz * Math.cos(k.heading);
    if (!held || k.tetherT <= 0) return this.breakTether(k, 'release');
    if (t.dead || t.out || d > ROPE_MAX || Math.abs(t.y - k.y) > 8) return this.breakTether(k, 'snap');
    if (d < 4.2 || ahead < 1.5) return this.breakTether(k, 'catch');
    if (this.ropeBlocked(k, t)) return this.breakTether(k, 'snap');
    k.pullSpeed = Math.min(Math.max(0, t.speed) + pullBonus(k.primaryLvl), k.topSpeed * 1.5);
    // 繩子往對方的方向拉：只拉側向（把車往對方那邊帶），往前的速度由追速決定
    const v = Math.hypot(k.vx, k.vz);
    if (k.air <= 0 && v > 1) {
      const ux = k.vx / v, uz = k.vz / v, rx = dx / d, rz = dz / d;
      const al = rx * ux + rz * uz;
      k.vx += (rx - ux * al) * ROPE_PULL * dt;
      k.vz += (rz - uz * al) * ROPE_PULL * dt;
    }
  }

  /** 繩子中間經過路面以外（彎道內側的牆、捷徑兩側的岩壁）就算被擋住 */
  private ropeBlocked(k: Kart, t: Kart): boolean {
    let hint = k.idx;
    for (const u of [0.3, 0.6, 0.85]) {
      hint = this.track.probe(k.x + (t.x - k.x) * u, k.z + (t.z - k.z) * u, hint, 1.2);
      if (!this.track.probeOn) return true;
    }
    return false;
  }

  /** 魚叉繩斷掉；Lv.5 甩射：收線追上對方的瞬間自動小噴 */
  private breakTether(k: Kart, why: TetherEnd): void {
    const v = k.tether;
    k.tether = null;
    k.tetherT = 0;
    k.pullSpeed = 0;
    if (!v) return;
    if (v.towBy === k && !v.remote) {
      v.towT = 0;
      v.towBy = null;
    }
    if (why === 'catch' && !k.remote && !k.dead && k.primaryLvl >= PERK_LVL5) {
      k.miniT = Math.max(k.miniT, CFG.miniTime * k.miniMul);
      this.events.push({ t: 'kart', k, e: 'mini' });
    }
    this.events.push({ t: 'tether', k, v, on: false, why });
  }

  /**
   * 冷凍、震波、魚叉的狀態（本機與遠端的車都跑：遠端車的只影響畫面）。
   * 結冰沒被照到一小段時間後慢慢退；被魚叉叉住的拖慢由自己判定什麼時候結束。
   */
  private updateStatus(k: Kart, dt: number): void {
    k.chillT += dt;
    if (k.chill > 0 && k.chillT > CHILL_HOLD) {
      k.chill = Math.max(0, k.chill - dt / (k.chillDeep ? CHILL_DECAY_DEEP : CHILL_DECAY));
      if (k.chill <= 0) k.chillDeep = false;
    }
    k.shoveT = Math.max(0, k.shoveT - dt);
    if (k.shoveT <= 0) k.shoveBy = null;
    if (k.dead || k.finished) {
      k.chill = 0;
      k.chillDeep = false;
      k.shoveT = 0;
      k.towT = 0;
      k.towBy = null;
      if (k.tether && !k.remote) this.breakTether(k, 'snap');
      return;
    }
    if (k.towT <= 0) return;
    // 被叉住：叉中自己的人放開、追上、斷掉（遠端的人看他的旗標）或拉太遠就結束
    k.towT -= dt;
    k.towAge += dt;
    const s = k.towBy;
    let live = !!s && !s.dead && !s.out && s.netFire;
    if (live && s) {
      if (!s.remote) live = s.tether === k;
      else if (k.towAge > 0.6) live = s.netTether;
      const dx = k.x - s.x, dz = k.z - s.z;
      if (dx * dx + dz * dz > ROPE_MAX * ROPE_MAX) live = false;
    }
    if (!live || k.towT <= 0) {
      k.towT = 0;
      k.towBy = null;
    }
  }

  /** 火箭：朝正前方直線飛行 */
  private fireRocket(k: Kart): void {
    const S = SECONDARY.rocket;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const twin = k.secondaryLvl >= PERK_LVL5;
    for (const off of twin ? [-0.45, 0.45] : [0]) {
      this.missiles.push({
        x: k.x + fx * 1.6 + fz * off, y: k.y + 0.95, z: k.z + fz * 1.6 - fx * off, a: k.heading, idx: k.idx,
        speed: Math.max(30, k.speed) + 35, life: 3, dmg: this.secDmg(k), radius: S.radius, owner: k,
        homing: false, target: null, age: 0,
      });
    }
  }

  /** 追蹤導彈：從附近的對手裡隨機挑一台鎖定 */
  private fireHoming(k: Kart, targets: number[]): void {
    const S = SECONDARY.missile;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const n = k.secondaryLvl >= PERK_LVL5 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const target = targets[i] !== undefined ? this.karts[targets[i]] ?? null : null;
      const off = n > 1 ? (i ? 0.4 : -0.4) : 0;
      this.missiles.push({
        x: k.x + fx * 1.6 + fz * off, y: k.y + 1.2, z: k.z + fz * 1.6 - fx * off, a: k.heading + off * 0.3, idx: k.idx,
        speed: Math.max(30, k.speed) + 12, life: 6, dmg: this.secDmg(k) * (n > 1 ? 0.55 : 1), radius: S.radius, owner: k,
        homing: true, target, age: 0,
      });
      if (target) {
        target.lockT = 2;
        this.events.push({ t: 'lock', k: target, by: k });
      }
    }
  }

  /**
   * 榴彈預判：車頭前方扇形內最近的對手，沿賽道推算它在砲彈飛行時間後的位置。
   * 太近（會在自己旁邊爆炸）就不瞄。
   */
  grenadeAim(k: Kart): { x: number; z: number; target: Kart } | null {
    const o = this.pickTarget(k, GRENADE_CONE, GRENADE_RANGE, 14);
    if (!o) return null;
    const tr = this.track;
    let x: number, z: number;
    if (o.branch || o.air > 0) {
      x = o.x + o.vx * SHELL_T;
      z = o.z + o.vz * SHELL_T;
    } else {
      const s = tr.samples[tr.wrap(o.idx + Math.round((Math.max(0, o.speed) * SHELL_T) / tr.spacing))];
      x = s.x + s.nx * o.lat;
      z = s.z + s.nz * o.lat;
    }
    if (Math.hypot(x - k.x, z - k.z) < 14) return null;
    return { x, z, target: o };
  }

  /** 榴彈發射器：自動預判對手位置拋射；沒有目標就落在車前約 45 公尺（隨車速往前帶） */
  private fireShell(k: Kart, p: SecParams): void {
    const S = SECONDARY.grenade;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const ox = k.x + fx * 1.4, oz = k.z + fz * 1.4;
    const hv = Math.max(0, k.speed) + 46;
    let vx = fx * hv, vz = fz * hv;
    if (p.ax !== undefined && p.az !== undefined) {
      vx = (p.ax - ox) / SHELL_T;
      vz = (p.az - oz) / SHELL_T;
    }
    this.shells.push({
      x: ox, y: 1 + k.air, z: oz, gy: k.y - k.air, idx: k.idx, vx, vy: SHELL_VY, vz,
      dmg: this.secDmg(k), radius: S.radius, owner: k, sub: false,
    });
  }

  private newMine(k: Kart, kind: 'mine' | 'cluster', x: number, z: number, vx: number, vz: number, R: () => number = this.rng): Mine {
    const S = SECONDARY[kind];
    const idx = this.track.probe(x, z, k.idx);
    return {
      x, y: this.track.probeY, z, vx, vz, idx, owner: k, by: k, kind,
      armT: kind === 'mine' ? 0.8 : 0.35, life: kind === 'mine' ? 45 : 6 + R() * 0.8, fuse: 0,
      dmg: this.secDmg(k), radius: S.radius * (kind === 'mine' && k.secondaryLvl >= PERK_LVL5 ? 1.4 : 1), trigger: kind === 'mine' ? 3.3 : 2.1, dead: false,
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
  private dropCluster(k: Kart, seed: number): void {
    const S = SECONDARY.cluster;
    const R = mulberry32(seed);
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const count = S.count + (k.secondaryLvl >= PERK_LVL5 ? 2 : 0);
    for (let i = 0; i < count; i++) {
      const a = k.heading + Math.PI + (i - (count - 1) / 2) * (count > 5 ? 0.28 : 0.36);
      const sp = 9 + R() * 5;
      this.mines.push(this.newMine(k, 'cluster', k.x - fx * 2, k.z - fz * 2, k.vx * 0.42 + Math.sin(a) * sp, k.vz * 0.42 + Math.cos(a) * sp, R));
    }
  }

  private explodeMine(m: Mine): void {
    if (m.dead) return;
    m.dead = true;
    this.explodeAt(m.x, m.y + 0.5, m.z, m.y, m.radius, m.dmg, m.by, m.kind === 'cluster' ? 0.25 : 1);
  }

  private updateMines(dt: number): void {
    const track = this.track;
    for (const m of this.mines) {
      if (m.dead) continue;
      // 滑動與停下，不會滾出護欄（有緩衝區的路段滾到緩衝區外緣為止）
      if (m.vx !== 0 || m.vz !== 0) {
        m.x += m.vx * dt;
        m.z += m.vz * dt;
        const f = Math.exp(-3.2 * dt);
        m.vx *= f;
        m.vz *= f;
        if (m.vx * m.vx + m.vz * m.vz < 0.04) m.vx = m.vz = 0;
        m.idx = track.probe(m.x, m.z, m.idx);
        const sg = Math.sign(track.lat);
        const lim = track.edgeLat(m.idx, sg) - 0.6;
        if (!track.probeOn && Math.abs(track.lat) > lim) {
          const s = track.samples[m.idx];
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
      if (hit && this.shieldBlocks(hit, b.x - b.vx, b.z - b.vz)) {
        // 從後面打來的子彈打在護盾上
        this.blockAt(hit, b.x - b.vx, b.z - b.vz, b.dmg);
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
      // 離開路面（導彈抄近路飛過內場）時不要用斜率往外推算高度，直接用最近的路面高度
      const roadY = track.probeOn ? track.probeY : track.samples[m.idx].y;
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
          if (d < 18) wantY = Math.min(t.y + 0.9, roadY + HOMING_MAX_ALT);
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
      if (m.homing) {
        // 飛行高度上限：用移動後腳下的路面算（畫面上看到的位置）
        m.idx = track.probe(m.x, m.z, m.idx);
        const g = track.probeOn ? track.probeY : track.samples[m.idx].y;
        m.y = clamp(m.y, g + 0.5, g + HOMING_MAX_ALT);
      }
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
              dmg: s.dmg * 0.28, radius: s.radius * 0.55, owner: s.owner, sub: true,
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
        const TR = tramSpec(h.def);
        const cycle = Math.floor(ph);
        const tau = (ph - cycle) * P;
        const T = (2 * TR.reach) / TR.speed;
        h.dir = cycle % 2 ? 1 : -1;
        h.moving = tau >= TR.warn && tau < TR.warn + T;
        h.warn = tau < TR.warn + T;
        h.c = h.dir * (h.moving ? -TR.reach + TR.speed * (tau - TR.warn) : -TR.reach);
        if (cycle !== h.cycle) {
          if (h.cycle >= 0) this.events.push({ t: 'tram', x: h.x, y: h.y, z: h.z });
          h.cycle = cycle;
        }
        if (dt > 0 && h.moving) this.tramHits(h);
      } else if (h.def.kind !== 'boulder') {
        // 機車、鞭炮、強風（src/game/street.ts）
        updateStreet(this, h, dt);
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
    const TR = tramSpec(h.def);
    for (const k of this.karts) {
      if (k.dead || k.out || k.hazardCd > 0 || k.invulnT > 0 || k.air > 3) continue;
      const dx = k.x - h.x, dz = k.z - h.z;
      const along = dx * h.tx + dz * h.tz;
      const lat = dx * h.nx + dz * h.nz;
      if (Math.abs(along) > TR.width + 1.1 || Math.abs(lat - h.c) > TR.half + 1.1) continue;
      // 火車太快，撞飛的力道跟電車一樣就好（不然會直接飛出地圖）
      this.knock(k, h.nx * h.dir, h.nz * h.dir, TRAM.speed * 1.1, 10);
      this.hazardHit(k, 'tram', TR.dmg);
    }
  }

  private spawnBoulder(h: HazardState): void {
    const tr = this.track, hw = tr.halfWidth;
    const side = this.rng() < 0.5 ? 1 : -1;
    // 從路邊（有緩衝區的話是緩衝區外緣）滾進來
    const out = hw + 5 + tr.runoffW(tr.wrap(Math.round(h.def.dist / tr.spacing)), side);
    this.boulders.push({
      d: h.def.dist + this.rng() * 25, lat: side * out, lat0: side * out, lat1: (this.rng() * 2 - 1) * (hw - 3.2),
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
