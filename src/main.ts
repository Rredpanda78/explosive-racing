import './ui/style.css';
import { GameAudio } from './audio';
import { KILL_REWARD, PAYOUT } from './game/config';
import { Race } from './game/race';
import { loadProfile, saveProfile } from './game/save';
import { Track, TRACKS } from './game/track';
import { Input } from './input';
import { DEBRIS_MODELS, KART_MODELS, loadModels, PROP_MODELS } from './render/assets';
import { GameView } from './render/view';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const touchRoot = document.getElementById('touch')!;
const coarse = window.matchMedia('(pointer: coarse)').matches;

const track = new Track(TRACKS[0]);
const view = new GameView(canvas, coarse);
const profile = loadProfile();
const input = new Input();
const hud = new Hud(track);
const audio = new GameAudio();

let race: Race | null = null;
let ready = false;
let paused = false;
let resultsTimer = 0;
let resultsShown = false;
/** 擊毀瞬間的短暫慢動作（以真實時間計） */
let slowT = 0;

function setTouchUI(on: boolean): void {
  document.body.classList.toggle('touch', on);
  touchRoot.classList.toggle('hidden', !on || !race || resultsShown);
}

function startRace(): void {
  if (!ready) return;
  audio.init();
  audio.setMusic('race');
  audio.setMusicRush(false);
  if (coarse) {
    // 手機：嘗試全螢幕並鎖定橫向（不支援就略過）
    const el = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    el.requestFullscreen?.().then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
  }
  race = new Race(track, profile);
  view.setRace(race);
  hud.show(race);
  screens.hide();
  paused = false;
  resultsTimer = 0;
  resultsShown = false;
  slowT = 0;
  input.clear();
  input.capture = true;
  if (coarse) input.touchMode = true;
  setTouchUI(input.touchMode);
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
  if (p) screens.pause(audio.muted);
  else {
    screens.hide();
    input.clear();
  }
}

const screens = new Screens(profile, {
  start: startRace,
  resume: () => setPaused(false),
  restart: startRace,
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
  const reward = (PAYOUT[rank - 1] ?? 0) + p.kills * KILL_REWARD;
  const best = p.lapTimes.length ? Math.min(...p.lapTimes) : 0;
  profile.cash += reward;
  profile.races++;
  if (rank === 1) profile.wins++;
  if (best > 0 && (profile.bestLap <= 0 || best < profile.bestLap)) profile.bestLap = best;
  saveProfile(profile);
  resultsShown = true;
  input.capture = false;
  hud.hide();
  touchRoot.classList.add('hidden');
  audio.setMusic('menu');
  screens.results(r, rank, reward, best);
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
      if (e.t === 'kill' && (e.killer === p || e.victim === p) && !resultsShown) slowT = 0.11;
      if (e.t === 'lap' && e.k === p && e.lap === race.track.laps - 1) audio.setMusicRush(true);
    }
    race.events.length = 0;
    view.update(dt, race, input.lookBack && !resultsShown);
    if (!resultsShown) {
      hud.update(race, view);
      if (race.state === 'finished') {
        resultsTimer += real;
        if (resultsTimer > 2.6) finishRace(race);
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
void loadModels([...KART_MODELS, ...DEBRIS_MODELS, ...PROP_MODELS]).then(() => {
  view.setTrack(track);
  ready = true;
  if (screens.current === 'menu') screens.menu();
});

// 方便除錯與之後的自動化測試
(window as unknown as Record<string, unknown>).__game = { get race() { return race; }, profile, view, input, startRace, audio };
