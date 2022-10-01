/**
 * The connector specification document: its limits, its grammar, and the
 * normalisation that turns it into declarations this tool can compare.
 *
 * Nothing in this module opens a socket, calls a connector, reads a clock or
 * resolves a path. It answers one question -- what did this document actually
 * declare -- and records a problem for every part of it that could not be
 * understood. A part that could not be understood is never quietly defaulted:
 * the caller turns each problem into a finding, and the rules that mean "this
 * question could not be answered" mark the whole run incomplete.
 */

import { decodeUtf8, sanitize } from './text.mjs'

/**
 * The one document dialect this tool supports.
 *
 * A dialect it does not know is reported as unsupported and stops the run. The
 * alternative -- reading the keys it recognises and ignoring the rest -- would
 * report a verdict about a document whose meaning it guessed at, which is the
 * exact shape of "unsupported construct silently treated as satisfied".
 */
export const SPEC_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A specification is ordinary untrusted input: it can be a generated 40 MB
 * document, ten thousand connectors, or a structure nested deeply enough to
 * exhaust a recursive walk. Every limit is explicit, overridable from the
 * command line and from a configuration file, and named in the finding when it
 * is reached. Exceeding one produces an `incomplete` report -- never a quietly
 * shorter matrix, and never a pass.
 *
 * `maxMillis` is the only limit that may be zero: a budget of zero is spent
 * before any work is done, so it is the one budget whose effect needs no
 * fixture at all. It says nothing about whether a real clock is wired in,
 * though -- only a budget the work outlives can, which is what the nonzero
 * case in `test/limits.test.mjs` runs.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1048576,
  maxCapabilities: 200,
  maxConnectors: 100,
  maxClaimsPerConnector: 200,
  maxObservations: 2000,
  maxDepth: 12,
  maxMillis: 5000,
})

/** The one limit measured in time, and so the one limit allowed to be zero. */
const ZERO_ALLOWED = Object.freeze(['maxMillis'])

/**
 * Validate limit overrides.
 *
 * An unknown key throws rather than being ignored. A one-character typo that is
 * silently dropped leaves the default in force while the operator believes a
 * stricter bound is being enforced, which is how a documented limit stops being
 * enforced without anyone noticing -- and how a real failure turns green.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${sanitize(name, 60)}"`)
    const floor = ZERO_ALLOWED.includes(name) ? 0 : 1
    if (!Number.isInteger(value) || value < floor) {
      throw new TypeError(`Limit "${name}" must be an integer of at least ${floor}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * The grammar of an identifier.
 *
 * A connector id and a capability id both name something a person, a report and
 * another tool have to refer to. The pattern is deliberately narrow: an id that
 * does not match is reported rather than repaired, because silently renaming a
 * declaration would change which cell of the matrix it lands in.
 *
 * The narrowness is also what makes a JSON Pointer safe to build by
 * interpolation. `/` and `~` are the two characters RFC 6901 must escape, and
 * neither is in this grammar, so an id that reaches a pointer needs no escaping
 * and an id that would have needed it never reaches one -- it is reported at an
 * index-based pointer instead.
 */
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/
export const ID_LIMIT = 100
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const REFERENCE_LIMIT = 200
export const NOTE_LIMIT = 400

/**
 * The capability groups, in the order the matrix presents them.
 *
 * This is a declared order, not a sorted one: a group's position is its index
 * here. Presenting operations before authentication before pagination before
 * rate limits is an editorial decision about how the comparison reads, and
 * making it a fixed list keeps it out of reach of any collation table.
 */
export const CAPABILITY_GROUPS = Object.freeze(['operations', 'authentication', 'pagination', 'rate-limit'])

/**
 * The two things a specification may claim about a capability.
 *
 * There is deliberately no "partial", "beta" or "planned". A word this tool
 * does not know is reported as unsupported input and makes the run incomplete;
 * mapping it onto one of these two would be inventing evidence. The third
 * matrix state -- `unverified` -- is never claimed, only concluded.
 */
export const CLAIM_STATES = Object.freeze(['supported', 'unsupported'])

/** The kinds of observation this tool accepts as evidence. */
export const OBSERVATION_KINDS = Object.freeze(['contract-test', 'manual-check', 'recorded-response', 'sandbox-run'])

/** What an observation found. `inconclusive` is evidence that settled nothing. */
export const OBSERVATION_RESULTS = Object.freeze(['supported', 'unsupported', 'inconclusive'])

export const DOCUMENT_KEYS = Object.freeze([
  'capabilities', 'connectors', 'description', 'matrix', 'observations', 'schemaVersion',
])
export const CAPABILITY_KEYS = Object.freeze(['description', 'group', 'id', 'required', 'title'])
export const CONNECTOR_KEYS = Object.freeze(['capabilities', 'description', 'id', 'rateLimit', 'title', 'version'])
export const CLAIM_KEYS = Object.freeze(['note', 'state'])
export const OBSERVATION_KEYS = Object.freeze(['capability', 'connector', 'kind', 'reference', 'result'])
export const RATE_LIMIT_KEYS = Object.freeze(['concurrency', 'requests', 'retryAfterHonoured', 'windowSeconds'])

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function problem(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, ...extra }
}

/**
 * Read the specification document from bytes.
 *
 * Byte length is checked before decoding, decoding is strict, parsing follows,
 * and the structural depth of the parsed value is bounded last. Each failure
 * names the document rather than guessing at its contents, and every one of
 * them makes the run incomplete: a document that was not read is not evidence
 * that a connector works.
 */
export function readSpecDocument(bytes, limits) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Specification bytes must be a Uint8Array')
  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      ruleId: 'spec-too-large',
      message: `The specification is ${bytes.byteLength} bytes, over the maxBytes budget of ${limits.maxBytes}; it was not read.`,
      suggestion: 'Raise --max-bytes deliberately, or split the catalog into smaller specifications.',
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      ruleId: 'spec-not-utf8',
      message: 'The specification is not valid UTF-8, so no connector in it was compared.',
      suggestion: 'Re-encode the specification as UTF-8.',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return {
      ok: false,
      ruleId: 'spec-not-json',
      message: 'The specification is not valid JSON, so no connector in it was compared.',
      evidence: String(error.message),
    }
  }
  if (!withinDepth(parsed, limits.maxDepth)) {
    return {
      ok: false,
      ruleId: 'spec-too-deep',
      message: `The specification nests deeper than the maxDepth budget of ${limits.maxDepth}, so it was not compared.`,
      suggestion: 'Raise --max-depth deliberately, or flatten the document.',
    }
  }
  return { ok: true, spec: parsed }
}

/**
 * Bound the structure before anything walks it.
 *
 * The walk is iterative on purpose: a recursive depth check is itself the thing
 * a deeply nested document breaks, and a RangeError from an exhausted stack is
 * a much worse diagnostic than a named limit. The top-level value is depth 1.
 */
function withinDepth(value, maxDepth) {
  const stack = [{ node: value, depth: 1 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop()
    if (depth > maxDepth) return false
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 })
    } else if (isRecord(node)) {
      for (const key of Object.keys(node)) stack.push({ node: node[key], depth: depth + 1 })
    }
  }
  return true
}

function checkKeys(raw, allowed, pointer, what, problems) {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue
    problems.push(problem(
      'unknown-declaration-key',
      pointer,
      `${what} declares an unknown key "${sanitize(key, 60)}"; its intent could not be read.`,
      { suggestion: `Remove the key, or correct it to one of: ${allowed.join(', ')}.` },
    ))
  }
}

function readOptionalString(raw, key, limit, pointer, what, problems) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined) return null
  const value = raw[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) {
    problems.push(problem(
      what.ruleId,
      pointer,
      `${what.subject} declares "${key}" as ${describe(value)}, which is not a non-empty string of at most ${limit} characters; it was not read.`,
      { suggestion: `Give "${key}" a short string, or remove it.` },
    ))
    return null
  }
  return value
}

/**
 * Normalise the whole document.
 *
 * Capabilities are read first because they are the catalog every other
 * declaration refers to: a claim or an observation naming a capability the
 * catalog does not declare is a fact worth reporting, and it can only be known
 * once the catalog is complete.
 */
export function normalizeSpec(raw, limits) {
  const problems = []
  const state = {
    matrix: null,
    capabilities: [],
    connectors: [],
    observations: [],
    declared: { capabilities: 0, connectors: 0, observations: 0 },
    refusedCapabilities: new Set(),
    refusedConnectors: new Set(),
    problems,
    stopped: false,
  }

  if (!isRecord(raw)) {
    problems.push(problem(
      'spec-malformed',
      '/',
      `The specification is ${describe(raw)}, not an object, so no connector in it was compared.`,
      { suggestion: 'The document must be a JSON object with "schemaVersion", "capabilities" and "connectors".' },
    ))
    state.stopped = true
    return state
  }

  if (raw.schemaVersion !== SPEC_SCHEMA_VERSION) {
    const found = typeof raw.schemaVersion === 'string'
      ? `"${sanitize(raw.schemaVersion, 40)}"`
      : Object.hasOwn(raw, 'schemaVersion') ? describe(raw.schemaVersion) : 'nothing'
    problems.push(problem(
      'schema-version-unsupported',
      '/schemaVersion',
      `The specification declares schemaVersion ${found}; this tool supports "${SPEC_SCHEMA_VERSION}" only, so nothing in the document was compared.`,
      { suggestion: `Convert the document to schemaVersion "${SPEC_SCHEMA_VERSION}", or use a release of this tool that supports the dialect you have.` },
    ))
    state.stopped = true
    return state
  }

  checkKeys(raw, DOCUMENT_KEYS, '/', 'The specification', problems)
  state.matrix = readOptionalString(
    raw, 'matrix', ID_LIMIT, '/', { ruleId: 'spec-malformed', subject: 'The specification' }, problems,
  )

  const capabilities = readArray(raw, 'capabilities', '/capabilities', 'The specification', problems)
  state.declared.capabilities = capabilities.length
  if (capabilities.length > limits.maxCapabilities) {
    problems.push(problem(
      'too-many-capabilities',
      '/capabilities',
      `The specification declares ${capabilities.length} capabilities, over the maxCapabilities budget of ${limits.maxCapabilities}; none of them were compared.`,
      { suggestion: 'Raise --max-capabilities deliberately, or split the catalog.' },
    ))
    state.stopped = true
    return state
  }
  const known = new Map()
  for (const [index, entry] of capabilities.entries()) {
    const capability = normalizeCapability(entry, index, known, state, problems)
    if (capability !== null) {
      known.set(capability.id, capability)
      state.capabilities.push(capability)
    }
  }

  const connectors = readArray(raw, 'connectors', '/connectors', 'The specification', problems)
  state.declared.connectors = connectors.length
  if (connectors.length > limits.maxConnectors) {
    problems.push(problem(
      'too-many-connectors',
      '/connectors',
      `The specification declares ${connectors.length} connectors, over the maxConnectors budget of ${limits.maxConnectors}; none of them were compared.`,
      { suggestion: 'Raise --max-connectors deliberately, or split the catalog.' },
    ))
    state.stopped = true
    return state
  }
  const seenConnectors = new Set()
  for (const [index, entry] of connectors.entries()) {
    const connector = normalizeConnector(entry, index, known, seenConnectors, state, limits, problems)
    if (connector !== null) {
      seenConnectors.add(connector.id)
      state.connectors.push(connector)
    }
  }

  const observations = readArray(raw, 'observations', '/observations', 'The specification', problems)
  state.declared.observations = observations.length
  if (observations.length > limits.maxObservations) {
    problems.push(problem(
      'too-many-observations',
      '/observations',
      `The specification declares ${observations.length} observations, over the maxObservations budget of ${limits.maxObservations}; none of them were read, so no claim in the document could be verified.`,
      { suggestion: 'Raise --max-observations deliberately, or split the catalog.' },
    ))
    state.stopped = true
    return state
  }
  for (const [index, entry] of observations.entries()) {
    const observation = normalizeObservation(entry, index, known, seenConnectors, state, problems)
    if (observation !== null) state.observations.push(observation)
  }

  return state
}

function readArray(raw, key, pointer, what, problems) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined) return []
  const value = raw[key]
  if (!Array.isArray(value)) {
    problems.push(problem(
      'spec-malformed',
      pointer,
      `${what} declares "${key}" as ${describe(value)}, not an array, so nothing under it was read.`,
      { suggestion: `Declare "${key}" as an array.` },
    ))
    return []
  }
  return value
}

function normalizeCapability(raw, index, known, state, problems) {
  const at = `/capabilities/${index}`
  if (!isRecord(raw)) {
    problems.push(problem(
      'capability-malformed',
      at,
      `Capability ${index} is ${describe(raw)}, not an object, so it was left out of the matrix.`,
      { suggestion: 'Declare each capability as an object with "id" and "group".' },
    ))
    return null
  }
  checkKeys(raw, CAPABILITY_KEYS, at, `Capability ${index}`, problems)

  const id = raw.id
  if (typeof id !== 'string' || id.length > ID_LIMIT || !ID_PATTERN.test(id)) {
    problems.push(problem(
      'capability-id-invalid',
      at,
      `Capability ${index} declares an id that is not an identifier of at most ${ID_LIMIT} characters matching ${ID_PATTERN.source}, so it was left out of the matrix.`,
      { evidence: typeof id === 'string' ? id : describe(id), suggestion: 'Give the capability an identifier such as "list-records".' },
    ))
    return null
  }
  const pointer = `/capabilities/${id}`
  if (known.has(id)) {
    problems.push(problem(
      'capability-id-duplicated',
      pointer,
      `Capability "${sanitize(id, ID_LIMIT)}" is declared more than once; only the first declaration was used, and this one was left out of the matrix.`,
      { suggestion: 'Rename one of the two capabilities, or remove the repeat.' },
    ))
    return null
  }

  const group = raw.group
  if (typeof group !== 'string' || !CAPABILITY_GROUPS.includes(group)) {
    problems.push(problem(
      'capability-group-unknown',
      pointer,
      `Capability "${sanitize(id, ID_LIMIT)}" declares group ${typeof group === 'string' ? `"${sanitize(group, 60)}"` : describe(group)}, which is not one of ${CAPABILITY_GROUPS.join(', ')}; the matrix has no column to put it in, so it was left out.`,
      { suggestion: `Use one of: ${CAPABILITY_GROUPS.join(', ')}.` },
    ))
    // The id is real even though the capability was refused, so a claim or an
    // observation naming it is suppressed rather than reported a second time.
    state.refusedCapabilities.add(id)
    return null
  }

  const title = readOptionalString(
    raw, 'title', NOTE_LIMIT, pointer,
    { ruleId: 'capability-malformed', subject: `Capability "${sanitize(id, ID_LIMIT)}"` }, problems,
  )

  let required = false
  if (Object.hasOwn(raw, 'required') && raw.required !== undefined) {
    if (typeof raw.required !== 'boolean') {
      problems.push(problem(
        'capability-malformed',
        pointer,
        `Capability "${sanitize(id, ID_LIMIT)}" declares "required" as ${describe(raw.required)}, not a boolean, so whether it is required could not be read; it was treated as optional.`,
        { suggestion: 'Declare "required" as true or false, or remove it.' },
      ))
    } else {
      required = raw.required
    }
  }

  return { id, group, groupIndex: CAPABILITY_GROUPS.indexOf(group), title, required, pointer }
}

function normalizeConnector(raw, index, known, seen, state, limits, problems) {
  const at = `/connectors/${index}`
  if (!isRecord(raw)) {
    problems.push(problem(
      'connector-malformed',
      at,
      `Connector ${index} is ${describe(raw)}, not an object, so it was left out of the matrix.`,
      { suggestion: 'Declare each connector as an object with "id".' },
    ))
    return null
  }
  checkKeys(raw, CONNECTOR_KEYS, at, `Connector ${index}`, problems)

  const id = raw.id
  if (typeof id !== 'string' || id.length > ID_LIMIT || !ID_PATTERN.test(id)) {
    problems.push(problem(
      'connector-id-invalid',
      at,
      `Connector ${index} declares an id that is not an identifier of at most ${ID_LIMIT} characters matching ${ID_PATTERN.source}, so it was left out of the matrix.`,
      { evidence: typeof id === 'string' ? id : describe(id), suggestion: 'Give the connector an identifier such as "acme-crm".' },
    ))
    return null
  }
  const pointer = `/connectors/${id}`
  if (seen.has(id)) {
    problems.push(problem(
      'connector-id-duplicated',
      pointer,
      `Connector "${sanitize(id, ID_LIMIT)}" is declared more than once; only the first declaration was used, and this one was left out of the matrix.`,
      { suggestion: 'Rename one of the two connectors, or remove the repeat.' },
    ))
    return null
  }

  const title = readOptionalString(
    raw, 'title', NOTE_LIMIT, pointer,
    { ruleId: 'connector-malformed', subject: `Connector "${sanitize(id, ID_LIMIT)}"` }, problems,
  )

  let version = null
  if (Object.hasOwn(raw, 'version') && raw.version !== undefined) {
    if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
      problems.push(problem(
        'connector-version-invalid',
        pointer,
        `Connector "${sanitize(id, ID_LIMIT)}" declares a version that is not major.minor.patch, so the version column of the matrix is blank for it.`,
        { evidence: typeof raw.version === 'string' ? raw.version : describe(raw.version) },
      ))
    } else {
      version = raw.version
    }
  }

  const rateLimit = normalizeRateLimit(raw, id, pointer, problems)

  const claims = new Map()
  const unreadableClaims = new Set()
  let claimsRead = true
  const declaredClaims = raw.capabilities
  if (Object.hasOwn(raw, 'capabilities') && declaredClaims !== undefined && !isRecord(declaredClaims)) {
    problems.push(problem(
      'connector-malformed',
      `${pointer}/capabilities`,
      `Connector "${sanitize(id, ID_LIMIT)}" declares "capabilities" as ${describe(declaredClaims)}, not an object mapping capability id to a claim, so none of its claims were read.`,
      { suggestion: 'Declare "capabilities" as an object such as { "list-records": "supported" }.' },
    ))
    claimsRead = false
  } else if (isRecord(declaredClaims)) {
    const keys = Object.keys(declaredClaims)
    if (keys.length > limits.maxClaimsPerConnector) {
      problems.push(problem(
        'too-many-claims',
        `${pointer}/capabilities`,
        `Connector "${sanitize(id, ID_LIMIT)}" declares ${keys.length} claims, over the maxClaimsPerConnector budget of ${limits.maxClaimsPerConnector}; the connector was left out of the matrix rather than compared on part of its specification.`,
        { suggestion: 'Raise --max-claims-per-connector deliberately, or split the connector.' },
      ))
      state.refusedConnectors.add(id)
      return null
    }
    for (const key of keys) {
      readClaim(key, declaredClaims[key], id, pointer, known, state, claims, unreadableClaims, problems)
    }
  }

  return { id, title, version, rateLimit, claims, unreadableClaims, claimsRead, pointer }
}

function normalizeRateLimit(raw, id, pointer, problems) {
  const at = `${pointer}/rateLimit`
  if (!Object.hasOwn(raw, 'rateLimit') || raw.rateLimit === undefined || raw.rateLimit === null) {
    problems.push(problem(
      'rate-limit-undeclared',
      at,
      `Connector "${sanitize(id, ID_LIMIT)}" declares no rate limit, so the rate limit this matrix compares is unknown for it rather than absent.`,
      { suggestion: 'Declare "rateLimit" with "requests" and "windowSeconds", both integers.' },
    ))
    return null
  }
  const value = raw.rateLimit
  if (!isRecord(value)) {
    problems.push(problem(
      'rate-limit-malformed',
      at,
      `Connector "${sanitize(id, ID_LIMIT)}" declares "rateLimit" as ${describe(value)}, not an object, so its rate limit could not be read.`,
      { suggestion: 'Declare "rateLimit" as { "requests": 100, "windowSeconds": 60 }.' },
    ))
    return null
  }
  checkKeys(value, RATE_LIMIT_KEYS, at, `The rate limit of connector "${sanitize(id, ID_LIMIT)}"`, problems)

  const positive = (key, optional) => {
    if (!Object.hasOwn(value, key) || value[key] === undefined) {
      if (optional) return { ok: true, value: null }
      problems.push(problem(
        'rate-limit-malformed',
        at,
        `The rate limit of connector "${sanitize(id, ID_LIMIT)}" declares no "${key}", so it states no bound this matrix can compare.`,
        { suggestion: 'Declare "requests" and "windowSeconds" as integers of at least 1.' },
      ))
      return { ok: false }
    }
    if (!Number.isInteger(value[key]) || value[key] < 1) {
      problems.push(problem(
        'rate-limit-malformed',
        at,
        `The rate limit of connector "${sanitize(id, ID_LIMIT)}" declares "${key}" as ${describe(value[key])}, not an integer of at least 1, so its rate limit could not be read.`,
        { evidence: String(value[key]) },
      ))
      return { ok: false }
    }
    return { ok: true, value: value[key] }
  }

  const requests = positive('requests', false)
  const windowSeconds = positive('windowSeconds', false)
  const concurrency = positive('concurrency', true)
  if (!requests.ok || !windowSeconds.ok || !concurrency.ok) return null

  let retryAfterHonoured = null
  if (Object.hasOwn(value, 'retryAfterHonoured') && value.retryAfterHonoured !== undefined) {
    if (typeof value.retryAfterHonoured !== 'boolean') {
      problems.push(problem(
        'rate-limit-malformed',
        at,
        `The rate limit of connector "${sanitize(id, ID_LIMIT)}" declares "retryAfterHonoured" as ${describe(value.retryAfterHonoured)}, not a boolean, so whether it honours Retry-After could not be read.`,
      ))
      return null
    }
    retryAfterHonoured = value.retryAfterHonoured
  }

  return { requests: requests.value, windowSeconds: windowSeconds.value, concurrency: concurrency.value, retryAfterHonoured }
}

/**
 * Read one claim.
 *
 * A claim is either the word `supported`, the word `unsupported`, or an object
 * carrying one of those words and an optional note. Anything else is refused
 * and named: a claim of "partial" is a statement this tool cannot place in a
 * three-state matrix, and placing it anywhere would be a guess about whether
 * the capability works.
 */
function readClaim(key, value, connectorId, pointer, known, state, claims, unreadable, problems) {
  const at = `${pointer}/capabilities`
  if (typeof key !== 'string' || key.length > ID_LIMIT || !ID_PATTERN.test(key)) {
    problems.push(problem(
      'claim-unknown-capability',
      at,
      `Connector "${sanitize(connectorId, ID_LIMIT)}" claims a capability whose key is not an identifier of at most ${ID_LIMIT} characters, so the claim names no column of the matrix.`,
      { evidence: key, suggestion: 'Key each claim by a declared capability id.' },
    ))
    return
  }
  if (!known.has(key)) {
    // A capability the catalog declared and this tool refused was already
    // reported once; saying the claim names nothing would describe the same
    // defect twice.
    if (state.refusedCapabilities.has(key)) return
    problems.push(problem(
      'claim-unknown-capability',
      `${at}/${key}`,
      `Connector "${sanitize(connectorId, ID_LIMIT)}" claims capability "${sanitize(key, ID_LIMIT)}", which the catalog does not declare, so the matrix has no column for it.`,
      { suggestion: 'Declare the capability under "capabilities", or correct the claim.' },
    ))
    return
  }

  const claimPointer = `${at}/${key}`
  let claimState = null
  let note = null
  if (typeof value === 'string') {
    claimState = value
  } else if (isRecord(value)) {
    checkKeys(value, CLAIM_KEYS, claimPointer, `The claim of connector "${sanitize(connectorId, ID_LIMIT)}"`, problems)
    note = readOptionalString(
      value, 'note', NOTE_LIMIT, claimPointer,
      { ruleId: 'claim-malformed', subject: `The claim of connector "${sanitize(connectorId, ID_LIMIT)}"` }, problems,
    )
    if (typeof value.state !== 'string') {
      problems.push(problem(
        'claim-malformed',
        claimPointer,
        `Connector "${sanitize(connectorId, ID_LIMIT)}" claims capability "${sanitize(key, ID_LIMIT)}" with a "state" of ${describe(value.state)}, not a string, so what it claims could not be read.`,
        { suggestion: `Declare "state" as one of: ${CLAIM_STATES.join(', ')}.` },
      ))
      unreadable.add(key)
      return
    }
    claimState = value.state
  } else {
    problems.push(problem(
      'claim-malformed',
      claimPointer,
      `Connector "${sanitize(connectorId, ID_LIMIT)}" claims capability "${sanitize(key, ID_LIMIT)}" as ${describe(value)}, which is neither a state word nor an object carrying one, so what it claims could not be read.`,
      { suggestion: `Declare the claim as one of: ${CLAIM_STATES.join(', ')}.` },
    ))
    unreadable.add(key)
    return
  }

  if (!CLAIM_STATES.includes(claimState)) {
    problems.push(problem(
      'claim-state-unknown',
      claimPointer,
      `Connector "${sanitize(connectorId, ID_LIMIT)}" claims capability "${sanitize(key, ID_LIMIT)}" as "${sanitize(claimState, 60)}", which is not one of ${CLAIM_STATES.join(' or ')}; this tool will not map an unknown word onto either, so the cell is unverified.`,
      { suggestion: `Declare the claim as one of: ${CLAIM_STATES.join(', ')}. There is no third claim; a capability that is only partly there is a capability of its own.` },
    ))
    unreadable.add(key)
    return
  }

  claims.set(key, { state: claimState, note, pointer: claimPointer })
}

function normalizeObservation(raw, index, known, connectors, state, problems) {
  const at = `/observations/${index}`
  const refuse = (message, extra = {}) => {
    problems.push(problem('observation-malformed', at, message, extra))
    return null
  }
  if (!isRecord(raw)) {
    return refuse(
      `Observation ${index} is ${describe(raw)}, not an object, so it was not counted as evidence for anything.`,
      { suggestion: 'Declare each observation with "connector", "capability", "kind", "result" and "reference".' },
    )
  }
  checkKeys(raw, OBSERVATION_KEYS, at, `Observation ${index}`, problems)

  const connector = raw.connector
  const capability = raw.capability
  for (const [key, value] of [['connector', connector], ['capability', capability]]) {
    if (typeof value !== 'string' || value.length > ID_LIMIT || !ID_PATTERN.test(value)) {
      return refuse(
        `Observation ${index} names a "${key}" that is not an identifier of at most ${ID_LIMIT} characters, so the cell it is evidence for could not be identified.`,
        { evidence: typeof value === 'string' ? value : describe(value) },
      )
    }
  }

  const reference = raw.reference
  if (typeof reference !== 'string' || reference.trim() === '' || reference.length > REFERENCE_LIMIT) {
    return refuse(
      `Observation ${index} declares a "reference" that is not a non-empty string of at most ${REFERENCE_LIMIT} characters, so the evidence it claims cannot be looked up.`,
      { suggestion: 'Reference the test, recording or transcript that was observed.' },
    )
  }

  if (!connectors.has(connector)) {
    if (state.refusedConnectors.has(connector)) return null
    problems.push(problem(
      'observation-unknown-connector',
      at,
      `Observation ${index} is evidence about connector "${sanitize(connector, ID_LIMIT)}", which the specification does not declare, so it verifies nothing in this matrix.`,
      { suggestion: 'Declare the connector, or correct the observation.' },
    ))
    return null
  }
  if (!known.has(capability)) {
    if (state.refusedCapabilities.has(capability)) return null
    problems.push(problem(
      'observation-unknown-capability',
      at,
      `Observation ${index} is evidence about capability "${sanitize(capability, ID_LIMIT)}", which the catalog does not declare, so it verifies nothing in this matrix.`,
      { suggestion: 'Declare the capability, or correct the observation.' },
    ))
    return null
  }

  if (typeof raw.kind !== 'string' || !OBSERVATION_KINDS.includes(raw.kind)) {
    problems.push(problem(
      'observation-kind-unknown',
      at,
      `Observation ${index} declares kind ${typeof raw.kind === 'string' ? `"${sanitize(raw.kind, 60)}"` : describe(raw.kind)}, which is not one of ${OBSERVATION_KINDS.join(', ')}; evidence of an unknown kind was not counted.`,
      { suggestion: `Use one of: ${OBSERVATION_KINDS.join(', ')}.` },
    ))
    return null
  }
  if (typeof raw.result !== 'string' || !OBSERVATION_RESULTS.includes(raw.result)) {
    problems.push(problem(
      'observation-result-unknown',
      at,
      `Observation ${index} declares result ${typeof raw.result === 'string' ? `"${sanitize(raw.result, 60)}"` : describe(raw.result)}, which is not one of ${OBSERVATION_RESULTS.join(', ')}; an observation whose outcome cannot be read verifies nothing.`,
      { suggestion: `Use one of: ${OBSERVATION_RESULTS.join(', ')}.` },
    ))
    return null
  }

  return { connector, capability, kind: raw.kind, result: raw.result, reference, pointer: at, index }
}
