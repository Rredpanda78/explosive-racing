import type { CarId } from './cars';
import { CFG } from './config';
import type { Branch, Sample, Track } from './track';
import { clamp, lerp, wrapAngle } from './util';
import type { PrimaryId, SecondaryId } from './weapons';

export interface KartInput {
  /** +1 = 左，-1 = 右 */
  steer: number;
  /** +1 = 油門，-1 = 煞車／倒車 */
  accel: number;
  drift: boolean;
  boost: boolean;
  firePrimary: boolean;
  fireSecondary: boolean;
}

export const emptyInput = (): KartInput => ({
  steer: 0, accel: 0, drift: false, boost: false, firePrimary: false, fireSecondary: false,
});

export type KartEvent = 'boost' | 'mini' | 'n2o' | 'wall' | 'driftStart' | 'driftFail' | 'pad' | 'jump' | 'land';

export class Kart {
  id: number;
  name: string;
  color: number;
  car: CarId = 'kart-oobi';
  isPlayer = false;
  /** AI 用的簡化操控：不甩尾，改用較高的轉向率並在過彎時集氣 */
  aiAssist = false;
  /** AI 高速時的轉向率與過彎集氣量（依難度） */
  aiTurn = CFG.aiTurnHigh;
  aiGauge = 0.21;

  // 運動狀態
  x = 0;
  z = 0;
  /** 車身高度 = 路面高度 + 斜坡／滯空高度 */
  y = 0;
  /** 車身俯仰角（上坡為正） */
  pitch = 0;
  heading = 0;
  vx = 0;
  vz = 0;
  /** 沿行進方向的速度（倒車為負） */
  speed = 0;
  /** 車頭與行進方向的夾角 */
  slip = 0;
  steerVis = 0;
  /** 離地高度（跳台飛出去或被炸飛之後 > 0） */
  air = 0;
  vy = 0;
  /** 這次離地是不是自己飛越跳台（被炸飛不算，落地沒有獎勵） */
  jumped = false;
  /** 被撞之後的打轉角速度，會逐漸衰減 */
  spinVel = 0;
  /** 被炸飛時車身翻滾的角速度（只影響畫面） */
  tumble = 0;
  /** 質量：重的車撞人時自己比較不動 */
  mass = 1;

  // 甩尾 / N2O
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  driftRelease = 0;
  /** 這次甩尾到目前為止集到的氣（撞牆時要扣回去） */
  driftGain = 0;
  gauge = 0;
  n2o = 0;
  boostT = 0;
  miniT = 0;
  miniWindowT = 0;
  /** 加速帶／起跑衝刺／落地衝刺的剩餘時間 */
  padT = 0;
  /** 尾流累積時間與是否生效（由 Race 判定） */
  draftT = 0;
  drafting = false;

  // 耐久
  hp = CFG.hp;
  maxHp = CFG.hp;
  dead = false;
  /** 淘汰賽中已被淘汰 */
  out = false;
  outOrder = 0;
  respawnT = 0;
  invulnT = 0;
  sinceDamage = 99;
  kills = 0;
  deaths = 0;
  streak = 0;

  // 賽道進度
  idx = 0;
  lat = 0;
  /** 目前開在哪一條捷徑上（null = 主線）、捷徑上的取樣點，以及換算成主線進度的小數部分 */
  branch: Branch | null = null;
  bIdx = 0;
  branchFrac = 0;
  /** 累積前進的取樣點數（一圈 = track.n） */
  prog = 0;
  /** 含小數的進度：排名用，避免兩台車落在同一個取樣點時分不出先後 */
  progFine = 0;
  lapCount = -1;
  lapStart = 0;
  lapTimes: number[] = [];
  finished = false;
  finishTime = 0;
  rank = 1;
  wrongWayT = 0;

  // 武器
  primary: PrimaryId = 'mg';
  secondary: SecondaryId = 'rocket';
  primaryLvl = 1;
  secondaryLvl = 1;
  heat = 0;
  overheated = false;
  fireCd = 0;
  spin = 0;
  secCd = 0;
  gunSide = 1;
  dmgMul = 1;
  /** 火焰／雷射正在發射（畫面用），以及雷射光束的長度與是否打中車 */
  firing = 0;
  beamLen = 0;
  beamHit = false;
  /** 燃燒剩餘秒數與點火的人 */
  burnT = 0;
  burnBy: Kart | null = null;
  /** 被追蹤導彈鎖定的警告時間 */
  lockT = 0;
  /** 剛被機關打到後的保護時間（避免同一個機關連續判定） */
  hazardCd = 0;

  // 車款與升級係數
  maxSpeedMul = 1;
  accelMul = 1;
  boostTimeAdd = 0;
  gaugeMul = 1;
  handling = 1;
  ramMul = 1;

  /** 本場統計（任務判定用） */
  stats = { n2oUsed: 0, driftTime: 0, barrels: 0, airTime: 0, draftTime: 0, damage: 0, bestStreak: 0, perfectStart: false, jumps: 0, shortcuts: 0 };

  /** 倒數時按下油門的時間點（距 GO 還剩幾秒），-1 表示沒按著 */
  launchT = -1;
  private prevAccel = false;
  private prevBoost = false;
  private wasOnPad = false;

  constructor(id: number, name: string, color: number) {
    this.id = id;
    this.name = name;
    this.color = color;
  }

  get boosting(): boolean {
    return this.boostT > 0;
  }

  get topSpeed(): number {
    return CFG.maxSpeed * this.maxSpeedMul;
  }

  get airborne(): boolean {
    return this.air > 0;
  }

  /** 倒數期間追蹤油門：GO 前一小段時間內才按下 = 起跑衝刺 */
  preStart(inp: KartInput, countdown: number): void {
    const on = inp.accel > 0.5;
    // 觸控是自動油門、沒有「按下」的瞬間，所以也接受按 N2O 鍵
    const pressed = (on && !this.prevAccel) || (inp.boost && !this.prevBoost);
    if (pressed) this.launchT = Math.max(countdown, 1e-6);
    if (!on && !inp.boost) this.launchT = -1;
    this.prevAccel = on;
    this.prevBoost = inp.boost;
  }

  addGauge(v: number, emit?: (e: KartEvent) => void): void {
    this.gauge += v * this.gaugeMul;
    if (this.gauge >= 1) {
      if (this.n2o < CFG.maxN2O) {
        this.n2o++;
        this.gauge -= 1;
        if (this.n2o >= CFG.maxN2O) this.gauge = Math.min(this.gauge, 1);
        emit?.('n2o');
      } else {
        this.gauge = 1;
      }
    }
  }

  update(dt: number, inp: KartInput, track: Track, emit: (e: KartEvent) => void): void {
    const C = CFG;
    const vmaxBase = this.topSpeed;
    let fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let sp = Math.hypot(this.vx, this.vz);
    const vf = this.vx * fx + this.vz * fz;
    const reversing = vf < -0.3;
    const flying = this.air > 0;

    const accelOn = inp.accel > 0.5;
    const accelEdge = accelOn && !this.prevAccel;
    const boostEdge = inp.boost && !this.prevBoost;
    this.prevAccel = accelOn;
    this.prevBoost = inp.boost;

    // ---- 甩尾開始 ----
    if (!this.drifting && !this.aiAssist && !flying && inp.drift && Math.abs(inp.steer) > 0.15 && vf > C.driftMinSpeed) {
      this.drifting = true;
      this.driftDir = Math.sign(inp.steer);
      this.driftTime = 0;
      this.driftRelease = 0;
      this.driftGain = 0;
      this.heading += this.driftDir * C.driftKick;
      emit('driftStart');
    }

    // ---- 轉向 ----
    let omega: number;
    const sameDir = this.drifting ? inp.steer * this.driftDir : 0;
    if (flying) {
      omega = inp.steer * 0.55;
    } else if (this.drifting) {
      if (sameDir < -0.1) omega = inp.steer * C.driftCounterTurn;
      else if (inp.drift) omega = sameDir > 0.1 ? inp.steer * C.driftTurn * this.handling : this.driftDir * C.driftIdleTurn;
      // 放開甩尾鍵後：繼續按同方向 = 拖漂，維持滑行角度
      else omega = sameDir > 0.1 ? inp.steer * C.driftHoldTurn * this.handling : this.driftDir * C.driftIdleTurn * 0.5;
    } else {
      const av = Math.abs(vf);
      const t = clamp((av - 8) / (vmaxBase - 8), 0, 1);
      const hi = this.aiAssist ? this.aiTurn : C.gripTurnHigh * this.handling;
      const rate = lerp(C.gripTurnLow, hi, t) * Math.min(1, av / 5);
      omega = inp.steer * rate * (reversing ? -1 : 1);
    }
    // 被撞到的打轉疊加在方向盤之上
    this.heading = wrapAngle(this.heading + (omega + this.spinVel) * dt);
    this.spinVel *= Math.exp(-C.spinDamping * dt);
    fx = Math.sin(this.heading);
    fz = Math.cos(this.heading);
    this.steerVis += (inp.steer - this.steerVis) * Math.min(1, dt * 10);

    // ---- 抓地力：把行進方向往車頭方向拉 ----
    let grip = C.gripNormal;
    if (this.drifting) {
      // 放開後抓地力慢慢恢復：同方向拖漂恢復最慢，反打方向盤最快回正
      if (inp.drift) this.driftRelease = 0;
      else this.driftRelease += dt * (sameDir > 0.1 ? C.driftSustain : sameDir < -0.1 ? C.driftCounterRecover : 1);
      const r = clamp(this.driftRelease / C.driftRecover, 0, 1);
      grip = lerp(C.gripDrift, C.gripNormal, r * r);
      this.driftTime += dt;
      if (!this.finished) this.stats.driftTime += dt;
    }
    if (flying) grip = 0.4; // 空中幾乎不能改變行進方向
    let dirx = fx, dirz = fz;
    let s: number;
    if (sp > 1 && !reversing) {
      const slip0 = wrapAngle(Math.atan2(this.vx, this.vz) - this.heading);
      const slip = slip0 * Math.exp(-grip * dt);
      if (!flying) sp = Math.max(0, sp - C.driftDrag * Math.abs(Math.sin(slip0)) * dt);
      const a = this.heading + slip;
      dirx = Math.sin(a);
      dirz = Math.cos(a);
      this.slip = slip;
      s = sp;
    } else {
      this.slip = 0;
      s = vf;
    }

    // ---- 小噴 / N2O 觸發 ----
    if (this.miniWindowT > 0 && (accelEdge || boostEdge)) {
      this.miniT = C.miniTime;
      this.miniWindowT = 0;
      this.addGauge(C.gaugeMini, emit);
      emit('mini');
    } else if (boostEdge && this.n2o > 0 && this.boostT <= 0.15) {
      this.n2o--;
      this.boostT = C.boostTime + this.boostTimeAdd;
      if (!this.finished) this.stats.n2oUsed++;
      emit('boost');
    }

    // ---- 加減速 ----
    let vmax = vmaxBase;
    const boosting = this.boostT > 0;
    const padOn = this.padT > 0;
    if (boosting) vmax *= C.boostSpeedMul;
    else if (padOn) vmax *= C.padSpeedMul;
    else if (this.miniT > 0) vmax *= C.miniSpeedMul;
    if (this.drafting && !flying) vmax *= C.draftSpeedMul;
    const forced = boosting || padOn || this.miniT > 0;
    const throttle = inp.accel < -0.1 ? inp.accel : forced ? 1 : inp.accel;
    const sm0 = this.surface(track);
    if (flying) {
      // 空中：引擎使不上力，只有 N2O 還能推
      if (boosting && s < vmax) s = Math.min(vmax, s + C.boostAccel * 0.5 * dt);
      else s = Math.max(0, s - 1.2 * dt);
    } else {
      // 坡度：上坡略減速、下坡略加速
      if (Math.abs(s) > 1) s -= 9.8 * C.slopeGravity * sm0.slope * Math.sign(dirx * sm0.tx + dirz * sm0.tz) * dt;
      if (throttle > 0.05) {
        if (s < vmax) {
          let a: number;
          if (boosting) a = C.boostAccel;
          else if (padOn) a = C.padAccel;
          else if (this.miniT > 0) a = C.miniAccel;
          else {
            const r = Math.max(0, s) / vmax;
            a = C.accel * this.accelMul * Math.max(0.1, 1 - r * r) + (this.drafting ? C.draftAccel : 0);
          }
          s = Math.min(vmax, s + a * throttle * dt);
        } else {
          s = Math.max(vmax, s - C.overspeedDecay * dt);
        }
      } else if (throttle < -0.05) {
        if (s > 0.5) s = Math.max(0, s - C.brake * dt);
        else s = Math.max(-C.reverseMax, s - 12 * dt);
      } else {
        if (s > 0) s = Math.max(0, s - C.coast * dt);
        else s = Math.min(0, s + C.coast * dt);
      }
    }

    this.boostT = Math.max(0, this.boostT - dt);
    this.miniT = Math.max(0, this.miniT - dt);
    this.miniWindowT = Math.max(0, this.miniWindowT - dt);
    this.padT = Math.max(0, this.padT - dt);

    this.speed = s;
    this.vx = dirx * s;
    this.vz = dirz * s;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ---- 集氣 ----
    const driftFill = this.drifting && s > 10 ? C.gaugeRate * Math.abs(Math.sin(this.slip)) * (s / vmaxBase) : 0;
    let fill = driftFill;
    if (this.aiAssist && s > 18) fill += this.aiGauge * Math.abs(inp.steer);
    if (s > 15) fill += C.gaugePassive;
    if (this.drafting) {
      fill += C.gaugeDraft;
      if (!this.finished) this.stats.draftTime += dt;
    }
    if (fill > 0) {
      const before = this.n2o + this.gauge;
      this.addGauge(fill * dt, emit);
      // 記下其中屬於甩尾的份量
      if (driftFill > 0) this.driftGain += (this.n2o + this.gauge - before) * (driftFill / fill);
    }

    // ---- 甩尾結束 ----
    if (
      this.drifting &&
      ((!inp.drift && this.driftRelease > 0.12 && Math.abs(this.slip) < 0.1) || this.driftRelease >= C.driftRecover || s < 7 || flying)
    ) {
      this.drifting = false;
      if (this.driftTime > C.miniMinDrift) this.miniWindowT = C.miniWindow;
    }

    // ---- 護欄碰撞（主線與捷徑） ----
    this.collideWalls(dt, track, emit);

    // ---- 高度：路面 + 跳台斜坡 + 滯空 ----
    const sm = this.surface(track);
    const ground = this.branch ? this.branch.heightAt(this.bIdx, this.x, this.z) : track.heightAt(this.idx, this.x, this.z);
    const along = Math.sin(this.heading) * sm.tx + Math.cos(this.heading) * sm.tz;
    let lift = 0;
    let basePitch = Math.atan(sm.slope) * along;
    if (this.air > 0) {
      this.vy -= C.gravity * dt;
      this.air += this.vy * dt;
      if (this.jumped && !this.finished) this.stats.airTime += dt;
      basePitch += clamp(this.vy * 0.025, -0.35, 0.35);
      if (this.air <= 0) {
        this.air = 0;
        this.vy = 0;
        this.tumble = 0;
        // 只有自己飛越跳台落地才有衝刺與集氣
        if (this.jumped) {
          this.padT = Math.max(this.padT, C.landBoostTime);
          this.addGauge(C.gaugeLand, emit);
        }
        this.jumped = false;
        emit('land');
      }
    } else {
      const rp = this.branch ? -1 : track.rampProgress(this.idx, C.rampLength);
      if (rp >= 0 && along > 0.5) {
        lift = rp * C.rampHeight;
        basePitch += Math.atan(C.rampHeight / C.rampLength);
        // 開到斜坡頂端：飛出去
        if (rp >= 0.85 && s > 10) {
          this.air = C.rampHeight;
          this.vy = C.rampVy * clamp(s / vmaxBase, 0.6, 1.35);
          this.jumped = true;
          if (!this.finished) this.stats.jumps++;
          lift = 0;
          emit('jump');
        }
      }
    }
    this.y = ground + this.air + lift;
    this.pitch += (basePitch - this.pitch) * Math.min(1, dt * 14);

    // ---- 加速帶 ----
    // 要先離開加速帶才能再次觸發，停在上面不會一直重複加速
    const onPad = this.air <= 0 && !this.branch && track.onPad(this.idx, this.lat);
    if (onPad && !this.wasOnPad) {
      this.padT = C.padTime;
      this.addGauge(C.gaugePad, emit);
      emit('pad');
    }
    this.wasOnPad = onPad;
  }

  /** 目前腳下路面的取樣點（主線或捷徑） */
  surface(track: Track): Sample {
    return this.branch ? this.branch.samples[this.bIdx] : track.samples[this.idx];
  }

  /**
   * 路面是主線與捷徑的聯集：在任何一條路的範圍內都可以自由行駛，
   * 兩條都超出時才撞牆，推回比較近的那一條。
   */
  private collideWalls(dt: number, track: Track, emit: (e: KartEvent) => void): void {
    const C = CFG;
    const lim = track.halfWidth - C.kartRadius * 0.8;
    const br = this.branch;
    if (br) {
      const bi = br.locate(this.x, this.z);
      const blat = br.lat, inside = br.inside();
      const prog = br.progress(bi, br.along);
      const hint = track.wrap(br.fromIdx + Math.floor(prog));
      const mi = track.locate(this.x, this.z, hint, 40);
      const onMain = Math.abs(track.lat) <= lim && Math.abs(track.along) < track.spacing * 1.5;
      if (onMain || !inside) {
        this.branch = null;
        this.idx = mi;
        this.lat = track.lat;
        if (!onMain) this.pushWall(track.samples[mi], track.lat, lim, dt, emit);
        return;
      }
      this.bIdx = bi;
      this.idx = hint;
      this.branchFrac = prog - Math.floor(prog);
      this.lat = blat;
      const limB = br.halfWidth - C.kartRadius * 0.8;
      if (Math.abs(blat) > limB) this.pushWall(br.samples[bi], blat, limB, dt, emit);
      return;
    }
    this.idx = track.locate(this.x, this.z, this.idx);
    this.lat = track.lat;
    if (Math.abs(this.lat) <= lim) return;
    // 超出主線：如果正好進入捷徑的範圍就切換過去
    const b = track.branchNear(this.x, this.z);
    if (b) {
      const bi = b.locate(this.x, this.z);
      if (b.inside() && Math.abs(b.lat) <= b.halfWidth - C.kartRadius * 0.8) {
        this.branch = b;
        this.bIdx = bi;
        const prog = b.progress(bi, b.along);
        this.idx = track.wrap(b.fromIdx + Math.floor(prog));
        this.branchFrac = prog - Math.floor(prog);
        this.lat = b.lat;
        return;
      }
    }
    this.pushWall(track.samples[this.idx], this.lat, lim, dt, emit);
  }

  private pushWall(sm: Sample, lat: number, lim: number, dt: number, emit: (e: KartEvent) => void): void {
    const C = CFG;
    const sgn = Math.sign(lat);
    const nx = sm.nx * sgn, nz = sm.nz * sgn;
    const over = Math.abs(lat) - lim;
    this.x -= nx * over;
    this.z -= nz * over;
    this.lat = sgn * lim;
    const fxh = Math.sin(this.heading), fzh = Math.cos(this.heading);
    const tanA = Math.atan2(sm.tx, sm.tz) + (fxh * sm.tx + fzh * sm.tz < 0 ? Math.PI : 0);
    // 車頭朝向護欄時，逐漸轉回賽道方向，避免頂著牆動不了
    if (fxh * nx + fzh * nz > 0) {
      this.heading = wrapAngle(this.heading + wrapAngle(tanA - this.heading) * Math.min(1, dt * 4));
    }
    const vn = this.vx * nx + this.vz * nz;
    if (vn <= 0) return;
    this.vx -= nx * vn * 1.3;
    this.vz -= nz * vn * 1.3;
    const k = Math.min(1, vn / 14);
    const loss = C.wallLoss * k;
    this.vx *= 1 - loss;
    this.vz *= 1 - loss;
    this.heading = wrapAngle(this.heading + wrapAngle(tanA - this.heading) * k * 0.4);
    if (vn > 4) {
      if (this.drifting && this.driftGain > 0.001) {
        // 把這次甩尾集到的氣扣回去（包含已經換成整瓶的部分）
        const total = Math.max(0, this.n2o + this.gauge - this.driftGain);
        this.n2o = Math.min(C.maxN2O, Math.floor(total + 1e-6));
        this.gauge = Math.min(1, Math.max(0, total - this.n2o));
        emit('driftFail');
      }
      this.driftGain = 0;
      this.drifting = false;
      emit('wall');
    }
  }
}
