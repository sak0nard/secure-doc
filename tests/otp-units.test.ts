import { expect, test } from 'bun:test'
import { sha256Hex } from '../src/modules/access/crypto'
import { generateCode, hashCode } from '../src/modules/otp/codes'

/** A random source that yields the given values in order and counts calls. */
function source(...values: number[]) {
  const s = { calls: 0, next: () => values[s.calls++]! }
  return s
}

test('codes are six digits and keep leading zeros', () => {
  expect(generateCode(source(42).next)).toBe('000042')
})

test('values that would bias the distribution are rejected', () => {
  const s = source(4_294_967_295, 4_294_000_000, 7)
  expect(generateCode(s.next)).toBe('000007')
  expect(s.calls).toBe(3)
})

test('real codes are always six digits', () => {
  for (let i = 0; i < 1000; i++) expect(generateCode()).toMatch(/^\d{6}$/)
})

test('the code hash depends on the link and the pepper', () => {
  const pepper = 'p'.repeat(32)
  const a = hashCode(pepper, 'link-a', '123456')
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(hashCode(pepper, 'link-b', '123456')).not.toBe(a)
  expect(hashCode('q'.repeat(32), 'link-a', '123456')).not.toBe(a)
})

test('the code hash is an HMAC, not a plain SHA-256', () => {
  const pepper = 'p'.repeat(32)
  expect(hashCode(pepper, 'link-a', '123456')).not.toBe(sha256Hex('link-a:123456'))
})
