import { CFG } from './config';
import type { Track } from './track';
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

export type KartEvent = 'boost' | 'mini' | 'n2o' | 'wall' | 'driftStart' | 'pad';

export class Kart {
  id: number;
  name: string;
  color: number;
  isPlayer = false;
  /** AI 用的簡化操控：不甩尾，改用較高的轉向率並在過彎時集氣 */
  aiAssist = false;

  // 運動狀態
  x = 0;
  z = 0;
  /** 路面高度（由賽道決定） */
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

  // 甩尾 / N2O
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  driftRelease = 0;
  gauge = 0;
  n2o = 0;
  boostT = 0;
  miniT = 0;
  miniWindowT = 0;
  /** 加速帶效果剩餘時間 */
  padT = 0;

  // 耐久
  hp = CFG.hp;
  maxHp = CFG.hp;
  dead = false;
  respawnT = 0;
  invulnT = 0;
  sinceDamage = 99;
  kills = 0;
  deaths = 0;

  // 賽道進度
  idx = 0;
  lat = 0;
  /** 累積前進的取樣點數（一圈 = track.n） */
  prog = 0;
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

  // 車輛升級
  maxSpeedMul = 1;
  accelMul = 1;
  boostTimeAdd = 0;

  private prevAccel = false;
  private prevBoost = false;

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

  update(dt: number, inp: KartInput, track: Track, emit: (e: KartEvent) => void): void {
    const C = CFG;
    const vmaxBase = this.topSpeed;
    let fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    let sp = Math.hypot(this.vx, this.vz);
    const vf = this.vx * fx + this.vz * fz;
    const reversing = vf < -0.3;

    const accelOn = inp.accel > 0.5;
    const accelEdge = accelOn && !this.prevAccel;
    const boostEdge = inp.boost && !this.prevBoost;
    this.prevAccel = accelOn;
    this.prevBoost = inp.boost;

    // ---- 甩尾開始 ----
    if (!this.drifting && !this.aiAssist && inp.drift && Math.abs(inp.steer) > 0.15 && vf > C.driftMinSpeed) {
      this.drifting = true;
      this.driftDir = Math.sign(inp.steer);
      this.driftTime = 0;
      this.driftRelease = 0;
      this.heading += this.driftDir * C.driftKick;
      emit('driftStart');
    }

    // ---- 轉向 ----
    let omega: number;
    const sameDir = this.drifting ? inp.steer * this.driftDir : 0;
    if (this.drifting) {
      if (sameDir < -0.1) omega = inp.steer * C.driftCounterTurn;
      else if (inp.drift) omega = sameDir > 0.1 ? inp.steer * C.driftTurn : this.driftDir * C.driftIdleTurn;
      // 放開甩尾鍵後：繼續按同方向 = 拖漂，維持滑行角度
      else omega = sameDir > 0.1 ? inp.steer * C.driftHoldTurn : this.driftDir * C.driftIdleTurn * 0.5;
    } else {
      const av = Math.abs(vf);
      const t = clamp((av - 8) / (vmaxBase - 8), 0, 1);
      const hi = this.aiAssist ? C.aiTurnHigh : C.gripTurnHigh;
      const rate = lerp(C.gripTurnLow, hi, t) * Math.min(1, av / 5);
      omega = inp.steer * rate * (reversing ? -1 : 1);
    }
    this.heading = wrapAngle(this.heading + omega * dt);
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
    }
    let dirx = fx, dirz = fz;
    let s: number;
    if (sp > 1 && !reversing) {
      const slip0 = wrapAngle(Math.atan2(this.vx, this.vz) - this.heading);
      const slip = slip0 * Math.exp(-grip * dt);
      sp = Math.max(0, sp - C.driftDrag * Math.abs(Math.sin(slip0)) * dt);
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
      emit('mini');
    } else if (boostEdge && this.n2o > 0 && this.boostT <= 0.15) {
      this.n2o--;
      this.boostT = C.boostTime + this.boostTimeAdd;
      emit('boost');
    }

    // ---- 加減速 ----
    let vmax = vmaxBase;
    const boosting = this.boostT > 0;
    const padOn = this.padT > 0;
    if (boosting) vmax *= C.boostSpeedMul;
    else if (padOn) vmax *= C.padSpeedMul;
    else if (this.miniT > 0) vmax *= C.miniSpeedMul;
    const throttle = inp.accel < -0.1 ? inp.accel : boosting || padOn || this.miniT > 0 ? 1 : inp.accel;
    // 坡度：上坡略減速、下坡略加速
    const sm0 = track.samples[this.idx];
    if (Math.abs(s) > 1) s -= 9.8 * C.slopeGravity * sm0.slope * Math.sign(dirx * sm0.tx + dirz * sm0.tz) * dt;
    if (throttle > 0.05) {
      if (s < vmax) {
        let a: number;
        if (boosting) a = C.boostAccel;
        else if (padOn) a = C.padAccel;
        else if (this.miniT > 0) a = C.miniAccel;
        else {
          const r = Math.max(0, s) / vmax;
          a = C.accel * this.accelMul * Math.max(0.1, 1 - r * r);
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
    let fill = 0;
    if (this.drifting && s > 10) fill += C.gaugeRate * Math.abs(Math.sin(this.slip)) * (s / vmaxBase);
    if (this.aiAssist && s > 18) fill += 0.2 * Math.abs(inp.steer);
    if (s > 15) fill += C.gaugePassive;
    this.gauge += fill * dt;
    if (this.gauge >= 1) {
      if (this.n2o < C.maxN2O) {
        this.n2o++;
        this.gauge = 0;
        emit('n2o');
      } else {
        this.gauge = 1;
      }
    }

    // ---- 甩尾結束 ----
    if (
      this.drifting &&
      ((!inp.drift && this.driftRelease > 0.12 && Math.abs(this.slip) < 0.1) || this.driftRelease >= C.driftRecover || s < 7)
    ) {
      this.drifting = false;
      if (this.driftTime > C.miniMinDrift) this.miniWindowT = C.miniWindow;
    }

    // ---- 護欄碰撞 ----
    this.idx = track.locate(this.x, this.z, this.idx);
    this.lat = track.lat;
    const lim = track.halfWidth - C.kartRadius * 0.8;
    if (Math.abs(this.lat) > lim) {
      const sgn = Math.sign(this.lat);
      const sm = track.samples[this.idx];
      const nx = sm.nx * sgn, nz = sm.nz * sgn;
      const over = Math.abs(this.lat) - lim;
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
      if (vn > 0) {
        this.vx -= nx * vn * 1.3;
        this.vz -= nz * vn * 1.3;
        const k = Math.min(1, vn / 14);
        const loss = C.wallLoss * k;
        this.vx *= 1 - loss;
        this.vz *= 1 - loss;
        this.heading = wrapAngle(this.heading + wrapAngle(tanA - this.heading) * k * 0.4);
        if (vn > 4) {
          this.drifting = false;
          emit('wall');
        }
      }
    }

    // ---- 高度、俯仰與加速帶 ----
    const sm = track.samples[this.idx];
    this.y = track.heightAt(this.idx, this.x, this.z);
    this.pitch = Math.atan(sm.slope) * (Math.sin(this.heading) * sm.tx + Math.cos(this.heading) * sm.tz);
    if (this.padT < C.padTime - 0.4 && track.onPad(this.idx, this.lat)) {
      this.padT = C.padTime;
      emit('pad');
    }
  }
}
