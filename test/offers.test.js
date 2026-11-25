import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOffers, higherLowerOffers, adviseHigherLower, formatOffers, explainHigherLower } from '../src/offers.js';

// Shape of a legacy contracts_for response (trimmed).
const SAMPLE = {
  contracts_for: {
    available: [
      { contract_type: 'CALL', contract_display: 'Rise', barrier_category: 'euro_atm', barriers: 0, expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' },
      { contract_type: 'CALL', contract_display: 'Higher', barrier_category: 'euro_non_atm', barriers: 1, barrier: '+0.37', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
      { contract_type: 'PUT', contract_display: 'Lower', barrier_category: 'euro_non_atm', barriers: 1, barrier: '+0.37', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
      { contract_type: 'DIGITEVEN', barrier_category: 'non_financial', barriers: 0, expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' },
    ],
  },
};
const cfg = { symbol: 'R_100', durationUnit: 't', barrier: '+0.1' };

test('picks out Higher/Lower offers, not Rise/Fall or digits', () => {
  const o = higherLowerOffers(SAMPLE.contracts_for.available);
  assert.deepEqual(o.map((x) => x.side), ['HIGHER', 'LOWER']);
  assert.equal(o[0].barrier, '+0.37');
  assert.match(formatOffers(o), /HIGHER\s+intraday\s+15s - 1d\s+\+0\.37/);
});

test('advice: no tick Higher/Lower -> switch to the shortest allowed duration; use the suggested barrier', () => {
  const advice = adviseHigherLower(higherLowerOffers(SAMPLE.contracts_for.available), cfg).join('\n');
  assert.match(advice, /not offered in ticks\. The shortest duration is 15s/);
  assert.match(advice, /DURATION_UNIT=s and DURATION=15/);
  assert.match(advice, /suggested barrier for Higher is \+0\.37/);
});

test('advice: tick offers keep ticks and only suggest the barrier', () => {
  const tickOffer = [{ contract_type: 'CALL', barriers: 1, barrier: '+0.2', barrier_category: 'euro_non_atm', expiry_type: 'tick', min_contract_duration: '5t', max_contract_duration: '10t' }];
  const advice = adviseHigherLower(higherLowerOffers(tickOffer), cfg).join('\n');
  assert.doesNotMatch(advice, /not offered in ticks/);
  assert.match(advice, /BARRIER=\+0\.2/);
});

test('advice when Deriv lists no Higher/Lower at all', () => {
  assert.match(adviseHigherLower([], cfg).join('\n'), /does not offer Higher\/Lower on R_100/);
});

test('fetchOffers falls back to the Options API request form', async () => {
  const sent = [];
  const client = {
    async request(p) {
      sent.push(p);
      if (p.contracts_for === 'R_100') throw new Error('InputValidationFailed: contracts_for');
      return { data: { contracts: SAMPLE.contracts_for.available } };
    },
  };
  const offers = await fetchOffers(client, 'R_100');
  assert.equal(offers.length, 4);
  assert.deepEqual(sent[1], { contracts_for: 1, underlying_symbol: 'R_100' });
});

test('explainHigherLower prints the table and advice', async () => {
  const out = [];
  const client = { request: async () => SAMPLE };
  await explainHigherLower(client, cfg, (l) => out.push(l));
  const text = out.join('\n');
  assert.match(text, /Higher\/Lower contracts Deriv offers on R_100/);
  assert.match(text, /-> .*suggested barrier/);
});
