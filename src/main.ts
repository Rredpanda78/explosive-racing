import './ui/style.css';
import { GameAudio } from './audio';
import { KILL_REWARD, PAYOUT, STREAK_BONUS } from './game/config';
import { Race, type RaceMode } from './game/race';
import { loadProfile, saveProfile } from './game/save';
import { Track, TRACKS } from './game/track';
import { Input } from './input';
import { CAR_MODELS, DEBRIS_MODELS, KART_MODELS, loadModels, PROP_MODELS } from './render/assets';
import { GameView } from './render/view';
import { Hud } from './ui/hud';
import { Screens, type Summary } from './ui/screens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const touchRoot = document.getElementById('touch')!;
const coarse = window.matchMedia('(pointer: coarse)').matches;

const profile = loadProfile();
let trackIndex = Math.max(0, TRACKS.findIndex((t) => t.id === profile.track));
let track = new Track(TRACKS[trackIndex]);
/** 選單上顯示的地圖清單（長度要先把賽道算出來才知道） */
const trackList = TRACKS.map((def) => ({ name: def.name, desc: def.desc, laps: def.laps, length: Math.round(new Track(def).length) }));
const view = new GameView(canvas, coarse);
const input = new Input();
const hud = new Hud(track);
const audio = new GameAudio();

let race: Race | null = null;
let mode: RaceMode = 'race';
let ready = false;
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

function startRace(m?: RaceMode): void {
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
  race = new Race(track, profile, mode);
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
  if (p) screens.pause(audio.muted, hud.missionHtml(race));
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
});

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
  screens.results(r, summary);
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

  if (race && !paused) {
    const inp = input.read();
    // 幀率偏低時拆成兩小步，維持物理穩定
    const steps = dt > 1 / 45 ? 2 : 1;
    for (let i = 0; i < steps; i++) race.step(dt / steps, inp);
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
  audio.frame(race, !!race && !paused && !resultsShown);
  if (ready) view.render();
}

screens.menu(true);
requestAnimationFrame(frame);

// 先載入模型再建立場景；個別模型載入失敗時會自動改用內建幾何
void loadModels([...CAR_MODELS, ...KART_MODELS, ...DEBRIS_MODELS, ...PROP_MODELS]).then(() => {
  view.setTrack(track);
  ready = true;
  if (screens.current === 'menu') screens.menu();
});

// 方便除錯與之後的自動化測試
(window as unknown as Record<string, unknown>).__game = { get race() { return race; }, profile, view, input, startRace, audio, get track() { return track; } };
