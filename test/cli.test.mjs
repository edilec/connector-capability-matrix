import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * The real command line, over real files.
 *
 * Exit 2 has two shapes and the difference is deliberate: a configuration error
 * means the run never had a subject, so stdout stays empty; an input that could
 * not be read means the run had a subject and failed to obtain evidence about
 * it, so stdout carries an `incomplete` report naming what was not read.
 */

const runCli = (args, options = {}) => execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory, ...options })
  .then((ok) => ({ code: 0, ...ok }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))

const PASSING = {
  schemaVersion: '1',
  matrix: 'cli',
  capabilities: [{ id: 'list-records', group: 'operations', required: true }],
  connectors: [{ id: 'acme', version: '1.0.0', rateLimit: { requests: 5, windowSeconds: 1 }, capabilities: { 'list-records': 'supported' } }],
  observations: [{ connector: 'acme', capability: 'list-records', kind: 'contract-test', result: 'supported', reference: 'test/acme.mjs' }],
}

async function workspace(t, document = PASSING) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'connectors.json')
  if (document !== null) await writeFile(spec, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
  return { directory, spec }
}

test('--help explains the three states and exits 0 with no report', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /connector-capability-matrix/)
  assert.match(result.stdout, /supported/)
  assert.match(result.stdout, /unsupported/)
  assert.match(result.stdout, /unverified/)
  assert.match(result.stdout, /--spec FILE/)
  assert.match(result.stdout, /Exit codes:/)
  assert.equal(result.stdout.includes('"schemaVersion"'), false)
})

test('a passing specification exits 0 and stdout is nothing but the report', async (t) => {
  const { spec } = await workspace(t)
  const result = await runCli(['--spec', spec, '--json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
})

test('a contradicted claim exits 1, which no edit to a severity table can change', async (t) => {
  const { spec } = await workspace(t, {
    ...PASSING,
    observations: [{ connector: 'acme', capability: 'list-records', kind: 'contract-test', result: 'unsupported', reference: 'test/acme-403.mjs' }],
  })
  const result = await runCli(['--spec', spec, '--json'])
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).status, 'fail')
})

test('an unverified claim exits 2 with an incomplete report, never a pass', async (t) => {
  const { spec } = await workspace(t, { ...PASSING, observations: [] })
  const result = await runCli(['--spec', spec, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unverified, 1)
  assert.match(result.stderr, /this run is not a verdict/)
})

test('an unreadable input carries a report on stdout; a bad option carries none', async (t) => {
  const { directory } = await workspace(t, null)
  const unreadable = await runCli(['--spec', join(directory, 'absent.json'), '--json'])
  assert.equal(unreadable.code, 2)
  assert.equal(JSON.parse(unreadable.stdout).status, 'incomplete')
  assert.equal(JSON.parse(unreadable.stdout).findings[0].ruleId, 'spec-unreadable')

  for (const args of [['--spec'], [], ['--spec', 'x.json', '--verbose'], ['--spec', 'a.json', '--spec', 'b.json'], ['--json', '--json', '--spec', 'a.json']]) {
    const result = await runCli(args)
    assert.equal(result.code, 2, `${args.join(' ')} did not fail`)
    assert.equal(result.stdout, '', `${args.join(' ')} emitted a report for a run that never started`)
    assert.notEqual(result.stderr, '')
  }
})

test('stderr carries diagnostics and stdout stays parseable', async (t) => {
  const { directory, spec } = await workspace(t, { ...PASSING, observations: [] })
  const destination = join(directory, 'out', 'matrix.json')
  const result = await runCli(['--spec', spec, '--json', '--matrix', destination])
  assert.equal(result.code, 2)
  // A non-empty stderr is correct: it is where operational diagnostics go.
  assert.match(result.stderr, /matrix written/)
  assert.equal(JSON.parse(result.stdout).tool, 'connector-capability-matrix')
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.complete, false)
  assert.equal(written.connectors[0].cells[0].state, 'unverified')
})

test('the matrix artifact may not be written over the specification', async (t) => {
  const { spec } = await workspace(t)
  const result = await runCli(['--spec', spec, '--matrix', spec])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--matrix is not usable/)
  assert.deepEqual(JSON.parse(await readFile(spec, 'utf8')), PASSING)
})

test('--config supplies limits, and a flag overrides the same limit', async (t) => {
  const { directory, spec } = await workspace(t)
  const config = join(directory, 'limits.json')
  await writeFile(config, JSON.stringify({ limits: { maxConnectors: 1, maxBytes: 10 } }), 'utf8')

  const fromConfig = await runCli(['--spec', spec, '--json', '--config', config])
  assert.equal(fromConfig.code, 2)
  assert.deepEqual(JSON.parse(fromConfig.stdout).findings.map((finding) => finding.ruleId), ['spec-too-large'])

  const overridden = await runCli(['--spec', spec, '--json', '--config', config, '--max-bytes', '100000'])
  assert.equal(overridden.code, 0)
  assert.deepEqual(JSON.parse(overridden.stdout).findings, [])
})

test('a configuration file is decoded as strictly as the specification', async (t) => {
  const { directory, spec } = await workspace(t)
  const config = join(directory, 'limits.json')

  // The data path and the configuration path get the same decoder. A tool that
  // hardened one and left the other lossy turned a mangled byte into a
  // different limit.
  await writeFile(config, new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]))
  const notUtf8 = await runCli(['--spec', spec, '--config', config])
  assert.equal(notUtf8.code, 2)
  assert.equal(notUtf8.stdout, '')
  assert.match(notUtf8.stderr, /not valid UTF-8/)

  for (const [content, pattern] of [
    ['{ not json', /not valid JSON/],
    ['[]', /must be a JSON object/],
    ['{"limit":{"maxBytes":10}}', /unknown configuration key "limit"/],
    ['{"limits":{"maxByte":10}}', /Unknown limit "maxByte"/],
    ['{"limits":{"maxBytes":0}}', /at least 1/],
  ]) {
    await writeFile(config, content, 'utf8')
    const result = await runCli(['--spec', spec, '--config', config])
    assert.equal(result.code, 2, content)
    assert.equal(result.stdout, '', `${content} emitted a report for a run that never started`)
    assert.match(result.stderr, pattern)
  }

  const absent = await runCli(['--spec', spec, '--config', join(directory, 'absent.json')])
  assert.equal(absent.code, 2)
  assert.equal(absent.stdout, '')
  assert.match(absent.stderr, /could not be read/)
})

test('the shipped examples behave as the README says they do', async () => {
  const clean = await runCli(['--spec', 'examples/integration-platform.json', '--json'])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')
  assert.equal(JSON.parse(clean.stdout).summary.unverified, 0)

  const broken = await runCli(['--spec', 'examples/broken-matrix.json', '--json'])
  assert.equal(broken.code, 2)
  const report = JSON.parse(broken.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unverified > 0, true)
  // `incomplete` outranks `fail`, which the documented exit-code table says and
  // this document demonstrates: it carries a claim-contradicted -- an error
  // that on its own is exit 1 -- alongside rules that mean a question went
  // unanswered, and the run is called incomplete and exits 2. The errors are
  // still all there; the precedence settles what the run is called, not what it
  // says.
  const rules = report.findings.map((finding) => finding.ruleId)
  assert.equal(rules.includes('claim-contradicted'), true, 'the broken example no longer contradicts a claim')
  assert.equal(rules.includes('observation-conflict'), true, 'the broken example no longer leaves a question unanswered')
  assert.equal(report.summary.errors > 0, true)
  assert.equal(report.findings.every((finding) => finding.location.file === 'examples/broken-matrix.json'), true)
  // A location is never an absolute host path: a report is an artifact people
  // paste into issues and diff between machines.
  assert.equal(report.findings.some((finding) => finding.location.file.startsWith('/')), false)
})
