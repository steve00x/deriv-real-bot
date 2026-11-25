// Backtester: replays real tick history through every strategy using the same
// rules as paper trading, and compares the results side by side.
//
//   npm run backtest                    (5000 ticks of SYMBOL)
//   npm run backtest -- --ticks 20000   (more history)
//   npm run backtest -- --contract even_odd
//   npm run backtest -- --contract higher_lower --barrier +0.1
import { CONTRACTS, contractOutcome, inferDecimals, labelFor } from './contracts.js';
import { RandomStrategy, buildStrategy, strategiesFor } from './strategy.js';
import { decimalsFromPipSize } from './bot.js';

export { RandomStrategy };

const isRiseFall = (t) => t === 'CALL' || t === 'PUT';

/** Every strategy for the configured contract, with `random` as the baseline. */
export function allStrategies(cfg) {
  return strategiesFor(cfg).map((name) => {
    const s = buildStrategy(cfg, name);
    if (name === 'random') s.name = 'random (baseline)';
    return s;
  });
}

/**
 * Simulate one strategy over a price series with a fixed stake.
 * Signal on tick i -> entry is tick i+1 -> exit is tick i+1+duration.
 * After the exit the strategy waits `cooldown` ticks before deciding again.
 */
/**
 * `payout` is the profit per 1 staked on a win: a number, or a map by contract
 * type when the two sides pay differently (Higher/Lower with a barrier).
 * `barrier` is the Higher/Lower offset (0 otherwise).
 */
export function backtest(prices, strategy, { duration = 5, cooldown = 3, payout = 0.95, stake = 1, decimals = 2, barrier = 0 } = {}) {
  const payoutFor = (type) => (typeof payout === 'number' ? payout : payout[type]);
  const results = []; // profit of each trade, for the significance test
  let profit = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let trades = 0;
  let streak = 0;
  let maxLosingStreak = 0;
  let calls = 0;
  let ties = 0;
  let riseFallTrades = 0;

  // Strategies only look at their last `minHistory` ticks; pass a short window
  // (with one spare tick) instead of copying the whole history every step.
  const window = strategy.minHistory + 1;
  let i = strategy.minHistory - 1;
  while (i + 1 + duration < prices.length) {
    const signal = strategy.decide(prices.slice(Math.max(0, i + 1 - window), i + 1), { decimals });
    if (!signal) {
      i += 1;
      continue;
    }
    const entryIdx = i + 1;
    const exitIdx = entryIdx + duration;
    const won = contractOutcome(signal, prices[entryIdx], prices[exitIdx], decimals, barrier) === 'won';
    if (isRiseFall(signal) && !barrier && prices[entryIdx] === prices[exitIdx]) ties += 1;
    if (isRiseFall(signal) && !barrier) riseFallTrades += 1;

    trades += 1;
    if (signal === 'CALL') calls += 1;
    const p = won ? stake * payoutFor(signal) : -stake;
    results.push(p);
    profit += p;
    if (won) {
      wins += 1;
      streak = 0;
    } else {
      streak += 1;
      maxLosingStreak = Math.max(maxLosingStreak, streak);
    }
    peak = Math.max(peak, profit);
    maxDrawdown = Math.max(maxDrawdown, peak - profit);
    i = exitIdx + cooldown;
  }

  const winRate = trades ? wins / trades : 0;
  // Significance: how many standard errors the average profit per trade sits
  // above zero. Works when the two sides pay differently.
  const mean = trades ? profit / trades : 0;
  const variance = trades > 1 ? results.reduce((a, x) => a + (x - mean) ** 2, 0) / (trades - 1) : 0;
  const z = trades > 1 && variance > 0 ? mean / Math.sqrt(variance / trades) : 0;
  // Break-even win rate for the payout actually earned on this strategy's trades.
  const avgPayout = typeof payout === 'number' ? payout : (payoutFor('CALL') + payoutFor('PUT')) / 2;
  const breakEven = 1 / (1 + avgPayout);
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
    tieRate: riseFallTrades ? ties / riseFallTrades : null, // ties only matter for Rise/Fall
    breakEven,
    z,
  };
}

/** Plain-language verdict for one result. */
export function verdict(r) {
  if (r.trades < 100) return 'too few trades to judge';
  if (r.z >= 2) return 'profitable beyond chance (check on new data before trusting it)';
  if (r.z <= -2) return 'clearly loses';
  return 'no proven edge (indistinguishable from chance)';
}

export function formatReport(results, { symbol, ticks, duration, payout, contract = 'rise_fall', barrier = null, side = null }) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const money = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const rows = results.map((r) => [
    r.name,
    String(r.trades),
    pct(r.winRate),
    r.tieRate == null ? '-' : pct(r.tieRate),
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
    `Backtest: ${ticks} ticks of ${symbol}, ${duration}-tick ${CONTRACTS[contract].name}` +
      `${barrier ? ` (barrier ${barrier})` : ''}${side && side !== 'both' ? `, ${labelFor(contract, side === 'higher' ? 'CALL' : 'PUT')} only` : ''}, stake 1`,
    ...(typeof payout === 'number'
      ? [`A win pays +${payout}; break-even win rate ${pct(1 / (1 + payout))}`]
      : CONTRACTS[contract].types.map(
          (t) => `${labelFor(contract, t)} pays +${payout[t].toFixed(3)} on a win; break-even win rate ${pct(1 / (1 + payout[t]))}`,
        )),
    '',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    {
      rise_fall: 'ties = exit price equal to entry price; Rise/Fall loses on a tie, whichever side you pick.',
      higher_lower: 'Higher wins above entry + barrier, Lower below it; landing exactly on the barrier loses both.',
      even_odd: 'Even/Odd is decided by the last digit of the exit price; there are no ties.',
    }[contract],
    'max drawdown = biggest drop from a profit peak, in stake units; worst streak = most losses in a row.',
    'Verdicts test average profit per trade: "profitable beyond chance" needs it at least 2 standard errors above zero.',
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
  let pipSize;
  while (byTime.size < total) {
    const count = Math.min(5000, total - byTime.size);
    const { history } = await client.request({ ticks_history: symbol, end, count, style: 'ticks' });
    const prices = (history?.prices ?? []).map(Number);
    const times = (history?.times ?? []).map(Number);
    pipSize ??= history?.pip_size;
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
    decimals: decimalsFromPipSize(pipSize) ?? inferDecimals(sorted.map(([, p]) => p)),
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

/**
 * Ask Deriv what each side currently pays (profit per 1 staked), so the
 * backtest uses real payouts. Falls back to PAPER_PAYOUT if quotes fail.
 */
export async function quotePayouts(client, cfg, log, prices = []) {
  const { Bot } = await import('./bot.js');
  const bot = new Bot({ cfg, client, strategy: null, risk: null, log });
  bot.prices = prices.slice(-10);
  if (prices.length) bot.decimals = inferDecimals(prices.slice(-200));
  const out = {};
  for (const type of CONTRACTS[cfg.contract].types) {
    try {
      const { result } = await bot.withBarrierFormats(type, 1, (p) => client.request({ proposal: 1, ...p }, 10_000));
      out[type] = Number(result.proposal.payout) - 1;
    } catch (err) {
      if (cfg.contract === 'higher_lower') {
        throw new Error(
          `Could not get a ${labelFor(cfg.contract, type)} quote from Deriv (${err.message}). ` +
            'Higher/Lower payouts depend on the barrier, so the backtest needs real quotes. Try a different BARRIER.',
        );
      }
      log.warn(`Could not get a quote from Deriv (${err.message}); using PAPER_PAYOUT ${cfg.paperPayout}`);
      return cfg.paperPayout;
    }
  }
  const values = Object.values(out);
  return values.every((v) => Math.abs(v - values[0]) < 1e-9) ? values[0] : out;
}

export async function main(argv = process.argv.slice(2)) {
  const { loadConfig, validateConfig } = await import('./config.js');
  const { DerivClient } = await import('./derivClient.js');
  const { publicWsUrl, LEGACY_HOSTS } = await import('./derivApi.js');

  const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const contract = arg('contract', null);
  const barrierArg = arg('barrier', null);
  const sideArg = arg('side', null);
  const env = {
    ...process.env,
    ...(contract && { CONTRACT: contract }),
    ...(barrierArg && { BARRIER: barrierArg }),
    ...(sideArg && { TRADE_SIDE: sideArg }),
  };
  const cfg = validateConfig({ ...loadConfig(env), paper: true });
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
  let payout = cfg.paperPayout;
  try {
    data = await fetchHistory(client, symbol, ticks, log);
    payout = await quotePayouts(client, { ...cfg, symbol }, log, data.prices);
  } finally {
    client.close();
  }
  const { prices } = data;
  log.info(describeData(prices, data.times));

  const decimals = data.decimals ?? inferDecimals(prices);
  const barrier = cfg.contract === 'higher_lower' ? Number(cfg.barrier) : 0;
  const opts = { duration: cfg.duration, cooldown: cfg.cooldownTicks, payout, decimals, barrier };
  const results = allStrategies(cfg).map((s) => backtest(prices, s, opts));
  const meta = {
    symbol,
    ticks: prices.length,
    duration: cfg.duration,
    payout,
    contract: cfg.contract,
    barrier: barrier ? cfg.barrier : null,
    side: cfg.contract !== 'even_odd' ? cfg.tradeSide : null,
  };
  console.log(`\n${formatReport(results, meta)}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backtest.js')) {
  main().catch((err) => {
    console.error(`ERROR ${err.message}`);
    process.exit(1);
  });
}
