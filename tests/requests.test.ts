import { beforeEach, expect, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { auditEvents, requests, uploadLinks } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { sha256Hex } from '../src/modules/access/crypto'
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

const create = (app: App, cookie: string, form: [string, string][]) =>
  post(app, '/requests', form, { cookie })

const validForm = (customer: string = SEED.customers.dana): [string, string][] => [
  ['customerId', customer],
  ['documentTypes', 'payslip'],
]

const eventsForRequest = (requestId: string) =>
  appDb
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.requestId, requestId))
    .orderBy(asc(auditEvents.seq))

const eventsNamed = (action: string) =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, action))

test('AC-1: banker creates a request and sees the upload link exactly once', async () => {
  const { app } = testApp()
  const cookie = await signIn(app, SEED.users.alice)
  const res = await create(app, cookie, [
    ['customerId', SEED.customers.dana],
    ['documentTypes', 'payslip'],
    ['documentTypes', 'photo_id'],
  ])
  expect(res.status).toBe(200)
  const html = await bodyText(res)
  expect(html).toContain("Copy this link now. It won't be shown again.")
  const urls = html.match(/http:\/\/localhost:3000\/u\/[A-Za-z0-9_-]{43}/g) ?? []
  expect(new Set(urls).size).toBe(1)
  const token = linkToken(html)!

  const links = await appDb.select().from(uploadLinks)
  expect(links).toHaveLength(1)
  expect(links[0]!.tokenHash).toBe(sha256Hex(token))
  expect(JSON.stringify(links)).not.toContain(token)
  expect(JSON.stringify(await appDb.select().from(auditEvents))).not.toContain(token)

  const [request] = await appDb.select().from(requests)
  const detail = await get(app, `/requests/${request!.id}`, { cookie })
  expect(await detail.text()).not.toContain(token)
  const home = await get(app, '/', { cookie })
  expect(home.status).toBe(200)
  expect(await home.text()).not.toContain(token)
})

test('creating a request is audited with its link', async () => {
  const { requestId } = await createRequestVia(testApp().app)
  const events = await eventsForRequest(requestId)
  expect(events.map((e) => e.action)).toEqual(['request.created', 'link.issued'])
  for (const e of events)
    expect(e).toMatchObject({
      actorType: 'user',
      actorId: SEED.users.alice,
      outcome: 'success',
    })
})

test('both selected document types are stored, duplicates once', async () => {
  const { app } = testApp()
  const cookie = await signIn(app, SEED.users.alice)
  const res = await create(app, cookie, [
    ['customerId', SEED.customers.dana],
    ['documentTypes', 'payslip'],
    ['documentTypes', 'photo_id'],
    ['documentTypes', 'payslip'],
  ])
  expect(res.status).toBe(200)
  const [request] = await appDb.select().from(requests)
  expect(request!.documentTypes).toEqual(['payslip', 'photo_id'])
})

test('create rejects missing or unknown document types and unknown customers', async () => {
  const { app } = testApp()
  const cookie = await signIn(app, SEED.users.alice)
  const forms: [string, string][][] = [
    [['customerId', SEED.customers.dana]],
    [
      ['customerId', SEED.customers.dana],
      ['documentTypes', 'passport'],
    ],
    validForm(crypto.randomUUID()),
    validForm('not-a-uuid'),
  ]
  for (const form of forms) expect((await create(app, cookie, form)).status).toBe(400)
  expect(await appDb.select().from(requests)).toHaveLength(0)
})

test('compliance cannot create requests, and the attempt is logged', async () => {
  const { app } = testApp()
  const cookie = await signIn(app, SEED.users.carol)
  const res = await create(app, cookie, validForm())
  expect(res.status).toBe(403)
  expect(await bodyText(res)).toContain("You don't have access to this.")
  expect(await appDb.select().from(requests)).toHaveLength(0)
  const denied = await eventsNamed('access.denied')
  expect(denied).toHaveLength(1)
  expect(denied[0]).toMatchObject({
    actorType: 'user',
    actorId: SEED.users.carol,
    outcome: 'denied',
    detail: { action: 'request.create' },
  })
})

test('bankers see only their own requests; compliance sees all', async () => {
  const { app } = testApp()
  await createRequestVia(app, { banker: SEED.users.alice })
  await createRequestVia(app, { banker: SEED.users.bob, customer: SEED.customers.eli })
  const home = async (user: string) =>
    (await get(app, '/', { cookie: await signIn(app, user) })).text()

  const alice = await home(SEED.users.alice)
  expect(alice).toContain('Dana Customer')
  expect(alice).not.toContain('Eli Customer')
  const bob = await home(SEED.users.bob)
  expect(bob).toContain('Eli Customer')
  expect(bob).not.toContain('Dana Customer')
  const carol = await home(SEED.users.carol)
  expect(carol).toContain('Dana Customer')
  expect(carol).toContain('Eli Customer')
})

test('compliance home has no new-request button', async () => {
  const { app } = testApp()
  const home = async (user: string) =>
    (await get(app, '/', { cookie: await signIn(app, user) })).text()
  expect(await home(SEED.users.carol)).not.toContain('href="/requests/new"')
  expect(await home(SEED.users.alice)).toContain('href="/requests/new"')
})

const linksFor = (requestId: string) =>
  appDb.select().from(uploadLinks).where(eq(uploadLinks.requestId, requestId))

const reissue = (app: App, requestId: string, cookie: string) =>
  post(app, `/requests/${requestId}/reissue`, {}, { cookie })

const close = (app: App, requestId: string, cookie: string) =>
  post(app, `/requests/${requestId}/close`, {}, { cookie })

const markReceived = (requestId: string) =>
  appDb.update(requests).set({ status: 'received' }).where(eq(requests.id, requestId))

const storedStatus = async (requestId: string) =>
  (await appDb.select().from(requests).where(eq(requests.id, requestId)))[0]!.status

test('the owning banker sees the detail page, and the view is audited', async () => {
  const { app } = testApp()
  const { requestId, cookie } = await createRequestVia(app)
  const res = await get(app, `/requests/${requestId}`, { cookie })
  expect(res.status).toBe(200)
  const html = await bodyText(res)
  expect(html).toContain('Dana Customer')
  expect(html).toContain('+•••••••••01')
  expect(html).not.toContain('+61400000101')
  const viewed = await eventsNamed('request.viewed')
  expect(viewed).toHaveLength(1)
  expect(viewed[0]).toMatchObject({
    actorId: SEED.users.alice,
    requestId,
    outcome: 'success',
  })
})

test('another banker is denied the detail page, and the attempt is logged', async () => {
  const { app } = testApp()
  const { requestId } = await createRequestVia(app)
  const res = await get(app, `/requests/${requestId}`, {
    cookie: await signIn(app, SEED.users.bob),
  })
  expect(res.status).toBe(403)
  expect(await bodyText(res)).toContain("You don't have access to this.")
  const denied = await eventsNamed('access.denied')
  expect(denied).toHaveLength(1)
  expect(denied[0]).toMatchObject({
    actorId: SEED.users.bob,
    requestId,
    outcome: 'denied',
    detail: { action: 'request.view' },
  })
  expect(await eventsNamed('request.viewed')).toHaveLength(0)
})

test('compliance can view any request', async () => {
  const { app } = testApp()
  const { requestId } = await createRequestVia(app)
  const res = await get(app, `/requests/${requestId}`, {
    cookie: await signIn(app, SEED.users.carol),
  })
  expect(res.status).toBe(200)
})

test('malformed or unknown request ids are 404', async () => {
  const { app } = testApp()
  const cookie = await signIn(app, SEED.users.alice)
  for (const id of ['not-a-uuid', crypto.randomUUID()]) {
    expect((await get(app, `/requests/${id}`, { cookie })).status).toBe(404)
    expect((await reissue(app, id, cookie)).status).toBe(404)
    expect((await close(app, id, cookie)).status).toBe(404)
  }
})

test('reissue revokes the old link and shows the new one once', async () => {
  const { app } = testApp()
  const { requestId, token, cookie } = await createRequestVia(app)
  const res = await reissue(app, requestId, cookie)
  expect(res.status).toBe(200)
  const fresh = linkToken(await res.text())
  expect(fresh).toBeTruthy()
  expect(fresh).not.toBe(token)

  const links = await linksFor(requestId)
  expect(links.filter((l) => l.state === 'active').map((l) => l.tokenHash)).toEqual([
    sha256Hex(fresh!),
  ])
  expect(links.find((l) => l.tokenHash === sha256Hex(token))!.state).toBe('revoked')
  const actions = (await eventsForRequest(requestId)).map((e) => e.action)
  expect(actions).toEqual([
    'request.created',
    'link.issued',
    'link.revoked',
    'link.issued',
  ])
  const detail = await get(app, `/requests/${requestId}`, { cookie })
  expect(await detail.text()).not.toContain(fresh!)
})

test('another banker and compliance cannot reissue', async () => {
  const { app } = testApp()
  const { requestId, token } = await createRequestVia(app)
  for (const user of [SEED.users.bob, SEED.users.carol]) {
    const res = await reissue(app, requestId, await signIn(app, user))
    expect(res.status).toBe(403)
  }
  const denied = await eventsNamed('access.denied')
  expect(denied.map((e) => [e.actorId, e.detail])).toEqual([
    [SEED.users.bob, { action: 'request.reissue' }],
    [SEED.users.carol, { action: 'request.reissue' }],
  ])
  const links = await linksFor(requestId)
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ state: 'active', tokenHash: sha256Hex(token) })
})

test('two reissues at once leave one active link', async () => {
  const { app } = testApp()
  const { requestId, cookie } = await createRequestVia(app)
  const results = await Promise.all([
    reissue(app, requestId, cookie),
    reissue(app, requestId, cookie),
  ])
  expect(results.map((r) => r.status)).toEqual([200, 200])
  const links = await linksFor(requestId)
  expect(links).toHaveLength(3)
  expect(links.filter((l) => l.state === 'active')).toHaveLength(1)
})

test('reissuing an expired request makes it Open again', async () => {
  let now = new Date('2026-11-07T00:00:00Z')
  const { app } = testApp({ now: () => now })
  const { requestId } = await createRequestVia(app)
  // Sign in afresh each time: the sign-in session is shorter-lived than the link.
  const statusOnHome = async () => {
    const cookie = await signIn(app, SEED.users.alice)
    const html = await (await get(app, '/', { cookie })).text()
    return html.match(/<td>(Open|Expired|Received|Closed)/)?.[1]
  }
  expect(await statusOnHome()).toBe('Open')
  now = new Date(now.getTime() + 72 * 3600_000)
  expect(await statusOnHome()).toBe('Expired')
  const cookie = await signIn(app, SEED.users.alice)
  expect((await reissue(app, requestId, cookie)).status).toBe(200)
  expect(await statusOnHome()).toBe('Open')
})

test('reissue and close are refused in the wrong state', async () => {
  const { app } = testApp()
  const { requestId, cookie } = await createRequestVia(app)
  const refused = await close(app, requestId, cookie)
  expect(refused.status).toBe(409)
  expect(await bodyText(refused)).toContain(
    "This request can't be changed in its current state."
  )

  await markReceived(requestId)
  expect((await reissue(app, requestId, cookie)).status).toBe(409)
  const closed = await close(app, requestId, cookie)
  expect(closed.status).toBe(303)
  expect(closed.headers.get('location')).toBe(`/requests/${requestId}`)
  expect(await storedStatus(requestId)).toBe('closed')
  const events = await eventsNamed('request.closed')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ actorId: SEED.users.alice, requestId })

  expect((await close(app, requestId, cookie)).status).toBe(409)
  expect(await eventsNamed('request.closed')).toHaveLength(1)
})

test('compliance can close a received request', async () => {
  const { app } = testApp()
  const { requestId } = await createRequestVia(app)
  await markReceived(requestId)
  const res = await close(app, requestId, await signIn(app, SEED.users.carol))
  expect(res.status).toBe(303)
  expect(await storedStatus(requestId)).toBe('closed')
})

test('another banker cannot close, and the attempt is logged', async () => {
  const { app } = testApp()
  const { requestId } = await createRequestVia(app)
  await markReceived(requestId)
  const res = await close(app, requestId, await signIn(app, SEED.users.bob))
  expect(res.status).toBe(403)
  expect(await storedStatus(requestId)).toBe('received')
  expect((await eventsNamed('access.denied'))[0]!.detail).toEqual({
    action: 'request.close',
  })
})

test('a locked link is flagged on the list and the detail page', async () => {
  const { app } = testApp()
  const { requestId, cookie } = await createRequestVia(app)
  await appDb
    .update(uploadLinks)
    .set({ state: 'locked' })
    .where(eq(uploadLinks.requestId, requestId))
  expect(await (await get(app, '/', { cookie })).text()).toContain('Link locked')
  const detail = await (await get(app, `/requests/${requestId}`, { cookie })).text()
  expect(detail).toContain('Link locked: reissue required')
})
