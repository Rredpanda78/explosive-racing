import type { EngineStyle, MusicStyle, WeaponPack } from './audio';
import type { Lang } from './i18n';
import { defaultKeys, normalizeKeys, type KeyMap } from './keymap';

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
  /** 引擎聲與武器音效組 */
  engineSound: EngineStyle;
  weaponSound: WeaponPack;
  /** 畫面震動強度 0~1 */
  shake: number;
  /** 手機震動（壓路緣、撞擊、擊毀；iPhone 不支援） */
  vibrate: boolean;
  dmgNumbers: boolean;
  /** 畫面角落顯示 FPS（線上比賽另外顯示延遲） */
  netInfo: boolean;
  /** 手機操控：按鈕或傾斜轉向 */
  control: 'buttons' | 'tilt';
  /** 操控輔助：甩完自動小噴、甩尾自動回正並限制角度 */
  autoMini: boolean;
  driftAssist: boolean;
  /** 手機甩尾鍵：一顆（配合方向鍵）或左甩／右甩兩顆 */
  touchDrift: 'single' | 'dual';
  /** 傾斜幾度轉到底 */
  tiltRange: number;
  tiltInvert: boolean;
  /** 自訂的按鈕位置（沒有的就用預設位置） */
  layout: Record<string, ButtonPos>;
  /** 鍵盤按鍵（電腦版；每個動作主要鍵＋第二個鍵） */
  keys: KeyMap;
  /** 聽得到附近其他車的引擎聲（有方位感） */
  otherEngines: boolean;
  /** 介面語言；沒選過（undefined）= 依瀏覽器語言自動判斷 */
  lang?: Lang;
}

const KEY = 'explosive-racing-settings-v1';

export function defaultSettings(mobile: boolean): Settings {
  return {
    quality: mobile ? 'medium' : 'high',
    music: 0.8,
    sfx: 0.9,
    musicStyle: 'synth',
    engineSound: 'kart',
    weaponSound: 'classic',
    shake: 1,
    vibrate: true,
    dmgNumbers: true,
    netInfo: true,
    control: 'buttons',
    autoMini: false,
    driftAssist: false,
    touchDrift: 'single',
    tiltRange: 24,
    tiltInvert: false,
    layout: {},
    keys: defaultKeys(),
    otherEngines: true,
  };
}

export function loadSettings(mobile: boolean): Settings {
  const d = defaultSettings(mobile);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    // 舊版存檔沒有 keys：補上預設鍵位（跟改版前一樣）
    return {
      ...d, ...s, layout: { ...(s.layout ?? {}) }, keys: normalizeKeys(s.keys), otherEngines: s.otherEngines !== false,
      lang: s.lang === 'zh' || s.lang === 'en' ? s.lang : undefined,
    };
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
export const LAYOUT_IDS = ['t-steer', 't-look', 't-fire1', 't-fire2', 't-boost', 't-drift', 't-brake', 't-driftl', 't-driftr'];

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
