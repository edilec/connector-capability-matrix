#!/usr/bin/env node

import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  compareConnectorFile,
  formatReport,
  readConfigFile,
  resolveMatrixDestination,
  writeMatrixFile,
} from '../src/index.mjs'

const HELP = `connector-capability-matrix

Validate connector specifications and build the comparison they describe:
operations, authentication, pagination, rate limits, and the evidence behind
every claim. Nothing is fetched and no connector is called -- the evidence comes
from the document, and this tool decides what it is worth.

Every cell of the matrix is one of three states, and never a blank:

  [+] supported    an observation recorded the capability working
  [-] unsupported  declared not to work, or observed not working
  [?] unverified   claimed, silent or inconclusive -- never observed working

A claim with no observation behind it is unverified, not supported, and a run
with an unverified cell is incomplete rather than a pass.

Usage:
  connector-capability-matrix --spec FILE [--matrix FILE] [--json] [limits]

Options:
  --spec FILE                  Connector specification to compare (required)
  --matrix FILE                Write the matrix artifact here. A destination
                               that is not the file it names is refused: a
                               symbolic link, a path whose parent leaves the
                               permitted tree, a directory, or any file this
                               run reads -- including one reached by a hard
                               link, which shares no path with its input
  --config FILE                JSON file of limit overrides: { "limits": {...} }
  --json                       Emit the machine-readable report on stdout
  --max-bytes N                Maximum specification size (default 1048576)
  --max-capabilities N         Maximum declared capabilities (default 200)
  --max-connectors N           Maximum declared connectors (default 100)
  --max-claims-per-connector N Maximum claims on one connector (default 200)
  --max-observations N         Maximum declared observations (default 2000)
  --max-depth N                Maximum document nesting depth (default 12)
  --max-millis N               Comparison time budget in milliseconds (default 5000)
  -h, --help                   Show this help

A flag given on the command line overrides the same limit in --config. Every
option is accepted once: a repeated flag is a configuration error, not a silent
last-wins. An unknown option is refused rather than ignored, because a typo that
falls back to a default is a real failure reported as a green run.

A limit that is reached is reported by name and makes the run incomplete. The
declaration that exceeded it is refused whole -- a document-level limit refuses
the document, a connector-level limit refuses the connector. Nothing is
truncated.

Exit codes:
  0  every cell is a settled answer and no claim outran its evidence
  1  the specification is contradicted by the evidence, or a required
     capability is unclaimed
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-capabilities', 'maxCapabilities'],
  ['--max-connectors', 'maxConnectors'],
  ['--max-claims-per-connector', 'maxClaimsPerConnector'],
  ['--max-observations', 'maxObservations'],
  ['--max-depth', 'maxDepth'],
  ['--max-millis', 'maxMillis'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { spec: null, matrix: null, config: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--spec a --spec b` compares a document nobody named and `--max-connectors
   * 10 --max-connectors 10000` enforces a bound nobody asked for.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--spec') {
      once('--spec')
      options.spec = takeValue('--spec')
    } else if (argument === '--matrix') {
      once('--matrix')
      options.matrix = takeValue('--matrix')
    } else if (argument === '--config') {
      once('--config')
      options.config = takeValue('--config')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const floor = argument === '--max-millis' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.spec === null) throw new Error('--spec is required')
  return options
}

/**
 * The label a finding carries.
 *
 * `location.file` is never an absolute host path: a report is an artifact
 * people paste into issues and diff between machines. A specification inside
 * the working directory is named relative to it, and anything else is named by
 * its base name alone.
 */
function sourceLabel(specPath) {
  const absolute = resolve(specPath)
  const fromHere = relative(process.cwd(), absolute)
  if (fromHere === '' || fromHere.startsWith('..') || isAbsolute(fromHere)) return absolute.split(/[\\/]/).pop()
  return fromHere.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before the specification is read, so a bad limit,
  // an unreadable configuration file or a destination pointing at the input
  // fails with no report at all rather than half way through a run.
  let limits = options.limits
  if (options.config !== null) {
    try {
      limits = { ...await readConfigFile(options.config), ...options.limits }
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }

  let destination = null
  if (options.matrix !== null) {
    try {
      destination = await resolveMatrixDestination(options.spec, options.matrix)
    } catch (error) {
      process.stderr.write(`--matrix is not usable: ${error.message}\n`)
      return 2
    }
  }

  let report
  let artifact
  try {
    const result = await compareConnectorFile(options.spec, {
      source: sourceLabel(options.spec),
      limits,
      // The clock the documented time budget is measured with. Wiring it here
      // is the difference between a limit that is enforced and one that is
      // merely written down -- and a constant passed here would still satisfy
      // --max-millis 0, so the case that holds this line is the nonzero budget
      // in test/limits.test.mjs.
      clock: () => performance.now(),
    })
    report = result.report
    artifact = result.matrix
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (destination !== null) {
    try {
      await writeMatrixFile(destination, artifact)
      process.stderr.write(
        `matrix written: ${artifact.counts.connectors} connector(s) x ${artifact.counts.capabilities} capability/ies, complete=${artifact.complete}\n`,
      )
    } catch (error) {
      process.stderr.write(`matrix could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, artifact))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unverified} of ${report.summary.cells} cell(s) are unverified and part of this document was not read; this run is not a verdict.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
