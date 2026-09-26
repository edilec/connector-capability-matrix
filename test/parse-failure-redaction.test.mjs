import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/text.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'connector-capability-matrix.mjs')

/**
 * A parse failure does not quote the document it failed on.
 *
 * V8 writes `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`,
 * so a specification or a configuration short enough to be nothing but a
 * credential was reproduced in full by its own error message -- `spec-not-json`
 * put it in the report's `evidence` field on stdout, and `--config` put it on
 * stderr. Sanitising never helped: it cuts from the end and the quoted span is
 * at the front.
 *
 * The canary is the AWS documentation placeholder, not a key. It is asserted
 * absent from stdout, from stderr and from every prefix down to eight
 * characters, because V8 quotes a ten-character window once the input is long
 * enough: an assertion on the whole string alone passes while ten characters of
 * the secret still ship.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'connector-capability-matrix-parse-failure-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function run(base, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd: base })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** Every prefix of the canary from its full length down to eight characters. */
function assertNoPrefix(text, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.equal(text.includes(prefix), false, `${where} carried ${length} characters of the canary`)
  }
}

test('a specification that is only a credential is not echoed by its own parse error', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'spec.json'), CANARY)

    const { code, stdout, stderr } = await run(base, ['--spec', 'spec.json', '--json'])
    assert.equal(code, 2)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'spec-not-json')
    assert.notEqual(finding, undefined, 'the run still said the specification was not JSON')
    assert.match(finding.evidence, /token/, 'the evidence still says what went wrong')
  })
})

test('the human grid does not echo it either', async () => {
  await withBase(async (base) => {
    // This one was already clean before the fix: the human grid prints no
    // evidence field. It is here to keep that true, since the grid is what a
    // reader sees by default.
    await writeFile(join(base, 'spec.json'), CANARY)

    const { stdout, stderr } = await run(base, ['--spec', 'spec.json'])
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')
  })
})

test('a configuration that is only a credential is not echoed on stderr', async () => {
  await withBase(async (base) => {
    await writeFile(join(base, 'spec.json'), JSON.stringify({ schemaVersion: '1', capabilities: [], connectors: [] }))
    await writeFile(join(base, 'config.json'), CANARY)

    const { code, stdout, stderr } = await run(base, ['--spec', 'spec.json', '--config', 'config.json'])
    assert.equal(code, 2)
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')
    assert.match(stderr, /not valid JSON/, 'the refusal still says why the configuration was refused')
  })
})

test('a specification that fails after a valid property keeps its position, line and column', async () => {
  await withBase(async (base) => {
    // V8 answers this one with the safe spelling: a position, no quoted span.
    // A parse error that says nothing is a different defect.
    await writeFile(join(base, 'spec.json'), `{"schemaVersion": "1" ${CANARY}}`)

    const { stdout, stderr } = await run(base, ['--spec', 'spec.json', '--json'])
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'spec-not-json')
    assert.match(finding.evidence, /at position \d+/, 'the position a reader needs is still there')
    assert.match(finding.evidence, /line \d+ column \d+/, 'line and column are still there')
  })
})

test('a secret deep inside a longer specification is not echoed by the windowed spelling', async () => {
  await withBase(async (base) => {
    // The third V8 spelling quotes a window rather than a prefix and carries no
    // position; only the offending token survives it.
    await writeFile(join(base, 'spec.json'), `{"schemaVersion": "1", "connectors": ${CANARY}}`)

    const { stdout, stderr } = await run(base, ['--spec', 'spec.json', '--json'])
    assertNoPrefix(stdout, 'stdout')
    assertNoPrefix(stderr, 'stderr')

    const finding = JSON.parse(stdout).findings.find((row) => row.ruleId === 'spec-not-json')
    assert.match(finding.evidence, /unexpected token/)
  })
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const caught = (text) => {
    try {
      JSON.parse(text)
      return null
    } catch (error) {
      return error
    }
  }

  const quoted = caught(CANARY)
  assert.equal(quoted.message.includes(CANARY), true, 'V8 still quotes the input, so this test still has a subject')
  assert.equal(parseFailureDetail(quoted).includes(CANARY.slice(0, SHORTEST_PREFIX)), false)

  const detail = parseFailureDetail(caught(`{"a": 1 ${CANARY}}`))
  assert.equal(detail.includes(CANARY.slice(0, SHORTEST_PREFIX)), false)
  assert.match(detail, /at position \d+ \(line \d+ column \d+\)$/)

  assert.equal(parseFailureDetail(caught('password=hunter2-correct-horse')).includes('password'), false)
  assert.equal(parseFailureDetail(caught('')), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
