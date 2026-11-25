import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastDigit, inferDecimals, contractOutcome } from '../src/contracts.js';
import { DigitContrarianStrategy, DigitFollowStrategy, buildStrategy, RandomStrategy } from '../src/strategy.js';
import { Bot, decimalsFromPipSize } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { backtest, allStrategies, formatReport } from '../src/backtest.js';

test('last digit counts trailing zeros at the market precision', () => {
  assert.equal(lastDigit(428.56, 2), 6);
  assert.equal(lastDigit(428.5, 2), 0); // shown as 428.50
  assert.equal(lastDigit(1234.567, 3), 7);
  assert.equal(lastDigit(0.29, 2), 9); // no float drift (0.29 * 100 = 28.999...)
});

test('decimals are inferred from prices or taken from pip_size', () => {
  assert.equal(inferDecimals([428.5, 428.56, 429]), 2);
  assert.equal(decimalsFromPipSize(2), 2);
  assert.equal(decimalsFromPipSize(0.001), 3);
  assert.equal(decimalsFromPipSize(undefined), null);
});

test('even/odd outcome uses the exit price last digit only', () => {
  assert.equal(contractOutcome('DIGITEVEN', 1, 428.56, 2), 'won');
  assert.equal(contractOutcome('DIGITEVEN', 1, 428.5, 2), 'won'); // 0 is even
  assert.equal(contractOutcome('DIGITODD', 999, 428.57, 2), 'won');
  assert.equal(contractOutcome('DIGITODD', 1, 428.56, 2), 'lost');
});

test('digit strategies react to a same-parity streak', () => {
  const c = new DigitContrarianStrategy(3);
  const f = new DigitFollowStrategy(3);
  const evens = [1.02, 1.04, 1.1]; // 2, 4, 0
  const odds = [1.01, 1.03, 1.05];
  assert.equal(c.decide(evens, { decimals: 2 }), 'DIGITODD');
  assert.equal(c.decide(odds, { decimals: 2 }), 'DIGITEVEN');
  assert.equal(f.decide(evens, { decimals: 2 }), 'DIGITEVEN');
  assert.equal(f.decide(odds, { decimals: 2 }), 'DIGITODD');
  assert.equal(c.decide([1.01, 1.02, 1.03], { decimals: 2 }), null);
  assert.equal(c.decide([1.02, 1.04], { decimals: 2 }), null);
});

test('config: CONTRACT=even_odd defaults to digit_contrarian and checks duration', () => {
  const cfg = validateConfig(loadConfig({ CONTRACT: 'even_odd' }));
  assert.equal(cfg.strategy, 'digit_contrarian');
  assert.throws(() => validateConfig(loadConfig({ CONTRACT: 'even_odd', DURATION: '11' })), /1-10 ticks/);
  assert.throws(() => buildStrategy({ ...cfg, strategy: 'sma_cross' }), /for even_odd/);
  assert.throws(() => validateConfig(loadConfig({ CONTRACT: 'touch' })), /CONTRACT must be/);
});

test('random baseline uses the contract sides', () => {
  const r = new RandomStrategy(1, ['DIGITEVEN', 'DIGITODD']);
  const seen = new Set(Array.from({ length: 50 }, () => r.decide()));
  assert.deepEqual([...seen].sort(), ['DIGITEVEN', 'DIGITODD']);
});

test('paper bot trades Even/Odd and settles on the exit last digit', async () => {
  const cfg = { ...validateConfig(loadConfig({ CONTRACT: 'even_odd', DIGIT_WINDOW: '2', DURATION: '1' })), cooldownTicks: 0, maxTrades: 1 };
  const streams = {};
  const sent = [];
  const client = {
    async request(p) {
      sent.push(p);
      if (p.ticks_history) return { history: { prices: [1.01, 1.03], pip_size: 2 } };
      if (p.proposal) return { proposal: { payout: 1.9 } };
      return {};
    },
    subscribe(p, cb) {
      streams.ticks = cb;
      return 1;
    },
    unsubscribe() {},
  };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn() {}, error() {} };
  const risk = new RiskManager(cfg);
  const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk, log });
  bot.run();
  await new Promise((r) => setImmediate(r));
  const tick = (q) => streams.ticks({ tick: { quote: q, pip_size: 2 } });
  tick(1.05); // last two digits odd, odd -> contrarian bets EVEN
  await new Promise((r) => setImmediate(r));
  const proposal = sent.find((p) => p.proposal);
  assert.equal(proposal.contract_type, 'DIGITEVEN');
  assert.equal(proposal.underlying_symbol, 'R_100');
  tick(1.07); // entry
  tick(1.1); // exit after 1 tick: shown as 1.10 -> digit 0 -> even wins
  assert.equal(risk.trades, 1);
  assert.equal(risk.profit, 0.9);
  assert.ok(logs.some((m) => /EVEN WON .*last digit=0/.test(m)));
});

test('backtest runs all Even/Odd strategies and reports without ties', () => {
  const cfg = validateConfig(loadConfig({ CONTRACT: 'even_odd' }));
  let x = 100;
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const prices = Array.from({ length: 20_000 }, () => Math.round((x += rand() - 0.5) * 100) / 100);
  const results = allStrategies(cfg).map((s) => backtest(prices, s, { duration: 5, cooldown: 0, decimals: 2 }));
  assert.deepEqual(results.map((r) => r.name), ['digit_contrarian', 'digit_follow', 'random (baseline)']);
  for (const r of results) {
    assert.ok(r.trades > 100);
    assert.equal(r.tieRate, null);
    assert.ok(r.winRate > 0.4 && r.winRate < 0.6, `${r.name} ${r.winRate}`);
  }
  const text = formatReport(results, { symbol: 'R_100', ticks: prices.length, duration: 5, payout: 0.95, contract: 'even_odd' });
  assert.match(text, /5-tick Even\/Odd/);
  assert.match(text, /no ties/);
});
