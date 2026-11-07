import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { auditEvents, otpCodes, outbox } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { REFUSED_LINK_TEXT } from '../src/modules/requests/links'
import { hashCode } from '../src/modules/otp/codes'
import {
  appDb,
  bodyText,
  config,
  createRequestVia,
  get,
  latestOutboxCode,
  linkToken,
  post,
  resetDb,
  signIn,
  testApp,
} from './helpers'

beforeEach(resetDb)

type App = ReturnType<typeof testApp>['app']

const T0 = new Date('2026-11-07T00:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const SECOND = 1000
const MINUTE = 60 * SECOND

/** An app on a clock the test moves by assigning `clock.now`. */
function clockedApp(overrides: Parameters<typeof testApp>[0] = {}) {
  const clock = { now: T0 }
  const { app } = testApp({ now: () => clock.now, ...overrides })
  return { app, clock }
}

const sendCode = (app: App, token: string) => post(app, `/u/${token}/code`, {})
const outboxRows = () => appDb.select().from(outbox)
const events = (action: string) =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, action))

async function reissue(app: App, requestId: string): Promise<string> {
  const cookie = await signIn(app, SEED.users.alice)
  const res = await post(app, `/requests/${requestId}/reissue`, {}, { cookie })
  return linkToken(await res.text())!
}

const SMS_TEMPLATE =
  /^Your secure document upload code is \d{6}\. It expires in 5 minutes\. We will never ask for this code by phone or email\.$/

test('opening a valid link offers to text a code and sends nothing', async () => {
  const { app } = clockedApp()
  const { token } = await createRequestVia(app)
  const res = await get(app, `/u/${token}`)
  expect(res.status).toBe(200)
  const body = await bodyText(res)
  expect(body).toContain('Text me a code')
  expect(body).toContain('+•••••••••01')
  expect(await outboxRows()).toHaveLength(0)
})

test('requesting a code texts the mobile on the customer record', async () => {
  const { app } = clockedApp()
  const { token, linkId, requestId } = await createRequestVia(app)
  const res = await sendCode(app, token)
  expect(res.status).toBe(200)
  const body = await bodyText(res)
  expect(body).toContain('We sent a code to +•••••••••01')
  expect(body).toContain('name="code"')
  // HTML attribute names are case-insensitive; React writes them as inputMode/autoComplete.
  expect(body).toMatch(/inputmode="numeric"/i)
  expect(body).toMatch(/autocomplete="one-time-code"/i)
  expect(body).toContain(`action="/u/${token}/verify"`)

  const rows = await outboxRows()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.toMobile).toBe('+61400000101')
  expect(rows[0]!.body).toMatch(SMS_TEMPLATE)
  const code = (await latestOutboxCode(linkId))!

  const codes = await appDb.select().from(otpCodes)
  expect(codes).toHaveLength(1)
  expect(codes[0]!.codeHash).toBe(hashCode(config.otpPepper, linkId, code))
  expect(JSON.stringify(codes)).not.toContain(code)
  expect(JSON.stringify(await appDb.select().from(auditEvents))).not.toContain(code)

  const sent = await events('otp.sent')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    actorType: 'customer',
    actorId: linkId,
    requestId,
    outcome: 'success',
  })
})

test('codes are at least 30 seconds apart', async () => {
  const { app, clock } = clockedApp()
  const { token } = await createRequestVia(app)
  expect((await sendCode(app, token)).status).toBe(200)

  const again = await sendCode(app, token)
  expect(again.status).toBe(429)
  expect(await bodyText(again)).toContain(
    'Please wait a moment before requesting another code.'
  )
  const refused = await events('otp.send_refused')
  expect(refused).toHaveLength(1)
  expect(refused[0]).toMatchObject({
    outcome: 'failure',
    detail: { reason: 'cooldown' },
  })
  expect(await outboxRows()).toHaveLength(1)

  clock.now = at(30 * SECOND)
  expect((await sendCode(app, token)).status).toBe(200)
  expect(await outboxRows()).toHaveLength(2)
})

test('at most three codes per link', async () => {
  const { app, clock } = clockedApp()
  const { token } = await createRequestVia(app)
  for (let i = 0; i < 3; i++) {
    clock.now = at(i * 30 * SECOND)
    expect((await sendCode(app, token)).status).toBe(200)
  }
  clock.now = at(3 * 30 * SECOND)
  const fourth = await sendCode(app, token)
  expect(fourth.status).toBe(429)
  expect(await bodyText(fourth)).toContain(
    'Too many codes requested; contact your banker.'
  )
  expect((await events('otp.send_refused'))[0]).toMatchObject({
    detail: { reason: 'limit' },
  })
  expect(await outboxRows()).toHaveLength(3)
})

test('codes cannot be requested on a refused link', async () => {
  const { app } = clockedApp()
  const { token, requestId } = await createRequestVia(app)
  await reissue(app, requestId)
  const res = await sendCode(app, token)
  expect(res.status).toBe(404)
  expect(await bodyText(res)).toContain(REFUSED_LINK_TEXT)
  expect(await outboxRows()).toHaveLength(0)
})

test('outbox page lists codes only when the mock is enabled', async () => {
  const { app } = clockedApp()
  const { token, linkId } = await createRequestVia(app)
  await sendCode(app, token)
  const code = (await latestOutboxCode(linkId))!
  const res = await get(app, '/dev/outbox')
  expect(res.status).toBe(200)
  expect(await bodyText(res)).toContain(code)

  const { app: off } = testApp({ config: { ...config, mockOutboxEnabled: false } })
  expect((await get(off, '/dev/outbox')).status).toBe(404)
})
