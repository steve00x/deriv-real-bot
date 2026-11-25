// Session risk management: stake sizing and stop conditions.

const round2 = (x) => Math.round(x * 100) / 100;

export class RiskManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.profit = 0;
    this.trades = 0;
    this.wins = 0;
    this.losses = 0;
    this.consecutiveLosses = 0;
    this.currentStake = cfg.stake;
  }

  nextStake() {
    return round2(Math.min(this.currentStake, this.cfg.maxStake));
  }

  record(profit) {
    this.trades += 1;
    this.profit = round2(this.profit + profit);
    if (profit > 0) {
      this.wins += 1;
      this.consecutiveLosses = 0;
      this.currentStake = this.cfg.stake;
    } else {
      this.losses += 1;
      this.consecutiveLosses += 1;
      this.currentStake = Math.min(this.currentStake * this.cfg.martingale, this.cfg.maxStake);
    }
  }

  /** Returns why trading must stop, or null if it may continue. */
  stopReason() {
    const c = this.cfg;
    if (this.profit >= c.takeProfit) return `take profit reached (${fmt(this.profit)})`;
    if (-this.profit >= c.stopLoss) return `stop loss reached (${fmt(this.profit)})`;
    if (this.trades >= c.maxTrades) return `max trades reached (${this.trades})`;
    if (this.consecutiveLosses >= c.maxConsecutiveLosses) return `${this.consecutiveLosses} consecutive losses`;
    // Never open a trade whose loss could blow through the stop loss.
    if (-this.profit + this.nextStake() > c.stopLoss + 1e-9) {
      return `next stake ${this.nextStake().toFixed(2)} would exceed stop loss`;
    }
    return null;
  }

  summary() {
    const rate = this.trades ? (this.wins / this.trades) * 100 : 0;
    return `trades=${this.trades} wins=${this.wins} losses=${this.losses} win_rate=${rate.toFixed(1)}% profit=${fmt(this.profit)}`;
  }
}

export const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
