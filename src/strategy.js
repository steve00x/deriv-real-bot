// Signal generators.
// Rise/Fall: decide(prices) returns 'CALL' (Rise), 'PUT' (Fall) or null (no trade).
import { CONTRACTS, lastDigit } from './contracts.js';

export const sma = (values, period) =>
  values.slice(-period).reduce((a, b) => a + b, 0) / period;

/** Simple (non-smoothed) RSI over the last `period` price changes. */
export function rsi(prices, period) {
  const w = prices.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < w.length; i++) {
    const change = w[i] - w[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  return 100 - 100 / (1 + gains / losses);
}

/** Trend following: trade in the direction of a fast/slow SMA crossover. */
export class SmaCrossStrategy {
  constructor(fast, slow) {
    this.name = 'sma_cross';
    this.fast = fast;
    this.slow = slow;
    this.minHistory = slow + 1;
  }

  decide(prices) {
    if (prices.length < this.minHistory) return null;
    const prev = prices.slice(0, -1);
    const fastNow = sma(prices, this.fast);
    const slowNow = sma(prices, this.slow);
    const fastPrev = sma(prev, this.fast);
    const slowPrev = sma(prev, this.slow);
    if (fastPrev <= slowPrev && fastNow > slowNow) return 'CALL';
    if (fastPrev >= slowPrev && fastNow < slowNow) return 'PUT';
    return null;
  }
}

/** Trade in the direction of N consecutive ticks moving the same way. */
export class MomentumStrategy {
  constructor(window) {
    this.name = 'momentum';
    this.window = window;
    this.minHistory = window + 1;
  }

  decide(prices) {
    if (prices.length < this.minHistory) return null;
    const recent = prices.slice(-this.minHistory);
    const diffs = recent.slice(1).map((p, i) => p - recent[i]);
    if (diffs.every((d) => d > 0)) return 'CALL';
    if (diffs.every((d) => d < 0)) return 'PUT';
    return null;
  }
}

/** Mean reversion: buy Rise when oversold, Fall when overbought. */
export class RsiStrategy {
  constructor(period, low, high) {
    this.name = 'rsi';
    this.period = period;
    this.low = low;
    this.high = high;
    this.minHistory = period + 1;
  }

  decide(prices) {
    if (prices.length < this.minHistory) return null;
    const value = rsi(prices, this.period);
    if (value <= this.low) return 'CALL';
    if (value >= this.high) return 'PUT';
    return null;
  }
}

// ---------------------------------------------------------------------------
// Even/Odd (digit) strategies. decide(prices, { decimals }) returns
// 'DIGITEVEN', 'DIGITODD' or null, based on the last digits of recent ticks.

const parity = (prices, decimals) => prices.map((p) => lastDigit(p, decimals) % 2); // 0 even, 1 odd

/** After N same-parity last digits in a row, bet the other parity ("it's due"). */
export class DigitContrarianStrategy {
  constructor(window) {
    this.name = 'digit_contrarian';
    this.window = window;
    this.minHistory = window;
  }

  decide(prices, { decimals = 2 } = {}) {
    if (prices.length < this.window) return null;
    const p = parity(prices.slice(-this.window), decimals);
    if (p.every((x) => x === 0)) return 'DIGITODD';
    if (p.every((x) => x === 1)) return 'DIGITEVEN';
    return null;
  }
}

/** After N same-parity last digits in a row, bet the streak continues. */
export class DigitFollowStrategy {
  constructor(window) {
    this.name = 'digit_follow';
    this.window = window;
    this.minHistory = window;
  }

  decide(prices, { decimals = 2 } = {}) {
    if (prices.length < this.window) return null;
    const p = parity(prices.slice(-this.window), decimals);
    if (p.every((x) => x === 0)) return 'DIGITEVEN';
    if (p.every((x) => x === 1)) return 'DIGITODD';
    return null;
  }
}

/** Coin flip between the two sides of a contract; seeded so runs are reproducible. */
export class RandomStrategy {
  constructor(seed = 42, sides = CONTRACTS.rise_fall.types) {
    this.name = 'random';
    this.minHistory = 1;
    this.sides = sides;
    this.state = seed >>> 0;
  }

  decide() {
    // mulberry32 PRNG
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return r < 0.5 ? this.sides[0] : this.sides[1];
  }
}

export const STRATEGIES = {
  rise_fall: ['sma_cross', 'momentum', 'rsi', 'random'],
  even_odd: ['digit_contrarian', 'digit_follow', 'random'],
};

export function buildStrategy(cfg, name = cfg.strategy) {
  const contract = cfg.contract ?? 'rise_fall';
  const allowed = STRATEGIES[contract];
  if (!allowed) throw new Error(`Unknown contract "${contract}" (use rise_fall or even_odd)`);
  if (!allowed.includes(name)) {
    throw new Error(`Unknown strategy "${name}" for ${contract} (use ${allowed.join(', ')})`);
  }
  switch (name) {
    case 'sma_cross':
      return new SmaCrossStrategy(cfg.fastPeriod, cfg.slowPeriod);
    case 'momentum':
      return new MomentumStrategy(cfg.momentumWindow);
    case 'rsi':
      return new RsiStrategy(cfg.rsiPeriod, cfg.rsiLow, cfg.rsiHigh);
    case 'digit_contrarian':
      return new DigitContrarianStrategy(cfg.digitWindow);
    case 'digit_follow':
      return new DigitFollowStrategy(cfg.digitWindow);
    default:
      return new RandomStrategy(42, CONTRACTS[contract].types);
  }
}
