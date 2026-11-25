// Contract families the bot can trade, and how each one is settled.
//
// rise_fall: Rise (CALL) wins if exit > entry; Fall (PUT) wins if exit < entry.
//            A tie (exit == entry) loses both.
// higher_lower: Higher (CALL + barrier) wins if exit > entry + barrier;
//            Lower (PUT + barrier) wins if exit < entry + barrier. The barrier
//            is a signed offset such as +0.10; Deriv prices the payout from it.
// even_odd:  Even (DIGITEVEN) / Odd (DIGITODD) win on the parity of the LAST
//            DIGIT of the exit price, shown to the market's decimal places
//            (R_100 has 2, so 428.50 -> last digit 0 -> Even).

export const CONTRACTS = {
  rise_fall: { name: 'Rise/Fall', types: ['CALL', 'PUT'] },
  higher_lower: { name: 'Higher/Lower', types: ['CALL', 'PUT'], barrier: true },
  even_odd: { name: 'Even/Odd', types: ['DIGITEVEN', 'DIGITODD'] },
};

export const LABELS = { CALL: 'RISE', PUT: 'FALL', DIGITEVEN: 'EVEN', DIGITODD: 'ODD' };
const HIGHER_LOWER_LABELS = { CALL: 'HIGHER', PUT: 'LOWER' };

/** Display name of a contract type within a contract family. */
export function labelFor(contract, contractType) {
  if (contract === 'higher_lower') return HIGHER_LOWER_LABELS[contractType] ?? contractType;
  return LABELS[contractType] ?? contractType;
}

/**
 * Deriv's signed barrier form: 0.1 -> "+0.1". With `decimals`, pad to the
 * market's precision: (0.1, 2) -> "+0.10".
 */
export function formatBarrier(barrier, decimals = null) {
  const raw = String(barrier).trim();
  const n = Number(raw);
  if (decimals != null && Number.isFinite(n)) {
    // Never drop the barrier's own digits (0.15 must not become 0.2 or 0).
    const own = (raw.split('.')[1] ?? '').length;
    return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(Math.max(decimals, own));
  }
  return /^[+-]/.test(raw) ? raw : `+${raw}`;
}

/** Last digit of a price shown to `decimals` places (trailing zeros count). */
export function lastDigit(price, decimals) {
  return Math.round(Math.abs(Number(price)) * 10 ** decimals) % 10;
}

/**
 * Number of decimal places the market quotes in, inferred from prices.
 * Numbers drop trailing zeros (428.50 -> 428.5), so take the maximum seen.
 */
export function inferDecimals(prices) {
  let max = 0;
  for (const p of prices) {
    const frac = String(p).split('.')[1];
    if (frac && frac.length > max) max = frac.length;
  }
  return max;
}

/**
 * Settle a contract. `barrier` is the Higher/Lower offset (0 for Rise/Fall).
 * Prices are compared at the market's precision so float noise can't flip a result.
 */
export function contractOutcome(contractType, entry, exit, decimals = 2, barrier = 0) {
  const scale = 10 ** decimals;
  const target = Math.round((Number(entry) + Number(barrier)) * scale);
  const end = Math.round(Number(exit) * scale);
  switch (contractType) {
    case 'CALL':
      return end > target ? 'won' : 'lost';
    case 'PUT':
      return end < target ? 'won' : 'lost';
    case 'DIGITEVEN':
      return lastDigit(exit, decimals) % 2 === 0 ? 'won' : 'lost';
    case 'DIGITODD':
      return lastDigit(exit, decimals) % 2 === 1 ? 'won' : 'lost';
    default:
      throw new Error(`Unknown contract type ${contractType}`);
  }
}
