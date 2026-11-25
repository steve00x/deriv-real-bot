// Contract families the bot can trade, and how each one is settled.
//
// rise_fall: Rise (CALL) wins if exit > entry; Fall (PUT) wins if exit < entry.
//            A tie (exit == entry) loses both.
// even_odd:  Even (DIGITEVEN) / Odd (DIGITODD) win on the parity of the LAST
//            DIGIT of the exit price, shown to the market's decimal places
//            (R_100 has 2, so 428.50 -> last digit 0 -> Even).

export const CONTRACTS = {
  rise_fall: { name: 'Rise/Fall', types: ['CALL', 'PUT'] },
  even_odd: { name: 'Even/Odd', types: ['DIGITEVEN', 'DIGITODD'] },
};

export const LABELS = { CALL: 'RISE', PUT: 'FALL', DIGITEVEN: 'EVEN', DIGITODD: 'ODD' };

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

export function contractOutcome(contractType, entry, exit, decimals = 2) {
  switch (contractType) {
    case 'CALL':
      return exit > entry ? 'won' : 'lost';
    case 'PUT':
      return exit < entry ? 'won' : 'lost';
    case 'DIGITEVEN':
      return lastDigit(exit, decimals) % 2 === 0 ? 'won' : 'lost';
    case 'DIGITODD':
      return lastDigit(exit, decimals) % 2 === 1 ? 'won' : 'lost';
    default:
      throw new Error(`Unknown contract type ${contractType}`);
  }
}
