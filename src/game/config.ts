/** 手感調校參數。單位：公尺、秒、弧度。 */
export const CFG = {
  // 基本動力
  maxSpeed: 37,
  accel: 18,
  brake: 34,
  reverseMax: 9,
  coast: 7,
  overspeedDecay: 6,

  // 一般抓地轉向：低速靈活、高速轉向不足（所以高速彎需要甩尾）
  gripTurnLow: 2.3,
  gripTurnHigh: 0.9,
  aiTurnHigh: 1.5,
  gripNormal: 8.5,
  /** 轉向的角速度跟上方向盤的快慢（越小越有滑行感、越不會一按就猛轉） */
  yawResp: 11,
  yawRespDrift: 14,

  // 甩尾
  driftMinSpeed: 13,
  driftTurn: 1.95,
  /** 放開甩尾鍵後繼續按同方向時的轉向率（拖漂） */
  driftHoldTurn: 1.75,
  driftCounterTurn: 1.5,
  driftIdleTurn: 0.55,
  gripDrift: 1.8,
  /** 放開甩尾鍵後抓地力完全恢復所需秒數 */
  driftRecover: 1.1,
  /** 拖漂時恢復速度的倍率（越小拖越久） */
  driftSustain: 0.35,
  /** 反打方向盤時恢復速度的倍率 */
  driftCounterRecover: 2.6,
  driftDrag: 8,
  driftKick: 0.1,

  // ---- 集氣（比最初版本少 20%）：甩尾是主要來源，但「打人、擊毀、尾流、滯空、加速帶」都會給 ----
  gaugeRate: 0.5,
  gaugePassive: 0.016,
  /** 每造成 1 點傷害得到的集氣量 */
  gaugePerDamage: 0.004,
  /** 尾流中每秒集氣量 */
  gaugeDraft: 0.11,
  gaugePad: 0.096,
  gaugeLand: 0.08,
  gaugeMini: 0.04,
  maxN2O: 2,
  boostTime: 3.0,
  boostSpeedMul: 1.4,
  boostAccel: 38,

  // 短漂（點一下甩尾鍵）：放開得夠快就是短漂——回正快、減速少、集氣效率高，但沒有小噴
  shortDriftKey: 0.16,
  shortDriftRecover: 2.4,
  shortDriftDrag: 0.5,
  shortDriftGauge: 1.35,
  /** 短漂結束後這段時間內接長漂：這次長漂集氣加成 */
  chainWindow: 0.5,
  chainGauge: 1.3,
  /** 連噴：上一次小噴後這段時間內又小噴就算連噴，集氣加成 */
  comboWindow: 1.8,
  /** 斷飄：甩尾中點一下煞車立刻結束甩尾，這段時間內的煞車不會減速 */
  cancelGrace: 0.25,
  /** 重甩：甩尾中同方向連按兩下（放開到再按的間隔要短），轉得更兇、滑得更開，適合髮夾彎 */
  hardTapWindow: 0.26,
  hardDriftTime: 1.0,
  hardTurnMul: 1.3,
  hardGrip: 1.3,
  hardKick: 0.08,
  hardDrag: 1.3,

  // 小噴（甩尾結束後短時間內再按一次加速）
  miniMinDrift: 0.35,
  miniWindow: 0.65,
  miniTime: 0.6,
  miniSpeedMul: 1.1,
  miniAccel: 30,

  // 加速帶與坡度
  padTime: 1.3,
  padSpeedMul: 1.25,
  padAccel: 34,
  slopeGravity: 0.45,

  // 起跑衝刺：倒數結束前這段時間內按下油門
  startWindow: 0.5,
  startBoostTime: 1.5,

  // 尾流：緊跟在前車正後方一小段時間後生效
  draftMin: 3,
  draftMax: 24,
  draftCone: 0.17,
  draftDelay: 0.5,
  draftSpeedMul: 1.07,
  draftAccel: 6,

  /** 爆炸桶：使用者要求先全部拿掉（程式保留，改成 true 就會回來） */
  barrels: false,

  // 跳台
  rampLength: 7,
  rampHeight: 1.5,
  rampVy: 10.5,
  gravity: 26,
  landBoostTime: 0.8,
  /** 坡頂飛起：路面往下彎的速度超過這個「重力」就會離地，空中也用這個比較輕的重力 */
  hopGravity: 7,
  hopMinSpeed: 22,

  // 碰撞與衝撞
  kartRadius: 1.25,
  wallLoss: 0.3,
  /** 相對速度超過這個值的碰撞才會造成傷害 */
  ramMinSpeed: 7,
  ramDamage: 1.1,
  /** 噴射中撞人的傷害倍率 */
  ramBoostMul: 2.4,

  // 耐久
  hp: 100,
  respawnTime: 2.5,
  invulnTime: 2.0,
  regenDelay: 5,
  regenRate: 3,

  // 爆炸桶：被子彈、火箭或車撞到就引爆
  barrelDamage: 34,
  barrelRadius: 7.5,
  barrelRespawn: 14,

  // 碰撞物理
  /** 車與車擦撞時的摩擦係數（決定被擦到時會不會打轉） */
  kartFriction: 0.45,
  /** 轉動慣量：越小越容易被撞到打轉 */
  spinInertia: 3.4,
  spinDamping: 4.5,
  /** 爆炸把車炸離地面的向上速度 */
  blastLift: 9,

  // 淘汰賽
  elimFirst: 28,
  elimInterval: 17,

  // 武器共用
  bulletSpeed: 260,
  aiDamageMul: 0.65,

  racers: 8,
};

export const PAYOUT = [1500, 1100, 850, 650, 500, 400, 300, 220];
export const KILL_REWARD = 150;
/** 連續擊毀（中途沒被擊毀）每多一台的額外獎金 */
export const STREAK_BONUS = 75;
