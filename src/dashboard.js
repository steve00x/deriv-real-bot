// Local web dashboard: http://localhost:3000 (DASHBOARD_PORT, 0 = off).
// Listens on 127.0.0.1 only, so it is reachable from this computer and nowhere else.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { CONTRACTS, labelFor, lastDigit } from './contracts.js';

const PAGE = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const MAX_PRICES = 300;
const MAX_DIGITS = 1000;
const MAX_TRADES = 500;
const MAX_LOGS = 60;

/** Collects everything the page shows, from bot events and log lines. */
export class DashboardState {
  constructor({ cfg, risk, account = null }) {
    this.cfg = cfg;
    this.risk = risk;
    this.account = account;
    this.status = 'starting';
    this.stopReason = null;
    this.startedAt = Date.now();
    this.decimals = 2;
    this.prices = []; // [time, price]
    this.digits = []; // recent last digits
    this.trades = [];
    this.open = null;
    this.logs = [];
  }

  attach(bot) {
    bot.on('ready', ({ prices, decimals }) => {
      this.status = 'running';
      this.decimals = decimals;
      this.account = bot.account ?? this.account;
      const now = Date.now();
      this.prices = prices.slice(-MAX_PRICES).map((p, i, a) => [now - (a.length - i) * 1000, p]);
      this.digits = prices.slice(-MAX_DIGITS).map((p) => lastDigit(p, decimals));
    });
    bot.on('price', ({ price, time }) => {
      this.decimals = bot.decimals ?? this.decimals;
      this.prices.push([time, price]);
      if (this.prices.length > MAX_PRICES) this.prices.shift();
      this.digits.push(lastDigit(price, this.decimals));
      if (this.digits.length > MAX_DIGITS) this.digits.shift();
    });
    bot.on('trade-open', (t) => {
      this.open = t;
    });
    bot.on('trade-close', (t) => {
      this.open = null;
      this.trades.push({ n: this.trades.length + 1, ...t, cumulative: this.risk.profit });
      if (this.trades.length > MAX_TRADES) this.trades.shift();
    });
    bot.on('trade-error', () => {
      this.open = null;
    });
    bot.on('stopped', ({ reason }) => {
      this.status = 'stopped';
      this.stopReason = reason;
    });
    return this;
  }

  addLog(level, message) {
    this.logs.push({ time: Date.now(), level, message: String(message) });
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.onLog?.();
  }

  snapshot() {
    const c = this.cfg;
    const r = this.risk;
    const even = this.digits.filter((d) => d % 2 === 0).length;
    const counts = Array.from({ length: 10 }, (_, d) => this.digits.filter((x) => x === d).length);
    return {
      now: Date.now(),
      status: this.status,
      stopReason: this.stopReason,
      startedAt: this.startedAt,
      config: {
        mode: c.paper ? 'PAPER' : 'LIVE',
        contract: c.contract,
        contractName: CONTRACTS[c.contract ?? 'rise_fall'].name,
        strategy: c.strategy,
        barrier: c.contract === 'higher_lower' ? c.barrier : null,
        tradeSide: c.contract !== 'even_odd' ? c.tradeSide : null,
        sideLabel: c.contract !== 'even_odd' && c.tradeSide !== 'both' ? labelFor(c.contract, c.tradeSide === 'higher' ? 'CALL' : 'PUT') : null,
        symbol: c.symbol,
        duration: `${c.duration}${c.durationUnit}`,
        stake: c.stake,
        takeProfit: c.takeProfit,
        stopLoss: c.stopLoss,
        maxTrades: c.maxTrades,
        maxConsecutiveLosses: c.maxConsecutiveLosses,
        breakEven: 1 / (1 + c.paperPayout),
      },
      account: this.account && { id: this.account.id, isVirtual: this.account.isVirtual, currency: this.account.currency },
      risk: {
        profit: r.profit,
        trades: r.trades,
        wins: r.wins,
        losses: r.losses,
        winRate: r.trades ? r.wins / r.trades : null,
        consecutiveLosses: r.consecutiveLosses,
        nextStake: r.nextStake(),
      },
      price: {
        last: this.prices.at(-1)?.[1] ?? null,
        decimals: this.decimals,
        series: this.prices,
      },
      digits: { sample: this.digits.length, counts, even, odd: this.digits.length - even },
      open: this.open,
      trades: this.trades,
      logs: this.logs,
    };
  }
}

const isLocalHost = (host = '') => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

/**
 * Start the HTTP server. Tries `port`, then the next 9 ports (so two bots can
 * run side by side). Resolves with { url, server, close }.
 */
export async function startDashboard({ state, bot, port = 3000, log, host = '127.0.0.1' }) {
  const clients = new Set();
  let pending = null;
  const broadcast = () => {
    // Throttle: at most ~4 updates a second.
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const data = `data: ${JSON.stringify(state.snapshot())}\n\n`;
      for (const res of clients) res.write(data);
    }, 250);
  };
  for (const ev of ['ready', 'price', 'trade-open', 'trade-close', 'trade-error', 'stopped']) bot.on(ev, broadcast);
  state.onLog = broadcast;

  const server = http.createServer((req, res) => {
    // Refuse requests addressed to other host names (DNS-rebinding protection).
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE);
    } else if (req.method === 'GET' && path === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(state.snapshot()));
    } else if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (req.method === 'POST' && path === '/api/stop') {
      // The custom header can't be sent by a plain cross-site form, so other
      // websites can't press Stop for you.
      if (req.headers['x-dashboard'] !== '1') {
        res.writeHead(403).end('Forbidden');
        return;
      }
      bot.stop('stopped from the dashboard');
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end('Not found');
    }
  });

  const listen = (p) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') resolve(null);
        else reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    });
  let bound = null;
  for (let p = port; p < port + 10 && bound == null; p++) bound = await listen(p);
  if (bound == null) throw new Error(`Dashboard: ports ${port}-${port + 9} are all in use (set DASHBOARD_PORT)`);

  const url = `http://localhost:${bound}`;
  log?.info(`Dashboard: ${url}`);
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 20_000);
  return {
    url,
    port: bound,
    server,
    close: () => {
      clearInterval(keepAlive);
      clearTimeout(pending);
      for (const res of clients) res.end();
      server.close();
    },
  };
}
