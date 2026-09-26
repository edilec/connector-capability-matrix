import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself. Asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand in a test,
 * is three declarations agreeing with one another, and one coordinated edit
 * satisfies all three -- a catalog defended that way had forty error rules
 * survive being flipped to warnings.
 *
 * A behavioural test can be a fourth mirror, and the usual way is to drive the
 * real command line but compare against `CASES[i].severity`, a value in a map
 * the same edit touches. So this file shares nothing. It imports nothing from
 * `src/`. There is no table of cases, no expectation computed from one, and no
 * expectation named once and reused. Every rule below is a separate test that
 * runs the real command line over a real specification and states its outcome
 * as a literal:
 *
 * - the **exit code**, which no edit to a table can change;
 * - the **status** the report declares;
 * - the exact set of rule ids the run emitted, so a fixture cannot be carried
 *   by some other rule;
 * - `errors`, `warnings` and `info`, as literal counts;
 * - the **severity word the human report prints**, read off stdout.
 *
 * For a rule that also marks the run incomplete the exit code is 2 whatever its
 * severity, so there the literal counts and the printed word are what hold it:
 * downgrade `spec-not-json` to a warning and `errors` goes from 1 to 0,
 * `warnings` from 0 to 1, and the line a person reads starts with WARNING.
 *
 * `test/severity-table.test.mjs` checks that every rule in the table has a case
 * here, so a rule cannot be added without one.
 */

const json = (value) => JSON.stringify(value)

let workspace = null
function directory() {
  if (workspace === null) workspace = mkdtemp(join(tmpdir(), 'connector-matrix-severity-'))
  return workspace
}
after(async () => {
  if (workspace !== null) await rm(await workspace, { recursive: true, force: true })
})

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

/**
 * Run one specification through the real command line, twice: once for the
 * machine-readable report and once for the words a person reads.
 *
 * Nothing here carries an expectation. It writes the bytes, runs the binary and
 * hands back what came out; every expectation is written inline at its
 * assertion, in the test that makes it. A `null` document is a specification
 * that was never written, which is how the unreadable case is reached.
 */
async function run(name, document, flags = []) {
  const specPath = join(await directory(), `${name}.json`)
  if (document !== null) await writeFile(specPath, document)
  const machine = await runCli(['--spec', specPath, '--json', ...flags])
  const human = await runCli(['--spec', specPath, ...flags])
  const report = JSON.parse(machine.stdout)
  return {
    exitCode: machine.code,
    humanExitCode: human.code,
    report,
    rules: [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    line: (ruleId) => human.stdout.split('\n').find((entry) => entry.includes(` ${ruleId} `)) ?? '',
  }
}


test('capability-group-unknown is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'capability-group-unknown',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'odd', group: 'telepathy' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['capability-group-unknown'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('capability-group-unknown').startsWith('ERROR'), true, outcome.line('capability-group-unknown'))
})

test('capability-id-duplicated is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'capability-id-duplicated',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['capability-id-duplicated'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('capability-id-duplicated').startsWith('ERROR'), true, outcome.line('capability-id-duplicated'))
})

test('capability-id-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'capability-id-invalid',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'has space', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['capability-id-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('capability-id-invalid').startsWith('ERROR'), true, outcome.line('capability-id-invalid'))
})

test('capability-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'capability-malformed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, 'nope'], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['capability-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('capability-malformed').startsWith('ERROR'), true, outcome.line('capability-malformed'))
})

test('capability-unclaimed is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'capability-unclaimed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['capability-unclaimed'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('capability-unclaimed').startsWith('WARNING'), true, outcome.line('capability-unclaimed'))
})

test('capability-unsupported-everywhere is information: the run still passes and the command exits 0', async () => {
  const outcome = await run(
    'capability-unsupported-everywhere',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'unsupported' } }] }),
  )
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.report.status, 'pass')
  assert.deepEqual(outcome.rules, ['capability-unsupported-everywhere'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 1)
  assert.equal(outcome.humanExitCode, 0)
  assert.equal(outcome.line('capability-unsupported-everywhere').startsWith('INFO'), true, outcome.line('capability-unsupported-everywhere'))
})

test('claim-contradicted is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'claim-contradicted',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'unsupported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['capability-unsupported-everywhere', 'claim-contradicted'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 1)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('claim-contradicted').startsWith('ERROR'), true, outcome.line('claim-contradicted'))
})

test('claim-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'claim-malformed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 7 } }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['claim-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('claim-malformed').startsWith('ERROR'), true, outcome.line('claim-malformed'))
})

test('claim-state-unknown is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'claim-state-unknown',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'partial' } }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['claim-state-unknown'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('claim-state-unknown').startsWith('ERROR'), true, outcome.line('claim-state-unknown'))
})

test('claim-unknown-capability is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'claim-unknown-capability',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported', ghost: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['claim-unknown-capability'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('claim-unknown-capability').startsWith('ERROR'), true, outcome.line('claim-unknown-capability'))
})

test('claim-unverified is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'claim-unverified',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['claim-unverified'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('claim-unverified').startsWith('WARNING'), true, outcome.line('claim-unverified'))
})

test('connector-id-duplicated is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'connector-id-duplicated',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['connector-id-duplicated'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('connector-id-duplicated').startsWith('ERROR'), true, outcome.line('connector-id-duplicated'))
})

test('connector-id-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'connector-id-invalid',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: '9lives' }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['connector-id-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('connector-id-invalid').startsWith('ERROR'), true, outcome.line('connector-id-invalid'))
})

test('connector-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'connector-malformed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, 'nope'], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['connector-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('connector-malformed').startsWith('ERROR'), true, outcome.line('connector-malformed'))
})

test('connector-version-invalid is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'connector-version-invalid',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, version: 'v1', capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['connector-version-invalid'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('connector-version-invalid').startsWith('ERROR'), true, outcome.line('connector-version-invalid'))
})

test('evidence-inconclusive is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'evidence-inconclusive',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'inconclusive', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['evidence-inconclusive'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('evidence-inconclusive').startsWith('WARNING'), true, outcome.line('evidence-inconclusive'))
})

test('no-capabilities-declared is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'no-capabilities-declared',
    json({ schemaVersion: '1', capabilities: [], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 } }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['no-capabilities-declared'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('no-capabilities-declared').startsWith('WARNING'), true, outcome.line('no-capabilities-declared'))
})

test('no-connectors-declared is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'no-connectors-declared',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['no-connectors-declared'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('no-connectors-declared').startsWith('WARNING'), true, outcome.line('no-connectors-declared'))
})

test('observation-conflict is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-conflict',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'unsupported', reference: 'notes/broke.md' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-conflict'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-conflict').startsWith('ERROR'), true, outcome.line('observation-conflict'))
})

test('observation-kind-unknown is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-kind-unknown',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'vibes', result: 'supported', reference: 'notes/hunch.md' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-kind-unknown'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-kind-unknown').startsWith('ERROR'), true, outcome.line('observation-kind-unknown'))
})

test('observation-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-malformed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: '' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-malformed').startsWith('ERROR'), true, outcome.line('observation-malformed'))
})

test('observation-result-unknown is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-result-unknown',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'probably', reference: 'notes/hunch.md' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-result-unknown'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-result-unknown').startsWith('ERROR'), true, outcome.line('observation-result-unknown'))
})

test('observation-unclaimed is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-unclaimed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-unclaimed'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-unclaimed').startsWith('WARNING'), true, outcome.line('observation-unclaimed'))
})

test('observation-unknown-capability is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-unknown-capability',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'ghost', kind: 'contract-test', result: 'supported', reference: 'notes/other.md' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-unknown-capability'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-unknown-capability').startsWith('ERROR'), true, outcome.line('observation-unknown-capability'))
})

test('observation-unknown-connector is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'observation-unknown-connector',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'ghost', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'notes/other.md' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['observation-unknown-connector'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('observation-unknown-connector').startsWith('ERROR'), true, outcome.line('observation-unknown-connector'))
})

test('rate-limit-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'rate-limit-malformed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 0, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['rate-limit-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('rate-limit-malformed').startsWith('ERROR'), true, outcome.line('rate-limit-malformed'))
})

test('rate-limit-undeclared is a warning on a run that exits 2 either way', async () => {
  const outcome = await run(
    'rate-limit-undeclared',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['rate-limit-undeclared'])
  assert.equal(outcome.report.summary.errors, 0)
  assert.equal(outcome.report.summary.warnings, 1)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('rate-limit-undeclared').startsWith('WARNING'), true, outcome.line('rate-limit-undeclared'))
})

test('required-capability-unclaimed is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'required-capability-unclaimed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations', required: true }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 } }] }),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['required-capability-unclaimed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('required-capability-unclaimed').startsWith('ERROR'), true, outcome.line('required-capability-unclaimed'))
})

test('schema-version-unsupported is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'schema-version-unsupported',
    json({ schemaVersion: '2', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['schema-version-unsupported'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('schema-version-unsupported').startsWith('ERROR'), true, outcome.line('schema-version-unsupported'))
})

test('spec-malformed is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-malformed', json([]))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-malformed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-malformed').startsWith('ERROR'), true, outcome.line('spec-malformed'))
})

test('spec-not-json is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-not-json', '{ not json')
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-not-json'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-not-json').startsWith('ERROR'), true, outcome.line('spec-not-json'))
})

test('spec-not-utf8 is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-not-utf8', new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]))
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-not-utf8'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-not-utf8').startsWith('ERROR'), true, outcome.line('spec-not-utf8'))
})

test('spec-too-deep is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'spec-too-deep',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-depth', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-too-deep'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-too-deep').startsWith('ERROR'), true, outcome.line('spec-too-deep'))
})

test('spec-too-large is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'spec-too-large',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-bytes', '10'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-too-large'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-too-large').startsWith('ERROR'), true, outcome.line('spec-too-large'))
})

test('spec-unreadable is an error on a run that exits 2 either way', async () => {
  const outcome = await run('spec-unreadable', null)
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['spec-unreadable'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('spec-unreadable').startsWith('ERROR'), true, outcome.line('spec-unreadable'))
})

test('time-budget-exceeded is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'time-budget-exceeded',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-millis', '0'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['time-budget-exceeded'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('time-budget-exceeded').startsWith('ERROR'), true, outcome.line('time-budget-exceeded'))
})

test('too-many-capabilities is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-capabilities',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-capabilities', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-capabilities'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-capabilities').startsWith('ERROR'), true, outcome.line('too-many-capabilities'))
})

test('too-many-claims is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-claims',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }, { id: 'other', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported', other: 'unsupported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-claims-per-connector', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-claims'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-claims').startsWith('ERROR'), true, outcome.line('too-many-claims'))
})

test('too-many-connectors is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-connectors',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }, { id: 'two', rateLimit: { requests: 1, windowSeconds: 1 } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }), ['--max-connectors', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-connectors'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-connectors').startsWith('ERROR'), true, outcome.line('too-many-connectors'))
})

test('too-many-observations is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'too-many-observations',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }, { connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/again.contract.mjs' }] }), ['--max-observations', '1'],
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['too-many-observations'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('too-many-observations').startsWith('ERROR'), true, outcome.line('too-many-observations'))
})

test('unknown-declaration-key is an error on a run that exits 2 either way', async () => {
  const outcome = await run(
    'unknown-declaration-key',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'supported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }], extra: true }),
  )
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.report.status, 'incomplete')
  assert.deepEqual(outcome.rules, ['unknown-declaration-key'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 2)
  assert.equal(outcome.line('unknown-declaration-key').startsWith('ERROR'), true, outcome.line('unknown-declaration-key'))
})

test('unsupported-capability-observed is an error: the run fails and the command exits 1', async () => {
  const outcome = await run(
    'unsupported-capability-observed',
    json({ schemaVersion: '1', capabilities: [{ id: 'cap', group: 'operations' }], connectors: [{ id: 'con', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { cap: 'unsupported' } }], observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'test/cap.contract.mjs' }] }),
  )
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.report.status, 'fail')
  assert.deepEqual(outcome.rules, ['unsupported-capability-observed'])
  assert.equal(outcome.report.summary.errors, 1)
  assert.equal(outcome.report.summary.warnings, 0)
  assert.equal(outcome.report.summary.info, 0)
  assert.equal(outcome.humanExitCode, 1)
  assert.equal(outcome.line('unsupported-capability-observed').startsWith('ERROR'), true, outcome.line('unsupported-capability-observed'))
})
