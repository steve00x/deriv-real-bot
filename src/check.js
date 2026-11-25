// Live-mode connection check: logs in, opens the trading socket and asks for
// a quote for the configured contract, but NEVER buys.   npm run check
import { loadConfig, validateConfig } from './config.js';
import { DerivClient } from './derivClient.js';
import { resolveConnection } from './derivApi.js';
import { Bot } from './bot.js';
import { RiskManager } from './risk.js';
import { buildStrategy } from './strategy.js';
import { CONTRACTS, labelFor } from './contracts.js';
import { explainHigherLower } from './offers.js';

const log = { info: (m) => console.log(`OK    ${m}`), warn: (m) => console.warn(`WARN  ${m}`), error: (m) => console.error(`FAIL  ${m}`) };

export async function runCheck(env = process.env, { fetchImpl, client = new DerivClient({ log }) } = {}) {
  const cfg = validateConfig({ ...loadConfig(env), paper: false });
  log.info(`Settings loaded (App ID set, token set, symbol ${cfg.symbol}, stake ${cfg.stake})`);

  const { urls, account, needsAuthorize } = await resolveConnection(cfg, log, fetchImpl);
  if (account) log.info(`Selected account ${account.id} (${account.isVirtual ? 'DEMO' : 'REAL'})`);
  log.info('Got a one-time trading URL');

  await client.connect(urls);
  try {
    const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk: new RiskManager(cfg), log, account, needsAuthorize });
    if (needsAuthorize) {
      const { authorize } = await client.request({ authorize: cfg.apiToken });
      log.info(`Logged in as ${authorize.loginid} (${authorize.is_virtual ? 'DEMO' : 'REAL'})`);
    }
    const balance = await client.request({ balance: 1 }).catch((err) => {
      log.warn(`Could not read balance (${err.message}); continuing`);
      return null;
    });
    if (balance?.balance) log.info(`Balance: ${balance.balance.balance} ${balance.balance.currency}`);

    const type = CONTRACTS[cfg.contract].types[0];
    const params = bot.contractParams(type, cfg.stake);
    let proposal;
    try {
      ({ proposal } = await client.request({ proposal: 1, ...params }));
    } catch (err) {
      // Higher/Lower quotes fail when the barrier or duration isn't offered:
      // show what Deriv does offer so the fix is obvious.
      if (cfg.contract === 'higher_lower') {
        log.error(`Quote failed: ${err.message}`);
        await explainHigherLower(client, cfg).catch((e) => log.warn(`Could not list contracts: ${e.message}`));
      }
      throw err;
    }
    log.info(`Quote for a ${cfg.duration}${cfg.durationUnit} ${labelFor(cfg.contract, type)}${cfg.contract === 'higher_lower' ? ` (barrier ${cfg.barrier})` : ''} at stake ${cfg.stake}: payout ${proposal.payout} (nothing was bought)`);
    return { ok: true, payout: Number(proposal.payout), account };
  } finally {
    client.close();
  }
}

if (process.argv[1]?.endsWith('check.js')) {
  runCheck()
    .then(() => console.log('\nAll checks passed. Live demo trading should work: set PAPER_TRADING=false and run npm start.'))
    .catch((err) => {
      log.error(err.message);
      console.error('\nNothing was traded. Paste this output to get help.');
      process.exit(1);
    });
}
