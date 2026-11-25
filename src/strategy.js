// Signal generators for Rise/Fall.
// decide(prices) returns 'CALL' (Rise), 'PUT' (Fall) or null (no trade).

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

export function buildStrategy(cfg) {
  switch (cfg.strategy) {
    case 'sma_cross':
      return new SmaCrossStrategy(cfg.fastPeriod, cfg.slowPeriod);
    case 'momentum':
      return new MomentumStrategy(cfg.momentumWindow);
    case 'rsi':
      return new RsiStrategy(cfg.rsiPeriod, cfg.rsiLow, cfg.rsiHigh);
    default:
      throw new Error(`Unknown strategy "${cfg.strategy}" (use sma_cross, momentum or rsi)`);
  }
}
