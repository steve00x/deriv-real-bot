// Ask Deriv which contracts it offers for a market (contracts_for), and explain
// the Higher/Lower options: allowed durations and Deriv's suggested barrier.
//
//   npm run contracts                     (uses SYMBOL from .env)
//   npm run contracts -- --symbol 1HZ100V
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
  if (suggested != null) {
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
  const rows = options.map((o) => [o.side, o.expiry, `${o.min} - ${o.max}`, o.barrier != null ? formatBarrier(o.barrier) : '-', o.barrierCategory]);
  const header = ['side', 'expiry', 'duration', 'suggested barrier', 'category'];
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
