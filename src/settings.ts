import type { MusicStyle } from './audio';

/** 這台裝置的設定（跟存檔分開：畫質、音量、按鈕位置都是看裝置的） */
export type Quality = 'low' | 'medium' | 'high';

export interface ButtonPos {
  /** 按鈕中心在畫面上的位置（佔畫面寬、高的百分比）與縮放 */
  x: number;
  y: number;
  s: number;
}

export interface Settings {
  quality: Quality;
  /** 音樂與音效音量 0~1 */
  music: number;
  sfx: number;
  /** 比賽配樂風格 */
  musicStyle: MusicStyle;
  /** 畫面震動強度 0~1 */
  shake: number;
  dmgNumbers: boolean;
  /** 手機操控：按鈕或傾斜轉向 */
  control: 'buttons' | 'tilt';
  /** 傾斜幾度轉到底 */
  tiltRange: number;
  tiltInvert: boolean;
  /** 自訂的按鈕位置（沒有的就用預設位置） */
  layout: Record<string, ButtonPos>;
}

const KEY = 'explosive-racing-settings-v1';

export function defaultSettings(mobile: boolean): Settings {
  return {
    quality: mobile ? 'medium' : 'high',
    music: 0.8,
    sfx: 0.9,
    musicStyle: 'synth',
    shake: 1,
    dmgNumbers: true,
    control: 'buttons',
    tiltRange: 24,
    tiltInvert: false,
    layout: {},
  };
}

export function loadSettings(mobile: boolean): Settings {
  const d = defaultSettings(mobile);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    return { ...d, ...s, layout: { ...(s.layout ?? {}) } };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 無痕模式等情況下無法儲存 */
  }
}

/** 可以拖曳調整位置的手機按鈕 */
export const LAYOUT_IDS = ['t-steer', 't-look', 't-fire1', 't-fire2', 't-boost', 't-drift', 't-brake'];

/** 套用自訂的按鈕位置；沒有自訂的清掉行內樣式、回到 CSS 預設位置 */
export function applyLayout(s: Settings): void {
  for (const id of LAYOUT_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const p = s.layout[id];
    if (p) {
      el.style.left = p.x + '%';
      el.style.top = p.y + '%';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.translate = '-50% -50%';
      el.style.scale = String(p.s);
    } else {
      for (const k of ['left', 'top', 'right', 'bottom', 'translate', 'scale'] as const) el.style[k] = '';
    }
  }
}
