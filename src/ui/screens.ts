import { CAR_IDS, CARS, type CarId } from '../game/cars';
import { KILL_REWARD } from '../game/config';
import type { Race, RaceMode } from '../game/race';
import { TOUCH_SKINS } from './touchIcons';
import { liverySwatch } from '../render/livery';
import { carIcon, weaponIcon } from '../render/weaponIcons';
import { DIFFICULTY, DIFFICULTY_IDS, type DifficultyId } from '../game/difficulty';
import { saveProfile, type Profile } from '../game/save';
import { formatTime } from '../game/util';
import {
  BURN_DPS, PERK_LVL3, PERK_LVL5, CAR_UPGRADES, MAX_CAR_LVL, MAX_WEAPON_LVL, PRIMARY, PRIMARY_IDS, SECONDARY, SECONDARY_IDS, carUpgradeCost, isPrimary,
  weaponLvlMul, weaponUpgradeCost, type CarUpgradeId, type SecondaryId, type WeaponId,
} from '../game/weapons';

export interface TrackInfo {
  name: string;
  desc: string;
  laps: number;
  length: number;
}

export interface ScreenActions {
  start(mode?: RaceMode): void;
  selectTrack(i: number): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  toggleMute(): boolean;
  /** 套用手機按鈕樣式（profile.touchSkin 已更新） */
  touchSkin(): void;
}

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
  current: 'none' | 'menu' | 'garage' | 'pause' | 'results' = 'none';
  private garageBack: 'menu' | 'results' = 'menu';
  private lastResults = '';
  private loading = false;

  constructor(profile: Profile, tracks: TrackInfo[], trackIndex: () => number, act: ScreenActions) {
    this.profile = profile;
    this.tracks = tracks;
    this.trackIndex = trackIndex;
    this.act = act;
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el && !(el as HTMLButtonElement).disabled) this.handle(el.dataset.act!, el.dataset.id);
    });
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
      case 'skin':
        p.touchSkin = Number(id);
        saveProfile(p);
        this.act.touchSkin();
        this.root.querySelectorAll('.skinbtn').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.id === id));
        break;
      case 'diff':
        p.difficulty = id as DifficultyId;
        saveProfile(p);
        this.menu(this.loading);
        break;
      case 'resume': this.act.resume(); break;
      case 'restart': this.act.restart(); break;
      case 'menu': this.act.toMenu(); break;
      case 'garage': this.garageBack = this.current === 'results' ? 'results' : 'menu'; this.garage(); break;
      case 'back':
        if (this.garageBack === 'results' && this.lastResults) { this.current = 'results'; this.root.innerHTML = this.lastResults; }
        else this.menu(this.loading);
        break;
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
    const trackBtns = this.tracks.map((t, i) => `
      <button class="trackbtn ${i === ti ? 'on' : ''}" data-act="track" data-id="${i}" ${dis}>
        <b>${t.name}</b><span>${t.desc}</span><span>${(t.length / 1000).toFixed(1)} 公里 × ${t.laps} 圈</span>
      </button>`).join('');
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title">EXPLOSIVE <span>RACING</span></h1>
        <div class="tagline">甩尾集氣、N2O 衝刺，再用機槍與火箭把對手轟出賽道</div>
        <div class="tracks">${trackBtns}</div>
        <div class="modes">
          <button class="mode primary" data-act="start" data-id="race" ${dis}>
            <b>${loading ? '載入中…' : '競速賽'}</b><span>跑完 ${cur.laps} 圈，名次高的贏</span>
          </button>
          <button class="mode" data-act="start" data-id="elim" ${dis}>
            <b>${loading ? '載入中…' : '淘汰賽'}</b><span>每 ${17} 秒淘汰最後一名，撐到最後</span>
          </button>
        </div>
        <div class="diffs"><span>電腦難度</span>${DIFFICULTY_IDS.map((d) => `<button class="diffbtn ${p.difficulty === d ? 'on' : ''}" data-act="diff" data-id="${d}" title="${DIFFICULTY[d].desc}">${DIFFICULTY[d].name}</button>`).join('')}<em>${DIFFICULTY[p.difficulty].desc}</em></div>
        ${this.skinRow()}
        <div class="row" style="margin-top:0.8em"><button class="btn" data-act="garage">車庫</button></div>
        <div class="tagline" style="margin:1.1em 0 0">
          <span class="cash">$${p.cash}</span>　${CARS[p.kart].name}・${PRIMARY[p.primary].name}・${SECONDARY[p.secondary].name}　出賽 ${p.races}　冠軍 ${p.wins}　${cur.name}最快單圈 ${formatTime(p.bestLaps[p.track] ?? 0)}
        </div>
        <div class="help">
          <b>鍵盤</b>　<kbd>↑↓←→</kbd> 駕駛　<kbd>Shift</kbd> 甩尾　<kbd>Ctrl</kbd> N2O　<kbd>Z</kbd> 主武器　<kbd>X</kbd> 副武器　<kbd>C</kbd> 後視　<kbd>R</kbd> 重置　<kbd>Esc</kbd> 暫停<br />
          <b>手機</b>　自動油門，左下方向鍵、左側中間開火，右下甩尾與 N2O<br />
          <b>集氣</b>　甩尾最快；打中對手、擊毀（直接送一瓶）、跟在別人正後方吃尾流、飛越跳台、踩加速帶也都會集氣<br />
          <b>技巧</b>　倒數到 GO 的瞬間才按油門可以起跑衝刺；點一下甩尾並按住方向能拖漂，結束瞬間再按一次 <kbd>↑</kbd> 觸發小噴；開著 N2O 撞人傷害加倍；紅色油桶打了會爆
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
      info = P.kind === 'flame'
        ? `每秒傷害 ${dps} + 燃燒 ${BURN_DPS}/秒　射程 ${P.range} m`
        : `每秒傷害 ${dps}　射程 ${P.range} m${P.kind === 'laser' ? '（瞬間命中）' : ''}`;
    } else {
      const S = SECONDARY[id as SecondaryId];
      info = `傷害 ${(S.dmg * mul).toFixed(0)}${S.count > 1 ? ' × ' + S.count : ''}　冷卻 ${S.cooldown} 秒`;
    }
    const lv = owned ? lvl : 0;
    const perks = `<div class="perks">
      <div class="${lv >= PERK_LVL3 ? 'on' : ''}"><b>Lv.${PERK_LVL3}</b> ${prim ? '過熱變慢 15%' : '冷卻縮短 15%'}</div>
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

  /** 手機按鈕樣式的選擇列（只在觸控裝置顯示） */
  private skinRow(): string {
    const cur = this.profile.touchSkin;
    return `<div class="diffs touch-only"><span>手機按鈕</span>${TOUCH_SKINS.map((s) => `<button class="diffbtn skinbtn ${cur === s.id ? 'on' : ''}" data-act="skin" data-id="${s.id}">${s.id}・${s.name}</button>`).join('')}</div>`;
  }

  pause(muted: boolean, missionHtml: string): void {
    this.current = 'pause';
    this.root.innerHTML = `
      <div class="screen">
        <h1 class="title" style="font-size:clamp(28px,7vw,64px)">暫停</h1>
        <div class="missions-box">${missionHtml}</div>
        ${this.skinRow()}
        <div class="row" style="flex-direction:column;align-items:center">
          <button class="btn primary" data-act="resume">繼續</button>
          <button class="btn" data-act="restart">重新開始</button>
          <button class="btn" data-act="mute">${muted ? '音效：關' : '音效：開'}</button>
          <button class="btn" data-act="menu">回主選單</button>
        </div>
      </div>`;
  }

  results(race: Race, s: Summary): void {
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
            <button class="btn primary" data-act="start">再來一場</button>
            <button class="btn" data-act="garage">車庫</button>
            <button class="btn" data-act="menu">主選單</button>
          </div>
        </div>
      </div>`;
    this.root.innerHTML = this.lastResults;
  }
}
