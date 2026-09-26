import assert from 'node:assert/strict'
import test from 'node:test'

import { CELL_MARKERS, CELL_STATES, analyzeSpecification, formatReport } from '../src/index.mjs'

/**
 * The three states, driven through the real entry point.
 *
 * This is the tool's whole reason to exist: a capability a specification claims
 * and nobody observed is `unverified`, which is neither `supported` nor
 * `unsupported`, and a capability that does not work keeps a cell of its own
 * rather than being left blank.
 */

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const run = (document) => analyzeSpecification({ bytes: encode(document), source: 'matrix.json' })

const document = ({ claim, observations = [], required = false }) => ({
  schemaVersion: '1',
  matrix: 'states',
  capabilities: [{ id: 'list-records', group: 'operations', required }],
  connectors: [{
    id: 'acme',
    rateLimit: { requests: 1, windowSeconds: 1 },
    ...(claim === undefined ? {} : { capabilities: { 'list-records': claim } }),
  }],
  observations: observations.map((result, index) => ({
    connector: 'acme',
    capability: 'list-records',
    kind: 'contract-test',
    result,
    reference: `test/case-${index}.mjs`,
  })),
})

const cellOf = (result) => result.matrix.connectors[0].cells[0]
const ruleIds = (result) => result.report.findings.map((finding) => finding.ruleId)

test('a claim backed by an observation is supported, and says how much evidence it has', () => {
  const result = run(document({ claim: 'supported', observations: ['supported', 'supported'] }))
  assert.equal(cellOf(result).state, 'supported')
  assert.equal(cellOf(result).observations, 2)
  assert.deepEqual(ruleIds(result), [])
  assert.equal(result.report.status, 'pass')
  assert.equal(result.report.summary.supported, 1)
})

test('a claim with no evidence behind it is unverified, not supported', () => {
  const result = run(document({ claim: 'supported' }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.equal(cellOf(result).claim, 'supported')
  assert.equal(cellOf(result).observations, 0)
  assert.deepEqual(ruleIds(result), ['claim-unverified'])
  assert.equal(result.report.summary.supported, 0)
  assert.equal(result.report.summary.unverified, 1)
  // Unknown evidence is never a pass, and it is not a failure either.
  assert.equal(result.report.status, 'incomplete')
})

test('an unsupported capability keeps an explicit cell rather than a blank', () => {
  const result = run(document({ claim: { state: 'unsupported', note: 'no endpoint exists' } }))
  assert.equal(cellOf(result).state, 'unsupported')
  assert.equal(cellOf(result).claim, 'unsupported')
  assert.equal(cellOf(result).note, 'no endpoint exists')
  // The only thing said about it is the information that nothing in this
  // matrix provides the capability, which is not a defect and does not fail.
  assert.deepEqual(ruleIds(result), ['capability-unsupported-everywhere'])
  assert.equal(result.report.summary.info, 1)
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.status, 'pass')
  assert.equal(result.report.summary.unsupported, 1)
})

test('evidence outranks the claim in both directions, and the disagreement is an error', () => {
  const contradicted = run(document({ claim: 'supported', observations: ['unsupported'] }))
  assert.equal(cellOf(contradicted).state, 'unsupported')
  assert.deepEqual(ruleIds(contradicted), ['capability-unsupported-everywhere', 'claim-contradicted'])
  assert.equal(contradicted.report.summary.errors, 1)
  assert.equal(contradicted.report.status, 'fail')

  const stale = run(document({ claim: 'unsupported', observations: ['supported'] }))
  assert.equal(cellOf(stale).state, 'supported')
  assert.deepEqual(ruleIds(stale), ['unsupported-capability-observed'])
  assert.equal(stale.report.status, 'fail')
})

test('two observations that disagree leave the cell unverified, not half supported', () => {
  const result = run(document({ claim: 'supported', observations: ['supported', 'unsupported'] }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.deepEqual(ruleIds(result), ['observation-conflict'])
  assert.equal(result.report.status, 'incomplete')
})

test('evidence that settled nothing leaves the claim unverified', () => {
  const result = run(document({ claim: 'supported', observations: ['inconclusive'] }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.equal(cellOf(result).observations, 1)
  assert.deepEqual(ruleIds(result), ['evidence-inconclusive'])
  assert.equal(result.report.status, 'incomplete')
})

test('silence about an optional capability is unverified, and is reported as silence', () => {
  const result = run(document({ claim: undefined }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.equal(cellOf(result).claim, null)
  assert.deepEqual(ruleIds(result), ['capability-unclaimed'])
  assert.equal(result.report.status, 'incomplete')
})

test('silence about a required capability is a gap the run fails on', () => {
  const result = run(document({ claim: undefined, required: true }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.deepEqual(ruleIds(result), ['required-capability-unclaimed'])
  // A fact the run established, not a question it could not answer: this one
  // is a verdict, so it fails rather than abstaining.
  assert.equal(result.report.status, 'fail')
})

test('an observation about a cell nobody claimed decides the cell and reports the silence', () => {
  const result = run(document({ claim: undefined, observations: ['supported'] }))
  assert.equal(cellOf(result).state, 'supported')
  assert.deepEqual(ruleIds(result), ['observation-unclaimed'])
  assert.equal(result.report.status, 'incomplete')
})

test('a claim this tool cannot read never becomes a state, and is reported once', () => {
  const result = run(document({ claim: 'partial' }))
  assert.equal(cellOf(result).state, 'unverified')
  assert.equal(cellOf(result).claim, null)
  // Exactly one finding: the unreadable claim. Adding "nothing was claimed"
  // on top of it would report one defect twice.
  assert.deepEqual(ruleIds(result), ['claim-state-unknown'])
})

test('every connector has a cell for every capability, including the ones that do not work', () => {
  const result = run({
    schemaVersion: '1',
    capabilities: [
      { id: 'list-records', group: 'operations' },
      { id: 'delete-record', group: 'operations' },
      { id: 'api-key', group: 'authentication' },
    ],
    connectors: [
      { id: 'acme', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { 'list-records': 'unsupported', 'delete-record': 'unsupported', 'api-key': 'unsupported' } },
      { id: 'bolt', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { 'list-records': 'unsupported', 'delete-record': 'unsupported', 'api-key': 'unsupported' } },
    ],
  })
  assert.equal(result.report.summary.cells, 6)
  assert.equal(result.report.summary.checked, 6)
  for (const connector of result.matrix.connectors) {
    assert.equal(connector.cells.length, 3)
    for (const cell of connector.cells) {
      assert.equal(cell.state, 'unsupported')
      assert.equal(CELL_STATES.includes(cell.state), true)
    }
  }
  assert.equal(result.report.status, 'pass')
})

test('the three states render distinctly in the grid, and none of them renders as a blank', () => {
  const result = run({
    schemaVersion: '1',
    matrix: 'states',
    capabilities: [
      { id: 'a-supported', group: 'operations' },
      { id: 'b-unsupported', group: 'operations' },
      { id: 'c-unverified', group: 'operations' },
    ],
    connectors: [{
      id: 'acme',
      rateLimit: { requests: 1, windowSeconds: 1 },
      capabilities: { 'a-supported': 'supported', 'b-unsupported': 'unsupported', 'c-unverified': 'supported' },
    }],
    observations: [
      { connector: 'acme', capability: 'a-supported', kind: 'contract-test', result: 'supported', reference: 'test/a.mjs' },
    ],
  })
  const markers = new Set(Object.values(CELL_MARKERS))
  assert.equal(markers.size, 3, 'two states render the same way')
  for (const marker of markers) assert.equal(marker.trim().length > 0, true, 'a state renders as a blank')

  const text = formatReport(result.report, result.matrix)
  const row = (name) => text.split('\n').find((line) => line.startsWith(`operations/${name}`))
  assert.equal(row('a-supported').includes(`| ${CELL_MARKERS.supported}1`), true, row('a-supported'))
  assert.equal(row('b-unsupported').includes(`| ${CELL_MARKERS.unsupported}`), true, row('b-unsupported'))
  assert.equal(row('c-unverified').includes(`| ${CELL_MARKERS.unverified}`), true, row('c-unverified'))
  assert.equal(text.includes('legend:'), true)
  // The comparison the matrix is for: the rate limit and the version are rows
  // of their own rather than prose somewhere else.
  assert.equal(text.includes('rate limit'), true)
  assert.equal(text.includes('1/1s'), true)
})

test('a run that passed has no unverified cell anywhere in it', () => {
  // The invariant behind "unknown evidence is never a pass": every rule that
  // can leave a cell unverified is in INCOMPLETE_RULES or is an error.
  for (const claim of ['supported', 'unsupported', 'partial', undefined]) {
    for (const observations of [[], ['supported'], ['unsupported'], ['inconclusive'], ['supported', 'unsupported']]) {
      const result = run(document({ claim, observations }))
      if (result.report.status !== 'pass') continue
      assert.equal(result.report.summary.unverified, 0, `a pass carried an unverified cell: ${claim} / ${observations}`)
    }
  }
})

test('the artifact carries the legend, so a consumer cannot mistake unverified for unsupported', () => {
  const result = run(document({ claim: 'supported' }))
  assert.deepEqual(Object.keys(result.matrix.legend).sort(), ['supported', 'unsupported', 'unverified'])
  assert.match(result.matrix.legend.unverified, /never observed working/)
  assert.equal(result.matrix.complete, false)
})

test('the per-capability totals add up to the cells in the column', () => {
  const result = run({
    schemaVersion: '1',
    capabilities: [{ id: 'a', group: 'operations' }],
    connectors: [
      { id: 'one', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'unsupported' } },
      { id: 'two', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'supported' } },
      { id: 'three', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'supported' } },
    ],
    observations: [{ connector: 'two', capability: 'a', kind: 'sandbox-run', result: 'supported', reference: 'runs/two.log' }],
  })
  const column = result.matrix.capabilities[0]
  assert.equal(column.supported, 1)
  assert.equal(column.unsupported, 1)
  assert.equal(column.unverified, 1)
  assert.deepEqual(column.supportedBy, ['two'])
  assert.equal(column.supported + column.unsupported + column.unverified, result.matrix.connectors.length)
})
