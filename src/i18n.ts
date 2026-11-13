// 介面語言：繁體中文（zh，原本的字一字不改）與英文（en）
// ・畫面上的字串表在 src/lang/zh.ts、src/lang/en.ts（帳號面板另外在 src/lang/account.ts，跟著面板分開下載）
// ・車款、武器、賽道、難度等資料的名稱與說明留在原本的定義裡（中文），英文另外列在旁邊，用 localize() 換成跟著語言切換的 getter
// ・語言只影響畫面顯示：不會經過網路（中文、英文的玩家可以在同一個房間），也不影響模擬
import { zh } from './lang/zh';
import { en } from './lang/en';

export type Lang = 'zh' | 'en';
export const LANGS: Lang[] = ['zh', 'en'];

/** 沒存過語言時的預設：瀏覽器語言是中文就用中文，其他都用英文 */
export function detectLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.languages?.[0] || navigator.language || '' : '';
  return /^zh\b/i.test(nav) ? 'zh' : 'en';
}

let cur: Lang = detectLang();
const listeners = new Set<(l: Lang) => void>();

/** 目前的語言 */
export const lang = (): Lang => cur;
export const isEn = (): boolean => cur === 'en';

/** 換語言：更新 <html lang>、index.html 裡標了 data-i18n 的字，再通知各畫面重畫 */
export function setLang(l: Lang): void {
  const changed = l !== cur;
  cur = l;
  applyDom();
  if (changed) for (const f of listeners) f(l);
}

/** 換語言時要做的事（重畫畫面、換 HUD 的字、重畫場景裡的指示牌…）；回傳取消函式 */
export function onLang(f: (l: Lang) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

type Dict = typeof zh;
const DICTS: Record<Lang, Dict> = { zh, en };

/** 畫面上的字串：t.key 或 t.key(參數)；永遠回傳目前語言的版本 */
export const t: Dict = new Proxy(zh, {
  get: (_o, k) => (DICTS[cur] as Record<string | symbol, unknown>)[k],
}) as Dict;

/** 給延後下載的模組（帳號面板）用：自己帶一組中英字串表 */
export function dict<D extends object>(zhD: D, enD: D): D {
  return new Proxy(zhD, { get: (_o, k) => ((cur === 'en' ? enD : zhD) as Record<string | symbol, unknown>)[k] }) as D;
}

/**
 * 把資料物件的幾個文字欄位換成跟著語言切換的 getter：中文用原本的值（一字不改），英文用 en 裡的。
 * 回傳同一個物件（呼叫端的型別不變，讀 .name、.desc 的地方都不用改）。
 */
export function localize<T extends object>(obj: T, enText: { [K in keyof T]?: T[K] extends string | undefined ? string : never }): T {
  for (const k of Object.keys(enText) as (keyof T & string)[]) {
    const zhv = (obj as Record<string, unknown>)[k];
    const env = (enText as Record<string, unknown>)[k];
    Object.defineProperty(obj, k, { get: () => (cur === 'en' ? env : zhv), enumerable: true, configurable: true });
  }
  return obj;
}

/** index.html 裡固定的字：data-i18n（文字）、data-i18n-aria（aria-label） */
function applyDom(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = cur === 'zh' ? 'zh-Hant' : 'en';
  const d = DICTS[cur] as Record<string, unknown>;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const v = d[el.dataset.i18n!];
    if (typeof v === 'string') el.innerHTML = v;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    const v = d[el.dataset.i18nAria!];
    if (typeof v === 'string') el.setAttribute('aria-label', v);
  });
}
