// Backtester: replays real tick history through every strategy using the same
// rules as paper trading, and compares the results side by side.
//
//   npm run backtest                    (5000 ticks of SYMBOL)
//   npm run backtest -- --ticks 20000   (more history)
import { riseFallOutcome } from './bot.js';
import { SmaCrossStrategy, MomentumStrategy, RsiStrategy } from './strategy.js';

/** Coin-flip baseline with a fixed seed so runs are reproducible. */
export class RandomStrategy {
  constructor(seed = 42) {
    this.name = 'random (baseline)';
    this.minHistory = 1;
    this.state = seed >>> 0;
  }

  decide() {
    // mulberry32 PRNG
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return r < 0.5 ? 'CALL' : 'PUT';
  }
}

export function allStrategies(cfg) {
  return [
    new SmaCrossStrategy(cfg.fastPeriod, cfg.slowPeriod),
    new MomentumStrategy(cfg.momentumWindow),
    new RsiStrategy(cfg.rsiPeriod, cfg.rsiLow, cfg.rsiHigh),
    new RandomStrategy(),
  ];
}

/**
 * Simulate one strategy over a price series with a fixed stake.
 * Signal on tick i -> entry is tick i+1 -> exit is tick i+1+duration.
 * After the exit the strategy waits `cooldown` ticks before deciding again.
 */
export function backtest(prices, strategy, { duration = 5, cooldown = 3, payout = 0.95, stake = 1 } = {}) {
  let profit = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let trades = 0;
  let streak = 0;
  let maxLosingStreak = 0;
  let calls = 0;
  let ties = 0;

  // Strategies only look at their last `minHistory` ticks; pass a short window
  // (with one spare tick) instead of copying the whole history every step.
  const window = strategy.minHistory + 1;
  let i = strategy.minHistory - 1;
  while (i + 1 + duration < prices.length) {
    const signal = strategy.decide(prices.slice(Math.max(0, i + 1 - window), i + 1));
    if (!signal) {
      i += 1;
      continue;
    }
    const entryIdx = i + 1;
    const exitIdx = entryIdx + duration;
    const won = riseFallOutcome(signal, prices[entryIdx], prices[exitIdx]) === 'won';
    if (prices[entryIdx] === prices[exitIdx]) ties += 1;

    trades += 1;
    if (signal === 'CALL') calls += 1;
    if (won) {
      wins += 1;
      profit += stake * payout;
      streak = 0;
    } else {
      profit -= stake;
      streak += 1;
      maxLosingStreak = Math.max(maxLosingStreak, streak);
    }
    peak = Math.max(peak, profit);
    maxDrawdown = Math.max(maxDrawdown, peak - profit);
    i = exitIdx + cooldown;
  }

  const winRate = trades ? wins / trades : 0;
  // How many standard errors the win rate sits above the break-even rate.
  const breakEven = 1 / (1 + payout);
  const z = trades ? (winRate - breakEven) / Math.sqrt((breakEven * (1 - breakEven)) / trades) : 0;
  return {
    name: strategy.name,
    trades,
    wins,
    winRate,
    profit: Math.round(profit * 100) / 100,
    perTrade: trades ? profit / trades : 0,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxLosingStreak,
    riseShare: trades ? calls / trades : 0,
    ties,
    tieRate: trades ? ties / trades : 0,
    breakEven,
    z,
  };
}

/** Plain-language verdict for one result. */
export function verdict(r) {
  if (r.trades < 100) return 'too few trades to judge';
  if (r.z >= 2) return 'beats break-even (check on new data before trusting it)';
  if (r.z <= -2) return 'clearly loses';
  return 'no proven edge (indistinguishable from chance)';
}

export function formatReport(results, { symbol, ticks, duration, payout }) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const money = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const rows = results.map((r) => [
    r.name,
    String(r.trades),
    pct(r.winRate),
    pct(r.tieRate),
    money(r.profit),
    money(r.perTrade),
    r.maxDrawdown.toFixed(2),
    String(r.maxLosingStreak),
    verdict(r),
  ]);
  const header = ['strategy', 'trades', 'win rate', 'ties', 'profit', 'per trade', 'max drawdown', 'worst streak', 'verdict'];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((row) => row[c].length)));
  const line = (cells) => cells.map((cell, c) => cell.padEnd(widths[c])).join('  ');

  const out = [
    `Backtest: ${ticks} ticks of ${symbol}, ${duration}-tick Rise/Fall, stake 1, win pays +${payout}`,
    `Break-even win rate: ${pct(results[0]?.breakEven ?? 1 / (1 + payout))}`,
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    'ties = exit price equal to entry price; Rise/Fall loses on a tie, whichever side you pick.',
    'max drawdown = biggest drop from a profit peak, in stake units; worst streak = most losses in a row.',
    'A strategy only "beats break-even" if its win rate is at least 2 standard errors above it.',
  ];
  return out.join('\n');
}

/**
 * Download up to `total` ticks, paging backwards. Deriv caps each request
 * (5000 on the legacy API, fewer on the Options API), so keep paging until
 * no older ticks come back. Ticks are de-duplicated by time and sorted oldest first.
 */
export async function fetchHistory(client, symbol, total, log) {
  const byTime = new Map();
  let end = 'latest';
  while (byTime.size < total) {
    const count = Math.min(5000, total - byTime.size);
    const { history } = await client.request({ ticks_history: symbol, end, count, style: 'ticks' });
    const prices = (history?.prices ?? []).map(Number);
    const times = (history?.times ?? []).map(Number);
    if (!prices.length || times.length !== prices.length) break;
    const before = byTime.size;
    times.forEach((t, k) => byTime.set(t, prices[k]));
    log.info(`Downloaded ${byTime.size}/${total} ticks`);
    const oldest = Math.min(...times);
    if (byTime.size === before || !(oldest > 0)) break; // no older data
    end = oldest - 1;
  }
  const sorted = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
  return {
    prices: sorted.slice(-total).map(([, p]) => p),
    times: sorted.slice(-total).map(([t]) => t),
  };
}

/** Quick sanity check of the downloaded data. */
export function describeData(prices, times) {
  let unchanged = 0;
  for (let k = 1; k < prices.length; k++) if (prices[k] === prices[k - 1]) unchanged += 1;
  const span = times.length > 1 ? (times.at(-1) - times[0]) / 60 : 0;
  const decimals = Math.max(...prices.slice(0, 200).map((p) => (String(p).split('.')[1] ?? '').length));
  return (
    `Data: ${prices.length} ticks over ${span.toFixed(0)} min, ` +
    `${((unchanged / Math.max(1, prices.length - 1)) * 100).toFixed(1)}% of ticks unchanged from the previous one, ` +
    `prices shown to ${decimals} decimals`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { loadConfig, validateConfig } = await import('./config.js');
  const { DerivClient } = await import('./derivClient.js');
  const { publicWsUrl, LEGACY_HOSTS } = await import('./derivApi.js');

  const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const cfg = validateConfig({ ...loadConfig(), paper: true });
  const ticks = Number(arg('ticks', 5000));
  const symbol = arg('symbol', cfg.symbol);
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };

  const client = new DerivClient({ log });
  const urls =
    cfg.api === 'legacy'
      ? LEGACY_HOSTS.map((h) => `wss://${h}/websockets/v3?app_id=${cfg.appId}`)
      : [publicWsUrl(cfg)];
  await client.connect(urls);
  let data;
  try {
    data = await fetchHistory(client, symbol, ticks, log);
  } finally {
    client.close();
  }
  const { prices } = data;
  log.info(describeData(prices, data.times));

  const opts = { duration: cfg.duration, cooldown: cfg.cooldownTicks, payout: cfg.paperPayout };
  const results = allStrategies(cfg).map((s) => backtest(prices, s, opts));
  console.log(`\n${formatReport(results, { symbol, ticks: prices.length, duration: cfg.duration, payout: cfg.paperPayout })}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backtest.js')) {
  main().catch((err) => {
    console.error(`ERROR ${err.message}`);
    process.exit(1);
  });
}
