// 鍵盤按鍵自訂：每個動作一個主要鍵＋一個可有可無的第二個鍵
// 鍵位用 KeyboardEvent.code（實體按鍵位置），換鍵盤配置（AZERTY、Dvorak…）也能用；
// 另外有四個「左右兩顆都算」的虛擬代碼：Shift、Control、Alt、Meta
import { isEn, localize, t } from './i18n';

export type KeyAction = 'up' | 'down' | 'left' | 'right' | 'drift' | 'boost' | 'fire1' | 'fire2' | 'look' | 'reset' | 'pause';

/** [主要鍵, 第二個鍵]；空字串 = 沒有設定 */
export type KeySlots = [string, string];
export type KeyMap = Record<KeyAction, KeySlots>;

/** 設定頁的順序與名稱 */
export const KEY_ACTIONS: { id: KeyAction; name: string }[] = [
  { id: 'up', name: '油門' },
  { id: 'down', name: '煞車／倒車' },
  { id: 'left', name: '左轉' },
  { id: 'right', name: '右轉' },
  { id: 'drift', name: '甩尾' },
  { id: 'boost', name: 'N2O' },
  { id: 'fire1', name: '主武器' },
  { id: 'fire2', name: '副武器' },
  { id: 'look', name: '後視' },
  { id: 'reset', name: '重置' },
  { id: 'pause', name: '暫停' },
];
/** 英文的動作名稱 */
const EN_ACTIONS: Record<KeyAction, string> = {
  up: 'Accelerate', down: 'Brake / Reverse', left: 'Steer Left', right: 'Steer Right', drift: 'Drift', boost: 'N2O',
  fire1: 'Primary Weapon', fire2: 'Secondary Weapon', look: 'Look Back', reset: 'Reset', pause: 'Pause',
};
for (const a of KEY_ACTIONS) localize(a, { name: EN_ACTIONS[a.id] });

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 左右兩顆都算的修飾鍵 */
const PAIRS: Record<string, [string, string]> = {
  Shift: ['ShiftLeft', 'ShiftRight'],
  Control: ['ControlLeft', 'ControlRight'],
  Alt: ['AltLeft', 'AltRight'],
  Meta: ['MetaLeft', 'MetaRight'],
};

/**
 * 預設鍵位（跟改版前完全一樣：方向鍵＋WASD、兩顆 Shift 甩尾、兩顆 Ctrl 或空白鍵開 N2O）。
 * Mac 的 Control＋方向鍵會切換桌面，所以把空白鍵排在前面顯示（兩個鍵都照樣能用）。
 * Esc 不在這裡：Esc 一律可以暫停，也是改鍵時的「取消」。
 */
export function defaultKeys(): KeyMap {
  return {
    up: ['ArrowUp', 'KeyW'],
    down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    drift: ['Shift', ''],
    boost: IS_MAC ? ['Space', 'Control'] : ['Control', 'Space'],
    fire1: ['KeyZ', ''],
    fire2: ['KeyX', ''],
    look: ['KeyC', ''],
    reset: ['KeyR', ''],
    pause: ['KeyP', ''],
  };
}

/** 讀取存檔裡的鍵位：缺的、壞掉的、重複的都補回預設（舊版存檔沒有這一項） */
export function normalizeKeys(raw: unknown): KeyMap {
  const d = defaultKeys();
  if (!raw || typeof raw !== 'object') return d;
  const src = raw as Record<string, unknown>;
  const out = defaultKeys();
  const used = new Set<string>();
  for (const { id } of KEY_ACTIONS) {
    const v = src[id];
    if (!Array.isArray(v)) continue;
    const slots = v.slice(0, 2).map((c) => (typeof c === 'string' && c.length < 32 && !BANNED.has(c) ? c : ''));
    // 第一格空著就把第二格往前移
    if (!slots[0] && slots[1]) slots.reverse();
    if (!slots[0]) continue;
    out[id] = [slots[0], slots[1] && slots[1] !== slots[0] ? slots[1] : ''];
  }
  // 兩個動作用到同一顆鍵（手動改壞的存檔）：整份退回預設，比玩到一半才發現好
  for (const { id } of KEY_ACTIONS) {
    for (const c of out[id]) {
      if (!c) continue;
      for (const x of expand(c)) {
        if (used.has(x)) return d;
        used.add(x);
      }
    }
  }
  return out;
}

/** 一個鍵位代碼實際對應的 KeyboardEvent.code（Shift → 左右兩顆） */
export function expand(code: string): string[] {
  return PAIRS[code] ?? (code ? [code] : []);
}

/** 不能拿來當遊戲按鍵：Esc（取消／暫停）、視窗鍵／Command（會觸發系統快捷鍵） */
const BANNED = new Set(['Escape', 'MetaLeft', 'MetaRight', 'Meta', 'OSLeft', 'OSRight', 'ContextMenu']);
export function bannedKey(code: string): boolean {
  return BANNED.has(code);
}

/** 兩個代碼有沒有重疊（例如 Shift 與 ShiftLeft） */
function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  const eb = expand(b);
  return expand(a).some((x) => eb.includes(x));
}

/** 這顆鍵目前被哪個動作的哪一格用掉 */
export function findKey(map: KeyMap, code: string): { id: KeyAction; slot: 0 | 1 } | null {
  for (const { id } of KEY_ACTIONS) {
    for (const slot of [0, 1] as const) if (overlaps(map[id][slot], code)) return { id, slot };
  }
  return null;
}

export type BindResult =
  | { ok: true; swapped: KeyAction | null }
  | { ok: false; why: string };

/**
 * 把 code 設到 id 的第 slot 格。已經被別的動作用掉就兩邊互換；
 * 換過去會讓對方一個鍵都不剩（對方只有那一顆）就拒絕。
 */
export function bindKey(map: KeyMap, id: KeyAction, slot: 0 | 1, code: string): BindResult {
  if (bannedKey(code)) return { ok: false, why: t.keyBanned(keyName(code)) };
  const old = map[id][slot];
  if (old === code) return { ok: true, swapped: null };
  const hit = findKey(map, code);
  if (hit && hit.id === id) {
    // 同一個動作的另一格：兩格互換
    const s = map[id];
    s[hit.slot] = old;
    s[slot] = code;
    fix(s);
    return { ok: true, swapped: null };
  }
  if (hit) {
    const other = map[hit.id];
    const left = other[1 - hit.slot];
    if (!old && !left) {
      const name = KEY_ACTIONS.find((a) => a.id === hit.id)?.name ?? '';
      return { ok: false, why: t.keyOnly(keyName(code), name) };
    }
    other[hit.slot] = old;
    fix(other);
  }
  map[id][slot] = code;
  fix(map[id]);
  return { ok: true, swapped: hit ? hit.id : null };
}

/** 清掉某一格（主要鍵清掉時第二個鍵遞補；只剩一顆就不能清） */
export function clearKey(map: KeyMap, id: KeyAction, slot: 0 | 1): boolean {
  const s = map[id];
  if (!s[1 - slot]) return false;
  s[slot] = '';
  fix(s);
  return true;
}

function fix(s: KeySlots): void {
  if (!s[0] && s[1]) {
    s[0] = s[1];
    s[1] = '';
  }
}

// ---------------------------------------------------------------------------
// 顯示用的按鍵名稱
// ---------------------------------------------------------------------------

const NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps Lock',
  Shift: 'Shift', ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
  Control: 'Ctrl', ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl',
  Alt: IS_MAC ? 'Option' : 'Alt', AltLeft: IS_MAC ? '左 Option' : '左 Alt', AltRight: IS_MAC ? '右 Option' : '右 Alt',
  Escape: 'Esc', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\', IntlRo: 'ろ', IntlYen: '¥',
  NumpadAdd: '數字鍵 +', NumpadSubtract: '數字鍵 -', NumpadMultiply: '數字鍵 *', NumpadDivide: '數字鍵 /',
  NumpadDecimal: '數字鍵 .', NumpadEnter: '數字鍵 Enter', NumLock: 'Num Lock', ScrollLock: 'Scroll Lock', Pause: 'Pause',
  ContextMenu: '選單鍵', PrintScreen: 'PrtSc',
};
/** 英文版跟中文不一樣的按鍵名稱 */
const NAMES_EN: Record<string, string> = {
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: IS_MAC ? 'Left Option' : 'Left Alt', AltRight: IS_MAC ? 'Right Option' : 'Right Alt',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  ContextMenu: 'Menu',
};

/** 實際鍵盤配置的字（Chrome 系才有；例如 AZERTY 的 KeyQ 是 A） */
let layout: Map<string, string> | null = null;
let layoutAsked = false;
export function loadKeyboardLayout(onReady?: () => void): void {
  if (layoutAsked) return;
  layoutAsked = true;
  const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return;
  kb.getLayoutMap().then((m) => {
    layout = m;
    onReady?.();
  }).catch(() => {});
}

export function keyName(code: string): string {
  if (!code) return '';
  if (isEn() && NAMES_EN[code]) return NAMES_EN[code];
  if (NAMES[code]) return NAMES[code];
  const lay = layout?.get(code);
  if (lay && lay.trim()) return lay.length === 1 ? lay.toUpperCase() : lay;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return (isEn() ? 'Num ' : '數字鍵 ') + m[1];
  return code;
}
