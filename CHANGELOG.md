# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking
change and is recorded here.

## [Unreleased]

### Added

- `analyzeSpecification` and `compareConnectorFile` read a connector
  specification and return both a report and a capability matrix artifact.
- `connector-capability-matrix` command line interface with `--spec`,
  `--matrix`, `--config`, `--json`, `--help` and the seven documented limit
  flags.
- Three cell states, kept distinct everywhere: `supported` (an observation
  recorded the capability working), `unsupported` (declared not to work, or
  observed not working) and `unverified` (claimed, silent or inconclusive --
  never observed working). A claim never reaches `supported` on its own, and a
  run carrying an unverified cell is `incomplete` rather than a pass.
- An explicit cell for every connector and every capability, including the ones
  that do not work: a blank cell reads as "no information" when the fact is the
  opposite.
- Disagreement handling: a claim an observation contradicts, and a capability
  declared unsupported that was observed working, are both errors that fail the
  run; two observations that disagree with each other leave the cell unverified
  and the run incomplete.
- A matrix artifact listing every cell, its claim, its state, the evidence
  behind it and the rate limit and version of each connector. Its destination is
  refused if it is the specification itself, compared by device and inode so
  that a hard link is refused as well as a symbolic link.
- Forty-two rules with severities pinned in one frozen table and behaviourally
  in the test suite, documented in `docs/capability-rules.md`; thirty-eight of
  them make the run incomplete.
- Seven explicit limits -- bytes, capabilities, connectors, claims per
  connector, observations, depth and milliseconds -- each enforced, each wired
  to a flag and to `--config`, and each reported by name. A document-level limit
  refuses the document and a connector-level limit refuses the connector;
  nothing is truncated.
- Strict UTF-8 decoding on both byte paths, the specification and the
  configuration file, and unknown keys refused in both.
- Stable output: no clock reading, no absolute host path, no locale-dependent
  ordering, and byte-identical stdout for the same specification.

### Fixed

- A parse failure no longer quotes the document it failed on. V8 writes
  `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`, and
  `spec-not-json` put that message straight into the report's `evidence` field
  while `--config` put it on stderr, so a specification or a configuration short
  enough to be nothing but a credential was reproduced in full. Sanitising never
  helped: it cuts from the end and the quoted span is at the front.
  `parseFailureDetail` keeps the position, line, column and offending token and
  drops the input, and `test/parse-failure-redaction.test.mjs` drives the AWS
  documentation placeholder through the real command line interface and asserts
  it absent from stdout, from stderr and from every prefix down to eight
  characters.

No release has been published.
