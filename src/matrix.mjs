/**
 * The matrix itself: one cell for every connector and every capability, and
 * the rule that decides what each cell says.
 *
 * The whole point of this tool is the difference between what a specification
 * *claims* and what somebody *observed*, so a cell is never a boolean:
 *
 * - **supported** -- an observation recorded that it works. Only evidence puts
 *   a cell here; a claim on its own never does.
 * - **unsupported** -- the connector says it does not work, or an observation
 *   recorded that it does not. This state stays in the matrix as an explicit
 *   cell. Omitting it would read as "no information" where it means "does not
 *   work", and those are opposite facts.
 * - **unverified** -- claimed and not observed, observed inconclusively, or not
 *   mentioned at all. It is neither of the other two, it renders as neither of
 *   the other two, and the run that produced it is `incomplete`.
 *
 * Where a claim and an observation disagree, the matrix shows what was
 * observed and the disagreement is reported as an error: a specification that
 * says a capability works when a test recorded that it does not is a defect in
 * the specification, not a matter of opinion. Where two observations disagree
 * with each other, nothing is known, so the cell falls back to `unverified`.
 */

import { EXCERPT_LIMIT, LABEL_LIMIT, byCodeUnit, sanitize } from './text.mjs'

/** The three states a cell may hold. There is no fourth, and no blank. */
export const CELL_STATES = Object.freeze(['supported', 'unsupported', 'unverified'])

/**
 * How each state renders in the human grid.
 *
 * Three distinct, non-empty markers. A blank cell is what this tool exists to
 * avoid: a reader takes an empty cell for missing information, and two of these
 * three states are definite answers.
 */
export const CELL_MARKERS = Object.freeze({
  supported: '[+]',
  unsupported: '[-]',
  unverified: '[?]',
})

const label = (value) => sanitize(value, LABEL_LIMIT)

/**
 * Order the columns.
 *
 * The group is a declared position, not a compared string: `groupIndex` is the
 * index of the group in `CAPABILITY_GROUPS`, so the reading order of the
 * comparison -- operations, then authentication, then pagination, then rate
 * limits -- is an editorial decision no collation table can reach. Within a
 * group the capability id is compared by code unit.
 */
function compareCapabilities(left, right) {
  return (left.groupIndex - right.groupIndex) || byCodeUnit(left.id, right.id)
}

/** Order the rows by connector id, by code unit. */
function compareConnectors(left, right) {
  return byCodeUnit(left.id, right.id)
}

/** Order the evidence listed in a cell by kind, then by reference. */
function compareEvidence(left, right) {
  return byCodeUnit(left.kind, right.kind) || byCodeUnit(left.reference, right.reference)
}

function indexObservations(observations) {
  const byConnector = new Map()
  for (const observation of observations) {
    if (!byConnector.has(observation.connector)) byConnector.set(observation.connector, new Map())
    const byCapability = byConnector.get(observation.connector)
    if (!byCapability.has(observation.capability)) byCapability.set(observation.capability, [])
    byCapability.get(observation.capability).push(observation)
  }
  return byConnector
}

/**
 * Build the matrix, recording a finding for every cell that is not a settled
 * answer.
 *
 * `record` is the caller's one construction site for findings, which is what
 * keeps severity in a single frozen table rather than spread across this file
 * as literals.
 */
export function buildMatrix(spec, record) {
  const capabilities = [...spec.capabilities].sort(compareCapabilities)
  const connectors = [...spec.connectors].sort(compareConnectors)
  const observations = indexObservations(spec.observations)

  const totals = { supported: 0, unsupported: 0, unverified: 0 }
  const columns = capabilities.map((capability) => ({
    id: label(capability.id),
    group: capability.group,
    title: capability.title === null ? null : label(capability.title),
    required: capability.required,
    supported: 0,
    unsupported: 0,
    unverified: 0,
    supportedBy: [],
  }))

  const rows = connectors.map((connector) => {
    const perConnector = { supported: 0, unsupported: 0, unverified: 0 }
    const cells = capabilities.map((capability, column) => {
      const found = observations.get(connector.id)?.get(capability.id) ?? []
      const cell = resolveCell(connector, capability, found, record)
      totals[cell.state] += 1
      perConnector[cell.state] += 1
      columns[column][cell.state] += 1
      if (cell.state === 'supported') columns[column].supportedBy.push(label(connector.id))
      return cell
    })
    return {
      id: label(connector.id),
      title: connector.title === null ? null : label(connector.title),
      version: connector.version,
      rateLimit: connector.rateLimit === null ? null : { ...connector.rateLimit },
      supported: perConnector.supported,
      unsupported: perConnector.unsupported,
      unverified: perConnector.unverified,
      cells,
    }
  })

  /**
   * A capability every connector declares unsupported.
   *
   * This is information, not a defect: it is the most actionable thing a
   * comparison says -- nothing in the catalog does this, so a workflow that
   * needs it needs a new connector. It is reported only when every cell in the
   * column is an explicit `unsupported`; if any cell is `unverified` the column
   * is not evidence of anything, and the run is incomplete for that reason
   * instead.
   */
  for (const column of columns) {
    if (rows.length === 0 || column.unsupported !== rows.length) continue
    record({
      ruleId: 'capability-unsupported-everywhere',
      pointer: `/capabilities/${column.id}`,
      message: `Every one of the ${rows.length} connector(s) in this matrix declares capability "${column.id}" unsupported, so nothing here provides it.`,
      suggestion: 'Nothing to fix in the specification; a workflow that needs this capability needs a connector that has it.',
    })
  }

  return {
    capabilities: columns,
    connectors: rows,
    counts: {
      capabilities: columns.length,
      connectors: rows.length,
      cells: columns.length * rows.length,
      supported: totals.supported,
      unsupported: totals.unsupported,
      unverified: totals.unverified,
      observations: spec.observations.length,
    },
  }
}

/**
 * Decide one cell.
 *
 * The order of the branches is the policy. Evidence outranks a claim, a
 * disagreement between two observations outranks both, and a claim with no
 * evidence behind it never reaches `supported` however confidently it is
 * written.
 */
function resolveCell(connector, capability, found, record) {
  const claim = connector.claims.get(capability.id) ?? null
  const supported = found.filter((observation) => observation.result === 'supported')
  const unsupported = found.filter((observation) => observation.result === 'unsupported')
  const inconclusive = found.filter((observation) => observation.result === 'inconclusive')
  const pointer = `${connector.pointer}/capabilities/${capability.id}`
  const who = `Connector "${label(connector.id)}"`
  const what = `capability "${label(capability.id)}"`

  const cell = {
    capability: label(capability.id),
    group: capability.group,
    state: 'unverified',
    claim: claim === null ? null : claim.state,
    note: claim === null || claim.note === null ? null : label(claim.note),
    observations: found.length,
    evidence: found
      .map((observation) => ({ kind: observation.kind, result: observation.result, reference: sanitize(observation.reference, EXCERPT_LIMIT) }))
      .sort(compareEvidence),
  }

  // Two observations that disagree are not half an answer. Nothing is known
  // about this cell until somebody works out which run was wrong.
  if (supported.length > 0 && unsupported.length > 0) {
    record({
      ruleId: 'observation-conflict',
      pointer,
      message: `${who} has evidence both ways for ${what}: ${supported.length} observation(s) recorded it working and ${unsupported.length} recorded it not working, so the cell is unverified.`,
      evidence: `${supported[0].reference} vs ${unsupported[0].reference}`,
      suggestion: 'Re-run both observations and withdraw the one that is wrong.',
    })
    cell.state = 'unverified'
    return cell
  }

  if (claim === null) {
    return resolveUnclaimed(cell, { connector, capability, found, supported, unsupported, pointer, who, what }, record)
  }

  if (claim.state === 'supported') {
    if (supported.length > 0) {
      cell.state = 'supported'
      return cell
    }
    if (unsupported.length > 0) {
      record({
        ruleId: 'claim-contradicted',
        pointer,
        message: `${who} claims ${what} is supported, but ${unsupported.length} observation(s) recorded it not working; the matrix shows what was observed.`,
        evidence: unsupported[0].reference,
        suggestion: 'Correct the claim to "unsupported", or fix the connector and record a new observation.',
      })
      cell.state = 'unsupported'
      return cell
    }
    if (inconclusive.length > 0) {
      record({
        ruleId: 'evidence-inconclusive',
        pointer,
        message: `${who} claims ${what} is supported and the only evidence for it is ${inconclusive.length} inconclusive observation(s), so the claim stays unverified.`,
        evidence: inconclusive[0].reference,
        suggestion: 'Record an observation that settles it either way.',
      })
      cell.state = 'unverified'
      return cell
    }
    record({
      ruleId: 'claim-unverified',
      pointer,
      message: `${who} claims ${what} is supported, and no observation backs the claim; the cell is unverified, which is neither supported nor unsupported.`,
      suggestion: 'Record an observation of the capability working, or withdraw the claim.',
    })
    cell.state = 'unverified'
    return cell
  }

  // claim.state === 'unsupported'
  if (supported.length > 0) {
    record({
      ruleId: 'unsupported-capability-observed',
      pointer,
      message: `${who} declares ${what} unsupported, but ${supported.length} observation(s) recorded it working; the matrix shows what was observed and the specification is out of date.`,
      evidence: supported[0].reference,
      suggestion: 'Claim the capability as supported, or withdraw the observation.',
    })
    cell.state = 'supported'
    return cell
  }
  // A connector that declares a limitation against its own interest is taken at
  // its word: "this does not work" needs no evidence, and the cell stays in the
  // matrix as an explicit answer rather than a blank.
  cell.state = 'unsupported'
  return cell
}

function resolveUnclaimed(cell, context, record) {
  const { connector, capability, found, supported, unsupported, pointer, who, what } = context

  if (found.length > 0) {
    // The specification says nothing, but somebody observed the cell. The
    // evidence decides the state; the silence is what gets reported.
    record({
      ruleId: 'observation-unclaimed',
      pointer,
      message: `${who} claims nothing about ${what}, and ${found.length} observation(s) exist for it; the specification is behind what has been observed.`,
      evidence: found[0].reference,
      suggestion: 'Record the claim the observations support, so the specification and the evidence agree.',
    })
    cell.state = supported.length > 0 ? 'supported' : unsupported.length > 0 ? 'unsupported' : 'unverified'
    return cell
  }

  // A connector whose claims could not be read at all was already reported
  // once, for the whole connector. Repeating it per capability would bury that
  // finding under one line per column.
  if (!connector.claimsRead || connector.unreadableClaims.has(capability.id)) {
    cell.state = 'unverified'
    return cell
  }

  if (capability.required) {
    record({
      ruleId: 'required-capability-unclaimed',
      pointer,
      message: `${who} says nothing about ${what}, which the catalog declares required; a required capability nobody claims and nobody observed is a gap, not an omission.`,
      suggestion: 'Claim the capability as supported and record an observation, or claim it as unsupported.',
    })
    cell.state = 'unverified'
    return cell
  }

  record({
    ruleId: 'capability-unclaimed',
    pointer,
    message: `${who} says nothing about ${what}, so the matrix cannot tell "does not work" from "nobody wrote it down"; the cell is unverified.`,
    suggestion: 'Claim the capability either way. An explicit "unsupported" is an answer; silence is not.',
  })
  cell.state = 'unverified'
  return cell
}
