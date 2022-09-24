import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { analyzeSpecification } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * The same document produces the same bytes, on any host and in any order.
 *
 * Two things could break that and neither is visible in a single run: a value
 * derived from the clock, and an output that depends on the order the
 * declarations happened to be written in. Both are checked by running the real
 * thing twice and comparing bytes, rather than by reading the source for
 * forbidden spellings -- a source scan cannot see an `Intl.Collator` doing what
 * a `localeCompare` used to do.
 */

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const run = (document) => analyzeSpecification({ bytes: encode(document), source: 'determinism.json' })

const DOCUMENT = {
  schemaVersion: '1',
  matrix: 'determinism',
  capabilities: [
    { id: 'list-records', group: 'operations', required: true },
    { id: 'delete-record', group: 'operations' },
    { id: 'api-key', group: 'authentication' },
    { id: 'cursor', group: 'pagination' },
  ],
  connectors: [
    {
      id: 'acme',
      version: '1.0.0',
      rateLimit: { requests: 1, windowSeconds: 1 },
      capabilities: { 'list-records': 'supported', 'delete-record': 'unsupported', 'api-key': 'supported', cursor: 'supported' },
    },
    {
      id: 'bolt',
      rateLimit: { requests: 2, windowSeconds: 1 },
      capabilities: { 'list-records': 'supported', 'delete-record': 'unsupported', 'api-key': 'unsupported' },
    },
  ],
  observations: [
    { connector: 'acme', capability: 'list-records', kind: 'contract-test', result: 'supported', reference: 'test/acme-list.mjs' },
    { connector: 'acme', capability: 'api-key', kind: 'sandbox-run', result: 'supported', reference: 'runs/acme-key.log' },
    { connector: 'bolt', capability: 'list-records', kind: 'recorded-response', result: 'supported', reference: 'fixtures/bolt-list.json' },
    { connector: 'acme', capability: 'cursor', kind: 'manual-check', result: 'inconclusive', reference: 'notes/acme-cursor.md' },
  ],
}

const reversed = (document) => ({
  ...document,
  capabilities: [...document.capabilities].reverse(),
  connectors: [...document.connectors].reverse(),
  observations: [...document.observations].reverse(),
})

test('two runs over the same bytes produce byte-identical output', () => {
  const first = run(DOCUMENT)
  const second = run(DOCUMENT)
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report))
  assert.equal(JSON.stringify(first.matrix), JSON.stringify(second.matrix))
})

test('the order the declarations were written in does not reach the output', () => {
  const forwards = run(DOCUMENT)
  const backwards = run(reversed(DOCUMENT))
  assert.equal(JSON.stringify(forwards.report), JSON.stringify(backwards.report))
  assert.equal(JSON.stringify(forwards.matrix), JSON.stringify(backwards.matrix))
  assert.equal(forwards.report.findings.length > 2, true, 'the fixture stopped exercising the finding order')
})

test('the keys of the report are in a fixed order too, not just its values', () => {
  const { report, matrix } = run(DOCUMENT)
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.deepEqual(Object.keys(report.findings[0]).slice(0, 4), ['ruleId', 'severity', 'message', 'location'])
  assert.deepEqual(Object.keys(matrix.connectors[0].cells[0]), ['capability', 'group', 'state', 'claim', 'note', 'observations', 'evidence'])
})

test('the real command line is byte-identical across runs, and carries no timing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-determinism-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'determinism.json')
  await writeFile(spec, JSON.stringify(DOCUMENT), 'utf8')

  const first = await execFileAsync(process.execPath, [cli, '--spec', spec, '--json'], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  // A second run, deliberately after some real time has passed, so a wall clock
  // reading its way into the report would show up as a difference.
  await new Promise((resolve_) => { setTimeout(resolve_, 25) })
  const second = await execFileAsync(process.execPath, [cli, '--spec', spec, '--json'], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  assert.equal(first.stdout, second.stdout)

  const humanFirst = await execFileAsync(process.execPath, [cli, '--spec', spec], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  const humanSecond = await execFileAsync(process.execPath, [cli, '--spec', spec], { cwd: projectDirectory })
    .then((ok) => ok, (error) => error)
  assert.equal(humanFirst.stdout, humanSecond.stdout)
})

test('the matrix artifact written to disk is byte-identical across runs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-determinism-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'determinism.json')
  await writeFile(spec, JSON.stringify(DOCUMENT), 'utf8')
  const write = async (name, document) => {
    await writeFile(spec, JSON.stringify(document), 'utf8')
    const destination = join(directory, name)
    await execFileAsync(process.execPath, [cli, '--spec', spec, '--matrix', destination, '--json'], { cwd: projectDirectory })
      .then((ok) => ok, (error) => error)
    return readFile(destination, 'utf8')
  }
  assert.equal(await write('one.json', DOCUMENT), await write('two.json', DOCUMENT))
  assert.equal(await write('three.json', DOCUMENT), await write('four.json', reversed(DOCUMENT)))
})

test('the source reads no wall clock and names no collator', async () => {
  // Not the guard -- a grep for `.localeCompare(` is satisfied by an
  // `Intl.Collator` that collates exactly as badly, which is why ordering is
  // pinned behaviourally in test/ordering.test.mjs. This is a cheap second
  // line: the clock and the random number generator have no legitimate use
  // here at all, so their absence is worth stating.
  for (const file of ['src/index.mjs', 'src/spec.mjs', 'src/matrix.mjs', 'src/text.mjs', 'bin/connector-capability-matrix.mjs']) {
    const text = await readFile(resolve(projectDirectory, file), 'utf8')
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')).join('\n')
    assert.equal(code.includes('Date.now'), false, `${file} reads a wall clock`)
    assert.equal(code.includes('new Date'), false, `${file} reads a wall clock`)
    assert.equal(code.includes('Math.random'), false, `${file} uses a random number generator`)
    assert.equal(code.includes('localeCompare'), false, `${file} orders by locale`)
    assert.equal(code.includes('Intl.'), false, `${file} orders by locale`)
    assert.equal(code.includes('readdir'), false, `${file} enumerates a directory`)
  }
})
