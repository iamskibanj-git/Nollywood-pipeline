const assert = require('assert');
const { CinemaStudioAutomation } = require('../src/main/automation/cinema-studio-automation');

const studio = new CinemaStudioAutomation({
  automation: { page: null },
  logger: () => {},
});

assert.strictEqual(
  studio._optionMatchesElementName('zaram_o1_tbdfn_0528', 'zaram_o1_tbdfn_0528'),
  true,
  'exact option text should match'
);

assert.strictEqual(
  studio._optionMatchesElementName('mama_zaram_o1_tbdfn_0528', 'zaram_o1_tbdfn_0528'),
  false,
  'longer colliding element name must not match by substring'
);

assert.strictEqual(
  studio._optionMatchesElementName('Character\nzaram_o1_tbdfn_0528', 'zaram_o1_tbdfn_0528'),
  true,
  'option text with labels should match only by exact token'
);

assert.strictEqual(
  studio._isStartFrameProofValid(
    { batchOk: false, putOk: false, finalizeOk: false },
    { attached: true, method: 'plus-has-img' }
  ),
  false,
  'thumbnail-only reference should not pass the start-frame gate'
);

assert.strictEqual(
  studio._isStartFrameProofValid(
    { batchOk: true, putOk: true, finalizeOk: false },
    { attached: true, method: 'plus-has-img' }
  ),
  true,
  'batch plus remote PUT plus thumbnail should pass'
);

assert.strictEqual(
  studio._isStartFrameProofValid(
    { batchOk: false, putOk: false, finalizeOk: true },
    { attached: true, method: 'plus-has-img' }
  ),
  true,
  'final media upload plus thumbnail should pass'
);

assert.strictEqual(
  studio._isStartFrameProofValid(
    { batchOk: true, putOk: true, finalizeOk: true },
    { attached: false }
  ),
  false,
  'backend-confirmed upload still fails without active reference attachment'
);

console.log('cinema studio reference gates: ok');
