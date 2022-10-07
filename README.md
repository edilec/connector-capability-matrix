# connector-capability-matrix

Validate connector specifications and build the comparison they describe --
operations, authentication, pagination, rate limits -- with one distinction the
comparison usually loses: what a connector **claims** is not what anybody
**observed**.

- **Repository:** [edilec/connector-capability-matrix](https://github.com/edilec/connector-capability-matrix)
- **Area:** API & Integration
- **License:** MIT

Zero dependencies, runtime and development both. Node built-ins only, Node 22 or
newer.

## Why it exists

Every capability matrix is a table of ticks, and a tick means two different
things in the same table: "we tested this" and "the vendor's page says so". The
second is how an integration gets picked, built against, and discovered to be
wrong in production.

So this tool has three states and no ticks:

| State | Marker | What it means |
| --- | --- | --- |
| supported | `[+]` | An observation recorded the capability working |
| unsupported | `[-]` | It does not work -- declared, or observed not working |
| unverified | `[?]` | Claimed, silent or inconclusive; never observed working |

A claim with nothing behind it is `unverified`, not `supported`, and a run that
produced one is `incomplete` rather than a pass. A capability that does not work
keeps an explicit cell: a blank reads as "no information" when the fact is the
opposite.

Nothing is fetched. No connector is called, no socket is opened. The evidence is
in the document; what this tool decides is what that evidence is worth.

## Install

```sh
npm install connector-capability-matrix
```

Or run it without installing:

```sh
npx connector-capability-matrix --spec connectors.json
```

## Use

```sh
connector-capability-matrix --spec examples/integration-platform.json
```

```
matrix "integration-platform": 3 connector(s) x 7 capability/ies, 21 cell(s) checked; 13 supported, 8 unsupported, 0 unverified; 16 observation(s); status pass.
0 error, 0 warning, 1 info.
legend: [+] supported: an observation recorded the capability working; [-] unsupported: declared not to work, or observed not working; [?] unverified: claimed, silent or inconclusive -- never observed working; * marks a required capability
capability                                 | acme-crm                   | bolt-erp                | cirrus-mail
operations/create-record *                 | [+]1                       | [+]1                    | [-]1
operations/delete-record                   | [-]                        | [-]                     | [-]
operations/list-records *                  | [+]2                       | [+]1                    | [+]1
authentication/oauth2-authorization-code * | [+]1                       | [+]1                    | [+]1
pagination/cursor-pagination *             | [+]1                       | [-]1                    | [-]
pagination/offset-pagination               | [-]                        | [+]1                    | [+]1
rate-limit/retry-after-honoured            | [+]1                       | [+]1                    | [-]
version                                    | 2.4.0                      | 1.11.2                  | 0.9.4
rate limit                                 | 120/60s c4 retry-after:yes | 600/60s retry-after:yes | 30/1s c2 retry-after:no
INFO    examples/integration-platform.json/capabilities/delete-record capability-unsupported-everywhere Every one of the 3 connector(s) in this matrix declares capability "delete-record" unsupported, so nothing here provides it.
```

The number after a marker is how much evidence stands behind the cell. The same
document with the gaps a real catalog has:

```sh
connector-capability-matrix --spec examples/broken-matrix.json
```

```
matrix "integration-platform (broken)": 3 connector(s) x 5 capability/ies, 15 cell(s) checked; 4 supported, 3 unsupported, 8 unverified; 8 observation(s); status incomplete.
7 error, 6 warning, 0 info.
capability                                 | acme-crm                | bolt-erp     | cirrus-mail
operations/create-record *                 | [-]1                    | [?]          | [+]1
operations/list-records *                  | [+]1                    | [+]1         | [?]
authentication/oauth2-authorization-code * | [?]                     | [?]          | [+]1
pagination/cursor-pagination               | [?]1                    | [?]2         | [-]
rate-limit/retry-after-honoured            | [-]                     | [?]          | [?]
version                                    | 2.4.0                   | 1.11.2       | 0.9.4
rate limit                                 | 120/60s retry-after:yes | (undeclared) | 30/1s
ERROR   .../connectors/acme-crm/capabilities/create-record claim-contradicted Connector "acme-crm" claims capability "create-record" is supported, but 1 observation(s) recorded it not working; the matrix shows what was observed.
WARNING .../connectors/acme-crm/capabilities/oauth2-authorization-code claim-unverified Connector "acme-crm" claims capability "oauth2-authorization-code" is supported, and no observation backs the claim; the cell is unverified, which is neither supported nor unsupported.
ERROR   .../connectors/bolt-erp/capabilities/cursor-pagination observation-conflict Connector "bolt-erp" has evidence both ways for capability "cursor-pagination": 1 observation(s) recorded it working and 1 recorded it not working, so the cell is unverified.
ERROR   .../connectors/bolt-erp/capabilities/oauth2-authorization-code required-capability-unclaimed Connector "bolt-erp" says nothing about capability "oauth2-authorization-code", which the catalog declares required; a required capability nobody claims and nobody observed is a gap, not an omission.
ERROR   .../connectors/cirrus-mail/capabilities/create-record unsupported-capability-observed Connector "cirrus-mail" declares capability "create-record" unsupported, but 1 observation(s) recorded it working; the matrix shows what was observed and the specification is out of date.
```

(The findings are shown abridged; the real output names the file in full and
lists all thirteen.)

Add `--json` for the machine-readable report, and `--matrix FILE` to write the
matrix artifact -- every cell, its state, its claim and the evidence behind it:

```sh
connector-capability-matrix --spec connectors.json --json --matrix build/capability-matrix.json
```

Every option is accepted once, an unknown option is refused rather than ignored,
and every documented limit has a flag. `--config FILE` supplies the same limits
from a JSON file, and a flag overrides the file. `--help` lists them all.

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | Every cell is a settled answer and no claim outran its evidence | the report |
| 1 | Everything was read, and the evidence contradicts the specification or a required capability is unclaimed | the report |
| 2 | Invalid usage or configuration | **empty** |
| 2 | Evidence missing, unreadable or bounded out (`incomplete`) | the report |

A configuration error produces no report because the run never had a subject. An
input that could not be read produces one, with status `incomplete`, because a
consumer needs to know which input was not read. `incomplete` is never a pass.

**`incomplete` outranks `fail`.** A document that both contradicts itself and
leaves a question unanswered exits 2, not 1, and its status is `incomplete`. The
errors are still reported in full -- the precedence changes what the run is
called, never what it says -- but a run that could not read all of the document
does not get to claim its errors are the whole story. Exit 1 means everything
was read and the specification is wrong.

## As a library

```js
import { analyzeSpecification, compareConnectorFile } from 'connector-capability-matrix'

const { report, matrix } = await compareConnectorFile('connectors.json', { source: 'connectors.json' })

for (const connector of matrix.connectors) {
  const gaps = connector.cells.filter((cell) => cell.state === 'unverified')
  console.log(`${connector.id}: ${connector.supported} observed, ${gaps.length} unverified`)
}
```

`analyzeSpecification({ bytes, source, limits, clock })` is the same comparison
over bytes you already hold. Both return `{ report, matrix }`. A configuration
error -- an unknown option, an unknown limit, a limit that is not an integer --
throws; everything that is a fact about the document is a finding instead.

## What it checks

| Check | Rule |
| --- | --- |
| A claim of support with no observation behind it | `claim-unverified` |
| A claim of support whose only evidence settled nothing | `evidence-inconclusive` |
| A claim of support that an observation contradicts | `claim-contradicted` |
| A capability declared unsupported that was observed working | `unsupported-capability-observed` |
| Two observations of one cell that disagree | `observation-conflict` |
| A required capability the connector says nothing about | `required-capability-unclaimed` |
| A capability the connector says nothing about | `capability-unclaimed` |
| A capability no connector in the matrix provides | `capability-unsupported-everywhere` |
| A connector that declares no rate limit | `rate-limit-undeclared` |
| Evidence for a cell the specification says nothing about | `observation-unclaimed` |
| A claim, observation or declaration that could not be read | 22 rules |
| A document that declares nothing to compare | 2 rules |
| A document in an unsupported dialect | `schema-version-unsupported` |
| A bound that was reached | 7 rules |

| Catalog | Size |
| --- | --- |
| Rules | 42, of which 38 make the run `incomplete` |
| Limits | 7, each with a flag and a default |

The full catalog, with the severity and the incompleteness of every rule, is in
[docs/capability-rules.md](./docs/capability-rules.md).

## Limits and non-goals

**This tool cannot tell you whether a connector works.** It reads a document. An
observation in that document is somebody's record that they looked; this tool
never calls a connector, opens a socket, or checks that a referenced test exists,
compiles or passed. A `supported` cell means *the document records an observation
of it working* -- no more than that.

Everything else follows from the same boundary:

- **It does not weigh evidence.** A `manual-check` counts exactly as much as a
  `contract-test`. If you do not want a note in a file to carry a cell, do not
  record one.
- **It has no notion of time.** There is no clock, by design, so evidence never
  goes stale here: an observation recorded three years ago counts as much as one
  from this morning. Freshness is a judgement this tool does not make.
- **It cannot see a duplicate key.** JSON parsing keeps the last value, so a
  claims block naming one capability twice is read as whatever came last, with
  no finding. Lint the document for that separately.
- **It validates one dialect and only one.** It is not a JSON Schema or OpenAPI
  validator, and it does not read a connector's real specification. A document in
  a dialect it does not know is reported as unsupported and compared not at all --
  never guessed at, never partly read.
- **Ids are strings.** It cannot tell whether `list-records` in one connector
  means what `list-records` means in another. If two connectors disagree about
  what a capability is, the matrix will agree with both of them.
- **`unverified` is not a bug report about the connector.** It is a bug report
  about the evidence: somebody has to go and look.
- **A pass is not a certificate.** It says every cell in *this* document was a
  settled answer. Whether the catalog asks the right questions is a judgement
  nobody can automate.

## Development

```sh
npm run check
```

That runs the lint (`node --check` over every file), the test suite, the example,
and a packaging dry run. There is no build step and nothing to install.

## License

MIT. See [LICENSE](./LICENSE).
