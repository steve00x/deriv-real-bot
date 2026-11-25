import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest, RandomStrategy, formatReport, fetchHistory, verdict } from '../src/backtest.js';
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

test('fetchHistory pages backwards and keeps ticks in time order', async () => {
  const all = Array.from({ length: 12_000 }, (_, i) => i); // price = epoch = index
  const calls = [];
  const client = {
    async request(p) {
      calls.push(p);
      const end = p.end === 'latest' ? all.length - 1 : p.end;
      const slice = all.slice(Math.max(0, end - p.count + 1), end + 1);
      return { history: { prices: slice, times: slice } };
    },
  };
  const prices = await fetchHistory(client, 'R_100', 12_000, { info() {} });
  assert.equal(prices.length, 12_000);
  assert.deepEqual(prices.slice(0, 3), [0, 1, 2]);
  assert.equal(prices.at(-1), 11_999);
  assert.deepEqual(calls.map((c) => c.count), [5000, 5000, 2000]);
});
