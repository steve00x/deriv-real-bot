import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, RandomStrategy, formatReport, fetchHistory, verdict, describeData } from '../src/backtest.js';
import { MomentumStrategy } from '../src/strategy.js';

const always = (signal) => ({ name: signal, minHistory: 1, decide: () => signal });

test('uses next tick as entry and exits after `duration` ticks', () => {
  // Signal at tick 0 -> entry tick 1 (10) -> exit tick 3 (12): Rise wins.
  const r = backtest([0, 10, 11, 12], always('CALL'), { duration: 2, cooldown: 0, payout: 0.9 });
  assert.equal(r.trades, 1);
  assert.equal(r.wins, 1);
  assert.equal(r.profit, 0.9);
});

test('ties lose, and cooldown skips ticks after each exit', () => {
  const prices = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const r = backtest(prices, always('PUT'), { duration: 1, cooldown: 2, payout: 0.95 });
  // decisions at 0, 4, 8? -> 0: entry1 exit2, next i=4: entry5 exit6, next i=8: 8+1+1=10 not < 10
  assert.equal(r.trades, 2);
  assert.equal(r.wins, 0);
  assert.equal(r.profit, -2);
  assert.equal(r.maxLosingStreak, 2);
  assert.equal(r.maxDrawdown, 2);
});

test('momentum on a steady uptrend wins every trade', () => {
  const prices = Array.from({ length: 200 }, (_, i) => 100 + i);
  const r = backtest(prices, new MomentumStrategy(3), { duration: 5, cooldown: 0 });
  assert.ok(r.trades > 10);
  assert.equal(r.winRate, 1);
  assert.match(verdict(r), /too few|beats/);
});

test('random baseline is reproducible and roughly 50/50 on a random walk', () => {
  let x = 1000;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const prices = Array.from({ length: 40_000 }, () => (x += rand() < 0.5 ? -1 : 1));
  const a = backtest(prices, new RandomStrategy(1), { duration: 5, cooldown: 0 });
  const b = backtest(prices, new RandomStrategy(1), { duration: 5, cooldown: 0 });
  assert.deepEqual(a, b);
  assert.ok(a.winRate > 0.45 && a.winRate < 0.55, `win rate ${a.winRate}`);
  assert.match(verdict(a), /no proven edge/);
});

test('report shows break-even and a verdict per strategy', () => {
  const r = backtest([0, 1, 2, 3], always('CALL'), { duration: 1, cooldown: 0 });
  const text = formatReport([r], { symbol: 'R_100', ticks: 4, duration: 1, payout: 0.95 });
  assert.match(text, /Break-even win rate: 51\.3%/);
  assert.match(text, /too few trades to judge/);
});

test('fetchHistory keeps paging when Deriv returns fewer ticks than asked', async () => {
  const all = Array.from({ length: 12_000 }, (_, i) => i + 1); // price = epoch
  const calls = [];
  const client = {
    async request(p) {
      calls.push(p);
      const end = p.end === 'latest' ? all.length : p.end;
      const n = Math.min(p.count, 2000); // Options API cap
      const slice = all.filter((t) => t <= end).slice(-n);
      return { history: { prices: slice, times: slice } };
    },
  };
  const { prices, times } = await fetchHistory(client, 'R_100', 5000, { info() {} });
  assert.equal(prices.length, 5000);
  assert.deepEqual(prices.slice(0, 2), [7001, 7002]);
  assert.equal(prices.at(-1), 12_000);
  assert.deepEqual(times, prices);
  assert.equal(calls.length, 3);
});

test('fetchHistory stops when there is no older data', async () => {
  const client = { request: async () => ({ history: { prices: [1, 2], times: [10, 11] } }) };
  const { prices } = await fetchHistory(client, 'R_100', 5000, { info() {} });
  assert.deepEqual(prices, [1, 2]);
});

test('ties are counted and reported', () => {
  const r = backtest([5, 5, 5, 5, 6, 6], always('CALL'), { duration: 1, cooldown: 0 });
  assert.equal(r.trades, 2);
  assert.equal(r.ties, 1);
  const text = formatReport([r], { symbol: 'X', ticks: 6, duration: 1, payout: 0.95 });
  assert.match(text, /ties/);
  assert.match(describeData([1, 1, 2], [0, 60, 120]), /50\.0% of ticks unchanged/);
});
