import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { OBSERVATION_KINDS, RULE_SEVERITY, analyzeSpecification } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly, so
 * the grep stays green while the matrix starts depending on the ICU data of
 * whichever host produced it. Pinning `byCodeUnit` in isolation is no better --
 * that pins the helper, and every call site can still be swapped one at a time.
 *
 * So there is a case here for each site that orders something reaching output,
 * each built from values whose collated order genuinely differs from their
 * code-unit order, each driven through the real entry point:
 *
 * | site | what it orders | case below |
 * | --- | --- | --- |
 * | `compareFindingRows` pointer | the order of the findings | the pointer order |
 * | `compareFindingRows` message | two findings alike but for their message | the two unknown keys |
 * | `compareCapabilities` id | the columns within a group | the column order |
 * | `compareConnectors` id | the rows | the row order |
 * | `compareEvidence` reference | the evidence listed in a cell | the evidence order |
 *
 * Two comparisons are left, and neither can be made observable by any document:
 *
 * - `compareFindingRows` on `ruleId`, whose values are a closed set over
 *   `[a-z-]`;
 * - `compareEvidence` on `kind`, whose four values are a closed set too.
 *
 * Both are enumerated below, every ordered pair of them, and shown to collate
 * exactly as their code units do. They are equivalent mutants, not gaps.
 *
 * `compareCapabilities` compares the *group* by its index in the declared list
 * rather than as a string, so there is no collation to pin there -- and the
 * declared order is deliberately not alphabetical, which the column-order case
 * asserts. The `supportedBy` list inherits the row order and sorts nothing.
 *
 * Every identifier below is chosen so that the two orders disagree: a collator
 * folds case, so it puts `assets` before `README` and `Z`, and it treats `-`
 * and `_` as ignorable punctuation, so it orders `a_b` before `a-b`. Code units
 * give exactly one answer: R(0x52), Z(0x5A), a(0x61), then `a` before `a-b`
 * because it is a prefix, then `-`(0x2D) before `_`(0x5F) before `s`(0x73).
 */

const CODE_UNIT_ORDER = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']
// Declaration order is deliberately the reverse of the answer, so document
// order cannot be mistaken for the sort.
const DECLARED = [...CODE_UNIT_ORDER].reverse()

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const run = (document) => analyzeSpecification({ bytes: encode(document), source: 'ordering.json' })
const rateLimit = { requests: 1, windowSeconds: 1 }

test('the rows are the connectors in code-unit order, not collated order', () => {
  const { matrix } = run({
    schemaVersion: '1',
    capabilities: [{ id: 'cap', group: 'operations' }],
    connectors: DECLARED.map((id) => ({ id, rateLimit, capabilities: { cap: 'unsupported' } })),
  })
  assert.deepEqual(matrix.connectors.map((connector) => connector.id), CODE_UNIT_ORDER)
})

test('the columns are the capabilities in code-unit order within their group', () => {
  const { matrix } = run({
    schemaVersion: '1',
    capabilities: DECLARED.map((id) => ({ id, group: 'operations' })),
    connectors: [{ id: 'one', rateLimit, capabilities: Object.fromEntries(DECLARED.map((id) => [id, 'unsupported'])) }],
  })
  assert.deepEqual(matrix.capabilities.map((capability) => capability.id), CODE_UNIT_ORDER)
  assert.deepEqual(matrix.connectors[0].cells.map((cell) => cell.capability), CODE_UNIT_ORDER)
})

test('the groups keep their declared order, which is not their alphabetical one', () => {
  // Declared: operations, authentication, pagination, rate-limit. Sorted by
  // name -- by code unit or by collation, they agree here -- authentication
  // would come first, so this pins the declared order rather than a sort.
  const { matrix } = run({
    schemaVersion: '1',
    capabilities: [
      { id: 'z-throttle', group: 'rate-limit' },
      { id: 'a-cursor', group: 'pagination' },
      { id: 'a-token', group: 'authentication' },
      { id: 'z-list', group: 'operations' },
    ],
    connectors: [{ id: 'one', rateLimit, capabilities: { 'z-throttle': 'unsupported', 'a-cursor': 'unsupported', 'a-token': 'unsupported', 'z-list': 'unsupported' } }],
  })
  assert.deepEqual(matrix.capabilities.map((capability) => `${capability.group}/${capability.id}`), [
    'operations/z-list',
    'authentication/a-token',
    'pagination/a-cursor',
    'rate-limit/z-throttle',
  ])
})

/**
 * The findings are ordered by the whole field path, and a path continues past
 * the connector id, so `/connectors/a-b/...` precedes `/connectors/a/...`: at
 * the twelfth character the comparison is `-` (0x2D) against `/` (0x2F). That
 * is a third answer, different from both the collated order and the order of
 * the ids alone, which is why it is written out literally.
 */
const POINTER_ORDER = [
  '/connectors/README/capabilities/cap',
  '/connectors/Z/capabilities/cap',
  '/connectors/a-b/capabilities/cap',
  '/connectors/a/capabilities/cap',
  '/connectors/a_b/capabilities/cap',
  '/connectors/assets/capabilities/cap',
]

const UNVERIFIED = {
  schemaVersion: '1',
  capabilities: [{ id: 'cap', group: 'operations' }],
  connectors: DECLARED.map((id) => ({ id, rateLimit, capabilities: { cap: 'supported' } })),
}

test('the findings reach the report in code-unit order of their field path', () => {
  const { report } = run(UNVERIFIED)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), POINTER_ORDER)
  assert.deepEqual([...new Set(report.findings.map((finding) => finding.ruleId))], ['claim-unverified'])
})

test('two findings alike but for their message are ordered by code unit', () => {
  // Both sit at pointer "/" under the same rule id, so the message is the only
  // key left. The document declares "apple" first, so declaration order -- the
  // final tiebreak -- would give the other answer, and so would a collator.
  const { report } = run({ schemaVersion: '1', apple: true, Zebra: true, capabilities: [], connectors: [] })
  const unknown = report.findings.filter((finding) => finding.ruleId === 'unknown-declaration-key')
  assert.deepEqual(unknown.map((finding) => finding.location.pointer), ['/', '/'])
  assert.deepEqual(unknown.map((finding) => finding.message), [
    'The specification declares an unknown key "Zebra"; its intent could not be read.',
    'The specification declares an unknown key "apple"; its intent could not be read.',
  ])
})

test('the evidence in a cell is listed in code-unit order of its reference', () => {
  const references = ['assets/x.json', 'a_b.log', 'a.log', 'a-b.log', 'Z.log', 'README.md']
  const { matrix } = run({
    schemaVersion: '1',
    capabilities: [{ id: 'cap', group: 'operations' }],
    connectors: [{ id: 'one', rateLimit, capabilities: { cap: 'supported' } }],
    observations: references.map((reference) => ({
      connector: 'one', capability: 'cap', kind: 'manual-check', result: 'supported', reference,
    })),
  })
  assert.deepEqual(matrix.connectors[0].cells[0].evidence.map((item) => item.reference), [
    'README.md', 'Z.log', 'a-b.log', 'a.log', 'a_b.log', 'assets/x.json',
  ])
})

test('the kind of a piece of evidence is compared before its reference', () => {
  const { matrix } = run({
    schemaVersion: '1',
    capabilities: [{ id: 'cap', group: 'operations' }],
    connectors: [{ id: 'one', rateLimit, capabilities: { cap: 'supported' } }],
    observations: [
      { connector: 'one', capability: 'cap', kind: 'sandbox-run', result: 'supported', reference: 'a-first.log' },
      { connector: 'one', capability: 'cap', kind: 'contract-test', result: 'supported', reference: 'z-last.mjs' },
    ],
  })
  assert.deepEqual(matrix.connectors[0].cells[0].evidence.map((item) => [item.kind, item.reference]), [
    ['contract-test', 'z-last.mjs'],
    ['sandbox-run', 'a-first.log'],
  ])
})

/**
 * The two comparisons no document can make observable.
 *
 * Both draw from a closed set of values, and for these particular values a
 * collator answers exactly as code units do -- so swapping either one changes
 * nothing that can be asserted. That is an equivalent mutant and it is proved
 * here by enumeration rather than claimed in a comment: every ordered pair of
 * the real values, both orders compared.
 */
function agreesOnEveryPair(values) {
  const collate = new Intl.Collator('en').compare
  const sign = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0)
  const disagreements = []
  for (const left of values) {
    for (const right of values) {
      const byCodeUnitSign = sign(left === right ? 0 : left < right ? -1 : 1)
      if (sign(collate(left, right)) !== byCodeUnitSign) disagreements.push(`${left} vs ${right}`)
    }
  }
  return disagreements
}

test('every ordered pair of rule ids collates exactly as its code units do', () => {
  const ruleIds = Object.keys(RULE_SEVERITY)
  assert.equal(ruleIds.length > 30, true)
  assert.equal(ruleIds.every((ruleId) => /^[a-z0-9-]+$/.test(ruleId)), true, 'a rule id left the alphabet this proof rests on')
  assert.deepEqual(agreesOnEveryPair(ruleIds), [], 'the rule-id comparison is observable after all and needs a case')
})

test('every ordered pair of evidence kinds collates exactly as its code units do', () => {
  assert.deepEqual(agreesOnEveryPair([...OBSERVATION_KINDS]), [])
  assert.equal(OBSERVATION_KINDS.length, 4)
})

test('the real command line emits the same order over a file on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'ordering.json')
  const destination = join(directory, 'matrix.json')
  await writeFile(spec, JSON.stringify(UNVERIFIED), 'utf8')

  const result = await execFileAsync(
    process.execPath,
    [cli, '--spec', spec, '--matrix', destination, '--json'],
    { cwd: projectDirectory },
  ).then((ok) => ok, (error) => error)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.location.pointer), POINTER_ORDER)
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.deepEqual(written.connectors.map((connector) => connector.id), CODE_UNIT_ORDER)
})
