// Rise/Fall trading engine: watches ticks, asks the strategy for a signal,
// sizes the stake with the risk manager, and places (or simulates) the trade.
import { fmt } from './risk.js';

const HISTORY_SIZE = 500;

/**
 * Rise/Fall rules: Rise (CALL) wins if exit > entry, Fall (PUT) wins if exit < entry.
 * An exit equal to the entry loses both.
 */
export function riseFallOutcome(contractType, entry, exit) {
  if (contractType === 'CALL') return exit > entry ? 'won' : 'lost';
  if (contractType === 'PUT') return exit < entry ? 'won' : 'lost';
  throw new Error(`Unknown contract type ${contractType}`);
}

export class Bot {
  constructor({ cfg, client, strategy, risk, log }) {
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
  }

  /** Runs until a stop condition is hit. Resolves with the stop reason. */
  async run() {
    const { cfg, client, log } = this;

    if (cfg.apiToken) {
      const { authorize: acct } = await client.request({ authorize: cfg.apiToken });
      const kind = acct.is_virtual ? 'DEMO' : 'REAL';
      log.info(`Logged in as ${acct.loginid} (${kind}) balance=${acct.balance} ${acct.currency}`);
      if (!acct.is_virtual && !cfg.paper && !cfg.allowRealAccount) {
        throw new Error('Refusing to trade a REAL account. Use a demo token, or set ALLOW_REAL_ACCOUNT=true.');
      }
      this.currency = acct.currency || cfg.currency;
    }

    const { history } = await client.request({
      ticks_history: cfg.symbol,
      end: 'latest',
      count: Math.max(this.strategy.minHistory * 2, 100),
      style: 'ticks',
    });
    this.prices = history.prices.map(Number);
    log.info(`Loaded ${this.prices.length} ticks of ${cfg.symbol} history`);
    log.info(
      `Mode=${cfg.paper ? 'PAPER' : 'LIVE'} strategy=${this.strategy.name} ` +
        `contract=${cfg.duration}${cfg.durationUnit} stake=${cfg.stake} ${this.currency}`,
    );

    return new Promise((resolve) => {
      this.resolveRun = resolve;
      client.onClose = () => this.stop('connection lost');
      this.tickReq = client.subscribe({ ticks: cfg.symbol }, (msg) => {
        if (msg.error) return this.stop(`tick stream error: ${msg.error.message}`);
        this.tickSubId ??= msg.subscription?.id;
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
    this.resolveRun?.(reason);
  }

  onTick(price) {
    if (this.stopped) return;
    this.prices.push(price);
    if (this.prices.length > HISTORY_SIZE) this.prices.shift();

    if (this.paperTrade) this.advancePaperTrade(price);
    if (this.busy) return;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }

    const reason = this.risk.stopReason();
    if (reason) return this.stop(reason);

    const signal = this.strategy.decide(this.prices);
    if (!signal) return;

    this.busy = true;
    this.placeTrade(signal).catch((err) => {
      this.log.error(`Trade failed: ${err.message}`);
      this.paperTrade = null;
      this.busy = false;
      this.cooldown = this.cfg.cooldownTicks;
    });
  }

  contractParams(contractType, stake) {
    const { cfg } = this;
    return {
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: this.currency,
      duration: cfg.duration,
      duration_unit: cfg.durationUnit,
      symbol: cfg.symbol,
    };
  }

  async placeTrade(contractType) {
    const stake = this.risk.nextStake();
    const params = this.contractParams(contractType, stake);
    const label = contractType === 'CALL' ? 'RISE' : 'FALL';

    if (this.cfg.paper) {
      // Ask Deriv for a real quote so simulated payouts match the market.
      const { proposal } = await this.client.request({ proposal: 1, ...params });
      this.paperTrade = { contractType, stake, payout: Number(proposal.payout), entry: null, ticks: 0 };
      this.log.info(`[PAPER] ${label} stake=${stake} payout=${proposal.payout}`);
      return; // settled tick-by-tick in advancePaperTrade()
    }

    const { buy } = await this.client.request({ buy: 1, price: stake, parameters: params });
    this.log.info(`[LIVE] ${label} contract=${buy.contract_id} cost=${buy.buy_price} payout=${buy.payout}`);
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

    const outcome = riseFallOutcome(t.contractType, t.entry, price);
    const profit = outcome === 'won' ? t.payout - t.stake : -t.stake;
    this.paperTrade = null;
    this.settle(t.contractType === 'CALL' ? 'RISE' : 'FALL', profit, t.entry, price);
  }

  settle(label, profit, entry, exit) {
    this.risk.record(profit);
    const tag = this.cfg.paper ? '[PAPER]' : '[LIVE]';
    this.log.info(
      `${tag} ${label} ${profit > 0 ? 'WON ' : 'LOST'} ${fmt(profit)} (entry=${entry} exit=${exit}) | ${this.risk.summary()}`,
    );
    this.busy = false;
    this.cooldown = this.cfg.cooldownTicks;
  }
}
