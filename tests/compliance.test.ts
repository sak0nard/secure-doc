import { beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { auditEvents, users } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import {
  appDb,
  bodyText,
  createRequestVia,
  get,
  resetDb,
  signIn,
  tamperAsOwner,
  testApp,
  uploadedRequestVia,
} from './helpers'

beforeEach(resetDb)

type App = ReturnType<typeof testApp>['app']

const events = (action: string) =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, action))

/** Create → code → verify → upload → Alice downloads. */
async function journey(app: App) {
  const r = await uploadedRequestVia(app)
  const res = await get(app, `/documents/${r.documentIds[0]}`, { cookie: r.cookie })
  if (res.status !== 200) throw new Error(`download failed: ${res.status}`)
  return r
}

describe('compliance audit trail', () => {
  test('AC-8: compliance can view the document and the full audit trail', async () => {
    const { app } = testApp()
    const { requestId, documentIds } = await journey(app)
    const carol = await signIn(app, SEED.users.carol)
    expect(
      (await get(app, `/documents/${documentIds[0]}`, { cookie: carol })).status
    ).toBe(200)

    const res = await get(app, `/requests/${requestId}/audit`, { cookie: carol })
    expect(res.status).toBe(200)
    const body = await bodyText(res)
    const order = [
      'request.created',
      'link.issued',
      'otp.sent',
      'otp.verified',
      'document.uploaded',
      'request.received',
      'document.downloaded',
    ].map((a) => body.indexOf(a))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    for (const text of [
      '<td>Alice Banker</td>',
      '<td>Customer</td>',
      'Chain intact (',
      '<th>Source IP</th>',
    ])
      expect(body).toContain(text)

    const viewed = await events('audit.viewed')
    expect(viewed).toHaveLength(1)
    expect(viewed[0]).toMatchObject({
      actorId: SEED.users.carol,
      requestId,
      outcome: 'success',
    })
  })

  test('the audit page reports a tampered chain', async () => {
    const { app } = testApp()
    const { requestId } = await journey(app)
    const [created] = await appDb
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.requestId, requestId),
          eq(auditEvents.action, 'request.created')
        )
      )
    await tamperAsOwner(async (tx) => {
      await tx
        .update(auditEvents)
        .set({ detail: { edited: true } })
        .where(eq(auditEvents.seq, created!.seq))
    })
    const carol = await signIn(app, SEED.users.carol)
    const res = await get(app, `/requests/${requestId}/audit`, { cookie: carol })
    const body = await bodyText(res)
    expect(body).toContain(`Chain broken at event #${created!.seq} (content edited)`)
    expect(body).not.toContain('Chain intact')
  })

  test('bankers cannot view the audit trail, and the attempt is logged', async () => {
    const { app } = testApp()
    const { requestId, cookie } = await journey(app)
    const res = await get(app, `/requests/${requestId}/audit`, { cookie })
    expect(res.status).toBe(403)
    expect(await bodyText(res)).not.toContain('request.created')
    const refused = await events('access.denied')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      actorId: SEED.users.alice,
      requestId,
      outcome: 'denied',
      detail: { action: 'audit.view' },
    })
    expect(await events('audit.viewed')).toHaveLength(0)
  })

  test("the audit trail shows only this request's events", async () => {
    const { app } = testApp()
    const { requestId } = await journey(app)
    await createRequestVia(app, { banker: SEED.users.bob })
    const carol = await signIn(app, SEED.users.carol)
    const body = await bodyText(
      await get(app, `/requests/${requestId}/audit`, { cookie: carol })
    )
    expect(body.match(/request\.created/g)).toHaveLength(1)
    expect(body).not.toContain('Bob Banker')
  })

  test('stored text is escaped on the audit page', async () => {
    const [u] = await appDb
      .insert(users)
      .values({ name: '<script>x</script>', role: 'banker' })
      .returning()
    const { app } = testApp()
    const { requestId } = await createRequestVia(app, { banker: u!.id })
    const carol = await signIn(app, SEED.users.carol)
    const res = await get(app, `/requests/${requestId}/audit`, { cookie: carol })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>x')
  })

  test('unknown and malformed request ids are 404', async () => {
    const { app } = testApp()
    const carol = await signIn(app, SEED.users.carol)
    for (const id of ['nope', crypto.randomUUID()])
      expect((await get(app, `/requests/${id}/audit`, { cookie: carol })).status).toBe(
        404
      )
  })
})
