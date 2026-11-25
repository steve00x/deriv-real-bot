import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DashboardState, startDashboard } from '../src/dashboard.js';
import { RiskManager } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';

function setup(env = {}) {
  const cfg = validateConfig(loadConfig(env));
  const risk = new RiskManager(cfg);
  const bot = new EventEmitter();
  bot.decimals = 2;
  bot.stopReason = null;
  bot.stop = (r) => {
    bot.stopReason = r;
    bot.emit('stopped', { reason: r, time: Date.now() });
  };
  const state = new DashboardState({ cfg, risk }).attach(bot);
  return { cfg, risk, bot, state };
}

/** Raw request so we can set any Host header. */
function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('state tracks prices, digits, trades and stop reason', () => {
  const { bot, risk, state } = setup({ CONTRACT: 'even_odd' });
  bot.emit('ready', { prices: [1.02, 1.03, 1.1], decimals: 2 });
  bot.emit('price', { price: 1.24, time: 1 });
  bot.emit('trade-open', { label: 'EVEN', stake: 1, payout: 1.95, time: 2 });
  assert.equal(state.snapshot().open.label, 'EVEN');
  risk.record(0.95);
  bot.emit('trade-close', { label: 'EVEN', profit: 0.95, won: true, entry: 1.1, exit: 1.24, digit: 4, time: 3 });
  state.addLog('error', 'something broke');
  bot.stop('test over');

  const s = state.snapshot();
  assert.equal(s.status, 'stopped');
  assert.equal(s.stopReason, 'test over');
  assert.equal(s.open, null);
  assert.equal(s.price.last, 1.24);
  assert.deepEqual(s.digits.counts.slice(0, 5), [1, 0, 1, 1, 1]); // digits 2, 3, 0, 4
  assert.equal(s.digits.even, 3);
  assert.equal(s.trades[0].cumulative, 0.95);
  assert.equal(s.risk.winRate, 1);
  assert.equal(s.config.contractName, 'Even/Odd');
  assert.equal(s.logs[0].level, 'error');
});

test('server serves the page and state, and only to localhost', async () => {
  const { bot, state } = setup();
  const d = await startDashboard({ state, bot, port: 3900 });
  try {
    const page = await request(d.port, { headers: { Host: `localhost:${d.port}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Deriv Bot Dashboard<\/title>/);
    const api = await request(d.port, { path: '/api/state', headers: { Host: `127.0.0.1:${d.port}` } });
    assert.equal(JSON.parse(api.body).status, 'starting');
    const evil = await request(d.port, { headers: { Host: 'attacker.example' } });
    assert.equal(evil.status, 403, 'DNS-rebinding requests are refused');
  } finally {
    d.close();
  }
});

test('stop needs the dashboard header', async () => {
  const { bot, state } = setup();
  const d = await startDashboard({ state, bot, port: 3910 });
  try {
    const host = { Host: `localhost:${d.port}` };
    const blocked = await request(d.port, { method: 'POST', path: '/api/stop', headers: host });
    assert.equal(blocked.status, 403);
    assert.equal(bot.stopReason, null);
    const ok = await request(d.port, { method: 'POST', path: '/api/stop', headers: { ...host, 'X-Dashboard': '1' } });
    assert.equal(ok.status, 204);
    assert.equal(bot.stopReason, 'stopped from the dashboard');
  } finally {
    d.close();
  }
});

test('a second dashboard moves to the next free port', async () => {
  const a = setup();
  const b = setup();
  const d1 = await startDashboard({ state: a.state, bot: a.bot, port: 3920 });
  const d2 = await startDashboard({ state: b.state, bot: b.bot, port: 3920 });
  try {
    assert.equal(d1.port, 3920);
    assert.equal(d2.port, 3921);
  } finally {
    d1.close();
    d2.close();
  }
});

test('DASHBOARD_PORT defaults to 3000 and 0 turns it off', () => {
  assert.equal(loadConfig({}).dashboardPort, 3000);
  assert.equal(loadConfig({ DASHBOARD_PORT: '0' }).dashboardPort, 0);
});
