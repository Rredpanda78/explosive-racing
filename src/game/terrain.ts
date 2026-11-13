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
  // 捷徑也是路面：地形同樣要壓在它下方
  for (const b of track.branches) for (let i = 0; i < b.n; i += 3) coarse.push(Object.assign(Object.create(b.samples[i]), { _b: true }));

  // 沒有護欄（摔得下去）的捷徑：離主線夠遠的路段，兩側地面往下挖，看得出是懸崖
  const cliffs: { x: number; z: number; r: number }[] = [];
  for (const b of track.branches) {
    if (b.def.edge !== 'fall') continue;
    for (let i = 0; i < b.n; i += 2) {
      const s = b.samples[i];
      let dm = Infinity;
      for (const c of coarse) if (!(c as unknown as { _b?: boolean })._b) dm = Math.min(dm, Math.hypot(c.x - s.x, c.z - s.z));
      if (dm > track.halfWidth + 20) cliffs.push({ x: s.x, z: s.z, r: b.halfWidth });
    }
  }
  const CLIFF_DEPTH = 11;

  // 軟邊界：每個粗取樣點兩側的「緩衝區 + 屏障」範圍（主線取樣點才有；捷徑是 0）。
  // 落在這個範圍內的地形一律壓到路面下方，緩衝區（路面高度）才不會被別段比較高的路拉起來的地形蓋住
  const roL: number[] = [], roR: number[] = [];
  const hw = track.halfWidth;
  for (let i = 0; i < coarse.length; i++) {
    const main = i * 3 < S.length;
    roL.push(main && track.runoffW(i * 3, 1) > 0 ? hw + track.runoffW(i * 3, 1) + 3 : 0);
    roR.push(main && track.runoffW(i * 3, -1) > 0 ? hw + track.runoffW(i * 3, -1) + 3 : 0);
  }
  // 台地邊緣的懸崖：緩衝區外緣以外的地面往下挖
  const drops: { x: number; z: number; nx: number; nz: number; k: number }[] = [];
  if (track.hasRunoff) {
    const n = S.length;
    for (const sg of [1, -1]) {
      for (let i = 0; i < n; i += 2) {
        if (!track.cliffAt(i, sg)) continue;
        // 懸崖兩端慢慢收掉，不會在邊上切出一道直角
        let end = 0;
        while (end < 40 && track.cliffAt(track.wrap(i + end), sg) && track.cliffAt(track.wrap(i - end), sg)) end++;
        const u = Math.min(1, (end * track.spacing) / 16);
        const s = S[i], lat = sg * track.edgeLat(i, sg);
        drops.push({ x: s.x + s.nx * lat, z: s.z + s.nz * lat, nx: s.nx * sg, nz: s.nz * sg, k: u * u * (3 - 2 * u) });
      }
    }
  }
  const DROP_DEPTH = 18;

  const height = (x: number, z: number): number => {
    let num = 0, den = 0, dmin = Infinity, near = 0;
    for (let i = 0; i < coarse.length; i++) {
      const s = coarse[i];
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < dmin) { dmin = d2; near = i; }
      const w = 1 / ((d2 + 40) * (d2 + 40));
      num += w * s.y;
      den += w;
    }
    let h = num / den - ROAD_ABOVE_TERRAIN;
    if (track.hasRunoff) {
      const s = coarse[near];
      const lat = (x - s.x) * s.nx + (z - s.z) * s.nz;
      const lim = lat > 0 ? roL[near] : roR[near];
      if (Math.abs(lat) < lim) h = Math.min(h, s.y - ROAD_ABOVE_TERRAIN);
    }
    if (drops.length) {
      let cd = Infinity, c: (typeof drops)[number] | null = null;
      for (const p of drops) {
        const d = (x - p.x) ** 2 + (z - p.z) ** 2;
        if (d < cd) { cd = d; c = p; }
      }
      // 從緩衝區外緣往內 6 公尺開始挖（那裡上面蓋著緩衝區的路面，看不到），到外緣已經挖到底，
      // 地形網格比較粗，這樣岩壁才會直直接到谷底，不會被網格的斜面蓋住半截
      const out = (x - c!.x) * c!.nx + (z - c!.z) * c!.nz;
      const u = Math.min(1, Math.max(0, (out + 6) / 6));
      const carve = DROP_DEPTH * c!.k * u * u * (3 - 2 * u);
      if (carve > 0) h = Math.min(h, Math.max(baseY + 0.3, h - carve));
    }
    if (cliffs.length) {
      let cd = Infinity, cr = 0;
      for (const c of cliffs) {
        const d = Math.hypot(x - c.x, z - c.z);
        if (d < cd) { cd = d; cr = c.r; }
      }
      const u = Math.min(1, Math.max(0, (cd - cr - 1) / 16));
      h -= CLIFF_DEPTH * (1 - u * u * (3 - 2 * u));
    }
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
