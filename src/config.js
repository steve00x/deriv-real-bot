// Bot configuration, read from environment variables (see .env.example).

export function loadConfig(env = process.env) {
  // A blank line in .env (e.g. `STRATEGY=`) means "use the default".
  const str = (name, def) => {
    const v = String(env[name] ?? '').trim();
    return v === '' ? String(def) : v;
  };
  const num = (name, def) => {
    const v = Number(str(name, def));
    if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
    return v;
  };
  const bool = (name, def) => ['1', 'true', 'yes', 'on'].includes(str(name, def).toLowerCase());

  return {
    // Connection
    api: str('DERIV_API', 'new').toLowerCase(), // new = current Options API, legacy = old websockets/v3
    apiHost: str('DERIV_API_HOST', 'api.derivws.com'),
    appId: str('DERIV_APP_ID', ''), // register yours at https://developers.deriv.com
    apiToken: str('DERIV_API_TOKEN', ''), // Personal Access Token
    accountId: str('DERIV_ACCOUNT_ID', ''), // optional; defaults to your demo account

    // Mode
    paper: bool('PAPER_TRADING', 'true'), // simulate trades, never send a buy
    allowRealAccount: bool('ALLOW_REAL_ACCOUNT', 'false'),
    paperPayout: num('PAPER_PAYOUT', 0.95), // profit per 1 staked on a win, if Deriv won't quote one

    // Contract
    symbol: str('SYMBOL', 'R_100'), // Volatility 100 Index
    currency: str('CURRENCY', 'USD'),
    duration: num('DURATION', 5),
    durationUnit: str('DURATION_UNIT', 't'), // t = ticks, s = seconds, m = minutes

    // Strategy
    contract: str('CONTRACT', 'rise_fall').toLowerCase(), // rise_fall | even_odd
    // rise_fall: sma_cross | momentum | rsi | random
    // even_odd:  digit_contrarian | digit_follow | random
    strategy: str('STRATEGY', str('CONTRACT', 'rise_fall').toLowerCase() === 'even_odd' ? 'digit_contrarian' : 'sma_cross'),
    digitWindow: num('DIGIT_WINDOW', 3), // same-parity digits in a row before an Even/Odd trade
    fastPeriod: num('FAST_PERIOD', 5),
    slowPeriod: num('SLOW_PERIOD', 20),
    momentumWindow: num('MOMENTUM_WINDOW', 5),
    rsiPeriod: num('RSI_PERIOD', 14),
    rsiLow: num('RSI_LOW', 30),
    rsiHigh: num('RSI_HIGH', 70),
    cooldownTicks: num('COOLDOWN_TICKS', 3), // ticks to wait after a trade closes

    // Risk management
    stake: num('STAKE', 1),
    maxStake: num('MAX_STAKE', 10),
    martingale: num('MARTINGALE', 1), // stake multiplier after a loss; 1 = off
    takeProfit: num('TAKE_PROFIT', 10),
    stopLoss: num('STOP_LOSS', 10),
    maxTrades: num('MAX_TRADES', 50),
    maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 5),
  };
}

export function validateConfig(cfg) {
  if (!['new', 'legacy'].includes(cfg.api)) throw new Error('DERIV_API must be "new" or "legacy"');
  if (!cfg.paper && !cfg.apiToken) throw new Error('DERIV_API_TOKEN is required when PAPER_TRADING=false');
  if (cfg.api === 'legacy' && !cfg.appId) cfg.appId = '1089'; // Deriv's old public test id
  if (!cfg.paper && cfg.api === 'new' && !cfg.appId) {
    throw new Error('DERIV_APP_ID is required for live trading. Register an app at https://developers.deriv.com');
  }
  if (cfg.paper && cfg.durationUnit !== 't') throw new Error('Paper trading only supports tick durations (DURATION_UNIT=t)');
  if (cfg.stake <= 0 || cfg.maxStake < cfg.stake) throw new Error('STAKE must be > 0 and MAX_STAKE >= STAKE');
  if (!['rise_fall', 'even_odd'].includes(cfg.contract)) throw new Error('CONTRACT must be "rise_fall" or "even_odd"');
  if (cfg.contract === 'even_odd' && (cfg.durationUnit !== 't' || cfg.duration < 1 || cfg.duration > 10)) {
    throw new Error('Even/Odd contracts last 1-10 ticks: set DURATION_UNIT=t and DURATION between 1 and 10');
  }
  if (cfg.digitWindow < 1) throw new Error('DIGIT_WINDOW must be at least 1');
  if (cfg.martingale < 1) throw new Error('MARTINGALE must be >= 1');
  if (cfg.fastPeriod >= cfg.slowPeriod) throw new Error('FAST_PERIOD must be smaller than SLOW_PERIOD');
  return cfg;
}
