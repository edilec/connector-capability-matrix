import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, analyzeSpecification } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * Every documented limit, from both sides of the bound.
 *
 * A limit tested only from the outside proves that some number is refused; it
 * does not prove the bound is where the documentation says it is. An off-by-one
 * here is the difference between a document that is compared and one that is
 * refused, so each case runs the largest input the limit allows and then one
 * item more.
 */

const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const run = (document, limits) => analyzeSpecification({ bytes: encode(document), source: 'limits.json', limits })
const capability = (index) => ({ id: `cap-${index}`, group: 'operations' })
const connector = (index) => ({ id: `con-${index}`, rateLimit: { requests: 1, windowSeconds: 1 } })
const ruleIds = (result) => result.report.findings.map((finding) => finding.ruleId)

test('maxCapabilities: the last capability that fits is compared, and one more is refused whole', () => {
  const document = (count) => ({
    schemaVersion: '1',
    capabilities: Array.from({ length: count }, (_, index) => capability(index)),
    connectors: [connector(0)],
  })
  const atBound = run(document(3), { maxCapabilities: 3 })
  assert.equal(atBound.report.summary.capabilities, 3)
  assert.equal(ruleIds(atBound).includes('too-many-capabilities'), false)

  const over = run(document(4), { maxCapabilities: 3 })
  assert.deepEqual(ruleIds(over), ['too-many-capabilities'])
  assert.equal(over.report.status, 'incomplete')
  // Refused whole, not truncated to the first three.
  assert.equal(over.report.summary.capabilities, 0)
  assert.equal(over.report.summary.declaredCapabilities, 4)
})

test('maxConnectors: the last connector that fits is compared, and one more is refused whole', () => {
  const document = (count) => ({
    schemaVersion: '1',
    capabilities: [capability(0)],
    connectors: Array.from({ length: count }, (_, index) => connector(index)),
  })
  assert.equal(run(document(2), { maxConnectors: 2 }).report.summary.connectors, 2)
  const over = run(document(3), { maxConnectors: 2 })
  assert.deepEqual(ruleIds(over), ['too-many-connectors'])
  assert.equal(over.report.summary.connectors, 0)
  assert.equal(over.report.summary.declaredConnectors, 3)
})

test('maxObservations: the last observation that fits is read, and one more refuses the document', () => {
  const document = (count) => ({
    schemaVersion: '1',
    capabilities: [capability(0)],
    connectors: [{ ...connector(0), capabilities: { 'cap-0': 'supported' } }],
    observations: Array.from({ length: count }, (_, index) => ({
      connector: 'con-0', capability: 'cap-0', kind: 'contract-test', result: 'supported', reference: `test/${index}.mjs`,
    })),
  })
  const atBound = run(document(2), { maxObservations: 2 })
  assert.equal(atBound.report.summary.observations, 2)
  assert.equal(atBound.report.status, 'pass')

  const over = run(document(3), { maxObservations: 2 })
  assert.deepEqual(ruleIds(over), ['too-many-observations'])
  assert.equal(over.report.summary.observations, 0)
  // No claim could be verified once the evidence was refused, and the run says
  // so rather than reporting the claims as unsupported.
  assert.equal(over.report.status, 'incomplete')
})

test('maxClaimsPerConnector: the connector at the bound is compared, one claim more is refused', () => {
  const document = (count) => ({
    schemaVersion: '1',
    capabilities: Array.from({ length: count }, (_, index) => capability(index)),
    connectors: [{
      ...connector(0),
      capabilities: Object.fromEntries(Array.from({ length: count }, (_, index) => [`cap-${index}`, 'unsupported'])),
    }],
  })
  assert.equal(run(document(2), { maxClaimsPerConnector: 2 }).report.status, 'pass')
  const over = run(document(3), { maxClaimsPerConnector: 2 })
  assert.deepEqual(ruleIds(over), ['too-many-claims'])
  assert.equal(over.report.summary.connectors, 0)
  assert.equal(over.report.summary.capabilities, 3, 'a connector-level limit refused more than the connector')
})

test('maxBytes: a document of exactly the budget is read, one byte more is not', () => {
  const document = { schemaVersion: '1', capabilities: [capability(0)], connectors: [connector(0)] }
  const size = encode(document).byteLength
  assert.equal(run(document, { maxBytes: size }).report.summary.capabilities, 1)
  const over = run(document, { maxBytes: size - 1 })
  assert.deepEqual(ruleIds(over), ['spec-too-large'])
  assert.match(over.report.findings[0].message, new RegExp(`${size} bytes`))
})

test('maxDepth: the deepest legal document is compared and one level deeper is refused', () => {
  const document = {
    schemaVersion: '1',
    capabilities: [capability(0)],
    connectors: [{ ...connector(0), capabilities: { 'cap-0': { state: 'unsupported' } } }],
  }
  assert.equal(run(document, { maxDepth: 6 }).report.status, 'pass')
  assert.deepEqual(ruleIds(run(document, { maxDepth: 5 })), ['spec-too-deep'])
})

test('maxMillis: a budget that is not spent changes nothing, and one that is stops the run', () => {
  const document = { schemaVersion: '1', capabilities: [capability(0)], connectors: [{ ...connector(0), capabilities: { 'cap-0': 'unsupported' } }] }
  let now = 0
  assert.equal(analyzeSpecification({ bytes: encode(document), limits: { maxMillis: 5 }, clock: () => now }).report.status, 'pass')
  const spent = analyzeSpecification({
    bytes: encode(document),
    limits: { maxMillis: 5 },
    clock: () => { const value = now; now += 5; return value },
  })
  assert.deepEqual(spent.report.findings.map((finding) => finding.ruleId), ['time-budget-exceeded'])
})

test('every documented default is a real default, and every flag reaches the analysis', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-limits-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'connectors.json')
  const claims = { 'cap-0': 'unsupported', 'cap-1': 'unsupported' }
  await writeFile(path, JSON.stringify({
    schemaVersion: '1',
    capabilities: [capability(0), capability(1)],
    connectors: [{ ...connector(0), capabilities: claims }, { ...connector(1), capabilities: claims }],
    observations: [
      { connector: 'con-0', capability: 'cap-0', kind: 'manual-check', result: 'unsupported', reference: 'notes/one.md' },
      { connector: 'con-1', capability: 'cap-0', kind: 'manual-check', result: 'unsupported', reference: 'notes/two.md' },
    ],
  }), 'utf8')

  // The document passes cleanly on the defaults -- nothing but information --
  // so every finding below is produced by the flag under test and nothing else.
  const clean = await execFileAsync(process.execPath, [cli, '--spec', path, '--json'], { cwd: projectDirectory })
  const before = JSON.parse(clean.stdout)
  assert.equal(before.status, 'pass')
  assert.equal(before.findings.every((finding) => finding.severity === 'info'), true)

  // Each flag is given a value the document exceeds. A flag that never reached
  // the analysis would leave the default in force and the finding absent.
  const flags = [
    ['--max-bytes', '10', 'spec-too-large'],
    ['--max-capabilities', '1', 'too-many-capabilities'],
    ['--max-connectors', '1', 'too-many-connectors'],
    ['--max-claims-per-connector', '1', 'too-many-claims'],
    ['--max-observations', '1', 'too-many-observations'],
    ['--max-depth', '1', 'spec-too-deep'],
    ['--max-millis', '0', 'time-budget-exceeded'],
  ]
  for (const [flag, value, ruleId] of flags) {
    const result = await execFileAsync(process.execPath, [cli, '--spec', path, '--json', flag, value], { cwd: projectDirectory })
      .then((ok) => ({ code: 0, ...ok }), (error) => error)
    const report = JSON.parse(result.stdout)
    assert.equal(
      report.findings.some((finding) => finding.ruleId === ruleId),
      true,
      `${flag} did not reach the analysis; the run reported ${JSON.stringify(report.findings.map((finding) => finding.ruleId))}`,
    )
    assert.equal(result.code, 2)
    assert.equal(report.status, 'incomplete')
  }
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    'maxBytes', 'maxCapabilities', 'maxClaimsPerConnector', 'maxConnectors', 'maxDepth', 'maxMillis', 'maxObservations',
  ])
})

test('a limit flag below its floor is a configuration error with no report at all', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-limits-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'connectors.json')
  await writeFile(path, JSON.stringify({ schemaVersion: '1', capabilities: [], connectors: [] }), 'utf8')
  for (const [flag, value] of [['--max-connectors', '0'], ['--max-bytes', '-1'], ['--max-depth', 'lots'], ['--max-millis', '1.5']]) {
    const result = await execFileAsync(process.execPath, [cli, '--spec', path, flag, value], { cwd: projectDirectory })
      .then((ok) => ({ code: 0, ...ok }), (error) => error)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', `${flag} ${value} emitted a report for a run that never started`)
    // A value that begins with "-" is refused as a missing value rather than
    // silently consumed as the next flag; either way the run never starts.
    assert.match(result.stderr, /requires (an integer|a value)/)
  }
})
