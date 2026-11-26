import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { MomentumStrategy } from '../src/strategy.js';
import { loadConfig } from '../src/config.js';
import { DashboardState } from '../src/dashboard.js';

const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond, ms = 500) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Fake Deriv connection that can be dropped; subscriptions die with it. */
class FakeClient {
  constructor() {
    this.sent = [];
    this.streams = new Map();
    this.connects = 0;
    this.onClose = null;
  }
  async request(p) {
    this.sent.push(p);
    if (p.ticks_history) return { history: { prices: [1, 2, 3] } };
    if (p.proposal) return { proposal: { payout: 1.95 } };
    if (p.buy) return { buy: { contract_id: 99, buy_price: 1, payout: 1.95 } };
    return {};
  }
  subscribe(p, cb) {
    this.sent.push(p);
    this.streams.set(p.ticks ? 'ticks' : 'poc', cb);
    return this.sent.length;
  }
  unsubscribe() {}
  drop() {
    this.streams.clear();
    this.onClose?.();
  }
  tick(q) {
    this.streams.get('ticks')?.({ tick: { quote: q } });
  }
}

function setup({ cfgOver = {}, reconnect } = {}) {
  const cfg = { ...loadConfig({}), cooldownTicks: 0, duration: 1, stopLoss: 100, maxConsecutiveLosses: 100, ...cfgOver };
  const client = new FakeClient();
  const risk = new RiskManager(cfg);
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const bot = new Bot({
    cfg,
    client,
    strategy: new MomentumStrategy(2),
    risk,
    log,
    needsAuthorize: false,
    reconnect: reconnect ?? (async () => (client.connects += 1)),
    reconnectDelays: [1],
  });
  return { cfg, client, risk, bot, logs };
}

test('reconnects after a drop and keeps the session going', async () => {
  const { client, risk, bot, logs } = setup({ cfgOver: { maxTrades: 2 } });
  const done = bot.run();
  await tick();
  // First trade (paper): 2,3,4 rising -> RISE, entry 5, exit 6 -> won.
  client.tick(4);
  await tick();
  client.tick(5);
  client.tick(6);
  assert.equal(risk.trades, 1);

  client.drop();
  await until(() => client.connects === 1 && client.streams.has('ticks'));
  assert.ok(logs.some((m) => /Reconnected after 1 attempt\. Session continues: trades=1/.test(m)));
  assert.equal(bot.stopped, false);

  // Trading continues on the new connection with the same counters.
  client.tick(7);
  client.tick(8);
  await tick();
  client.tick(9);
  client.tick(10);
  assert.equal(risk.trades, 2);
  client.tick(11);
  assert.match(await done, /max trades/);
});

test('an open live contract is re-checked after reconnecting and still counted', async () => {
  const { client, risk, bot } = setup({ cfgOver: { paper: false, apiToken: 't', maxTrades: 1 } });
  bot.run();
  await tick();
  client.tick(4); // RISE signal -> buy
  await until(() => client.streams.has('poc'));
  client.drop(); // contract still open
  await until(() => client.connects === 1 && client.streams.has('poc'));
  const pocs = client.sent.filter((p) => p.proposal_open_contract);
  assert.equal(pocs.length, 2, 'settlement subscription renewed');
  assert.equal(pocs[1].contract_id, 99);
  client.streams.get('poc')({ proposal_open_contract: { is_sold: 1, profit: '0.95', entry_spot: 4, exit_spot: 5 } });
  await tick();
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, 0.95);
});

test('gives up after RECONNECT_ATTEMPTS failures', async () => {
  let tries = 0;
  const { client, bot } = setup({
    cfgOver: { reconnectAttempts: 3 },
    reconnect: async () => {
      tries += 1;
      throw new Error('Could not reach any Deriv server.\n  details');
    },
  });
  const done = bot.run();
  await tick();
  client.drop();
  assert.match(await done, /could not reconnect after 3 attempts/);
  assert.equal(tries, 3);
});

test('RECONNECT_ATTEMPTS=0 stops on the first drop', async () => {
  assert.equal(loadConfig({}).reconnectAttempts, 20);
  assert.equal(loadConfig({ RECONNECT_ATTEMPTS: '0' }).reconnectAttempts, 0);
  const { client, bot } = setup({ cfgOver: { reconnectAttempts: 0 } });
  const done = bot.run();
  await tick();
  client.drop();
  assert.equal(await done, 'connection lost');
});

test('stopping while reconnecting cancels further attempts', async () => {
  let tries = 0;
  const { client, bot } = setup({
    reconnect: async () => {
      tries += 1;
      throw new Error('still down');
    },
  });
  bot.reconnectDelays = [30];
  const done = bot.run();
  await tick();
  client.drop();
  bot.stop('stopped by user (Ctrl+C)');
  assert.equal(await done, 'stopped by user (Ctrl+C)');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(tries, 0);
});

test('dashboard shows reconnecting, then running again', async () => {
  const { cfg, client, risk, bot } = setup();
  const state = new DashboardState({ cfg, risk }).attach(bot);
  bot.run();
  await tick();
  assert.equal(state.snapshot().status, 'running');
  let seen = null;
  bot.once('disconnected', () => (seen = state.snapshot()));
  client.drop();
  await until(() => seen && client.connects === 1);
  assert.equal(seen.status, 'reconnecting');
  assert.equal(seen.reconnectAttempt, 1);
  await until(() => state.snapshot().status === 'running');
});
