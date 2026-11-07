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
