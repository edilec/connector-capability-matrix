import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REPORT_SCHEMA_VERSION,
  TOOL_ID,
  analyzeSpecification,
  compareConnectorFile,
  formatReport,
} from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const run = (document, options = {}) => analyzeSpecification({ bytes: encode(document), source: 'connectors.json', ...options })

const CLEAN = {
  schemaVersion: '1',
  matrix: 'small',
  capabilities: [{ id: 'list-records', group: 'operations', required: true }],
  connectors: [{ id: 'acme', version: '1.2.3', rateLimit: { requests: 10, windowSeconds: 1 }, capabilities: { 'list-records': 'supported' } }],
  observations: [{ connector: 'acme', capability: 'list-records', kind: 'contract-test', result: 'supported', reference: 'test/acme.mjs' }],
}

test('the report envelope is the documented shape', () => {
  const { report } = run(CLEAN)
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.tool, 'connector-capability-matrix')
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.info, 0)
  assert.equal(report.summary.observations, 1)
})

test('a finding carries a relative file, a pointer and a bounded suggestion', () => {
  const { report } = run({ ...CLEAN, observations: [] })
  assert.equal(report.findings.length, 1)
  const [finding] = report.findings
  assert.equal(finding.ruleId, 'claim-unverified')
  assert.equal(finding.severity, 'warning')
  assert.equal(finding.location.file, 'connectors.json')
  assert.equal(finding.location.pointer, '/connectors/acme/capabilities/list-records')
  assert.equal(typeof finding.suggestion, 'string')
  assert.equal(Object.hasOwn(finding, 'evidence'), false)
})

test('a configuration error throws instead of becoming a finding', () => {
  // A run that never had a subject has nothing to report about, which is why
  // the CLI turns these into exit 2 with an empty stdout.
  assert.throws(() => analyzeSpecification({ bytes: encode(CLEAN), sorce: 'typo.json' }), /Unknown option "sorce"/)
  assert.throws(() => analyzeSpecification({ bytes: encode(CLEAN), limits: { maxCells: 4 } }), /Unknown limit "maxCells"/)
  assert.throws(() => analyzeSpecification({ bytes: encode(CLEAN), clock: 'noon' }), /clock must be a function/)
  assert.throws(() => analyzeSpecification({ bytes: encode(CLEAN), clock: () => 'noon' }), /finite number/)
  assert.throws(() => analyzeSpecification('a string'), /Options must be an object/)
  assert.throws(() => analyzeSpecification({ bytes: 'not bytes' }), /Uint8Array/)
})

test('a document with nothing in it is not a clean bill of health', () => {
  // "pass" with nothing checked is green on no evidence.
  const empty = run({ schemaVersion: '1', capabilities: [], connectors: [] })
  assert.equal(empty.report.summary.checked, 0)
  assert.notEqual(empty.report.status, 'pass')
  assert.equal(empty.report.status, 'incomplete')
  assert.deepEqual(empty.report.findings.map((finding) => finding.ruleId), ['no-capabilities-declared', 'no-connectors-declared'])

  const noConnectors = run({ schemaVersion: '1', capabilities: [{ id: 'a', group: 'operations' }], connectors: [] })
  assert.equal(noConnectors.report.summary.cells, 0)
  assert.equal(noConnectors.report.status, 'incomplete')
  assert.deepEqual(noConnectors.report.findings.map((finding) => finding.ruleId), ['no-connectors-declared'])
})

test('a run that checked no cell can never report a pass, whatever emptied it', () => {
  const documents = [
    { schemaVersion: '1', capabilities: [], connectors: [] },
    { schemaVersion: '1', capabilities: [{ id: 'a', group: 'operations' }], connectors: [] },
    { schemaVersion: '1', capabilities: [], connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 } }] },
    { schemaVersion: '1', capabilities: [{ id: 'a', group: 'telepathy' }], connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 } }] },
    { schemaVersion: '1', capabilities: [{ id: 'a', group: 'operations' }], connectors: ['not an object'] },
  ]
  for (const document of documents) {
    const { report } = run(document)
    assert.equal(report.summary.checked, 0)
    assert.notEqual(report.status, 'pass', `${JSON.stringify(document)} passed on no evidence`)
  }
})

test('the time budget is measured with the clock the caller injects', () => {
  let now = 0
  const clock = () => now
  assert.equal(run(CLEAN, { clock, limits: { maxMillis: 10 } }).report.status, 'pass')

  const spent = run(CLEAN, { clock: () => { now += 100; return now }, limits: { maxMillis: 10 } })
  assert.equal(spent.report.status, 'incomplete')
  assert.equal(spent.report.findings[0].ruleId, 'time-budget-exceeded')
  // Nothing derived from the clock reaches the report, so an elapsed time
  // cannot make two runs of the same document differ.
  assert.equal(JSON.stringify(spent.report).includes('100'), false)
})

test('a budget of zero is spent before any work is done', () => {
  const { report } = run(CLEAN, { limits: { maxMillis: 0 } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['time-budget-exceeded'])
  assert.equal(report.summary.checked, 0)
})

test('an unreadable file is an incomplete report, not a configuration error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-read-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { report } = await compareConnectorFile(join(directory, 'absent.json'), { source: 'absent.json' })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['spec-unreadable'])
  assert.equal(report.findings[0].location.file, 'absent.json')
  assert.match(report.findings[0].message, /ENOENT/)
})

test('compareConnectorFile reads a real file and reports on it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-read-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'connectors.json')
  await writeFile(path, JSON.stringify(CLEAN), 'utf8')
  const { report, matrix } = await compareConnectorFile(path, { source: 'connectors.json' })
  assert.equal(report.status, 'pass')
  assert.equal(matrix.connectors[0].version, '1.2.3')
  assert.deepEqual(matrix.connectors[0].rateLimit, { requests: 10, windowSeconds: 1, concurrency: null, retryAfterHonoured: null })
})

test('the human report states the counts, the status and every finding', () => {
  const { report, matrix } = run({ ...CLEAN, observations: [] })
  const text = formatReport(report, matrix)
  assert.equal(text.endsWith('\n'), true)
  assert.match(text, /matrix "small": 1 connector\(s\) x 1 capability\/ies, 1 cell\(s\) checked/)
  assert.match(text, /status incomplete/)
  assert.match(text, /0 error, 1 warning, 0 info/)
  assert.match(text, /^WARNING connectors\.json\/connectors\/acme\/capabilities\/list-records claim-unverified /m)
})

test('the human report survives a run that never reached the matrix', () => {
  const { report, matrix } = run('{ not json')
  const text = formatReport(report, matrix)
  assert.match(text, /\(unnamed matrix\)/)
  assert.match(text, /spec-not-json/)
  assert.equal(text.includes('legend:'), false)
})
