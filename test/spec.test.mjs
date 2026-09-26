import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPABILITY_GROUPS,
  DEFAULT_LIMITS,
  ID_LIMIT,
  normalizeSpec,
  readSpecDocument,
  validateLimits,
} from '../src/spec.mjs'

const encode = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const limits = validateLimits({})
const spec = (extra) => ({ schemaVersion: '1', ...extra })
const rules = (result) => result.problems.map((problem) => problem.ruleId).sort()

test('validateLimits refuses an unknown key rather than ignoring it', () => {
  // A typo that is silently dropped leaves the default in force while the
  // operator believes a stricter bound is being enforced.
  assert.throws(() => validateLimits({ maxConectors: 4 }), /Unknown limit "maxConectors"/)
  assert.throws(() => validateLimits({ maxConnectors: 0 }), /at least 1/)
  assert.throws(() => validateLimits({ maxConnectors: 2.5 }), /at least 1/)
  assert.throws(() => validateLimits('nope'), TypeError)
  assert.equal(validateLimits({ maxConnectors: 1 }).maxConnectors, 1)
  assert.equal(validateLimits({ maxMillis: 0 }).maxMillis, 0)
  assert.equal(validateLimits({}).maxBytes, DEFAULT_LIMITS.maxBytes)
})

test('readSpecDocument enforces its bounds from both sides', () => {
  const document = spec({ connectors: [] })
  const bytes = encode(document)
  assert.equal(readSpecDocument(bytes, validateLimits({ maxBytes: bytes.byteLength })).ok, true)
  assert.equal(readSpecDocument(bytes, validateLimits({ maxBytes: bytes.byteLength - 1 })).ruleId, 'spec-too-large')
})

test('readSpecDocument decodes strictly, parses strictly and bounds the nesting', () => {
  assert.equal(readSpecDocument(new Uint8Array([0xc3, 0x28]), limits).ruleId, 'spec-not-utf8')
  assert.equal(readSpecDocument(encode('{ not json'), limits).ruleId, 'spec-not-json')
  assert.throws(() => readSpecDocument('a string', limits), TypeError)
})

test('the depth bound is exact: the deepest legal document passes and one deeper does not', () => {
  // The claim object sits at depth 5: document(1) connectors(2) entry(3)
  // capabilities(4) claim(5), and its "state" value at 6.
  const document = spec({
    capabilities: [{ id: 'a', group: 'operations' }],
    connectors: [{ id: 'c', capabilities: { a: { state: 'supported' } } }],
  })
  assert.equal(readSpecDocument(encode(document), validateLimits({ maxDepth: 6 })).ok, true)
  assert.equal(readSpecDocument(encode(document), validateLimits({ maxDepth: 5 })).ruleId, 'spec-too-deep')
})

test('a document in an unsupported dialect stops the run instead of being partly read', () => {
  const result = normalizeSpec({ schemaVersion: '2', connectors: [{ id: 'c' }] }, limits)
  assert.equal(result.stopped, true)
  assert.deepEqual(rules(result), ['schema-version-unsupported'])
  assert.equal(result.connectors.length, 0)
  const missing = normalizeSpec({ connectors: [] }, limits)
  assert.deepEqual(rules(missing), ['schema-version-unsupported'])
  assert.match(missing.problems[0].message, /declares schemaVersion nothing/)
})

test('an unknown key is reported wherever it appears, and never guessed at', () => {
  const result = normalizeSpec(spec({
    capabilities: [{ id: 'a', group: 'operations', requird: true }],
    connectors: [{ id: 'c', capabilities: { a: 'supported' }, rateLimit: { requests: 1, windowSeconds: 1, burst: 2 } }],
    observations: [{ connector: 'c', capability: 'a', kind: 'manual-check', result: 'supported', reference: 'r', when: 'later' }],
    extras: true,
  }), limits)
  assert.deepEqual(
    result.problems.filter((problem) => problem.ruleId === 'unknown-declaration-key').map((problem) => problem.pointer),
    ['/', '/capabilities/0', '/connectors/c/rateLimit', '/observations/0'],
  )
})

test('a capability the matrix has no column for is refused, and its id is remembered', () => {
  const result = normalizeSpec(spec({
    capabilities: [{ id: 'weird', group: 'telepathy' }],
    connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { weird: 'supported' } }],
    observations: [{ connector: 'c', capability: 'weird', kind: 'manual-check', result: 'supported', reference: 'r' }],
  }), limits)
  // One finding, not three: the claim and the observation name a capability
  // that was already refused once, and repeating it would describe the same
  // defect three times.
  assert.deepEqual(rules(result), ['capability-group-unknown'])
  assert.equal(result.refusedCapabilities.has('weird'), true)
  assert.match(result.problems[0].message, new RegExp(CAPABILITY_GROUPS.join(', ')))
})

test('an id that is not an identifier is refused rather than repaired', () => {
  const result = normalizeSpec(spec({
    capabilities: [{ id: 'has space', group: 'operations' }, { id: 'x'.repeat(ID_LIMIT + 1), group: 'operations' }],
    connectors: [{ id: '9lives' }],
  }), limits)
  assert.deepEqual(rules(result), ['capability-id-invalid', 'capability-id-invalid', 'connector-id-invalid'])
  assert.equal(result.capabilities.length, 0)
  assert.equal(result.connectors.length, 0)
})

test('a duplicate id keeps the first declaration and refuses the repeat', () => {
  const result = normalizeSpec(spec({
    capabilities: [{ id: 'a', group: 'operations', title: 'first' }, { id: 'a', group: 'pagination', title: 'second' }],
    connectors: [
      { id: 'c', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'unsupported' } },
      { id: 'c', rateLimit: { requests: 9, windowSeconds: 9 }, capabilities: { a: 'unsupported' } },
    ],
  }), limits)
  assert.deepEqual(rules(result), ['capability-id-duplicated', 'connector-id-duplicated'])
  assert.equal(result.capabilities.length, 1)
  assert.equal(result.capabilities[0].title, 'first')
  assert.equal(result.connectors.length, 1)
  assert.equal(result.connectors[0].rateLimit.requests, 1)
})

test('a rate limit is read whole or not at all', () => {
  const of = (rateLimit) => normalizeSpec(spec({
    capabilities: [], connectors: [{ id: 'c', rateLimit }],
  }), limits)
  assert.equal(of({ requests: 100, windowSeconds: 60 }).connectors[0].rateLimit.concurrency, null)
  assert.deepEqual(
    of({ requests: 100, windowSeconds: 60, concurrency: 3, retryAfterHonoured: false }).connectors[0].rateLimit,
    { requests: 100, windowSeconds: 60, concurrency: 3, retryAfterHonoured: false },
  )
  for (const bad of [{ requests: 100 }, { requests: 0, windowSeconds: 60 }, { requests: 1, windowSeconds: 1.5 }, 'fast', { requests: 1, windowSeconds: 1, retryAfterHonoured: 'yes' }]) {
    const result = of(bad)
    assert.equal(result.connectors[0].rateLimit, null, `${JSON.stringify(bad)} was read anyway`)
    assert.equal(result.problems.some((problem) => problem.ruleId === 'rate-limit-malformed'), true)
  }
  assert.equal(of(undefined).problems.some((problem) => problem.ruleId === 'rate-limit-undeclared'), true)
})

test('a claim is a state word or an object carrying one, and nothing else', () => {
  const of = (claim) => normalizeSpec(spec({
    capabilities: [{ id: 'a', group: 'operations' }],
    connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: claim } }],
  }), limits)
  assert.equal(of('supported').connectors[0].claims.get('a').state, 'supported')
  assert.equal(of({ state: 'unsupported', note: 'no endpoint' }).connectors[0].claims.get('a').note, 'no endpoint')
  for (const [claim, ruleId] of [
    ['partial', 'claim-state-unknown'],
    [{ state: 'beta' }, 'claim-state-unknown'],
    [true, 'claim-malformed'],
    [{ state: 7 }, 'claim-malformed'],
    [['supported'], 'claim-malformed'],
  ]) {
    const result = of(claim)
    assert.deepEqual(rules(result), [ruleId], `${JSON.stringify(claim)} was read as a claim`)
    assert.equal(result.connectors[0].claims.size, 0)
    assert.equal(result.connectors[0].unreadableClaims.has('a'), true)
  }
})

test('an observation is refused unless every part of it can be read', () => {
  const of = (observation) => normalizeSpec(spec({
    capabilities: [{ id: 'a', group: 'operations' }],
    connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'supported' } }],
    observations: [observation],
  }), limits)
  const good = { connector: 'c', capability: 'a', kind: 'contract-test', result: 'supported', reference: 'test/a.mjs' }
  assert.equal(of(good).observations.length, 1)
  for (const [change, ruleId] of [
    [{ connector: 'nope' }, 'observation-unknown-connector'],
    [{ capability: 'nope' }, 'observation-unknown-capability'],
    [{ kind: 'vibes' }, 'observation-kind-unknown'],
    [{ result: 'probably' }, 'observation-result-unknown'],
    [{ reference: '' }, 'observation-malformed'],
    [{ reference: 'x'.repeat(1000) }, 'observation-malformed'],
    [{ connector: 'has space' }, 'observation-malformed'],
    [{ capability: 4 }, 'observation-malformed'],
  ]) {
    const result = of({ ...good, ...change })
    assert.equal(result.observations.length, 0, `${JSON.stringify(change)} was counted as evidence`)
    assert.equal(result.problems.some((problem) => problem.ruleId === ruleId), true, `${JSON.stringify(change)} gave ${rules(result)}`)
  }
})

test('a connector-level limit refuses the connector rather than part of its specification', () => {
  const result = normalizeSpec(spec({
    capabilities: [{ id: 'a', group: 'operations' }, { id: 'b', group: 'operations' }],
    connectors: [{ id: 'c', rateLimit: { requests: 1, windowSeconds: 1 }, capabilities: { a: 'supported', b: 'supported' } }],
    observations: [{ connector: 'c', capability: 'a', kind: 'manual-check', result: 'supported', reference: 'r' }],
  }), validateLimits({ maxClaimsPerConnector: 1 }))
  assert.deepEqual(rules(result), ['too-many-claims'])
  assert.equal(result.connectors.length, 0)
  assert.equal(result.refusedConnectors.has('c'), true)
  // The observation named a connector that is gone, and saying so would be a
  // second finding about the one defect.
  assert.equal(result.observations.length, 0)
})

test('a document-level limit stops the run, so nothing after it is half read', () => {
  const document = spec({
    capabilities: [{ id: 'a', group: 'operations' }, { id: 'b', group: 'operations' }],
    connectors: [{ id: 'c' }],
    observations: [],
  })
  const result = normalizeSpec(document, validateLimits({ maxCapabilities: 1 }))
  assert.deepEqual(rules(result), ['too-many-capabilities'])
  assert.equal(result.stopped, true)
  assert.equal(result.connectors.length, 0)
  assert.equal(result.declared.capabilities, 2)
})
