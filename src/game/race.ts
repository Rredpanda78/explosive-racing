import { AIController } from './ai';
import { CAR_IDS, CARS } from './cars';
import { CFG } from './config';
import { Kart, type KartEvent, type KartInput } from './kart';
import { pickMissions, type Mission } from './missions';
import type { Profile } from './save';
import type { Track } from './track';
import { clamp, mulberry32, wrapAngle } from './util';
import { PRIMARY, PRIMARY_IDS, SECONDARY, SECONDARY_IDS, weaponLvlMul } from './weapons';

export type RaceMode = 'race' | 'elim';

export interface Bullet { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; dmg: number; owner: Kart }
/** 火箭：不追蹤，沿發射方向直線飛行 */
export interface Missile { x: number; y: number; z: number; a: number; idx: number; speed: number; life: number; dmg: number; radius: number; owner: Kart }
/** y 為離地高度，gy 為砲彈下方的路面高度 */
export interface Shell { x: number; y: number; z: number; gy: number; idx: number; vx: number; vy: number; vz: number; dmg: number; radius: number; owner: Kart }
/** 爆炸桶：respawnT > 0 表示已引爆等待重生；fuse > 0 表示被旁邊的爆炸波及、即將連鎖引爆 */
export interface Barrel { x: number; y: number; z: number; respawnT: number; fuse: number; by: Kart | null }

export type RaceEvent =
  | { t: 'shot'; k: Kart; x: number; y: number; z: number; side: number }
  | { t: 'hit'; k: Kart; by: Kart; x: number; y: number; z: number }
  | { t: 'blast'; x: number; y: number; z: number; r: number; gy: number; kart: boolean }
  | { t: 'kill'; killer: Kart | null; victim: Kart; streak: number }
  | { t: 'launch'; k: Kart; kind: string }
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
  missions: Mission[];
  events: RaceEvent[] = [];
  state: 'countdown' | 'racing' | 'finished' = 'countdown';
  countdown = 3.4;
  time = 0;
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
        this.ais.set(k, new AIController(rng, 1));
        player = k;
      } else {
        k.aiAssist = true;
        k.car = CAR_IDS[Math.floor(rng() * CAR_IDS.length)];
        k.primary = PRIMARY_IDS[Math.floor(rng() * PRIMARY_IDS.length)];
        k.secondary = SECONDARY_IDS[Math.floor(rng() * SECONDARY_IDS.length)];
        k.dmgMul = CFG.aiDamageMul;
        const skill = 0.88 + 0.1 * (1 - j / Math.max(1, total - 2));
        this.ais.set(k, new AIController(rng, skill));
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
      this.ais.get(k)!.baseSpeedMul = k.maxSpeedMul;
      this.karts.push(k);
    }
    this.player = player;

    // 爆炸桶
    for (const b of track.def.barrels) {
      const s = track.samples[track.wrap(Math.round(b.dist / track.spacing))];
      this.barrels.push({ x: s.x + s.nx * b.lat, y: s.y, z: s.z + s.nz * b.lat, respawnT: 0, fuse: 0, by: null });
    }
    this.missions = pickMissions(rng, mode);
  }

  step(dt: number, pin: KartInput): void {
    const ev = this.events;
    const track = this.track;
    const n = track.n;

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
          k.salvoLeft = 0;
          ev.push({ t: 'respawn', k });
        }
        continue;
      }
      if (!k.finished) k.invulnT = Math.max(0, k.invulnT - dt);
      k.sinceDamage += dt;
      if (k.sinceDamage > CFG.regenDelay && k.hp < k.maxHp) k.hp = Math.min(k.maxHp, k.hp + CFG.regenRate * dt);
      if (!racing) continue;

      const inp = useAI ? ai.think(k, this, dt) : pin;
      const prevIdx = k.idx;
      k.update(dt, inp, track, (e) => ev.push({ t: 'kart', k, e }));

      // 進度與圈數
      let d = k.idx - prevIdx;
      if (d > n / 2) d -= n;
      else if (d < -n / 2) d += n;
      k.prog += d;
      const sp = track.samples[k.idx];
      k.progFine = k.prog + ((k.x - sp.x) * sp.tx + (k.z - sp.z) * sp.tz) / track.spacing;
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
      const sm = track.samples[k.idx];
      if (k.vx * sm.tx + k.vz * sm.tz < -3) k.wrongWayT += dt;
      else k.wrongWayT = 0;

      if (!k.finished) this.updateWeapons(k, inp, dt);
    }

    if (racing) {
      this.collideKarts();
      this.updateDraft(dt);
      this.updateBarrels(dt);
      this.updateBullets(dt);
      this.updateMissiles(dt);
      this.updateShells(dt);
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
    k.salvoLeft = 0;
    if (this.firstFinishT < 0) this.firstFinishT = this.time;
    this.events.push({ t: 'finish', k });
  }

  /** 找車頭前方圓錐內最近的車。只給 AI 判斷開火時機用，武器本身不會自動瞄準 */
  pickTarget(k: Kart, cone: number, range: number, minDist = 2): Kart | null {
    let best: Kart | null = null;
    let bs = Infinity;
    for (const o of this.karts) {
      if (o === k || o.dead || o.out || o.invulnT > 0) continue;
      const dx = o.x - k.x, dz = o.z - k.z;
      const d = Math.hypot(dx, dz);
      if (d > range || d < minDist) continue;
      const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - k.heading));
      if (ang > cone) continue;
      const score = d * (1 + (ang / cone) * 1.5);
      if (score < bs) { bs = score; best = o; }
    }
    return best;
  }

  resetToTrack(k: Kart): void {
    const s = this.track.samples[k.idx];
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

  damage(v: Kart, amount: number, attacker: Kart | null): void {
    if (v.dead || v.out || v.invulnT > 0 || this.state === 'countdown' || amount <= 0) return;
    v.hp -= amount;
    v.sinceDamage = 0;
    if (attacker && attacker !== v) {
      attacker.stats.damage += amount;
      // 打中人也會集氣
      attacker.addGauge(amount * CFG.gaugePerDamage, (e) => this.events.push({ t: 'kart', k: attacker, e }));
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
    v.salvoLeft = 0;
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
        k.vx = k.vx * 0.7 + dx * inv * 9 * f;
        k.vz = k.vz * 0.7 + dz * inv * 9 * f;
        if (k.air <= 0) k.jumped = false;
        k.air = Math.max(k.air, 0.05);
        k.vy = Math.max(k.vy, CFG.blastLift * (0.45 + 0.55 * f));
        k.spinVel += (this.rng() - 0.5) * 5 * f;
        k.tumble = (this.rng() > 0.5 ? 1 : -1) * (4 + 5 * f);
        k.drifting = false;
      }
    }
    // 波及附近的爆炸桶：延遲一點點引爆，形成連鎖
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (radius + 1.5) * (radius + 1.5)) {
        b.fuse = 0.12 + this.rng() * 0.1;
        b.by = owner;
      }
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
    victim.salvoLeft = 0;
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

  /** 子彈或火箭打到爆炸桶：回傳被打中的桶 */
  private barrelAt(x: number, z: number, r: number): Barrel | null {
    for (const b of this.barrels) {
      if (b.respawnT > 0 || b.fuse > 0) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < r * r) return b;
    }
    return null;
  }

  private updateWeapons(k: Kart, inp: KartInput, dt: number): void {
    const P = PRIMARY[k.primary];
    k.fireCd -= dt;
    if (P.spinUp > 0) k.spin = clamp(k.spin + (inp.firePrimary && !k.overheated ? dt : -dt * 1.5) / P.spinUp, 0, 1);
    else k.spin = inp.firePrimary ? 1 : 0;
    const canFire = inp.firePrimary && !k.overheated && (P.spinUp <= 0 || k.spin >= 1);
    if (canFire) {
      let guard = 0;
      while (k.fireCd <= 0 && guard++ < 4) {
        this.firePrimary(k);
        k.fireCd += 1 / P.rate;
        k.heat += P.heat;
      }
    } else if (k.fireCd < 0) {
      k.fireCd = 0;
    }
    if (!inp.firePrimary || k.overheated) k.heat = Math.max(0, k.heat - 0.4 * dt);
    if (k.heat >= 1) { k.heat = 1; k.overheated = true; }
    if (k.overheated && k.heat < 0.35) k.overheated = false;

    k.secCd = Math.max(0, k.secCd - dt);
    if (inp.fireSecondary && k.secCd <= 0 && k.salvoLeft <= 0) {
      const S = SECONDARY[k.secondary];
      k.secCd = S.cooldown;
      if (k.secondary === 'howitzer') {
        this.fireShell(k);
        this.events.push({ t: 'launch', k, kind: 'howitzer' });
      } else {
        k.salvoLeft = S.count;
        k.salvoT = 0;
      }
    }
    // 火箭：單發或連射
    if (k.salvoLeft > 0) {
      k.salvoT -= dt;
      while (k.salvoLeft > 0 && k.salvoT <= 0) {
        const S = SECONDARY[k.secondary];
        const i = S.count - k.salvoLeft;
        // 多管火箭左右交錯、略微散開
        const off = S.count > 1 ? (i - (S.count - 1) / 2) * 0.035 : 0;
        this.fireRocket(k, off, i);
        this.events.push({ t: 'launch', k, kind: 'rocket' });
        k.salvoLeft--;
        k.salvoT += 0.11;
      }
    }
  }

  private dmgScale(k: Kart): number {
    return k.dmgMul;
  }

  /** 主武器：沿車頭方向直射（只有武器本身的散布，沒有輔助瞄準） */
  private firePrimary(k: Kart): void {
    const P = PRIMARY[k.primary];
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const lx = fz, lz = -fx;
    k.gunSide = -k.gunSide;
    const ox = k.x + lx * 0.7 * k.gunSide + fx * 1.2;
    const oz = k.z + lz * 0.7 * k.gunSide + fz * 1.2;
    const oy = k.y + 0.95;
    const dmg = P.dmg * weaponLvlMul(k.primaryLvl) * this.dmgScale(k);
    for (let i = 0; i < P.pellets; i++) {
      const a = k.heading + (this.rng() * 2 - 1) * P.spread;
      const sp = CFG.bulletSpeed * (P.pellets > 1 ? 0.8 + this.rng() * 0.3 : 1);
      this.bullets.push({
        x: ox, y: oy, z: oz,
        vx: Math.sin(a) * sp, vy: Math.tan(k.pitch) * sp, vz: Math.cos(a) * sp,
        life: P.range / sp, dmg, owner: k,
      });
    }
    this.events.push({ t: 'shot', k, x: ox, y: oy, z: oz, side: k.gunSide });
  }

  /** 火箭：朝正前方直線飛行。angle 為相對車頭的偏角，n 是連射中的第幾枚 */
  private fireRocket(k: Kart, angle: number, n: number): void {
    const S = SECONDARY[k.secondary];
    const a = k.heading + angle;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const side = S.count > 1 ? (n % 2 ? 0.25 : -0.25) : 0;
    this.missiles.push({
      x: k.x + fx * 1.6 + fz * side, y: k.y + 0.95, z: k.z + fz * 1.6 - fx * side, a, idx: k.idx,
      speed: Math.max(30, k.speed) + 25, life: 3.5,
      dmg: S.dmg * weaponLvlMul(k.secondaryLvl) * this.dmgScale(k), radius: S.radius,
      owner: k,
    });
  }

  /** 榴彈砲：固定仰角朝前拋射，落點約在車前 45 公尺（隨車速往前帶） */
  private fireShell(k: Kart): void {
    const S = SECONDARY.howitzer;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hv = Math.max(0, k.speed) + 46;
    this.shells.push({
      x: k.x + fx * 1.4, y: 1 + k.air, z: k.z + fz * 1.4, gy: k.y - k.air, idx: k.idx, vx: fx * hv, vy: SHELL_VY, vz: fz * hv,
      dmg: S.dmg * weaponLvlMul(k.secondaryLvl) * this.dmgScale(k), radius: S.radius, owner: k,
    });
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
        if (k === b.owner || k.dead || k.out || k.invulnT > 0) continue;
        const t = clamp(((k.x - b.x) * sx + (k.z - b.z) * sz) / sl2, 0, 1);
        const cx = b.x + sx * t - k.x, cz = b.z + sz * t - k.z;
        if (cx * cx + cz * cz < 2.1 && t < ht && Math.abs(b.y - (k.y + 0.9)) < 2.2) { ht = t; hit = k; }
      }
      const barrel = hit ? null : this.barrelAt(b.x + sx, b.z + sz, 1.25);
      if (barrel) {
        this.detonate(barrel, b.owner);
        B[i] = B[B.length - 1];
        B.pop();
        continue;
      }
      if (hit) {
        this.events.push({ t: 'hit', k: hit, by: b.owner, x: b.x + sx * ht, y: b.y + b.vy * dt * ht, z: b.z + sz * ht });
        this.damage(hit, b.dmg, b.owner);
        B[i] = B[B.length - 1];
        B.pop();
        continue;
      }
      b.x += sx;
      b.y += b.vy * dt;
      b.z += sz;
      b.life -= dt;
      if (b.life <= 0) {
        B[i] = B[B.length - 1];
        B.pop();
      }
    }
  }

  private updateMissiles(dt: number): void {
    const M = this.missiles;
    const wallLat = this.track.halfWidth + 0.4;
    for (let i = M.length - 1; i >= 0; i--) {
      const m = M[i];
      m.speed = Math.min(95, m.speed + 70 * dt);
      m.x += Math.sin(m.a) * m.speed * dt;
      m.z += Math.cos(m.a) * m.speed * dt;
      // 高度貼著附近的路面；飛出護欄就爆炸
      m.idx = this.track.locate(m.x, m.z, m.idx, 45);
      const hitWall = Math.abs(this.track.lat) > wallLat;
      m.y += (this.track.samples[m.idx].y + 0.95 - m.y) * Math.min(1, dt * 8);
      m.life -= dt;
      let boom = m.life <= 0 || hitWall || !!this.barrelAt(m.x, m.z, 1.8);
      for (const k of this.karts) {
        if (k === m.owner || k.dead || k.out) continue;
        const dx = k.x - m.x, dz = k.z - m.z;
        if (dx * dx + dz * dz < 6.5) { boom = true; break; }
      }
      if (boom) {
        this.explodeAt(m.x, m.y, m.z, this.track.samples[m.idx].y, m.radius, m.dmg, m.owner);
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
      s.idx = this.track.locate(s.x, s.z, s.idx, 45);
      s.gy += (this.track.samples[s.idx].y - s.gy) * Math.min(1, dt * 10);
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
      }
    }
  }
}
