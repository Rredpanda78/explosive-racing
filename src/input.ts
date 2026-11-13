import type { KartInput } from './game/kart';
import { defaultKeys, expand, KEY_ACTIONS, type KeyAction, type KeyMap } from './keymap';

type TouchBtn = 'drift' | 'boost' | 'brake' | 'fire1' | 'fire2' | 'look' | 'driftl' | 'driftr';

/** 比賽中一律攔截的鍵（避免方向鍵、空白鍵捲動頁面），其餘的依目前鍵位加進來 */
const ALWAYS_CAPTURE = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];

/**
 * 傾斜轉向：用重力在螢幕平面上的方向算出手機轉了幾度（像握方向盤）。
 * 以開始時的握法當作正中（校正），所以 iOS 與 Android 的座標正負號不同也沒關係。
 */
export class Tilt {
  enabled = false;
  steer = 0;
  range = 24;
  invert = false;
  private neutral: number | null = null;

  /** iOS 需要在使用者點擊時要求權限 */
  async enable(): Promise<boolean> {
    const DM = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    try {
      if (DM && typeof DM.requestPermission === 'function' && (await DM.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
    if (!this.enabled) window.addEventListener('devicemotion', this.onMotion);
    this.enabled = true;
    this.neutral = null;
    return true;
  }

  disable(): void {
    window.removeEventListener('devicemotion', this.onMotion);
    this.enabled = false;
    this.steer = 0;
  }

  /** 把目前的握法當作正中 */
  calibrate(): void {
    this.neutral = null;
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null) return;
    const so = (screen as unknown as { orientation?: { angle?: number } }).orientation;
    const ang = ((so?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) + 360) % 360;
    const gx = g.x ?? 0, gy = g.y ?? 0;
    let sx: number, sy: number;
    if (ang === 90) { sx = -gy; sy = gx; }
    else if (ang === 270) { sx = gy; sy = -gx; }
    else if (ang === 180) { sx = -gx; sy = -gy; }
    else { sx = gx; sy = gy; }
    const a = Math.atan2(sx, sy);
    if (this.neutral === null) this.neutral = a;
    let d = a - this.neutral;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    let deg = (d * 180) / Math.PI;
    // 小角度的死區，避免手抖造成蛇行
    deg = Math.sign(deg) * Math.max(0, Math.abs(deg) - 2);
    const want = Math.max(-1, Math.min(1, deg / this.range)) * (this.invert ? -1 : 1);
    this.steer += (want - this.steer) * 0.5;
  };
}

/** 鍵盤與觸控輸入統一成 KartInput */
export class Input {
  /** 是否攔截遊戲按鍵的瀏覽器預設行為（比賽中才開） */
  capture = false;
  touchMode = false;
  onPause: () => void = () => {};
  onReset: () => void = () => {};
  tilt = new Tilt();
  /** 手機用傾斜轉向（方向鍵按鈕隱藏） */
  tiltMode = false;
  private keys = new Set<string>();
  private touch: Record<TouchBtn, boolean> = { drift: false, boost: false, brake: false, fire1: false, fire2: false, look: false, driftl: false, driftr: false };
  /** 鍵盤轉向：按住後在短時間內漸增，短按可以微調 */
  private kbSteer = 0;
  private lastRead = performance.now();
  private steerTouch = 0;
  private out: KartInput = { steer: 0, accel: 0, drift: false, boost: false, firePrimary: false, fireSecondary: false };
  /** 每個動作實際對應的 KeyboardEvent.code（Shift 展開成左右兩顆） */
  private codes = {} as Record<KeyAction, string[]>;
  private gameKeys = new Set<string>();

  constructor() {
    this.setKeys(defaultKeys());
    window.addEventListener('keydown', (e) => {
      if (this.capture && this.gameKeys.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.touchMode = false;
      // Esc 一律可以暫停（改鍵時 Esc 是取消，所以不開放改掉）
      if (e.code === 'Escape' || this.codes.pause.includes(e.code)) this.onPause();
      if (this.codes.reset.includes(e.code)) this.onReset();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
  }

  /** 套用設定頁的鍵位 */
  setKeys(map: KeyMap): void {
    const all = new Set(ALWAYS_CAPTURE);
    for (const { id } of KEY_ACTIONS) {
      const list = map[id].flatMap(expand);
      this.codes[id] = list;
      for (const c of list) all.add(c);
    }
    this.gameKeys = all;
  }

  clear(): void {
    this.keys.clear();
    this.steerTouch = 0;
    for (const k of Object.keys(this.touch) as TouchBtn[]) this.touch[k] = false;
    document.querySelectorAll('#touch .on').forEach((el) => el.classList.remove('on'));
  }

  /** 這個動作的任一顆鍵按著 */
  private down(a: KeyAction): boolean {
    for (const c of this.codes[a]) if (this.keys.has(c)) return true;
    return false;
  }

  get lookBack(): boolean {
    return this.down('look') || this.touch.look;
  }

  read(): KartInput {
    const o = this.out;
    const t = this.touch;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastRead) / 1000);
    this.lastRead = now;
    let want = 0;
    if (this.down('left')) want += 1;
    if (this.down('right')) want -= 1;
    // 0.12 秒轉到底；換邊或放開時立刻歸零
    if (want === 0 || Math.sign(want) !== Math.sign(this.kbSteer)) this.kbSteer = 0;
    if (want !== 0) this.kbSteer = Math.max(-1, Math.min(1, this.kbSteer + want * (dt / 0.12) + want * 0.18 * (this.kbSteer === 0 ? 1 : 0)));
    let steer = this.kbSteer;
    if (steer === 0) steer = this.tiltMode && this.tilt.enabled ? this.tilt.steer : this.steerTouch;
    // 左甩／右甩鍵：按住就往那邊甩尾
    if (t.driftl || t.driftr) steer = t.driftl ? 1 : -1;
    o.steer = steer;
    let accel = 0;
    if (this.down('up')) accel += 1;
    if (this.down('down')) accel -= 1;
    // 觸控模式：自動油門，按住煞車鍵才減速
    if (this.touchMode) accel = t.brake ? -1 : 1;
    o.accel = accel;
    o.drift = this.down('drift') || t.drift || t.driftl || t.driftr;
    o.boost = this.down('boost') || t.boost;
    o.firePrimary = this.down('fire1') || t.fire1;
    o.fireSecondary = this.down('fire2') || t.fire2;
    return o;
  }

  bindTouch(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('[data-btn]').forEach((el) => {
      const name = el.dataset.btn as TouchBtn;
      const set = (v: boolean) => {
        this.touch[name] = v;
        el.classList.toggle('on', v);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchMode = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        set(true);
      });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, () => set(false));
    });

    const zone = root.querySelector<HTMLElement>('[data-steer]');
    if (zone) {
      const l = zone.querySelector<HTMLElement>('.steer-l');
      const r = zone.querySelector<HTMLElement>('.steer-r');
      let pid = -1;
      const apply = (e: PointerEvent) => {
        const rect = zone.getBoundingClientRect();
        this.steerTouch = e.clientX < rect.left + rect.width / 2 ? 1 : -1;
        l?.classList.toggle('on', this.steerTouch > 0);
        r?.classList.toggle('on', this.steerTouch < 0);
      };
      const end = (e: PointerEvent) => {
        if (e.pointerId !== pid) return;
        pid = -1;
        this.steerTouch = 0;
        l?.classList.remove('on');
        r?.classList.remove('on');
      };
      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchMode = true;
        pid = e.pointerId;
        try { zone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        apply(e);
      });
      zone.addEventListener('pointermove', (e) => { if (e.pointerId === pid) apply(e); });
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
    }
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
