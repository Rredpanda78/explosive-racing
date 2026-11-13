import { CARS, type CarId } from '../game/cars';
import type { TrackDef } from '../game/track';
import { DEBRIS_MODELS, hasModel, isLoaded, LANDMARK_MODELS, loadModels, PROP_MODELS, prefetchModels, registerModels } from './assets';
import { FOREST_MODELS, hasForest } from './forest';

/**
 * 分批載入模型：選單只需要「目前這張地圖」的景物，車子在選單出現後才在背景載入，
 * 其他地圖的地標等到選了那張地圖才載（之前開遊戲要先下載全部 21 MB）。
 */

/** 每種主題會擺的 Tripo 地標（見 world.ts）。沒列在這裡的主題就把全部地標都載入，保證不缺 */
const THEME_LANDMARKS: Partial<Record<string, string[]>> = {
  meadow: ['tripo/windmill_tower', 'tripo/windmill_blades'],
  desert: ['tripo/water_tower'],
  city: ['tripo/city_a', 'tripo/city_b', 'tripo/ferris_stand', 'tripo/ferris_wheel', 'tripo/highrise'],
};

// 森林模型也登記起來：建場景時用到但還沒載入的話，會補載再重建（見 assets.takeMissing）
registerModels(FOREST_MODELS);

/** 建一張地圖的場景要先載入的模型（路邊景物與碎片都很小，一律先載） */
export function trackModels(def: TrackDef): string[] {
  const landmarks = THEME_LANDMARKS[def.theme] ?? LANDMARK_MODELS;
  return [...PROP_MODELS, ...DEBRIS_MODELS, ...landmarks, ...(hasForest(def.id) ? FOREST_MODELS : [])];
}

export const carModel = (id: CarId): string => CARS[id].model;

/** 車款模型（Tripo）；載不到的那台改載同名的 Kenney 卡丁車當備用（CarId 就是卡丁車的檔名） */
export async function loadCars(ids: readonly CarId[], onProgress?: (f: number) => void): Promise<void> {
  await loadModels(ids.map(carModel), onProgress);
  const fallback = ids.filter((id) => !hasModel(carModel(id)));
  if (fallback.length) await loadModels(fallback);
}

export const carsLoaded = (ids: readonly CarId[]): boolean => ids.every((id) => hasModel(carModel(id)) || isLoaded(id));

/** 其他地圖的模型：選單閒著時先抓進瀏覽器快取（不解析），之後換地圖幾乎不用等 */
export function prefetchTracks(defs: readonly TrackDef[]): Promise<void> {
  const names = new Set<string>();
  for (const d of defs) for (const n of trackModels(d)) names.add(n);
  return prefetchModels([...names]);
}
