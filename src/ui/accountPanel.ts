/**
 * 帳號面板（同步邏輯在 src/net/account.ts）：自己掛在 document.body、關掉就拿掉。
 * - 沒登入：登入／註冊／忘記密碼（用救援碼重設）
 * - 註冊、重設、重新產生救援碼之後：救援碼只顯示這一次（複製；勾「我已經存好了」才能按完成、才能關）
 * - 登入了：名稱、同步狀態、雲端存檔、立即同步、改密碼、重新產生救援碼、登出、登出所有裝置
 * openConflictDialog：雲端跟這台的進度不一樣時讓玩家選（AccountClient.onConflict 用）
 */
import './account.css';
import { SIGNUP_GIFT, type AccountClient, type AcctErr, type SaveSummary } from '../net/account';
import { ta } from '../lang/account';

// 字串表在 src/lang/account.ts（中文、英文）

/** 錯誤代碼 → 給玩家看的字；ctx 決定 auth 的說法 */
export function errText(e: Pick<AcctErr, 'err' | 'why' | 'ms' | 'key'>, ctx: 'login' | 'reset' | 'token' = 'token'): string {
  switch (e.err) {
    case 'auth':
      return ctx === 'login' ? ta.authLogin : ctx === 'reset' ? ta.authReset : ta.authToken;
    case 'name':
      return ta.nameErr[e.why ?? ''] ?? ta.nameBad;
    case 'weakpw':
      return ta.pwErr[e.why ?? ''] ?? ta.pwBad;
    case 'badpw':
      return ta.badpw;
    case 'taken':
      return ta.taken;
    case 'locked':
      return ta.locked(Math.max(1, Math.ceil((e.ms ?? 0) / 60_000)));
    case 'slow':
      return ta.slow;
    case 'big':
      return ta.big;
    case 'odd':
      return ta.odd(e.key ?? ta.oddData);
    case 'save':
      return ta.saveBad;
    case 'conflict':
      return ta.conflict;
    case 'bad':
    case 'method':
      return ta.bad;
    case 'op':
      return ta.op;
    case 'later':
      return ta.later;
    case 'gone':
      return ta.gone;
    case 'store':
      return ta.store;
    case 'net':
      return ta.net;
    default:
      return ta.other;
  }
}

/** 同步狀態的一行字（主選單可以用） */
export function statusText(acct: AccountClient): string {
  const s = acct.status;
  if (s === 'guest') return acct.lastErr === 'auth' ? ta.authToken : ta.status.guest;
  if (s === 'offline' && acct.lastErr) return ta.statusErr(ta.status.offline, errText({ err: acct.lastErr }));
  return ta.status[s];
}

// ---------- 小工具 ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function button(text: string, cls: string, on: () => void): HTMLButtonElement {
  const b = el('button', `acp-btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', on);
  return b;
}
function input(type: 'text' | 'password', auto: string, ph: string, max: number): HTMLInputElement {
  const i = el('input');
  i.type = type;
  i.autocomplete = auto as AutoFill;
  i.placeholder = ph;
  i.maxLength = max;
  i.spellcheck = false;
  i.setAttribute('autocapitalize', 'off');
  i.setAttribute('autocorrect', 'off');
  return i;
}
function field(label: string, i: HTMLInputElement): HTMLLabelElement {
  const l = el('label', 'acp-field');
  l.append(el('span', '', label), i);
  return l;
}
const pad = (n: number) => String(n).padStart(2, '0');
function whenText(t: number): string {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const sumText = (s: SaveSummary): string => ta.sum(s.cash.toLocaleString('en-US'), s.races, s.wins, s.karts);
/** 鍵盤事件不要傳到遊戲（P、R、Esc 是暫停、重置） */
function trapKeys(root: HTMLElement): void {
  for (const ev of ['keydown', 'keyup', 'keypress']) root.addEventListener(ev, (e) => e.stopPropagation());
}
const NAME_RE = /^[A-Za-z0-9_]{3,20}$/;
/** 送出前先在這台檢查（伺服器也會檢查） */
function localPwWhy(pw: string, name: string): string | null {
  const n = Array.from(pw).length;
  if (n < 8 || n > 64) return 'len';
  if (name && pw.toLowerCase() === name.toLowerCase()) return 'same';
  return null;
}

// ---------- 帳號面板 ----------

export function openAccountPanel(acct: AccountClient, onClose: () => void): void {
  document.getElementById('acp-root')?.remove();
  const root = el('div', 'acp-overlay');
  root.id = 'acp-root';
  const panel = el('div', 'acp-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'acp-title');
  const title = el('h2', '', ta.title);
  title.id = 'acp-title';
  const x = el('button', 'acp-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', ta.close);
  const head = el('div', 'acp-head');
  head.append(title, x);
  const body = el('div');
  body.style.display = 'contents';
  const msg = el('p', 'acp-msg');
  msg.setAttribute('aria-live', 'polite');
  panel.append(head, body, msg);
  root.append(panel);
  trapKeys(root);
  document.body.append(root);

  /** 正在顯示救援碼：不能關 */
  let locked = false;
  let busy = false;
  let shownIn: boolean | null = null;
  let mode: 'login' | 'reg' | 'reset' = 'login';
  let paintInfo: (() => void) | null = null;
  /** 訊息是「正在同步」：同步有結果了就換掉 */
  let syncMsg = false;

  const say = (text: string, kind: 'err' | 'ok' | '' = '') => {
    syncMsg = false;
    msg.textContent = text;
    msg.className = `acp-msg${kind ? ' ' + kind : ''}`;
  };
  const saysyncing = (text: string) => {
    say(text, 'ok');
    syncMsg = true;
  };
  const close = () => {
    if (locked) return;
    unwatch();
    root.remove();
    onClose();
  };
  x.addEventListener('click', close);
  root.addEventListener('click', (e) => e.target === root && close());
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  const unwatch = acct.watch(() => {
    if (locked) return;
    if (acct.loggedIn !== shownIn) {
      render();
      if (!acct.loggedIn && acct.lastErr === 'auth') say(ta.kicked, 'err');
    } else {
      paintInfo?.();
      if (syncMsg && acct.status !== 'syncing') say(acct.status === 'synced' ? ta.synced : statusText(acct), acct.status === 'offline' ? 'err' : 'ok');
    }
  });
  /** 按鈕按下去到做完之間不能再按 */
  const run = async (b: HTMLButtonElement, f: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    b.disabled = true;
    try {
      await f();
    } finally {
      busy = false;
      b.disabled = false;
    }
  };

  const render = () => {
    shownIn = acct.loggedIn;
    paintInfo = null;
    x.hidden = false;
    body.replaceChildren(...(acct.loggedIn ? inView() : outView()));
    say('');
  };

  // ---------- 沒登入 ----------
  function outView(): HTMLElement[] {
    const tip = el('p', 'acp-tip', ta.tip);
    const tabs = el('div', 'acp-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabBtns = (['login', 'reg', 'reset'] as const).map((m) => {
      const b = el('button', 'acp-tab', m === 'login' ? ta.tabLogin : m === 'reg' ? ta.tabReg : ta.tabReset);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => setMode(m));
      tabs.append(b);
      return [m, b] as const;
    });
    const form = el('form', 'acp-form');
    form.noValidate = true;
    const nameIn = input('text', 'username', ta.namePh, 24);
    const rcIn = input('text', 'off', 'XXXXX-XXXXX-XXXXX-XXXXX', 40);
    rcIn.classList.add('acp-rc-input');
    rcIn.setAttribute('autocapitalize', 'characters');
    const pwIn = input('password', 'current-password', ta.pwPh, 128);
    const pw2In = input('password', 'new-password', ta.pw2Ph, 128);
    const rcField = field(ta.rc, rcIn);
    const pwField = field(ta.pw, pwIn);
    const pw2Field = field(ta.again, pw2In);
    const rule = el('p', 'acp-hint');
    const go = el('button', 'acp-btn primary wide', ta.goLogin);
    go.type = 'submit';
    form.append(field(ta.name, nameIn), rcField, pwField, pw2Field, rule, go);

    const setMode = (m: typeof mode) => {
      mode = m;
      for (const [k, b] of tabBtns) b.setAttribute('aria-selected', String(k === m));
      rcField.hidden = m !== 'reset';
      pw2Field.hidden = m === 'login';
      (pwField.firstChild as HTMLElement).textContent = m === 'reset' ? ta.newPw : ta.pw;
      pwIn.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      go.textContent = m === 'login' ? ta.goLogin : m === 'reg' ? ta.goReg : ta.goReset;
      rule.textContent =
        m === 'reg'
          ? ta.ruleReg
          : m === 'reset'
            ? ta.ruleReset
            : '';
      rule.hidden = m === 'login';
      say('');
    };
    setMode(mode);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void run(go, async () => {
        const name = nameIn.value.trim();
        const pw = pwIn.value;
        if (mode === 'reg' && !NAME_RE.test(name)) return say(name.length < 3 || name.length > 20 ? ta.nameErr.len : ta.nameErr.chars, 'err');
        if (mode !== 'reg' && !NAME_RE.test(name)) return say(mode === 'reset' ? ta.authReset : ta.authLogin, 'err');
        if (mode === 'reset' && rcIn.value.replace(/[\s-]/g, '').length !== 20) return say(ta.rcFormat, 'err');
        if (mode === 'login' && !pw) return say(ta.needPw, 'err');
        if (mode !== 'login') {
          const w = localPwWhy(pw, name);
          if (w) return say(ta.pwErr[w], 'err');
          if (pw !== pw2In.value) return say(ta.pwMismatch, 'err');
        }
        say(mode === 'reg' ? ta.registering : ta.checking);
        if (mode === 'login') {
          const r = await acct.login(name, pw);
          if (!r.ok) return say(errText(r, 'login'), 'err');
          render();
          if (acct.status === 'syncing') saysyncing(ta.loginSyncing);
          else say(ta.loginOk, 'ok');
          return;
        }
        acct.hold = true; // 救援碼還沒存好之前先不同步（不然選進度的視窗會蓋在上面）
        const r = mode === 'reg' ? await acct.register(name, pw) : await acct.reset(name, rcIn.value, pw);
        if (!r.ok) {
          acct.hold = false;
          return say(errText(r, mode === 'reset' ? 'reset' : 'login'), 'err');
        }
        pwIn.value = pw2In.value = rcIn.value = '';
        showRc(r.rc, mode === 'reg' ? 'reg' : 'reset');
      });
    });
    queueMicrotask(() => nameIn.focus({ preventScroll: true }));
    return [tip, tabs, form];
  }

  // ---------- 登入了 ----------
  function inView(): HTMLElement[] {
    const info = el('div', 'acp-info');
    const who = el('p');
    const st = el('p', 'acp-status');
    const cloud = el('p');
    const dev = el('p', 'acp-hint');
    info.append(who, st, cloud, dev);
    paintInfo = () => {
      who.replaceChildren(ta.who, el('b', '', acct.name));
      st.textContent = ta.syncState(statusText(acct));
      st.dataset.s = acct.status;
      const s = acct.info?.save;
      cloud.textContent = acct.info ? (s ? ta.cloudSave(sumText(s.sum), whenText(s.at)) : ta.cloudNone) : ta.cloudLoading;
      dev.textContent = acct.info ? ta.devices(acct.info.devices) : '';
    };
    paintInfo();
    void acct.me().then(() => paintInfo?.());

    const syncBtn = button(ta.syncNow, 'primary', () =>
      void run(syncBtn, async () => {
        say(ta.syncing);
        await acct.syncNow();
        await acct.me();
        paintInfo?.();
        if (!acct.loggedIn) return;
        if (acct.status === 'synced') say(ta.syncedShort, 'ok');
        else if (acct.status === 'offline') say(statusText(acct), 'err');
        else say(statusText(acct));
      }),
    );

    // 改密碼
    const oldIn = input('password', 'current-password', ta.curPw, 128);
    const newIn = input('password', 'new-password', ta.pwPh, 128);
    const new2In = input('password', 'new-password', ta.newPw2Ph, 128);
    const pwGo = button(ta.pwApply, 'primary wide', () =>
      void run(pwGo, async () => {
        const w = localPwWhy(newIn.value, acct.name);
        if (!oldIn.value) return say(ta.needCurPw, 'err');
        if (w) return say(ta.pwErr[w], 'err');
        if (newIn.value !== new2In.value) return say(ta.newPwMismatch, 'err');
        const r = await acct.changePassword(oldIn.value, newIn.value);
        if (!r.ok) return say(errText(r), 'err');
        oldIn.value = newIn.value = new2In.value = '';
        pwSec.close();
        say(ta.pwChanged, 'ok');
        await acct.me();
        paintInfo?.();
      }),
    );
    const pwSec = section(ta.changePw, [field(ta.curPw, oldIn), field(ta.newPw, newIn), field(ta.again, new2In), pwGo]);

    // 重新產生救援碼
    const rcPw = input('password', 'current-password', ta.curPw, 128);
    const rcGo = button(ta.newRc, 'primary wide', () =>
      void run(rcGo, async () => {
        if (!rcPw.value) return say(ta.needCurPw, 'err');
        const r = await acct.newRecoveryCode(rcPw.value);
        if (!r.ok) return say(errText(r), 'err');
        rcPw.value = '';
        showRc(r.rc, 'regen');
      }),
    );
    const rcSec = section(ta.regenRc, [el('p', 'acp-hint', ta.regenHint), field(ta.pw, rcPw), rcGo]);

    // 登出
    const out = button(ta.logout, '', () =>
      void run(out, async () => {
        await acct.logout();
        render();
        say(ta.loggedOut, 'ok');
      }),
    );
    let sureTimer = 0;
    const all = button(ta.logoutAll, 'danger', () => {
      if (!all.classList.contains('sure')) {
        all.classList.add('sure');
        all.textContent = ta.sure;
        sureTimer = window.setTimeout(() => {
          all.classList.remove('sure');
          all.textContent = ta.logoutAll;
        }, 4000);
        return;
      }
      clearTimeout(sureTimer);
      void run(all, async () => {
        const r = await acct.logoutAll();
        if (!r.ok) {
          all.classList.remove('sure');
          all.textContent = ta.logoutAll;
          return say(errText(r), 'err');
        }
        render();
        say(ta.loggedOutAll, 'ok');
      });
    });
    const outRow = el('div', 'acp-row acp-sec');
    outRow.append(out, all);
    const syncRow = el('div', 'acp-row');
    syncRow.append(syncBtn);
    return [info, syncRow, pwSec.el, rcSec.el, outRow];
  }

  /** 可以展開／收起的一段 */
  function section(label: string, kids: HTMLElement[]): { el: HTMLElement; close: () => void } {
    const sec = el('div', 'acp-sec');
    const t = el('button', 'acp-toggle', label);
    t.type = 'button';
    t.setAttribute('aria-expanded', 'false');
    const box = el('div', 'acp-form');
    box.hidden = true;
    box.append(...kids);
    const set = (open: boolean) => {
      box.hidden = !open;
      t.setAttribute('aria-expanded', String(open));
    };
    t.addEventListener('click', () => set(t.getAttribute('aria-expanded') !== 'true'));
    sec.append(t, box);
    return { el: sec, close: () => set(false) };
  }

  // ---------- 救援碼（只顯示這一次） ----------
  function showRc(rc: string, why: 'reg' | 'reset' | 'regen'): void {
    locked = true;
    paintInfo = null;
    x.hidden = true;
    const h = el('h3', '', why === 'reg' ? ta.rcReg : why === 'reset' ? ta.rcReset : ta.rcRegen);
    h.style.margin = '0';
    const code = el('p', 'acp-code', rc);
    const copy = button(ta.copy, '', () => {
      const done = () => say(ta.copiedRc, 'ok');
      const manual = () => {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        sel?.removeAllRanges();
        sel?.addRange(range);
        say(ta.copyFail, 'err');
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(rc).then(done, manual);
      else manual();
    });
    const box = el('div', 'acp-rc-box');
    box.append(code, copy);
    const warn = el('p', 'acp-warn', ta.rcWarn);
    const extra: HTMLElement[] = [];
    if (why === 'reg') extra.push(el('p', 'acp-gift', ta.gift(SIGNUP_GIFT.toLocaleString('en-US'))));
    if (why !== 'reg') extra.push(el('p', 'acp-hint', ta.oldRcDead));
    if (why === 'reset') extra.push(el('p', 'acp-hint', ta.othersOut));
    const cb = el('input');
    cb.type = 'checkbox';
    const check = el('label', 'acp-check');
    check.append(cb, el('span', '', ta.saved));
    const fin = button(ta.done, 'primary wide', () => {
      if (!cb.checked) return;
      locked = false;
      acct.hold = false;
      render();
      if (why !== 'regen') {
        saysyncing(ta.syncingProgress);
        void acct.syncNow();
      } else say(ta.rcActive, 'ok');
    });
    fin.disabled = true;
    cb.addEventListener('change', () => (fin.disabled = !cb.checked));
    body.replaceChildren(h, box, warn, ...extra, check, fin);
    say('');
    queueMicrotask(() => copy.focus({ preventScroll: true }));
  }

  render();
}

// ---------- 選進度 ----------

/** 雲端和這台的進度不一樣：讓玩家選（沒有「取消」：一定要選一個） */
export function openConflictDialog(local: SaveSummary, cloud: SaveSummary): Promise<'local' | 'cloud'> {
  return new Promise((resolve) => {
    const root = el('div', 'acp-overlay acp-top');
    const panel = el('div', 'acp-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'acp-cf-title');
    const head = el('div', 'acp-head');
    const title = el('h2', '', ta.cfTitle);
    title.id = 'acp-cf-title';
    head.append(title);
    const more = cloud.races !== local.races ? (cloud.races > local.races ? 'cloud' : 'local') : cloud.cash !== local.cash ? (cloud.cash > local.cash ? 'cloud' : 'local') : null;
    const card = (k: 'cloud' | 'local', s: SaveSummary) => {
      const c = el('div', `acp-card${more === k ? ' more' : ''}`);
      if (more === k) c.append(el('span', 'acp-tag', ta.cfMore));
      c.append(
        el('h3', '', k === 'cloud' ? ta.cfCloud : ta.cfLocal),
        el('span', 'acp-cash', `$${s.cash.toLocaleString('en-US')}`),
        el('span', '', ta.cfRaces(s.races, s.wins)),
        el('span', '', ta.cfKarts(s.karts)),
      );
      if (s.at) c.append(el('small', '', ta.cfWhen(whenText(s.at))));
      return c;
    };
    const cards = el('div', 'acp-cards');
    cards.append(card('cloud', cloud), card('local', local));
    const done = (k: 'local' | 'cloud') => {
      root.remove();
      resolve(k);
    };
    const row = el('div', 'acp-row');
    row.append(button(ta.cfUseCloud, more === 'local' ? '' : 'primary', () => done('cloud')), button(ta.cfUseLocal, more === 'local' ? 'primary' : '', () => done('local')));
    panel.append(
      head,
      el('p', 'acp-tip', ta.cfTip),
      cards,
      el('p', 'acp-hint', ta.cfHint),
      row,
    );
    root.append(panel);
    trapKeys(root);
    document.body.append(root);
    queueMicrotask(() => (row.querySelector('.primary') as HTMLButtonElement | null)?.focus({ preventScroll: true }));
  });
}
