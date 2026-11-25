// Ask Deriv which contracts it offers for a market (contracts_for), and explain
// the Higher/Lower options: allowed durations and Deriv's suggested barrier.
//
//   npm run contracts                     (uses SYMBOL from .env)
//   npm run contracts -- --symbol 1HZ100V
//   npm run contracts -- --probe          (also try quotes to find what Deriv accepts)
import { formatBarrier } from './contracts.js';

/** First array of objects that look like contract offers. */
function findOffers(obj, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object' && 'contract_type' in obj[0]) return obj;
  for (const v of Object.values(obj)) {
    const hit = findOffers(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Request the offer list. The legacy API takes `contracts_for: SYMBOL`; the
 * Options API renamed some fields, so try the likely variants in turn.
 */
export async function fetchOffers(client, symbol) {
  const attempts = [{ contracts_for: symbol }, { contracts_for: 1, underlying_symbol: symbol }];
  const errors = [];
  for (const req of attempts) {
    try {
      const res = await client.request(req, 15_000);
      const offers = findOffers(res);
      if (offers) return offers;
      errors.push(`unexpected response: ${JSON.stringify(res).slice(0, 300)}`);
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(`Deriv did not return a contract list for ${symbol}: ${errors.join(' | ')}`);
}

const isHigherLower = (o) =>
  (o.contract_type === 'CALL' || o.contract_type === 'PUT') &&
  (Number(o.barriers) >= 1 || o.barrier != null) &&
  o.barrier_category !== 'euro_atm' &&
  !/rise|fall/i.test(o.contract_display ?? '');

/** Higher/Lower offers in a simple shape. */
export function higherLowerOffers(offers) {
  return offers.filter(isHigherLower).map((o) => ({
    side: o.contract_type === 'CALL' ? 'HIGHER' : 'LOWER',
    expiry: o.expiry_type ?? '?',
    min: o.min_contract_duration ?? '?',
    max: o.max_contract_duration ?? '?',
    barrier: o.barrier ?? null,
    barrierCategory: o.barrier_category ?? '?',
  }));
}

const UNIT_SECONDS = { t: 2, s: 1, m: 60, h: 3600, d: 86400 };
const parseDuration = (d) => {
  const m = /^(\d+)([tsmhd])$/.exec(String(d));
  return m ? { n: Number(m[1]), unit: m[2] } : null;
};

/** Plain-language advice for the configured duration and barrier. */
export function adviseHigherLower(options, cfg) {
  const lines = [];
  const higher = options.filter((o) => o.side === 'HIGHER');
  if (!higher.length) {
    lines.push(`Deriv does not offer Higher/Lower on ${cfg.symbol} right now. Try another SYMBOL (e.g. R_50 or 1HZ100V).`);
    return lines;
  }
  const tick = higher.find((o) => o.expiry === 'tick' || parseDuration(o.min)?.unit === 't');
  if (cfg.durationUnit === 't' && !tick) {
    const shortest = higher
      .map((o) => ({ o, d: parseDuration(o.min) }))
      .filter((x) => x.d)
      .sort((a, b) => a.d.n * UNIT_SECONDS[a.d.unit] - b.d.n * UNIT_SECONDS[b.d.unit])[0];
    lines.push(
      `Higher/Lower on ${cfg.symbol} is not offered in ticks. The shortest duration is ${shortest?.o.min ?? 'unknown'}.`,
      `Set DURATION_UNIT and DURATION to match (for example DURATION_UNIT=${shortest?.d.unit ?? 'm'} and DURATION=${shortest?.d.n ?? 1}).`,
      'Note: paper mode only simulates tick durations, so test with npm run check and the demo account.',
    );
  }
  const suggested = (tick ?? higher[0]).barrier;
  if (suggested != null && Number(suggested) === Number(cfg.barrier)) {
    lines.push(
      `Your BARRIER=${cfg.barrier} matches Deriv's suggestion and DURATION in ticks is offered.`,
      'If Deriv still says "Invalid barrier", the format is the problem: npm run check now tries the other formats automatically.',
    );
  } else if (suggested != null) {
    lines.push(
      `Deriv's suggested barrier for Higher is ${formatBarrier(suggested)} (you have BARRIER=${cfg.barrier}).`,
      `Try BARRIER=${formatBarrier(suggested)} first; Deriv only accepts barriers within a range around the current price.`,
    );
  } else {
    lines.push(`Deriv did not suggest a barrier. Try a smaller offset than ${cfg.barrier} (e.g. +0.05) or a larger one (e.g. +0.5).`);
  }
  return lines;
}

export function formatOffers(options) {
  if (!options.length) return '  (no Higher/Lower contracts listed)';
  // Hide the category column when Deriv doesn't report it (the Options API doesn't).
  const showCat = options.some((o) => o.barrierCategory !== '?');
  const rows = options.map((o) => [o.side, o.expiry, `${o.min} - ${o.max}`, o.barrier != null ? formatBarrier(o.barrier) : '-', ...(showCat ? [o.barrierCategory] : [])]);
  const header = ['side', 'expiry', 'duration', 'suggested barrier', ...(showCat ? ['category'] : [])];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => '  ' + r.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Fetch, print and advise. Used by npm run contracts and by npm run check on failure. */
export async function explainHigherLower(client, cfg, print = console.log) {
  const offers = await fetchOffers(client, cfg.symbol);
  const options = higherLowerOffers(offers);
  print(`\nHigher/Lower contracts Deriv offers on ${cfg.symbol}:`);
  print(formatOffers(options));
  print('');
  for (const l of adviseHigherLower(options, cfg)) print(`  -> ${l}`);
  return options;
}

/** Quote requests to try, to learn what Deriv accepts for Higher/Lower. */
export function probeVariants(cfg) {
  const sym = cfg.api === 'legacy' ? { symbol: cfg.symbol } : { underlying_symbol: cfg.symbol };
  const base = { proposal: 1, amount: 1, basis: 'stake', currency: cfg.currency, ...sym };
  const b = formatBarrier(cfg.barrier);
  const call = (duration, unit, extra = {}) => ({ ...base, contract_type: 'CALL', duration, duration_unit: unit, ...extra });
  return [
    ['Rise, 5 ticks, no barrier (baseline)', call(5, 't')],
    [`Higher, 5 ticks, barrier ${b}`, call(5, 't', { barrier: b })],
    [`Higher, 1 tick, barrier ${b}`, call(1, 't', { barrier: b })],
    [`Higher, 10 ticks, barrier ${b}`, call(10, 't', { barrier: b })],
    ['Higher, 5 ticks, barrier +0.50', call(5, 't', { barrier: '+0.50' })],
    ['Higher, 5 ticks, barrier -0.07', call(5, 't', { barrier: '-0.07' })],
    [`Higher, 5 ticks, barrier ${b}, product_type basic`, call(5, 't', { barrier: b, product_type: 'basic' })],
    ['Higher, 15 seconds, barrier +0.25', call(15, 's', { barrier: '+0.25' })],
    ['Higher, 1 minute, barrier +0.25', call(1, 'm', { barrier: '+0.25' })],
    ['Higher, 5 minutes, barrier +0.50', call(5, 'm', { barrier: '+0.50' })],
  ];
}

/** Run every probe and print what Deriv answered. Nothing is bought. */
export async function probeHigherLower(client, cfg, print = console.log) {
  const offers = await fetchOffers(client, cfg.symbol).catch(() => []);
  const tick = offers.find((o) => o.contract_type === 'CALL' && isHigherLower(o) && (o.expiry_type === 'tick' || /t$/.test(o.min_contract_duration ?? '')));
  print(`\nDeriv's description of tick Higher on ${cfg.symbol}:`);
  print(tick ? JSON.stringify(tick, null, 2).replace(/^/gm, '  ') : '  (not found)');
  print('\nQuote probes (nothing is bought):');
  const results = [];
  for (const [label, req] of probeVariants(cfg)) {
    try {
      const { proposal } = await client.request(req, 15_000);
      results.push({ label, ok: true, payout: Number(proposal.payout) });
      print(`  OK    ${label}: payout ${proposal.payout}`);
    } catch (err) {
      results.push({ label, ok: false, error: err.message });
      print(`  FAIL  ${label}: ${err.message}`);
    }
  }
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const { loadConfig } = await import('./config.js');
  const { DerivClient } = await import('./derivClient.js');
  const { publicWsUrl, LEGACY_HOSTS } = await import('./derivApi.js');
  const i = argv.indexOf('--symbol');
  const env = { ...process.env, CONTRACT: 'higher_lower', ...(i >= 0 && argv[i + 1] && { SYMBOL: argv[i + 1] }) };
  // Only reads Deriv's offer list, so no login or full validation is needed.
  const cfg = loadConfig(env);
  const log = { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) };
  const client = new DerivClient({ log });
  await client.connect(
    cfg.api === 'legacy' ? LEGACY_HOSTS.map((h) => `wss://${h}/websockets/v3?app_id=${cfg.appId}`) : [publicWsUrl(cfg)],
  );
  try {
    await explainHigherLower(client, cfg);
    if (argv.includes('--probe')) await probeHigherLower(client, cfg);
  } finally {
    client.close();
  }
}

if (process.argv[1]?.endsWith('offers.js')) {
  main().catch((err) => {
    console.error(`ERROR ${err.message}`);
    process.exit(1);
  });
}
