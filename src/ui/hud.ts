import { KILL_REWARD, STREAK_BONUS } from '../game/config';
import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { formatTime } from '../game/util';
import { PRIMARY, SECONDARY } from '../game/weapons';
import type { GameView } from '../render/view';

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
  private mapBg = document.createElement('canvas');
  private mapT = { s: 1, ox: 0, oz: 0, size: 220 };
  private cache: Record<string, string | number> = {};
  private scr = { x: 0, y: 0 };

  constructor(track: Track) {
    this.setTrack(track);
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
    this.feed.innerHTML = '';
    this.popups.innerHTML = '';
    this.cache = {};
    this.center.className = '';
    this.center.textContent = '';
    this.sub.textContent = '';
    this.hitK = 0;
    this.missionT = 9;
    this.wasDrafting = false;
    this.missions.classList.remove('fade');
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
        if (e.by === p) this.hitMarkT = 0.12;
        break;
      case 'ram':
        if ((e.a === p || e.b === p) && e.power > 5) {
          const fast = p.boostT > 0 || p.padT > 0;
          this.popup(fast ? '噴射衝撞！' : '碰撞！', fast ? 'gold' : '');
        }
        break;
      case 'kart':
        if (e.k !== p) break;
        if (e.e === 'jump') this.popup('飛越！');
        else if (e.e === 'n2o') this.popup('N2O +1', 'blue');
        else if (e.e === 'mini') this.popup('小噴！', 'gold');
        else if (e.e === 'driftFail') this.popup('撞牆！這次甩尾的集氣歸零', 'warn');
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
          this.popup(`+$${KILL_REWARD + (e.streak - 1) * STREAK_BONUS}　N2O +1`, 'gold');
        }
        break;
      }
    }
  }

  update(race: Race, view: GameView, dt: number): void {
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
    this.width('w1', this.w1Bar, p.heat);
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
    const sp = Math.round(Math.max(view.boostK, p.drafting ? 0.35 : 0) * 10) / 10;
    if (this.cache.fxs !== sp) {
      this.cache.fxs = sp;
      this.fxSpeed.style.opacity = String(sp);
    }
    this.hitK = p.dead ? 0.7 : Math.max(p.sinceDamage < 0.1 ? 1 : 0, this.hitK - 0.04, p.hp < p.maxHp * 0.3 ? 0.45 : 0);
    const hk = Math.round(this.hitK * 10) / 10;
    if (this.cache.fxh !== hk) {
      this.cache.fxh = hk;
      this.fxHit.style.opacity = String(hk);
    }

    // 提示訊息
    let sub = '';
    let subCls = '';
    if (p.dead) { sub = p.out ? '' : '車輛重生中…'; subCls = 'warn'; }
    else if (p.finished) sub = '';
    else if (p.wrongWayT > 1) { sub = '逆向行駛！'; subCls = 'warn'; }
    else if (p.overheated) { sub = '武器過熱'; subCls = 'warn'; }
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
      this.reticle.style.transform = 'translate(' + this.scr.x.toFixed(1) + 'px, ' + this.scr.y.toFixed(1) + 'px)';
    } else {
      this.reticle.style.display = 'none';
    }
    this.hitMarkT -= dt;
    this.cls('hitmark', this.reticle, 'hit', this.hitMarkT > 0);

    // 任務：開場顯示幾秒後淡出，進度每半秒更新一次
    this.missionT -= dt;
    this.cls('missionfade', this.missions, 'fade', this.missionT <= 0);
    const tick = Math.floor(race.time * 2);
    if (this.cache.missionTick !== tick) {
      this.cache.missionTick = tick;
      this.missions.innerHTML = this.missionHtml(race);
    }

    this.drawMap(race);
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
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 9;
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 5;
    c.stroke();
    const s0 = track.samples[0];
    const [sx, sy] = this.mapXY(s0.x, s0.z);
    c.fillStyle = '#ff4747';
    c.fillRect(sx - 6, sy - 2, 12, 4);
    // 跳台位置
    c.fillStyle = '#ff9d2e';
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
    }
    const p = race.player;
    const [x, y] = this.mapXY(p.x, p.z);
    c.fillStyle = '#fff';
    c.strokeStyle = '#111';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 6, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
}
