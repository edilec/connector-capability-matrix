/**
 * connector-capability-matrix
 *
 * Reads a connector specification and builds the comparison it describes: what
 * each connector claims about its operations, authentication, pagination and
 * rate limits, and what anybody actually observed.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **A claim is not evidence.** A capability a specification asserts with
 *    nothing behind it is `unverified` -- neither supported nor unsupported --
 *    and the run that produced it is `incomplete`. No amount of confident
 *    prose turns a claim into an observation.
 * 2. **An unsupported capability stays visible.** Every connector has a cell
 *    for every capability, and a capability that does not work says so. A blank
 *    would read as "no information" where the fact is "does not work".
 * 3. **Nothing is fetched.** No connector is called, no socket is opened, no
 *    clock is read except the one the caller injects for its own time budget.
 *    Evidence comes from the document; this tool decides what it is worth.
 * 4. **Everything from the document is untrusted.** Connector ids, capability
 *    ids, titles, notes, evidence references and unknown keys are all sanitised
 *    on the way to output, because every one of them is a string the author of
 *    the document chose.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { CELL_MARKERS, buildMatrix } from './matrix.mjs'
import {
  CAPABILITY_GROUPS,
  SPEC_SCHEMA_VERSION,
  isRecord,
  normalizeSpec,
  readSpecDocument,
  validateLimits,
} from './spec.mjs'
import { EXCERPT_LIMIT, LABEL_LIMIT, MESSAGE_LIMIT, byCodeUnit, decodeUtf8, sanitize } from './text.mjs'

export const TOOL_ID = 'connector-capability-matrix'
export const REPORT_SCHEMA_VERSION = '1'
export const MATRIX_SCHEMA_VERSION = '1'

const DEFAULT_SOURCE = 'connectors.json'
const POINTER_LIMIT = 300

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across construction sites as a literal it drifts silently, so
 * every finding takes its severity from here and an unknown rule id throws.
 *
 * This table is the source of truth; it is not the guard. Asserting it against
 * the documented catalog and against a hand-written map in a test is three
 * declarations agreeing with one another, and one coordinated edit satisfies
 * all three -- a catalog defended that way had forty error rules survive being
 * flipped to warnings. `test/severity-behaviour.test.mjs` drives every rule
 * through the real command line and pins the observable outcome instead.
 *
 * The policy this encodes:
 *
 * - A declaration this tool could not read is an `error`, and additionally
 *   makes the run incomplete. It is not a verdict about the connector; it says
 *   the evidence for one was not obtained.
 * - A claim contradicted by an observation, and a required capability nobody
 *   claims, are `error` and do *not* make the run incomplete: those are facts
 *   the run established, so the run fails rather than abstaining.
 * - A cell that is merely unverified is a `warning` -- but every one of those
 *   rules is also in `INCOMPLETE_RULES`, and for them that membership is the
 *   only thing standing between an unverified matrix and a green build.
 */
export const RULE_SEVERITY = Object.freeze({
  'capability-group-unknown': 'error',
  'capability-id-duplicated': 'error',
  'capability-id-invalid': 'error',
  'capability-malformed': 'error',
  'capability-unclaimed': 'warning',
  'claim-contradicted': 'error',
  'claim-malformed': 'error',
  'claim-state-unknown': 'error',
  'claim-unknown-capability': 'error',
  'claim-unverified': 'warning',
  'connector-id-duplicated': 'error',
  'connector-id-invalid': 'error',
  'connector-malformed': 'error',
  'connector-version-invalid': 'error',
  'evidence-inconclusive': 'warning',
  'no-capabilities-declared': 'warning',
  'no-connectors-declared': 'warning',
  'observation-conflict': 'error',
  'observation-kind-unknown': 'error',
  'observation-malformed': 'error',
  'observation-result-unknown': 'error',
  'observation-unclaimed': 'warning',
  'observation-unknown-capability': 'error',
  'observation-unknown-connector': 'error',
  'rate-limit-malformed': 'error',
  'rate-limit-undeclared': 'warning',
  'required-capability-unclaimed': 'error',
  'schema-version-unsupported': 'error',
  'spec-malformed': 'error',
  'spec-not-json': 'error',
  'spec-not-utf8': 'error',
  'spec-too-deep': 'error',
  'spec-too-large': 'error',
  'spec-unreadable': 'error',
  'time-budget-exceeded': 'error',
  'too-many-capabilities': 'error',
  'too-many-claims': 'error',
  'too-many-connectors': 'error',
  'too-many-observations': 'error',
  'unknown-declaration-key': 'error',
  'unsupported-capability-observed': 'error',
})

/**
 * The rules that mean a question was not answered.
 *
 * Each marks the run `incomplete`, which is what keeps an unread declaration
 * and an unverified claim from producing a verdict. Seven of them are only
 * `warning` severity -- `capability-unclaimed`, `claim-unverified`,
 * `evidence-inconclusive`, `no-capabilities-declared`, `no-connectors-declared`,
 * `observation-unclaimed` and `rate-limit-undeclared` -- so for those this
 * membership is the *only* thing between the run and exit 0. Every id here is
 * driven through the real entry point in `test/incompleteness.test.mjs`;
 * removing one turns exactly one of those tests red.
 *
 * The three rules deliberately absent are the ones that state a fact rather
 * than a gap: `claim-contradicted`, `required-capability-unclaimed` and
 * `unsupported-capability-observed`.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'capability-group-unknown',
  'capability-id-duplicated',
  'capability-id-invalid',
  'capability-malformed',
  'capability-unclaimed',
  'claim-malformed',
  'claim-state-unknown',
  'claim-unknown-capability',
  'claim-unverified',
  'connector-id-duplicated',
  'connector-id-invalid',
  'connector-malformed',
  'connector-version-invalid',
  'evidence-inconclusive',
  'no-capabilities-declared',
  'no-connectors-declared',
  'observation-conflict',
  'observation-kind-unknown',
  'observation-malformed',
  'observation-result-unknown',
  'observation-unclaimed',
  'observation-unknown-capability',
  'observation-unknown-connector',
  'rate-limit-malformed',
  'rate-limit-undeclared',
  'schema-version-unsupported',
  'spec-malformed',
  'spec-not-json',
  'spec-not-utf8',
  'spec-too-deep',
  'spec-too-large',
  'spec-unreadable',
  'time-budget-exceeded',
  'too-many-capabilities',
  'too-many-claims',
  'too-many-connectors',
  'too-many-observations',
  'unknown-declaration-key',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze(['bytes', 'clock', 'limits', 'source'])

/** Every finding is built here, so severity has exactly one source. */
function record(collector, row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) throw new TypeError(`No severity is declared for rule "${row.ruleId}"`)
  collector.rows.push({ ...row, severity, order: collector.rows.length })
  // One site, so "which rules make a run incomplete" is a list a test can
  // enumerate rather than a property scattered through the analysis.
  if (INCOMPLETE.has(row.ruleId)) collector.incomplete = true
}

function createFinding(row, source) {
  const finding = {
    ruleId: row.ruleId,
    severity: row.severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: source, pointer: sanitize(row.pointer, POINTER_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== null) finding.evidence = sanitize(row.evidence, EXCERPT_LIMIT)
  if (row.suggestion !== undefined && row.suggestion !== null) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: `(location.pointer, ruleId, message)`.
 *
 * `location.file` is deliberately not part of it: every finding in a run comes
 * from the one specification document, so sorting by it would compare a string
 * with itself, and a sort key that cannot discriminate is not a sort key.
 * Declaration order is the final tiebreak so that two findings alike in every
 * other respect keep a fixed order.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.pointer, right.pointer)
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
    || (left.order - right.order)
}

/**
 * The time budget, measured with a clock the caller supplies.
 *
 * `performance.now()` is a monotonic counter, not a wall clock, and the elapsed
 * value never reaches the report: the only thing it can change is whether the
 * budget was spent. A test injects its own clock to pin where the budget is
 * checked, and a budget of zero is spent before any work is done, which is how
 * the CLI's wiring is proved rather than assumed.
 */
function createDeadline(clock, maxMillis) {
  const started = clock()
  if (typeof started !== 'number' || !Number.isFinite(started)) {
    throw new TypeError('clock must return a finite number of milliseconds')
  }
  return { exceeded: () => clock() - started >= maxMillis }
}

function defaultClock() {
  return performance.now()
}

const label = (value) => sanitize(value, LABEL_LIMIT)

/**
 * Compare the connectors described by a specification supplied as bytes.
 *
 * Configuration errors -- an unknown option, an unknown limit, a limit that is
 * not an integer -- throw. They mean the run never had a subject, so there is
 * nothing to report about, and the CLI turns them into exit 2 with an empty
 * stdout. Everything that is a fact about the *document* is a finding instead.
 */
export function analyzeSpecification(input = {}) {
  if (!isRecord(input)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(input)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
  const limits = validateLimits(input.limits)
  const source = label(input.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')

  const deadline = createDeadline(clock, limits.maxMillis)
  const collector = { rows: [], incomplete: false }
  const state = { source, matrix: null, declared: { capabilities: 0, connectors: 0, observations: 0 } }

  if (deadline.exceeded()) {
    recordTimeout(collector, '/')
    return finish(collector, state)
  }

  const document = readSpecDocument(input.bytes, limits)
  if (!document.ok) {
    record(collector, {
      ruleId: document.ruleId,
      pointer: '/',
      message: document.message,
      evidence: document.evidence,
      suggestion: document.suggestion,
    })
    return finish(collector, state)
  }

  const spec = normalizeSpec(document.spec, limits)
  for (const problem of spec.problems) record(collector, problem)
  state.matrix = spec.matrix === null ? null : label(spec.matrix)
  state.declared = spec.declared
  if (spec.stopped) return finish(collector, state)

  /**
   * Green on no evidence is a defect, not a clean bill of health. A document
   * that declares no connector, or no capability, was read rather than
   * checked: its matrix has no cells at all. Both findings are warnings, so
   * their membership of INCOMPLETE_RULES is the only thing between an empty
   * document and exit 0.
   */
  if (spec.declared.capabilities === 0) {
    record(collector, {
      ruleId: 'no-capabilities-declared',
      pointer: '/capabilities',
      message: 'The specification declares no capabilities, so this matrix compares nothing and no cell was checked.',
      suggestion: 'Declare the capabilities the connectors are being compared on.',
    })
  }
  if (spec.declared.connectors === 0) {
    record(collector, {
      ruleId: 'no-connectors-declared',
      pointer: '/connectors',
      message: 'The specification declares no connectors, so this matrix compares nothing and no cell was checked.',
      suggestion: 'Declare at least one connector.',
    })
  }

  if (deadline.exceeded()) {
    recordTimeout(collector, '/connectors')
    return finish(collector, state)
  }

  const matrix = buildMatrix(spec, (row) => record(collector, row))
  return finish(collector, state, matrix)
}

function recordTimeout(collector, pointer) {
  record(collector, {
    ruleId: 'time-budget-exceeded',
    pointer,
    message: 'The comparison exceeded the maxMillis budget before it finished, so this matrix is not complete.',
    suggestion: 'Raise --max-millis deliberately, or compare fewer connectors at once.',
  })
}

const EMPTY_COUNTS = Object.freeze({
  capabilities: 0,
  connectors: 0,
  cells: 0,
  supported: 0,
  unsupported: 0,
  unverified: 0,
  observations: 0,
})

/**
 * The legend, carried in the artifact rather than only in the documentation.
 *
 * A consumer reading the JSON has to be able to tell the three states apart
 * without guessing, and in particular has to know that `unverified` is not a
 * weaker `unsupported`.
 */
const LEGEND = Object.freeze({
  supported: `${CELL_MARKERS.supported} supported: an observation recorded the capability working`,
  unsupported: `${CELL_MARKERS.unsupported} unsupported: declared not to work, or observed not working`,
  unverified: `${CELL_MARKERS.unverified} unverified: claimed, silent or inconclusive -- never observed working`,
})

function finish(collector, state, matrix) {
  collector.rows.sort(compareFindingRows)
  const findings = collector.rows.map((row) => createFinding(row, state.source))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const counts = matrix === undefined ? { ...EMPTY_COUNTS } : matrix.counts
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.cells,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      connectors: counts.connectors,
      capabilities: counts.capabilities,
      cells: counts.cells,
      supported: counts.supported,
      unsupported: counts.unsupported,
      unverified: counts.unverified,
      observations: counts.observations,
      declaredConnectors: state.declared.connectors,
      declaredCapabilities: state.declared.capabilities,
    },
    findings,
  }

  const artifact = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    tool: TOOL_ID,
    specSchemaVersion: SPEC_SCHEMA_VERSION,
    matrix: state.matrix,
    source: state.source,
    status,
    complete: status !== 'incomplete',
    legend: { ...LEGEND },
    groups: [...CAPABILITY_GROUPS],
    counts: { ...counts },
    capabilities: matrix === undefined ? [] : matrix.capabilities,
    connectors: matrix === undefined ? [] : matrix.connectors,
  }

  return { report, matrix: artifact }
}

/**
 * Read a specification from a file and compare it.
 *
 * A file that could not be read is an input failure, not a configuration
 * failure: the run had a subject and failed to obtain evidence about it. That
 * is exactly what `incomplete` exists to say, and a consumer needs the report
 * to know which input was not read.
 */
export async function compareConnectorFile(path, options = {}) {
  let bytes
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    const source = label(options.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
    const collector = { rows: [], incomplete: false }
    record(collector, {
      ruleId: 'spec-unreadable',
      pointer: '/',
      message: `The specification could not be read: ${String(error.code ?? error.message)}.`,
      suggestion: 'Check the path and the file permissions.',
    })
    return finish(collector, { source, matrix: null, declared: { capabilities: 0, connectors: 0, observations: 0 } })
  }
  return analyzeSpecification({ ...options, bytes })
}

/** The configuration file is small by contract; anything larger is a mistake. */
export const CONFIG_MAX_BYTES = 65536
const CONFIG_KEYS = Object.freeze(['limits'])

/**
 * Read limit overrides from a configuration file.
 *
 * This is the tool's second byte stream, and it is decoded exactly as strictly
 * as the first. A tool in this catalog hardened its data path and left its
 * configuration path lossy, so a mangled byte in a limit silently became a
 * different limit. Every failure here throws: a configuration that could not be
 * read means the run never had a subject, which is exit 2 with an empty stdout
 * and no report at all.
 */
export async function readConfigFile(path) {
  let bytes
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    throw new TypeError(`the configuration could not be read: ${String(error.code ?? error.message)}`)
  }
  if (bytes.byteLength > CONFIG_MAX_BYTES) {
    throw new TypeError(`the configuration is ${bytes.byteLength} bytes, over the ${CONFIG_MAX_BYTES} byte configuration budget`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('the configuration is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    throw new TypeError(`the configuration is not valid JSON: ${sanitize(error.message, 120)}`)
  }
  if (!isRecord(parsed)) throw new TypeError('the configuration must be a JSON object')
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.includes(key)) throw new TypeError(`unknown configuration key "${sanitize(key, 60)}"`)
  }
  const overrides = parsed.limits === undefined ? {} : parsed.limits
  // Validated here so a bad configuration is refused before any input is read,
  // and validated again by the analysis, which is the only place that decides
  // what a limit means.
  validateLimits(overrides)
  return overrides
}

const ANCESTOR_PROBE_LIMIT = 64

/**
 * Resolve the matrix artifact's destination, and refuse the specification.
 *
 * The matrix is a derived artifact. Writing it over the document it was derived
 * from destroys the input, irreversibly, and no comparison of *paths* prevents
 * that. A symbolic link has a target, so `realpath` collapses it -- but a
 * **hard link has no target**. Two names for one inode resolve to two different
 * real paths, so a `realpath` comparison says they are different files and the
 * write destroys the specification. Hard links are routine in build trees:
 * `cp -l`, package-store linking and de-duplicating backups all make them. So
 * identity is decided the way the filesystem decides it, by device and inode,
 * read with `bigint: true` because an inode number can exceed what a double
 * represents exactly.
 *
 * The resolved-path comparison is kept as well, for a filesystem that reports
 * no inode number at all (`ino` of zero), where the dev/ino test cannot answer.
 *
 * The destination usually does not exist yet, so its nearest existing ancestor
 * is resolved and the remaining segments are appended. Resolving the ancestor
 * rather than refusing an unresolvable path is the other half of the same
 * defect: a destination under a symlinked directory -- which is what the system
 * temporary directory is on macOS -- is legitimate, and refusing it would be a
 * bug of its own. A destination that does not exist cannot be the
 * specification, which does.
 */
export async function resolveMatrixDestination(specPath, destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Matrix destination must be a non-empty path')
  }
  const absolute = resolve(destination)
  const tail = []
  let probe = absolute
  let realBase = null

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      realBase = await realpath(probe)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`Matrix destination could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError('Matrix destination has no existing ancestor directory')
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  if (realBase === null) throw new TypeError('Matrix destination is nested too deeply to resolve')

  const resolved = tail.length === 0 ? realBase : join(realBase, ...tail)
  let specReal
  let specStat
  try {
    specReal = await realpath(specPath)
    specStat = await stat(specPath, { bigint: true })
  } catch (error) {
    throw new TypeError(`The specification could not be resolved: ${error.code ?? 'unknown error'}`)
  }

  let destinationStat = null
  try {
    destinationStat = await stat(resolved, { bigint: true })
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw new TypeError(`Matrix destination could not be resolved: ${error.code ?? 'unknown error'}`)
    }
  }
  const sameFile = destinationStat !== null
    && destinationStat.ino !== 0n
    && destinationStat.ino === specStat.ino
    && destinationStat.dev === specStat.dev
  if (sameFile || resolved === specReal) {
    throw new TypeError(
      'Matrix destination is the specification itself; the matrix is a derived artifact and must be written elsewhere',
    )
  }
  return resolved
}

/** Serialise the matrix artifact. The specification is never written to. */
export async function writeMatrixFile(destination, artifact) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  return destination
}

const SEVERITY_WIDTH = 7
const NAME_COLUMN_LIMIT = 46

function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function rateLimitText(rateLimit) {
  if (rateLimit === null) return '(undeclared)'
  const parts = [`${rateLimit.requests}/${rateLimit.windowSeconds}s`]
  if (rateLimit.concurrency !== null) parts.push(`c${rateLimit.concurrency}`)
  if (rateLimit.retryAfterHonoured !== null) parts.push(`retry-after:${rateLimit.retryAfterHonoured ? 'yes' : 'no'}`)
  return parts.join(' ')
}

function cellText(cell) {
  return cell.observations > 0 ? `${CELL_MARKERS[cell.state]}${cell.observations}` : CELL_MARKERS[cell.state]
}

/**
 * The human grid.
 *
 * Every cell prints a marker, and the three markers differ from one another.
 * Nothing prints as a blank: the reader of a matrix takes an empty cell for
 * missing information, and two of the three states are definite answers. The
 * number after a marker is how many observations exist for that cell, so a
 * supported cell says how much evidence is behind it.
 */
export function formatReport(report, artifact) {
  const { summary } = report
  const name = artifact?.matrix ? `"${artifact.matrix}"` : '(unnamed matrix)'
  const lines = [
    `matrix ${name}: ${summary.connectors} connector(s) x ${summary.capabilities} capability/ies, `
    + `${summary.cells} cell(s) checked; ${summary.supported} supported, ${summary.unsupported} unsupported, `
    + `${summary.unverified} unverified; ${summary.observations} observation(s); status ${report.status}.`,
    `${summary.errors} error, ${summary.warnings} warning, ${summary.info} info.`,
  ]

  if (artifact !== undefined && artifact.connectors.length > 0 && artifact.capabilities.length > 0) {
    lines.push(`legend: ${LEGEND.supported}; ${LEGEND.unsupported}; ${LEGEND.unverified}; * marks a required capability`)
    const rowNames = artifact.capabilities.map(
      (capability) => `${capability.group}/${capability.id}${capability.required ? ' *' : ''}`,
    )
    const nameWidth = Math.min(NAME_COLUMN_LIMIT, Math.max(16, ...rowNames.map((text) => text.length), 'rate limit'.length))
    const widths = artifact.connectors.map((connector) => Math.max(
      connector.id.length,
      ...connector.cells.map((cell) => cellText(cell).length),
      (connector.version ?? '(none)').length,
      rateLimitText(connector.rateLimit).length,
    ))
    // Padded on the left of the separator only; a trailing run of spaces at the
    // end of a line is invisible noise in a diff.
    const cellsOf = (values) => values.map((text, column) => pad(text, widths[column])).join(' | ').trimEnd()
    lines.push(`${pad('capability', nameWidth)} | ${cellsOf(artifact.connectors.map((connector) => connector.id))}`)
    for (const [row, rowName] of rowNames.entries()) {
      lines.push(`${pad(rowName, nameWidth)} | ${cellsOf(artifact.connectors.map((connector) => cellText(connector.cells[row])))}`)
    }
    lines.push(`${pad('version', nameWidth)} | ${cellsOf(artifact.connectors.map((connector) => connector.version ?? '(none)'))}`)
    lines.push(`${pad('rate limit', nameWidth)} | ${cellsOf(artifact.connectors.map((connector) => rateLimitText(connector.rateLimit)))}`)
  }

  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${finding.location.file}${finding.location.pointer} `
      + `${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export { CELL_MARKERS, CELL_STATES, buildMatrix } from './matrix.mjs'
export {
  CAPABILITY_GROUPS,
  CLAIM_STATES,
  DEFAULT_LIMITS,
  OBSERVATION_KINDS,
  OBSERVATION_RESULTS,
  SPEC_SCHEMA_VERSION,
  normalizeSpec,
  readSpecDocument,
  validateLimits,
} from './spec.mjs'
export { byCodeUnit, decodeUtf8, sanitize } from './text.mjs'
