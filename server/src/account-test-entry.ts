/**
 * 只給本機測試帳號用的 Worker（wrangler.account-test.toml，名稱 racing-account-test；不部署）：
 * POST /account → handleAccount。只收 localhost 的 Origin（槽位 dev），另外收 TEST_PROD_ORIGIN（測 prod 槽位分開）。
 * GET /bench = 算幾次 PBKDF2 看時間（本機的時鐘不一定會走）。
 * cd server && npx wrangler dev -c wrangler.account-test.toml --port 8790，再 node test/account.cjs
 */
import { Account, Limiter, handleAccount, hashPw, PBKDF2_ITER, randHex, type AccountEnv } from './account';

export { Account, Limiter };

const DEV_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
/** 假的「正式網頁」：測試 prod 槽位跟 dev 分開 */
const TEST_PROD_ORIGIN = 'https://racing-prod.invalid';

export default {
  async fetch(req: Request, env: AccountEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/bench') {
      const n = 5;
      const t0 = Date.now();
      const p0 = performance.now();
      for (let i = 0; i < n; i++) await hashPw('bench-password', randHex(16));
      return Response.json({ iter: PBKDF2_ITER, n, dateMs: (Date.now() - t0) / n, perfMs: (performance.now() - p0) / n });
    }
    if (url.pathname !== '/account') return new Response('not found', { status: 404 });
    const origin = req.headers.get('Origin') ?? '';
    if (!DEV_RE.test(origin) && origin !== TEST_PROD_ORIGIN) return new Response('forbidden', { status: 403 });
    return handleAccount(req, env, origin);
  },
} satisfies ExportedHandler<AccountEnv>;
