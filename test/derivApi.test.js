import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnection, parseAccounts } from '../src/derivApi.js';
import { loadConfig, validateConfig } from '../src/config.js';

const quietLog = { info() {}, warn() {}, error() {} };

/** Fake fetch for the Options REST API; records calls. */
function fakeFetch({ accounts, otpUrl = 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc', status = 200 }) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, ...opts });
    const json = url.endsWith('/accounts') ? { data: accounts } : { data: { url: otpUrl } };
    return { ok: status < 400, status, text: async () => JSON.stringify(status < 400 ? json : { error: { message: 'bad token' } }) };
  };
  return { impl, calls };
}

const cfg = (env) => validateConfig(loadConfig(env));

test('paper mode uses the public websocket with no login', async () => {
  const r = await resolveConnection(cfg({}), quietLog);
  assert.deepEqual(r.urls, ['wss://api.derivws.com/trading/v1/options/ws/public']);
  assert.equal(r.account, null);
});

test('legacy mode uses the old v3 endpoints with app id 1089 by default', async () => {
  const r = await resolveConnection(cfg({ DERIV_API: 'legacy' }), quietLog);
  assert.match(r.urls[0], /ws\.derivws\.com\/websockets\/v3\?app_id=1089/);
});

test('live mode requires an app id', () => {
  assert.throws(() => cfg({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 't' }), /DERIV_APP_ID is required/);
});

test('live mode picks the demo account, sends PAT + App ID, and returns the OTP url', async () => {
  const { impl, calls } = fakeFetch({
    accounts: [
      { account_id: 'CR123', account_type: 'real', currency: 'USD' },
      { account_id: 'DOT456', account_type: 'demo', currency: 'USD', balance: 10000 },
    ],
  });
  const c = cfg({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 'pat_x', DERIV_APP_ID: 'app1' });
  const r = await resolveConnection(c, quietLog, impl);
  assert.equal(r.account.id, 'DOT456');
  assert.equal(r.account.isVirtual, true);
  assert.match(r.urls[0], /\/ws\/demo\?otp=abc/);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/trading\/v1\/options\/accounts\/DOT456\/otp$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer pat_x');
  assert.equal(calls[0].headers['Deriv-App-ID'], 'app1');
});

test('live mode refuses a real account unless allowed, even if Deriv returns a real session', async () => {
  const c = cfg({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 't', DERIV_APP_ID: 'a', DERIV_ACCOUNT_ID: 'CR123' });
  const accounts = [{ account_id: 'CR123', account_type: 'real' }];
  await assert.rejects(resolveConnection(c, quietLog, fakeFetch({ accounts }).impl), /Refusing to trade REAL/);

  const sneaky = [{ account_id: 'X1', account_type: 'demo' }];
  const realUrl = 'wss://api.derivws.com/trading/v1/options/ws/real?otp=z';
  const c2 = cfg({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 't', DERIV_APP_ID: 'a' });
  await assert.rejects(resolveConnection(c2, quietLog, fakeFetch({ accounts: sneaky, otpUrl: realUrl }).impl), /REAL-money session/);
});

test('REST errors are reported with status and a hint', async () => {
  const c = cfg({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 't', DERIV_APP_ID: 'a' });
  await assert.rejects(resolveConnection(c, quietLog, fakeFetch({ accounts: [], status: 401 }).impl), /HTTP 401: bad token.*Trade scope/);
});

test('parseAccounts handles common field names', () => {
  const [a, b] = parseAccounts({ accounts: [{ loginid: 'VRTC1', is_virtual: 1 }, { id: 'CR9' }] });
  assert.deepEqual([a.id, a.isVirtual, b.id, b.isVirtual], ['VRTC1', true, 'CR9', false]);
});
