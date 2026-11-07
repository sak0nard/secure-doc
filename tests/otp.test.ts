import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  auditEvents,
  customerSessions,
  otpCodes,
  outbox,
  uploadLinks,
} from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { sha256Hex } from '../src/modules/access/crypto'
import { REFUSED_LINK_TEXT } from '../src/modules/requests/links'
import { hashCode } from '../src/modules/otp/codes'
import {
  appDb,
  bodyText,
  config,
  createRequestVia,
  customerCookie,
  customerSessionVia,
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

// --- Verification, lockout and the customer upload session ---

const WRONG_TEXT =
  "That code didn't work. Check it and try again, or request a new code."
const LOCKED_TEXT =
  'Too many incorrect codes. This link is now locked; contact your banker.'
const SESSION_ENDED_TEXT =
  'Your upload session has ended. Open the link from your banker again.'

const verify = (app: App, token: string, code: string) =>
  post(app, `/u/${token}/verify`, { code })
/** A well-formed code that is certainly not `code`. */
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000')
const linkRow = async (linkId: string) =>
  (await appDb.select().from(uploadLinks).where(eq(uploadLinks.id, linkId)))[0]!

/** Creates a request and texts its first code; returns the link and the code. */
async function withCode(app: App) {
  const created = await createRequestVia(app)
  expect((await sendCode(app, created.token)).status).toBe(200)
  return { ...created, code: (await latestOutboxCode(created.linkId))! }
}

test('the correct code starts a short upload session', async () => {
  const { app } = clockedApp()
  const { token, code, linkId, requestId } = await withCode(app)
  const res = await verify(app, token, code)
  expect(res.status).toBe(303)
  expect(res.headers.get('location')).toBe('/u/upload')
  const setCookie = res.headers.get('set-cookie')!
  for (const part of ['cs=', 'HttpOnly', 'SameSite=Strict', 'Path=/u', 'Max-Age=900'])
    expect(setCookie).toContain(part)
  expect(setCookie).not.toContain('Secure')

  const cs = customerCookie(res)!
  const sessions = await appDb.select().from(customerSessions)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.tokenHash).toBe(sha256Hex(cs.slice('cs='.length)))

  const upload = await get(app, '/u/upload', { cookie: cs })
  expect(upload.status).toBe(200)
  expect(await bodyText(upload)).toContain('Upload your documents')
  const verified = await events('otp.verified')
  expect(verified).toHaveLength(1)
  expect(verified[0]).toMatchObject({ actorId: linkId, requestId, outcome: 'success' })
})

test('the session cookie is Secure when the site is served over https', async () => {
  const { app } = clockedApp()
  const { token, linkId } = await createRequestVia(app)
  const origin = 'https://docs.example.test'
  const { app: https } = clockedApp({ config: { ...config, baseUrl: new URL(origin) } })
  await post(https, `/u/${token}/code`, {}, { origin })
  const code = (await latestOutboxCode(linkId))!
  const res = await post(https, `/u/${token}/verify`, { code }, { origin })
  expect(res.status).toBe(303)
  expect(res.headers.get('set-cookie')).toContain('Secure')
})

test('a code works only once', async () => {
  const { app } = clockedApp()
  const { token, code, linkId } = await withCode(app)
  expect((await verify(app, token, code)).status).toBe(303)
  const again = await verify(app, token, code)
  expect(again.status).toBe(400)
  expect(await bodyText(again)).toContain(WRONG_TEXT)
  expect((await linkRow(linkId)).failedCodeAttempts).toBe(1)
})

test('a code expires after five minutes', async () => {
  const { app, clock } = clockedApp()
  const { token, code, linkId } = await withCode(app)
  clock.now = at(5 * MINUTE)
  expect((await verify(app, token, code)).status).toBe(400)
  expect((await sendCode(app, token)).status).toBe(200)
  const fresh = (await latestOutboxCode(linkId))!
  expect((await verify(app, token, fresh)).status).toBe(303)
})

test('a code just inside five minutes still works', async () => {
  const { app, clock } = clockedApp()
  const { token, code } = await withCode(app)
  clock.now = at(5 * MINUTE - 1)
  expect((await verify(app, token, code)).status).toBe(303)
})

test('a new code replaces the previous one', async () => {
  const { app, clock } = clockedApp()
  const { token, code: first, linkId } = await withCode(app)
  clock.now = at(30 * SECOND)
  expect((await sendCode(app, token)).status).toBe(200)
  const second = (await latestOutboxCode(linkId))!
  expect((await verify(app, token, first)).status).toBe(first === second ? 303 : 400)
  if (first !== second) expect((await verify(app, token, second)).status).toBe(303)
})

test('AC-6: five wrong codes lock the link and log a suspicious-activity event', async () => {
  const { app } = clockedApp()
  const { token, code, linkId, requestId, cookie } = await withCode(app)
  for (let i = 0; i < 4; i++) {
    const res = await verify(app, token, wrongCode(code))
    expect(res.status).toBe(400)
    expect(await bodyText(res)).toContain(WRONG_TEXT)
  }
  const fifth = await verify(app, token, wrongCode(code))
  expect(fifth.status).toBe(403)
  expect(await bodyText(fifth)).toContain(LOCKED_TEXT)

  expect((await linkRow(linkId)).state).toBe('locked')
  const locked = await events('otp.locked')
  expect(locked).toHaveLength(1)
  expect(locked[0]).toMatchObject({ outcome: 'suspicious', requestId, actorId: linkId })
  expect(await events('otp.verify_failed')).toHaveLength(5)

  const afterwards = await verify(app, token, code)
  expect(afterwards.status).toBe(404)
  expect(await bodyText(afterwards)).toContain(REFUSED_LINK_TEXT)
  expect((await events('link.refused')).map((e) => e.detail.reason)).toEqual(['locked'])
  expect((await get(app, `/u/${token}`)).status).toBe(404)

  expect(await bodyText(await get(app, '/', { cookie }))).toContain('Link locked')
})

test('wrong attempts count across resends', async () => {
  const { app, clock } = clockedApp()
  const { token, code, linkId } = await withCode(app)
  for (let i = 0; i < 3; i++)
    expect((await verify(app, token, wrongCode(code))).status).toBe(400)
  clock.now = at(30 * SECOND)
  expect((await sendCode(app, token)).status).toBe(200)
  const fresh = (await latestOutboxCode(linkId))!
  expect((await verify(app, token, wrongCode(fresh))).status).toBe(400)
  expect((await verify(app, token, wrongCode(fresh))).status).toBe(403)
  expect((await linkRow(linkId)).state).toBe('locked')
})

test('concurrent wrong guesses stop at five', async () => {
  const { app } = clockedApp()
  const { token, code, linkId } = await withCode(app)
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => verify(app, token, wrongCode(code)))
  )
  const statuses = responses.map((r) => r.status).sort()
  expect(statuses).not.toContain(500)
  expect(statuses.filter((s) => s === 403)).toHaveLength(1)
  expect((await linkRow(linkId)).failedCodeAttempts).toBe(5)
  expect(await events('otp.locked')).toHaveLength(1)
})

test('malformed codes count as wrong and never error', async () => {
  const { app } = clockedApp()
  const { token, linkId } = await withCode(app)
  const inputs = ['', '12345', '1234567', 'abcdef', '1'.repeat(5000)]
  const statuses = []
  for (const input of inputs) statuses.push((await verify(app, token, input)).status)
  expect(statuses).toEqual([400, 400, 400, 400, 403])
  const link = await linkRow(linkId)
  expect(link.failedCodeAttempts).toBe(5)
  expect(link.state).toBe('locked')
})

test('a missing code field counts as wrong', async () => {
  const { app } = clockedApp()
  const { token, linkId } = await withCode(app)
  expect((await post(app, `/u/${token}/verify`, {})).status).toBe(400)
  expect((await linkRow(linkId)).failedCodeAttempts).toBe(1)
})

test('upload session needs a valid cookie', async () => {
  const { app } = clockedApp()
  const none = await get(app, '/u/upload')
  expect(none.status).toBe(403)
  expect(await bodyText(none)).toContain(SESSION_ENDED_TEXT)
  expect((await get(app, '/u/upload', { cookie: 'cs=garbage' })).status).toBe(403)
})

test('upload session ends after fifteen minutes', async () => {
  const { app, clock } = clockedApp()
  const { customerCookie: cs } = await customerSessionVia(app)
  clock.now = at(15 * MINUTE - 1)
  expect((await get(app, '/u/upload', { cookie: cs })).status).toBe(200)
  clock.now = at(15 * MINUTE)
  expect((await get(app, '/u/upload', { cookie: cs })).status).toBe(403)
})

test('reissuing the link ends an upload session on the old link', async () => {
  const { app } = clockedApp()
  const { customerCookie: cs, requestId } = await customerSessionVia(app)
  expect((await get(app, '/u/upload', { cookie: cs })).status).toBe(200)
  await reissue(app, requestId)
  expect((await get(app, '/u/upload', { cookie: cs })).status).toBe(403)
})

test('a locked request gets a fresh allowance after reissue', async () => {
  const { app } = clockedApp()
  const { token, code, requestId } = await withCode(app)
  for (let i = 0; i < 5; i++) await verify(app, token, wrongCode(code))
  const fresh = await reissue(app, requestId)
  expect((await sendCode(app, fresh)).status).toBe(200)
  const [link] = await appDb
    .select()
    .from(uploadLinks)
    .where(eq(uploadLinks.tokenHash, sha256Hex(fresh)))
  const newCode = (await latestOutboxCode(link!.id))!
  expect((await verify(app, fresh, newCode)).status).toBe(303)
})
