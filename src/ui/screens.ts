import { KILL_REWARD, PAYOUT } from '../game/config';
import type { Race } from '../game/race';
import { saveProfile, type Profile } from '../game/save';
import { formatTime } from '../game/util';
import {
  CAR_UPGRADES, MAX_CAR_LVL, MAX_WEAPON_LVL, PRIMARY, SECONDARY, carUpgradeCost, isPrimary,
  weaponLvlMul, weaponUpgradeCost, type CarUpgradeId, type WeaponId,
} from '../game/weapons';

export interface ScreenActions {
  start(): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  toggleMute(): boolean;
}

const pips = (lvl: number, max: number) =>
  `<span class="pips">${Array.from({ length: max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span>`;

/** 主選單、車庫、暫停、結算畫面 */
export class Screens {
  private root = document.getElementById('screens')!;
  private profile: Profile;
  private act: ScreenActions;
  current: 'none' | 'menu' | 'garage' | 'pause' | 'results' = 'none';
  private garageBack: 'menu' | 'results' = 'menu';
  private lastResults = '';

  constructor(profile: Profile, act: ScreenActions) {
    this.profile = profile;
    this.act = act;
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el) this.handle(el.dataset.act!, el.dataset.id);
    });
  }

  hide(): void {
    this.current = 'none';
    this.root.innerHTML = '';
  }

  private handle(act: string, id?: string): void {
    const p = this.profile;
    switch (act) {
      case 'start': this.act.start(); break;
      case 'resume': this.act.resume(); break;
      case 'restart': this.act.restart(); break;
      case 'menu': this.act.toMenu(); break;
      case 'garage': this.garageBack = this.current === 'results' ? 'results' : 'menu'; this.garage(); break;
      case 'back':
        if (this.garageBack === 'results' && this.lastResults) { this.current = 'results'; this.root.innerHTML = this.lastResults; }
        else this.menu();
        break;
      case 'mute': {
        const m = this.act.toggleMute();
        const b = this.root.querySelector('[data-act="mute"]');
        if (b) b.textContent = m ? '音效：關' : '音效：開';
        break;
      }
      case 'buy': {
        const w = id as WeaponId;
        const price = (isPrimary(w) ? PRIMARY[w] : SECONDARY[w]).price;
        if (!p.owned[w] && p.cash >= price) {
          p.cash -= price;
          p.owned[w] = true;
          if (isPrimary(w)) p.primary = w; else p.secondary = w;
        }
        saveProfile(p);
        this.garage();
        break;
      }
      case 'equip': {
        const w = id as WeaponId;
        if (p.owned[w]) { if (isPrimary(w)) p.primary = w; else p.secondary = w; }
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
    }
  }

  menu(loading = false): void {
    this.current = 'menu';
    const p = this.profile;
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title">EXPLOSIVE <span>RACING</span></h1>
        <div class="tagline">甩尾集氣、N2O 衝刺，再用機槍與飛彈把對手轟出賽道</div>
        <div class="row">
          <button class="btn primary" data-act="start" ${loading ? 'disabled' : ''}>${loading ? '載入中…' : '開始比賽'}</button>
          <button class="btn" data-act="garage">車庫</button>
        </div>
        <div class="tagline" style="margin:1.2em 0 0"><span class="cash">$${p.cash}</span>　出賽 ${p.races}　冠軍 ${p.wins}　最快單圈 ${formatTime(p.bestLap)}</div>
        <div class="help">
          <b>鍵盤</b>　<kbd>↑↓←→</kbd> 駕駛　<kbd>Shift</kbd> 甩尾　<kbd>Ctrl</kbd> N2O　<kbd>Z</kbd> 主武器　<kbd>X</kbd> 副武器　<kbd>C</kbd> 後視　<kbd>R</kbd> 重置　<kbd>Esc</kbd> 暫停<br />
          <b>手機</b>　自動油門，左下方向鍵、左側中間開火，右下甩尾與 N2O<br />
          <b>技巧</b>　過彎時點一下甩尾並按住方向可以拖漂很久，反打方向盤回正；集滿一管得到一瓶 N2O（最多兩瓶）；甩尾結束瞬間再按一次 <kbd>↑</kbd>（手機按 N2O）可觸發小噴；地上的箭頭是加速帶
        </div>
      </div>`;
  }

  private weaponCard(id: WeaponId): string {
    const p = this.profile;
    const prim = isPrimary(id);
    const def = prim ? PRIMARY[id] : SECONDARY[id];
    const owned = p.owned[id];
    const lvl = p.lvl[id];
    const equipped = owned && (prim ? p.primary === id : p.secondary === id);
    const mul = weaponLvlMul(lvl);
    const stat = prim
      ? `每秒傷害 ${(PRIMARY[id as 'mg'].dmg * PRIMARY[id as 'mg'].rate * mul).toFixed(0)}　射速 ${PRIMARY[id as 'mg'].rate}/秒`
      : `傷害 ${(SECONDARY[id as 'rocket'].dmg * mul).toFixed(0)}　冷卻 ${SECONDARY[id as 'rocket'].cooldown} 秒`;
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
      <h4>${def.name}<small>${owned ? 'Lv.' + lvl : '未擁有'}</small></h4>
      <p>${def.desc}</p>
      <div class="stat">${stat}　${pips(owned ? lvl : 0, MAX_WEAPON_LVL)}</div>
      <div class="row">${btns}</div>
    </div>`;
  }

  private carCard(id: CarUpgradeId): string {
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
            <button class="btn small primary" data-act="start">出賽</button>
          </div>
        </div>
        <div class="section"><h3>主武器（車身兩側）</h3><div class="cards">${this.weaponCard('mg')}${this.weaponCard('vulcan')}</div></div>
        <div class="section"><h3>副武器（引擎蓋）</h3><div class="cards">${this.weaponCard('rocket')}${this.weaponCard('howitzer')}</div></div>
        <div class="section"><h3>車輛升級</h3><div class="cards">${this.carCard('engine')}${this.carCard('n2o')}${this.carCard('armor')}</div></div>
      </div>`;
    const s = this.root.querySelector('.screen');
    if (s) s.scrollTop = scroll;
  }

  pause(muted: boolean): void {
    this.current = 'pause';
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,64px)">暫停</h1>
        <div class="tagline"></div>
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">繼續</button>
          <button class="btn" data-act="restart">重新開始</button>
          <button class="btn" data-act="mute">${muted ? '音效：關' : '音效：開'}</button>
          <button class="btn" data-act="menu">回主選單</button>
        </div>
      </div>`;
  }

  results(race: Race, rank: number, reward: number, bestLap: number): void {
    this.current = 'results';
    const p = race.player;
    const order = race.results();
    const rows = order.map((k, i) => `
      <tr class="${k === p ? 'me' : ''}">
        <td>${i + 1}</td><td>${k.name}</td>
        <td>${k.finished ? formatTime(k.finishTime) : '未完賽'}</td>
        <td>擊毀 ${k.kills}</td>
      </tr>`).join('');
    this.lastResults = `
      <div class="screen">
        <div class="results">
          <h2>第 ${rank} 名</h2>
          <table>${rows}</table>
          <div class="earn">
            名次獎金 $${PAYOUT[rank - 1] ?? 0}　＋　擊毀 ${p.kills} × $${KILL_REWARD}<br />
            本場收入 <b>$${reward}</b>　最快單圈 ${formatTime(bestLap)}
          </div>
          <div class="row">
            <button class="btn primary" data-act="start">再來一場</button>
            <button class="btn" data-act="garage">車庫</button>
            <button class="btn" data-act="menu">主選單</button>
          </div>
        </div>
      </div>`;
    this.root.innerHTML = this.lastResults;
  }
}
