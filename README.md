# Deriv Rise/Fall Bot

An automated trading bot for Deriv **Rise/Fall** contracts, written in plain JavaScript (Node.js 22+, no dependencies).

It streams live ticks over the [Deriv WebSocket API](https://api.deriv.com), asks a strategy whether to buy **Rise** (`CALL`) or **Fall** (`PUT`), and places the trade — or simulates it in paper mode — while a risk manager enforces stake size and stop conditions.

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
| Paper (default) | `PAPER_TRADING=true` | Uses the live price feed and real Deriv payout quotes, settles trades locally. Never buys. |
| Live, demo | `PAPER_TRADING=false`, demo `DERIV_API_TOKEN` | Places real contracts on your virtual account. |
| Live, real money | also `ALLOW_REAL_ACCOUNT=true` | Off by default. The bot refuses a real account unless you set this. |

Get a token at https://app.deriv.com/account/api-token with the **Read** and **Trade** scopes. Keep it in `.env`, which is git-ignored.

## Strategies (`STRATEGY=`)

- `sma_cross`: trend following. Buys Rise when the fast SMA crosses above the slow SMA, and Fall when it crosses below.
- `momentum`: buys in the direction of `MOMENTUM_WINDOW` consecutive ticks moving the same way.
- `rsi`: mean reversion. Buys Rise when RSI ≤ `RSI_LOW` and Fall when RSI ≥ `RSI_HIGH`.

To add your own, write a class with `minHistory` and `decide(prices)` that returns `'CALL'`, `'PUT'` or `null` in `src/strategy.js`, then register it in `buildStrategy`.

## Risk controls

The bot stops when any of these is hit: `TAKE_PROFIT`, `STOP_LOSS`, `MAX_TRADES` or `MAX_CONSECUTIVE_LOSSES`. It also stops if the next stake could push the session past the stop loss. `MARTINGALE` (stake × N after a loss, capped by `MAX_STAKE`) is off by default; it raises risk quickly. Press Ctrl+C to stop cleanly and print a summary. A live contract that is still open settles on Deriv by itself.

## Layout

```
src/index.js        entry point
src/bot.js          trading loop, paper and live execution
src/strategy.js     signal generators
src/risk.js         stake sizing and stop rules
src/derivClient.js  WebSocket API client (req_id routing, subscriptions, keep-alive)
src/config.js       env config and validation
test/               node:test unit tests (fake Deriv client)
```
