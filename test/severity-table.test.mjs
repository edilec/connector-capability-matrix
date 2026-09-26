import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { INCOMPLETE_RULES, RULE_SEVERITY, severityOf } from '../src/index.mjs'
import { DEFAULT_LIMITS } from '../src/spec.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILES = ['src/index.mjs', 'src/spec.mjs', 'src/matrix.mjs', 'src/text.mjs']

/**
 * The table, the documented catalog and the shipped source agree.
 *
 * This is a consistency check, not the severity guard. Three declarations
 * agreeing with one another can all be edited together, and a catalog where
 * that was the only defence had forty error rules survive being flipped to
 * warnings. The guard is `test/severity-behaviour.test.mjs`, which drives every
 * rule through the real command line and states each outcome as a literal.
 *
 * What lives here is the one thing that guard cannot check about itself: that
 * it has a case for every rule, and that it still imports nothing from `src/`.
 * A guard that imported the table would be a fourth declaration agreeing with
 * the other three.
 */

const readProjectFile = (relativePath) => readFile(resolve(projectDirectory, relativePath), 'utf8')

async function documentedRules() {
  const text = await readProjectFile('docs/capability-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|\s*(yes|no)\s*\|/g)]
  return rows.map(([, ruleId, severity, incomplete]) => ({ ruleId, severity, incomplete: incomplete === 'yes' }))
}

test('the documented catalog and the severity table list the same rules, with the same severities', async () => {
  const documented = await documentedRules()
  assert.equal(documented.length, 42)
  assert.deepEqual(
    documented.map((row) => row.ruleId).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/capability-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(Object.fromEntries(documented.map((row) => [row.ruleId, row.severity])), { ...RULE_SEVERITY })
})

test('the documented incomplete column and INCOMPLETE_RULES agree in both directions', async () => {
  const documented = await documentedRules()
  assert.deepEqual(
    documented.filter((row) => row.incomplete).map((row) => row.ruleId).sort(),
    [...INCOMPLETE_RULES].sort(),
  )
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} marks a run incomplete but has no severity`)
  }
  // The four that state a fact rather than a gap. Adding a fifth without
  // thinking about it should be a decision, not an accident.
  assert.deepEqual(
    Object.keys(RULE_SEVERITY).filter((ruleId) => !INCOMPLETE_RULES.includes(ruleId)).sort(),
    ['capability-unsupported-everywhere', 'claim-contradicted', 'required-capability-unclaimed', 'unsupported-capability-observed'],
  )
})

test('every rule in the table has a case of its own in the behavioural guard', async () => {
  const text = await readProjectFile('test/severity-behaviour.test.mjs')
  assert.equal(
    text.includes("from '../src/index.mjs'"),
    false,
    'the behavioural guard imports the table it exists to defend',
  )
  assert.equal(text.includes("from '../src/"), false, 'the behavioural guard imports from the source it exists to defend')
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(
      text,
      new RegExp(`run\\(\\s*'${ruleId}'`),
      `${ruleId} has no case in test/severity-behaviour.test.mjs`,
    )
  }
  assert.equal(Object.keys(RULE_SEVERITY).length, 42)
})

test('the README states the size of the catalog, and states it right', async () => {
  // A README that said fourteen while the code declared twenty-five went
  // unnoticed in another tool, because the consistency test read the docs and
  // never the README.
  const text = await readProjectFile('README.md')
  const stated = /\| Rules \| (\d+), of which (\d+) make the run `incomplete` \|/.exec(text)
  assert.notEqual(stated, null, 'the README no longer states the size of the catalog')
  assert.equal(Number(stated[1]), Object.keys(RULE_SEVERITY).length)
  assert.equal(Number(stated[2]), INCOMPLETE_RULES.length)
  const limits = /\| Limits \| (\d+), each with a flag and a default \|/.exec(text)
  assert.notEqual(limits, null, 'the README no longer states how many limits there are')
  assert.equal(Number(limits[1]), Object.keys(DEFAULT_LIMITS).length)
})

test('the README\'s summary of what the tool checks accounts for every rule', () => {
  // The table names some rules and counts the rest. Both halves drift, and a
  // drifting count is exactly the kind of claim nobody notices is wrong: this
  // one said "14 rules" for a group of twenty-two.
  return readProjectFile('README.md').then((text) => {
    const section = text.slice(text.indexOf('## What it checks'), text.indexOf('| Catalog | Size |'))
    assert.equal(section.length > 200, true, 'the README no longer has a "What it checks" table')
    const named = new Set(
      [...section.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]).filter((id) => Object.hasOwn(RULE_SEVERITY, id)),
    )
    const counted = [...section.matchAll(/\| (\d+) rules \|/g)].reduce((total, match) => total + Number(match[1]), 0)
    assert.equal(
      named.size + counted,
      Object.keys(RULE_SEVERITY).length,
      `the README accounts for ${named.size} named and ${counted} counted rules, of ${Object.keys(RULE_SEVERITY).length}`,
    )
  })
})

test('every rule the source emits is in the severity table', async () => {
  const sources = await Promise.all(SOURCE_FILES.map((path) => readProjectFile(path)))
  const text = sources.join('\n')
  const emitted = new Set([
    ...[...text.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]),
    ...[...text.matchAll(/problem\(\s*'([a-z0-9-]+)'/g)].map((match) => match[1]),
  ])
  assert.ok(emitted.size > 30, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('every rule in the table is one the source can actually emit', async () => {
  const sources = await Promise.all(SOURCE_FILES.map((path) => readProjectFile(path)))
  const text = sources.join('\n')
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(text.includes(`'${ruleId}'`), `${ruleId} is declared but no source file names it`)
  }
})

test('an unknown rule id throws rather than defaulting to a severity', () => {
  // The one property the frozen table has to have, exercised rather than
  // grepped for: a finding built for a rule nobody declared a severity for is a
  // programming error. Left to default, its severity would be `undefined`, the
  // errors and warnings counts would drop it and `JSON.stringify` would omit
  // the field, so it would reach a report as a finding nobody could triage.
  //
  // The previous version of this test read the source for the message string
  // and asserted that an exported function was a function. Deleting the throw
  // left it green.
  // Not a fourth copy of the severities: this states that severityOf hands back
  // whatever the table declares, for every rule the table declares. A
  // coordinated edit of the table and the docs moves this with them, which is
  // the point -- the severities themselves are pinned behaviourally, in
  // test/severity-behaviour.test.mjs.
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.equal(severityOf(ruleId), severity, ruleId)
  }
  assert.throws(
    () => severityOf('a-rule-nobody-declared'),
    /No severity is declared for rule "a-rule-nobody-declared"/,
  )
  // An inherited property is not a declaration. An index lookup would hand back
  // a function here and call the rule declared.
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => severityOf(inherited), /No severity is declared for rule/, inherited)
  }
})

test('every documented limit is a real limit, and every real limit is documented', async () => {
  const text = await readProjectFile('docs/capability-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map(([, name, , value]) => [name, Number(value)]))
  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const help = await readProjectFile('bin/connector-capability-matrix.mjs')
  for (const [, name, flag] of rows) {
    assert.ok(help.includes(flag), `${name} is documented as ${flag}, which the CLI does not accept`)
  }
})
