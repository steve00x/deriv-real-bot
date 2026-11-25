// Trading engine: watches ticks, asks the strategy for a signal, sizes the
// stake with the risk manager, and places (or simulates) the trade.
// Supports Rise/Fall and Even/Odd contracts (see contracts.js).
import { EventEmitter } from 'node:events';
import { fmt } from './risk.js';
import { CONTRACTS, labelFor, contractOutcome, formatBarrier, inferDecimals, lastDigit } from './contracts.js';

const HISTORY_SIZE = 500;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Rise/Fall rules: Rise (CALL) wins if exit > entry, Fall (PUT) wins if exit < entry.
 * An exit equal to the entry loses both.
 */
export function riseFallOutcome(contractType, entry, exit) {
  if (contractType !== 'CALL' && contractType !== 'PUT') throw new Error(`Unknown contract type ${contractType}`);
  return contractOutcome(contractType, entry, exit);
}

/** Deriv's pip_size is a count of decimals (2); accept a pip value (0.01) too. */
export function decimalsFromPipSize(pip) {
  const n = Number(pip);
  if (!Number.isFinite(n) || n < 0) return null;
  if (Number.isInteger(n) && n <= 10) return n;
  if (n > 0 && n < 1) return Math.round(-Math.log10(n));
  return null;
}

/**
 * Events (used by the dashboard):
 *   ready        { prices, decimals }       history loaded, trading starts
 *   price        { price, time }            every tick
 *   trade-open   { label, stake, payout, time, contractId? }
 *   trade-close  { label, profit, won, entry, exit, digit, time }
 *   trade-error  { message, time }
 *   stopped      { reason, time }
 */
export class Bot extends EventEmitter {
  constructor({ cfg, client, strategy, risk, log, account = null, needsAuthorize = Boolean(cfg.apiToken) }) {
    super();
    this.cfg = cfg;
    this.client = client;
    this.strategy = strategy;
    this.risk = risk;
    this.log = log;
    this.prices = [];
    this.busy = false; // a trade is being placed or is open
    this.cooldown = 0;
    this.paperTrade = null;
    this.currency = cfg.currency;
    this.stopped = false;
    this.account = account; // set by the new-API login flow
    this.needsAuthorize = needsAuthorize; // legacy API: log in over the socket
    this.quoteFailed = false;
    this.decimals = 2; // decimal places the market quotes in (for Even/Odd digits)
  }

  /** Runs until a stop condition is hit. Resolves with the stop reason. */
  async run() {
    const { cfg, client, log } = this;

    if (this.needsAuthorize) {
      const { authorize: acct } = await client.request({ authorize: cfg.apiToken });
      this.account = { id: acct.loginid, isVirtual: Boolean(acct.is_virtual), currency: acct.currency, balance: acct.balance };
    }
    if (this.account) {
      const a = this.account;
      log.info(`Trading account ${a.id} (${a.isVirtual ? 'DEMO' : 'REAL'})${a.balance != null ? ` balance=${a.balance} ${a.currency ?? ''}` : ''}`);
      if (!a.isVirtual && !cfg.paper && !cfg.allowRealAccount) {
        throw new Error('Refusing to trade a REAL account. Use a demo account, or set ALLOW_REAL_ACCOUNT=true.');
      }
      this.currency = a.currency || cfg.currency;
    }

    const { history } = await client.request({
      ticks_history: cfg.symbol,
      end: 'latest',
      count: Math.max(this.strategy.minHistory * 2, 100),
      style: 'ticks',
    });
    this.prices = history.prices.map(Number);
    this.decimals = decimalsFromPipSize(history.pip_size) ?? inferDecimals(history.prices);
    log.info(`Loaded ${this.prices.length} ticks of ${cfg.symbol} history (${this.decimals} decimals)`);
    this.emit('ready', { prices: [...this.prices], decimals: this.decimals });
    log.info(
      `Mode=${cfg.paper ? 'PAPER' : 'LIVE'} contract=${CONTRACTS[cfg.contract ?? 'rise_fall'].name}` +
        `${cfg.contract === 'higher_lower' ? ` barrier=${formatBarrier(cfg.barrier)} side=${cfg.tradeSide}` : ''} strategy=${this.strategy.name} ` +
        `duration=${cfg.duration}${cfg.durationUnit} stake=${cfg.stake} ${this.currency}`,
    );

    return new Promise((resolve) => {
      this.resolveRun = resolve;
      client.onClose = () => this.stop('connection lost');
      this.tickReq = client.subscribe({ ticks: cfg.symbol }, (msg) => {
        if (msg.error) return this.stop(`tick stream error: ${msg.error.message}`);
        this.tickSubId ??= msg.subscription?.id;
        this.decimals = decimalsFromPipSize(msg.tick.pip_size) ?? this.decimals;
        this.onTick(Number(msg.tick.quote));
      });
    });
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.client.unsubscribe(this.tickReq, this.tickSubId);
    if (this.busy && !this.cfg.paper) {
      this.log.warn('A live contract is still open; it will settle on Deriv automatically.');
    }
    this.log.info(`Stopping: ${reason}`);
    this.log.info(`Session: ${this.risk.summary()}`);
    this.emit('stopped', { reason, time: Date.now() });
    this.resolveRun?.(reason);
  }

  onTick(price) {
    if (this.stopped) return;
    this.prices.push(price);
    if (this.prices.length > HISTORY_SIZE) this.prices.shift();
    this.emit('price', { price, time: Date.now() });

    if (this.paperTrade) this.advancePaperTrade(price);
    if (this.busy) return;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    const reason = this.risk.stopReason();
    if (reason) return this.stop(reason);

    const signal = this.strategy.decide(this.prices, { decimals: this.decimals });
    if (!signal) return;

    this.busy = true;
    this.placeTrade(signal).catch((err) => {
      this.log.error(`Trade failed: ${err.message}`);
      this.emit('trade-error', { message: err.message, time: Date.now() });
      this.paperTrade = null;
      this.busy = false;
      this.cooldown = this.cfg.cooldownTicks;
    });
  }

  /** Numeric Higher/Lower barrier offset (0 for other contracts). */
  barrierOffset() {
    return this.cfg.contract === 'higher_lower' ? Number(this.cfg.barrier) : 0;
  }

  contractParams(contractType, stake) {
    const { cfg } = this;
    const barrier = cfg.contract === 'higher_lower' ? { barrier: formatBarrier(cfg.barrier) } : {};
    return {
      ...barrier,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: this.currency,
      duration: cfg.duration,
      duration_unit: cfg.durationUnit,
      // The Options API renamed the legacy `symbol` field to `underlying_symbol`.
      [cfg.api === 'legacy' ? 'symbol' : 'underlying_symbol']: cfg.symbol,
    };
  }

  async placeTrade(contractType) {
    const stake = this.risk.nextStake();
    const params = this.contractParams(contractType, stake);
    const label = labelFor(this.cfg.contract, contractType);

    if (this.cfg.paper) {
      // Ask Deriv for a real quote so simulated payouts match the market; the
      // public feed may not allow quotes, so fall back to PAPER_PAYOUT.
      let payout = round2(stake * (1 + this.cfg.paperPayout));
      if (!this.quoteFailed) {
        try {
          const { proposal } = await this.client.request({ proposal: 1, ...params }, 10_000);
          payout = Number(proposal.payout);
        } catch (err) {
          this.quoteFailed = true;
          this.log.warn(`Deriv won't quote on this connection (${err.message}); simulating a ${this.cfg.paperPayout} payout ratio.`);
        }
      }
      this.paperTrade = { contractType, stake, payout, entry: null, ticks: 0 };
      this.log.info(`[PAPER] ${label} stake=${stake} payout=${payout}`);
      this.emit('trade-open', { label, stake, payout, time: Date.now() });
      return; // settled tick-by-tick in advancePaperTrade()
    }

    const { buy } = await this.client.request({ buy: 1, price: stake, parameters: params });
    this.log.info(`[LIVE] ${label} contract=${buy.contract_id} cost=${buy.buy_price} payout=${buy.payout}`);
    this.emit('trade-open', { label, stake: Number(buy.buy_price), payout: Number(buy.payout), contractId: buy.contract_id, time: Date.now() });
    const result = await this.waitForSettlement(buy.contract_id);
    this.settle(label, Number(result.profit), result.entry_spot, result.exit_spot);
  }

  waitForSettlement(contractId) {
    return new Promise((resolve, reject) => {
      let subId;
      const req = this.client.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg) => {
        if (msg.error) {
          this.client.unsubscribe(req, subId);
          return reject(new Error(msg.error.message));
        }
        subId ??= msg.subscription?.id;
        const poc = msg.proposal_open_contract;
        if (poc?.is_sold) {
          this.client.unsubscribe(req, subId);
          resolve(poc);
        }
      });
    });
  }

  advancePaperTrade(price) {
    const t = this.paperTrade;
    // Like Deriv, the entry spot is the first tick after the purchase.
    if (t.entry === null) {
      t.entry = price;
      return;
    }
    t.ticks += 1;
    if (t.ticks < this.cfg.duration) return;

    const outcome = contractOutcome(t.contractType, t.entry, price, this.decimals, this.barrierOffset());
    const profit = outcome === 'won' ? t.payout - t.stake : -t.stake;
    this.paperTrade = null;
    this.settle(labelFor(this.cfg.contract, t.contractType), profit, t.entry, price);
  }

  settle(label, profit, entry, exit) {
    this.risk.record(profit);
    const tag = this.cfg.paper ? '[PAPER]' : '[LIVE]';
    const exitDigit = exit != null ? lastDigit(exit, this.decimals) : null;
    const digit = this.cfg.contract === 'even_odd' && exitDigit != null ? ` last digit=${exitDigit}` : '';
    this.log.info(
      `${tag} ${label} ${profit > 0 ? 'WON ' : 'LOST'} ${fmt(profit)} (entry=${entry} exit=${exit}${digit}) | ${this.risk.summary()}`,
    );
    this.emit('trade-close', {
      label,
      profit,
      won: profit > 0,
      entry: entry != null ? Number(entry) : null,
      exit: exit != null ? Number(exit) : null,
      digit: exitDigit,
      time: Date.now(),
    });
    this.busy = false;
    this.cooldown = this.cfg.cooldownTicks;
  }
}
