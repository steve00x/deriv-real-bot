import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';

const env = { DERIV_APP_ID: 'app1', DERIV_API_TOKEN: 'pat', PAPER_TRADING: 'true' };

function fakeFetch() {
  return async (url) => {
    const json = url.endsWith('/accounts')
      ? { data: [{ account_id: 'DOT1', account_type: 'demo', currency: 'USD' }] }
      : { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=x' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
}

function fakeClient() {
  const sent = [];
  return {
    sent,
    connected: null,
    async connect(urls) {
      this.connected = urls;
    },
    close() {},
    async request(p) {
      sent.push(p);
      if (p.balance) return { balance: { balance: 10000, currency: 'USD' } };
      if (p.proposal) return { proposal: { payout: 1.95 } };
      return {};
    },
  };
}

test('check logs in, quotes a Rise and never buys (even if .env says paper)', async () => {
  const client = fakeClient();
  const r = await runCheck(env, { fetchImpl: fakeFetch(), client });
  assert.equal(r.ok, true);
  assert.equal(r.payout, 1.95);
  assert.match(client.connected[0], /\/ws\/demo\?otp=/);
  assert.ok(client.sent.some((p) => p.proposal && p.underlying_symbol === 'R_100'));
  assert.ok(!client.sent.some((p) => p.buy), 'must never buy');
});

test('check explains missing credentials', async () => {
  await assert.rejects(runCheck({}, { client: fakeClient() }), /DERIV_API_TOKEN is required/);
});
