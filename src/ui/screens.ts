import { CAR_IDS, CARS, type CarId } from '../game/cars';
import { KILL_REWARD } from '../game/config';
import type { Race, RaceMode } from '../game/race';
import { liverySwatch } from '../render/livery';
import { carIcon, weaponIcon } from '../render/weaponIcons';
import { DIFFICULTY, DIFFICULTY_IDS, type DifficultyId } from '../game/difficulty';
import type { Settings } from '../settings';
import { ENGINE_STYLES, MUSIC_STYLES, WEAPON_PACKS } from '../audio';
import { bindKey, clearKey, defaultKeys, KEY_ACTIONS, keyName, loadKeyboardLayout, type KeyAction, type KeyMap } from '../keymap';
import { saveProfile, type Profile } from '../game/save';
import { formatTime } from '../game/util';
import { isEn, lang, t, type Lang } from '../i18n';
import type { OnlineSession } from '../net/online';
import type { PublicRoom } from '../net/room';
import {
  BURN_DPS, PERK_LVL3, PERK_LVL5, CAR_UPGRADES, MAX_CAR_LVL, MAX_WEAPON_LVL, PRIMARY, PRIMARY_IDS, SECONDARY, SECONDARY_IDS, carUpgradeCost, isPrimary,
  laserCooldown, laserKeep, shieldHalfArc, shieldTime, weaponLvlMul, weaponUpgradeCost, type CarUpgradeId, type SecondaryId, type WeaponId,
  ARC_KEEP, arcHops, arcJump, chillRate, pullBonus, sonicPush, tetherTime,
} from '../game/weapons';

export interface TrackInfo {
  name: string;
  desc: string;
  laps: number;
  length: number;
  /** 賽道縮圖的 SVG 路徑 */
  outline: string;
  theme: string;
}

/** 主選單的徽章標誌 */
const EMBLEM = `<svg class="emblem" viewBox="0 0 320 170" aria-label="Explosive Racing">
  <path d="M40 40 L160 14 L280 40 L296 96 L160 160 L24 96 Z" fill="#13284b" stroke="#f3ead5" stroke-width="7" stroke-linejoin="round"/>
  <path d="M52 50 L160 26 L268 50 L281 94 L160 148 L39 94 Z" fill="none" stroke="#f3ead5" stroke-width="2" opacity=".45" stroke-linejoin="round"/>
  <g fill="#e8574a">
    <path d="M128 40l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z"/>
    <path d="M160 32l5 10 11 1.5-8 7.5 2 11-10-5.5-10 5.5 2-11-8-7.5 11-1.5z"/>
    <path d="M192 40l4 8 9 1-7 6 2 9-8-5-8 5 2-9-7-6 9-1z"/>
  </g>
  <text x="160" y="106" text-anchor="middle" font-size="44" font-weight="900" fill="#f3ead5" letter-spacing="1" font-family="'Segoe UI Black','Arial Black',sans-serif">EXPLOSIVE</text>
  <text x="160" y="134" text-anchor="middle" font-size="21" font-weight="900" fill="#f3ead5" letter-spacing="6" font-family="'Segoe UI Black','Arial Black',sans-serif">RACING</text>
  <path d="M8 104h22M4 116h18M290 104h22M298 116h18" stroke="#e8574a" stroke-width="5" stroke-linecap="round"/>
</svg>`;

export interface ScreenActions {
  start(mode?: RaceMode): void;
  selectTrack(i: number): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  toggleMute(): boolean;
  /** 設定改了某一項（已經寫進 settings 物件） */
  settingChanged(key: keyof Settings): void;
  editLayout(): void;
  resetLayout(): void;
  calibrateTilt(): void;
  /** 進出設定頁：在設定頁可以試聽比賽配樂 */
  settingsOpen(open: boolean): void;
  /** 試聽目前選的引擎聲或武器音效 */
  previewSound(kind: 'engine' | 'weapon'): void;
  /** 帳號面板 */
  account(): void;
  /** 換介面語言（存進這台裝置的設定） */
  setLang(l: Lang): void;
  /** 線上對戰：開房、加入、房主設定、開始、回到房間、離開 */
  online(): void;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  roomCfg(key: 'track' | 'mode' | 'ai' | 'diff' | 'pub', val: string): void;
  roomStart(): void;
  roomScreen(): void;
  leaveRoom(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 一場比賽的結算內容（由 main 計算後交給結算畫面顯示） */
export interface Summary {
  rank: number;
  payout: number;
  killCash: number;
  streakCash: number;
  missionCash: number;
  total: number;
  bestLap: number;
  missions: { text: string; reward: number; done: boolean }[];
}

const pips = (lvl: number, max: number) =>
  `<span class="pips">${Array.from({ length: max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span>`;

/** 0~1 的能力條 */
const stat = (label: string, v: number) =>
  `<div class="statbar"><span>${label}</span><div><i style="width:${Math.round(Math.max(0.08, Math.min(1, v)) * 100)}%"></i></div></div>`;

/** 主選單、車庫、暫停、結算畫面 */
export class Screens {
  private root = document.getElementById('screens')!;
  private profile: Profile;
  private tracks: TrackInfo[];
  private trackIndex: () => number;
  private act: ScreenActions;
  current: 'none' | 'menu' | 'garage' | 'pause' | 'results' | 'settings' | 'online' | 'room' = 'none';
  private garageBack: 'menu' | 'results' | 'room' = 'menu';
  private lastResults = '';
  /** 重畫目前畫面用（換語言時）：結算、線上對戰畫面的參數 */
  private resultsArgs: [Race, Summary, boolean] | null = null;
  private onlineArgs: [string, string, string] = ['', '', ''];
  private loading = false;

  constructor(profile: Profile, tracks: TrackInfo[], trackIndex: () => number, act: ScreenActions) {
    this.profile = profile;
    this.tracks = tracks;
    this.trackIndex = trackIndex;
    this.act = act;
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const key = el.dataset.set as keyof Settings | undefined;
      if (!key || !this.settings) return;
      const st = this.settings as unknown as Record<string, unknown>;
      st[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
      this.act.settingChanged(key);
    });
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el && !(el as HTMLButtonElement).disabled) this.handle(el.dataset.act!, el.dataset.id);
    });
    // 知道實際鍵盤配置的字之後（例如 AZERTY），重畫設定頁的按鍵名稱
    loadKeyboardLayout(() => this.renderKeys());
  }

  /** 這台裝置的設定（由 main 指定） */
  settings!: Settings;
  /** 登入中的帳號名稱（空字串 = 訪客） */
  accountLabel = '';
  private settingsBack: 'menu' | 'pause' = 'menu';
  private pauseArgs: [boolean, () => string, boolean] = [false, () => '', false];

  /** 載入進度（0~1）：直接更新載入條，不重畫整個選單 */
  private loadF = 0;
  loadProgress(f: number): void {
    this.loadF = f;
    const bar = this.root.querySelector<HTMLElement>('.loadbar i');
    if (bar) bar.style.width = Math.round(f * 100) + '%';
    const pct = this.root.querySelector<HTMLElement>('.loadbar span');
    if (pct) pct.textContent = t.loadingPct(Math.round(f * 100));
  }

  hide(): void {
    this.current = 'none';
    this.root.innerHTML = '';
  }

  /** 換語言後重畫目前的畫面（線上房間由 main 重畫：要用到連線） */
  rerender(): void {
    switch (this.current) {
      case 'menu': this.menu(this.loading); break;
      case 'settings': this.settingsPage(); break;
      case 'garage': this.garage(); break;
      case 'pause': this.pause(...this.pauseArgs); break;
      case 'results': if (this.resultsArgs) this.results(...this.resultsArgs); break;
      case 'online': {
        const [name, msg, code] = this.onlineArgs;
        this.onlineMenu(this.val('#net-name') || name, msg, this.val('#net-code') || code);
        break;
      }
    }
  }

  /** 主選單右上角的語言切換（中／EN） */
  private langToggle(): string {
    const b = (l: Lang, label: string) => `<button class="${lang() === l ? 'on' : ''}" data-act="lang" data-id="${l}" lang="${l === 'zh' ? 'zh-Hant' : 'en'}">${label}</button>`;
    return `<div class="lang-toggle" role="group" aria-label="${t.langAria}">${b('zh', '中')}${b('en', 'EN')}</div>`;
  }

  private handle(act: string, id?: string): void {
    const p = this.profile;
    // 正在等新按鍵時點了別的東西：取消改鍵
    if (this.capturing && act !== 'keybind') {
      this.stopCapture();
      this.renderKeys();
    }
    switch (act) {
      case 'start': this.act.start(id as RaceMode | undefined); break;
      case 'track': this.act.selectTrack(Number(id)); break;
      case 'help': this.root.querySelector('.helpbox')?.classList.toggle('hidden'); break;
      case 'diff':
        p.difficulty = id as DifficultyId;
        saveProfile(p);
        this.menu(this.loading);
        break;
      case 'resume': this.act.resume(); break;
      case 'settings':
        this.settingsBack = this.current === 'pause' ? 'pause' : 'menu';
        this.act.settingsOpen(true);
        this.settingsPage();
        break;
      case 'music':
        this.settingsBack = 'menu';
        this.act.settingsOpen(true);
        this.settingsPage();
        this.root.querySelector('[data-act="style"]')?.scrollIntoView({ block: 'center' });
        break;
      case 'sback':
        this.act.settingsOpen(false);
        if (this.settingsBack === 'pause') this.pause(...this.pauseArgs);
        else this.menu(this.loading);
        break;
      case 'style':
        this.settings.musicStyle = id as Settings['musicStyle'];
        this.act.settingChanged('musicStyle');
        this.settingsPage();
        break;
      case 'engsnd':
      case 'wpnsnd': {
        // 選了就試聽；只換按鈕的亮起狀態，不重畫整頁（避免捲動位置跳回頂端）
        const eng = act === 'engsnd';
        if (eng) this.settings.engineSound = id as Settings['engineSound'];
        else this.settings.weaponSound = id as Settings['weaponSound'];
        this.act.settingChanged(eng ? 'engineSound' : 'weaponSound');
        this.act.previewSound(eng ? 'engine' : 'weapon');
        this.root.querySelectorAll<HTMLElement>(`[data-act="${act}"]`).forEach((b) => b.classList.toggle('on', b.dataset.id === id));
        const info = (eng ? ENGINE_STYLES : WEAPON_PACKS).find((x) => x.id === id);
        const note = this.root.querySelector<HTMLElement>(eng ? '[data-engdesc]' : '[data-wpndesc]');
        if (note && info) note.textContent = info.desc + t.tapPreview;
        break;
      }
      case 'tdrift':
        this.settings.touchDrift = id as Settings['touchDrift'];
        this.act.settingChanged('touchDrift');
        this.settingsPage();
        break;
      case 'ctrl':
        this.settings.control = id as Settings['control'];
        this.act.settingChanged('control');
        this.settingsPage();
        break;
      case 'quality':
        this.settings.quality = id as Settings['quality'];
        this.act.settingChanged('quality');
        break;
      case 'layout': this.act.editLayout(); break;
      case 'layoutreset': this.act.resetLayout(); break;
      case 'keybind': {
        const [a, s] = (id ?? '').split(':');
        if (!KEY_ACTIONS.some((x) => x.id === a)) break;
        const slot = s === '1' ? 1 : 0;
        // 再點一次同一格 = 取消
        if (this.capturing?.id === a && this.capturing.slot === slot) {
          this.stopCapture();
          this.renderKeys();
        } else this.startCapture(a as KeyAction, slot);
        break;
      }
      case 'keyreset':
        this.stopCapture();
        this.settings.keys = defaultKeys();
        this.act.settingChanged('keys');
        this.renderKeys(t.keysReset);
        break;
      case 'calib': this.act.calibrateTilt(); break;
      case 'restart': this.act.restart(); break;
      case 'menu': this.act.toMenu(); break;
      case 'garage': this.garageBack = this.current === 'results' ? 'results' : this.current === 'room' ? 'room' : 'menu'; this.garage(); break;
      case 'back':
        if (this.garageBack === 'results' && this.resultsArgs) this.results(...this.resultsArgs);
        else if (this.garageBack === 'room') this.act.roomScreen();
        else this.menu(this.loading);
        break;
      case 'online': this.act.online(); break;
      case 'account': this.act.account(); break;
      case 'lang': if (id === 'zh' || id === 'en') this.act.setLang(id); break;
      case 'backmenu': this.menu(this.loading); break;
      case 'mkroom': this.act.createRoom(this.val('#net-name')); break;
      case 'joinroom': this.act.joinRoom(this.val('#net-code'), this.val('#net-name')); break;
      case 'leaveroom': this.act.leaveRoom(); break;
      case 'toroom': this.act.roomScreen(); break;
      case 'rtrack': this.act.roomCfg('track', id ?? '0'); break;
      case 'rmode': this.act.roomCfg('mode', id ?? 'race'); break;
      case 'rai': this.act.roomCfg('ai', id ?? '1'); break;
      case 'rdiff': this.act.roomCfg('diff', id ?? 'normal'); break;
      case 'rpub': this.act.roomCfg('pub', id ?? '1'); break;
      case 'joinpub': if (id) this.act.joinRoom(id, this.val('#net-name')); break;
      case 'rstart': this.act.roomStart(); break;
      case 'copylink': {
        const link = location.origin + location.pathname + '?room=' + (id ?? '');
        void navigator.clipboard?.writeText(link).then(() => {
          const b = this.root.querySelector('[data-act="copylink"]');
          if (b) b.textContent = t.copied;
        }).catch(() => window.prompt(t.inviteLink, link));
        break;
      }
      case 'mute': {
        const m = this.act.toggleMute();
        const b = this.root.querySelector('[data-act="mute"]');
        if (b) b.textContent = m ? t.soundOff : t.soundOn;
        break;
      }
      case 'buy': {
        const w = id as WeaponId;
        const price = (isPrimary(w) ? PRIMARY[w] : SECONDARY[w as SecondaryId]).price;
        if (!p.owned[w] && p.cash >= price) {
          p.cash -= price;
          p.owned[w] = true;
          if (isPrimary(w)) p.primary = w; else p.secondary = w as SecondaryId;
        }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'equip': {
        const w = id as WeaponId;
        if (p.owned[w]) { if (isPrimary(w)) p.primary = w; else p.secondary = w as SecondaryId; }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'upw': {
        const w = id as WeaponId;
        const cost = weaponUpgradeCost(w, p.lvl[w]);
        if (p.owned[w] && p.lvl[w] < MAX_WEAPON_LVL && p.cash >= cost) { p.cash -= cost; p.lvl[w]++; }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'upc': {
        const c = id as CarUpgradeId;
        const cost = carUpgradeCost(p.car[c]);
        if (p.car[c] < MAX_CAR_LVL && p.cash >= cost) { p.cash -= cost; p.car[c]++; }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'buycar': {
        const c = id as CarId;
        if (!p.karts[c] && p.cash >= CARS[c].price) {
          p.cash -= CARS[c].price;
          p.karts[c] = true;
          p.kart = c;
        }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'livery': {
        const [c, i] = (id ?? '').split(':');
        if (p.karts[c as CarId]) {
          p.livery = { ...p.livery, [c]: Number(i) };
          p.kart = c as CarId;
        }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'usecar': {
        const c = id as CarId;
        if (p.karts[c]) p.kart = c;
        saveProfile(p);
        this.garage();
        break;
      }
    }
  }

  menu(loading = false): void {
    this.current = 'menu';
    this.loading = loading;
    const p = this.profile;
    const dis = loading ? 'disabled' : '';
    const ti = this.trackIndex();
    const cur = this.tracks[ti];
    const cards = this.tracks.map((tr, i) => `
      <button class="tcard ${i === ti ? 'on' : ''}" data-act="track" data-id="${i}" ${dis}>
        ${i === ti ? `<em class="tag">${t.picked}</em>` : ''}
        <svg viewBox="0 0 100 64"><path d="${tr.outline}" /></svg>
        <b>${tr.name}</b>
        <span>${t.themes[tr.theme] ?? ''}${t.sep}${t.km((tr.length / 1000).toFixed(1))}</span>
      </button>`).join('');
    // 標題與內容之間的分隔（賽道介紹、按鍵說明）：中文用全形空白，英文用破折號
    const hs = isEn() ? ' — ' : '　';
    const loadout = `${CARS[p.kart].name}${t.sep}${PRIMARY[p.primary].name} / ${SECONDARY[p.secondary].name}`;
    this.root.innerHTML = `
      <div class="screen menu2">
        ${this.langToggle()}
        <div class="m-grid">
          <div class="m-left">
            ${EMBLEM}
            <button class="m-loadout" data-act="garage"><span>${t.loadoutBtn}</span><b>${loadout}</b><i>›</i></button>
            <div class="m-stats"><span class="cash">$${p.cash}</span><span>${t.races(p.races)}</span><span>${t.wins(p.wins)}</span></div>
            ${loading
              ? `<div class="loadbar"><div class="lb-track"><i style="width:${Math.round(this.loadF * 100)}%"></i><span>${t.loadingPct(Math.round(this.loadF * 100))}</span></div><div class="n2o-badge">N2O</div></div>`
              : `<div class="m-modes">
                  <button class="m-mode primary" data-act="start" data-id="race"><b>${t.modeRace}</b><span>${t.raceSub(cur.laps)}</span></button>
                  <button class="m-mode" data-act="start" data-id="elim"><b>${t.modeElim}</b><span>${t.elimSub}</span></button>
                  <button class="m-mode net" data-act="online"><b>${t.online}</b><span>${t.onlineSub}</span></button>
                </div>`}
            <div class="m-diff"><span>${t.aiLevel}</span>${DIFFICULTY_IDS.map((d) => `<button class="seg ${p.difficulty === d ? 'on' : ''}" data-act="diff" data-id="${d}">${DIFFICULTY[d].name}</button>`).join('')}</div>
            <div class="m-links"><button data-act="account" class="${this.accountLabel ? 'acct-on' : ''}">${this.accountLabel ? '👤 ' + esc(this.accountLabel) : t.signIn}</button><button data-act="settings">${t.settings}</button><button data-act="music">${t.musicLink}</button><button data-act="help">${t.helpLink}</button></div>
          </div>
          <div class="m-right">
            <h3>${t.chooseTrack}</h3>
            <div class="m-tracks">${cards}</div>
            <div class="m-detail"><b>${cur.name}</b>${hs}${cur.desc}<br /><small>${t.trackDetail(cur.laps, formatTime(p.bestLaps[p.track] ?? 0), DIFFICULTY[p.difficulty].desc)}</small></div>
          </div>
        </div>
        <div class="helpbox hidden" data-act="help">
          <div>
            <b>${t.helpKb}</b>${hs}${this.keyHelp()}<br />
            <b>${t.helpMobile}</b>${hs}${t.helpMobileText}<br />
            <b>${t.helpGauge}</b>${hs}${t.helpGaugeText}<br />
            <b>${t.helpDrift}</b>${hs}${t.helpDriftText(this.kbd('up'))}<br />
            <b>${t.helpHard}</b>${hs}${t.helpHardText}<br />
            <b>${t.helpAdv}</b>${hs}${t.helpAdvText(this.kbd('up'), this.kbd('down'))}<br />
            <b>${t.helpTips}</b>${hs}${t.helpTipsText}
            <div class="hint">${t.helpClose}</div>
          </div>
        </div>
      </div>`;
  }

  private val(sel: string): string {
    return this.root.querySelector<HTMLInputElement>(sel)?.value.trim() ?? '';
  }

  /** 線上對戰：輸入名字，建立房間或輸入代碼加入 */
  onlineMenu(name: string, msg = '', code = ''): void {
    this.current = 'online';
    this.onlineArgs = [name, msg, code];
    this.root.innerHTML = `
      <div class="screen online">
        <div class="net-panel">
          <h2>${t.onlineTitle}</h2>
          <p class="sub">${t.onlineSubText}</p>
          <label class="field"><span>${t.yourName}</span><input id="net-name" maxlength="8" value="${esc(name)}" /></label>
          <button class="btn primary wide" data-act="mkroom">${t.createRoom}</button>
          <div class="or">${t.orCode}</div>
          <div class="joinrow"><input id="net-code" maxlength="6" placeholder="${t.codePh}" value="${esc(code)}" autocapitalize="characters" autocomplete="off" /><button class="btn" data-act="joinroom">${t.join}</button></div>
          ${msg ? `<div class="net-msg">${esc(msg)}</div>` : ''}
          <div class="pub-head"><b>${t.pubRooms}</b><span>${t.pubTap}</span></div>
          <div class="pub-list" data-publist><div class="pub-empty">${t.loading}</div></div>
          <button class="btn small" data-act="backmenu">${t.back}</button>
        </div>
      </div>`;
    const codeEl = this.root.querySelector<HTMLInputElement>('#net-code');
    codeEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.handle('joinroom'); });
  }

  /** 跟某位玩家的連線：直連或伺服器中轉、延遲 */
  private linkText(s: OnlineSession, pid: number): string {
    const l = s.link(pid);
    if (l.away) return `<i class="away">${t.linkAway}</i>`;
    const ms = l.rtt ? ` ${Math.round(l.rtt)} ms` : '';
    const name = t.linkNames[l.path];
    return `<i class="${l.path === 'direct' ? 'direct' : l.path === 'server' ? 'relay' : 'turn'}">${name}</i>${ms}`;
  }

  private routeText(s: OnlineSession): string {
    const n = s.list.filter((p) => p.pid !== s.me && !s.away.has(p.pid));
    const d = n.filter((p) => s.link(p.pid).path !== 'server').length;
    const via = s.colo ? t.serverVia(esc(s.colo)) : t.server;
    return n.length ? t.routeDirect(via, d, n.length) : t.routeWait(via);
  }

  /** 只更新連線狀況的小字（每 2 秒量一次延遲，不重畫整頁） */
  roomLinks(s: OnlineSession): void {
    if (this.current !== 'room') return;
    this.root.querySelectorAll<HTMLElement>('[data-link]').forEach((el) => {
      el.innerHTML = this.linkText(s, Number(el.dataset.link));
    });
    const r = this.root.querySelector<HTMLElement>('[data-route]');
    if (r) r.innerHTML = this.routeText(s);
  }

  /** 更新公開房間列表（null = 讀不到） */
  roomList(list: PublicRoom[] | null): void {
    const box = this.root.querySelector<HTMLElement>('[data-publist]');
    if (!box) return;
    if (!list) { box.innerHTML = `<div class="pub-empty">${t.roomsFail}</div>`; return; }
    if (!list.length) { box.innerHTML = `<div class="pub-empty">${t.roomsNone}</div>`; return; }
    box.innerHTML = list.map((r) => {
      const tn = this.tracks[r.track]?.name ?? '';
      const full = r.players >= 8;
      const dis = full || r.started ? 'disabled' : '';
      return `<button class="pub-row" data-act="joinpub" data-id="${esc(r.code)}" ${dis}>
        <b>${esc(r.code)}</b><span class="pr-host">${esc(r.host || t.host)}</span>
        <span>${esc(tn)}${t.sep}${r.mode === 'elim' ? t.modeElim : t.modeRace}</span>
        <span class="pr-n">${r.players}/8</span>
        <em class="${r.started ? 'busy' : full ? 'busy' : 'open'}">${r.started ? t.roomRacing : full ? t.roomFull : t.roomWaiting}</em>
      </button>`;
    }).join('');
  }

  /** 房間：車手名單與房主的比賽設定 */
  room(s: OnlineSession): void {
    this.current = 'room';
    const host = s.isHost;
    const list = s.list;
    const dis = host ? '' : 'disabled';
    const c = s.cfg;
    const players = list.map((p) => {
      const car = CARS[p.car] ?? CARS['kart-oobi'];
      const icon = carIcon(car.model, car.liveries[p.livery] ?? car.liveries[0]);
      return `<div class="pl ${p.pid === s.me ? 'me' : ''}">
        ${icon ? `<img src="${icon}" alt="" />` : '<i></i>'}
        <div><b>${esc(p.name || t.racer)}${p.pid === s.hostPid ? `<em>${t.host}</em>` : ''}${p.pid === s.me ? `<em class="you">${t.you}</em>` : ''}</b>
        <span>${car.name}${t.sep}${PRIMARY[p.primary]?.name ?? ''} / ${SECONDARY[p.secondary]?.name ?? ''}</span></div>
        ${p.pid === s.me ? '' : `<small class="lk" data-link="${p.pid}">${this.linkText(s, p.pid)}</small>`}
      </div>`;
    }).join('');
    const tracks = this.tracks.map((tr, i) => `
      <button class="tcard mini ${i === c.track ? 'on' : ''}" data-act="rtrack" data-id="${i}" ${dis}>
        <svg viewBox="0 0 100 64"><path d="${tr.outline}" /></svg><b>${tr.name}</b>
      </button>`).join('');
    const seg = (act: string, cur: string, opts: [string, string][]) =>
      opts.map(([v, label]) => `<button class="seg ${cur === v ? 'on' : ''}" data-act="${act}" data-id="${v}" ${dis}>${label}</button>`).join('');
    const connecting = s.status === 'connecting';
    this.root.innerHTML = `
      <div class="screen online">
        <div class="net-panel room">
          <div class="room-head">
            <div class="code-box"><span>${t.roomCode}</span><b>${s.code}</b></div>
            <button class="btn small" data-act="copylink" data-id="${s.code}">${t.copyInvite}</button>
          </div>
          ${connecting ? `<div class="net-msg">${t.connecting}</div>` : s.reconnecting ? `<div class="net-msg">${t.reconnecting}</div>` : ''}
          <div class="net-route" data-route>${this.routeText(s)}</div>
          <div class="room-grid">
            <div class="players"><h3>${t.racersN(list.length)}</h3>${players}</div>
            <div class="cfg">
              <h3>${t.raceSettings}${host ? '' : `<small>${t.hostDecides}</small>`}</h3>
              <div class="room-tracks">${tracks}</div>
              <div class="m-diff"><span>${t.cfgMode}</span>${seg('rmode', c.mode, [['race', t.modeRace], ['elim', t.modeElim]])}</div>
              <div class="m-diff"><span>${t.cfgSlots}</span>${seg('rai', c.aiFill ? '1' : '0', [['1', t.fillAi], ['0', t.playersOnly]])}</div>
              <div class="m-diff"><span>${t.cfgAi}</span>${seg('rdiff', c.difficulty, DIFFICULTY_IDS.map((d) => [d, DIFFICULTY[d].name] as [string, string]))}</div>
              <div class="m-diff"><span>${t.cfgRoom}</span>${seg('rpub', c.public === false ? '0' : '1', [['1', t.roomPublic], ['0', t.roomInvite]])}</div>
            </div>
          </div>
          <div class="row">
            ${host
              ? `<button class="btn primary" data-act="rstart" ${list.length < 2 && !c.aiFill ? 'disabled' : ''}>${t.startRace}</button>`
              : `<div class="wait">${t.waitHost}</div>`}
            <button class="btn" data-act="garage">${t.garage}</button>
            <button class="btn" data-act="leaveroom">${t.leaveRoom}</button>
          </div>
        </div>
      </div>`;
  }

  private weaponCard(id: WeaponId): string {
    const p = this.profile;
    const prim = isPrimary(id);
    const def = prim ? PRIMARY[id] : SECONDARY[id as SecondaryId];
    const owned = p.owned[id];
    const lvl = p.lvl[id];
    const equipped = owned && (prim ? p.primary === id : p.secondary === id);
    const mul = weaponLvlMul(lvl);
    let info: string;
    if (prim) {
      const P = PRIMARY[id];
      const dps = (P.dmg * P.pellets * P.rate * mul).toFixed(0);
      const lv1 = Math.max(1, lvl);
      const hit = (P.dmg * mul).toFixed(1).replace(/\.0$/, '');
      switch (P.kind) {
        case 'flame': info = t.infoFlame(dps, BURN_DPS, P.range); break;
        case 'laser': info = t.infoLaser(Math.round(laserKeep(lv1) * 100), laserCooldown(lv1).toFixed(1), P.range); break;
        case 'arc': info = t.infoArc(hit, ARC_KEEP, 1 + arcHops(lv1), arcJump(lv1), P.rate, P.range); break;
        case 'freeze': info = t.infoFreeze(dps, (1 / (chillRate(lv1) * P.rate)).toFixed(1), P.range); break;
        case 'sonic': info = t.infoSonic(hit, sonicPush(lv1).toFixed(1), P.range); break;
        case 'harpoon': info = t.infoHarpoon(hit, tetherTime(lv1).toFixed(2).replace(/0$/, ''), pullBonus(lv1), P.range); break;
        default: info = t.infoGun(dps, P.range);
      }
    } else {
      const S = SECONDARY[id as SecondaryId];
      const lv1 = Math.max(1, lvl);
      info = id === 'shield'
        ? t.infoShield(Math.round((shieldHalfArc(lv1) * 2 * 180) / Math.PI), shieldTime(lv1), S.cooldown)
        : t.infoSec(`${(S.dmg * mul).toFixed(0)}${S.count > 1 ? ' × ' + S.count : ''}`, S.cooldown);
    }
    const lv = owned ? lvl : 0;
    const perks = `<div class="perks">
      <div class="${lv >= PERK_LVL3 ? 'on' : ''}"><b>Lv.${PERK_LVL3}</b> ${prim && id !== 'laser' ? t.perkHeat : t.perkCd}</div>
      <div class="${lv >= PERK_LVL5 ? 'on' : ''}"><b>Lv.${PERK_LVL5}</b> ${def.perk}</div>
    </div>`;
    const icon = weaponIcon(id);
    let btns: string;
    if (!owned) {
      btns = `<button class="btn small primary" data-act="buy" data-id="${id}" ${p.cash < def.price ? 'disabled' : ''}>${t.buy(def.price)}</button>`;
    } else {
      const cost = weaponUpgradeCost(id, lvl);
      btns = `<button class="btn small" data-act="equip" data-id="${id}" ${equipped ? 'disabled' : ''}>${equipped ? t.equipped : t.equip}</button>`;
      btns += lvl < MAX_WEAPON_LVL
        ? `<button class="btn small primary" data-act="upw" data-id="${id}" ${p.cash < cost ? 'disabled' : ''}>${t.upgrade(cost)}</button>`
        : `<button class="btn small" disabled>${t.maxed}</button>`;
    }
    return `<div class="card ${equipped ? 'equipped' : ''}">
      ${icon ? `<div class="wimg"><img src="${icon}" alt="" /></div>` : ''}
      <h4>${def.name}<small>${owned ? 'Lv.' + lvl : t.notOwned}</small></h4>
      <p>${def.desc}</p>
      <div class="stat">${info}${t.infoSep}${pips(owned ? lvl : 0, MAX_WEAPON_LVL)}</div>
      ${perks}
      <div class="row">${btns}</div>
    </div>`;
  }

  private carCard(id: CarId): string {
    const p = this.profile;
    const c = CARS[id];
    const owned = !!p.karts[id];
    const using = p.kart === id;
    const btn = !owned
      ? `<button class="btn small primary" data-act="buycar" data-id="${id}" ${p.cash < c.price ? 'disabled' : ''}>${t.buy(c.price)}</button>`
      : `<button class="btn small" data-act="usecar" data-id="${id}" ${using ? 'disabled' : ''}>${using ? t.inUse : t.select}</button>`;
    const lv = p.livery?.[id] ?? 0;
    const icon = carIcon(c.model, c.liveries[lv]);
    const swatches = c.liveries.map((l, i) => `<button class="swatch ${i === lv ? 'on' : ''}" data-act="livery" data-id="${id}:${i}" ${owned ? '' : 'disabled'} title="${l.name}" style="--sw:${liverySwatch(l, c.color)}"><span></span>${l.name}</button>`).join('');
    return `<div class="card ${using ? 'equipped' : ''}">
      ${icon ? `<div class="wimg car"><img src="${icon}" alt="" /></div>` : ''}
      <h4>${c.name}<small>${owned ? t.owned : t.notOwned}</small></h4>
      <p>${c.desc}</p>
      <p class="trait">★ ${c.trait}</p>
      <div class="swatches">${swatches}</div>
      ${stat(t.statSpeed, (c.speed - 0.94) / 0.12)}
      ${stat(t.statAccel, (c.accel - 0.88) / 0.2)}
      ${stat(t.statHandling, (c.handling - 0.9) / 0.26)}
      ${stat(t.statArmor, (100 + c.hp - 80) / 80)}
      ${stat(t.statGauge, (c.gauge - 0.9) / 0.45 + c.boostTime * 0.5)}
      <div class="row" style="margin-top:.7em">${btn}</div>
    </div>`;
  }

  private upgradeCard(id: CarUpgradeId): string {
    const p = this.profile;
    const lvl = p.car[id];
    const cost = carUpgradeCost(lvl);
    const btn = lvl < MAX_CAR_LVL
      ? `<button class="btn small primary" data-act="upc" data-id="${id}" ${p.cash < cost ? 'disabled' : ''}>${t.upgrade(cost)}</button>`
      : `<button class="btn small" disabled>${t.maxed}</button>`;
    return `<div class="card">
      <h4>${CAR_UPGRADES[id].name}<small>Lv.${lvl}</small></h4>
      <p>${CAR_UPGRADES[id].desc}</p>
      <div class="stat">${pips(lvl, MAX_CAR_LVL)}</div>
      <div class="row">${btn}</div>
    </div>`;
  }

  garage(): void {
    this.current = 'garage';
    const p = this.profile;
    const scroll = this.root.querySelector('.screen')?.scrollTop ?? 0;
    this.root.innerHTML = `
      <div class="screen solid">
        <div class="garage-head">
          <h2>${t.garage}</h2>
          <span class="cash">$${p.cash}</span>
          <div class="row">
            <button class="btn small" data-act="back">${t.back}</button>
            <button class="btn small primary" data-act="start" ${this.loading ? 'disabled' : ''}>${t.goRace}</button>
          </div>
        </div>
        <div class="section"><h3>${t.secKarts}</h3><div class="cards">${CAR_IDS.map((c) => this.carCard(c)).join('')}</div></div>
        <div class="section"><h3>${t.secPrimary}</h3><div class="cards">${PRIMARY_IDS.map((w) => this.weaponCard(w)).join('')}</div></div>
        <div class="section"><h3>${t.secSecondary}</h3><div class="cards">${SECONDARY_IDS.map((w) => this.weaponCard(w)).join('')}</div></div>
        <div class="section"><h3>${t.secUpgrades}</h3><div class="cards">${(['engine', 'n2o', 'armor'] as CarUpgradeId[]).map((u) => this.upgradeCard(u)).join('')}</div></div>
      </div>`;
    const s = this.root.querySelector('.screen');
    if (s) s.scrollTop = scroll;
  }

  // ---------------- 鍵盤按鍵（設定頁與按鍵說明） ----------------

  /** 正在等哪一格的新按鍵 */
  private capturing: { id: KeyAction; slot: 0 | 1 } | null = null;

  private get keys(): KeyMap {
    return this.settings?.keys ?? defaultKeys();
  }

  /** 某個動作的主要鍵 */
  private kbd(a: KeyAction): string {
    return `<kbd>${esc(keyName(this.keys[a][0]))}</kbd>`;
  }

  /** 某個動作的所有鍵（主要／第二個） */
  private kbdAll(a: KeyAction): string {
    return this.keys[a].filter(Boolean).map((c) => `<kbd>${esc(keyName(c))}</kbd>`).join(t.keySep);
  }

  /** 按鍵說明的「鍵盤」那一行：跟著目前的鍵位 */
  private keyHelp(): string {
    const drive = (['up', 'down', 'left', 'right'] as KeyAction[]).map((a) => keyName(this.keys[a][0]));
    const d = drive.every((n) => n.length === 1) ? `<kbd>${esc(drive.join(''))}</kbd>` : drive.map((n) => `<kbd>${esc(n)}</kbd>`).join('');
    const k = (a: KeyAction) => this.kbdAll(a);
    return t.keyHelp({ drive: d, drift: k('drift'), boost: k('boost'), fire1: k('fire1'), fire2: k('fire2'), look: k('look'), reset: k('reset'), pause: k('pause') });
  }

  /** 設定頁的按鍵列表（每個動作兩格） */
  private keyRows(): string {
    const cap = this.capturing;
    return KEY_ACTIONS.map(({ id, name }) => {
      const slots = this.keys[id].map((c, i) => {
        const on = cap?.id === id && cap.slot === i;
        const label = on ? t.keyPress : c ? esc(keyName(c)) : isEn() ? '+' : '＋';
        const title = on ? t.keyEscCancel : c ? t.keyChange : t.keyAdd;
        const aria = t.keyAria(name, i > 0, on ? t.keyWaiting : c ? keyName(c) : t.keyUnset);
        return `<button class="keycap ${on ? 'wait' : ''} ${c || on ? '' : 'empty'}" data-act="keybind" data-id="${id}:${i}" title="${title}" aria-label="${esc(aria)}">${label}</button>`;
      }).join('');
      const note = id === 'pause' ? `<em>${t.keyEscToo}</em>` : '';
      return `<b>${name}</b><div class="keyslots">${slots}${note}</div>`;
    }).join('');
  }

  /** 只重畫按鍵列表（不重畫整頁，捲動位置不會跳） */
  private renderKeys(msg?: string, warn = false): void {
    if (this.current !== 'settings') return;
    const box = this.root.querySelector<HTMLElement>('[data-keys]');
    if (box) box.innerHTML = this.keyRows();
    const m = this.root.querySelector<HTMLElement>('[data-keymsg]');
    if (m) {
      m.textContent = msg ?? (this.capturing ? t.keyCapture : t.keyHint);
      m.classList.toggle('warn', warn);
    }
  }

  private startCapture(id: KeyAction, slot: 0 | 1): void {
    this.stopCapture();
    this.capturing = { id, slot };
    // 用捕獲階段先攔下按鍵：不讓遊戲把它當成暫停、重置
    window.addEventListener('keydown', this.onCaptureKey, true);
    this.renderKeys();
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = null;
    window.removeEventListener('keydown', this.onCaptureKey, true);
    // 按鈕失去焦點，之後按空白鍵才不會又按到它
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  private onCaptureKey = (e: KeyboardEvent): void => {
    const cap = this.capturing;
    if (!cap || this.current !== 'settings') {
      this.stopCapture();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const name = KEY_ACTIONS.find((a) => a.id === cap.id)?.name ?? '';
    if (e.code === 'Escape') {
      this.stopCapture();
      this.renderKeys();
      return;
    }
    if (e.code === 'Backspace') {
      const ok = clearKey(this.settings.keys, cap.id, cap.slot);
      this.stopCapture();
      if (ok) this.act.settingChanged('keys');
      this.renderKeys(ok ? t.keyCleared(name) : t.keyNeedOne(name), !ok);
      return;
    }
    if (!e.code) return;
    const before = this.settings.keys[cap.id][cap.slot];
    const r = bindKey(this.settings.keys, cap.id, cap.slot, e.code);
    this.stopCapture();
    if (!r.ok) {
      this.renderKeys(r.why, true);
      return;
    }
    this.act.settingChanged('keys');
    let msg = t.keyNow(name, keyName(e.code));
    if (r.swapped) {
      const other = KEY_ACTIONS.find((a) => a.id === r.swapped)?.name ?? '';
      msg += before ? t.keySwapped(other, keyName(before)) : t.keyMoved(other);
    }
    this.renderKeys(msg);
  };

  /** 設定頁：畫質、音量、配樂、操控與按鈕位置 */
  settingsPage(): void {
    this.stopCapture();
    const keep = this.current === 'settings' ? this.root.querySelector('.screen')?.scrollTop ?? 0 : 0;
    this.current = 'settings';
    const s = this.settings;
    const pick = (act: string, cur: string, opts: [string, string][]) =>
      `<div class="choices">${opts.map(([v, n]) => `<button class="diffbtn ${cur === v ? 'on' : ''}" data-act="${act}" data-id="${v}">${n}</button>`).join('')}</div>`;
    const range = (key: string, v: number, min: number, max: number, step: number) => `<input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${v}" />`;
    this.root.innerHTML = `
      <div class="screen settings-screen">
        <h1 class="title">${t.settings}</h1>
        <div class="setcols">
        <div class="setcol">
        <div class="setgrid setsec">
          <h3>${t.setDisplay}</h3>
          <b>${t.setLanguage}</b>${pick('lang', lang(), [['zh', '中文'], ['en', 'English']])}
          <b>${t.setQuality}</b>${pick('quality', s.quality, [['low', t.qLow], ['medium', t.qMed], ['high', t.qHigh]])}
          <small>${t.setReload}</small>
          <b>${t.setShake}</b>${range('shake', s.shake, 0, 1, 0.05)}
          <b>${t.setDmg}</b><label><input type="checkbox" data-set="dmgNumbers" ${s.dmgNumbers ? 'checked' : ''} /> ${t.setDmgText}</label>
          <b>${t.setInfo}</b><label><input type="checkbox" data-set="netInfo" ${s.netInfo ? 'checked' : ''} /> ${t.setInfoText}</label>
        </div>
        <div class="setgrid setsec">
          <h3>${t.setAssist}</h3>
          <b>${t.setAutoMini}</b><label><input type="checkbox" data-set="autoMini" ${s.autoMini ? 'checked' : ''} /> ${t.setAutoMiniText}</label>
          <b>${t.setDriftAssist}</b><label><input type="checkbox" data-set="driftAssist" ${s.driftAssist ? 'checked' : ''} /> ${t.setDriftAssistText}</label>
        </div>
        <div class="setgrid setsec touch-sec">
            <h3>${t.setTouch}</h3>
            <b>${t.setVibrate}</b><label><input type="checkbox" data-set="vibrate" ${s.vibrate ? 'checked' : ''} /> ${t.setVibrateText}</label>
            <b>${t.setDriftBtn}</b>${pick('tdrift', s.touchDrift, [['single', t.driftSingle], ['dual', t.driftDual]])}
            <b>${t.setSteer}</b>${pick('ctrl', s.control, [['buttons', t.steerButtons], ['tilt', t.steerTilt]])}
            ${s.control === 'tilt' ? `<b>${t.setTiltSens}</b>${range('tiltRange', 52 - s.tiltRange, 12, 40, 1)}
            <b>${t.setInvert}</b><label><input type="checkbox" data-set="tiltInvert" ${s.tiltInvert ? 'checked' : ''} /> ${t.setInvertText}</label>
            <b></b><div class="choices"><button class="diffbtn" data-act="calib">${t.setCalib}</button></div>` : ''}
            <b>${t.setLayout}</b><div class="choices"><button class="diffbtn" data-act="layout">${t.setLayoutEdit}</button><button class="diffbtn" data-act="layoutreset">${t.reset}</button></div>
        </div>
        </div>
        <div class="setcol">
        <div class="setgrid setsec">
          <h3>${t.setSound}</h3>
          <b>${t.setMusic}</b>${range('music', s.music, 0, 1, 0.05)}
          <b>${t.setSfx}</b>${range('sfx', s.sfx, 0, 1, 0.05)}
          <b>${t.setStyle}</b>${pick('style', s.musicStyle, MUSIC_STYLES.map((m) => [m.id, m.name]))}
          <small>${t.setStyleNote}</small>
          <b>${t.setEngine}</b>${pick('engsnd', s.engineSound, ENGINE_STYLES.map((m) => [m.id, m.name]))}
          <small data-engdesc>${ENGINE_STYLES.find((m) => m.id === s.engineSound)?.desc ?? ''}${t.tapPreview}</small>
          <b>${t.setWeapon}</b>${pick('wpnsnd', s.weaponSound, WEAPON_PACKS.map((m) => [m.id, m.name]))}
          <small data-wpndesc>${WEAPON_PACKS.find((m) => m.id === s.weaponSound)?.desc ?? ''}${t.tapPreview}</small>
          <b>${t.setOthers}</b><label><input type="checkbox" data-set="otherEngines" ${s.otherEngines ? 'checked' : ''} /> ${t.setOthersText}</label>
        </div>
        <div class="setgrid setsec kb-sec">
            <h3>${t.setKeys}</h3>
            <div class="keyrows" data-keys>${this.keyRows()}</div>
            <b></b><div class="choices"><button class="diffbtn" data-act="keyreset">${t.reset}</button></div>
            <small class="keymsg" data-keymsg>${t.keyHint}</small>
        </div>
        </div>
        </div>
        <div class="row setback"><button class="btn primary" data-act="sback">${t.back}</button></div>
      </div>`;
    const sc = this.root.querySelector('.screen');
    if (sc && keep) sc.scrollTop = keep;
  }

  pause(muted: boolean, missionHtml: () => string, online = false): void {
    this.pauseArgs = [muted, missionHtml, online];
    if (online) {
      this.current = 'pause';
      this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,48px)">${t.menuTitle}</h1>
        <p class="sub">${t.onlineNoPause}</p>
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">${t.backToRace}</button>
          <button class="btn" data-act="mute">${muted ? t.soundOff : t.soundOn}</button>
          <button class="btn touch-only" data-act="layout">${t.pauseLayout}</button>
          <button class="btn" data-act="leaveroom">${t.leaveRoom}</button>
        </div>
      </div>`;
      return;
    }
    this.current = 'pause';
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,64px)">${t.paused}</h1>
        <div class="missions-box">${missionHtml()}</div>
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">${t.resume}</button>
          <button class="btn" data-act="restart">${t.restart}</button>
          <button class="btn" data-act="mute">${muted ? t.soundOff : t.soundOn}</button>
          <button class="btn touch-only" data-act="layout">${t.pauseLayout}</button>
          <button class="btn" data-act="settings">${t.settings}</button>
          <button class="btn" data-act="menu">${t.mainMenu}</button>
        </div>
      </div>`;
  }

  results(race: Race, s: Summary, online = false): void {
    this.current = 'results';
    this.resultsArgs = [race, s, online];
    const p = race.player;
    const elim = race.mode === 'elim';
    const rows = this.resultRows(race, online);
    const missions = s.missions.map((m) => `<div class="${m.done ? 'ok' : 'no'}">${m.done ? '✔' : '✘'} ${m.text} <em>${m.done ? '+$' + m.reward : '$' + m.reward}</em></div>`).join('');
    this.lastResults = `
      <div class="screen">
        <div class="results">
          <h2>${elim && s.rank === 1 ? t.winner : t.place(s.rank)}</h2>
          <div class="res-body">
          <div class="res-left"><table class="res-table">${rows}</table><div class="res-live">${this.liveNote(race, online)}</div></div>
          <div class="res-side">
          <div class="missions-box"><b>${t.missions}</b>${missions}</div>
          <div class="earn">
            ${t.earnPlace(s.payout)}${t.earnPlus}${t.earnKills(p.kills, KILL_REWARD)}${s.streakCash ? t.earnPlus + t.earnStreak(s.streakCash) : ''}${t.earnPlus}${t.earnMissions(s.missionCash)}<br />
            ${t.earnTotal} <b>$${s.total}</b>${s.bestLap > 0 ? t.earnBest(formatTime(s.bestLap)) : ''}
          </div>
          <div class="row">
            ${online
              ? `<button class="btn primary" data-act="toroom">${t.backToRoom}</button><button class="btn" data-act="leaveroom">${t.leaveRoom}</button>`
              : `<button class="btn primary" data-act="start">${t.raceAgain}</button><button class="btn" data-act="garage">${t.garage}</button><button class="btn" data-act="menu">${t.exit}</button>`}
          </div>
          </div>
          </div>
        </div>
      </div>`;
    this.root.innerHTML = this.lastResults;
  }

  /** 結算表的每一列。連線時還在跑的車顯示「比賽中」（不是未完賽），名次會隨著大家完賽更新 */
  private resultRows(race: Race, online: boolean): string {
    const p = race.player;
    const elim = race.mode === 'elim';
    return race.results().map((k, i) => {
      let st: string;
      if (elim) st = k.out ? t.resOut : t.resAlive;
      else if (k.finished) st = formatTime(k.finishTime);
      else if (k.out) st = online ? t.resLeft : t.resDnf;
      else st = online ? t.resRacing : t.resDnf;
      return `
      <tr class="${k === p ? 'me' : ''}">
        <td>${i + 1}</td><td>${k.name}</td>
        <td>${st}</td>
        <td>${t.resKills(k.kills)}</td>
      </tr>`;
    }).join('');
  }

  /** 連線時還有人在跑：提示名次會即時更新 */
  private liveNote(race: Race, online: boolean): string {
    if (!online) return '';
    const running = race.mode === 'elim' ? race.aliveCount > 1 : race.karts.some((k) => !k.finished && !k.out);
    return running ? t.resLive : '';
  }

  /** 連線比賽的結算畫面：別人陸續完賽、被淘汰時，只重畫名次表（按鈕、任務不動） */
  refreshResults(): void {
    if (this.current !== 'results' || !this.resultsArgs) return;
    const [race, , online] = this.resultsArgs;
    const table = this.root.querySelector<HTMLElement>('.res-table');
    const note = this.root.querySelector<HTMLElement>('.res-live');
    if (!table) return;
    const rows = this.resultRows(race, online);
    if (table.dataset.h !== rows) {
      table.innerHTML = rows;
      table.dataset.h = rows;
    }
    if (note) note.textContent = this.liveNote(race, online);
  }
}
