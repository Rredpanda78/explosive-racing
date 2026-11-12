import type { Sample, Track } from './track';

/** 路面比周圍草地高出的距離 */
export const ROAD_ABOVE_TERRAIN = 1.9;

export interface Terrain {
  /** 遠方平地的高度：一定低於整條賽道的最低點，不然會把低處的路面蓋住 */
  baseY: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 任意位置的草地高度 */
  height(x: number, z: number): number;
  /** 與賽道中心線的最短距離 */
  trackDist(x: number, z: number): number;
}

/**
 * 賽道外的地形：高度取附近賽道各點高度的距離加權平均，再往下降一點，
 * 所以草地永遠貼在路面下方；離賽道很遠的地方漸漸降到 baseY。
 * 這裡不依賴畫面，模擬測試可以直接檢查「地形沒有蓋住路面」。
 */
export function makeTerrain(track: Track): Terrain {
  const S = track.samples;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
  for (const s of S) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
    minY = Math.min(minY, s.y);
  }
  const baseY = minY - ROAD_ABOVE_TERRAIN - 2;
  const coarse: Sample[] = [];
  for (let i = 0; i < S.length; i += 3) coarse.push(S[i]);

  const height = (x: number, z: number): number => {
    let num = 0, den = 0, dmin = Infinity;
    for (const s of coarse) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
      const w = 1 / ((d2 + 40) * (d2 + 40));
      num += w * s.y;
      den += w;
    }
    const h = num / den - ROAD_ABOVE_TERRAIN;
    const t = Math.min(1, Math.max(0, (Math.sqrt(dmin) - 150) / 110));
    return h + (baseY - h) * t * t * (3 - 2 * t);
  };

  const trackDist = (x: number, z: number): number => {
    let dmin = Infinity;
    for (const s of coarse) {
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) dmin = d2;
    }
    return Math.sqrt(dmin);
  };

  return { baseY, minX, maxX, minZ, maxZ, height, trackDist };
}
