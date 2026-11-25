// Works out which WebSocket URL(s) the bot should connect to.
//
// Current Deriv Options API (https://developers.deriv.com/docs/options/):
//   - Public market data, no login:  wss://api.derivws.com/trading/v1/options/ws/public
//   - Trading: REST call with a Personal Access Token + your App ID returns a
//     one-time WebSocket URL (wss://.../ws/demo?otp=... or .../ws/real?otp=...).
//     The OTP is valid for 120 seconds and can be used once.
//
// Legacy API (wss://ws.derivws.com/websockets/v3?app_id=...) is kept as an
// option (DERIV_API=legacy) but Deriv now rejects it with HTTP 520 for many users.

export const LEGACY_HOSTS = ['ws.derivws.com', 'ws.binaryws.com'];

const restBase = (cfg) => `https://${cfg.apiHost}/trading/v1/options`;
export const publicWsUrl = (cfg) => `wss://${cfg.apiHost}/trading/v1/options/ws/public`;

async function rest(cfg, method, path, fetchImpl = fetch) {
  const url = `${restBase(cfg)}${path}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Deriv-App-ID': cfg.appId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const cause = err.cause ?? err;
    throw new Error(`${method} ${path} failed: ${cause.code || cause.name}: ${cause.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    const hint =
      res.status === 401 || res.status === 403
        ? ' (check DERIV_API_TOKEN and DERIV_APP_ID, and that the token has the Trade scope)'
        : '';
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${msg}${hint}`);
  }
  return body;
}

/** Depth-first search for the first value matching a predicate. */
function findValue(obj, pred, depth = 0) {
  if (depth > 6 || obj == null) return undefined;
  if (pred(obj)) return obj;
  if (typeof obj !== 'object') return undefined;
  for (const v of Object.values(obj)) {
    const hit = findValue(v, pred, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Normalise the account list; the exact response shape isn't documented publicly. */
export function parseAccounts(body) {
  const list = findValue(body, (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') ?? [];
  return list.map((a) => {
    const id = a.account_id ?? a.accountId ?? a.loginid ?? a.id;
    const kind = String(a.account_type ?? a.type ?? a.environment ?? a.mode ?? '').toLowerCase();
    const isVirtual =
      a.is_virtual === 1 || a.is_virtual === true || kind.includes('demo') || kind.includes('virtual') ||
      /^(VRT|DOT|VR)/i.test(String(id));
    return { id: String(id), isVirtual, currency: a.currency, balance: a.balance, raw: a };
  });
}

export async function listAccounts(cfg, fetchImpl) {
  const body = await rest(cfg, 'GET', '/accounts', fetchImpl);
  const accounts = parseAccounts(body);
  if (!accounts.length || accounts.some((a) => a.id === 'undefined')) {
    throw new Error(`Could not read the account list from Deriv. Response: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return accounts;
}

export async function getOtpUrl(cfg, accountId, fetchImpl) {
  const body = await rest(cfg, 'POST', `/accounts/${encodeURIComponent(accountId)}/otp`, fetchImpl);
  const url = findValue(body, (v) => typeof v === 'string' && /^wss?:\/\//.test(v));
  if (!url) {
    const shape = JSON.stringify(body, (k, v) => (typeof v === 'string' && v.length > 12 ? '<redacted>' : v));
    throw new Error(`Deriv did not return a WebSocket URL for the OTP request. Response shape: ${shape.slice(0, 500)}`);
  }
  return url;
}

/**
 * Decide where to connect.
 * Returns { urls, account, needsAuthorize } where account is null for public/paper connections.
 */
export async function resolveConnection(cfg, log, fetchImpl) {
  if (cfg.api === 'legacy') {
    return {
      urls: LEGACY_HOSTS.map((h) => `wss://${h}/websockets/v3?app_id=${cfg.appId}`),
      account: null,
      needsAuthorize: Boolean(cfg.apiToken),
    };
  }

  if (cfg.paper) {
    return { urls: [publicWsUrl(cfg)], account: null, needsAuthorize: false };
  }

  const accounts = await listAccounts(cfg, fetchImpl);
  log.info(`Accounts: ${accounts.map((a) => `${a.id} (${a.isVirtual ? 'DEMO' : 'REAL'})`).join(', ')}`);
  const account = cfg.accountId
    ? accounts.find((a) => a.id === cfg.accountId)
    : accounts.find((a) => a.isVirtual);
  if (!account) {
    throw new Error(
      cfg.accountId
        ? `Account ${cfg.accountId} not found for this token.`
        : 'No demo account found for this token. Set DERIV_ACCOUNT_ID to choose an account.',
    );
  }
  if (!account.isVirtual && !cfg.allowRealAccount) {
    throw new Error(`Refusing to trade REAL account ${account.id}. Use a demo account, or set ALLOW_REAL_ACCOUNT=true.`);
  }

  const url = await getOtpUrl(cfg, account.id, fetchImpl);
  // The OTP URL's path says which kind of account it opens; trust it over our guess.
  if (/\/ws\/real\b/.test(url) && !cfg.allowRealAccount) {
    throw new Error(`Deriv returned a REAL-money session for ${account.id}. Refusing (set ALLOW_REAL_ACCOUNT=true to allow).`);
  }
  if (/\/ws\/demo\b/.test(url)) account.isVirtual = true;
  return { urls: [url], account, needsAuthorize: false };
}
