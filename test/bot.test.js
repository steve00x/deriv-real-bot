import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, riseFallOutcome } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { MomentumStrategy } from '../src/strategy.js';
import { loadConfig } from '../src/config.js';

test('rise/fall outcome rules (ties lose)', () => {
  assert.equal(riseFallOutcome('CALL', 1, 2), 'won');
  assert.equal(riseFallOutcome('CALL', 2, 1), 'lost');
  assert.equal(riseFallOutcome('CALL', 1, 1), 'lost');
  assert.equal(riseFallOutcome('PUT', 2, 1), 'won');
  assert.equal(riseFallOutcome('PUT', 1, 1), 'lost');
});

/** Fake Deriv client: answers requests and lets the test push ticks. */
class FakeClient {
  constructor({ history = [], isVirtual = 1 } = {}) {
    this.history = history;
    this.isVirtual = isVirtual;
    this.sent = [];
    this.streams = new Map();
    this.nextId = 1;
  }
  async request(p) {
    this.sent.push(p);
    if (p.authorize) return { authorize: { is_virtual: this.isVirtual, loginid: 'VRTC1', balance: 10000, currency: 'USD' } };
    if (p.ticks_history) return { history: { prices: this.history } };
    if (p.proposal) return { proposal: { payout: 1.95, ask_price: p.amount } };
    if (p.buy) return { buy: { contract_id: 42, buy_price: p.price, payout: 1.95 } };
    return {};
  }
  subscribe(p, cb) {
    const id = this.nextId++;
    this.sent.push(p);
    this.streams.set(p.ticks ? 'ticks' : 'poc', cb);
    return id;
  }
  unsubscribe() {}
  tick(q) {
    this.streams.get('ticks')({ tick: { quote: q }, subscription: { id: 's1' } });
  }
}

const quietLog = { info() {}, warn() {}, error() {} };
const flush = () => new Promise((r) => setImmediate(r));

function makeBot(over = {}, clientOpts = {}) {
  const cfg = { ...loadConfig({}), cooldownTicks: 0, duration: 2, ...over };
  const client = new FakeClient({ history: [1, 2, 3], ...clientOpts });
  const risk = new RiskManager(cfg);
  const bot = new Bot({ cfg, client, strategy: new MomentumStrategy(2), risk, log: quietLog });
  return { bot, client, risk };
}

test('paper mode simulates a winning Rise trade without ever buying', async () => {
  const { bot, client, risk } = makeBot({ maxTrades: 1 });
  const done = bot.run();
  await flush();
  client.tick(4); // 2,3,4 rising -> CALL signal
  await flush(); // proposal resolves
  client.tick(5); // entry
  client.tick(6);
  client.tick(7); // exit after 2 ticks: 7 > 5 -> win
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, 0.95);
  client.tick(8); // next tick sees max trades reached
  assert.match(await done, /max trades/);
  assert.ok(!client.sent.some((p) => p.buy), 'paper mode must not send buy');
});

test('live mode refuses a real-money account by default', async () => {
  const { bot } = makeBot({ paper: false, apiToken: 'x' }, { isVirtual: 0 });
  await assert.rejects(bot.run(), /Refusing to trade a REAL account/);
});

test('live mode buys and records the settled profit', async () => {
  const { bot, client, risk } = makeBot({ paper: false, apiToken: 'x', maxTrades: 1 });
  bot.run();
  await flush();
  client.tick(4);
  await flush();
  const buy = client.sent.find((p) => p.buy);
  assert.equal(buy.parameters.contract_type, 'CALL');
  assert.equal(buy.parameters.symbol, 'R_100');
  client.streams.get('poc')({ proposal_open_contract: { is_sold: 1, profit: '-1.00', entry_spot: 4, exit_spot: 3 } });
  await flush();
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, -1);
});

test('paper mode falls back to PAPER_PAYOUT when the feed will not quote', async () => {
  const { bot, client, risk } = makeBot({ maxTrades: 1, paperPayout: 0.9 });
  client.request = async (p) => {
    if (p.proposal) throw new Error('AuthorizationRequired: Please log in.');
    if (p.ticks_history) return { history: { prices: [1, 2, 3] } };
    return {};
  };
  bot.run();
  await flush();
  client.tick(4);
  await flush();
  client.tick(5);
  client.tick(6);
  client.tick(7);
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, 0.9);
});
