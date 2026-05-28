/**
 * Regression checks for Cinema Studio 3.5 credit confirmation.
 *
 * Run: node test/test-cinema-video-ledger.js
 */

const assert = require('assert');
const { CinemaVideoAutomation } = require('../src/main/automation/cinema-video-automation');

async function withImmediateTimers(fn) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (cb, _ms, ...args) => originalSetTimeout(cb, 0, ...args);
  try {
    return await fn();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

async function main() {
  const logs = [];
  const automation = new CinemaVideoAutomation({
    automation: { page: { context: () => ({}) } },
    logger: (msg) => logs.push(msg),
  });

  const liveRows = automation._parseCinemaCreditRowsFromText(`
    HISTORY Credits All features All actions Date
    52.5 credits Cinematic Studio 3.5 Video Spent May 27, 202612:38 AM
    52.5 credits Cinematic Studio 3.5 Video Spent May 26, 202611:53 PM
    +52.5 credits Cinematic Studio 3.5 Video Refunded May 26, 20268:26 PM
  `);
  assert.strictEqual(liveRows.length, 2, 'text fallback should parse spent rows and ignore refunds');
  assert.strictEqual(liveRows[0].cost, 52.5);
  assert.strictEqual(liveRows[0].dateText, 'May 27, 2026 12:38 AM');
  assert.match(liveRows[0].signature, /cinematic studio 3\.5 video/);

  await withImmediateTimers(async () => {
    let ledgerReads = 0;
    automation._detectCinemaGenerationInProgress = async () => ({ active: true, evidence: 'Processing' });
    automation._readCinemaCreditLedger = async () => {
      ledgerReads++;
      return [{
        signature: '52.5 credits cinematic studio 3.5 video spent may 27, 2026 12:38 am',
        cost: 52.5,
        dateText: 'May 27, 2026 12:38 AM',
        source: 'dom',
      }];
    };

    const result = await automation._confirmCinemaCreditSpend({
      expectedCost: 52.5,
      clickedAt: new Date(2026, 4, 27, 0, 38, 1),
      timeoutMs: 1000,
      baselineSignatures: [],
      generationPage: {},
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.ledgerConfirmed, true);
    assert.strictEqual(result.row.source, 'dom');
    assert(ledgerReads > 0, 'Processing state must still require ledger polling');
  });

  await withImmediateTimers(async () => {
    automation._detectCinemaGenerationInProgress = async () => ({ active: false, evidence: null });
    automation._readCinemaCreditLedger = async () => ([{
      signature: '52.5 credits cinematic studio 3.5 video spent may 26, 2026 9:00 pm',
      cost: 52.5,
      dateText: 'May 26, 2026 9:00 PM',
      source: 'dom',
    }]);

    const result = await automation._confirmCinemaCreditSpend({
      expectedCost: 52.5,
      clickedAt: new Date(2026, 4, 26, 21, 0, 20),
      timeoutMs: 1000,
      baselineSignatures: [],
      generationPage: {},
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.ledgerConfirmed, true);
    assert.strictEqual(result.row.cost, 52.5);
  });

  await withImmediateTimers(async () => {
    automation._detectCinemaGenerationInProgress = async () => ({ active: true, evidence: 'Processing' });
    automation._readCinemaCreditLedger = async () => [];

    const result = await automation._confirmCinemaCreditSpend({
      expectedCost: 52.5,
      clickedAt: new Date(2026, 4, 26, 21, 0, 20),
      timeoutMs: 1,
      baselineSignatures: [],
      generationPage: {},
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.ledgerConfirmed, false);
    assert.match(result.reason, /Processing\/Generating appeared in UI/);
  });

  await withImmediateTimers(async () => {
    automation._detectCinemaGenerationInProgress = async () => ({ active: false, evidence: null });
    automation._readCinemaCreditLedger = async () => [];

    const result = await automation._confirmCinemaCreditSpend({
      expectedCost: 52.5,
      clickedAt: new Date(2026, 4, 26, 21, 0, 20),
      timeoutMs: 0,
      baselineSignatures: [],
      generationPage: {},
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.accepted, false);
    assert.match(result.reason, /Cinema Studio/);
    assert(!/Kling/i.test(result.reason), 'Cinema ledger failure reason must not mention Kling');
  });

  assert(logs.some(line => /waiting for matching credit ledger row/.test(line)), 'should log UI processing acceptance while still waiting for ledger');
  assert(logs.some(line => /Credit ledger confirmed Cinema Studio spend/.test(line)), 'should log Cinema ledger confirmation');
  assert(!logs.some(line => /Kling row|Kling spend|No matching Kling/i.test(line)), 'Cinema path should not log Kling ledger language');

  console.log('cinema video ledger regression checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
