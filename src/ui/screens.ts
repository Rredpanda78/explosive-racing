import { CAR_IDS, CARS, type CarId } from '../game/cars';
import { KILL_REWARD } from '../game/config';
import type { Race, RaceMode } from '../game/race';
import { liverySwatch } from '../render/livery';
import { carIcon, weaponIcon } from '../render/weaponIcons';
import { DIFFICULTY, DIFFICULTY_IDS, type DifficultyId } from '../game/difficulty';
import type { Settings } from '../settings';
import { MUSIC_STYLES } from '../audio';
import { saveProfile, type Profile } from '../game/save';
import { formatTime } from '../game/util';
import type { OnlineSession } from '../net/online';
import {
  BURN_DPS, PERK_LVL3, PERK_LVL5, CAR_UPGRADES, MAX_CAR_LVL, MAX_WEAPON_LVL, PRIMARY, PRIMARY_IDS, SECONDARY, SECONDARY_IDS, carUpgradeCost, isPrimary,
  laserCooldown, laserKeep, weaponLvlMul, weaponUpgradeCost, type CarUpgradeId, type SecondaryId, type WeaponId,
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
  /** 線上對戰：開房、加入、房主設定、開始、回到房間、離開 */
  online(): void;
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  roomCfg(key: 'track' | 'mode' | 'ai' | 'diff', val: string): void;
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
  }

  /** 這台裝置的設定（由 main 指定） */
  settings!: Settings;
  private settingsBack: 'menu' | 'pause' = 'menu';
  private pauseArgs: [boolean, string] = [false, ''];

  /** 載入進度（0~1）：直接更新載入條，不重畫整個選單 */
  private loadF = 0;
  loadProgress(f: number): void {
    this.loadF = f;
    const bar = this.root.querySelector<HTMLElement>('.loadbar i');
    if (bar) bar.style.width = Math.round(f * 100) + '%';
    const pct = this.root.querySelector<HTMLElement>('.loadbar span');
    if (pct) pct.textContent = '載入中… ' + Math.round(f * 100) + '%';
  }

  hide(): void {
    this.current = 'none';
    this.root.innerHTML = '';
  }

  private handle(act: string, id?: string): void {
    const p = this.profile;
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
      case 'calib': this.act.calibrateTilt(); break;
      case 'restart': this.act.restart(); break;
      case 'menu': this.act.toMenu(); break;
      case 'garage': this.garageBack = this.current === 'results' ? 'results' : this.current === 'room' ? 'room' : 'menu'; this.garage(); break;
      case 'back':
        if (this.garageBack === 'results' && this.lastResults) { this.current = 'results'; this.root.innerHTML = this.lastResults; }
        else if (this.garageBack === 'room') this.act.roomScreen();
        else this.menu(this.loading);
        break;
      case 'online': this.act.online(); break;
      case 'backmenu': this.menu(this.loading); break;
      case 'mkroom': this.act.createRoom(this.val('#net-name')); break;
      case 'joinroom': this.act.joinRoom(this.val('#net-code'), this.val('#net-name')); break;
      case 'leaveroom': this.act.leaveRoom(); break;
      case 'toroom': this.act.roomScreen(); break;
      case 'rtrack': this.act.roomCfg('track', id ?? '0'); break;
      case 'rmode': this.act.roomCfg('mode', id ?? 'race'); break;
      case 'rai': this.act.roomCfg('ai', id ?? '1'); break;
      case 'rdiff': this.act.roomCfg('diff', id ?? 'normal'); break;
      case 'rstart': this.act.roomStart(); break;
      case 'copylink': {
        const link = location.origin + location.pathname + '?room=' + (id ?? '');
        void navigator.clipboard?.writeText(link).then(() => {
          const b = this.root.querySelector('[data-act="copylink"]');
          if (b) b.textContent = '已複製！';
        }).catch(() => window.prompt('邀請連結', link));
        break;
      }
      case 'mute': {
        const m = this.act.toggleMute();
        const b = this.root.querySelector('[data-act="mute"]');
        if (b) b.textContent = m ? '音效：關' : '音效：開';
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
    const themeName: Record<string, string> = { meadow: '草原', desert: '沙漠', city: '夜城' };
    const cards = this.tracks.map((t, i) => `
      <button class="tcard ${i === ti ? 'on' : ''}" data-act="track" data-id="${i}" ${dis}>
        ${i === ti ? '<em class="tag">已選</em>' : ''}
        <svg viewBox="0 0 100 64"><path d="${t.outline}" /></svg>
        <b>${t.name}</b>
        <span>${themeName[t.theme] ?? ''}・${(t.length / 1000).toFixed(1)} km</span>
      </button>`).join('');
    const loadout = `${CARS[p.kart].name}・${PRIMARY[p.primary].name} / ${SECONDARY[p.secondary].name}`;
    this.root.innerHTML = `
      <div class="screen menu2">
        <div class="m-grid">
          <div class="m-left">
            ${EMBLEM}
            <button class="m-loadout" data-act="garage"><span>車庫 &amp; 裝備</span><b>${loadout}</b><i>›</i></button>
            <div class="m-stats"><span class="cash">$${p.cash}</span><span>出賽 ${p.races}</span><span>冠軍 ${p.wins}</span></div>
            ${loading
              ? `<div class="loadbar"><div class="lb-track"><i style="width:${Math.round(this.loadF * 100)}%"></i><span>載入中… ${Math.round(this.loadF * 100)}%</span></div><div class="n2o-badge">N2O</div></div>`
              : `<div class="m-modes">
                  <button class="m-mode primary" data-act="start" data-id="race"><b>競速賽</b><span>跑完 ${cur.laps} 圈，名次高的贏</span></button>
                  <button class="m-mode" data-act="start" data-id="elim"><b>淘汰賽</b><span>每 17 秒淘汰最後一名</span></button>
                  <button class="m-mode net" data-act="online"><b>線上對戰</b><span>開房間跟朋友一起跑</span></button>
                </div>`}
            <div class="m-diff"><span>電腦難度</span>${DIFFICULTY_IDS.map((d) => `<button class="seg ${p.difficulty === d ? 'on' : ''}" data-act="diff" data-id="${d}">${DIFFICULTY[d].name}</button>`).join('')}</div>
            <div class="m-links"><button data-act="settings">設定</button><button data-act="music">配樂</button><button data-act="help">遊戲按鍵說明</button></div>
          </div>
          <div class="m-right">
            <h3>選擇賽道</h3>
            <div class="m-tracks">${cards}</div>
            <div class="m-detail"><b>${cur.name}</b>　${cur.desc}<br /><small>${cur.laps} 圈・最快單圈 ${formatTime(p.bestLaps[p.track] ?? 0)}・電腦：${DIFFICULTY[p.difficulty].desc}</small></div>
          </div>
        </div>
        <div class="helpbox hidden" data-act="help">
          <div>
            <b>鍵盤</b>　<kbd>↑↓←→</kbd> 駕駛　<kbd>Shift</kbd> 甩尾　<kbd>Ctrl</kbd> N2O　<kbd>Z</kbd> 主武器　<kbd>X</kbd> 副武器　<kbd>C</kbd> 後視　<kbd>R</kbd> 重置　<kbd>Esc</kbd> 暫停<br />
            <b>手機</b>　自動油門；左手方向鍵（或在設定改成傾斜手機），右手開火、N2O、甩尾，右下角煞車<br />
            <b>集氣</b>　甩尾最快；打中對手、擊毀（直接送一瓶）、跟在別人正後方吃尾流、飛越跳台、踩加速帶也都會集氣<br />
            <b>甩尾</b>　點一下甩尾鍵（0.16 秒內放開）是<b>短漂</b>：回正快、減速少、集氣快，但沒有小噴；按久一點是<b>長漂</b>，按住方向能拖很久，結束後再按一次 <kbd>↑</kbd>（手機按「小噴」）觸發小噴<br />
            <b>重甩</b>　甩尾中把方向鍵放開再快速按回同一邊（手機連點兩下同一邊的方向或甩尾鍵），甩得更兇、角度更大，適合 180 度髮夾彎；代價是掉一點速度<br />
            <b>進階</b>　短漂後 0.5 秒內接長漂集氣加成（短接長）；長漂完先不噴、直接甩下一個彎，在第二次甩尾中途按 <kbd>↑</kbd> 就能<b>連噴</b>；甩尾中點一下 <kbd>↓</kbd>（手機點煞車）是<b>斷飄</b>，立刻回正又不掉速<br />
            <b>技巧</b>　倒數到 GO 的瞬間按油門可以起跑衝刺；開著 N2O 撞人傷害加倍；紅色油桶打了會爆
            <div class="hint">點一下關閉</div>
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
    this.root.innerHTML = `
      <div class="screen online">
        <div class="net-panel">
          <h2>線上對戰</h2>
          <p class="sub">開一個房間，把代碼或邀請連結傳給朋友（最多 8 人，空位可以補電腦車手）。</p>
          <label class="field"><span>你的名字</span><input id="net-name" maxlength="8" value="${esc(name)}" /></label>
          <button class="btn primary wide" data-act="mkroom">建立房間</button>
          <div class="or">或輸入朋友的房間代碼</div>
          <div class="joinrow"><input id="net-code" maxlength="6" placeholder="例如 K7QX" value="${esc(code)}" autocapitalize="characters" autocomplete="off" /><button class="btn" data-act="joinroom">加入</button></div>
          ${msg ? `<div class="net-msg">${esc(msg)}</div>` : ''}
          <button class="btn small" data-act="backmenu">返回</button>
        </div>
      </div>`;
    const codeEl = this.root.querySelector<HTMLInputElement>('#net-code');
    codeEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.handle('joinroom'); });
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
        <div><b>${esc(p.name || '車手')}${p.pid === s.hostPid ? '<em>房主</em>' : ''}${p.pid === s.me ? '<em class="you">你</em>' : ''}</b>
        <span>${car.name}・${PRIMARY[p.primary]?.name ?? ''} / ${SECONDARY[p.secondary]?.name ?? ''}</span></div>
      </div>`;
    }).join('');
    const tracks = this.tracks.map((t, i) => `
      <button class="tcard mini ${i === c.track ? 'on' : ''}" data-act="rtrack" data-id="${i}" ${dis}>
        <svg viewBox="0 0 100 64"><path d="${t.outline}" /></svg><b>${t.name}</b>
      </button>`).join('');
    const seg = (act: string, cur: string, opts: [string, string][]) =>
      opts.map(([v, label]) => `<button class="seg ${cur === v ? 'on' : ''}" data-act="${act}" data-id="${v}" ${dis}>${label}</button>`).join('');
    const connecting = s.status === 'connecting';
    this.root.innerHTML = `
      <div class="screen online">
        <div class="net-panel room">
          <div class="room-head">
            <div class="code-box"><span>房間代碼</span><b>${s.code}</b></div>
            <button class="btn small" data-act="copylink" data-id="${s.code}">複製邀請連結</button>
          </div>
          ${connecting ? '<div class="net-msg">連線中…</div>' : ''}
          <div class="room-grid">
            <div class="players"><h3>車手 ${list.length}/8</h3>${players}</div>
            <div class="cfg">
              <h3>比賽設定${host ? '' : '<small>（房主決定）</small>'}</h3>
              <div class="room-tracks">${tracks}</div>
              <div class="m-diff"><span>模式</span>${seg('rmode', c.mode, [['race', '競速賽'], ['elim', '淘汰賽']])}</div>
              <div class="m-diff"><span>空位</span>${seg('rai', c.aiFill ? '1' : '0', [['1', '補電腦車手'], ['0', '只有玩家']])}</div>
              <div class="m-diff"><span>電腦</span>${seg('rdiff', c.difficulty, DIFFICULTY_IDS.map((d) => [d, DIFFICULTY[d].name] as [string, string]))}</div>
            </div>
          </div>
          <div class="row">
            ${host
              ? `<button class="btn primary" data-act="rstart" ${list.length < 2 && !c.aiFill ? 'disabled' : ''}>開始比賽</button>`
              : '<div class="wait">等待房主開始…</div>'}
            <button class="btn" data-act="garage">車庫</button>
            <button class="btn" data-act="leaveroom">離開房間</button>
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
      info = P.kind === 'flame'
        ? `每秒傷害 ${dps} + 燃燒 ${BURN_DPS}/秒　射程 ${P.range} m`
        : P.kind === 'laser'
          ? `第一台直接打爆　貫穿後保留 ${Math.round(laserKeep(lv1) * 100)}%　冷卻 ${laserCooldown(lv1).toFixed(1)} 秒　射程 ${P.range} m`
          : `每秒傷害 ${dps}　射程 ${P.range} m`;
    } else {
      const S = SECONDARY[id as SecondaryId];
      info = `傷害 ${(S.dmg * mul).toFixed(0)}${S.count > 1 ? ' × ' + S.count : ''}　冷卻 ${S.cooldown} 秒`;
    }
    const lv = owned ? lvl : 0;
    const perks = `<div class="perks">
      <div class="${lv >= PERK_LVL3 ? 'on' : ''}"><b>Lv.${PERK_LVL3}</b> ${prim && id !== 'laser' ? '過熱變慢 15%' : '冷卻縮短 15%'}</div>
      <div class="${lv >= PERK_LVL5 ? 'on' : ''}"><b>Lv.${PERK_LVL5}</b> ${def.perk}</div>
    </div>`;
    const icon = weaponIcon(id);
    let btns: string;
    if (!owned) {
      btns = `<button class="btn small primary" data-act="buy" data-id="${id}" ${p.cash < def.price ? 'disabled' : ''}>購買 $${def.price}</button>`;
    } else {
      const cost = weaponUpgradeCost(id, lvl);
      btns = `<button class="btn small" data-act="equip" data-id="${id}" ${equipped ? 'disabled' : ''}>${equipped ? '已安裝' : '安裝'}</button>`;
      btns += lvl < MAX_WEAPON_LVL
        ? `<button class="btn small primary" data-act="upw" data-id="${id}" ${p.cash < cost ? 'disabled' : ''}>升級 $${cost}</button>`
        : `<button class="btn small" disabled>已滿級</button>`;
    }
    return `<div class="card ${equipped ? 'equipped' : ''}">
      ${icon ? `<div class="wimg"><img src="${icon}" alt="" /></div>` : ''}
      <h4>${def.name}<small>${owned ? 'Lv.' + lvl : '未擁有'}</small></h4>
      <p>${def.desc}</p>
      <div class="stat">${info}　${pips(owned ? lvl : 0, MAX_WEAPON_LVL)}</div>
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
      ? `<button class="btn small primary" data-act="buycar" data-id="${id}" ${p.cash < c.price ? 'disabled' : ''}>購買 $${c.price}</button>`
      : `<button class="btn small" data-act="usecar" data-id="${id}" ${using ? 'disabled' : ''}>${using ? '使用中' : '選用'}</button>`;
    const lv = p.livery?.[id] ?? 0;
    const icon = carIcon(c.model, c.liveries[lv]);
    const swatches = c.liveries.map((l, i) => `<button class="swatch ${i === lv ? 'on' : ''}" data-act="livery" data-id="${id}:${i}" ${owned ? '' : 'disabled'} title="${l.name}" style="--sw:${liverySwatch(l, c.color)}"><span></span>${l.name}</button>`).join('');
    return `<div class="card ${using ? 'equipped' : ''}">
      ${icon ? `<div class="wimg car"><img src="${icon}" alt="" /></div>` : ''}
      <h4>${c.name}<small>${owned ? '已擁有' : '未擁有'}</small></h4>
      <p>${c.desc}</p>
      <p class="trait">★ ${c.trait}</p>
      <div class="swatches">${swatches}</div>
      ${stat('極速', (c.speed - 0.94) / 0.12)}
      ${stat('加速', (c.accel - 0.88) / 0.2)}
      ${stat('操控', (c.handling - 0.9) / 0.26)}
      ${stat('耐久', (100 + c.hp - 80) / 80)}
      ${stat('集氣', (c.gauge - 0.9) / 0.45 + c.boostTime * 0.5)}
      <div class="row" style="margin-top:.7em">${btn}</div>
    </div>`;
  }

  private upgradeCard(id: CarUpgradeId): string {
    const p = this.profile;
    const lvl = p.car[id];
    const cost = carUpgradeCost(lvl);
    const btn = lvl < MAX_CAR_LVL
      ? `<button class="btn small primary" data-act="upc" data-id="${id}" ${p.cash < cost ? 'disabled' : ''}>升級 $${cost}</button>`
      : `<button class="btn small" disabled>已滿級</button>`;
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
          <h2>車庫</h2>
          <span class="cash">$${p.cash}</span>
          <div class="row">
            <button class="btn small" data-act="back">返回</button>
            <button class="btn small primary" data-act="start" ${this.loading ? 'disabled' : ''}>出賽</button>
          </div>
        </div>
        <div class="section"><h3>車款</h3><div class="cards">${CAR_IDS.map((c) => this.carCard(c)).join('')}</div></div>
        <div class="section"><h3>主武器（車身兩側，朝正前方直射）</h3><div class="cards">${PRIMARY_IDS.map((w) => this.weaponCard(w)).join('')}</div></div>
        <div class="section"><h3>副武器（引擎蓋）</h3><div class="cards">${SECONDARY_IDS.map((w) => this.weaponCard(w)).join('')}</div></div>
        <div class="section"><h3>車輛升級（所有車款共用）</h3><div class="cards">${(['engine', 'n2o', 'armor'] as CarUpgradeId[]).map((u) => this.upgradeCard(u)).join('')}</div></div>
      </div>`;
    const s = this.root.querySelector('.screen');
    if (s) s.scrollTop = scroll;
  }

  /** 設定頁：畫質、音量、配樂、操控與按鈕位置 */
  settingsPage(): void {
    this.current = 'settings';
    const s = this.settings;
    const pick = (act: string, cur: string, opts: [string, string][]) =>
      `<div class="choices">${opts.map(([v, n]) => `<button class="diffbtn ${cur === v ? 'on' : ''}" data-act="${act}" data-id="${v}">${n}</button>`).join('')}</div>`;
    const range = (key: string, v: number, min: number, max: number, step: number) => `<input type="range" data-set="${key}" min="${min}" max="${max}" step="${step}" value="${v}" />`;
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,60px)">設定</h1>
        <div class="setgrid">
          <h3>畫面</h3>
          <b>畫質</b>${pick('quality', s.quality, [['low', '低（省電）'], ['medium', '中'], ['high', '高']])}
          <small>變更後會重新載入</small>
          <b>畫面震動</b>${range('shake', s.shake, 0, 1, 0.05)}
          <b>傷害數字</b><label><input type="checkbox" data-set="dmgNumbers" ${s.dmgNumbers ? 'checked' : ''} /> 打中對手時顯示</label>
          <h3>聲音</h3>
          <b>音樂音量</b>${range('music', s.music, 0, 1, 0.05)}
          <b>音效音量</b>${range('sfx', s.sfx, 0, 1, 0.05)}
          <b>比賽配樂</b>${pick('style', s.musicStyle, MUSIC_STYLES.map((m) => [m.id, m.name]))}
          <small>在這頁可以直接試聽</small>
          <h3>操控輔助</h3>
          <b>自動小噴</b><label><input type="checkbox" data-set="autoMini" ${s.autoMini ? 'checked' : ''} /> 甩尾結束自動噴（不用自己按）</label>
          <b>甩尾輔助</b><label><input type="checkbox" data-set="driftAssist" ${s.driftAssist ? 'checked' : ''} /> 自動回正、限制甩尾角度</label>
          <div class="touch-only">
            <h3>手機操控</h3>
            <b>甩尾鍵</b>${pick('tdrift', s.touchDrift, [['single', '一顆（配合方向鍵）'], ['dual', '左甩／右甩兩顆']])}
            <b>轉向方式</b>${pick('ctrl', s.control, [['buttons', '左右按鈕'], ['tilt', '傾斜手機']])}
            ${s.control === 'tilt' ? `<b>傾斜靈敏度</b>${range('tiltRange', 52 - s.tiltRange, 12, 40, 1)}
            <b>方向反轉</b><label><input type="checkbox" data-set="tiltInvert" ${s.tiltInvert ? 'checked' : ''} /> 轉向相反時打勾</label>
            <b></b><div class="choices"><button class="diffbtn" data-act="calib">把現在的角度設為正中</button></div>` : ''}
            <b>按鈕位置</b><div class="choices"><button class="diffbtn" data-act="layout">拖曳調整位置與大小</button><button class="diffbtn" data-act="layoutreset">恢復預設</button></div>
          </div>
        </div>
        <div class="row"><button class="btn primary" data-act="sback">返回</button></div>
      </div>`;
  }

  pause(muted: boolean, missionHtml: string, online = false): void {
    this.pauseArgs = [muted, missionHtml];
    if (online) {
      this.current = 'pause';
      this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,48px)">選單</h1>
        <p class="sub">線上比賽不會暫停，車子還在跑！</p>
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">回到比賽</button>
          <button class="btn" data-act="mute">${muted ? '音效：關' : '音效：開'}</button>
          <button class="btn" data-act="leaveroom">離開房間</button>
        </div>
      </div>`;
      return;
    }
    this.current = 'pause';
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,64px)">暫停</h1>
        <div class="missions-box">${missionHtml}</div>
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">繼續</button>
          <button class="btn" data-act="restart">重新開始</button>
          <button class="btn" data-act="mute">${muted ? '音效：關' : '音效：開'}</button>
          <button class="btn" data-act="settings">設定</button>
          <button class="btn" data-act="menu">回主選單</button>
        </div>
      </div>`;
  }

  results(race: Race, s: Summary, online = false): void {
    this.current = 'results';
    const p = race.player;
    const elim = race.mode === 'elim';
    const order = race.results();
    const rows = order.map((k, i) => `
      <tr class="${k === p ? 'me' : ''}">
        <td>${i + 1}</td><td>${k.name}</td>
        <td>${elim ? (k.out ? '淘汰' : '存活') : k.finished ? formatTime(k.finishTime) : '未完賽'}</td>
        <td>擊毀 ${k.kills}</td>
      </tr>`).join('');
    const missions = s.missions.map((m) => `<div class="${m.done ? 'ok' : 'no'}">${m.done ? '✔' : '✘'} ${m.text} <em>${m.done ? '+$' + m.reward : '$' + m.reward}</em></div>`).join('');
    this.lastResults = `
      <div class="screen">
        <div class="results">
          <h2>${elim && s.rank === 1 ? '冠軍！' : `第 ${s.rank} 名`}</h2>
          <table>${rows}</table>
          <div class="missions-box"><b>本場任務</b>${missions}</div>
          <div class="earn">
            名次 $${s.payout}　＋　擊毀 ${p.kills} × $${KILL_REWARD}${s.streakCash ? '　＋　連續擊毀 $' + s.streakCash : ''}　＋　任務 $${s.missionCash}<br />
            本場收入 <b>$${s.total}</b>${s.bestLap > 0 ? '　最快單圈 ' + formatTime(s.bestLap) : ''}
          </div>
          <div class="row">
            ${online
              ? '<button class="btn primary" data-act="toroom">回到房間</button><button class="btn" data-act="leaveroom">離開房間</button>'
              : '<button class="btn primary" data-act="start">再來一場</button><button class="btn" data-act="garage">車庫</button><button class="btn" data-act="menu">主選單</button>'}
          </div>
        </div>
      </div>`;
    this.root.innerHTML = this.lastResults;
  }
}
