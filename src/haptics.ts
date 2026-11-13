/**
 * 手機震動：Android 等支援 navigator.vibrate 的瀏覽器才有；iPhone Safari 不支援，就什麼都不做。
 * 只在觸控裝置、設定打開時震動。
 */
export class Haptics {
  enabled = true;
  private ok = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  /** 壓路緣：下一次可以震的時間（毫秒） */
  private nextKerb = 0;
  private busyUntil = 0;

  pulse(ms: number, now = performance.now()): void {
    if (!this.enabled || !this.ok) return;
    try {
      navigator.vibrate(ms);
      this.busyUntil = now + ms;
    } catch {
      /* 瀏覽器拒絕（例如還沒有使用者互動）就略過 */
    }
  }

  /** 壓在路緣上：一下一下短促的震動，車越快越密（k = 0~1） */
  kerb(k: number, now = performance.now()): void {
    if (k < 0.05 || now < this.nextKerb || now < this.busyUntil) return;
    this.nextKerb = now + 120 - 50 * k;
    this.pulse(Math.round(10 + 12 * k), now);
  }
}
