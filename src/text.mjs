/**
 * Decoding, ordering and sanitising primitives.
 *
 * Nothing here reads the filesystem, the clock, the locale, the environment or
 * the network. Every function is a pure function of its arguments, which is
 * what lets the same specification produce byte-identical output on any host.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both depend on ICU data that differs
 * between Node builds and platforms, and collation has already produced a real
 * ordering difference in this catalog. A capability matrix is an artifact
 * people diff between machines, so no part of its order may depend on a
 * collation table.
 *
 * Pinning this helper in isolation -- `byCodeUnit('Z', 'a') < 0` -- pins the
 * helper and nothing else: every call site can still be swapped to a collator
 * one at a time. `test/ordering.test.mjs` drives an input whose collated order
 * differs from its code-unit order through the real entry point for each site.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then hunting for U+FFFD
 * in the result cannot tell undecodable bytes apart from a document that
 * legitimately contains a replacement character, and that confusion has let an
 * unreadable input report a pass. The decoder decides; the decoded text never
 * gets a vote.
 *
 * Every byte stream this tool reads comes through here -- the specification and
 * the optional configuration file both. A tool in this catalog hardened its
 * data path and left its configuration path lossy, which meant a mangled
 * configuration byte silently became a different limit.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed before any document-derived string reaches output.
 *
 * Built from code points rather than written literally: a literal U+2028 in a
 * module is a syntax hazard, and the whole point of the class is that these
 * characters never reach a line a person reads. Each class forges or hides
 * something:
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   row of the matrix; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which begins a new line on a
 *   terminal exactly as a newline does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a class that stops at C0 lets both through.
 * - **U+2028 and U+2029**: they terminate a line for a JavaScript consumer.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses the text displayed after it, so a connector called one thing is
 *   read as another, and the isolates hide what they wrap.
 *
 * Tab, newline and carriage return are deliberately outside the class: they are
 * ECMAScript whitespace, so the whitespace collapse below flattens them to a
 * single space rather than deleting them.
 *
 * This applies to identifiers, keys, references, notes and titles, not only to
 * an excerpt field. A capability id, an unknown declaration key and an evidence
 * reference all arrive from the same untrusted document as an excerpt does, and
 * a tool that sanitised only its excerpt let a page id carrying a newline forge
 * whole lines in its report.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/** Bounds on what any one untrusted string may contribute to output. */
export const EXCERPT_LIMIT = 200
export const MESSAGE_LIMIT = 400
export const LABEL_LIMIT = 120

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every string that came out of the document passes through here on its way to
 * the report, the matrix artifact or the human grid: connector ids, capability
 * ids, group names, titles, notes, evidence references and unknown key names.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Sanitise limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * What a JSON parse failure may be told about itself, with the input removed.
 *
 * V8 reports a parse failure two ways, and one of them quotes the document
 * back: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A
 * specification or a configuration short enough to be nothing but a credential
 * is therefore reproduced in full by its own error message, on exactly the path
 * a malformed or untrusted document takes. `sanitize` cannot help: it strips
 * control characters and cuts from the end, and the quoted span sits at the
 * front.
 *
 * Position, line and column are the useful half and carry no document text, so
 * they are kept verbatim; so is the offending token, one character wide and
 * bounded here to stay that way. V8 has a third spelling for a failure further
 * into the document, `..."connectors": AKIAIOSFOD"...`, which quotes a window
 * rather than a prefix and carries no position at all; that one keeps only the
 * token. The quoted half never leaves this function.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? 'could not be parsed')
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  const token = /^Unexpected token (.{1,8}?), (\.\.\.)?".*?"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) return token[2] === undefined ? `unexpected token ${token[1]} at the start of the document` : `unexpected token ${token[1]}`
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'the document could not be parsed as JSON'
}
