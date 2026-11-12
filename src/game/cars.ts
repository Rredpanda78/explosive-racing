/** 可購買的車款。id 同時是模型檔名（Kenney Car Kit 的卡丁車）。 */
export type CarId = 'kart-oobi' | 'kart-oodi' | 'kart-ooli' | 'kart-oopi' | 'kart-oozi';

export interface CarDef {
  id: CarId;
  name: string;
  desc: string;
  price: number;
  /** 極速倍率 */
  speed: number;
  /** 加速倍率 */
  accel: number;
  /** 耐久加成 */
  hp: number;
  /** 集氣倍率 */
  gauge: number;
  /** 轉向／甩尾靈活度倍率 */
  handling: number;
  /** N2O 持續時間加成（秒） */
  boostTime: number;
  /** 衝撞傷害倍率 */
  ram: number;
  /** 質量：越重撞人時自己越不動 */
  mass: number;
}

export const CARS: Record<CarId, CarDef> = {
  'kart-oobi': { id: 'kart-oobi', name: '新星', desc: '各項均衡的入門車', price: 0, speed: 1, accel: 1, hp: 0, gauge: 1, handling: 1, boostTime: 0, ram: 1, mass: 1 },
  'kart-ooli': { id: 'kart-ooli', name: '甩尾王', desc: '轉向靈活，甩尾集氣特別快', price: 4000, speed: 0.99, accel: 1.04, hp: -5, gauge: 1.3, handling: 1.13, boostTime: 0, ram: 1, mass: 1 },
  'kart-oodi': { id: 'kart-oodi', name: '疾風', desc: '極速最高，但起步慢、車身薄', price: 4500, speed: 1.045, accel: 0.93, hp: -12, gauge: 1, handling: 0.97, boostTime: 0, ram: 0.9, mass: 0.88 },
  'kart-oopi': { id: 'kart-oopi', name: '鐵牛', desc: '裝甲厚、撞人特別痛，極速略低', price: 4500, speed: 0.975, accel: 0.98, hp: 45, gauge: 0.95, handling: 0.95, boostTime: 0, ram: 1.7, mass: 1.45 },
  'kart-oozi': { id: 'kart-oozi', name: '噴射機', desc: 'N2O 燒得更久，適合直線多的賽道', price: 5500, speed: 1, accel: 1, hp: 0, gauge: 1.05, handling: 1, boostTime: 0.8, ram: 1, mass: 1 },
};

export const CAR_IDS = Object.keys(CARS) as CarId[];
