# Capability rules, states and limits

This is the rule catalog for `connector-capability-matrix`, the meaning of the
three cell states, and every bound the tool enforces. Rule ids are part of the
public interface: renaming one is a breaking change and is recorded in the
changelog.

## The three states

A cell is never a boolean and never a blank.

| State | Marker | What it means | What puts a cell here |
| --- | --- | --- | --- |
| supported | `[+]` | An observation recorded the capability working. | At least one observation with `result: "supported"`, and none that disagrees. |
| unsupported | `[-]` | It does not work. | The connector claims `unsupported`, or an observation recorded it not working. |
| unverified | `[?]` | Nobody knows. | A claim with no evidence, evidence that settled nothing, a claim this tool could not read, two observations that disagree, or silence. |

Three consequences follow, and they are the whole point of the tool:

1. **A claim never reaches `supported` on its own.** However confidently a
   specification asserts a capability, with no observation behind it the cell is
   `unverified` and the run is `incomplete`.
2. **`unsupported` is an answer and stays visible.** Every connector has a cell
   for every capability in the catalog. A capability that does not work says so,
   because a blank cell reads as "no information" when the fact is the opposite.
3. **`unverified` is not a weaker `unsupported`.** They render differently, they
   count separately in the summary, and only one of them is a fact.

Where a claim and an observation disagree, the matrix shows what was observed
and the disagreement is an error. Where two observations disagree with each
other, nothing is known, so the cell falls back to `unverified`.

A connector that declares a limitation against its own interest is taken at its
word: an `unsupported` claim needs no evidence. Only claims of support do.

## What counts as evidence

An observation is a record that somebody looked. It names the connector, the
capability, what was found, and where to look it up.

| Field | Values |
| --- | --- |
| `kind` | `contract-test`, `manual-check`, `recorded-response`, `sandbox-run` |
| `result` | `supported`, `unsupported`, `inconclusive` |
| `reference` | A non-empty string of at most 200 characters naming the test, recording or transcript |

This tool does not run any of them. It never opens a socket, calls a connector
or fetches a URL; the evidence is a claim about the world made in the document,
and what this tool decides is what that evidence is worth. A reference it cannot
follow is still a reference somebody can follow.

## The document

The dialect is declared by `schemaVersion`, which must be `"1"`. A document in
any other dialect is reported as unsupported and nothing in it is compared --
never read partially and never treated as satisfied.

```json
{
  "schemaVersion": "1",
  "matrix": "integration-platform",
  "capabilities": [
    { "id": "list-records", "group": "operations", "title": "List records", "required": true }
  ],
  "connectors": [
    {
      "id": "acme-crm",
      "title": "Acme CRM",
      "version": "2.4.0",
      "rateLimit": { "requests": 120, "windowSeconds": 60, "concurrency": 4, "retryAfterHonoured": true },
      "capabilities": {
        "list-records": "supported",
        "delete-record": { "state": "unsupported", "note": "The API has no delete." }
      }
    }
  ],
  "observations": [
    {
      "connector": "acme-crm",
      "capability": "list-records",
      "kind": "contract-test",
      "result": "supported",
      "reference": "test/acme/list-records.contract.mjs"
    }
  ]
}
```

- A capability `group` is one of `operations`, `authentication`, `pagination`,
  `rate-limit`. The matrix presents the groups in that order, which is a
  declared reading order rather than a sorted one.
- A claim is the word `supported`, the word `unsupported`, or an object carrying
  one of them and an optional `note`. There is no third word: `partial`, `beta`
  and `planned` are all reported as unreadable rather than mapped onto a state.
- An id -- of a capability or a connector -- matches `[A-Za-z][A-Za-z0-9_.-]*`
  and is at most 100 characters. An id that does not match is reported rather
  than repaired, because renaming a declaration would change which cell it lands
  in.
- Every key is checked. A key this dialect does not define is reported, because
  a one-character typo that falls back to a default is a real failure reported
  as a green run.

## Rules

Severity comes from one frozen table in `src/index.mjs`, and every finding takes
its severity from there. "Incomplete" means the rule marks the whole run
`incomplete`: the question was not answered, so no verdict is issued in either
direction. Thirty-eight of the forty-two rules do that.

The four that do not are the ones that state a fact the run established rather
than a gap in it: `claim-contradicted`, `required-capability-unclaimed`,
`unsupported-capability-observed` (all errors, so the run fails) and
`capability-unsupported-everywhere` (information, so the run still passes).

| Rule | Severity | Incomplete | What it means |
| --- | --- | --- | --- |
| `capability-group-unknown` | error | yes | The capability names a group that is not one of the four the matrix has columns for, so it was left out. |
| `capability-id-duplicated` | error | yes | Two capabilities share an id. The first declaration is used and the repeat is left out. |
| `capability-id-invalid` | error | yes | The capability id is not an identifier, so it was left out rather than repaired. |
| `capability-malformed` | error | yes | A capability, its title or its `required` flag could not be read. |
| `capability-unclaimed` | warning | yes | A connector says nothing about a capability the catalog declares, so the cell cannot tell "does not work" from "nobody wrote it down". |
| `capability-unsupported-everywhere` | info | no | Every connector in the matrix declares this capability unsupported, so nothing here provides it. |
| `claim-contradicted` | error | no | The connector claims a capability works and an observation recorded it not working. The matrix shows what was observed. |
| `claim-malformed` | error | yes | The claim is neither a state word nor an object carrying one, so what it claims could not be read. |
| `claim-state-unknown` | error | yes | The claim uses a word that is not `supported` or `unsupported`. It is not mapped onto either. |
| `claim-unknown-capability` | error | yes | The claim names a capability the catalog does not declare, so the matrix has no column for it. |
| `claim-unverified` | warning | yes | The connector claims a capability is supported and no observation backs the claim. |
| `connector-id-duplicated` | error | yes | Two connectors share an id. The first declaration is used and the repeat is left out. |
| `connector-id-invalid` | error | yes | The connector id is not an identifier, so it was left out rather than repaired. |
| `connector-malformed` | error | yes | A connector, its title or its claims block could not be read. |
| `connector-version-invalid` | error | yes | The connector version is not `major.minor.patch`, so the version column is blank for it. |
| `evidence-inconclusive` | warning | yes | The only evidence for a claimed capability is an observation that settled nothing. |
| `no-capabilities-declared` | warning | yes | The document declares no capabilities, so the matrix compares nothing. |
| `no-connectors-declared` | warning | yes | The document declares no connectors, so the matrix compares nothing. |
| `observation-conflict` | error | yes | Two observations of one cell disagree, so nothing is known about it until one of them is withdrawn. |
| `observation-kind-unknown` | error | yes | The observation declares a kind of evidence this tool does not accept, so it was not counted. |
| `observation-malformed` | error | yes | An observation, or the connector, capability or reference it names, could not be read. |
| `observation-result-unknown` | error | yes | The observation declares an outcome that is not `supported`, `unsupported` or `inconclusive`. |
| `observation-unclaimed` | warning | yes | Evidence exists for a cell the connector claims nothing about; the specification is behind what was observed. |
| `observation-unknown-capability` | error | yes | The observation is evidence about a capability the catalog does not declare. |
| `observation-unknown-connector` | error | yes | The observation is evidence about a connector the document does not declare. |
| `rate-limit-malformed` | error | yes | The rate limit block, or one of its fields, could not be read. |
| `rate-limit-undeclared` | warning | yes | The connector declares no rate limit, so the rate limit this matrix compares is unknown for it. |
| `required-capability-unclaimed` | error | no | A capability the catalog declares required is not claimed by this connector, either way, and was never observed. |
| `schema-version-unsupported` | error | yes | The document is in a dialect this tool does not support. Nothing in it was compared. |
| `spec-malformed` | error | yes | The document, or one of its top-level arrays, is not the shape the dialect requires. |
| `spec-not-json` | error | yes | The document is not valid JSON. |
| `spec-not-utf8` | error | yes | The document is not valid UTF-8, decoded strictly. |
| `spec-too-deep` | error | yes | The document nests deeper than `maxDepth`. |
| `spec-too-large` | error | yes | The document is larger than `maxBytes`. It was not read at all. |
| `spec-unreadable` | error | yes | The document could not be opened. |
| `time-budget-exceeded` | error | yes | The comparison ran out of the `maxMillis` budget before it finished. |
| `too-many-capabilities` | error | yes | The document declares more capabilities than `maxCapabilities`. None were compared. |
| `too-many-claims` | error | yes | One connector declares more claims than `maxClaimsPerConnector`. The connector was left out. |
| `too-many-connectors` | error | yes | The document declares more connectors than `maxConnectors`. None were compared. |
| `too-many-observations` | error | yes | The document declares more observations than `maxObservations`. None were read, so no claim could be verified. |
| `unknown-declaration-key` | error | yes | A declaration carries a key this dialect does not define, so part of its intent could not be read. |
| `unsupported-capability-observed` | error | no | The connector declares a capability unsupported and an observation recorded it working. The specification is out of date. |
## Limits

Every bound is explicit, overridable from the command line and from `--config`,
and named in the finding when it is reached. Exceeding one is an `incomplete`
result -- never a quietly shorter matrix and never a pass. The declaration that
exceeded a bound is refused whole: a document-level limit refuses the document,
and a connector-level limit refuses the connector. Nothing is truncated.

| Limit | Flag | Default | What it bounds |
| --- | --- | --- | --- |
| `maxBytes` | `--max-bytes` | 1048576 | Largest specification that is read at all. |
| `maxCapabilities` | `--max-capabilities` | 200 | Most capabilities one document may declare. |
| `maxConnectors` | `--max-connectors` | 100 | Most connectors one document may declare. |
| `maxClaimsPerConnector` | `--max-claims-per-connector` | 200 | Most claims one connector may declare. |
| `maxObservations` | `--max-observations` | 2000 | Most observations one document may declare. |
| `maxDepth` | `--max-depth` | 12 | Deepest structure the document may nest to. The top-level object is depth 1. |
| `maxMillis` | `--max-millis` | 5000 | Time budget for the comparison. The only limit that may be zero. |
The configuration file is bounded at 65536 bytes and is decoded with the same
strict UTF-8 decoder as the specification. A configuration that cannot be read,
carries an unknown key, or gives a limit a value that is not an integer, is a
configuration error: the run never had a subject, so stdout stays empty and the
exit code is 2.

## Determinism

- Findings are ordered by `(location.pointer, ruleId, message)`, with the order
  of declaration as the final tiebreak.
- Rows are the connectors in code-unit order. Columns are the capabilities in
  the declared group order, then code-unit order within a group. Evidence in a
  cell is ordered by kind, then by reference.
- Ordering is by UTF-16 code unit everywhere. `localeCompare` and
  `Intl.Collator` both depend on ICU data that differs between Node builds, and
  a matrix is an artifact people diff between machines.
- No wall clock is read. The only clock is the one injected for the `maxMillis`
  budget, and nothing derived from it reaches the output.
- Running the tool twice over identical inputs produces byte-identical stdout.

## Output sanitising

Every string that came out of the document is flattened to one line, bounded,
and stripped of the characters that forge or hide output: C0 (U+0000-U+001F),
DEL (U+007F), C1 (U+0080-U+009F), U+2028, U+2029 and the bidi controls (U+200E,
U+200F, U+202A-U+202E, U+2066-U+2069).

That applies to ids, group names, titles, notes, evidence references, unknown
key names and messages -- not only to an excerpt field. A tool that sanitised
its excerpt carefully let a page id carrying a newline forge whole lines in its
report.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every cell is a settled answer and no claim outran its evidence | the report |
| 1 | The specification is contradicted by the evidence, or a required capability is unclaimed | the report |
| 2 | Invalid usage or configuration | **empty** |
| 2 | Evidence missing, unreadable or bounded out (`incomplete`) | the report |
