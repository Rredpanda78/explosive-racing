import './ui/style.css';
import { GameAudio } from './audio';
import { KILL_REWARD, PAYOUT, STREAK_BONUS } from './game/config';
import { emptyInput } from './game/kart';
import type { NetRacer, OnlineSetup } from './game/net';
import { Race, type RaceMode } from './game/race';
import { OnlineSession, type StartMsg } from './net/online';
import { cleanCode, ERR_TEXT, newRoomCode } from './net/room';
import { loadProfile, saveProfile } from './game/save';
import { Track, TRACKS } from './game/track';
import { Input } from './input';
import { CAR_MODELS, DEBRIS_MODELS, KART_MODELS, LANDMARK_MODELS, loadModels, PROP_MODELS } from './render/assets';
import { GameView } from './render/view';
import { applyLayout, LAYOUT_IDS, loadSettings, saveSettings, type Settings } from './settings';
import { Hud } from './ui/hud';
import { Screens, type Summary } from './ui/screens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const touchRoot = document.getElementById('touch')!;
const coarse = window.matchMedia('(pointer: coarse)').matches;

const profile = loadProfile();
let trackIndex = Math.max(0, TRACKS.findIndex((t) => t.id === profile.track));
let track = new Track(TRACKS[trackIndex]);
/** 選單上顯示的地圖清單（長度要先把賽道算出來才知道） */
const trackList = TRACKS.map((def) => {
  const t = new Track(def);
  return { name: def.name, desc: def.desc, laps: def.laps, length: Math.round(t.length), outline: trackOutline(t), theme: def.theme };
});

/** 選單上的賽道縮圖：把賽道中心線縮放成 SVG 路徑（viewBox 0 0 100 64） */
function trackOutline(t: Track): string {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of t.samples) { minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minZ = Math.min(minZ, s.z); maxZ = Math.max(maxZ, s.z); }
  const sc = Math.min(92 / (maxX - minX), 56 / (maxZ - minZ));
  const ox = 50 + ((minX + maxX) / 2) * sc, oz = 32 + ((minZ + maxZ) / 2) * sc;
  let d = '';
  for (let i = 0; i < t.n; i += 6) {
    const s = t.samples[i];
    d += (i ? 'L' : 'M') + (ox - s.x * sc).toFixed(1) + ' ' + (oz - s.z * sc).toFixed(1);
  }
  return d + 'Z';
}
const settings = loadSettings(coarse);
const view = new GameView(canvas, coarse, settings.quality);
const input = new Input();
const hud = new Hud(track);
const audio = new GameAudio();
let race: Race | null = null;
/** 套用設定裡不需要重新載入的部分 */
function applySettings(): void {
  view.shakeMul = settings.shake;
  audio.setVolumes(settings.music, settings.sfx);
  if (audio.musicStyle !== settings.musicStyle) audio.setStyle(settings.musicStyle);
  hud.dmgNumbers = settings.dmgNumbers;
  input.tiltMode = settings.control === 'tilt';
  input.tilt.range = settings.tiltRange;
  input.tilt.invert = settings.tiltInvert;
  touchRoot.classList.toggle('tilt', input.tiltMode);
  touchRoot.classList.toggle('dual', settings.touchDrift === 'dual');
  if (race) {
    race.player.autoMini = settings.autoMini;
    race.player.driftAssist = settings.driftAssist;
  }
  applyLayout(settings);
}
applySettings();

let mode: RaceMode = 'race';
let ready = false;
/** 線上對戰的連線（null = 單機） */
let online: OnlineSession | null = null;
/** 房主已回到房間、但其他人還在跑的比賽（在背景繼續模擬） */
let bgRace: Race | null = null;
const NAME_KEY = 'explosive-racing-name';
function playerName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}
function setPlayerName(n: string): void {
  const v = n.trim().slice(0, 8);
  if (!v) return;
  try { localStorage.setItem(NAME_KEY, v); } catch { /* 無痕模式 */ }
}
/** 進房時告訴大家自己的車與裝備 */
function myRacer(): Omit<NetRacer, 'pid'> {
  return {
    name: playerName() || '車手', car: profile.kart, livery: profile.livery?.[profile.kart] ?? 0,
    primary: profile.primary, secondary: profile.secondary, plvl: profile.lvl[profile.primary], slvl: profile.lvl[profile.secondary],
    engine: profile.car.engine, n2o: profile.car.n2o, armor: profile.car.armor,
  };
}
const NO_INPUT = emptyInput();
let paused = false;
let resultsTimer = 0;
let resultsShown = false;
/** 擊毀瞬間的短暫慢動作（以真實時間計） */
let slowT = 0;
/** 這場靠連續擊毀多賺的獎金 */
let streakCash = 0;

function setTouchUI(on: boolean): void {
  document.body.classList.toggle('touch', on);
  touchRoot.classList.toggle('hidden', !on || !race || resultsShown);
}

function startRace(m?: RaceMode, seed?: number, setup?: OnlineSetup): void {
  if (!ready) return;
  if (m) mode = m;
  audio.init();
  audio.setMusic('race');
  audio.setMusicRush(false);
  if (coarse) {
    // 手機：嘗試全螢幕並鎖定橫向（不支援就略過）
    const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    el.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
  }
  if (input.tiltMode) void input.tilt.enable().then(() => input.tilt.calibrate());
  race = new Race(track, profile, mode, seed, setup);
  if (setup && online) online.attach(race);
  race.player.autoMini = settings.autoMini;
  race.player.driftAssist = settings.driftAssist;
  view.setRace(race);
  hud.show(race);
  screens.hide();
  paused = false;
  resultsTimer = 0;
  resultsShown = false;
  slowT = 0;
  streakCash = 0;
  input.clear();
  input.capture = true;
  if (coarse) input.touchMode = true;
  setTouchUI(input.touchMode);
}

/** 在主選單切換地圖：重建場景，背景會開始預覽新地圖 */
function selectTrack(i: number): void {
  if (race || !ready || i === trackIndex || !TRACKS[i]) return;
  trackIndex = i;
  track = new Track(TRACKS[i]);
  profile.track = TRACKS[i].id;
  saveProfile(profile);
  view.setTrack(track);
  hud.setTrack(track);
  screens.menu();
}

function toMenu(): void {
  if (online) leaveRoom();
  race = null;
  paused = false;
  resultsShown = false;
  input.capture = false;
  view.setRace(null);
  hud.hide();
  touchRoot.classList.add('hidden');
  audio.setMusic('menu');
  screens.menu();
}

function setPaused(p: boolean): void {
  if (!race || resultsShown) return;
  paused = p;
  if (p) screens.pause(audio.muted, hud.missionHtml(race), !!online);
  else {
    screens.hide();
    input.clear();
  }
}

const screens = new Screens(profile, trackList, () => trackIndex, {
  start: startRace,
  selectTrack,
  resume: () => setPaused(false),
  restart: () => startRace(),
  toMenu,
  toggleMute: () => {
    audio.setMuted(!audio.muted);
    return audio.muted;
  },
  settingChanged,
  editLayout,
  resetLayout: () => {
    settings.layout = {};
    saveSettings(settings);
    applyLayout(settings);
  },
  calibrateTilt: () => { void input.tilt.enable().then(() => input.tilt.calibrate()); },
  settingsOpen: (open) => {
    // 在設定頁試聽比賽配樂；離開時回到原本的音樂
    audio.init();
    if (!race) audio.setMusic(open ? 'race' : 'menu');
  },
  online: () => openOnline(),
  createRoom: (name) => {
    setPlayerName(name);
    enterRoom(newRoomCode(), true);
  },
  joinRoom: (code, name) => {
    setPlayerName(name);
    const c = cleanCode(code);
    if (c.length < 4) openOnline('請輸入 4 個字的房間代碼', c);
    else enterRoom(c, false);
  },
  roomCfg: (key, val) => {
    if (!online) return;
    if (key === 'track') online.setCfg({ track: Number(val) });
    else if (key === 'mode') online.setCfg({ mode: val as RaceMode });
    else if (key === 'ai') online.setCfg({ aiFill: val === '1' });
    else online.setCfg({ difficulty: val as typeof profile.difficulty });
  },
  roomStart: () => online?.start(),
  roomScreen: () => backToRoom(),
  leaveRoom: () => {
    leaveRoom();
    toMenu();
  },
});
screens.settings = settings;

// ---------------- 線上對戰 ----------------

function openOnline(msg = '', code = ''): void {
  screens.onlineMenu(playerName() || '車手' + Math.floor(10 + Math.random() * 90), msg, code);
}

function enterRoom(code: string, create: boolean): void {
  online?.leave();
  const s = new OnlineSession(myRacer, { track: trackIndex, mode: 'race', aiFill: true, difficulty: profile.difficulty });
  online = s;
  s.onChange = () => {
    if (online === s && !race && screens.current === 'room') screens.room(s);
  };
  s.onStart = (msg) => {
    if (online === s) startOnlineRace(s, msg);
  };
  s.onClosed = (code) => {
    if (online !== s) return;
    online = null;
    history.replaceState(null, '', location.pathname);
    if (race) {
      // 比賽中斷線：別人的車退出，自己繼續跑完
      for (const k of race.karts) if (k.remote) race.dropKart(k);
      race.net = null;
    } else openOnline(ERR_TEXT[code] ?? ERR_TEXT.closed);
  };
  s.open(code, create);
  history.replaceState(null, '', '?room=' + code);
  screens.room(s);
}

function leaveRoom(): void {
  bgRace = null;
  const s = online;
  online = null;
  s?.leave();
  history.replaceState(null, '', location.pathname);
}

function startOnlineRace(s: OnlineSession, msg: StartMsg): void {
  bgRace = null;
  // 用房主選的賽道與模式
  const ti = Math.max(0, Math.min(TRACKS.length - 1, msg.cfg.track));
  if (ti !== trackIndex) {
    trackIndex = ti;
    track = new Track(TRACKS[ti]);
    view.setTrack(track);
    hud.setTrack(track);
  }
  startRace(msg.cfg.mode, msg.seed, s.setup(msg));
}

/** 比賽結束（或從車庫）回到房間 */
function backToRoom(): void {
  const s = online;
  if (!s) return toMenu();
  if (race) {
    // 房主：其他人還在跑就讓比賽在背景繼續（電腦車手、淘汰判定都在房主這裡）
    const r = race;
    const busy = r.mode === 'elim' ? r.aliveCount > 1 : r.karts.some((k) => !k.finished && !k.out);
    bgRace = s.isHost && busy ? r : null;
    if (bgRace) s.backToLobby(true);
    race = null;
    paused = false;
    resultsShown = false;
    input.capture = false;
    view.setRace(null);
    hud.hide();
    touchRoot.classList.add('hidden');
    audio.setMusic('menu');
    if (!bgRace) s.backToLobby();
  }
  s.refreshInfo();
  screens.room(s);
}

function settingChanged(key: keyof Settings): void {
  if (key === 'tiltRange') {
    // 滑桿往右 = 更靈敏（轉到底需要的角度更小）
    settings.tiltRange = 52 - Number((settings as unknown as Record<string, number>).tiltRange);
  }
  saveSettings(settings);
  if (key === 'quality') {
    location.reload();
    return;
  }
  if (key === 'control' && settings.control === 'tilt') void input.tilt.enable();
  applySettings();
}

/** 按鈕位置編輯：直接拖曳畫面上的按鈕，選中的按鈕可以調大小 */
function editLayout(): void {
  hud.setWeaponIcons(profile.primary, profile.secondary);
  screens.hide();
  touchRoot.classList.remove('hidden');
  touchRoot.classList.add('editing');
  document.body.classList.add('touch');
  const bar = document.createElement('div');
  bar.id = 'layout-bar';
  bar.innerHTML = '拖曳按鈕調整位置　大小 <input type="range" min="0.6" max="1.6" step="0.05" value="1" /> <button class="btn small">恢復預設</button> <button class="btn small primary">完成</button>';
  document.body.appendChild(bar);
  const slider = bar.querySelector('input')!;
  const [resetBtn, doneBtn] = Array.from(bar.querySelectorAll('button'));
  let sel: HTMLElement | null = null;
  let drag: { id: string; el: HTMLElement; pid: number } | null = null;
  const ensure = (el: HTMLElement): void => {
    if (settings.layout[el.id]) return;
    const r = el.getBoundingClientRect();
    settings.layout[el.id] = { x: ((r.left + r.width / 2) / innerWidth) * 100, y: ((r.top + r.height / 2) / innerHeight) * 100, s: 1 };
  };
  const select = (el: HTMLElement | null): void => {
    sel?.classList.remove('sel');
    sel = el;
    if (!el) return;
    el.classList.add('sel');
    slider.value = String(settings.layout[el.id]?.s ?? 1);
  };
  const down = (e: PointerEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(LAYOUT_IDS.map((i) => '#' + i).join(','));
    e.stopPropagation();
    e.preventDefault();
    if (!el) return select(null);
    ensure(el);
    select(el);
    drag = { id: el.id, el, pid: e.pointerId };
  };
  const move = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.stopPropagation();
    const p = settings.layout[drag.id];
    p.x = Math.max(4, Math.min(96, (e.clientX / innerWidth) * 100));
    p.y = Math.max(6, Math.min(94, (e.clientY / innerHeight) * 100));
    applyLayout(settings);
  };
  const up = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pid) drag = null;
    e.stopPropagation();
  };
  touchRoot.addEventListener('pointerdown', down, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  slider.addEventListener('input', () => {
    if (!sel) return;
    settings.layout[sel.id].s = Number(slider.value);
    applyLayout(settings);
  });
  resetBtn.addEventListener('click', () => {
    settings.layout = {};
    applyLayout(settings);
    select(null);
  });
  doneBtn.addEventListener('click', () => {
    touchRoot.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    select(null);
    bar.remove();
    touchRoot.classList.remove('editing');
    if (!race || resultsShown) touchRoot.classList.add('hidden');
    if (!race) document.body.classList.toggle('touch', input.touchMode);
    saveSettings(settings);
    screens.settingsPage();
  });
}

input.bindTouch(touchRoot);
input.onPause = () => {
  if (race && !resultsShown) setPaused(!paused);
};
input.onReset = () => {
  if (race && !paused && race.state === 'racing' && !race.player.dead) race.resetToTrack(race.player);
};
document.getElementById('btn-pause')!.addEventListener('click', () => setPaused(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && race && !paused && !resultsShown) setPaused(true);
});
window.addEventListener('resize', () => view.resize());
window.addEventListener('pointerdown', (e) => {
  // 瀏覽器要求使用者互動後才能出聲：第一次點擊時啟動音訊與選單音樂
  audio.init();
  if (!race) audio.setMusic('menu');
  if (e.pointerType === 'touch' && race && !input.touchMode) input.touchMode = true;
});
window.addEventListener('keydown', () => audio.init(), { once: true });
// iPhone 只認點擊結束（touchend / click）才算可以出聲的操作
const unlockAudio = (): void => {
  audio.init();
  if (!race && screens.current !== 'settings') audio.setMusic('menu');
};
window.addEventListener('touchend', unlockAudio, { passive: true });
window.addEventListener('click', unlockAudio);

function finishRace(r: Race): void {
  const p = r.player;
  const rank = p.rank;
  const payout = PAYOUT[rank - 1] ?? 0;
  const killCash = p.kills * KILL_REWARD;
  const missions = r.missions.map((m) => ({ text: m.text, reward: m.reward, done: m.done(p, rank) }));
  const missionCash = missions.reduce((a, m) => a + (m.done ? m.reward : 0), 0);
  const best = p.lapTimes.length ? Math.min(...p.lapTimes) : 0;
  const summary: Summary = { rank, payout, killCash, streakCash, missionCash, total: payout + killCash + streakCash + missionCash, bestLap: best, missions };
  profile.cash += summary.total;
  profile.races++;
  if (rank === 1) profile.wins++;
  const id = r.track.def.id;
  if (best > 0 && (!profile.bestLaps[id] || best < profile.bestLaps[id])) profile.bestLaps[id] = best;
  saveProfile(profile);
  resultsShown = true;
  input.capture = false;
  hud.hide();
  touchRoot.classList.add('hidden');
  audio.setMusic('menu');
  screens.results(r, summary, !!online);
}

let last = performance.now();
let touchShown = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const real = Math.min(0.05, (now - last) / 1000);
  last = now;
  let dt = real;
  if (slowT > 0) {
    slowT -= real;
    dt = real * 0.25;
  }

  // 線上比賽不會暫停（開著選單時車子放開油門繼續跑）
  if (race && (!paused || online)) {
    if (online) dt = real;
    const inp = paused ? NO_INPUT : input.read();
    online?.applyRemote(now);
    // 幀率偏低時拆成兩小步，維持物理穩定
    const steps = dt > 1 / 45 ? 2 : 1;
    for (let i = 0; i < steps; i++) race.step(dt / steps, inp);
    online?.sendState(now);
    const p = race.player;
    for (const e of race.events) {
      view.onEvent(e, race);
      audio.onEvent(e, race);
      hud.onEvent(e, race);
      if (e.t === 'kill' && (e.killer === p || e.victim === p) && !resultsShown) {
        slowT = 0.12;
        if (e.killer === p && e.streak > 1) streakCash += (e.streak - 1) * STREAK_BONUS;
      }
      if (e.t === 'lap' && e.k === p && race.mode === 'race' && e.lap === race.track.laps - 1) audio.setMusicRush(true);
      if (e.t === 'elim' && race.aliveCount <= 3) audio.setMusicRush(true);
    }
    race.events.length = 0;
    view.update(dt, race, input.lookBack && !resultsShown);
    if (!resultsShown) {
      hud.update(race, view, real);
      if (race.state === 'finished') {
        resultsTimer += real;
        if (resultsTimer > 2.8) finishRace(race);
      }
    }
    if (input.touchMode !== touchShown) {
      touchShown = input.touchMode;
      setTouchUI(touchShown);
    }
  } else if (!race && ready) {
    view.updateMenuCam(real);
  }
  if (!race && bgRace) {
    if (!online) bgRace = null;
    else {
      online.applyRemote(now);
      bgRace.step(real, NO_INPUT);
      bgRace.events.length = 0;
      online.sendState(now);
      const r = bgRace;
      if (r.mode === 'elim' ? r.aliveCount <= 1 : r.karts.every((k) => k.finished || k.out)) {
        bgRace = null;
        online.backToLobby();
      }
    }
  }
  audio.frame(race, !!race && !paused && !resultsShown);
  if (ready) view.render();
}

screens.menu(true);
requestAnimationFrame(frame);

// 邀請連結 ?room=CODE：載入完成後直接打開加入房間的畫面
const inviteCode = cleanCode(new URLSearchParams(location.search).get('room') ?? '');

// 先載入模型再建立場景；個別模型載入失敗時會自動改用內建幾何
void loadModels([...CAR_MODELS, ...LANDMARK_MODELS, ...KART_MODELS, ...DEBRIS_MODELS, ...PROP_MODELS], (f) => screens.loadProgress(f)).then(() => {
  view.setTrack(track);
  ready = true;
  if (screens.current === 'menu') {
    if (inviteCode.length >= 4) openOnline('', inviteCode);
    else screens.menu();
  }
});

// 方便除錯與之後的自動化測試
(window as unknown as Record<string, unknown>).__game = { get race() { return race; }, profile, view, input, startRace, audio, screens, get track() { return track; }, get online() { return online; } };
