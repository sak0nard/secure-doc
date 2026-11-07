import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { auditEvents, uploadLinks } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { sha256Hex } from '../src/modules/access/crypto'
import { REFUSED_LINK_TEXT } from '../src/modules/requests/links'
import {
  appDb,
  bodyText,
  createRequestVia,
  get,
  linkToken,
  post,
  resetDb,
  signIn,
  testApp,
} from './helpers'

beforeEach(resetDb)

type App = ReturnType<typeof testApp>['app']

const refusals = () =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, 'link.refused'))

async function reissued(app: App, requestId: string): Promise<string> {
  const cookie = await signIn(app, SEED.users.alice)
  const res = await post(app, `/requests/${requestId}/reissue`, {}, { cookie })
  return linkToken(await res.text())!
}

test('a fresh link is accepted', async () => {
  const { app } = testApp()
  const { token } = await createRequestVia(app)
  const res = await get(app, `/u/${token}`)
  expect(res.status).toBe(200)
  expect(await bodyText(res)).toContain('Secure document upload')
  expect(await refusals()).toHaveLength(0)
})

test('AC-5: a reissued (revoked) link is refused', async () => {
  const { app } = testApp()
  const { requestId, token } = await createRequestVia(app)
  const fresh = await reissued(app, requestId)

  const old = await get(app, `/u/${token}`)
  expect(old.status).toBe(404)
  expect(await bodyText(old)).toContain(REFUSED_LINK_TEXT)
  expect((await get(app, `/u/${fresh}`)).status).toBe(200)

  const [link] = await appDb
    .select()
    .from(uploadLinks)
    .where(eq(uploadLinks.tokenHash, sha256Hex(token)))
  const events = await refusals()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    actorType: 'customer',
    actorId: link!.id,
    targetType: 'link',
    targetId: link!.id,
    requestId,
    outcome: 'failure',
    detail: { reason: 'revoked' },
  })
})

test('AC-5: an expired link is refused', async () => {
  const issuedAt = new Date('2026-11-07T00:00:00Z')
  let now = issuedAt
  const { app } = testApp({ now: () => now })
  const { token } = await createRequestVia(app)

  now = new Date(issuedAt.getTime() + 72 * 3600_000 - 1000)
  expect((await get(app, `/u/${token}`)).status).toBe(200)
  now = new Date(issuedAt.getTime() + 72 * 3600_000)
  const res = await get(app, `/u/${token}`)
  expect(res.status).toBe(404)
  expect(await bodyText(res)).toContain(REFUSED_LINK_TEXT)
  expect((await refusals()).map((e) => e.detail.reason)).toEqual(['expired'])
})

test('a locked link is refused', async () => {
  const { app } = testApp()
  const { requestId, token } = await createRequestVia(app)
  await appDb
    .update(uploadLinks)
    .set({ state: 'locked' })
    .where(eq(uploadLinks.requestId, requestId))
  expect((await get(app, `/u/${token}`)).status).toBe(404)
  expect((await refusals()).map((e) => e.detail.reason)).toEqual(['locked'])
})

test('unknown and hostile tokens get the same refusal, never a 500', async () => {
  const { app } = testApp()
  const { requestId, token } = await createRequestVia(app)
  await reissued(app, requestId)
  const revokedBody = await (await get(app, `/u/${token}`)).text()

  const hostile = ['x', 'a'.repeat(5000), '%00', '..%2F..%2Fetc', '%E2%9C%93']
  for (const t of hostile) {
    const res = await get(app, `/u/${t}`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe(revokedBody)
  }
  const unknown = (await refusals()).filter((e) => e.detail.reason === 'unknown')
  expect(unknown).toHaveLength(hostile.length)
  for (const e of unknown)
    expect(e).toMatchObject({
      actorType: 'customer',
      actorId: 'anonymous',
      targetType: 'link',
      targetId: 'unknown',
      requestId: null,
      outcome: 'failure',
    })
})

test('refusal events never contain the raw token', async () => {
  const { app } = testApp()
  const { requestId, token } = await createRequestVia(app)
  await reissued(app, requestId)
  await get(app, `/u/${token}`)
  const unknownToken = 'b'.repeat(43)
  await get(app, `/u/${unknownToken}`)

  const all = JSON.stringify(await appDb.select().from(auditEvents))
  expect(all).not.toContain(token)
  expect(all).not.toContain(unknownToken)
  const events = await refusals()
  expect(events).toHaveLength(2)
  for (const e of events) expect(e.detail.tokenHashPrefix).toMatch(/^[0-9a-f]{8}$/)
  expect(events[0]!.detail.tokenHashPrefix).toBe(sha256Hex(token).slice(0, 8))
})

test('refusal pages send no-referrer', async () => {
  const { app } = testApp()
  const { token } = await createRequestVia(app)
  const ok = await get(app, `/u/${token}`)
  const refused = await get(app, `/u/${'c'.repeat(43)}`)
  expect([ok.status, refused.status]).toEqual([200, 404])
  for (const res of [ok, refused])
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
})
