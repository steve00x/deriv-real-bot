import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { RiskManager } from '../src/risk.js';
import { buildStrategy } from '../src/strategy.js';
import { loadConfig, validateConfig } from '../src/config.js';

const quiet = { info() {}, warn() {}, error() {} };

function makeBot(env = {}, accept) {
  const cfg = {
    ...validateConfig(loadConfig({ CONTRACT: 'higher_lower', BARRIER: '+0.07', PAPER_TRADING: 'false', DERIV_API_TOKEN: 't', DERIV_APP_ID: 'a', ...env })),
    cooldownTicks: 0,
    maxTrades: 1,
  };
  const sent = [];
  const logs = [];
  const client = {
    async request(p) {
      sent.push(p);
      const params = p.parameters ?? p;
      if (p.buy) {
        if (!accept(params.barrier)) throw new Error('ContractBuyValidationError: Invalid barrier.');
        return { buy: { contract_id: 1, buy_price: 1, payout: 2.5 } };
      }
      if (p.proposal) {
        if (!accept(params.barrier)) throw new Error('ContractBuyValidationError: Invalid barrier.');
        return { proposal: { payout: 2.5 } };
      }
      return {};
    },
  };
  const bot = new Bot({ cfg, client, strategy: buildStrategy(cfg), risk: new RiskManager(cfg), log: { ...quiet, info: (m) => logs.push(m) } });
  bot.prices = [428.5, 428.55];
  bot.decimals = 2;
  return { bot, sent, logs };
}

const quote = (bot) => bot.withBarrierFormats('CALL', 1, (p) => bot.client.request({ proposal: 1, ...p }));

test('the documented relative string is tried first and kept if accepted', async () => {
  const { bot, sent } = makeBot({}, () => true);
  const r = await quote(bot);
  assert.equal(r.format, 'relative');
  assert.equal(sent[0].barrier, '+0.07');
});

test('falls back to a number when the string is rejected, and remembers it', async () => {
  const { bot, sent, logs } = makeBot({}, (b) => typeof b === 'number');
  const r = await quote(bot);
  assert.equal(r.format, 'relative_number');
  assert.equal(r.params.barrier, 0.07);
  assert.ok(logs.some((m) => /accepted the barrier as a relative offset number/.test(m)));
  sent.length = 0;
  await quote(bot);
  assert.equal(sent.length, 1, 'no second search once a format works');
});

test('falls back to an absolute price level', async () => {
  const { bot } = makeBot({}, (b) => typeof b === 'string' && !/^[+-]/.test(b));
  const r = await quote(bot);
  assert.equal(r.format, 'absolute');
  assert.equal(r.params.barrier, '428.62'); // 428.55 + 0.07
});

test('every format rejected -> one error listing each attempt', async () => {
  const { bot } = makeBot({}, () => false);
  await assert.rejects(quote(bot), (err) => {
    assert.match(err.message, /rejected the barrier in every format/);
    assert.match(err.message, /relative \("\+0\.07"\)/);
    assert.match(err.message, /relative_number \(0\.07\)/);
    assert.match(err.message, /absolute \("428\.62"\)/);
    return true;
  });
});

test('non-barrier errors are not retried', async () => {
  const { bot, sent } = makeBot({}, () => true);
  bot.client.request = async (p) => {
    sent.push(p);
    throw new Error('InsufficientBalance: not enough money');
  };
  await assert.rejects(quote(bot), /InsufficientBalance/);
  assert.equal(sent.length, 1);
});

test('BARRIER_FORMAT pins one format with no search', async () => {
  const { bot, sent } = makeBot({ BARRIER_FORMAT: 'absolute' }, () => false);
  await assert.rejects(quote(bot), /Invalid barrier/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].barrier, '428.62');
  assert.throws(() => validateConfig(loadConfig({ CONTRACT: 'higher_lower', BARRIER_FORMAT: 'weird' })), /BARRIER_FORMAT must be/);
});

test('live buy retries the barrier format and completes the trade', async () => {
  const { bot, sent } = makeBot({}, (b) => typeof b === 'number');
  bot.waitForSettlement = async () => ({ profit: '1.50', entry_spot: 428.55, exit_spot: 428.7 });
  await bot.placeTrade('CALL');
  const buys = sent.filter((p) => p.buy);
  assert.equal(buys.length, 2);
  assert.equal(buys[1].parameters.barrier, 0.07);
  assert.equal(bot.risk.profit, 1.5);
});

test('paper trade with an absolute barrier settles against that fixed level', async () => {
  const env = { PAPER_TRADING: 'true', DURATION: '1' };
  const { bot } = makeBot(env, (b) => typeof b === 'string' && !/^[+-]/.test(b));
  await bot.placeTrade('CALL'); // barrier fixed at 428.55 + 0.07 = 428.62
  bot.advancePaperTrade(428.6); // entry (a relative barrier would now be 428.67)
  bot.advancePaperTrade(428.65); // exit: above 428.62 -> won (would lose against 428.67)
  assert.equal(bot.risk.trades, 1);
  assert.equal(bot.risk.profit, 1.5);
});
