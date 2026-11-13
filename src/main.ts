import './ui/style.css';
import { GameAudio } from './audio';
import { KILL_REWARD, PAYOUT, STREAK_BONUS } from './game/config';
import { emptyInput } from './game/kart';
import type { NetRacer, OnlineSetup } from './game/net';
import { Race, type RaceMode } from './game/race';
import type { OnlineSession, StartMsg } from './net/online';
import { cleanCode, ERR_TEXT, fetchRooms, newRoomCode } from './net/room';
import { loadProfile, saveProfile } from './game/save';
import { AccountClient, SIGNUP_GIFT } from './net/account';
import { Track, TRACKS } from './game/track';
import { Input } from './input';
import { setupMobileViewport } from './mobile';
import { CAR_IDS } from './game/cars';
import { loadModels, takeMissing } from './render/assets';
import { carsLoaded, loadCars, prefetchTracks, trackModels } from './render/preload';
import { GameView } from './render/view';
import { Haptics } from './haptics';
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
// 其他車的引擎聲以追車鏡頭當作聽者（方位、距離、都卜勒）
audio.camera = view.camera;
const haptics = new Haptics();
// 沒有後製（低畫質、手機中畫質）時，N2O 的速度感改用 CSS 的簡易版
document.body.classList.toggle('fx-lite', !view.postFx);
let race: Race | null = null;
/** 套用設定裡不需要重新載入的部分 */
function applySettings(): void {
  view.shakeMul = settings.shake;
  haptics.enabled = settings.vibrate && coarse;
  audio.setVolumes(settings.music, settings.sfx);
  if (audio.musicStyle !== settings.musicStyle) audio.setStyle(settings.musicStyle);
  audio.setEngineStyle(settings.engineSound);
  audio.setWeaponPack(settings.weaponSound);
  hud.dmgNumbers = settings.dmgNumbers;
  hud.showInfo = settings.netInfo;
  input.setKeys(settings.keys);
  audio.setOtherEngines(settings.otherEngines);
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
    name: playerName() || acct.name || '車手', car: profile.kart, livery: profile.livery?.[profile.kart] ?? 0,
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
/** 擊毀瞬間的頓格：模擬完全停住幾十毫秒（只有單機；線上比賽絕不暫停模擬） */
let freezeT = 0;
/** 這場靠連續擊毀多賺的獎金 */
let streakCash = 0;

function setTouchUI(on: boolean): void {
  document.body.classList.toggle('touch', on);
  touchRoot.classList.toggle('hidden', !on || !race || resultsShown);
}

/** 等場景與車款模型都載完才開賽（車子在選單出現後就在背景載入，通常按下開始時早就載好了） */
let waitingAssets = false;
function startRace(m?: RaceMode, seed?: number, setup?: OnlineSetup): void {
  if (!ready) return;
  if (sceneTrack !== track || !carsLoaded(CAR_IDS)) {
    if (waitingAssets) return;
    waitingAssets = true;
    if (!setup && screens.current === 'menu') {
      screens.loadProgress(0);
      screens.menu(true);
    }
    const t = track;
    void Promise.all([sceneTrack === t || buildScene(t), loadCars(CAR_IDS, (f) => screens.loadProgress(f))]).then(() => {
      waitingAssets = false;
      startRace(m, seed, setup);
    });
    return;
  }
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
  // 線上比賽：角落顯示延遲與直連人數
  const net = setup ? online : null;
  hud.netSummary = net ? () => net.summary() : null;
  race.player.autoMini = settings.autoMini;
  race.player.driftAssist = settings.driftAssist;
  view.setRace(race);
  hud.show(race);
  screens.hide();
  paused = false;
  resultsTimer = 0;
  resultsShown = false;
  slowT = 0;
  freezeT = 0;
  streakCash = 0;
  input.clear();
  input.capture = true;
  if (coarse) input.touchMode = true;
  setTouchUI(input.touchMode);
}

/** 建場景的順序號：連續換地圖時，只有最後一次載完的才建場景 */
let sceneSeq = 0;
/** 目前畫面上已經建好的地圖場景 */
let sceneTrack: Track | null = null;
/**
 * 先載入這張地圖要用的模型再建場景。建的時候發現還缺模型（例如新賽道用了 preload.ts 沒登記的地標）
 * 就補載再重建一次，所以新地圖不會少東西。回傳 false = 被之後的換地圖取代了。
 */
async function buildScene(t: Track, onProgress?: (f: number) => void): Promise<boolean> {
  const seq = ++sceneSeq;
  await loadModels(trackModels(t.def), onProgress);
  if (seq !== sceneSeq) return false;
  takeMissing();
  view.setTrack(t);
  sceneTrack = t;
  const miss = takeMissing();
  if (miss.length) {
    await loadModels(miss);
    if (seq !== sceneSeq) return false;
    view.setTrack(t);
  }
  return true;
}

/** 在主選單切換地圖：重建場景，背景會開始預覽新地圖（模型還沒載入時先顯示載入條） */
function selectTrack(i: number): void {
  if (race || !ready || i === trackIndex || !TRACKS[i]) return;
  trackIndex = i;
  track = new Track(TRACKS[i]);
  profile.track = TRACKS[i].id;
  saveProfile(profile);
  hud.setTrack(track);
  screens.loadProgress(0);
  screens.menu(true);
  // 模型都已載入時只經過 microtask 就建好（畫面不會閃一下載入條）
  void buildScene(track, (f) => screens.loadProgress(f)).then((ok) => {
    if (ok && screens.current === 'menu') screens.menu();
  });
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

/** 線上對戰與帳號面板的程式碼用到才下載（不擋選單出現；Vite 會切成獨立、檔名含雜湊的檔案） */
const loadOnline = () => import('./net/online');
const loadAccountPanel = () => import('./ui/accountPanel');

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
  previewSound: (k) => (k === 'engine' ? audio.previewEngine() : audio.previewWeapons()),
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
  account: () => void loadAccountPanel().then((m) => m.openAccountPanel(acct, () => { if (screens.current === 'menu' || screens.current === 'none') screens.menu(!ready); })),
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
    else if (key === 'pub') online.setCfg({ public: val === '1' });
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

// ---------------- 帳號與雲端存檔 ----------------
const acct = new AccountClient();
// 比賽中、線上房間裡不要換掉進度（比賽結束會用記憶體裡的舊進度蓋回去）
acct.canApply = () => !race && !online && !bgRace && screens.current === 'menu';
acct.onConflict = (local, cloud) => loadAccountPanel().then((m) => m.openConflictDialog(local, cloud));
acct.onRegistered = () => {
  // 新帳號禮：加進這台的進度（接著會同步上雲端）
  profile.cash += SIGNUP_GIFT;
  saveProfile(profile);
  if (screens.current === 'menu') screens.menu(!ready);
};
acct.onRemoteSave = () => {
  // 換成雲端的進度：profile 是跟畫面共用的同一個物件，直接把內容換掉
  Object.assign(profile, loadProfile());
  const i = Math.max(0, TRACKS.findIndex((t) => t.id === profile.track));
  if (i !== trackIndex && ready) selectTrack(i);
  else if (screens.current === 'menu') screens.menu(!ready);
};
acct.onStatus = () => {
  screens.accountLabel = acct.loggedIn ? acct.name : '';
  if (screens.current === 'menu') screens.menu(!ready);
};
screens.accountLabel = acct.loggedIn ? acct.name : '';
acct.start();

// ---------------- 線上對戰 ----------------

function openOnline(msg = '', code = ''): void {
  screens.onlineMenu(playerName() || '車手' + Math.floor(10 + Math.random() * 90), msg, code);
  pollRooms();
  // 連線的程式先在背景下載好，按下開房／加入時就不用等
  void loadOnline();
}

/** 公開房間列表：開著線上對戰畫面時每 4 秒更新一次 */
let roomPoll = 0;
function pollRooms(): void {
  window.clearTimeout(roomPoll);
  if (screens.current !== 'online') return;
  void fetchRooms().then((list) => {
    if (screens.current !== 'online') return;
    screens.roomList(list);
    roomPoll = window.setTimeout(pollRooms, 4000);
  });
}

/** 進房間的順序號：連點兩次只開最後一個 */
let roomSeq = 0;
function enterRoom(code: string, create: boolean): void {
  const seq = ++roomSeq;
  void loadOnline().then(({ OnlineSession }) => {
    if (seq === roomSeq) openRoom(new OnlineSession(myRacer, { track: trackIndex, mode: 'race', aiFill: true, difficulty: profile.difficulty, public: true }), code, create);
  });
}

function openRoom(s: OnlineSession, code: string, create: boolean): void {
  online?.leave();
  online = s;
  s.onChange = () => {
    if (online !== s) return;
    if (!race && screens.current === 'room') screens.room(s);
    hud.netNote = s.reconnecting ? '連線中斷，重新連線中…' : '';
  };
  s.onLinks = () => {
    if (online === s && !race) screens.roomLinks(s);
  };
  s.onStart = (msg) => {
    if (online === s) startOnlineRace(s, msg);
  };
  s.onClosed = (code) => {
    if (online !== s) return;
    hud.netNote = '';
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
    hud.setTrack(track);
  }
  // 場景或車款模型還沒載入時，startRace 會等載完再開始
  startRace(msg.cfg.mode, msg.seed, s.setup(msg));
}

/** 比賽結束（或從車庫）回到房間 */
function backToRoom(): void {
  const s = online;
  if (!s) return toMenu();
  if (race) {
    // 房主：其他人還在跑就讓比賽在背景繼續（電腦車手、淘汰判定都在房主這裡）
    const r = race;
    // 自己還負責跑沒跑完的電腦車手，或（淘汰賽）房主要繼續判定淘汰
    const busy = r.mode === 'elim' ? r.aliveCount > 1 && (s.isHost || r.karts.some((k) => k.bot && !k.remote && !k.out))
      : r.karts.some((k) => k.bot && !k.remote && !k.finished && !k.out);
    bgRace = busy ? r : null;
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
// 視窗大小與轉向（含 iPhone Safari 轉向後放大卡住的修正）
setupMobileViewport(() => view.resize());
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
  // 頓格（單機）：這幾十毫秒模擬完全停住，之後才進入慢動作
  const frozen = freezeT > 0 && !online && !paused;
  if (frozen) {
    freezeT -= real;
    dt = 0;
  } else if (slowT > 0) {
    slowT -= real;
    dt = real * 0.25;
  }

  // 線上比賽不會暫停（開著選單時車子放開油門繼續跑）
  if (race && (!paused || online)) {
    if (online) dt = real;
    if (dt > 0) {
      const inp = paused ? NO_INPUT : input.read();
      online?.applyRemote(now);
      // 幀率偏低時拆成兩小步，維持物理穩定
      const steps = dt > 1 / 45 ? 2 : 1;
      for (let i = 0; i < steps; i++) race.step(dt / steps, inp);
      online?.sendState(now);
    }
    const p = race.player;
    for (const e of race.events) {
      view.onEvent(e, race);
      audio.onEvent(e, race);
      hud.onEvent(e, race);
      if (e.t === 'kill' && (e.killer === p || e.victim === p) && !resultsShown) {
        slowT = 0.12;
        // 擊毀／被擊毀的打擊感：單機頓格 0.05 秒；鏡頭往前一推（線上也有，只是模擬不停）
        if (!online) freezeT = 0.05;
        view.punch(e.victim === p ? 1.3 : 1);
        haptics.pulse(e.victim === p ? 70 : 35);
        if (e.killer === p && e.streak > 1) streakCash += (e.streak - 1) * STREAK_BONUS;
      }
      if (e.t === 'kart' && e.k === p && e.e === 'wall') haptics.pulse(22);
      if (e.t === 'dmg' && e.k === p && e.amount >= 15) haptics.pulse(30);
      if (e.t === 'lap' && e.k === p && race.mode === 'race' && e.lap === race.track.laps - 1) audio.setMusicRush(true);
      if (e.t === 'elim' && race.aliveCount <= 3) audio.setMusicRush(true);
    }
    race.events.length = 0;
    view.update(dt, race, input.lookBack && !resultsShown);
    if (dt > 0 && !paused) haptics.kerb(view.kerb);
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
  audio.frame(race, !!race && !paused && !resultsShown, race ? view.kerb : 0);
  if (ready) view.render();
}

screens.menu(true);
requestAnimationFrame(frame);

// 邀請連結 ?room=CODE：載入完成後直接打開加入房間的畫面
const inviteCode = cleanCode(new URLSearchParams(location.search).get('room') ?? '');

// 先載入這張地圖的模型再建立場景（個別模型載入失敗時會自動改用內建幾何）；
// 選單出現後才在背景載入車子（自己的車先），最後把其他地圖的模型抓進瀏覽器快取
void buildScene(track, (f) => screens.loadProgress(f)).then(() => {
  ready = true;
  performance.mark('menu-ready');
  if (screens.current === 'menu') {
    if (inviteCode.length >= 4) openOnline('', inviteCode);
    else screens.menu();
  }
  void loadCars([profile.kart])
    .then(() => loadCars(CAR_IDS))
    .then(() => {
      // 車庫、線上房間的車款圖要等模型載入才拍得出來
      if (screens.current === 'garage') screens.garage();
      else if (screens.current === 'room' && online) screens.room(online);
      return prefetchTracks(TRACKS);
    });
});

// 方便除錯與之後的自動化測試
(window as unknown as Record<string, unknown>).__game = { get race() { return race; }, profile, view, hud, input, startRace, audio, screens, get track() { return track; }, get online() { return online; } };
