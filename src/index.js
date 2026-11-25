#!/usr/bin/env node
// Entry point: node src/index.js   (or: npm start)
import { loadConfig, validateConfig } from './config.js';
import { DerivClient } from './derivClient.js';
import { resolveConnection } from './derivApi.js';
import { buildStrategy } from './strategy.js';
import { RiskManager } from './risk.js';
import { Bot } from './bot.js';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (m) => console.log(`${stamp()} INFO  ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN  ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

async function main() {
  const cfg = validateConfig(loadConfig());
  const { urls, account, needsAuthorize } = await resolveConnection(cfg, log);
  const client = new DerivClient({ log });
  const bot = new Bot({
    cfg,
    client,
    strategy: buildStrategy(cfg),
    risk: new RiskManager(cfg),
    log,
    account,
    needsAuthorize,
  });

  process.once('SIGINT', () => bot.stop('stopped by user (Ctrl+C)'));
  process.once('SIGTERM', () => bot.stop('terminated'));

  await client.connect(urls);
  try {
    await bot.run();
  } finally {
    client.close();
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
