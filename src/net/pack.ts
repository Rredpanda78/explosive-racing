import type { Kart } from '../game/kart';

/**
 * 車輛狀態的二進位格式（每台車 43 位元組，JSON 大約 160 字）。
 * 解出來是陣列，順序：
 * [netId, x, y, z, heading, pitch, speed, slip, steerVis, air, flags, boostT, miniT, padT, hp, maxHp, idx, prog, progFine, lapCount, invulnT, yawRate]
 * 封包：[0] 收件人遮罩（伺服器轉發時換成發送者編號）[1] 種類 = 1 [2] 車數，接著每台車，最後是命中紀錄（車數、[受害者, 攻擊者, 傷害×10]）
 */
export type Pack = number[];

const KART_BYTES = 43;
const TYPE_STATE = 1;

const clampI = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function flagsOf(k: Kart): number {
  return (k.drifting ? 1 : 0) | (k.dead ? 2 : 0) | (k.netFire ? 4 : 0) | (k.driftDir > 0 ? 8 : 0) | (k.hop ? 16 : 0) | (k.shieldT > 0 ? 32 : 0);
}

export function encodeStates(karts: Kart[], hits: [number, number, number][]): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(3 + karts.length * KART_BYTES + 1 + hits.length * 4);
  const v = new DataView(buf);
  v.setUint8(0, 0);
  v.setUint8(1, TYPE_STATE);
  v.setUint8(2, karts.length);
  let o = 3;
  for (const k of karts) {
    v.setUint8(o, k.netId); o += 1;
    v.setFloat32(o, k.x, true); o += 4;
    v.setFloat32(o, k.y, true); o += 4;
    v.setFloat32(o, k.z, true); o += 4;
    v.setInt16(o, clampI((wrap(k.heading) / Math.PI) * 32767, -32767, 32767), true); o += 2;
    v.setInt16(o, clampI(k.pitch * 10000, -32767, 32767), true); o += 2;
    v.setInt16(o, clampI(k.speed * 100, -32767, 32767), true); o += 2;
    v.setInt16(o, clampI((wrap(k.slip) / Math.PI) * 32767, -32767, 32767), true); o += 2;
    v.setInt8(o, clampI(k.steerVis * 100, -127, 127)); o += 1;
    v.setUint16(o, clampI(k.air * 100, 0, 65535), true); o += 2;
    v.setUint8(o, flagsOf(k)); o += 1;
    v.setUint8(o, clampI(k.boostT * 20, 0, 255)); o += 1;
    v.setUint8(o, clampI(k.miniT * 50, 0, 255)); o += 1;
    v.setUint8(o, clampI(k.padT * 50, 0, 255)); o += 1;
    v.setUint16(o, clampI(k.hp, 0, 65535), true); o += 2;
    v.setUint16(o, clampI(k.maxHp, 0, 65535), true); o += 2;
    v.setUint16(o, clampI(k.idx, 0, 65535), true); o += 2;
    v.setInt32(o, k.prog, true); o += 4;
    v.setInt8(o, clampI((k.progFine - k.prog) * 100, -127, 127)); o += 1;
    v.setInt8(o, clampI(k.lapCount, -127, 127)); o += 1;
    v.setUint8(o, clampI(k.invulnT * 10, 0, 255)); o += 1;
    v.setInt16(o, clampI(k.yawRate * 1000, -32767, 32767), true); o += 2;
  }
  v.setUint8(o, hits.length); o += 1;
  for (const [vi, by, amt] of hits) {
    v.setUint8(o, vi);
    v.setUint8(o + 1, by);
    v.setUint16(o + 2, clampI(amt * 10, 0, 65535), true);
    o += 4;
  }
  return new Uint8Array(buf);
}

export function decodeStates(buf: ArrayBuffer): { karts: Pack[]; hits: [number, number, number][] } | null {
  const v = new DataView(buf);
  if (buf.byteLength < 4 || v.getUint8(1) !== TYPE_STATE) return null;
  const n = v.getUint8(2);
  if (buf.byteLength < 3 + n * KART_BYTES + 1) return null;
  const karts: Pack[] = [];
  let o = 3;
  for (let i = 0; i < n; i++) {
    const id = v.getUint8(o); o += 1;
    const x = v.getFloat32(o, true); o += 4;
    const y = v.getFloat32(o, true); o += 4;
    const z = v.getFloat32(o, true); o += 4;
    const heading = (v.getInt16(o, true) / 32767) * Math.PI; o += 2;
    const pitch = v.getInt16(o, true) / 10000; o += 2;
    const speed = v.getInt16(o, true) / 100; o += 2;
    const slip = (v.getInt16(o, true) / 32767) * Math.PI; o += 2;
    const steer = v.getInt8(o) / 100; o += 1;
    const air = v.getUint16(o, true) / 100; o += 2;
    const fl = v.getUint8(o); o += 1;
    const boostT = v.getUint8(o) / 20; o += 1;
    const miniT = v.getUint8(o) / 50; o += 1;
    const padT = v.getUint8(o) / 50; o += 1;
    const hp = v.getUint16(o, true); o += 2;
    const maxHp = v.getUint16(o, true); o += 2;
    const idx = v.getUint16(o, true); o += 2;
    const prog = v.getInt32(o, true); o += 4;
    const frac = v.getInt8(o) / 100; o += 1;
    const lap = v.getInt8(o); o += 1;
    const inv = v.getUint8(o) / 10; o += 1;
    const yaw = v.getInt16(o, true) / 1000; o += 2;
    karts.push([id, x, y, z, heading, pitch, speed, slip, steer, air, fl, boostT, miniT, padT, hp, maxHp, idx, prog, prog + frac, lap, inv, yaw]);
  }
  const hits: [number, number, number][] = [];
  const nh = v.getUint8(o); o += 1;
  for (let i = 0; i < nh && o + 4 <= buf.byteLength; i++) {
    hits.push([v.getUint8(o), v.getUint8(o + 1), v.getUint16(o + 2, true) / 10]);
    o += 4;
  }
  return { karts, hits };
}
