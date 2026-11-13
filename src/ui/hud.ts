import { Vector3 } from 'three';
import { KILL_REWARD, STREAK_BONUS } from '../game/config';
import type { Kart } from '../game/kart';
import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { formatTime } from '../game/util';
import { PRIMARY, SECONDARY, type PrimaryId, type SecondaryId } from '../game/weapons';
import type { GameView } from '../render/view';
import { ICONS, primaryIcon, secondaryIcon } from './touchIcons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 比賽中的抬頭顯示：名次、圈數、速度、集氣、武器、小地圖、任務與各種提示 */
export class Hud {
  private root = $('hud');
  private pos = $('pos');
  private lap = $('lap');
  private laps = $('laps');
  private lapSep = $('lap-sep');
  private time = $('hud-time');
  private speed = $('speed').querySelector('b')!;
  private netinfo = $('netinfo');
  private fps = 60;
  private infoT = 0;
  /** 角落資訊：顯示 FPS；線上比賽時另外附上連線摘要 */
  showInfo = true;
  netSummary: (() => string) | null = null;
  private gauge = $('gauge').querySelector('i')!;
  private n2o = Array.from($('n2o').querySelectorAll('i'));
  private hp = $('hp');
  private hpBar = $('hp').querySelector('i')!;
  private w1 = $('w1');
  private w2 = $('w2');
  private w1Bar = $('w1').querySelector('i')!;
  private w2Bar = $('w2').querySelector('i')!;
  private center = $('center-msg');
  private sub = $('sub-msg');
  private reticle = $('reticle');
  private feed = $('feed');
  private popups = $('popups');
  private elim = $('elim');
  private missions = $('missions');
  private map = $<HTMLCanvasElement>('minimap');
  private fxSpeed = $('fx-speed');
  private fxHit = $('fx-hit');
  private hitK = 0;
  private hitMarkT = 0;
  private missionT = 0;
  private wasDrafting = false;
  /** 傷害數字：同一台車短時間內的傷害合併成一個數字 */
  private dmgLayer = document.createElement('div');
  /** 設定：顯示傷害數字 */
  dmgNumbers = true;
  /** 連線狀況提示（重新連線中…），有的話優先顯示 */
  netNote = '';
  /** 手機按鈕 */
  private tBoost = $('t-boost');
  private tBoostIc = this.tBoost.querySelector<HTMLElement>('.ic')!;
  private tBoostLb = this.tBoost.querySelector<HTMLElement>('b')!;
  private tBoostN = this.tBoost.querySelector<HTMLElement>('em')!;
  private dmgAcc = new Map<Kart, { amt: number; t: number; fatal: boolean; mine: boolean }>();
  private mapBg = document.createElement('canvas');
  private mapT = { s: 1, ox: 0, oz: 0, size: 220 };
  private cache: Record<string, string | number> = {};
  private scr = { x: 0, y: 0 };
  /** 命中標記（準星旁的 X）：打中時小小的米白色，擊毀時大一點的珊瑚紅 */
  private hitX = document.createElement('div');
  /** 受擊方向：畫面中央一圈弧形，指向攻擊來的方向 */
  private dirLayer = document.createElement('div');
  private dirs: { el: HTMLElement; t: number; x: number; z: number; src: unknown }[] = [];
  /** 連擊計數：短時間內連續打中 */
  private comboEl = document.createElement('div');
  private comboN = 0;
  private comboT = 0;
  private comboShown = 0;
  private comboFrame = new Set<Kart>();
  private flameComboT = 0;
  /** 自己的雷射射出時畫面閃一下 */
  private flashEl = document.createElement('div');
  /** 這一幀有沒有在玩家附近爆炸（受擊方向改指向爆炸點） */
  private blastNear = false;
  private camDir = new Vector3();
  /** 擊毀獎金：下一幀在被擊毀的車上方飄出來 */
  private killText: { k: Kart; text: string; x: number; y: number; z: number } | null = null;

  constructor(track: Track) {
    this.setTrack(track);
    document.querySelectorAll<HTMLElement>('#touch [data-icon]').forEach((el) => {
      el.innerHTML = ICONS[el.dataset.icon as keyof typeof ICONS] ?? '';
    });
    this.dmgLayer.id = 'dmgnums';
    this.root.appendChild(this.dmgLayer);
    this.hitX.id = 'hitx';
    this.dirLayer.id = 'dmgdir';
    this.comboEl.id = 'combo';
    this.flashEl.id = 'fx-flash';
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('div');
      this.dirLayer.appendChild(el);
      this.dirs.push({ el, t: 0, x: 0, z: 0, src: null });
    }
    this.root.append(this.flashEl, this.dirLayer, this.hitX, this.comboEl);
  }

  /** 命中標記：重新播放動畫 */
  private hitMark(kill: boolean): void {
    const el = this.hitX;
    if (!kill && el.classList.contains('kill') && el.getAnimations().some((a) => a.playState === 'running')) return;
    el.className = '';
    void el.offsetWidth;
    el.className = kill ? 'kill' : 'on';
  }

  /** 連擊：同一幀同一台車只算一次 */
  private addCombo(k: Kart): void {
    if (this.comboFrame.has(k)) return;
    this.comboFrame.add(k);
    this.comboN = this.comboT > 0 ? this.comboN + 1 : 1;
    this.comboT = 1.1;
  }

  /** 受擊方向：來源 (x, z)；同一個來源短時間內重複受擊只更新同一個弧 */
  private hitFrom(x: number, z: number, src: unknown): void {
    let d = this.dirs.find((o) => o.t > 0 && o.src === src && src !== null);
    if (!d) d = this.dirs.reduce((a, b) => (a.t <= b.t ? a : b));
    d.t = 1;
    d.x = x;
    d.z = z;
    d.src = src;
  }

  /** 自己的雷射射出：整個畫面閃一下粉白色 */
  private screenFlash(): void {
    const el = this.flashEl;
    el.style.transition = 'none';
    el.style.opacity = '0.32';
    void el.offsetWidth;
    el.style.transition = 'opacity .22s ease-out';
    el.style.opacity = '0';
  }

  /** 手機開火鈕：圖示與名稱依裝備的武器 */
  setWeaponIcons(primary: PrimaryId, secondary: SecondaryId): void {
    $('t-fire1').querySelector('.ic')!.innerHTML = primaryIcon(primary);
    $('t-fire2').querySelector('.ic')!.innerHTML = secondaryIcon(secondary);
    $('t-fire1').querySelector('b')!.textContent = PRIMARY[primary].name.replace('.50 ', '');
    $('t-fire2').querySelector('b')!.textContent = SECONDARY[secondary].name;
  }

  /** 換地圖時重畫小地圖底圖 */
  setTrack(track: Track): void {
    this.buildMap(track);
  }

  show(race: Race): void {
    this.root.classList.remove('hidden');
    const elim = race.mode === 'elim';
    this.laps.textContent = elim ? '' : String(race.track.laps);
    this.lapSep.textContent = elim ? '' : '/';
    this.elim.classList.toggle('hidden', !elim);
    this.w1.querySelector('.wname')!.textContent = PRIMARY[race.player.primary].name;
    this.w2.querySelector('.wname')!.textContent = SECONDARY[race.player.secondary].name;
    this.setWeaponIcons(race.player.primary, race.player.secondary);
    this.feed.innerHTML = '';
    this.popups.innerHTML = '';
    this.dmgLayer.innerHTML = '';
    this.dmgAcc.clear();
    this.cache = {};
    this.center.className = '';
    this.center.textContent = '';
    this.sub.textContent = '';
    this.hitK = 0;
    this.missionT = 9;
    this.wasDrafting = false;
    this.missions.classList.remove('fade');
    this.comboN = this.comboT = this.comboShown = 0;
    this.comboEl.className = '';
    this.hitX.className = '';
    for (const d of this.dirs) { d.t = 0; d.el.style.opacity = '0'; }
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private set(key: string, el: HTMLElement, text: string): void {
    if (this.cache[key] !== text) {
      this.cache[key] = text;
      el.textContent = text;
    }
  }

  private width(key: string, el: HTMLElement, frac: number): void {
    const v = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    if (this.cache[key] !== v) {
      this.cache[key] = v;
      el.style.width = v + '%';
    }
  }

  private cls(key: string, el: HTMLElement, name: string, on: boolean): void {
    const v = on ? 1 : 0;
    if (this.cache[key] !== v) {
      this.cache[key] = v;
      el.classList.toggle(name, on);
    }
  }

  flash(text: string, stay = false): void {
    this.center.textContent = text;
    this.center.className = '';
    void this.center.offsetWidth;
    this.center.className = stay ? 'stay' : 'pop';
  }

  /** 畫面右側往上飄的小提示（得分、技巧名稱） */
  popup(text: string, kind = ''): void {
    const d = document.createElement('div');
    d.className = kind;
    d.textContent = text;
    this.popups.appendChild(d);
    setTimeout(() => d.remove(), 1700);
    while (this.popups.children.length > 5) this.popups.firstChild!.remove();
  }

  onEvent(e: RaceEvent, race: Race): void {
    const p = race.player;
    switch (e.t) {
      case 'count':
        this.flash(String(e.n));
        break;
      case 'go':
        this.flash('GO!');
        break;
      case 'start':
        if (e.k === p) this.popup('起跑衝刺！', 'gold');
        break;
      case 'lap':
        if (e.k !== p) break;
        if (race.mode === 'race' && e.lap < race.track.laps) this.flash(e.lap === race.track.laps - 1 ? '最後一圈！' : `第 ${e.lap + 1} 圈`);
        break;
      case 'finish':
        if (e.k === p) this.flash(race.mode === 'elim' ? '冠軍！' : `第 ${p.rank} 名`, true);
        break;
      case 'elim':
        if (e.k === p) this.flash('遭到淘汰', true);
        else this.popup(`${e.k.name} 遭到淘汰`, 'warn');
        break;
      case 'hit':
        if (e.by === p) {
          this.hitMarkT = 0.12;
          // 火焰每秒判定很多次：命中標記與連擊放慢一點算
          if (e.w !== 'flame' || this.flameComboT <= 0) {
            if (e.w === 'flame') this.flameComboT = 0.3;
            this.hitMark(false);
            this.addCombo(e.k);
          }
        }
        if (e.k === p && e.by !== p) this.hitFrom(e.by.x, e.by.z, e.by);
        break;
      case 'blast':
        // 玩家被爆炸波及：受擊方向指向爆炸點
        if (!e.kart && Math.hypot(e.x - p.x, e.z - p.z) < e.r + 1.2 && !p.dead) {
          this.blastNear = true;
          if (Math.hypot(e.x - p.x, e.z - p.z) > 1.2) this.hitFrom(e.x, e.z, null);
        }
        break;
      case 'dmg': {
        if (e.k === p) {
          // 受擊方向（子彈、火焰、雷射在 hit 事件處理；這裡補上導彈、地雷等沒有 hit 事件的）
          if (e.by && e.by !== p && !this.blastNear && e.amount >= 0.5) this.hitFrom(e.by.x, e.by.z, e.by);
          break;
        }
        // 只顯示玩家打出去的傷害
        if (e.by !== p) break;
        // 爆炸、雷射這種一下很大的傷害：也算命中
        if (e.amount >= 12) {
          this.hitMark(false);
          this.addCombo(e.k);
        }
        const a = this.dmgAcc.get(e.k) ?? { amt: 0, t: 0, fatal: false, mine: true };
        a.amt += e.amount;
        a.fatal = a.fatal || e.fatal;
        this.dmgAcc.set(e.k, a);
        break;
      }
      case 'shortcut':
        if (e.k === p) this.popup('捷徑！', 'gold');
        break;
      case 'hazard':
        if (e.k === p) this.hitFrom(e.x, e.z, null);
        if (e.k === p) {
          const train = race.track.def.hazards?.some((h) => h.train);
          const msg: Record<string, string> = { hammer: '被鐵鎚砸飛！', tram: train ? '被火車撞飛！' : '被電車撞飛！', boulder: '被落石撞到！', scooter: '被機車擦撞！', firecracker: '被鞭炮炸到！' };
          this.popup(msg[e.kind] ?? '小心！', 'warn');
        }
        break;
      case 'lock':
        if (e.k === p) this.popup('被追蹤導彈鎖定！', 'warn');
        break;
      case 'ram':
        if ((e.a === p || e.b === p) && e.power > 5) {
          const fast = p.boostT > 0 || p.padT > 0;
          this.popup(fast ? '噴射衝撞！' : '碰撞！', fast ? 'gold' : '');
          const o = e.a === p ? e.b : e.a;
          this.hitFrom(o.x, o.z, o);
        }
        break;
      case 'kart':
        if (e.k !== p) break;
        if (e.e === 'jump') this.popup('飛越！');
        else if (e.e === 'n2o') this.popup('N2O +1', 'blue');
        // 小噴：甩完時下方已經有「小噴！」的時機提示，這裡不再另外跳一個（使用者說兩個重複）
        else if (e.e === 'combo') this.popup(`連噴 ×${p.combo}`, 'gold');
        else if (e.e === 'chain') this.popup('短接長！集氣加速', 'blue');
        else if (e.e === 'driftCancel') this.popup('斷飄');
        else if (e.e === 'hardDrift') this.popup('重甩！', 'gold');
        break;
      case 'rail':
        if (e.k === p) this.screenFlash();
        if (e.k === p && e.hits >= 2) this.popup(`雷射貫穿 ×${e.hits}`, 'gold');
        break;
      case 'kill': {
        const d = document.createElement('div');
        const killer = e.killer ? e.killer.name : '';
        if (e.killer === p || e.victim === p) d.className = 'me';
        d.textContent = `${killer} 💥 ${e.victim.name}`;
        this.feed.appendChild(d);
        setTimeout(() => d.remove(), 4000);
        while (this.feed.children.length > 4) this.feed.firstChild!.remove();
        if (e.killer === p) {
          this.flash(e.streak >= 2 ? `連續擊毀 ×${e.streak}` : '擊毀！');
          this.popup('N2O +1', 'blue');
          this.hitMark(true);
          // 被擊毀的車上方飄出獎金（連續擊毀另外加獎金）
          const cash = KILL_REWARD + Math.max(0, e.streak - 1) * STREAK_BONUS;
          this.killText = { k: e.victim, text: `+$${cash} 擊毀！`, x: e.victim.x, y: e.victim.y, z: e.victim.z };
        }
        break;
      }
    }
  }

  update(race: Race, view: GameView, dt: number): void {
    if (dt > 0) this.fps += (1 / Math.max(dt, 1 / 240) - this.fps) * 0.05;
    this.infoT -= dt;
    if (this.infoT <= 0) {
      this.infoT = 0.5;
      const net = this.netSummary?.();
      const txt = this.showInfo || net ? [this.showInfo ? `FPS ${Math.round(this.fps)}` : '', net ?? ''].filter(Boolean).join('・') : '';
      this.set('netinfo', this.netinfo, txt);
    }
    const p = race.player;
    const elim = race.mode === 'elim';
    this.set('pos', this.pos, String(p.rank));
    this.set('lap', this.lap, String(elim ? Math.max(1, p.lapCount + 1) : Math.min(race.track.laps, Math.max(1, p.lapCount + 1))));
    this.set('time', this.time, formatTime(p.finished ? p.finishTime : race.time));
    this.set('speed', this.speed, String(Math.round(Math.abs(p.speed) * 5.5)));
    this.width('gauge', this.gauge, p.gauge);
    for (let i = 0; i < this.n2o.length; i++) this.cls('n' + i, this.n2o[i], 'full', p.n2o > i);
    this.width('hp', this.hpBar, p.hp / p.maxHp);
    this.cls('hplow', this.hp, 'low', p.hp < p.maxHp * 0.35);
    // 雷射：條狀顯示充能進度（冷卻中慢慢補滿）；其他主武器顯示熱量
    this.width('w1', this.w1Bar, PRIMARY[p.primary].kind === 'laser' ? 1 - p.heat : p.heat);
    this.cls('w1hot', this.w1, 'hot', p.overheated);
    const S = SECONDARY[p.secondary];
    this.width('w2', this.w2Bar, 1 - p.secCd / S.cooldown);
    this.cls('w2cd', this.w2, 'cd', p.secCd > 0);

    // 淘汰賽倒數
    if (elim) {
      const alive = race.aliveCount;
      const last = p.rank === alive && !p.out;
      this.set('elim', this.elim, race.state === 'racing' ? `淘汰倒數 ${Math.ceil(race.elimT)}　剩 ${alive} 台${last ? '　你是最後一名！' : ''}` : '');
      this.cls('elimwarn', this.elim, 'warn', last && race.elimT < 8);
    }

    // 尾流開始時提示一次
    if (p.drafting && !this.wasDrafting) this.popup('尾流加速', 'blue');
    this.wasDrafting = p.drafting;

    // 畫面效果：加速時的速度線、受擊時的紅色邊框
    const sp = Math.round(Math.max(view.boostK, p.drafting ? 0.35 : 0, p.drifting ? Math.min(0.4, Math.abs(p.slip) * 0.9) : 0) * 10) / 10;
    if (this.cache.fxs !== sp) {
      this.cache.fxs = sp;
      this.fxSpeed.style.opacity = String(sp);
    }
    // 紅色邊框保持低調：受擊方向由中央的弧形指示，這裡只是淡淡一圈
    this.hitK = p.dead ? 0.55 : Math.max(p.sinceDamage < 0.1 ? 0.45 : 0, this.hitK - 0.03, p.hp < p.maxHp * 0.3 ? 0.3 : 0);
    const hk = Math.round(this.hitK * 10) / 10;
    if (this.cache.fxh !== hk) {
      this.cache.fxh = hk;
      this.fxHit.style.opacity = String(hk);
    }

    // 提示訊息
    let sub = '';
    let subCls = '';
    if (this.netNote) { sub = this.netNote; subCls = 'warn'; }
    else if (p.dead) { sub = p.out ? '' : '車輛重生中…'; subCls = 'warn'; }
    else if (p.finished) sub = '';
    else if (p.wrongWayT > 1) { sub = '逆向行駛！'; subCls = 'warn'; }
    else if (p.lockT > 0) { sub = '⚠ 導彈來襲：急轉可以甩掉'; subCls = 'warn'; }
    else if (p.overheated && PRIMARY[p.primary].kind !== 'laser') { sub = '武器過熱'; subCls = 'warn'; }
    else if (p.miniWindowT > 0) { sub = '小噴！'; subCls = 'mini'; }
    else if (race.state === 'countdown' && race.countdown < 1.4) { sub = document.body.classList.contains('touch') ? '抓準 GO 的瞬間按 N2O' : '抓準 GO 的瞬間按油門'; }
    this.set('sub', this.sub, sub);
    if (this.cache.subCls !== subCls) {
      this.cache.subCls = subCls;
      this.sub.className = subCls;
    }

    // 準星：固定指向車頭正前方 45 公尺處，不會鎖定敵人；打中時閃一下
    const show = !p.dead && !p.finished && race.state !== 'countdown';
    const ax = p.x + Math.sin(p.heading) * 45, az = p.z + Math.cos(p.heading) * 45;
    if (show && view.project(ax, p.y + 0.95 + Math.tan(p.pitch) * 45, az, this.scr)) {
      this.reticle.style.display = 'block';
      const tr = 'translate(' + this.scr.x.toFixed(1) + 'px, ' + this.scr.y.toFixed(1) + 'px)';
      this.reticle.style.transform = tr;
      // 命中標記與連擊數跟著準星
      this.hitX.style.transform = tr;
      this.comboEl.style.transform = tr;
    } else {
      this.reticle.style.display = 'none';
    }
    this.hitMarkT -= dt;
    this.cls('hitmark', this.reticle, 'hit', this.hitMarkT > 0);
    this.updateCombo(dt);
    this.updateHitDirs(view, p, dt);
    this.blastNear = false;
    this.comboFrame.clear();
    this.flameComboT -= dt;

    // 任務：開場顯示幾秒後淡出，進度每半秒更新一次
    this.missionT -= dt;
    this.cls('missionfade', this.missions, 'fade', this.missionT <= 0);
    const tick = Math.floor(race.time * 2);
    if (this.cache.missionTick !== tick) {
      this.cache.missionTick = tick;
      this.missions.innerHTML = this.missionHtml(race);
    }

    this.drawMap(race);
    this.updateDamageNumbers(view, dt);
    this.updateTouchBoost(race);
  }

  /** N2O 鈕：甩尾結束的小噴時機變成「小噴」（正在噴 N2O 時不切換），沒有氣瓶時變暗 */
  private updateTouchBoost(race: Race): void {
    const p = race.player;
    const boosting = p.boostT > 0;
    const mini = p.miniWindowT > 0 && !boosting;
    const state = mini ? 'mini' : boosting ? 'boosting' : p.n2o > 0 ? 'ready' : 'empty';
    if (this.cache.tboost !== state) {
      this.cache.tboost = state;
      this.tBoost.classList.toggle('mini', mini);
      this.tBoost.classList.toggle('boosting', boosting);
      this.tBoost.classList.toggle('empty', state === 'empty');
      this.tBoostIc.innerHTML = mini ? ICONS.mini : ICONS.n2o;
      this.tBoostLb.textContent = mini ? '小噴' : 'N2O';
    }
    this.set('tboostn', this.tBoostN, mini || p.n2o === 0 ? '' : '×' + p.n2o);
  }

  /** 連擊數：3 下以上才顯示，1.1 秒沒打中就歸零 */
  private updateCombo(dt: number): void {
    this.comboT -= dt;
    if (this.comboT <= 0) this.comboN = 0;
    const n = this.comboN >= 3 ? this.comboN : 0;
    if (n === this.comboShown) return;
    this.comboShown = n;
    if (!n) {
      this.comboEl.className = 'out';
      return;
    }
    this.comboEl.textContent = `連擊 ×${n}`;
    // 每多一下就跳一下（重新播放動畫）
    this.comboEl.className = '';
    void this.comboEl.offsetWidth;
    this.comboEl.className = n >= 10 ? 'on hot' : 'on';
  }

  /** 受擊方向的弧：依攻擊來源相對鏡頭的方向旋轉，0.9 秒內淡掉 */
  private updateHitDirs(view: GameView, p: Kart, dt: number): void {
    let yaw = NaN;
    for (const d of this.dirs) {
      if (d.t <= 0) continue;
      d.t = Math.max(0, d.t - dt / 0.9);
      if (Number.isNaN(yaw)) {
        view.camera.getWorldDirection(this.camDir);
        yaw = Math.atan2(this.camDir.x, this.camDir.z);
      }
      // 來源在鏡頭左邊 → 弧在畫面左邊（追尾視角裡 +X 在左）
      const a = Math.atan2(d.x - p.x, d.z - p.z) - yaw;
      d.el.style.transform = `rotate(${(-a).toFixed(3)}rad)`;
      d.el.style.opacity = (d.t * d.t).toFixed(2);
    }
  }

  /** 每 0.25 秒把累積的傷害變成一個往上飄的數字，擊毀那一下用金色大字 */
  private updateDamageNumbers(view: GameView, dt: number): void {
    // 擊毀獎金：在被擊毀的車上方飄出「+$150 擊毀！」（不受傷害數字設定影響）
    const kt = this.killText;
    if (kt) {
      this.killText = null;
      if (view.project(kt.x, kt.y + 3.6, kt.z, this.scr)) {
        const d = document.createElement('div');
        d.className = 'kill';
        d.textContent = kt.text;
        d.style.left = this.scr.x.toFixed(0) + 'px';
        d.style.top = this.scr.y.toFixed(0) + 'px';
        this.dmgLayer.appendChild(d);
        setTimeout(() => d.remove(), 1500);
      }
    }
    if (!this.dmgNumbers) { this.dmgAcc.clear(); return; }
    for (const [k, a] of this.dmgAcc) {
      a.t += dt;
      if (a.t < 0.25 && !a.fatal) continue;
      this.dmgAcc.delete(k);
      if (a.amt < 0.5) continue;
      if (!view.project(k.x, k.y + 2.2, k.z, this.scr)) continue;
      const d = document.createElement('div');
      d.className = a.fatal ? 'fatal' : a.amt >= 25 ? 'big' : '';
      d.textContent = String(Math.round(a.amt));
      d.style.left = (this.scr.x + (Math.random() - 0.5) * 30).toFixed(0) + 'px';
      d.style.top = this.scr.y.toFixed(0) + 'px';
      this.dmgLayer.appendChild(d);
      setTimeout(() => d.remove(), 900);
      while (this.dmgLayer.children.length > 14) this.dmgLayer.firstChild!.remove();
    }
  }

  /** 任務清單（HUD 與暫停畫面共用） */
  missionHtml(race: Race): string {
    const p = race.player;
    return '<b>本場任務</b>' + race.missions.map((m) => {
      const ok = m.done(p, p.rank) && !['win', 'top3', 'surv4', 'nodeath'].includes(m.id);
      return `<div class="${ok ? 'ok' : ''}">${ok ? '✔' : '・'} ${m.text} <i>${ok ? '' : m.progress(p)}</i> <em>$${m.reward}</em></div>`;
    }).join('');
  }

  private buildMap(track: Track): void {
    const size = this.mapT.size;
    const dpr = 2;
    this.map.width = this.mapBg.width = size * dpr;
    this.map.height = this.mapBg.height = size * dpr;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of track.samples) {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z);
    }
    const pad = 16;
    const sc = Math.min((size - pad * 2) / (maxX - minX), (size - pad * 2) / (maxZ - minZ));
    this.mapT.s = sc;
    // 畫面上方 = +Z（起跑方向），且左右與追尾視角一致：+X 在左
    this.mapT.ox = size / 2 + ((minX + maxX) / 2) * sc;
    this.mapT.oz = size / 2 + ((minZ + maxZ) / 2) * sc;
    const c = this.mapBg.getContext('2d')!;
    c.scale(dpr, dpr);
    c.lineJoin = 'round';
    c.beginPath();
    track.samples.forEach((s, i) => {
      const [x, y] = this.mapXY(s.x, s.z);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.closePath();
    c.strokeStyle = '#0b1a33';
    c.lineWidth = 9;
    c.stroke();
    c.strokeStyle = '#f3ead5';
    c.lineWidth = 5;
    c.stroke();
    // 捷徑：黃色虛線
    for (const b of track.branches) {
      c.beginPath();
      b.samples.forEach((s, i) => {
        const [x, y] = this.mapXY(s.x, s.z);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.setLineDash([]);
      c.strokeStyle = '#0b1a33';
      c.lineWidth = 5;
      c.stroke();
      c.setLineDash([4, 3]);
      c.strokeStyle = '#e8574a';
      c.lineWidth = 3;
      c.stroke();
      c.setLineDash([]);
    }
    // 機關：紅色三角形
    c.fillStyle = '#ffb02e';
    for (const h of track.def.hazards ?? []) {
      const s = track.samples[track.wrap(Math.round(h.dist / track.spacing))];
      const [x, y] = this.mapXY(s.x, s.z);
      c.beginPath();
      c.moveTo(x, y - 5); c.lineTo(x + 4.5, y + 3.5); c.lineTo(x - 4.5, y + 3.5);
      c.closePath();
      c.fill();
    }
    const s0 = track.samples[0];
    const [sx, sy] = this.mapXY(s0.x, s0.z);
    c.fillStyle = '#e8574a';
    c.fillRect(sx - 6, sy - 2, 12, 4);
    // 跳台位置
    c.fillStyle = '#ffd27a';
    for (const r of track.ramps) {
      const s = track.samples[track.wrap(Math.round(r / track.spacing))];
      const [x, y] = this.mapXY(s.x, s.z);
      c.fillRect(x - 3.5, y - 3.5, 7, 7);
    }
  }

  private mapXY(x: number, z: number): [number, number] {
    return [this.mapT.ox - x * this.mapT.s, this.mapT.oz - z * this.mapT.s];
  }

  private drawMap(race: Race): void {
    const c = this.map.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.map.width, this.map.height);
    c.drawImage(this.mapBg, 0, 0);
    c.setTransform(2, 0, 0, 2, 0, 0);
    for (const k of race.karts) {
      if (k.isPlayer || k.dead || k.out) continue;
      const [x, y] = this.mapXY(k.x, k.z);
      c.fillStyle = '#' + k.color.toString(16).padStart(6, '0');
      c.beginPath();
      c.arc(x, y, 4, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = '#0b1a33';
      c.stroke();
    }
    const p = race.player;
    const [x, y] = this.mapXY(p.x, p.z);
    c.fillStyle = '#e8574a';
    c.strokeStyle = '#f3ead5';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 6, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
}
