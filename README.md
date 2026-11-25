# Deriv Rise/Fall & Even/Odd Bot

An automated trading bot for Deriv **Rise/Fall** and **Even/Odd** contracts, written in plain JavaScript (Node.js 22+, no dependencies).

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

## Dashboard

While the bot runs, open **http://localhost:3000** in your browser. It updates live and shows:

- session profit, with progress toward your stop loss and take profit
- win rate against break-even, trade count, losing streak and next stake
- charts of profit over the session, the live price, and how often each last digit appears
- the open trade, every settled trade and the recent log
- a **Stop bot** button

The dashboard is only reachable from your own computer. When the bot stops, the page stays up so you can review the session; press Ctrl+C to close it. If you run two bots, the second one's dashboard is on port 3001. Set `DASHBOARD_PORT=0` to turn it off.

## Contracts (`CONTRACT=`)

- `rise_fall` (default): Rise wins if the exit price is above the entry price, Fall if it is below. A tie loses both.
- `higher_lower`: Higher wins if the exit price ends above `entry + BARRIER`, Lower if it ends below. On exactly the barrier, both lose. The barrier is an offset such as `+0.1` or `-0.25`, and Deriv sets the payout from it: an easy barrier pays little, a hard one pays more. Deriv only accepts barriers within a range around the price, and on some markets only offers Higher/Lower for seconds or minutes, not ticks. Run `npm run contracts` to see what it offers for your `SYMBOL`, including its suggested barrier. If Deriv answers "Invalid barrier" even with its own suggestion, the bot automatically tries other barrier formats (`BARRIER_FORMAT=auto`) and keeps the one Deriv accepts; `npm run check` reports which. `TRADE_SIDE=higher` (the default) makes the bot buy **only Higher**, whatever the strategy says; use `lower` or `both` to change that.
- `even_odd`: Even wins if the **last digit** of the exit price is even (0, 2, 4, 6, 8), Odd if it is odd. The digit is taken at the market's quoted precision, so on R_100 `428.50` ends in `0`. Duration must be 1-10 ticks.

## Strategies (`STRATEGY=`)

**Rise/Fall:**


- `sma_cross`: trend following. Buys Rise when the fast SMA crosses above the slow SMA, and Fall when it crosses below.
- `momentum`: buys in the direction of `MOMENTUM_WINDOW` consecutive ticks moving the same way.
- `rsi`: mean reversion. Buys Rise when RSI ≤ `RSI_LOW` and Fall when RSI ≥ `RSI_HIGH`.

- `random`: coin flip, as a baseline.

**Higher/Lower:**

- `always_higher` (default): buys Higher every time it is allowed to trade (after the cooldown).
- `always_lower`: buys Lower every time (needs `TRADE_SIDE=lower` or `both`).
- `sma_cross`, `momentum`, `rsi`, `random`: the Rise/Fall signals, used as Higher/Lower. With `TRADE_SIDE=higher`, their Lower signals are skipped.

**Even/Odd:**

- `digit_contrarian` (default): after `DIGIT_WINDOW` last digits in a row with the same parity, bets the other parity.
- `digit_follow`: after the same streak, bets that it continues.
- `random`: coin flip, as a baseline.

Last digits on Deriv's synthetic indices are random, so a streak says nothing about the next digit. Both digit strategies should score about 50% in the backtest. Check with `npm run backtest -- --contract even_odd`.

To add your own, write a class with `minHistory` and `decide(prices)` that returns `'CALL'`, `'PUT'` or `null` in `src/strategy.js`, then register it in `buildStrategy`.

## Going live on a demo account

1. Fill in `DERIV_APP_ID`, `DERIV_API_TOKEN` and your demo `DERIV_ACCOUNT_ID` in `.env`. The demo account ID usually starts with `VRTC` or `DOT`; leave it blank to let the bot pick your demo account.
2. Run `npm run check`. It logs in, opens the trading connection and asks Deriv for a Rise quote, but **never buys**. Fix anything it reports before going further.
3. Set `PAPER_TRADING=false` and run `npm start`.

## Backtesting

```bash
npm run backtest                          # last 5000 ticks of SYMBOL
npm run backtest -- --ticks 30000         # more history (downloaded 5000 at a time)
npm run backtest -- --symbol 1HZ100V      # another market
npm run backtest -- --contract even_odd   # Even/Odd strategies
npm run backtest -- --contract higher_lower --barrier +0.1   # Higher/Lower (real Deriv payouts)
```

This downloads real tick history from the public feed and replays it through every strategy, plus a **random coin-flip baseline**. It uses the same rules as paper trading: entry on the tick after the signal, exit `DURATION` ticks later, `COOLDOWN_TICKS` between trades, stake 1, and a win paying `PAPER_PAYOUT`. Strategy settings come from `.env`.

For each strategy it reports trades, win rate, profit, worst drawdown and longest losing streak, plus a verdict. A strategy only counts as **beating break-even** (about 51.3% at a 0.95 payout) if its win rate is at least 2 standard errors above it. Otherwise a lucky run can't be told apart from a real edge. If a strategy looks good, run it again on a different stretch of data before trusting it.

## Risk controls

The bot stops when any of these is hit: `TAKE_PROFIT`, `STOP_LOSS`, `MAX_TRADES` or `MAX_CONSECUTIVE_LOSSES`. It also stops if the next stake could push the session past the stop loss. `MARTINGALE` (stake × N after a loss, capped by `MAX_STAKE`) is off by default; it raises risk quickly. Press Ctrl+C to stop cleanly and print a summary. A live contract that is still open settles on Deriv by itself.

## Layout

```
src/index.js        entry point
src/dashboard.js    local web dashboard server (dashboard.html is the page)
src/bot.js          trading loop, paper and live execution
src/contracts.js    contract types and how each one is settled
src/strategy.js     signal generators
src/backtest.js     replays tick history through all strategies
src/risk.js         stake sizing and stop rules
src/derivApi.js     picks the WebSocket URL (public feed, or PAT + OTP login)
src/derivClient.js  WebSocket client (req_id routing, subscriptions, keep-alive, diagnostics)
src/config.js       env config and validation
test/               node:test unit tests (fake Deriv client)
```
