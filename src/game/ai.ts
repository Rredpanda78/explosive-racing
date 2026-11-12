import type { Kart, KartInput } from './kart';
import type { Race } from './race';
import { clamp, wrapAngle } from './util';

/** 電腦車手：沿賽道前視點行駛，直線用 N2O，前方有目標就開火。 */
export class AIController {
  lane: number;
  laneTarget: number;
  laneTimer = 0;
  boostDelay: number;
  secDelay: number;
  stuckT = 0;
  burstT = 0;
  pause = 1;
  /** 0.9 ~ 1.0，越高越快 */
  skill: number;
  private rng: () => number;
  private inp: KartInput = { steer: 0, accel: 0, drift: false, boost: false, firePrimary: false, fireSecondary: false };

  constructor(rng: () => number, skill: number) {
    this.rng = rng;
    this.skill = skill;
    this.lane = 0;
    this.laneTarget = 0;
    this.boostDelay = 1 + rng() * 3;
    this.secDelay = 1 + rng() * 3;
  }

  think(k: Kart, race: Race, dt: number): KartInput {
    const tr = race.track;
    const inp = this.inp;
    const sp = Math.max(0, k.speed);
    const n = tr.n;

    // 變換車道
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTarget = (this.rng() * 2 - 1) * (tr.halfWidth - 4.5);
      this.laneTimer = 2 + this.rng() * 4;
    }
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 0.8);

    // 前視點
    const look = 9 + sp * 0.5;
    const ti = (k.idx + Math.round(look / tr.spacing)) % n;
    const s = tr.samples[ti];
    const tx = s.x + s.nx * this.lane;
    const tz = s.z + s.nz * this.lane;
    const err = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.heading);
    inp.steer = clamp(err * 2.2, -1, 1);

    // 前方彎道決定目標速度
    let kmax = 0;
    const steps = Math.round(70 / tr.spacing);
    for (let i = 0; i < steps; i += 3) {
      const c = Math.abs(tr.samples[(k.idx + i) % n].curv);
      if (c > kmax) kmax = c;
    }
    const vT = 1.3 / (kmax + 1e-4);
    inp.accel = sp < vT ? 1 : sp > vT + 4 ? -1 : 0;
    if (Math.abs(err) > 1.4 && sp > 8) inp.accel = 0;
    inp.drift = false;

    // N2O：直線才用
    inp.boost = false;
    if (k.n2o > 0 && k.boostT <= 0 && kmax < 0.012 && sp > 15) {
      this.boostDelay -= dt;
      if (this.boostDelay <= 0) {
        inp.boost = true;
        this.boostDelay = 1 + this.rng() * 4;
      }
    }

    // 武器：沒有輔助瞄準，前方很窄的角度內有車才開火
    const target = race.pickTarget(k, 0.07, 95);
    this.burstT -= dt;
    if (target && this.burstT < -this.pause) {
      this.burstT = 0.5 + this.rng() * 0.8;
      this.pause = 0.8 + this.rng() * 2.2;
    }
    inp.firePrimary = !!target && this.burstT > 0;
    inp.fireSecondary = false;
    if (k.secCd <= 0) {
      // 火箭要正對目標；榴彈落點固定在車前約 45 公尺，目標在那附近才打
      const st = k.secondary === 'rocket' ? race.pickTarget(k, 0.045, 110) : race.pickTarget(k, 0.09, 58, 32);
      if (st) {
        this.secDelay -= dt;
        if (this.secDelay <= 0) {
          inp.fireSecondary = true;
          this.secDelay = 1.5 + this.rng() * 4;
        }
      }
    }

    // 卡住太久就重置到賽道中央
    if (race.state !== 'countdown' && sp < 3) this.stuckT += dt;
    else this.stuckT = 0;
    if (this.stuckT > 2.5) {
      this.stuckT = 0;
      race.resetToTrack(k);
    }
    return inp;
  }

  /** 依與玩家的距離調整速度，讓比賽保持膠著 */
  rubberBand(k: Kart, player: Kart | undefined, race: Race): void {
    let mul = this.skill;
    if (player && !player.finished) {
      const gap = (k.prog - player.prog) * race.track.spacing;
      if (gap > 120) mul *= 0.93;
      else if (gap < -120) mul *= 1.06;
    }
    k.maxSpeedMul = mul;
  }
}
