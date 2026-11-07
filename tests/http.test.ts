import { expect, test } from 'bun:test'
import type { Deps } from '../src/deps'
import { maskTokens, sourceIp } from '../src/web/http'
import { get, post, testApp } from './helpers'

test('security headers on every response, including 404', async () => {
  for (const path of ['/login', '/does-not-exist']) {
    const res = await get(testApp().app, path)
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'none'; form-action 'self'"
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
  }
})

test('maskTokens hides link tokens but keeps fixed customer paths', () => {
  expect(maskTokens('/u/AbC-123_xyz')).toBe('/u/****')
  expect(maskTokens('/u/AbC-123_xyz/verify')).toBe('/u/****/verify')
  expect(maskTokens('/u/upload')).toBe('/u/upload')
  expect(maskTokens('/requests/1')).toBe('/requests/1')
})

test('request log line never contains the raw token', async () => {
  const { app, logs } = testApp()
  await get(app, '/u/SECRETTOKENVALUE')
  await Bun.sleep(5) // the log hook runs after the response is sent
  expect(logs.join('\n')).not.toContain('SECRETTOKENVALUE')
  expect(logs.some((l) => l.includes('GET /u/**** '))).toBe(true)
})

test('POST without Origin is refused', async () => {
  expect((await post(testApp().app, '/logout', {}, { origin: null })).status).toBe(403)
})

test('POST from a foreign Origin is refused', async () => {
  expect(
    (await post(testApp().app, '/logout', {}, { origin: 'https://evil.example' }))
      .status
  ).toBe(403)
})

test('unexpected errors return a generic 500 page and are logged, never shown', async () => {
  const failingDb = {
    select() {
      throw new Error(
        'Failed query: select "token_hash" from "user_sessions" params: deadbeef'
      )
    },
  } as unknown as Deps['db']
  const { app, logs } = testApp({ db: failingDb })
  const res = await get(app, '/u/SECRETTOKENVALUE/x', { cookie: 'sid=abc' })
  const home = await get(app, '/', { cookie: 'sid=abc' })
  expect(home.status).toBe(500)
  const body = await home.text()
  expect(body).not.toContain('Failed query')
  expect(body).not.toContain('deadbeef')
  expect(home.headers.get('referrer-policy')).toBe('no-referrer')
  await Bun.sleep(5) // the log hook runs after the response is sent
  expect(logs.some((l) => l.includes('Failed query'))).toBe(true)
  expect(logs.join('\n')).not.toContain('SECRETTOKENVALUE')
  expect(res.status).toBe(404)
})

test('source IP ignores X-Forwarded-For unless the proxy is trusted', () => {
  const req = new Request('http://x/', {
    headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' },
  })
  const server = { requestIP: () => ({ address: '192.0.2.5' }) }
  expect(sourceIp(req, server, false)).toBe('192.0.2.5')
})

test('source IP behind a trusted proxy is the entry the proxy appended, not a client-supplied one', () => {
  const req = new Request('http://x/', {
    headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' },
  })
  const server = { requestIP: () => ({ address: '192.0.2.5' }) }
  expect(sourceIp(req, server, true)).toBe('203.0.113.9')
  expect(sourceIp(new Request('http://x/'), server, true)).toBe('192.0.2.5')
})

// Chrome sends `Origin: null` on same-site form posts when the page uses
// Referrer-Policy: no-referrer, which every page here does.
const browserPost = (fetchSite: string | null, origin: string | null = 'null') => {
  const headers: Record<string, string> = {}
  if (fetchSite !== null) headers['sec-fetch-site'] = fetchSite
  return post(
    testApp().app,
    '/login',
    { userId: '00000000-0000-4000-8000-00000000a11c' },
    { origin, headers }
  )
}

test('a real browser form post (Origin null, Sec-Fetch-Site same-origin) is accepted', async () => {
  expect((await browserPost('same-origin')).status).toBe(303)
})

test('Origin null from another site is refused', async () => {
  expect((await browserPost('cross-site')).status).toBe(403)
  expect((await browserPost('same-site')).status).toBe(403)
})

test('Origin null without Sec-Fetch-Site is refused', async () => {
  expect((await browserPost(null)).status).toBe(403)
})

test('a foreign Origin is refused even if Sec-Fetch-Site claims same-origin', async () => {
  expect((await browserPost('same-origin', 'https://evil.example')).status).toBe(403)
})
