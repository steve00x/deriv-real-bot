import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';

const cfg = (over = {}) => ({ ...loadConfig({}), ...over });

test('defaults are safe: paper mode, no martingale, real accounts blocked', () => {
  const c = loadConfig({});
  assert.equal(c.paper, true);
  assert.equal(c.martingale, 1);
  assert.equal(c.allowRealAccount, false);
  assert.doesNotThrow(() => validateConfig(c));
});

test('live mode requires a token', () => {
  assert.throws(() => validateConfig(loadConfig({ PAPER_TRADING: 'false' })), /DERIV_API_TOKEN/);
});

test('take profit stops the session', () => {
  const r = new RiskManager(cfg({ takeProfit: 1.5 }));
  r.record(0.95);
  assert.equal(r.stopReason(), null);
  r.record(0.95);
  assert.match(r.stopReason(), /take profit/);
});

test('stop loss stops the session before the next stake can breach it', () => {
  const r = new RiskManager(cfg({ stopLoss: 2.5, maxConsecutiveLosses: 99 }));
  r.record(-1);
  assert.equal(r.stopReason(), null);
  r.record(-1); // loss 2, next stake 1 would make it 3 > 2.5
  assert.match(r.stopReason(), /exceed stop loss/);
});

test('consecutive losses stop the session; a win resets the streak', () => {
  const r = new RiskManager(cfg({ maxConsecutiveLosses: 2, stopLoss: 100 }));
  r.record(-1);
  r.record(0.9);
  r.record(-1);
  assert.equal(r.stopReason(), null);
  r.record(-1);
  assert.match(r.stopReason(), /consecutive losses/);
});

test('martingale multiplies stake after a loss, capped by maxStake, reset on win', () => {
  const r = new RiskManager(cfg({ stake: 1, martingale: 2, maxStake: 3, stopLoss: 100 }));
  r.record(-1);
  assert.equal(r.nextStake(), 2);
  r.record(-2);
  assert.equal(r.nextStake(), 3);
  r.record(5);
  assert.equal(r.nextStake(), 1);
});
