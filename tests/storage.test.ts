import { describe, expect, test } from 'bun:test'
import { alwaysClean } from '../src/ports/scanner'
import { testStore as store } from './helpers'

const key = () => `documents/${crypto.randomUUID()}`

describe('object storage (RustFS, test bucket)', () => {
  test('stored bytes come back unchanged', async () => {
    const k = key()
    const bytes = crypto.getRandomValues(new Uint8Array(1024))
    await store.put(k, bytes, 'application/pdf')
    expect(await store.get(k)).toEqual(bytes)
    await store.delete(k)
  })

  test('a missing object reads as null', async () => {
    expect(await store.get('documents/does-not-exist')).toBeNull()
  })

  test('deleted objects are gone', async () => {
    const k = key()
    await store.put(k, new Uint8Array([1, 2, 3]), 'image/png')
    await store.delete(k)
    expect(await store.get(k)).toBeNull()
    await store.delete(k)
  })
})

test('the mock scanner passes everything', async () => {
  expect(await alwaysClean.scan(new Uint8Array([1]))).toBe('clean')
})
