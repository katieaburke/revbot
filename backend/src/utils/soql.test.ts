import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { soqlEscape, soqlLiteral, soqlInList } from './soql'

describe('soqlEscape', () => {
  test('leaves ordinary values alone', () => {
    assert.equal(soqlEscape('katie.burke@uberall.com'), 'katie.burke@uberall.com')
  })

  test('escapes single quotes', () => {
    // The real case: apostrophes in account names. "Lowe's" used to break the whole
    // query, not just its own row.
    assert.equal(soqlEscape("Lowe's"), "Lowe\\'s")
  })

  test('escapes backslashes before quotes, not after', () => {
    // This is the bug the inline `.replace(/'/g, "\\'")` version had. A trailing
    // backslash escapes the closing quote of the literal and Salesforce rejects the
    // entire statement with MALFORMED_QUERY.
    assert.equal(soqlEscape('C:\\'), 'C:\\\\')
    // And the escaping must not double-process what it just inserted.
    assert.equal(soqlEscape("a\\'b"), "a\\\\\\'b")
  })

  test('handles a value that is only quotes', () => {
    assert.equal(soqlEscape("'''"), "\\'\\'\\'")
  })
})

describe('soqlLiteral', () => {
  test('wraps in quotes', () => {
    assert.equal(soqlLiteral('abc'), "'abc'")
  })

  test('a quote in the value cannot terminate the literal early', () => {
    // If this ever regresses, the result would contain an unescaped `'` and the
    // remainder of the value would be parsed as SOQL.
    const injected = soqlLiteral("x' OR Name != '")
    assert.equal(injected, "'x\\' OR Name != \\''")
    // Exactly two unescaped quotes: the opening and closing delimiters.
    const unescaped = [...injected.matchAll(/(?<!\\)'/g)]
    assert.equal(unescaped.length, 2)
  })
})

describe('soqlInList', () => {
  test('builds a comma-separated quoted list', () => {
    assert.equal(soqlInList(['a', 'b']), "'a', 'b'")
  })

  test('returns empty string for no values', () => {
    assert.equal(soqlInList([]), '')
  })

  test('escapes each element', () => {
    assert.equal(soqlInList(["O'Brien"]), "'O\\'Brien'")
  })
})
