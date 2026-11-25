import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, rsi, SmaCrossStrategy, MomentumStrategy, RsiStrategy, buildStrategy } from '../src/strategy.js';

test('sma averages the last N values', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
});

test('rsi is 100 for straight gains, 0 for straight losses', () => {
  assert.equal(rsi([1, 2, 3, 4, 5], 4), 100);
  assert.equal(rsi([5, 4, 3, 2, 1], 4), 0);
  assert.equal(rsi([1, 2, 1, 2, 1], 4), 50);
});

test('sma_cross signals CALL on a bullish crossover and PUT on a bearish one', () => {
  const s = new SmaCrossStrategy(2, 4);
  assert.equal(s.decide([10, 10, 10, 10]), null); // not enough history
  assert.equal(s.decide([10, 10, 10, 10, 12]), 'CALL');
  assert.equal(s.decide([10, 10, 10, 10, 8]), 'PUT');
  assert.equal(s.decide([10, 11, 12, 13, 14]), null); // already above, no fresh cross
});

test('momentum needs N consecutive moves in one direction', () => {
  const s = new MomentumStrategy(3);
  assert.equal(s.decide([1, 2, 3, 4]), 'CALL');
  assert.equal(s.decide([4, 3, 2, 1]), 'PUT');
  assert.equal(s.decide([1, 2, 1, 2]), null);
  assert.equal(s.decide([1, 2, 3]), null);
});

test('rsi strategy is contrarian', () => {
  const s = new RsiStrategy(4, 30, 70);
  assert.equal(s.decide([5, 4, 3, 2, 1]), 'CALL'); // oversold
  assert.equal(s.decide([1, 2, 3, 4, 5]), 'PUT'); // overbought
  assert.equal(s.decide([1, 2, 1, 2, 1]), null);
});

test('buildStrategy rejects unknown names', () => {
  assert.throws(() => buildStrategy({ strategy: 'magic' }), /Unknown strategy/);
});
