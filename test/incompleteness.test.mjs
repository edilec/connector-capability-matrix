import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { INCOMPLETE_RULES, analyzeSpecification, compareConnectorFile } from '../src/index.mjs'

/**
 * Every rule that marks a run incomplete, and a case that goes red when it
 * stops doing so.
 *
 * `incomplete` is the only thing that keeps an unanswered question from
 * producing a verdict. Deleting one such flag in another tool let an entirely
 * unread input report `pass`, with the whole suite still green -- so each rule
 * below is driven through the real entry point and the status is asserted
 * literally. Remove an id from `INCOMPLETE_RULES` and exactly one of these
 * turns red:
 *
 * - for an error-severity rule the status becomes `fail`, which is a verdict
 *   about a document nobody managed to read;
 * - for the seven warnings -- `capability-unclaimed`, `claim-unverified`,
 *   `evidence-inconclusive`, `no-capabilities-declared`,
 *   `no-connectors-declared`, `observation-unclaimed` and
 *   `rate-limit-undeclared` -- the status becomes `pass`, which is green on no
 *   evidence.
 *
 * The second case is why severity is not the guard for those seven. Their
 * `errors` count is zero and is asserted as zero here, so nothing but the
 * incompleteness of the run stands between them and exit 0. Four of them are
 * the acceptance property of this whole tool: a claim nobody verified must not
 * pass.
 */

const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))

const CASES = [
  { ruleId: 'capability-group-unknown', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'odd', group: 'telepathy' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'capability-id-duplicated', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'capability-id-invalid', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'has space', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'capability-malformed', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, 'nope'], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'capability-unclaimed', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'claim-malformed', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 7 } }] } },
  { ruleId: 'claim-state-unknown', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'partial' } }] } },
  { ruleId: 'claim-unknown-capability', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported', ghost: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'claim-unverified', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }] } },
  { ruleId: 'connector-id-duplicated', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'connector-id-invalid', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: '9lives' }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'connector-malformed', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, 'nope'], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'connector-version-invalid', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, version: 'v1', capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'evidence-inconclusive', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'inconclusive', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'no-capabilities-declared', errors: 0, input: { schemaVersion: '1', capabilities: [], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 } }] } },
  { ruleId: 'no-connectors-declared', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [] } },
  { ruleId: 'observation-conflict', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'unsupported', reference: 'notes/broke.md' }] } },
  { ruleId: 'observation-kind-unknown', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'vibes', result: 'supported', reference: 'notes/hunch.md' }] } },
  { ruleId: 'observation-malformed', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: '' }] } },
  { ruleId: 'observation-result-unknown', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'probably', reference: 'notes/hunch.md' }] } },
  { ruleId: 'observation-unclaimed', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'observation-unknown-capability', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'ghost', kind: 'contract-test', result: 'supported', reference: 'notes/other.md' }] } },
  { ruleId: 'observation-unknown-connector', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'ghost', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'notes/other.md' }] } },
  { ruleId: 'rate-limit-malformed', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 0, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'rate-limit-undeclared', errors: 0, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'schema-version-unsupported', input: { schemaVersion: '2', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'spec-malformed', input: [] },
  { ruleId: 'spec-not-json', input: '{ not json' },
  { ruleId: 'spec-not-utf8', bytes: new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]) },
  { ruleId: 'spec-too-deep', limits: { maxDepth: 1 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'spec-too-large', limits: { maxBytes: 10 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'spec-unreadable', missing: true },
  { ruleId: 'time-budget-exceeded', limits: { maxMillis: 0 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'too-many-capabilities', limits: { maxCapabilities: 1 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'too-many-claims', limits: { maxClaimsPerConnector: 1 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported', other: 'unsupported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'too-many-connectors', limits: { maxConnectors: 1 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: 'two', rateLimit: { requests: 1, windowSeconds: 1 } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] } },
  { ruleId: 'too-many-observations', limits: { maxObservations: 1 }, input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/again.contract.mjs' }] } },
  { ruleId: 'unknown-declaration-key', input: { schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }], extra: true } },]

for (const testCase of CASES) {
  test(`${testCase.ruleId} makes the run incomplete, so it can never report a verdict`, async (t) => {
    let result
    if (testCase.missing === true) {
      const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-incomplete-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      result = await compareConnectorFile(join(directory, 'absent.json'), { source: 'absent.json' })
    } else {
      result = analyzeSpecification({
        bytes: testCase.bytes ?? encode(testCase.input),
        source: 'incomplete.json',
        limits: testCase.limits ?? {},
      })
    }
    const { report } = result
    assert.equal(
      report.findings.some((finding) => finding.ruleId === testCase.ruleId),
      true,
      `the fixture for ${testCase.ruleId} emitted ${JSON.stringify(report.findings.map((finding) => finding.ruleId))}`,
    )
    assert.equal(report.status, 'incomplete')
    if (testCase.errors === 0) {
      // Nothing but the incompleteness of the run is keeping this off a pass.
      assert.equal(report.summary.errors, 0)
    }
  })
}

test('every rule that claims to make a run incomplete has a case here', () => {
  assert.deepEqual(CASES.map((testCase) => testCase.ruleId).sort(), [...INCOMPLETE_RULES].sort())
  assert.equal(CASES.length, 38)
})

test('the warnings that only incompleteness holds back are the ones named in the comment', () => {
  const held = CASES.filter((testCase) => testCase.errors === 0).map((testCase) => testCase.ruleId).sort()
  assert.deepEqual(held, [
    'capability-unclaimed',
    'claim-unverified',
    'evidence-inconclusive',
    'no-capabilities-declared',
    'no-connectors-declared',
    'observation-unclaimed',
    'rate-limit-undeclared',
  ])
})
