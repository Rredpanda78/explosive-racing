import type { Race, RaceEvent } from '../game/race';
import type { Track } from '../game/track';
import { formatTime } from '../game/util';
import { PRIMARY, SECONDARY } from '../game/weapons';
import type { GameView } from '../render/view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 比賽中的抬頭顯示：名次、圈數、速度、集氣、武器、小地圖 */
export class Hud {
  private root = $('hud');
  private pos = $('pos');
  private lap = $('lap');
  private laps = $('laps');
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
  private map = $<HTMLCanvasElement>('minimap');
  private mapBg = document.createElement('canvas');
  private mapT = { s: 1, ox: 0, oz: 0, size: 220 };
  private cache: Record<string, string | number> = {};
  private scr = { x: 0, y: 0 };
  private stayMsg = false;

  constructor(track: Track) {
    this.buildMap(track);
  }

  show(race: Race): void {
    this.root.classList.remove('hidden');
    this.laps.textContent = String(race.track.laps);
    this.w1.querySelector('.wname')!.textContent = PRIMARY[race.player.primary].name;
    this.w2.querySelector('.wname')!.textContent = SECONDARY[race.player.secondary].name;
    this.feed.innerHTML = '';
    this.cache = {};
    this.stayMsg = false;
    this.center.className = '';
    this.center.textContent = '';
    this.sub.textContent = '';
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
    this.stayMsg = stay;
    this.center.textContent = text;
    this.center.className = '';
    void this.center.offsetWidth;
    this.center.className = stay ? 'stay' : 'pop';
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
      case 'lap':
        if (e.k === p && e.lap < race.track.laps) this.flash(e.lap === race.track.laps - 1 ? '最後一圈！' : `第 ${e.lap + 1} 圈`);
        break;
      case 'finish':
        if (e.k === p) this.flash(`第 ${p.rank} 名`, true);
        break;
      case 'kill': {
        const d = document.createElement('div');
        const killer = e.killer ? e.killer.name : '';
        if (e.killer === p || e.victim === p) d.className = 'me';
        d.textContent = `${killer} 💥 ${e.victim.name}`;
        this.feed.appendChild(d);
        setTimeout(() => d.remove(), 4000);
        while (this.feed.children.length > 4) this.feed.firstChild!.remove();
        if (e.killer === p) this.flash('擊毀！');
        break;
      }
    }
  }

  update(race: Race, view: GameView): void {
    const p = race.player;
    this.set('pos', this.pos, String(p.rank));
    this.set('lap', this.lap, String(Math.min(race.track.laps, Math.max(1, p.lapCount + 1))));
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

    // 提示訊息
    let sub = '';
    let subCls = '';
    if (p.dead) { sub = '車輛重生中…'; subCls = 'warn'; }
    else if (p.finished) sub = '';
    else if (p.wrongWayT > 1) { sub = '逆向行駛！'; subCls = 'warn'; }
    else if (p.overheated) { sub = '武器過熱'; subCls = 'warn'; }
    else if (p.miniWindowT > 0) { sub = '小噴！'; subCls = 'mini'; }
    this.set('sub', this.sub, sub);
    if (this.cache.subCls !== subCls) {
      this.cache.subCls = subCls;
      this.sub.className = subCls;
    }

    // 鎖定準星
    const tg = !p.dead && !p.finished && race.state !== 'countdown'
      ? race.pickTarget(p, p.secondary === 'missile' ? 0.5 : 0.35, p.secondary === 'missile' ? 190 : 125)
      : null;
    if (tg && view.project(tg.x, 1, tg.z, this.scr)) {
      this.reticle.style.display = 'block';
      this.reticle.style.transform = `translate(${this.scr.x.toFixed(1)}px, ${this.scr.y.toFixed(1)}px)`;
    } else {
      this.reticle.style.display = 'none';
    }

    this.drawMap(race);
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
      if (k.isPlayer || k.dead) continue;
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
