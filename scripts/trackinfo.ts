import { Track, TRACKS } from '../src/game/track';
const t = new Track(TRACKS[0]);
let kmax = 0, smax = 0;
for (const s of t.samples) { kmax = Math.max(kmax, Math.abs(s.curv)); smax = Math.max(smax, Math.abs(s.slope)); }
console.log(`length ${t.length.toFixed(0)} n ${t.n} minR ${(1 / kmax).toFixed(1)} maxSlope ${(smax * 100).toFixed(1)}%`);
// 控制點對應的距離
const out: string[] = [];
TRACKS[0].points.forEach((p, i) => { const idx = t.locate(p[0], p[1], -1); out.push(`${i}:${t.samples[idx].dist.toFixed(0)}`); });
console.log(out.join(' '));
// 彎道區段
let seg: string[] = []; let start = -1;
t.samples.forEach((s, i) => { const c = Math.abs(s.curv) > 0.015; if (c && start < 0) start = i; if (!c && start >= 0) { const a = t.samples[start], m = t.samples[(start + i) >> 1]; seg.push(`${a.dist.toFixed(0)}-${s.dist.toFixed(0)}(${m.curv > 0 ? 'L' : 'R'} R${(1 / Math.abs(m.curv)).toFixed(0)})`); start = -1; } });
console.log('corners', seg.join(' '));
// 不同路段之間的最小距離
let minSep = 1e9, at = '';
for (let i = 0; i < t.n; i += 4) for (let j = i + 60; j < t.n; j += 4) { if (t.n - j + i < 60) continue; const a = t.samples[i], b = t.samples[j]; const d = Math.hypot(a.x - b.x, a.z - b.z); if (d < minSep) { minSep = d; at = `${a.dist.toFixed(0)} vs ${b.dist.toFixed(0)}`; } }
console.log('min separation', minSep.toFixed(1), at);
