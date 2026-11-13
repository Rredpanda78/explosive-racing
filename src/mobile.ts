/**
 * 手機（尤其 iPhone Safari）的畫面修正。
 * 問題：橫屏、直屏轉來轉去之後，Safari 會殘留放大倍率；我們又關掉了雙指縮放，結果畫面放大卡住縮不回來。
 * 做法：
 * 1. 轉向或視窗大小改變後，重新設定 viewport（兩種等價寫法輪流換，逼 Safari 重新套用 1 倍），捲回原點
 * 2. 偵測到 visualViewport 被放大（scale > 1）時也立刻重設
 * 3. 擋掉 iOS 的雙指縮放手勢（Safari 會無視 user-scalable=no）
 * 4. 介面單位 --u 用實際可見的寬高算（Safari 的 vh 會把網址列算進去，轉向後也常常是舊的值）
 * 5. iOS 轉向後回報的尺寸會晚一點才正確：分幾次重新量
 */
const VIEWPORTS = [
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
];

export function setupMobileViewport(onResize: () => void): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  let which = 0;
  const vv = window.visualViewport;

  const setUnit = () => {
    const w = window.innerWidth, h = window.innerHeight;
    if (w < 2 || h < 2) return;
    document.documentElement.style.setProperty('--u', `${Math.min(h / 100, w * 0.0056).toFixed(3)}px`);
  };

  const resetZoom = () => {
    if (meta) {
      which = 1 - which;
      meta.content = VIEWPORTS[which];
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const settle = () => {
    if (vv && vv.scale > 1.01) resetZoom();
    else window.scrollTo(0, 0);
    setUnit();
    onResize();
  };

  let timers: number[] = [];
  const schedule = (orient: boolean) => {
    for (const t of timers) window.clearTimeout(t);
    if (orient) resetZoom();
    timers = [0, 150, 400, 900].map((ms) => window.setTimeout(settle, ms));
  };
  window.addEventListener('resize', () => schedule(false));
  window.addEventListener('orientationchange', () => schedule(true));
  screen.orientation?.addEventListener?.('change', () => schedule(true));
  vv?.addEventListener('resize', () => {
    if (vv.scale > 1.01) schedule(true);
  });

  // iOS 的雙指縮放手勢（gesturestart/gesturechange 只有 Safari 有）
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  // 雙擊放大：比賽畫面本來就是 touch-action: none；選單的按鈕連點也不要放大
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  if (meta) meta.content = VIEWPORTS[0];
  setUnit();
}
