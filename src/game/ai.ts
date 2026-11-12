import type { Kart, KartInput } from './kart';
import type { Race } from './race';
import type { Branch } from './track';
import { clamp, wrapAngle } from './util';
import { PRIMARY } from './weapons';

/** 電腦車手：沿賽道前視點行駛，直線用 N2O，前方有目標就開火，會閃地雷與滾石、偶爾走捷徑。 */
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
  /** 車款本身的極速倍率（由 Race 設定） */
  baseSpeedMul = 1;
  /** 這次接近捷徑時決定要不要走 */
  private plan: Branch | null = null;
  private planned: Branch | null = null;
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
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);

    // 變換車道
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTarget = (this.rng() * 2 - 1) * (tr.halfWidth - 4.5);
      this.laneTimer = 2 + this.rng() * 4;
    }
    // 閃避：前方車道上的地雷與滾石
    const dodge = (x: number, z: number, r: number) => {
      const dx = x - k.x, dz = z - k.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 3 || ahead > 42) return;
      const side = dx * fz - dz * fx;
      if (Math.abs(side) > r + 2.4) return;
      this.laneTarget = clamp(this.lane - Math.sign(side || 1) * (r + 4), -(tr.halfWidth - 3), tr.halfWidth - 3);
      this.laneTimer = 1.2;
    };
    for (const m of race.mines) if (m.owner !== k) dodge(m.x, m.z, 0.8);
    for (const b of race.boulders) if (b.enterT < 0.5) dodge(b.x, b.z, b.r);
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * (this.laneTimer < 1.3 ? 2.2 : 0.8));

    // 捷徑：接近分岔點時決定走不走（技術越好越常走）
    for (const b of tr.branches) {
      const ahead = this.ahead(k.idx, b.fromIdx, n);
      if (ahead > 0 && ahead < 110 / tr.spacing && this.planned !== b) {
        this.planned = b;
        this.plan = this.rng() < 0.25 + (this.skill - 0.88) * 3 ? b : null;
      }
      // 已經過了接回點，或錯過入口太遠：放棄這次的計畫
      if (this.planned === b && !k.branch && (this.ahead(k.idx, b.fromIdx + b.span, n) < 0 || this.ahead(k.idx, b.fromIdx, n) < -40 / tr.spacing)) {
        this.planned = null;
        this.plan = null;
      }
    }

    // 前視點
    const look = 9 + sp * 0.5;
    let tgt: { x: number; z: number };
    let curvAhead: (i: number) => number;
    const br = k.branch ?? this.plan;
    const mainLook = (lane: number) => {
      const s = tr.samples[(k.idx + Math.round(look / tr.spacing)) % n];
      return { x: s.x + s.nx * lane, z: s.z + s.nz * lane };
    };
    if (br) {
      // 走捷徑：沿捷徑的中心線，快到分岔點前先靠到那一側
      let bi: number;
      if (k.branch) bi = k.bIdx + Math.round(look / br.spacing);
      else {
        const toFrom = this.ahead(k.idx, br.fromIdx, n) * tr.spacing;
        bi = Math.round((look - toFrom) / br.spacing);
      }
      if (bi < 0) tgt = mainLook(br.def.lat);
      else if (bi < br.n) tgt = br.samples[bi];
      else {
        const s = tr.samples[(br.fromIdx + br.span + Math.round((bi - br.n) * br.spacing / tr.spacing)) % n];
        tgt = { x: s.x + s.nx * br.def.lat, z: s.z + s.nz * br.def.lat };
      }
      const base = k.branch ? k.bIdx : 0;
      curvAhead = (i) => {
        const j = base + Math.round((i * tr.spacing) / br.spacing);
        return j < br.n ? br.samples[j].curv : tr.samples[(br.fromIdx + br.span) % n].curv;
      };
    } else {
      tgt = mainLook(this.lane);
      curvAhead = (i) => tr.samples[(k.idx + i) % n].curv;
    }
    const err = wrapAngle(Math.atan2(tgt.x - k.x, tgt.z - k.z) - k.heading);
    inp.steer = clamp(err * 2.2, -1, 1);

    // 前方彎道決定目標速度
    let kmax = 0;
    const steps = Math.round(70 / tr.spacing);
    for (let i = 0; i < steps; i += 3) {
      const c = Math.abs(curvAhead(i));
      if (c > kmax) kmax = c;
    }
    const vT = 1.3 / (kmax + 1e-4);
    inp.accel = sp < vT ? 1 : sp > vT + 4 ? -1 : 0;
    if (Math.abs(err) > 1.4 && sp > 8) inp.accel = 0;
    // 電車正在通過或快要通過：在平交道前減速
    for (const h of race.hazards) {
      if (h.def.kind !== 'tram' || !h.warn) continue;
      const dx = h.x - k.x, dz = h.z - k.z;
      const ahead = dx * fx + dz * fz;
      if (ahead > 4 && ahead < 16 + sp * 0.9 && Math.abs(h.c) < 30) inp.accel = sp > 6 ? -1 : 0;
    }
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

    // 主武器：沒有輔助瞄準，前方很窄的角度內有車才開火（火焰要夠近）
    const P = PRIMARY[k.primary];
    const target = P.kind === 'flame' ? race.pickTarget(k, 0.24, P.range - 2) : race.pickTarget(k, 0.07, P.kind === 'laser' ? 140 : 95);
    this.burstT -= dt;
    if (target && this.burstT < -this.pause) {
      this.burstT = 0.5 + this.rng() * 0.8;
      this.pause = 0.8 + this.rng() * 2.2;
    }
    inp.firePrimary = !!target && this.burstT > 0;

    // 副武器
    inp.fireSecondary = false;
    if (k.secCd <= 0) {
      let want = false;
      switch (k.secondary) {
        case 'rocket': want = !!race.pickTarget(k, 0.045, 110); break;
        // 榴彈落點固定在車前約 45 公尺，目標在那附近才打
        case 'grenade': want = !!race.pickTarget(k, 0.09, 58, 32); break;
        // 地雷：後面有人跟著才放
        case 'mine': want = !!race.pickTarget(k, 0.3, 45, 4, true); break;
        case 'cluster': want = !!race.pickTarget(k, 0.45, 35, 4, true); break;
        case 'missile': want = race.karts.some((o) => o !== k && !o.dead && !o.out && Math.hypot(o.x - k.x, o.z - k.z) < 200); break;
      }
      if (want) {
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

  /** 從 idx 往前到 target 隔幾個取樣點（負值 = 已經過了） */
  private ahead(idx: number, target: number, n: number): number {
    let d = (((target - idx) % n) + n) % n;
    if (d > n / 2) d -= n;
    return d;
  }

  /** 依與玩家的距離調整速度，讓比賽保持膠著 */
  rubberBand(k: Kart, player: Kart | undefined, race: Race): void {
    let mul = this.skill * this.baseSpeedMul;
    if (player && !player.finished) {
      const gap = (k.prog - player.prog) * race.track.spacing;
      if (gap > 120) mul *= 0.93;
      else if (gap < -120) mul *= 1.06;
    }
    k.maxSpeedMul = mul;
  }
}

