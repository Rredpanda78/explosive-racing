import type { CarId } from './cars';
import type { DifficultyId } from './difficulty';
import type { Kart } from './kart';
import type { PrimaryId, SecondaryId } from './weapons';

/** 連線房間裡一位玩家的車與裝備（進房時送給大家） */
export interface NetRacer {
  pid: number;
  name: string;
  car: CarId;
  livery: number;
  primary: PrimaryId;
  secondary: SecondaryId;
  plvl: number;
  slvl: number;
  engine: number;
  n2o: number;
  armor: number;
}

/** 房主按開始時決定、每個人都一樣的比賽設定 */
export interface OnlineSetup {
  racers: NetRacer[];
  /** 自己的玩家編號 */
  me: number;
  /** 自己是不是房主（房主跑電腦車手） */
  host: boolean;
  /** 空位補電腦車手（補滿 8 台） */
  aiFill: boolean;
  difficulty: DifficultyId;
}

/** 副武器發射的參數：所有人照同樣的參數生出一樣的砲彈 */
export interface SecParams {
  seed: number;
  /** 追蹤導彈鎖定的車（netId） */
  targets?: number[];
  /** 榴彈預判的落點 */
  ax?: number;
  az?: number;
}

/** Race 對外的連線掛勾（由連線層實作） */
export interface RaceNet {
  host: boolean;
  onSecondary(k: Kart, p: SecParams): void;
  /** 自己控制的車被打（攻擊者的電腦要加集氣、顯示傷害數字） */
  onDamage(v: Kart, by: Kart | null, amount: number): void;
  onKill(v: Kart, by: Kart | null): void;
  onFinish(k: Kart): void;
  onElim(k: Kart): void;
}
