// Bot configuration, read from environment variables (see .env.example).

export function loadConfig(env = process.env) {
  const str = (name, def) => String(env[name] ?? def).trim();
  const num = (name, def) => {
    const v = Number(str(name, def));
    if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
    return v;
  };
  const bool = (name, def) => ['1', 'true', 'yes', 'on'].includes(str(name, def).toLowerCase());

  return {
    // Connection
    appId: str('DERIV_APP_ID', '1089'), // Deriv's public test app id; register your own at api.deriv.com
    apiToken: str('DERIV_API_TOKEN', ''),
    endpoint: str('DERIV_ENDPOINT', 'ws.derivws.com'),

    // Mode
    paper: bool('PAPER_TRADING', 'true'), // simulate trades, never send a buy
    allowRealAccount: bool('ALLOW_REAL_ACCOUNT', 'false'),

    // Contract
    symbol: str('SYMBOL', 'R_100'), // Volatility 100 Index
    currency: str('CURRENCY', 'USD'),
    duration: num('DURATION', 5),
    durationUnit: str('DURATION_UNIT', 't'), // t = ticks, s = seconds, m = minutes

    // Strategy
    strategy: str('STRATEGY', 'sma_cross'), // sma_cross | momentum | rsi
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
  if (!cfg.paper && !cfg.apiToken) throw new Error('DERIV_API_TOKEN is required when PAPER_TRADING=false');
  if (cfg.paper && cfg.durationUnit !== 't') throw new Error('Paper trading only supports tick durations (DURATION_UNIT=t)');
  if (cfg.stake <= 0 || cfg.maxStake < cfg.stake) throw new Error('STAKE must be > 0 and MAX_STAKE >= STAKE');
  if (cfg.martingale < 1) throw new Error('MARTINGALE must be >= 1');
  if (cfg.fastPeriod >= cfg.slowPeriod) throw new Error('FAST_PERIOD must be smaller than SLOW_PERIOD');
  return cfg;
}
