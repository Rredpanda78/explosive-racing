import type { PrimaryId, SecondaryId } from '../game/weapons';

/** 手機按鈕的圖示（SVG，顏色跟著按鈕文字色 currentColor） */
const svg = (body: string) => `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  // 煞車：圓圈裡一個驚嘆號，兩側括弧（儀表板的煞車警示燈）
  brake: svg('<circle cx="24" cy="24" r="12"/><path d="M24 17v9"/><circle cx="24" cy="31" r="1.6" fill="currentColor" stroke="none"/><path d="M9 14a18 18 0 0 0 0 20M39 14a18 18 0 0 1 0 20"/>'),
  // 甩尾：輪胎加上甩出去的胎痕
  drift: svg('<circle cx="29" cy="19" r="10"/><circle cx="29" cy="19" r="3.5" fill="currentColor" stroke="none"/><path d="M5 40c8-3 16-4 26-2M8 33c6-2 11-2 16-1"/>'),
  // N2O：氣瓶加火焰
  n2o: svg('<rect x="15" y="14" width="13" height="26" rx="5"/><path d="M19 14v-4h5v4M28 22l9-4M28 30l11 1M28 37l8 4"/>'),
  // 小噴：閃電
  mini: svg('<path d="M27 5 12 27h11l-3 16 16-23H25z" fill="currentColor" stroke="none"/>'),
  // 後視：後照鏡加往後的箭頭
  look: svg('<rect x="7" y="14" width="34" height="16" rx="6"/><path d="M30 22H17M21 18l-4 4 4 4M24 30v8"/>'),
  left: svg('<path d="M30 10 16 24l14 14" stroke-width="5"/>'),
  right: svg('<path d="M18 10l14 14-14 14" stroke-width="5"/>'),
};

const PRIMARY_ICON: Record<PrimaryId, string> = {
  mg: svg('<path d="M5 21h25v7H5zM30 22.5h13M14 28l-3 9M22 28v5h5"/>'),
  vulcan: svg('<path d="M4 18h10v13H4zM14 19h28M14 24.5h30M14 30h28M36 17v15"/>'),
  flame: svg('<path d="M22 42c-7 0-11-5-11-11 0-8 7-11 8-19 4 3 6 7 6 11 2-2 3-5 3-7 5 4 7 9 7 15 0 6-5 11-13 11z" fill="currentColor" fill-opacity=".25"/>'),
  laser: svg('<path d="M4 20h14v9H4zM18 24.5h26" /><path d="M36 18l4 6.5-4 6.5" stroke-width="2.4"/><circle cx="44" cy="24.5" r="2" fill="currentColor" stroke="none"/>'),
};

const SECONDARY_ICON: Record<SecondaryId, string> = {
  rocket: svg('<path d="M8 24h22l9-5v10l-9-5M30 24c4-4 8-5 12-5-1 4-1 6 0 10-4 0-8-1-12-5zM8 19l-4-3v16l4-3"/>'),
  grenade: svg('<circle cx="22" cy="28" r="12"/><path d="M28 17l4-6h6M38 11l3-3M38 11l4 1"/>'),
  mine: svg('<path d="M24 8l14 8v16l-14 8-14-8V16z"/><circle cx="24" cy="24" r="5" fill="currentColor" stroke="none"/>'),
  cluster: svg('<circle cx="15" cy="30" r="7"/><circle cx="33" cy="30" r="7"/><circle cx="24" cy="15" r="7"/><path d="M8 30h14M26 30h14M17 15h14" stroke-width="2"/>'),
  missile: svg('<circle cx="34" cy="16" r="9" stroke-width="2.4"/><path d="M34 6v4M34 22v4M24 16h4M40 16h4"/><path d="M6 40l18-18M10 32l-4 2 2 6 6 2 2-4" />'),
};

export const primaryIcon = (id: PrimaryId) => PRIMARY_ICON[id];
export const secondaryIcon = (id: SecondaryId) => SECONDARY_ICON[id];

