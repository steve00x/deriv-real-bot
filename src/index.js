#!/usr/bin/env node
// Entry point: node src/index.js   (or: npm start)
import { loadConfig, validateConfig } from './config.js';
import { DerivClient } from './derivClient.js';
import { resolveConnection } from './derivApi.js';
import { buildStrategy } from './strategy.js';
import { RiskManager } from './risk.js';
import { Bot } from './bot.js';
import { DashboardState, startDashboard } from './dashboard.js';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const sinks = []; // extra log listeners (the dashboard)
const emit = (level, m) => sinks.forEach((fn) => fn(level, m));
const log = {
  info: (m) => (console.log(`${stamp()} INFO  ${m}`), emit('info', m)),
  warn: (m) => (console.warn(`${stamp()} WARN  ${m}`), emit('warn', m)),
  error: (m) => (console.error(`${stamp()} ERROR ${m}`), emit('error', m)),
};

async function main() {
  const cfg = validateConfig(loadConfig());
  const risk = new RiskManager(cfg);
  const client = new DerivClient({ log });

  // Start the dashboard first so it can show the login and connection steps.
  let dashboard = null;
  let state = null;
  if (cfg.dashboardPort > 0) {
    state = new DashboardState({ cfg, risk });
    sinks.push((level, m) => state.addLog(level, m));
  }

  const { urls, account, needsAuthorize } = await resolveConnection(cfg, log);
  // Reconnecting needs a fresh URL: in live mode the one-time password is single use.
  const reconnect = async () => {
    const fresh = await resolveConnection(cfg, log);
    await client.connect(fresh.urls);
  };
  const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk, log, account, needsAuthorize, reconnect });

  if (state) {
    state.account = account;
    state.attach(bot);
    dashboard = await startDashboard({ state, bot, port: cfg.dashboardPort, log });
  }

  // First Ctrl+C stops trading; once stopped, Ctrl+C exits (and closes the dashboard).
  const onSignal = (reason) => {
    if (bot.stopped) {
      dashboard?.close();
      process.exit(0);
    }
    bot.stop(reason);
  };
  process.on('SIGINT', () => onSignal('stopped by user (Ctrl+C)'));
  process.on('SIGTERM', () => onSignal('terminated'));

  await client.connect(urls);
  try {
    await bot.run();
  } finally {
    client.close();
  }

  if (dashboard) {
    log.info(`Bot stopped. The dashboard stays open at ${dashboard.url} - press Ctrl+C to exit.`);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
