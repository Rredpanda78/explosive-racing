import { AIController } from './ai';
import { CFG } from './config';
import { Kart, type KartEvent, type KartInput } from './kart';
import type { Profile } from './save';
import type { Track } from './track';
import { clamp, mulberry32, wrapAngle } from './util';
import { PRIMARY, SECONDARY, weaponLvlMul, type PrimaryId, type SecondaryId } from './weapons';

export interface Bullet { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; dmg: number; owner: Kart }
/** 火箭：不追蹤，沿發射方向直線飛行 */
export interface Missile { x: number; y: number; z: number; a: number; idx: number; speed: number; life: number; dmg: number; radius: number; owner: Kart }
/** y 為離地高度，gy 為當下參考地面高度（從發射者高度漸變到目標高度） */
export interface Shell { x: number; y: number; z: number; gy: number; idx: number; vx: number; vy: number; vz: number; dmg: number; radius: number; owner: Kart }

export type RaceEvent =
  | { t: 'shot'; k: Kart; x: number; y: number; z: number; side: number }
  | { t: 'hit'; k: Kart; by: Kart; x: number; y: number; z: number }
  | { t: 'blast'; x: number; y: number; z: number; r: number; gy: number; kart: boolean }
  | { t: 'kill'; killer: Kart | null; victim: Kart }
  | { t: 'launch'; k: Kart; kind: SecondaryId }
  | { t: 'kart'; k: Kart; e: KartEvent }
  | { t: 'lap'; k: Kart; lap: number; time: number }
  | { t: 'finish'; k: Kart }
  | { t: 'respawn'; k: Kart }
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
  karts: Kart[] = [];
  player: Kart;
  ais = new Map<Kart, AIController>();
  bullets: Bullet[] = [];
  missiles: Missile[] = [];
  shells: Shell[] = [];
  events: RaceEvent[] = [];
  state: 'countdown' | 'racing' | 'finished' = 'countdown';
  countdown = 3.4;
  time = 0;
  /** 測試用：玩家也交給 AI 開 */
  autoPlayer = false;
  private lastCount = 4;
  private rng: () => number;

  constructor(track: Track, profile: Profile, seed = (Date.now() & 0x7fffffff)) {
    this.track = track;
    const rng = (this.rng = mulberry32(seed));
    const total = CFG.racers;
    const primaries: PrimaryId[] = ['mg', 'vulcan'];
    const secondaries: SecondaryId[] = ['rocket', 'howitzer'];
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
      k.lat = side * 4.5;
      if (isP) {
        k.isPlayer = true;
        k.primary = profile.primary;
        k.secondary = profile.secondary;
        k.primaryLvl = profile.lvl[profile.primary];
        k.secondaryLvl = profile.lvl[profile.secondary];
        k.maxSpeedMul = 1 + 0.015 * profile.car.engine;
        k.accelMul = 1 + 0.03 * profile.car.engine;
        k.boostTimeAdd = 0.2 * profile.car.n2o;
        k.maxHp = CFG.hp + 12 * profile.car.armor;
        k.hp = k.maxHp;
        this.ais.set(k, new AIController(rng, 1));
        player = k;
      } else {
        k.aiAssist = true;
        k.primary = primaries[Math.floor(rng() * 2)];
        k.secondary = secondaries[Math.floor(rng() * 2)];
        k.dmgMul = CFG.aiDamageMul;
        const skill = 0.86 + 0.1 * (1 - j / (total - 2));
        this.ais.set(k, new AIController(rng, skill));
      }
      this.karts.push(k);
    }
    this.player = player;
  }

  step(dt: number, pin: KartInput): void {
    const ev = this.events;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const c = Math.ceil(this.countdown);
      if (c < this.lastCount && c > 0 && c <= 3) {
        this.lastCount = c;
        ev.push({ t: 'count', n: c });
      }
      if (this.countdown <= 0) {
        this.state = 'racing';
        ev.push({ t: 'go' });
      }
    } else {
      this.time += dt;
    }
    const racing = this.state !== 'countdown';
    const track = this.track;
    const n = track.n;

    for (const k of this.karts) {
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
      const lc = Math.floor(k.prog / n);
      if (lc > k.lapCount) {
        if (k.lapCount >= 0) {
          const lt = this.time - k.lapStart;
          k.lapTimes.push(lt);
          ev.push({ t: 'lap', k, lap: lc, time: lt });
        }
        k.lapCount = lc;
        k.lapStart = this.time;
        if (lc >= track.laps && !k.finished) {
          k.finished = true;
          k.finishTime = this.time;
          k.aiAssist = true;
          k.drifting = false;
          k.invulnT = 1e9;
          ev.push({ t: 'finish', k });
        }
      }
      const sm = track.samples[k.idx];
      if (k.vx * sm.tx + k.vz * sm.tz < -3) k.wrongWayT += dt;
      else k.wrongWayT = 0;

      if (!k.finished) this.updateWeapons(k, inp, dt);
    }

    if (racing) {
      this.collideKarts();
      this.updateBullets(dt);
      this.updateMissiles(dt);
      this.updateShells(dt);
    }
    this.updateRanks();
    if (this.state === 'racing' && this.player.finished) this.state = 'finished';
  }

  /** 找車頭前方圓錐內最近的車。只給 AI 判斷開火時機用，武器本身不會自動瞄準 */
  pickTarget(k: Kart, cone: number, range: number, minDist = 2): Kart | null {
    let best: Kart | null = null;
    let bs = Infinity;
    for (const o of this.karts) {
      if (o === k || o.dead || o.invulnT > 0) continue;
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
    k.drifting = false;
    k.boostT = 0;
    k.miniT = 0;
    k.padT = 0;
  }

  damage(v: Kart, amount: number, attacker: Kart | null): void {
    if (v.dead || v.invulnT > 0 || this.state === 'countdown') return;
    v.hp -= amount;
    v.sinceDamage = 0;
    if (v.hp <= 0) {
      v.hp = 0;
      v.dead = true;
      v.deaths++;
      v.respawnT = CFG.respawnTime;
      v.drifting = false;
      v.boostT = 0;
      v.vx = v.vz = 0;
      v.speed = 0;
      if (attacker && attacker !== v) attacker.kills++;
      this.events.push({ t: 'blast', x: v.x, y: v.y + 1, z: v.z, r: 8, gy: v.y, kart: true });
      this.events.push({ t: 'kill', killer: attacker, victim: v });
    }
  }

  explodeAt(x: number, y: number, z: number, gy: number, radius: number, dmg: number, owner: Kart): void {
    this.events.push({ t: 'blast', x, y, z, r: radius, gy, kart: false });
    for (const k of this.karts) {
      if (k === owner || k.dead) continue;
      const dx = k.x - x, dz = k.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius + 1.2) continue;
      const f = clamp(1 - 0.6 * (d / radius), 0.3, 1);
      const wasInvuln = k.invulnT > 0;
      this.damage(k, dmg * f, owner);
      if (!k.dead && !wasInvuln) {
        const inv = d > 0.01 ? 1 / d : 0;
        k.vx = k.vx * 0.7 + dx * inv * 8 * f;
        k.vz = k.vz * 0.7 + dz * inv * 8 * f;
      }
    }
  }

  results(): Kart[] {
    return [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.prog - a.prog;
    });
  }

  // ------------------------------------------------------------------

  private updateRanks(): void {
    const order = this.results();
    for (let i = 0; i < order.length; i++) order[i].rank = i + 1;
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
        this.fireBullet(k);
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
    if (inp.fireSecondary && k.secCd <= 0) {
      const S = SECONDARY[k.secondary];
      k.secCd = S.cooldown;
      if (k.secondary === 'rocket') this.fireRocket(k);
      else this.fireShell(k);
      this.events.push({ t: 'launch', k, kind: k.secondary });
    }
  }

  /** 主武器：沿車頭方向直射（只有武器本身的散布，沒有輔助瞄準） */
  private fireBullet(k: Kart): void {
    const P = PRIMARY[k.primary];
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const lx = fz, lz = -fx;
    k.gunSide = -k.gunSide;
    const ox = k.x + lx * 0.7 * k.gunSide + fx * 1.2;
    const oz = k.z + lz * 0.7 * k.gunSide + fz * 1.2;
    const oy = k.y + 0.95;
    const a = k.heading + (this.rng() * 2 - 1) * P.spread;
    this.bullets.push({
      x: ox, y: oy, z: oz,
      vx: Math.sin(a) * CFG.bulletSpeed, vy: Math.tan(k.pitch) * CFG.bulletSpeed, vz: Math.cos(a) * CFG.bulletSpeed,
      life: P.range / CFG.bulletSpeed,
      dmg: P.dmg * weaponLvlMul(k.primaryLvl) * k.dmgMul,
      owner: k,
    });
    this.events.push({ t: 'shot', k, x: ox, y: oy, z: oz, side: k.gunSide });
  }

  /** 火箭炮：朝正前方直線飛行 */
  private fireRocket(k: Kart): void {
    const S = SECONDARY.rocket;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    this.missiles.push({
      x: k.x + fx * 1.6, y: k.y + 0.95, z: k.z + fz * 1.6, a: k.heading, idx: k.idx,
      speed: Math.max(30, k.speed) + 25, life: 3.5,
      dmg: S.dmg * weaponLvlMul(k.secondaryLvl) * k.dmgMul, radius: S.radius,
      owner: k,
    });
  }

  /** 榴彈砲：固定仰角朝前拋射，落點約在車前 45 公尺（隨車速往前帶） */
  private fireShell(k: Kart): void {
    const S = SECONDARY.howitzer;
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hv = Math.max(0, k.speed) + 46;
    this.shells.push({
      x: k.x + fx * 1.4, y: 1, z: k.z + fz * 1.4, gy: k.y, idx: k.idx, vx: fx * hv, vy: SHELL_VY, vz: fz * hv,
      dmg: S.dmg * weaponLvlMul(k.secondaryLvl) * k.dmgMul, radius: S.radius, owner: k,
    });
  }

  private collideKarts(): void {
    const K = this.karts;
    const R = CFG.kartRadius * 1.9;
    for (let i = 0; i < K.length; i++) {
      const a = K[i];
      if (a.dead) continue;
      for (let j = i + 1; j < K.length; j++) {
        const b = K[j];
        if (b.dead) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const pen = (R - d) * 0.5;
        a.x -= nx * pen; a.z -= nz * pen;
        b.x += nx * pen; b.z += nz * pen;
        const rvn = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (rvn > 0) {
          const imp = rvn * 0.6;
          a.vx -= nx * imp; a.vz -= nz * imp;
          b.vx += nx * imp; b.vz += nz * imp;
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
        if (k === b.owner || k.dead || k.invulnT > 0) continue;
        const t = clamp(((k.x - b.x) * sx + (k.z - b.z) * sz) / sl2, 0, 1);
        const cx = b.x + sx * t - k.x, cz = b.z + sz * t - k.z;
        if (cx * cx + cz * cz < 2.1 && t < ht) { ht = t; hit = k; }
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
      let boom = m.life <= 0 || hitWall;
      for (const k of this.karts) {
        if (k === m.owner || k.dead) continue;
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
          if (k === s.owner || k.dead) continue;
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
