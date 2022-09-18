import assert from 'node:assert/strict'
import test from 'node:test'

import { EXCERPT_LIMIT, byCodeUnit, decodeUtf8, sanitize } from '../src/text.mjs'

/**
 * The primitives, checked where they are small enough to be checked directly.
 *
 * None of this is the determinism guard or the sanitising guard: pinning
 * `byCodeUnit` here pins the helper and leaves every call site free to be
 * swapped one at a time, and pinning `sanitize` here says nothing about which
 * strings are passed through it. Those guards are behavioural and live in
 * test/ordering.test.mjs and test/sanitising.test.mjs.
 *
 * Every forbidden character is built from its code point rather than written
 * as an escape in a string literal, so nothing in this file depends on the
 * editor, the terminal or the transport that carried it here.
 */

const cp = (...codes) => String.fromCharCode(...codes)

test('byCodeUnit orders by code unit, which is not how a collator orders', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
  assert.equal(byCodeUnit('b', 'a') > 0, true)
})

test('a collator really does disagree, which is why the call sites are pinned', () => {
  // If this ever stops being true the ordering guard has lost its teeth, and a
  // silent agreement between the two orders is worth finding out about.
  assert.deepEqual(['Z', 'a'].sort(new Intl.Collator('en').compare), ['a', 'Z'])
  assert.deepEqual(['README', 'assets'].sort(new Intl.Collator('en').compare), ['assets', 'README'])
})

test('decodeUtf8 refuses bytes that are not UTF-8 instead of replacing them', () => {
  assert.deepEqual(decodeUtf8(new Uint8Array([0xc3, 0x28])), { ok: false, reason: 'not-utf8' })
  assert.deepEqual(decodeUtf8(new Uint8Array([0xff])), { ok: false, reason: 'not-utf8' })
  assert.deepEqual(decodeUtf8(new TextEncoder().encode('{"a":1}')), { ok: true, text: '{"a":1}' })
})

test('a document that legitimately contains U+FFFD still decodes', () => {
  // The defect this guards against: inferring "not UTF-8" from a replacement
  // character in the decoded text, which cannot tell a mangled byte from a
  // document that meant to say U+FFFD.
  const decoded = decodeUtf8(new TextEncoder().encode(`lost: ${cp(0xfffd)}`))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, `lost: ${cp(0xfffd)}`)
})

test('sanitize removes every class that forges or hides a line', () => {
  const classes = [
    ['C0', cp(0x00, 0x01, 0x1f)],
    ['DEL', cp(0x7f)],
    ['C1 NEL', cp(0x85)],
    ['C1 CSI', cp(0x9b)],
    ['C1 range ends', cp(0x80, 0x9f)],
    ['line separator', cp(0x2028)],
    ['paragraph separator', cp(0x2029)],
    ['bidi marks', cp(0x200e, 0x200f)],
    ['bidi embedding', cp(0x202a, 0x202b, 0x202c, 0x202d, 0x202e)],
    ['bidi isolates', cp(0x2066, 0x2067, 0x2068, 0x2069)],
  ]
  for (const [name, payload] of classes) {
    assert.equal(sanitize(`before${payload}after`), 'before after', `${name} survived sanitising`)
  }
})

test('sanitize flattens ordinary whitespace rather than deleting it', () => {
  assert.equal(sanitize(`two${cp(10)}lines`), 'two lines')
  assert.equal(sanitize(`a${cp(9)}b`), 'a b')
  assert.equal(sanitize(`a${cp(13)}b`), 'a b')
  assert.equal(sanitize('  padded  '), 'padded')
})

test('sanitize bounds what one untrusted string contributes', () => {
  const long = 'x'.repeat(EXCERPT_LIMIT + 50)
  assert.equal(sanitize(long).length, EXCERPT_LIMIT + 3)
  assert.equal(sanitize(long).endsWith('...'), true)
  assert.equal(sanitize('abcdef', 3), 'abc...')
  assert.throws(() => sanitize('abc', 0), TypeError)
  assert.throws(() => sanitize('abc', 1.5), TypeError)
})
