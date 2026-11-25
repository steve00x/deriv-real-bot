import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractOutcome, labelFor, formatBarrier } from '../src/contracts.js';
import { buildStrategy } from '../src/strategy.js';
import { Bot } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { backtest, allStrategies, formatReport, quotePayouts } from '../src/backtest.js';

const hl = (env = {}) => validateConfig(loadConfig({ CONTRACT: 'higher_lower', ...env }));

test('Higher/Lower settles against entry + barrier, at market precision', () => {
  // Entry 100.00, barrier +0.10 -> target 100.10
  assert.equal(contractOutcome('CALL', 100, 100.11, 2, 0.1), 'won');
  assert.equal(contractOutcome('CALL', 100, 100.1, 2, 0.1), 'lost'); // on the barrier
  assert.equal(contractOutcome('PUT', 100, 100.09, 2, 0.1), 'won'); // below barrier, though above entry
  assert.equal(contractOutcome('PUT', 100, 100.1, 2, 0.1), 'lost');
  // Negative barrier: Higher wins even on a small fall.
  assert.equal(contractOutcome('CALL', 100, 99.95, 2, -0.1), 'won');
  // Float noise: 0.1 + 0.2 style sums must not flip the result.
  assert.equal(contractOutcome('CALL', 428.2, 428.3, 2, 0.1), 'lost');
});

test('config: higher_lower defaults to always_higher with a +0.1 barrier', () => {
  const cfg = hl();
  assert.equal(cfg.strategy, 'always_higher');
  assert.equal(cfg.barrier, '+0.1');
  assert.equal(hl({ BARRIER: '0.25' }).barrier, '+0.25');
  assert.equal(hl({ BARRIER: '-0.5' }).barrier, '-0.5');
  assert.throws(() => hl({ BARRIER: '0' }), /non-zero/);
  assert.throws(() => hl({ BARRIER: 'abc' }), /BARRIER must be/);
  assert.throws(() => buildStrategy({ ...cfg, strategy: 'digit_follow' }), /for higher_lower/);
});

test('labels and barrier formatting', () => {
  assert.equal(labelFor('higher_lower', 'CALL'), 'HIGHER');
  assert.equal(labelFor('higher_lower', 'PUT'), 'LOWER');
  assert.equal(labelFor('rise_fall', 'CALL'), 'RISE');
  assert.equal(formatBarrier('0.1'), '+0.1');
  assert.equal(formatBarrier('-0.1'), '-0.1');
  assert.equal(formatBarrier('+0.1', 2), '+0.10');
  assert.equal(formatBarrier('-0.25', 3), '-0.250');
  assert.equal(formatBarrier('+0.15', 1), '+0.15');
  assert.equal(formatBarrier('+0.1', 0), '+0.1');
});

test('always_higher buys HIGHER with the barrier in live params', async () => {
  const cfg = { ...hl({ PAPER_TRADING: 'false', DERIV_API_TOKEN: 't', DERIV_APP_ID: 'a' }), cooldownTicks: 0, maxTrades: 1 };
  const sent = [];
  const streams = {};
  const client = {
    async request(p) {
      sent.push(p);
      if (p.ticks_history) return { history: { prices: [1, 2, 3] } };
      if (p.buy) return { buy: { contract_id: 7, buy_price: 1, payout: 2.4 } };
      return {};
    },
    subscribe(p, cb) {
      streams[p.ticks ? 'ticks' : 'poc'] = cb;
      return 1;
    },
    unsubscribe() {},
  };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn() {}, error() {} };
  const risk = new RiskManager(cfg);
  const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk, log, account: { id: 'VRTC1', isVirtual: true }, needsAuthorize: false });
  bot.run();
  await new Promise((r) => setImmediate(r));
  streams.ticks({ tick: { quote: 4 } });
  await new Promise((r) => setImmediate(r));
  const buy = sent.find((p) => p.buy);
  assert.equal(buy.parameters.contract_type, 'CALL');
  assert.equal(buy.parameters.barrier, '+0.1'); // never rounded away, even if prices look whole
  streams.poc({ proposal_open_contract: { is_sold: 1, profit: '1.40', entry_spot: 4, exit_spot: 4.2 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(risk.profit, 1.4);
  assert.ok(logs.some((m) => /\[LIVE\] HIGHER WON/.test(m)));
  assert.ok(logs.some((m) => /barrier=\+0\.1 side=higher strategy=always_higher/.test(m)));
});

test('paper mode settles Higher against the barrier', async () => {
  const cfg = { ...hl({ DURATION: '1' }), cooldownTicks: 0, maxTrades: 1 };
  const streams = {};
  const client = {
    async request(p) {
      if (p.ticks_history) return { history: { prices: [100, 100.5] } };
      if (p.proposal) return { proposal: { payout: 2.3 } };
      return {};
    },
    subscribe(p, cb) {
      streams.ticks = cb;
      return 1;
    },
    unsubscribe() {},
  };
  const risk = new RiskManager(cfg);
  const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk, log: { info() {}, warn() {}, error() {} } });
  bot.run();
  await new Promise((r) => setImmediate(r));
  streams.ticks({ tick: { quote: 100.2 } }); // signal (always higher)
  await new Promise((r) => setImmediate(r));
  streams.ticks({ tick: { quote: 100.0 } }); // entry -> target 100.10
  streams.ticks({ tick: { quote: 100.05 } }); // exit below target -> lost even though it rose
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, -1);
});

test('backtest uses separate payouts for Higher and Lower', () => {
  const cfg = hl({ TRADE_SIDE: 'both' });
  const up = Array.from({ length: 400 }, (_, i) => 100 + i * 0.05); // steady rise, 0.25 per 5 ticks
  const payout = { CALL: 1.2, PUT: 0.3 };
  const results = allStrategies(cfg).map((s) => backtest(up, s, { duration: 5, cooldown: 0, payout, barrier: 0.1 }));
  const higher = results.find((r) => r.name === 'always_higher');
  const lower = results.find((r) => r.name === 'always_lower');
  assert.equal(higher.winRate, 1);
  assert.ok(Math.abs(higher.perTrade - 1.2) < 1e-9);
  assert.equal(lower.winRate, 0);
  assert.deepEqual(results.map((r) => r.name), ['always_higher', 'always_lower', 'sma_cross', 'momentum', 'rsi', 'random (baseline)']);
  const text = formatReport(results, { symbol: 'R_100', ticks: up.length, duration: 5, payout, contract: 'higher_lower', barrier: '+0.1' });
  assert.match(text, /Higher\/Lower \(barrier \+0\.1\)/);
  assert.match(text, /HIGHER pays \+1\.200 on a win; break-even win rate 45\.5%/);
  assert.match(text, /LOWER pays \+0\.300 on a win; break-even win rate 76\.9%/);
});

test('quotePayouts asks Deriv for both sides with the barrier', async () => {
  const sent = [];
  const client = {
    async request(p) {
      sent.push(p);
      return { proposal: { payout: p.contract_type === 'CALL' ? 2.2 : 1.6 } };
    },
  };
  const payout = await quotePayouts(client, hl(), { info() {}, warn() {} });
  assert.ok(Math.abs(payout.CALL - 1.2) < 1e-9 && Math.abs(payout.PUT - 0.6) < 1e-9);
  assert.ok(sent.every((p) => p.barrier === '+0.10'));
});

test('TRADE_SIDE=higher (the default) never trades Lower, whatever the strategy', () => {
  const cfg = hl({ STRATEGY: 'momentum', MOMENTUM_WINDOW: '2' });
  assert.equal(cfg.tradeSide, 'higher');
  const s = buildStrategy(cfg);
  assert.equal(s.decide([1, 2, 3]), 'CALL'); // up streak -> Higher
  assert.equal(s.decide([3, 2, 1]), null); // down streak would be Lower -> skipped
  assert.equal(buildStrategy(hl({ STRATEGY: 'random' })).name, 'random');
  for (let i = 0; i < 50; i++) assert.notEqual(buildStrategy(hl({ STRATEGY: 'random' })).decide(), 'PUT');
});

test('TRADE_SIDE validation and backtest list', () => {
  assert.throws(() => hl({ STRATEGY: 'always_lower' }), /never trades when TRADE_SIDE=higher/);
  assert.throws(() => hl({ TRADE_SIDE: 'sideways' }), /TRADE_SIDE must be/);
  const names = allStrategies(hl()).map((s) => s.name);
  assert.ok(!names.includes('always_lower'));
  const up = Array.from({ length: 300 }, (_, i) => 100 + (i % 7) * 0.03 + i * 0.01);
  for (const s of allStrategies(hl())) {
    const r = backtest(up, s, { duration: 5, cooldown: 0, payout: 0.9, barrier: 0.1 });
    assert.ok(r.trades === 0 || r.name !== 'always_lower');
  }
  const text = formatReport([], { symbol: 'R_100', ticks: 1, duration: 5, payout: 0.9, contract: 'higher_lower', barrier: '+0.1', side: 'higher' });
  assert.match(text, /HIGHER only/);
});
