import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeSpecification, formatReport } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * Nothing from the document forges or hides a line of the output.
 *
 * Stripping C0 and the line separators is not sanitising: four tools in this
 * catalog did exactly that and let the C1 range through, where U+0085 begins a
 * new line on a terminal as surely as a newline does and U+009B opens an escape
 * sequence. Neither is ECMAScript whitespace and neither is escaped by
 * `JSON.stringify`, so both reach stdout intact.
 *
 * The other half of the defect is *which* strings get sanitised. A tool that
 * scrubbed its excerpt field carefully let a page id carrying a newline forge
 * whole lines in its report, so every class below arrives through a different
 * position, and two of them arrive through an **identifier**: a capability id
 * and a connector id.
 */

const cp = (...codes) => String.fromCharCode(...codes)

const FORBIDDEN = [
  ['C0 NUL', cp(0x00)],
  ['C0 newline', cp(0x0a)],
  ['C0 escape', cp(0x1b)],
  ['DEL', cp(0x7f)],
  ['C1 NEL', cp(0x85)],
  ['C1 CSI', cp(0x9b)],
  ['C1 lower bound', cp(0x80)],
  ['C1 upper bound', cp(0x9f)],
  ['line separator', cp(0x2028)],
  ['paragraph separator', cp(0x2029)],
  ['left-to-right mark', cp(0x200e)],
  ['right-to-left mark', cp(0x200f)],
  ['right-to-left override', cp(0x202e)],
  ['first strong isolate', cp(0x2069)],
]

/**
 * One document carrying every class in a different position.
 *
 * The identifier cases are the important ones: an id that carries a control
 * character is refused by the grammar, and the refusal quotes the id back --
 * which is exactly where a tool that sanitises only excerpts lets it through.
 */
const POISONED = {
  schemaVersion: '1',
  matrix: `platform${cp(0x0a)}FORGED SUMMARY LINE`,
  capabilities: [
    { id: `list${cp(0x85)}records`, group: 'operations' },
    { id: 'real-capability', group: 'operations', title: `Lists${cp(0x2028)}records` },
    { id: 'odd-group', group: `oper${cp(0x9b)}ations` },
  ],
  connectors: [
    { id: `acme${cp(0x202e)}crm`, rateLimit: { requests: 1, windowSeconds: 1 } },
    {
      id: 'real-connector',
      title: `Acme${cp(0x2029)}CRM`,
      rateLimit: { requests: 1, windowSeconds: 1 },
      capabilities: {
        'real-capability': { state: 'supported', note: `works${cp(0x1b)}[31m in staging` },
        'ghost-capability': 'supported',
        [`ghost${cp(0x00)}key`]: 'supported',
        'odd-state': `part${cp(0x7f)}ial`,
      },
    },
  ],
  observations: [
    { connector: 'real-connector', capability: 'real-capability', kind: 'contract-test', result: 'supported', reference: `test/a${cp(0x200e)}.mjs` },
    { connector: 'real-connector', capability: 'real-capability', kind: `manual${cp(0x200f)}check`, result: 'supported', reference: 'notes/b.md' },
  ],
  [`extra${cp(0x2069)}key`]: true,
}

const run = (document) => analyzeSpecification({
  bytes: new TextEncoder().encode(JSON.stringify(document)),
  source: 'poisoned.json',
})

test('no forbidden character reaches the machine-readable report', () => {
  const { report } = run(POISONED)
  assert.equal(report.findings.length > 6, true, 'the poisoned document produced suspiciously few findings')
  const serialised = JSON.stringify(report)
  for (const [name, character] of FORBIDDEN) {
    assert.equal(serialised.includes(character), false, `${name} reached the report`)
  }
})

test('no forbidden character reaches the matrix artifact', () => {
  const { matrix } = run(POISONED)
  const serialised = JSON.stringify(matrix)
  for (const [name, character] of FORBIDDEN) {
    assert.equal(serialised.includes(character), false, `${name} reached the matrix artifact`)
  }
})

/**
 * A line-oriented report separates its own lines with newlines, so the newline
 * is the one character that cannot be looked for by presence. It is pinned by
 * structure instead: the number of printed finding lines, which a smuggled
 * newline is precisely an attempt to change.
 */
const FORBIDDEN_IN_TEXT = FORBIDDEN.filter(([name]) => name !== 'C0 newline')

test('no forbidden character reaches the human report, and no line is forged', () => {
  const { report, matrix } = run(POISONED)
  const text = formatReport(report, matrix)
  for (const [name, character] of FORBIDDEN_IN_TEXT) {
    assert.equal(text.includes(character), false, `${name} reached the human report`)
  }
  // The count a forged line would change: one printed line per finding, and no
  // more, however many newlines the document tried to smuggle in.
  const printed = text.split('\n').filter((line) => /^(ERROR|WARNING|INFO) /.test(line))
  assert.equal(printed.length, report.findings.length)
  assert.equal(text.includes('FORGED SUMMARY LINE'), true, 'the payload was dropped rather than flattened')
  assert.equal(text.split('\n').some((line) => line.startsWith('FORGED')), false, 'a line was forged')
})

test('an identifier carrying a control character is refused by the grammar', () => {
  const { report } = run(POISONED)
  const rules = report.findings.map((finding) => finding.ruleId)
  assert.equal(rules.includes('capability-id-invalid'), true)
  assert.equal(rules.includes('connector-id-invalid'), true)
  // The refusal quotes the id back, which is where a tool that sanitises only
  // its excerpt field lets the character through.
  const refusal = report.findings.find((finding) => finding.ruleId === 'capability-id-invalid')
  assert.equal(typeof refusal.evidence, 'string')
  assert.equal(refusal.evidence.includes(cp(0x85)), false)
  assert.equal(refusal.evidence, 'list records')
})

test('a pointer only ever carries characters an id is allowed to have', () => {
  const { report } = run(POISONED)
  for (const finding of report.findings) {
    assert.match(
      finding.location.pointer,
      /^[A-Za-z0-9_./-]*$/,
      `${finding.ruleId} built a pointer out of something unsafe: ${JSON.stringify(finding.location.pointer)}`,
    )
  }
})

test('every untrusted position is bounded as well as cleaned', () => {
  const long = 'x'.repeat(5000)
  const { report, matrix } = run({
    schemaVersion: '1',
    matrix: long,
    capabilities: [{ id: 'cap', group: 'operations', title: long }],
    connectors: [{
      id: 'con',
      title: long,
      rateLimit: { requests: 1, windowSeconds: 1 },
      capabilities: { cap: { state: 'supported', note: long } },
    }],
    observations: [{ connector: 'con', capability: 'cap', kind: 'contract-test', result: 'supported', reference: long }],
  })
  const serialised = JSON.stringify({ report, matrix })
  assert.equal(serialised.includes('x'.repeat(500)), false, 'an unbounded string reached the output')
  for (const finding of report.findings) {
    assert.equal(finding.message.length <= 403, true)
    assert.equal((finding.evidence ?? '').length <= 203, true)
  }
})

test('the real command line emits nothing forbidden either, on stdout or in the artifact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-sanitise-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'poisoned.json')
  const destination = join(directory, 'matrix.json')
  await writeFile(spec, JSON.stringify(POISONED), 'utf8')

  const result = await execFileAsync(process.execPath, [cli, '--spec', spec, '--matrix', destination], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  const written = await readFile(destination, 'utf8')
  // Both are line-oriented text -- one a report, one a pretty-printed
  // document -- so the newline is pinned by structure rather than by absence.
  for (const [name, character] of FORBIDDEN_IN_TEXT) {
    assert.equal(result.stdout.includes(character), false, `${name} reached stdout`)
    assert.equal(written.includes(character), false, `${name} reached the written artifact`)
  }
  // One printed line per finding, counted against the machine-readable report
  // of the same file: a smuggled newline would print more lines than there are
  // findings.
  const machine = await execFileAsync(process.execPath, [cli, '--spec', spec, '--json'], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  const findings = JSON.parse(machine.stdout).findings
  const printed = result.stdout.split('\n').filter((line) => /^(ERROR|WARNING|INFO) /.test(line))
  assert.equal(printed.length, findings.length)
  assert.equal(findings.length > 6, true, 'the poisoned document produced suspiciously few findings')
})
