import type { KartInput } from './game/kart';

type TouchBtn = 'drift' | 'boost' | 'brake' | 'fire1' | 'fire2' | 'look';

const GAME_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'KeyZ', 'KeyX', 'KeyC', 'KeyR',
]);

/** 鍵盤與觸控輸入統一成 KartInput */
export class Input {
  /** 是否攔截遊戲按鍵的瀏覽器預設行為（比賽中才開） */
  capture = false;
  touchMode = false;
  onPause: () => void = () => {};
  onReset: () => void = () => {};
  private keys = new Set<string>();
  private touch: Record<TouchBtn, boolean> = { drift: false, boost: false, brake: false, fire1: false, fire2: false, look: false };
  private steerTouch = 0;
  private out: KartInput = { steer: 0, accel: 0, drift: false, boost: false, firePrimary: false, fireSecondary: false };

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (this.capture && GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.touchMode = false;
      if (e.code === 'Escape' || e.code === 'KeyP') this.onPause();
      if (e.code === 'KeyR') this.onReset();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
  }

  clear(): void {
    this.keys.clear();
    this.steerTouch = 0;
    for (const k of Object.keys(this.touch) as TouchBtn[]) this.touch[k] = false;
    document.querySelectorAll('#touch .on').forEach((el) => el.classList.remove('on'));
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  get lookBack(): boolean {
    return this.down('KeyC') || this.touch.look;
  }

  read(): KartInput {
    const o = this.out;
    const t = this.touch;
    let steer = 0;
    if (this.down('ArrowLeft', 'KeyA')) steer += 1;
    if (this.down('ArrowRight', 'KeyD')) steer -= 1;
    if (steer === 0) steer = this.steerTouch;
    o.steer = steer;
    let accel = 0;
    if (this.down('ArrowUp', 'KeyW')) accel += 1;
    if (this.down('ArrowDown', 'KeyS')) accel -= 1;
    // 觸控模式：自動油門，按住煞車鍵才減速
    if (this.touchMode) accel = t.brake ? -1 : 1;
    o.accel = accel;
    o.drift = this.down('ShiftLeft', 'ShiftRight') || t.drift;
    o.boost = this.down('ControlLeft', 'ControlRight', 'Space') || t.boost;
    o.firePrimary = this.down('KeyZ') || t.fire1;
    o.fireSecondary = this.down('KeyX') || t.fire2;
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
