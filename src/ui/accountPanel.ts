/**
 * 帳號面板（同步邏輯在 src/net/account.ts）：自己掛在 document.body、關掉就拿掉。
 * - 沒登入：登入／註冊／忘記密碼（用救援碼重設）
 * - 註冊、重設、重新產生救援碼之後：救援碼只顯示這一次（複製；勾「我已經存好了」才能按完成、才能關）
 * - 登入了：名稱、同步狀態、雲端存檔、立即同步、改密碼、重新產生救援碼、登出、登出所有裝置
 * openConflictDialog：雲端跟這台的進度不一樣時讓玩家選（AccountClient.onConflict 用）
 */
import './account.css';
import { SIGNUP_GIFT, type AccountClient, type AcctErr, type AcctStatus, type SaveSummary } from '../net/account';

const NAME_ERR: Record<string, string> = {
  len: '名稱要 3～20 個字',
  chars: '名稱只能用英文字母、數字和底線（_）',
  reserved: '這個名稱保留給官方使用，請換一個',
};
const PW_ERR: Record<string, string> = {
  len: '密碼要 8～64 個字',
  ctrl: '密碼裡不能有看不見的控制字元',
  same: '密碼不能跟名稱一樣',
  weak: '這個密碼太常見（或只重複同一個字），請換一個',
};
const STATUS_TEXT: Record<AcctStatus, string> = {
  guest: '未登入',
  syncing: '同步中…',
  synced: '已同步到雲端',
  offline: '暫時無法同步（稍後會自動重試）',
  conflict: '雲端和這台的進度不一樣，等你選擇要保留哪一份',
};

/** 錯誤代碼 → 給玩家看的字；ctx 決定 auth 的說法 */
export function errText(e: Pick<AcctErr, 'err' | 'why' | 'ms' | 'key'>, ctx: 'login' | 'reset' | 'token' = 'token'): string {
  switch (e.err) {
    case 'auth':
      return ctx === 'login' ? '名稱或密碼不對' : ctx === 'reset' ? '名稱或救援碼不對' : '登入已失效，請重新登入';
    case 'name':
      return NAME_ERR[e.why ?? ''] ?? '名稱格式不對';
    case 'weakpw':
      return PW_ERR[e.why ?? ''] ?? '這個密碼不能用，請換一個';
    case 'badpw':
      return '目前的密碼不對';
    case 'taken':
      return '這個名稱已經有人用了，請換一個';
    case 'locked':
      return `打錯太多次，暫時鎖住了：請 ${Math.max(1, Math.ceil((e.ms ?? 0) / 60_000))} 分鐘後再試`;
    case 'slow':
      return '操作太頻繁了，請稍等一下再試';
    case 'big':
      return '存檔太大，沒辦法上傳到雲端';
    case 'odd':
      return `存檔裡的數字不正常（${e.key ?? '資料'}），沒有上傳到雲端`;
    case 'save':
      return '存檔格式不對，沒有上傳到雲端';
    case 'conflict':
      return '雲端有比較新的進度';
    case 'bad':
    case 'method':
      return '送出的資料格式不對，請重新整理網頁再試';
    case 'op':
      return '伺服器不認得這個操作，請重新整理網頁再試';
    case 'later':
      return '伺服器暫時忙不過來，請稍後再試';
    case 'gone':
      return '伺服器還沒有開放帳號功能';
    case 'store':
      return '這台裝置沒辦法存資料（儲存空間滿了，或正在用私密瀏覽）';
    case 'net':
      return '連不上伺服器，請檢查網路';
    default:
      return '發生錯誤，請稍後再試';
  }
}

/** 同步狀態的一行字（主選單可以用） */
export function statusText(acct: AccountClient): string {
  const s = acct.status;
  if (s === 'guest') return acct.lastErr === 'auth' ? '登入已失效，請重新登入' : STATUS_TEXT.guest;
  if (s === 'offline' && acct.lastErr) return `${STATUS_TEXT.offline}：${errText({ err: acct.lastErr })}`;
  return STATUS_TEXT[s];
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
const sumText = (s: SaveSummary): string => `$${s.cash.toLocaleString('en-US')}・出賽 ${s.races}・冠軍 ${s.wins}・車款 ${s.karts} 台`;
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
  const title = el('h2', '', '帳號');
  title.id = 'acp-title';
  const x = el('button', 'acp-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', '關閉');
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
      if (!acct.loggedIn && acct.lastErr === 'auth') say('登入已失效（可能在別的裝置登出了所有裝置，或改了密碼），請重新登入', 'err');
    } else {
      paintInfo?.();
      if (syncMsg && acct.status !== 'syncing') say(acct.status === 'synced' ? '進度已同步' : statusText(acct), acct.status === 'offline' ? 'err' : 'ok');
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
    const tip = el('p', 'acp-tip', '帳號是選用的：不登入也能玩。登入後進度會存到雲端，換手機、換電腦都能接著玩。只要名稱和密碼，不收 email 或手機號碼。');
    const tabs = el('div', 'acp-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabBtns = (['login', 'reg', 'reset'] as const).map((m) => {
      const b = el('button', 'acp-tab', m === 'login' ? '登入' : m === 'reg' ? '註冊' : '忘記密碼');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => setMode(m));
      tabs.append(b);
      return [m, b] as const;
    });
    const form = el('form', 'acp-form');
    form.noValidate = true;
    const nameIn = input('text', 'username', '英文字母、數字、底線 3～20 字', 24);
    const rcIn = input('text', 'off', 'XXXXX-XXXXX-XXXXX-XXXXX', 40);
    rcIn.classList.add('acp-rc-input');
    rcIn.setAttribute('autocapitalize', 'characters');
    const pwIn = input('password', 'current-password', '8～64 個字', 128);
    const pw2In = input('password', 'new-password', '再輸入一次密碼', 128);
    const rcField = field('救援碼', rcIn);
    const pwField = field('密碼', pwIn);
    const pw2Field = field('再輸入一次', pw2In);
    const rule = el('p', 'acp-hint');
    const go = el('button', 'acp-btn primary wide', '登入');
    go.type = 'submit';
    form.append(field('名稱', nameIn), rcField, pwField, pw2Field, rule, go);

    const setMode = (m: typeof mode) => {
      mode = m;
      for (const [k, b] of tabBtns) b.setAttribute('aria-selected', String(k === m));
      rcField.hidden = m !== 'reset';
      pw2Field.hidden = m === 'login';
      (pwField.firstChild as HTMLElement).textContent = m === 'reset' ? '新的密碼' : '密碼';
      pwIn.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      go.textContent = m === 'login' ? '登入' : m === 'reg' ? '註冊' : '重設密碼並登入';
      rule.textContent =
        m === 'reg'
          ? '名稱：3～20 個英文字母、數字或底線，不分大小寫，只有你自己看得到。密碼：8～64 個字。註冊後會給你一組救援碼，忘記密碼時要靠它重設。'
          : m === 'reset'
            ? '輸入註冊時（或上次重新產生時）拿到的救援碼。重設後其他裝置都會登出，也會給你一組新的救援碼，舊的就不能用了。'
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
        if (mode === 'reg' && !NAME_RE.test(name)) return say(name.length < 3 || name.length > 20 ? NAME_ERR.len : NAME_ERR.chars, 'err');
        if (mode !== 'reg' && !NAME_RE.test(name)) return say(mode === 'reset' ? '名稱或救援碼不對' : '名稱或密碼不對', 'err');
        if (mode === 'reset' && rcIn.value.replace(/[\s-]/g, '').length !== 20) return say('救援碼是 20 個英文字母和數字（例：ABCDE-FGHJK-LMNPQ-RSTUV）', 'err');
        if (mode === 'login' && !pw) return say('請輸入密碼', 'err');
        if (mode !== 'login') {
          const w = localPwWhy(pw, name);
          if (w) return say(PW_ERR[w], 'err');
          if (pw !== pw2In.value) return say('兩次輸入的密碼不一樣', 'err');
        }
        say(mode === 'reg' ? '註冊中…' : '確認中…');
        if (mode === 'login') {
          const r = await acct.login(name, pw);
          if (!r.ok) return say(errText(r, 'login'), 'err');
          render();
          if (acct.status === 'syncing') saysyncing('登入成功，正在同步進度…');
          else say('登入成功', 'ok');
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
      who.replaceChildren('登入身分：', el('b', '', acct.name));
      st.textContent = `同步狀態：${statusText(acct)}`;
      st.dataset.s = acct.status;
      const s = acct.info?.save;
      cloud.textContent = acct.info ? (s ? `雲端存檔：${sumText(s.sum)}（${whenText(s.at)}）` : '雲端存檔：還沒有') : '雲端存檔：讀取中…';
      dev.textContent = acct.info ? `目前登入中的裝置：${acct.info.devices} 台` : '';
    };
    paintInfo();
    void acct.me().then(() => paintInfo?.());

    const syncBtn = button('立即同步', 'primary', () =>
      void run(syncBtn, async () => {
        say('同步中…');
        await acct.syncNow();
        await acct.me();
        paintInfo?.();
        if (!acct.loggedIn) return;
        if (acct.status === 'synced') say('已同步', 'ok');
        else if (acct.status === 'offline') say(statusText(acct), 'err');
        else say(statusText(acct));
      }),
    );

    // 改密碼
    const oldIn = input('password', 'current-password', '目前的密碼', 128);
    const newIn = input('password', 'new-password', '8～64 個字', 128);
    const new2In = input('password', 'new-password', '再輸入一次新密碼', 128);
    const pwGo = button('確定修改', 'primary wide', () =>
      void run(pwGo, async () => {
        const w = localPwWhy(newIn.value, acct.name);
        if (!oldIn.value) return say('請輸入目前的密碼', 'err');
        if (w) return say(PW_ERR[w], 'err');
        if (newIn.value !== new2In.value) return say('兩次輸入的新密碼不一樣', 'err');
        const r = await acct.changePassword(oldIn.value, newIn.value);
        if (!r.ok) return say(errText(r), 'err');
        oldIn.value = newIn.value = new2In.value = '';
        pwSec.close();
        say('密碼已修改，其他裝置都已登出（這台不用重新登入）', 'ok');
        await acct.me();
        paintInfo?.();
      }),
    );
    const pwSec = section('改密碼', [field('目前的密碼', oldIn), field('新的密碼', newIn), field('再輸入一次', new2In), pwGo]);

    // 重新產生救援碼
    const rcPw = input('password', 'current-password', '目前的密碼', 128);
    const rcGo = button('產生新的救援碼', 'primary wide', () =>
      void run(rcGo, async () => {
        if (!rcPw.value) return say('請輸入目前的密碼', 'err');
        const r = await acct.newRecoveryCode(rcPw.value);
        if (!r.ok) return say(errText(r), 'err');
        rcPw.value = '';
        showRc(r.rc, 'regen');
      }),
    );
    const rcSec = section('重新產生救援碼', [el('p', 'acp-hint', '產生新的救援碼之後，舊的就不能用了。'), field('密碼', rcPw), rcGo]);

    // 登出
    const out = button('登出', '', () =>
      void run(out, async () => {
        await acct.logout();
        render();
        say('已登出（這台的進度還在）', 'ok');
      }),
    );
    let sureTimer = 0;
    const all = button('登出所有裝置', 'danger', () => {
      if (!all.classList.contains('sure')) {
        all.classList.add('sure');
        all.textContent = '確定？再按一次';
        sureTimer = window.setTimeout(() => {
          all.classList.remove('sure');
          all.textContent = '登出所有裝置';
        }, 4000);
        return;
      }
      clearTimeout(sureTimer);
      void run(all, async () => {
        const r = await acct.logoutAll();
        if (!r.ok) {
          all.classList.remove('sure');
          all.textContent = '登出所有裝置';
          return say(errText(r), 'err');
        }
        render();
        say('所有裝置都已登出（包括這台；這台的進度還在）', 'ok');
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
    const h = el('h3', '', why === 'reg' ? '註冊成功！這是你的救援碼' : why === 'reset' ? '密碼已重設！這是新的救援碼' : '這是新的救援碼');
    h.style.margin = '0';
    const code = el('p', 'acp-code', rc);
    const copy = button('複製', '', () => {
      const done = () => say('已複製救援碼，記得存到安全的地方', 'ok');
      const manual = () => {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        sel?.removeAllRanges();
        sel?.addRange(range);
        say('沒辦法自動複製：救援碼已經選取，請自己複製或抄下來', 'err');
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(rc).then(done, manual);
      else manual();
    });
    const box = el('div', 'acp-rc-box');
    box.append(code, copy);
    const warn = el('p', 'acp-warn', '救援碼只會顯示這一次。忘記密碼時要用它才能重設密碼；弄丟了就沒辦法找回這個帳號（我們沒有你的 email 或手機）。請抄下來，或存到密碼管理器。');
    const extra: HTMLElement[] = [];
    if (why === 'reg') extra.push(el('p', 'acp-gift', `🎁 新帳號禮：已送你 $${SIGNUP_GIFT.toLocaleString('en-US')} 遊戲幣！`));
    if (why !== 'reg') extra.push(el('p', 'acp-hint', '舊的救援碼已經不能用了。'));
    if (why === 'reset') extra.push(el('p', 'acp-hint', '其他裝置都已經登出。'));
    const cb = el('input');
    cb.type = 'checkbox';
    const check = el('label', 'acp-check');
    check.append(cb, el('span', '', '我已經存好了'));
    const fin = button('完成', 'primary wide', () => {
      if (!cb.checked) return;
      locked = false;
      acct.hold = false;
      render();
      if (why !== 'regen') {
        saysyncing('正在同步進度…');
        void acct.syncNow();
      } else say('新的救援碼已經生效', 'ok');
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
    const title = el('h2', '', '要保留哪一份進度？');
    title.id = 'acp-cf-title';
    head.append(title);
    const more = cloud.races !== local.races ? (cloud.races > local.races ? 'cloud' : 'local') : cloud.cash !== local.cash ? (cloud.cash > local.cash ? 'cloud' : 'local') : null;
    const card = (k: 'cloud' | 'local', s: SaveSummary) => {
      const c = el('div', `acp-card${more === k ? ' more' : ''}`);
      if (more === k) c.append(el('span', 'acp-tag', '進度較多'));
      c.append(
        el('h3', '', k === 'cloud' ? '☁ 雲端' : '📱 這台裝置'),
        el('span', 'acp-cash', `$${s.cash.toLocaleString('en-US')}`),
        el('span', '', `出賽 ${s.races} 場・冠軍 ${s.wins} 次`),
        el('span', '', `擁有車款 ${s.karts} 台`),
      );
      if (s.at) c.append(el('small', '', `${whenText(s.at)} 存的`));
      return c;
    };
    const cards = el('div', 'acp-cards');
    cards.append(card('cloud', cloud), card('local', local));
    const done = (k: 'local' | 'cloud') => {
      root.remove();
      resolve(k);
    };
    const row = el('div', 'acp-row');
    row.append(button('用雲端的', more === 'local' ? '' : 'primary', () => done('cloud')), button('用這台的', more === 'local' ? 'primary' : '', () => done('local')));
    panel.append(
      head,
      el('p', 'acp-tip', '這個帳號在雲端的進度，和這台裝置上的不一樣。'),
      cards,
      el('p', 'acp-hint', '用雲端的：這台的進度會換成雲端那一份。用這台的：雲端那一份會被這台的進度蓋掉。沒選到的那一份會不見。'),
      row,
    );
    root.append(panel);
    trapKeys(root);
    document.body.append(root);
    queueMicrotask(() => (row.querySelector('.primary') as HTMLButtonElement | null)?.focus({ preventScroll: true }));
  });
}
