import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStrategy } from '../src/strategy.js';
import { Bot } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { allStrategies, formatReport } from '../src/backtest.js';

const rf = (env = {}) => validateConfig(loadConfig({ CONTRACT: 'rise_fall', ...env }));

test('Rise/Fall still trades both sides by default', () => {
  const cfg = rf({ STRATEGY: 'momentum', MOMENTUM_WINDOW: '2' });
  assert.equal(cfg.tradeSide, 'both');
  const s = buildStrategy(cfg);
  assert.equal(s.decide([1, 2, 3]), 'CALL');
  assert.equal(s.decide([3, 2, 1]), 'PUT');
});

test('TRADE_SIDE=rise (alias of higher) blocks every Fall', () => {
  const cfg = rf({ STRATEGY: 'momentum', MOMENTUM_WINDOW: '2', TRADE_SIDE: 'rise' });
  assert.equal(cfg.tradeSide, 'higher');
  const s = buildStrategy(cfg);
  assert.equal(s.decide([1, 2, 3]), 'CALL');
  assert.equal(s.decide([3, 2, 1]), null);
});

test('always_higher (or always_rise) on Rise/Fall buys Rise every time, with no barrier', () => {
  const cfg = rf({ STRATEGY: 'always_rise', TRADE_SIDE: 'higher' });
  assert.equal(cfg.strategy, 'always_higher');
  const s = buildStrategy(cfg);
  assert.equal(s.decide([1]), 'CALL');
  const bot = new Bot({ cfg, client: {}, strategy: s, risk: new RiskManager(cfg), log: { info() {}, warn() {}, error() {} } });
  const params = bot.contractParams('CALL', 1);
  assert.equal(params.contract_type, 'CALL');
  assert.equal('barrier' in params, false);
  assert.throws(() => rf({ STRATEGY: 'always_lower', TRADE_SIDE: 'rise' }), /never trades/);
});

test('backtest labels Rise only', () => {
  const cfg = rf({ TRADE_SIDE: 'higher' });
  const names = allStrategies(cfg).map((s) => s.name);
  assert.ok(names.includes('always_higher') && !names.includes('always_lower'));
  const text = formatReport([], { symbol: 'R_100', ticks: 1, duration: 5, payout: 0.95, contract: 'rise_fall', side: 'higher' });
  assert.match(text, /Rise\/Fall, RISE only/);
});

test('every-format barrier failure points to Rise only', async () => {
  const cfg = { ...validateConfig(loadConfig({ CONTRACT: 'higher_lower', BARRIER: '+0.07' })), cooldownTicks: 0 };
  const bot = new Bot({ cfg, client: {}, strategy: buildStrategy(cfg), risk: new RiskManager(cfg), log: { info() {}, warn() {}, error() {} } });
  bot.prices = [100];
  await assert.rejects(
    bot.withBarrierFormats('CALL', 1, async () => {
      throw new Error('ContractBuyValidationError: Invalid barrier.');
    }),
    /CONTRACT=rise_fall, STRATEGY=always_higher and TRADE_SIDE=higher/,
  );
});
