# Deriv Rise/Fall Bot

An automated trading bot for Deriv **Rise/Fall** contracts, written in plain JavaScript (Node.js 22+, no dependencies).

It streams live ticks over the [Deriv Options API](https://developers.deriv.com/docs/options/), asks a strategy whether to buy **Rise** (`CALL`) or **Fall** (`PUT`), and places the trade — or simulates it in paper mode — while a risk manager enforces stake size and stop conditions.

> ⚠️ **Risk warning.** Rise/Fall contracts pay less than 1:1 (about 0.95 per 1 staked), so you need to win more than ~51% of trades just to break even. The Volatility indices are random by design, so no indicator gives a reliable edge on them. Treat this as a tool for experimenting: run it in paper mode and on a demo account first, and only risk money you can afford to lose.

## Quick start

```bash
cp .env.example .env
npm start          # paper trading, no account needed
npm test
```

## Modes

| Mode | Settings | What happens |
|---|---|---|
| Paper (default) | `PAPER_TRADING=true` | Connects to Deriv's public market-data feed (no account needed), settles simulated trades locally. Never buys. |
| Live, demo | `PAPER_TRADING=false` + `DERIV_APP_ID` + `DERIV_API_TOKEN` | Places real contracts on your demo account. |
| Live, real money | also `ALLOW_REAL_ACCOUNT=true` | Off by default. The bot refuses a real account unless you set this. |

## Connecting to Deriv

Deriv replaced the old `wss://ws.derivws.com/websockets/v3?app_id=1089` endpoint with the **Options API** at `api.derivws.com`. The old endpoint now often fails with `HTTP 520`.

- **Paper mode** uses the public feed `wss://api.derivws.com/trading/v1/options/ws/public`. No login is needed.
- **Live mode** sends your Personal Access Token and App ID to `GET /trading/v1/options/accounts`. It picks your demo account (or `DERIV_ACCOUNT_ID`), then calls `POST /accounts/{id}/otp` to get a one-time WebSocket URL. That URL is valid for 120 seconds and can be used once.

To set up live trading, register an app and create a token (Trade scope) at https://developers.deriv.com, then put both in `.env`. Keep `.env` private; it is git-ignored. `DERIV_API=legacy` switches back to the old endpoint if you need it.

## Strategies (`STRATEGY=`)

- `sma_cross`: trend following. Buys Rise when the fast SMA crosses above the slow SMA, and Fall when it crosses below.
- `momentum`: buys in the direction of `MOMENTUM_WINDOW` consecutive ticks moving the same way.
- `rsi`: mean reversion. Buys Rise when RSI ≤ `RSI_LOW` and Fall when RSI ≥ `RSI_HIGH`.

To add your own, write a class with `minHistory` and `decide(prices)` that returns `'CALL'`, `'PUT'` or `null` in `src/strategy.js`, then register it in `buildStrategy`.

## Backtesting

```bash
npm run backtest                          # last 5000 ticks of SYMBOL
npm run backtest -- --ticks 30000         # more history (downloaded 5000 at a time)
npm run backtest -- --symbol 1HZ100V      # another market
```

This downloads real tick history from the public feed and replays it through every strategy, plus a **random coin-flip baseline**. It uses the same rules as paper trading: entry on the tick after the signal, exit `DURATION` ticks later, `COOLDOWN_TICKS` between trades, stake 1, and a win paying `PAPER_PAYOUT`. Strategy settings come from `.env`.

For each strategy it reports trades, win rate, profit, worst drawdown and longest losing streak, plus a verdict. A strategy only counts as **beating break-even** (about 51.3% at a 0.95 payout) if its win rate is at least 2 standard errors above it. Otherwise a lucky run can't be told apart from a real edge. If a strategy looks good, run it again on a different stretch of data before trusting it.

## Risk controls

The bot stops when any of these is hit: `TAKE_PROFIT`, `STOP_LOSS`, `MAX_TRADES` or `MAX_CONSECUTIVE_LOSSES`. It also stops if the next stake could push the session past the stop loss. `MARTINGALE` (stake × N after a loss, capped by `MAX_STAKE`) is off by default; it raises risk quickly. Press Ctrl+C to stop cleanly and print a summary. A live contract that is still open settles on Deriv by itself.

## Layout

```
src/index.js        entry point
src/bot.js          trading loop, paper and live execution
src/strategy.js     signal generators
src/backtest.js     replays tick history through all strategies
src/risk.js         stake sizing and stop rules
src/derivApi.js     picks the WebSocket URL (public feed, or PAT + OTP login)
src/derivClient.js  WebSocket client (req_id routing, subscriptions, keep-alive, diagnostics)
src/config.js       env config and validation
test/               node:test unit tests (fake Deriv client)
```
