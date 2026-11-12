/** 手感調校參數。單位：公尺、秒、弧度。 */
export const CFG = {
  // 基本動力
  maxSpeed: 36,
  accel: 17,
  brake: 34,
  reverseMax: 9,
  coast: 7,
  overspeedDecay: 6,

  // 一般抓地轉向：低速靈活、高速轉向不足（所以高速彎需要甩尾）
  gripTurnLow: 2.3,
  gripTurnHigh: 0.9,
  aiTurnHigh: 1.5,
  gripNormal: 11,

  // 甩尾
  driftMinSpeed: 13,
  driftTurn: 2.15,
  driftCounterTurn: 1.5,
  driftIdleTurn: 0.55,
  gripDrift: 2.3,
  driftRecover: 0.4,
  driftDrag: 9,
  driftKick: 0.1,

  // 集氣與 N2O
  gaugeRate: 0.4,
  gaugePassive: 0.01,
  maxN2O: 2,
  boostTime: 3.0,
  boostSpeedMul: 1.38,
  boostAccel: 36,

  // 小噴（甩尾結束後短時間內再按一次加速）
  miniMinDrift: 0.35,
  miniWindow: 0.65,
  miniTime: 0.6,
  miniSpeedMul: 1.1,
  miniAccel: 30,

  // 碰撞
  kartRadius: 1.25,
  wallLoss: 0.3,

  // 耐久
  hp: 100,
  respawnTime: 2.5,
  invulnTime: 2.0,
  regenDelay: 5,
  regenRate: 3,

  // 武器共用
  bulletSpeed: 260,
  aiDamageMul: 0.45,

  racers: 8,
};

export const PAYOUT = [1200, 900, 700, 550, 420, 320, 240, 180];
export const KILL_REWARD = 150;
