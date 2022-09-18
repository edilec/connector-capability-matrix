import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compareConnectorFile, resolveMatrixDestination, writeMatrixFile } from '../src/index.mjs'

/**
 * The matrix is a derived artifact, and writing it over the specification
 * destroys the input irreversibly.
 *
 * A `realpath` comparison is not enough. A symbolic link has a target, so
 * `realpath` collapses it -- but a **hard link has no target**, so two names for
 * one inode resolve to two different real paths and a path comparison says they
 * are different files. A tool in this catalog destroyed its own input exactly
 * that way. Identity is decided by device and inode, the way the filesystem
 * decides it.
 *
 * The opposite mistake matters too: refusing a legitimate destination because
 * it is reached through a symlinked directory. On macOS the system temporary
 * directory *is* a symlink, so that refusal would break every run in it.
 */

const SPEC = {
  schemaVersion: '1',
  capabilities: [{ id: 'list-records', group: 'operations' }],
  connectors: [{ id: 'acme', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { 'list-records': 'unsupported' } }],
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-matrix-dest-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const spec = join(directory, 'connectors.json')
  await writeFile(spec, JSON.stringify(SPEC), 'utf8')
  return { directory, spec }
}

test('the specification itself is refused as a destination', async (t) => {
  const { spec } = await workspace(t)
  await assert.rejects(() => resolveMatrixDestination(spec, spec), /must be written elsewhere/)
})

test('a hard link to the specification is refused, though its path differs', async (t) => {
  const { directory, spec } = await workspace(t)
  const hard = join(directory, 'also-connectors.json')
  await link(spec, hard)
  // The comparison a path-only guard makes, and why it is not enough: the two
  // names resolve to two different real paths while naming one inode, so only
  // the device-and-inode test can answer.
  assert.notEqual(hard, spec)
  assert.notEqual(await realpath(hard), await realpath(spec))
  await assert.rejects(() => resolveMatrixDestination(spec, hard), /must be written elsewhere/)
  // The specification is still intact, which is the property that matters.
  assert.deepEqual(JSON.parse(await readFile(spec, 'utf8')), SPEC)
})

test('a symbolic link to the specification is refused', async (t) => {
  const { directory, spec } = await workspace(t)
  const soft = join(directory, 'link-to-connectors.json')
  await symlink(spec, soft)
  await assert.rejects(() => resolveMatrixDestination(spec, soft), /must be written elsewhere/)
})

test('a legitimate destination under a symlinked directory is not refused', async (t) => {
  const { directory, spec } = await workspace(t)
  const real = join(directory, 'out')
  await mkdir(real)
  const linked = join(directory, 'out-link')
  await symlink(real, linked)
  const resolved = await resolveMatrixDestination(spec, join(linked, 'nested', 'matrix.json'))
  assert.equal(resolved.endsWith(join('out', 'nested', 'matrix.json')), true, resolved)
  await writeMatrixFile(resolved, { hello: 'world' })
  assert.deepEqual(JSON.parse(await readFile(join(real, 'nested', 'matrix.json'), 'utf8')), { hello: 'world' })
})

test('a specification reached through a symlinked directory is still protected', async (t) => {
  const { directory, spec } = await workspace(t)
  const linkedDirectory = join(directory, 'by-another-name')
  await symlink(directory, linkedDirectory)
  await assert.rejects(
    () => resolveMatrixDestination(join(linkedDirectory, 'connectors.json'), spec),
    /must be written elsewhere/,
  )
})

test('a destination that does not exist yet is accepted and its parents are created', async (t) => {
  const { directory, spec } = await workspace(t)
  const destination = await resolveMatrixDestination(spec, join(directory, 'a', 'b', 'matrix.json'))
  const { matrix } = await compareConnectorFile(spec, { source: 'connectors.json' })
  await writeMatrixFile(destination, matrix)
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'connector-capability-matrix')
  assert.equal(written.connectors[0].cells[0].state, 'unsupported')
})

test('an unusable destination is refused before anything is read', async (t) => {
  const { spec } = await workspace(t)
  await assert.rejects(() => resolveMatrixDestination(spec, ''), /non-empty path/)
  await assert.rejects(() => resolveMatrixDestination(spec, '   '), /non-empty path/)
  await assert.rejects(() => resolveMatrixDestination(spec, 42), TypeError)
  await assert.rejects(() => resolveMatrixDestination(join(spec, 'absent.json'), 'out.json'), /could not be resolved/)
})
