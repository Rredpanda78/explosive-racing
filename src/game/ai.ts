import { CFG } from './config';
import type { Difficulty } from './difficulty';
import type { Kart, KartInput } from './kart';
import type { Race } from './race';
import type { Branch } from './track';
import { clamp, wrapAngle } from './util';
import { arcJump, PRIMARY } from './weapons';

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
  private D: Difficulty;
  /** 上一幀是否在彎道中（出彎時給小噴） */
  private inCorner = false;
  private planned: Branch | null = null;
  private rng: () => number;
  private inp: KartInput = { steer: 0, accel: 0, drift: false, boost: false, firePrimary: false, fireSecondary: false };

  constructor(rng: () => number, skill: number, D: Difficulty) {
    this.rng = rng;
    this.skill = skill;
    this.D = D;
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
    // 賽車線：前方 20–70 公尺有彎就切到內側（閃避優先）
    let lineRate = 0.8;
    if (this.D.line && this.laneTimer >= 1.3) {
      let c = 0;
      for (let i = Math.round(20 / tr.spacing); i < Math.round(70 / tr.spacing); i += 3) {
        const ci = tr.samples[(k.idx + i) % n].curv;
        if (Math.abs(ci) > Math.abs(c)) c = ci;
      }
      this.laneTarget = Math.abs(c) > 0.012 ? Math.sign(c) * (tr.halfWidth - 3.5) * Math.min(1, Math.abs(c) / 0.025) : this.laneTarget * 0.98;
      lineRate = 1.6;
    }
    for (const m of race.mines) if (m.owner !== k) dodge(m.x, m.z, 0.8);
    for (const b of race.boulders) if (b.enterT < 0.5) dodge(b.x, b.z, b.r);
    // 被擠到路邊的緩衝區：從比較近的那一側斜斜地切回路面（不要一回來就橫越整條路）
    if (!k.branch && (k.runoff || Math.abs(k.lat) > tr.halfWidth + 0.5)) {
      this.lane = this.laneTarget = Math.sign(k.lat) * (tr.halfWidth - 4.5);
      this.laneTimer = Math.max(this.laneTimer, 1);
    }
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * (this.laneTimer < 1.3 ? 2.2 : lineRate));

    // 捷徑：接近分岔點時決定走不走（技術越好越常走）
    for (const b of tr.branches) {
      const ahead = this.ahead(k.idx, b.fromIdx, n);
      if (ahead > 0 && ahead < 110 / tr.spacing && this.planned !== b) {
        this.planned = b;
        // 碎石、泥地的捷徑要帶著 N2O 才划算
        this.plan = this.rng() < this.D.shortcut && (!b.def.rough || k.n2o > 0 || k.boostT > 0) ? b : null;
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
      else if (bi < br.n) {
        // 捷徑上的障礙物：前面 30 公尺內有的話，直接瞄準它旁邊的空隙（從離路中央較遠的另一側過）
        const here = k.branch ? k.bIdx * br.spacing : 0;
        let aim: { x: number; z: number } | null = null;
        for (const p of br.posts) {
          const ahead = p.d - here;
          if (ahead < 1 || ahead > 30) continue;
          const ps = br.samples[Math.min(br.n - 1, Math.round(p.d / br.spacing))];
          const side = -Math.sign(p.lat || 1);
          const pass = clamp(p.lat + side * (p.r + 2.1), -(br.halfWidth - 1.0), br.halfWidth - 1.0);
          aim = { x: ps.x + ps.nx * pass, z: ps.z + ps.nz * pass };
          break;
        }
        tgt = aim ?? br.samples[bi];
      }
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
    const vT = this.D.corner / (kmax + 1e-4);
    // 出彎小噴：模擬玩家甩尾後的加速
    const here = Math.abs(curvAhead(0));
    if (this.D.miniBoost && !k.isPlayer) {
      if (here > 0.02) this.inCorner = true;
      else if (this.inCorner && here < 0.008) {
        this.inCorner = false;
        if (sp > 15) k.miniT = Math.max(k.miniT, CFG.miniTime);
      }
    }
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
    // 開進碎石、泥地的捷徑就開 N2O
    if (k.branch?.def.rough && k.n2o > 0 && k.boostT <= 0) inp.boost = true;
    if (k.n2o > 0 && k.boostT <= 0 && kmax < 0.012 && sp > 15) {
      this.boostDelay -= dt;
      if (this.boostDelay <= 0) {
        inp.boost = true;
        this.boostDelay = this.D.boostDelay[0] + this.rng() * (this.D.boostDelay[1] - this.D.boostDelay[0]);
      }
    }

    // 主武器：沒有輔助瞄準，前方很窄的角度內有車才開火（火焰要夠近）
    const P = PRIMARY[k.primary];
    let target: Kart | null;
    switch (P.kind) {
      case 'flame': target = race.pickTarget(k, 0.24, P.range - 2); break;
      // 雷射一發就能打爆人，要瞄得很準才開
      case 'laser': target = race.pickTarget(k, 0.035, 120); break;
      // 電弧槍：前面有一群車（目標旁邊還有車可以跳）就開；只有一台的話要夠近才值得
      case 'arc': {
        const t = race.pickTarget(k, 0.09, P.range - 2);
        target = t && (race.crowd(t, arcJump(k.primaryLvl), k) > 0 || Math.hypot(t.x - k.x, t.z - k.z) < 20) ? t : null;
        break;
      }
      // 冷凍光束、音波炮：近距離、正前方的車
      case 'freeze': target = race.pickTarget(k, 0.05, P.range - 3); break;
      case 'sonic': target = race.pickTarget(k, 0.3, P.range - 3); break;
      // 魚叉鉤：在直線上、前方遠處有車（落後一段）才射，用來追上去
      case 'harpoon': {
        const t = race.pickTarget(k, 0.045, P.range - 4, 22);
        target = t && kmax < 0.012 && k.heat < 0.6 && sp > 12 ? t : null;
        break;
      }
      default: target = race.pickTarget(k, 0.07, 95);
    }
    this.burstT -= dt;
    if (target && this.burstT < -this.pause) {
      this.burstT = this.D.burst[0] + this.rng() * (this.D.burst[1] - this.D.burst[0]) + P.spinUp;
      this.pause = this.D.pause[0] + this.rng() * (this.D.pause[1] - this.D.pause[0]);
    }
    inp.firePrimary = !!target && this.burstT > 0;
    // 魚叉叉住了：一直按著讓繩子把自己拉過去（追上、斷掉時自然放開）
    if (P.kind === 'harpoon' && k.tether) inp.firePrimary = true;

    // 副武器
    inp.fireSecondary = false;
    if (k.secCd <= 0) {
      let want = false;
      switch (k.secondary) {
        case 'rocket': want = !!race.pickTarget(k, 0.06, 110); break;
        // 榴彈會自動預判，前方扇形內有對手就打
        case 'grenade': want = !!race.grenadeAim(k); break;
        // 地雷：後面有人跟著才放
        case 'mine': want = !!race.pickTarget(k, 0.3, 45, 4, true); break;
        case 'cluster': want = !!race.pickTarget(k, 0.45, 35, 4, true); break;
        case 'missile': want = race.karts.some((o) => o !== k && !o.dead && !o.out && Math.hypot(o.x - k.x, o.z - k.z) < 200); break;
        // 護盾：被導彈鎖定，或後面 35 公尺內有人跟著
        case 'shield': want = k.lockT > 0 || !!race.pickTarget(k, 0.6, 35, 3, true); break;
      }
      if (want) {
        this.secDelay -= dt;
        if (this.secDelay <= 0) {
          inp.fireSecondary = true;
          this.secDelay = this.D.secDelay[0] + this.rng() * (this.D.secDelay[1] - this.D.secDelay[0]);
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
      if (gap > 120) mul *= this.D.ahead;
      else if (gap < -90) mul *= this.D.behind;
    }
    k.maxSpeedMul = mul;
  }
}

