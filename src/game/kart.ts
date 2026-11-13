import type { CarId } from './cars';
import { CFG } from './config';
import { KERB_WIDTH, type Branch, type Post, type Sample, type Track } from './track';
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

export type KartEvent = 'boost' | 'mini' | 'n2o' | 'wall' | 'driftStart' | 'driftFail' | 'pad' | 'jump' | 'land' | 'chain' | 'combo' | 'driftCancel' | 'hardDrift' | 'hop' | 'fall' | 'post';

export class Kart {
  id: number;
  name: string;
  color: number;
  car: CarId = 'kart-oobi';
  isPlayer = false;
  /** 連線：這台車由別台電腦控制（只顯示收到的狀態，不在這裡跑物理、不在這裡扣血） */
  remote = false;
  /** 電腦車手（連線時 owner 是負責跑它的玩家） */
  bot = false;
  /** 連線：控制這台車的玩家編號與車在名單裡的編號 */
  owner = 0;
  netId = 0;
  /** 連線：遠端車目前有沒有按著主武器（這裡照著模擬子彈、雷射） */
  netFire = false;
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
  /** 這一幀的油門（-1 倒車 ~ 1 全油門；引擎聲用） */
  gas = 0;
  /** 這次離地是不是自己飛越跳台（被炸飛不算，落地沒有獎勵） */
  jumped = false;
  /** 衝過坡頂輕輕飛起（操控照常，只有高度在飛） */
  hop = false;
  /** 從沒有護欄的捷徑摔下去：剩餘的掉落秒數（結束後回到主線） */
  fallT = 0;
  private hopT = 0;
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
  /** 甩尾鍵第一次按住的時間；放開得夠快就是短漂 */
  private driftKeyT = 0;
  private driftHeld = false;
  shortDrift = false;
  /** 這次長漂是短漂接上來的（集氣加成） */
  chainDrift = false;
  private chainShown = false;
  private sinceShort = 99;
  /** 連噴計數與距離上次小噴的時間 */
  combo = 0;
  private comboT = 99;
  /** 斷飄後的寬限時間（煞車不減速） */
  private cancelT = 0;
  private prevBrake = false;
  /** 目前的轉向角速度（平滑跟上方向盤）與還沒轉完的甩尾甩動角度 */
  yawRate = 0;
  private kick = 0;
  /** 重甩剩餘時間；雙擊偵測用的方向狀態 */
  hardT = 0;
  private steerDir = 0;
  private lastDir = 0;
  private steerGap = 99;
  private tapDir = 0;
  private tapAge = 99;
  /** 操控輔助（只有玩家，由設定決定）：甩完自動小噴、甩尾自動回正並限制角度 */
  autoMini = false;
  driftAssist = false;
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
  /** 開在路緣外的砂石緩衝區裡（軟邊界）：沒有加速效果時極速變低、甩尾不集氣 */
  runoff = false;
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
  /** 雷射蓄力中的秒數（0 = 沒在蓄力） */
  charge = 0;
  /** 後方護盾剩餘秒數、剩餘耐久，以及剛碎掉的時間（畫面與連線用） */
  shieldT = 0;
  shieldHp = 0;
  shieldMax = 1;
  shieldBreakT = 0;
  /** 剛被機關打到後的保護時間（避免同一個機關連續判定） */
  hazardCd = 0;

  // 車款專屬特性與花色
  livery = 0;
  spareN2O = false;
  miniMul = 1;
  draftMul = 1;
  blastMul = 1;
  afterburn = false;

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
    // 甩尾中不算倒車（滑角過大時車頭朝後，之前會被當成倒車、速度瞬間歸零）
    const reversing = vf < -0.3 && !this.drifting;
    // 坡頂的小飛躍不影響操控
    if (this.air <= 0) this.hop = false;
    const flying = this.air > 0 && !this.hop;

    // ---- 雙擊同方向：放開方向後很快又按回同一邊 ----
    const sd = Math.abs(inp.steer) > 0.15 ? Math.sign(inp.steer) : 0;
    this.tapAge += dt;
    if (sd !== this.steerDir) {
      if (sd === 0) this.steerGap = 0;
      else if (this.steerDir === 0 && sd === this.lastDir && this.steerGap < C.hardTapWindow) {
        this.tapDir = sd;
        this.tapAge = 0;
      }
      if (sd !== 0) this.lastDir = sd;
      this.steerDir = sd;
    } else if (sd === 0) this.steerGap += dt;

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
      this.driftKeyT = 0;
      this.driftHeld = true;
      this.shortDrift = false;
      this.chainDrift = this.sinceShort < C.chainWindow;
      this.chainShown = false;
      this.kick += this.driftDir * C.driftKick;
      emit('driftStart');
    }
    // ---- 重甩：甩尾中（或甩尾前一刻）同方向雙擊 ----
    if (this.drifting && this.tapAge < 0.3 && this.tapDir === this.driftDir) {
      this.tapAge = 99;
      this.hardT = C.hardDriftTime;
      this.shortDrift = false;
      this.driftRelease = 0;
      this.kick += this.driftDir * C.hardKick;
      emit('hardDrift');
    }
    this.hardT = this.drifting ? Math.max(0, this.hardT - dt) : 0;
    const hk = clamp(this.hardT / 0.3, 0, 1);
    this.sinceShort += dt;
    this.comboT += dt;
    this.cancelT = Math.max(0, this.cancelT - dt);

    // ---- 斷飄：甩尾中點一下煞車，立刻結束甩尾、保留速度 ----
    const brakeOn = inp.accel < -0.5;
    const brakeEdge = brakeOn && !this.prevBrake;
    this.prevBrake = brakeOn;
    if (this.drifting && brakeEdge) {
      this.drifting = false;
      this.cancelT = C.cancelGrace;
      if (!this.shortDrift && this.driftTime > C.miniMinDrift) this.miniWindowT = C.miniWindow;
      emit('driftCancel');
    }

    // ---- 短漂／長漂：第一次放開甩尾鍵時判斷 ----
    if (this.drifting && this.driftHeld) {
      if (inp.drift) {
        this.driftKeyT += dt;
        if (this.chainDrift && !this.chainShown && this.driftKeyT >= C.shortDriftKey) {
          this.chainShown = true;
          emit('chain');
        }
      } else {
        this.driftHeld = false;
        this.shortDrift = this.driftKeyT < C.shortDriftKey && this.hardT <= 0;
      }
    }

    // ---- 轉向 ----
    let omega: number;
    /** 甩尾的速度補償（極速以上才生效）：轉向與行進方向跟上車頭都按比例加快 */
    const spdK = clamp(sp / C.maxSpeed, 1, 1.45);
    const sameDir = this.drifting ? inp.steer * this.driftDir : 0;
    if (flying) {
      omega = inp.steer * 0.55;
    } else if (this.drifting) {
      if (sameDir < -0.1) omega = inp.steer * C.driftCounterTurn;
      else if (inp.drift) omega = sameDir > 0.1 ? inp.steer * C.driftTurn * this.handling : this.driftDir * C.driftIdleTurn;
      // 放開甩尾鍵後：繼續按同方向 = 拖漂，維持滑行角度
      else omega = sameDir > 0.1 ? inp.steer * C.driftHoldTurn * this.handling : this.driftDir * C.driftIdleTurn * 0.5;
      // 重甩：往甩尾方向轉得更快（反打不受影響）
      if (sameDir >= -0.1) omega *= 1 + (C.hardTurnMul - 1) * hk;
      // 速度越快轉得越快：N2O、加速帶、小噴時甩尾的圈不會被拉大（否則同一個彎有時過得去、有時轉不過）
      omega *= spdK;
    } else {
      const av = Math.abs(vf);
      const t = clamp((av - 8) / (vmaxBase - 8), 0, 1);
      const hi = this.aiAssist ? this.aiTurn : C.gripTurnHigh * this.handling;
      const rate = lerp(C.gripTurnLow, hi, t) * Math.min(1, av / 5);
      omega = inp.steer * rate * (reversing ? -1 : 1);
    }
    // 角速度平滑跟上方向盤（滑行感）；甩尾開始的甩動也分幾幀轉完，不會一下跳過去
    const resp = this.aiAssist ? 40 : flying ? 6 : this.drifting ? C.yawRespDrift : C.yawResp;
    this.yawRate += (omega - this.yawRate) * (1 - Math.exp(-resp * dt));
    const kk = this.kick * Math.min(1, dt * 16);
    this.kick -= kk;
    // 被撞到的打轉疊加在方向盤之上
    this.heading = wrapAngle(this.heading + (this.yawRate + this.spinVel) * dt + kk);
    this.spinVel *= Math.exp(-C.spinDamping * dt);
    fx = Math.sin(this.heading);
    fz = Math.cos(this.heading);
    this.steerVis += (inp.steer - this.steerVis) * Math.min(1, dt * 10);

    // ---- 抓地力：把行進方向往車頭方向拉 ----
    let grip = C.gripNormal;
    if (this.drifting) {
      // 放開後抓地力慢慢恢復：同方向拖漂恢復最慢，反打方向盤最快回正
      if (inp.drift) this.driftRelease = 0;
      else {
        let rate = sameDir > 0.1 ? C.driftSustain : sameDir < -0.1 ? C.driftCounterRecover : 1;
        if (this.shortDrift) rate = Math.max(rate, 1) * C.shortDriftRecover;
        // 甩尾輔助：沒有繼續按同方向就自動回正
        if (this.driftAssist && sameDir <= 0.1) rate = Math.max(rate, C.driftCounterRecover);
        this.driftRelease += dt * rate;
      }
      const r = clamp(this.driftRelease / C.driftRecover, 0, 1);
      grip = lerp(C.gripDrift, C.gripNormal, r * r) * spdK;
      this.driftTime += dt;
      if (!this.finished) this.stats.driftTime += dt;
    }
    // 重甩：抓地力更低，車尾甩得更開
    if (hk > 0) grip = lerp(grip, Math.min(grip, C.hardGrip), hk);
    if (flying) grip = 0.4; // 空中幾乎不能改變行進方向
    // 甩尾輔助：限制最大甩尾角度（重甩時放寬）
    if (this.drifting && this.driftAssist && Math.abs(this.slip) > (hk > 0 ? 0.95 : 0.6)) grip = Math.max(grip, 6);
    let dirx = fx, dirz = fz;
    let s: number;
    if (sp > 1 && !reversing) {
      const slip0 = wrapAngle(Math.atan2(this.vx, this.vz) - this.heading);
      let slip = slip0 * Math.exp(-grip * dt);
      // 甩尾滑角上限：連續重甩、N2O 中重甩會甩過 90 度，車頭朝後就會突然停下來
      if (this.drifting && Math.abs(slip) > C.maxDriftSlip) slip = Math.sign(slip) * C.maxDriftSlip;
      // 短漂與斷飄後減速比較少
      // 一般過彎的小滑角不太減速（滑行感），甩尾才明顯減速
      const dragMul = this.cancelT > 0 ? 0 : !this.drifting ? 0.35 : (this.shortDrift ? C.shortDriftDrag : 1) * (1 + (C.hardDrag - 1) * hk);
      if (!flying) sp = Math.max(0, sp - C.driftDrag * dragMul * Math.abs(Math.sin(slip0)) * dt);
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
    const autoMini = this.autoMini && this.miniWindowT > 0 && !this.drifting && this.miniWindowT < C.miniWindow - 0.06;
    if (this.miniWindowT > 0 && (accelEdge || boostEdge || autoMini)) {
      this.miniT = C.miniTime * this.miniMul;
      this.miniWindowT = 0;
      // 連噴：上一次小噴不久又小噴
      this.combo = this.comboT < C.comboWindow ? this.combo + 1 : 1;
      this.comboT = 0;
      this.addGauge(C.gaugeMini * (1 + 0.5 * (this.combo - 1)), emit);
      emit('mini');
      if (this.combo >= 2) emit('combo');
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
    if (this.drafting && !flying) vmax *= 1 + (C.draftSpeedMul - 1) * this.draftMul;
    // 捷徑的碎石、泥地：沒有 N2O、小噴、加速帶時跑不快
    const rough = this.branch?.def.rough;
    if (rough && !boosting && !padOn && this.miniT <= 0 && !flying) vmax *= rough;
    const forced = boosting || padOn || this.miniT > 0;
    // 路邊的緩衝區：跟碎石捷徑一樣，沒有加速效果時跑不快；沙地、草地還會把速度很快吃掉（鋪面不會）
    const sand = this.runoff && !forced && !flying;
    const ro = C.runoffSurfaces[track.runoffSurface];
    if (sand) vmax *= ro.speed;
    const throttle = inp.accel < -0.1 ? inp.accel : forced ? 1 : inp.accel;
    this.gas = throttle;
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
            a = C.accel * this.accelMul * Math.max(0.1, 1 - r * r) + (this.drafting ? C.draftAccel * this.draftMul : 0);
          }
          s = Math.min(vmax, s + a * throttle * dt);
        } else {
          s = Math.max(vmax, s - C.overspeedDecay * dt);
        }
      } else if (throttle < -0.05) {
        if (this.cancelT > 0) { /* 斷飄的那一下煞車不減速 */ }
        else if (s > 0.5) s = Math.max(0, s - C.brake * dt);
        else s = Math.max(-C.reverseMax, s - 12 * dt);
      } else {
        if (s > 0) s = Math.max(0, s - C.coast * dt);
        else s = Math.min(0, s + C.coast * dt);
      }
      if (sand && s > vmax && ro.drag > 0) s = Math.max(vmax, s - ro.drag * dt);
    }

    const wasBoost = this.boostT > 0;
    this.boostT = Math.max(0, this.boostT - dt);
    // 後燃器：N2O 噴完接一次小噴
    if (this.afterburn && wasBoost && this.boostT <= 0) {
      this.miniT = C.miniTime * this.miniMul;
      emit('mini');
    }
    this.miniT = Math.max(0, this.miniT - dt);
    if (!this.drifting) this.miniWindowT = Math.max(0, this.miniWindowT - dt);
    this.padT = Math.max(0, this.padT - dt);

    this.speed = s;
    this.vx = dirx * s;
    this.vz = dirz * s;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ---- 集氣（在路邊的緩衝區甩尾不集氣） ----
    const driftFill = this.drifting && s > 10 && !this.runoff
      ? C.gaugeRate * Math.abs(Math.sin(this.slip)) * (s / vmaxBase) * (this.shortDrift ? C.shortDriftGauge : 1) * (this.chainDrift && !this.shortDrift ? C.chainGauge : 1)
        // 開著 N2O 甩尾：集氣加成
        * (this.boostT > 0 ? C.boostDriftGauge : 1)
      : 0;
    let fill = driftFill;
    if (this.aiAssist && s > 18 && !this.runoff) fill += this.aiGauge * Math.abs(inp.steer);
    if (s > 15) fill += C.gaugePassive;
    if (this.drafting) {
      fill += C.gaugeDraft * this.draftMul;
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
      if (this.shortDrift) this.sinceShort = 0;
      else if (this.driftTime > C.miniMinDrift) this.miniWindowT = C.miniWindow;
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
      this.vy -= (this.hop ? C.hopGravity : C.gravity) * dt;
      // 用絕對高度積分：腳下的路往下掉時離地更高（下坡起跳飛得更遠）
      this.air = this.y + this.vy * dt - ground;
      if (this.hop) this.hopT += dt;
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
        // 坡頂小飛躍：飛得夠久才算落地（落地特效）
        if (!this.hop || this.hopT > 0.3) emit('land');
        this.jumped = false;
        this.hop = false;
      }
    } else {
      // 跳台只鋪在路面上：開在旁邊的緩衝區不會被彈起來
      const rp = this.branch || Math.abs(this.lat) > track.halfWidth ? -1 : track.rampProgress(this.idx, C.rampLength);
      if (rp >= 0 && along > 0.5) {
        lift = rp * C.rampHeight;
        basePitch += Math.atan(C.rampHeight / C.rampLength);
        // 開到斜坡頂端：飛出去
        if (rp >= 0.85 && s > 10) {
          this.air = C.rampHeight;
          this.vy = C.rampVy * clamp(s / vmaxBase, 0.6, 1.35);
          this.jumped = true;
          this.hop = false;
          if (!this.finished) this.stats.jumps++;
          lift = 0;
          emit('jump');
        }
      } else if (!this.branch && s > C.hopMinSpeed && along > 0.5) {
        // 坡頂：路面往下彎得比「重力」還快，車子就會輕輕飛起來
        const a = track.samples[track.wrap(this.idx - 3)], b = track.samples[track.wrap(this.idx + 3)];
        const kv = (b.slope - a.slope) / (6 * track.spacing);
        if (-kv * s * s > C.hopGravity && sm.slope < 0.03 && sm.slope > -0.06) {
          this.hop = true;
          this.hopT = 0;
          this.jumped = false;
          this.vy = s * sm.slope * along;
          this.air = 0.01;
          emit('hop');
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
    this.runoff = false;
    if (br) {
      const bi = br.locate(this.x, this.z);
      const blat = br.lat, inside = br.inside();
      const prog = br.progress(bi, br.along);
      const hint = track.wrap(br.fromIdx + Math.floor(prog));
      const mi = track.locate(this.x, this.z, hint, 40);
      const nearMain = Math.abs(track.along) < track.spacing * 1.5;
      const onMain = Math.abs(track.lat) <= lim && nearMain;
      // 主線路邊的緩衝區也算回到主線（捷徑兩側一定是岩壁，所以只會發生在捷徑的出入口附近）
      const onRunoff = !onMain && nearMain && track.hasRunoff
        && Math.abs(track.lat) <= track.edgeLat(mi, Math.sign(track.lat), track.along) - C.kartRadius * 0.8;
      if (onMain || onRunoff || !inside) {
        this.branch = null;
        this.idx = mi;
        this.lat = track.lat;
        if (!onMain) this.mainEdge(track, dt, emit);
        return;
      }
      this.bIdx = bi;
      this.idx = hint;
      this.branchFrac = prog - Math.floor(prog);
      this.lat = blat;
      const limB = br.halfWidth - C.kartRadius * 0.8;
      if (br.def.edge === 'fall') {
        // 沒有護欄：車身大半開出路面就摔下去
        if (Math.abs(blat) > br.halfWidth + 0.6 && this.air <= 0) this.startFall(emit);
      } else if (Math.abs(blat) > limB) this.pushWall(br.samples[bi], blat, limB, dt, emit);
      for (const p of br.posts) this.hitPost(p, emit);
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
    this.mainEdge(track, dt, emit);
  }

  /**
   * 開出主線路面之外（已經 locate 過）：沒有緩衝區的地方是護欄；
   * 有緩衝區（軟邊界）就可以繼續開但會減速，再外面是岩石／輪胎牆（跟撞牆一樣），或是台地邊緣的懸崖（摔下去）。
   */
  private mainEdge(track: Track, dt: number, emit: (e: KartEvent) => void): void {
    const C = CFG;
    const sg = Math.sign(this.lat) || 1;
    const sm = track.samples[this.idx];
    const edge = track.edgeLat(this.idx, sg, track.along);
    const a = Math.abs(this.lat);
    if (edge <= track.halfWidth) {
      this.pushWall(sm, this.lat, track.halfWidth - C.kartRadius * 0.8, dt, emit);
      return;
    }
    // 壓在路緣石上不算
    this.runoff = a > track.halfWidth + KERB_WIDTH;
    if (track.cliffAt(this.idx, sg)) {
      // 台地邊緣沒有屏障：車身大半開出去就摔下去（被炸飛在空中時最多飛出邊緣幾公尺）
      if (a > edge + 0.6 && this.air <= 0) this.startFall(emit);
      else if (a > edge + 8) this.pushWall(sm, this.lat, edge + 8, dt, emit);
      return;
    }
    const lim = edge - C.kartRadius * 0.8;
    if (a > lim) this.pushWall(sm, this.lat, lim, dt, emit);
  }

  private startFall(emit: (e: KartEvent) => void): void {
    this.fallT = 1.1;
    this.vy = 1.5;
    this.drifting = false;
    this.hop = false;
    emit('fall');
  }

  /** 撞到捷徑上的障礙物：推出來、反彈、掉速；甩尾中撞到跟撞牆一樣這次的集氣作廢 */
  private hitPost(p: Post, emit: (e: KartEvent) => void): void {
    if (this.air > 1) return;
    const dx = this.x - p.x, dz = this.z - p.z;
    const min = p.r + CFG.kartRadius * 0.9;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min || d2 < 1e-6) return;
    const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
    this.x = p.x + nx * min;
    this.z = p.z + nz * min;
    const vn = -(this.vx * nx + this.vz * nz);
    if (vn <= 0) return;
    this.vx += nx * vn * 1.3;
    this.vz += nz * vn * 1.3;
    const k = Math.min(1, vn / 14);
    this.vx *= 1 - CFG.wallLoss * k;
    this.vz *= 1 - CFG.wallLoss * k;
    this.spinVel += (this.vx * nz - this.vz * nx > 0 ? 1 : -1) * k * 2.5;
    if (vn > 4) {
      this.voidDrift(emit);
      emit('post');
    }
  }

  /** 甩尾中撞到東西：把這次甩尾集到的氣扣回去（包含已經換成整瓶的部分） */
  private voidDrift(emit: (e: KartEvent) => void): void {
    if (this.drifting && this.driftGain > 0.001) {
      const total = Math.max(0, this.n2o + this.gauge - this.driftGain);
      this.n2o = Math.min(CFG.maxN2O, Math.floor(total + 1e-6));
      this.gauge = Math.min(1, Math.max(0, total - this.n2o));
      emit('driftFail');
    }
    this.driftGain = 0;
    this.drifting = false;
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
      this.voidDrift(emit);
      emit('wall');
    }
  }
}
