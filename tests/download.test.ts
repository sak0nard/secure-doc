import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { auditEvents, documents } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { sha256Hex } from '../src/modules/access/crypto'
import { pdf } from './fixtures'
import {
  appDb,
  bodyText,
  customerSessionVia,
  get,
  resetDb,
  signIn,
  testApp,
  uploadedRequestVia,
} from './helpers'

beforeEach(resetDb)

const events = (action: string) =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, action))

const setScan = (id: string, scanStatus: 'pending' | 'clean') =>
  appDb.update(documents).set({ scanStatus }).where(eq(documents.id, id))

describe('document download', () => {
  test('the requesting banker downloads the document as an attachment', async () => {
    const { app } = testApp()
    const { requestId, cookie, documentIds } = await uploadedRequestVia(app)
    const id = documentIds[0]!
    const res = await get(app, `/documents/${id}`, { cookie })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf())
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toStartWith('attachment; filename="')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')

    const downloaded = await events('document.downloaded')
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0]).toMatchObject({
      actorType: 'user',
      actorId: SEED.users.alice,
      targetType: 'document',
      targetId: id,
      requestId,
      outcome: 'success',
      detail: { sha256: sha256Hex(pdf()) },
    })
  })

  test('AC-7: another banker is denied the document and the attempt is logged', async () => {
    const { app } = testApp()
    const { requestId, documentIds } = await uploadedRequestVia(app)
    const id = documentIds[0]!
    const bob = await signIn(app, SEED.users.bob)
    const res = await get(app, `/documents/${id}`, { cookie: bob })
    expect(res.status).toBe(403)
    const body = await bodyText(res)
    expect(body).toContain("You don't have access to this.")
    expect(body).not.toContain('%PDF-')
    expect(res.headers.get('content-disposition')).toBeNull()

    const refused = await events('access.denied')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      actorId: SEED.users.bob,
      targetType: 'document',
      targetId: id,
      requestId,
      outcome: 'denied',
      detail: { action: 'document.download' },
    })
    expect(await events('document.downloaded')).toHaveLength(0)
  })

  test('compliance can download any document', async () => {
    const { app } = testApp()
    const { documentIds } = await uploadedRequestVia(app)
    const carol = await signIn(app, SEED.users.carol)
    const res = await get(app, `/documents/${documentIds[0]}`, { cookie: carol })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf())
  })

  test('a document still being scanned cannot be downloaded', async () => {
    const { app } = testApp()
    const { cookie, documentIds } = await uploadedRequestVia(app)
    const id = documentIds[0]!
    await setScan(id, 'pending')
    const carol = await signIn(app, SEED.users.carol)
    for (const c of [cookie, carol]) {
      const res = await get(app, `/documents/${id}`, { cookie: c })
      expect(res.status).toBe(409)
      expect(await bodyText(res)).toContain('This document is still being checked.')
      expect(res.headers.get('content-disposition')).toBeNull()
    }
    expect(await events('document.downloaded')).toHaveLength(0)
  })

  test('a missing object is a clean 404, logged', async () => {
    const { app, deps, logs } = testApp()
    const { cookie, documentIds } = await uploadedRequestVia(app)
    const id = documentIds[0]!
    const [row] = await appDb
      .select({ key: documents.storageKey, name: documents.originalFilename })
      .from(documents)
      .where(eq(documents.id, id))
    await deps.storage.delete(row!.key)
    const res = await get(app, `/documents/${id}`, { cookie })
    expect(res.status).toBe(404)
    expect(await bodyText(res)).toContain("This document isn't available.")
    const errors = logs.filter((l) => l.startsWith('ERROR'))
    expect(errors.some((l) => l.includes(id))).toBe(true)
    for (const l of errors) expect(l).not.toContain(row!.name)
    expect(await events('document.downloaded')).toHaveLength(0)
  })

  test('no download happens when its audit event cannot be written', async () => {
    const { app } = testApp()
    const { documentIds } = await uploadedRequestVia(app)
    const failingDb = new Proxy(appDb, {
      get: (target, key) =>
        key === 'transaction'
          ? () => Promise.reject(new Error('audit unavailable'))
          : Reflect.get(target, key),
    })
    const broken = testApp({ db: failingDb }).app
    const cookie = await signIn(app, SEED.users.alice)
    const res = await get(broken, `/documents/${documentIds[0]}`, { cookie })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('%PDF-')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  test('an upload-session cookie gives no staff access', async () => {
    const { app } = testApp()
    const s = await customerSessionVia(app)
    const { documentIds } = await uploadedRequestVia(app)
    const res = await get(app, `/documents/${documentIds[0]}`, {
      cookie: s.customerCookie,
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('malformed and unknown document ids are 404', async () => {
    const { app } = testApp()
    const cookie = await signIn(app, SEED.users.carol)
    for (const id of ['not-a-uuid', crypto.randomUUID()]) {
      const res = await get(app, `/documents/${id}`, { cookie })
      expect(res.status).toBe(404)
    }
  })
})
