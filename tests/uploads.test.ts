import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { auditEvents, documents, requests } from '../src/db/schema'
import { SEED } from '../src/db/seed'
import { sha256Hex } from '../src/modules/access/crypto'
import { verifyChain } from '../src/modules/audit/audit'
import { REFUSED_LINK_TEXT } from '../src/modules/requests/links'
import type { MalwareScanner } from '../src/ports/scanner'
import type { ObjectStore } from '../src/ports/storage'
import { exe, jpeg, pdf, sized } from './fixtures'
import {
  appDb,
  bodyText,
  config,
  customerSessionVia,
  get,
  post,
  resetDb,
  signIn,
  testApp,
  testStore,
} from './helpers'

beforeEach(resetDb)

type App = ReturnType<typeof testApp>['app']
type Part = { field: string; name: string; bytes: Uint8Array; type?: string }

const MB = 1024 * 1024
const THANKS = 'Thank you. Your documents have been sent to your banker.'
const SESSION_ENDED = 'Your upload session has ended.'
const OUTAGE = "We couldn't process your files right now. Please try again."

/** Posts files as a browser would: one multipart part per file, named by its input. */
function upload(app: App, cs: string, parts: Part[]) {
  const form = new FormData()
  for (const p of parts)
    form.append(
      p.field,
      new File([p.bytes], p.name, { type: p.type ?? 'application/octet-stream' })
    )
  return app.handle(
    new Request(new URL('/u/upload', config.baseUrl).toString(), {
      method: 'POST',
      headers: { origin: config.baseUrl.origin, cookie: cs },
      body: form,
    })
  )
}

const payslip = (bytes = pdf(), name = 'payslip.pdf'): Part => ({
  field: 'payslip',
  name,
  bytes,
})
const photoId = (bytes = jpeg(), name = 'id.jpg'): Part => ({
  field: 'photo_id',
  name,
  bytes,
})

/** A verified customer on a request for a payslip and a photo ID. */
const session = (app: App) =>
  customerSessionVia(app, { documentTypes: ['payslip', 'photo_id'] })

const docRows = () => appDb.select().from(documents)
const events = (action: string) =>
  appDb.select().from(auditEvents).where(eq(auditEvents.action, action))

/** The real store, recording every key written. `failOnPut` makes that put (1-based) throw. */
function recordingStore(opts: { failOnPut?: number } = {}) {
  const keys: string[] = []
  const store: ObjectStore = {
    async put(key, bytes, type) {
      keys.push(key)
      if (keys.length === opts.failOnPut) throw new Error('storage unavailable')
      await testStore.put(key, bytes, type)
    },
    get: (key) => testStore.get(key),
    delete: (key) => testStore.delete(key),
  }
  return { store, keys }
}

async function stored(keys: string[]) {
  return (await Promise.all(keys.map((k) => testStore.get(k)))).filter((b) => b)
}

describe('customer upload', () => {
  test('the upload page has one file input per requested type', async () => {
    const { app } = testApp()
    const s = await session(app)
    const res = await get(app, '/u/upload', { cookie: s.customerCookie })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('Upload your documents')
    // HTML attribute names are case-insensitive; React writes `encType`.
    expect(html).toMatch(/<form[^>]* enctype="multipart\/form-data"/i)
    const inputs = html.match(/<input type="file"[^>]*>/g) ?? []
    expect(inputs.map((i) => i.match(/name="([^"]*)"/)?.[1])).toEqual([
      'payslip',
      'photo_id',
    ])
    for (const input of inputs) expect(input).toContain(' multiple=""')
    expect(html).toContain('PDF, JPG or PNG, up to 10 MB each.')
    expect(html).toContain('Send documents')
  })

  test('AC-2: a valid link plus the correct code lets the customer upload a PDF', async () => {
    const { app } = testApp()
    const s = await session(app)
    const files = [payslip(), photoId()]
    const res = await upload(app, s.customerCookie, files)
    expect(res.status).toBe(200)
    expect(await bodyText(res)).toContain(THANKS)

    const rows = await docRows()
    expect(rows).toHaveLength(2)
    const retention = new Date(Date.now() + 2555 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    for (const f of files) {
      const row = rows.find((r) => r.originalFilename === f.name)!
      expect(row).toMatchObject({
        requestId: s.requestId,
        documentType: f.field,
        detectedType: f.field === 'payslip' ? 'pdf' : 'jpeg',
        sizeBytes: f.bytes.length,
        sha256: sha256Hex(f.bytes),
        scanStatus: 'clean',
        retentionUntil: retention,
      })
      expect(row.storageKey).toMatch(/^documents\/[0-9a-f-]{36}$/)
      expect(await testStore.get(row.storageKey)).toEqual(f.bytes)
    }

    const [req] = await appDb
      .select()
      .from(requests)
      .where(eq(requests.id, s.requestId))
    expect(req!.status).toBe('received')
    expect(await bodyText(await get(app, '/', { cookie: s.cookie }))).toContain(
      'Received'
    )
  })

  test('submitting uses up the link and ends the session', async () => {
    const { app } = testApp()
    const s = await session(app)
    expect((await upload(app, s.customerCookie, [payslip(), photoId()])).status).toBe(
      200
    )
    const page = await get(app, '/u/upload', { cookie: s.customerCookie })
    expect(page.status).toBe(403)
    expect(await bodyText(page)).toContain(SESSION_ENDED)
    const again = await upload(app, s.customerCookie, [payslip(), photoId()])
    expect(again.status).toBe(403)
    expect(await docRows()).toHaveLength(2)
  })

  test('AC-5: a used link is refused', async () => {
    const { app } = testApp()
    const s = await session(app)
    await upload(app, s.customerCookie, [payslip(), photoId()])
    const res = await get(app, `/u/${s.token}`)
    expect(res.status).toBe(404)
    expect(await bodyText(res)).toContain(REFUSED_LINK_TEXT)
    expect((await events('link.refused')).map((e) => e.detail.reason)).toEqual(['used'])
  })

  test('upload is audited per file and as received', async () => {
    const { app } = testApp()
    const s = await session(app)
    const files = [payslip(pdf(), 'secret-name.pdf'), photoId()]
    await upload(app, s.customerCookie, files)
    const uploaded = await events('document.uploaded')
    expect(uploaded).toHaveLength(2)
    expect(uploaded.map((e) => e.detail.sha256).sort()).toEqual(
      files.map((f) => sha256Hex(f.bytes)).sort()
    )
    for (const e of uploaded) {
      expect(e).toMatchObject({ requestId: s.requestId, outcome: 'success' })
      expect(JSON.stringify(e.detail)).not.toContain('secret-name')
    }
    const received = await events('request.received')
    expect(received).toHaveLength(1)
    expect(received[0]!.requestId).toBe(s.requestId)
    expect((await verifyChain(appDb)).ok).toBe(true)
  })

  test('AC-3: a renamed executable is rejected and nothing is stored', async () => {
    const recorder = recordingStore()
    const { app } = testApp({ storage: recorder.store })
    const s = await session(app)
    const fake = { ...payslip(exe(), 'payslip.pdf'), type: 'application/pdf' }
    const res = await upload(app, s.customerCookie, [fake, photoId()])
    expect(res.status).toBe(422)
    const body = await bodyText(res)
    expect(body).toContain('payslip.pdf: not a PDF, JPG or PNG file')
    expect(body).toContain('Send documents')
    expect(await docRows()).toHaveLength(0)
    expect(recorder.keys).toHaveLength(0)

    const [rejected] = await events('upload.rejected')
    expect(rejected).toMatchObject({ requestId: s.requestId, outcome: 'failure' })
    expect(rejected!.detail).toEqual({
      problems: [{ field: 'payslip', reason: 'not a PDF, JPG or PNG file' }],
    })

    const retry = await upload(app, s.customerCookie, [payslip(), photoId()])
    expect(retry.status).toBe(200)
  })

  test('AC-4: a file over 10 MB is rejected', async () => {
    const { app } = testApp()
    const s = await session(app)
    const big = payslip(sized(pdf(), 10 * MB + 1), 'big.pdf')
    const res = await upload(app, s.customerCookie, [big, photoId()])
    expect(res.status).toBe(422)
    expect(await bodyText(res)).toContain('big.pdf: larger than 10 MB')
    expect(await docRows()).toHaveLength(0)
  })

  test('a missing document type is refused with the type named', async () => {
    const { app } = testApp()
    const s = await session(app)
    const res = await upload(app, s.customerCookie, [payslip()])
    expect(res.status).toBe(422)
    expect(await bodyText(res)).toContain('Missing: Photo ID')
    expect(await docRows()).toHaveLength(0)
  })

  test('an input left empty counts as missing, not as a bad file', async () => {
    const { app } = testApp()
    const s = await session(app)
    // A browser sends an empty, unnamed part for a file input with nothing chosen.
    const empty = { field: 'photo_id', name: '', bytes: new Uint8Array() }
    const res = await upload(app, s.customerCookie, [payslip(), empty])
    expect(res.status).toBe(422)
    const body = await bodyText(res)
    expect(body).toContain('Missing: Photo ID')
    expect(body).not.toContain('not a PDF, JPG or PNG file')
  })

  test('a hostile file name is display-only and escaped', async () => {
    const { app } = testApp()
    const s = await session(app)
    const name = '../../etc/<b>x</b>.pdf'
    expect(
      (await upload(app, s.customerCookie, [payslip(pdf(), name), photoId()])).status
    ).toBe(200)
    const [row] = (await docRows()).filter((r) => r.originalFilename === name)
    expect(row!.storageKey).toMatch(/^documents\/[0-9a-f-]{36}$/)
    const html = await (
      await get(app, `/requests/${s.requestId}`, { cookie: s.cookie })
    ).text()
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  test('an infected file fails the whole submission', async () => {
    const recorder = recordingStore()
    const scanner: MalwareScanner = {
      scan: async (b) => (b[0] === 0x25 ? 'infected' : 'clean'),
    }
    const { app } = testApp({ scanner, storage: recorder.store })
    const s = await session(app)
    const res = await upload(app, s.customerCookie, [payslip(), photoId()])
    expect(res.status).toBe(422)
    expect(await bodyText(res)).toContain('payslip.pdf: failed the security scan')
    expect(await docRows()).toHaveLength(0)
    expect(recorder.keys).toHaveLength(0)
    expect(await events('upload.rejected')).toHaveLength(1)
  })

  test('a storage outage leaves no rows, no objects, and an open session', async () => {
    const recorder = recordingStore({ failOnPut: 2 })
    const { app } = testApp({ storage: recorder.store })
    const s = await session(app)
    const res = await upload(app, s.customerCookie, [payslip(), photoId()])
    expect(res.status).toBe(503)
    expect(await bodyText(res)).toContain(OUTAGE)
    expect(recorder.keys).toHaveLength(2)
    expect(await stored(recorder.keys)).toHaveLength(0)
    expect(await docRows()).toHaveLength(0)

    const { app: healthy } = testApp()
    expect(
      (await upload(healthy, s.customerCookie, [payslip(), photoId()])).status
    ).toBe(200)
  })

  test('a scanner outage fails closed', async () => {
    const recorder = recordingStore()
    const scanner: MalwareScanner = {
      scan: async () => {
        throw new Error('scanner unavailable')
      },
    }
    const { app } = testApp({ scanner, storage: recorder.store })
    const s = await session(app)
    const res = await upload(app, s.customerCookie, [payslip(), photoId()])
    expect(res.status).toBe(503)
    expect(await bodyText(res)).toContain(OUTAGE)
    expect(await docRows()).toHaveLength(0)
    expect(recorder.keys).toHaveLength(0)
  })

  test('reissue during upload refuses the submission', async () => {
    const recorder = recordingStore()
    const { app } = testApp({ storage: recorder.store })
    const s = await session(app)
    // The customer's upload is already past its checks when the banker reissues: the
    // reissue lands while the files are being stored.
    let reissued = false
    const racing: ObjectStore = {
      ...recorder.store,
      async put(key, bytes, type) {
        await recorder.store.put(key, bytes, type)
        if (reissued) return
        reissued = true
        const banker = await signIn(app, SEED.users.alice)
        const r = await post(
          app,
          `/requests/${s.requestId}/reissue`,
          {},
          { cookie: banker }
        )
        expect(r.status).toBe(200)
      },
    }
    const { app: customerApp } = testApp({ storage: racing })
    const res = await upload(customerApp, s.customerCookie, [payslip(), photoId()])
    expect(res.status).toBe(403)
    expect(await bodyText(res)).toContain(SESSION_ENDED)
    expect(recorder.keys.length).toBeGreaterThan(0)
    expect(await stored(recorder.keys)).toHaveLength(0)
    expect(await docRows()).toHaveLength(0)
  })

  test('two tabs submitting at once: exactly one succeeds', async () => {
    const recorder = recordingStore()
    const { app } = testApp({ storage: recorder.store })
    const s = await session(app)
    const [a, b] = await Promise.all([
      upload(app, s.customerCookie, [payslip(pdf(), 'tab-a.pdf'), photoId()]),
      upload(app, s.customerCookie, [payslip(pdf(), 'tab-b.pdf'), photoId()]),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 403])
    const rows = await docRows()
    expect(rows).toHaveLength(2)
    const winner = a.status === 200 ? 'tab-a.pdf' : 'tab-b.pdf'
    expect(rows.map((r) => r.originalFilename)).toContain(winner)
    const kept = new Set(rows.map((r) => r.storageKey))
    const losers = recorder.keys.filter((k) => !kept.has(k))
    expect(await stored(losers)).toHaveLength(0)
    expect(await stored([...kept])).toHaveLength(2)
  })

  test('the banker sees the uploaded documents', async () => {
    const { app } = testApp()
    const s = await session(app)
    await upload(app, s.customerCookie, [
      payslip(pdf(), 'march-payslip.pdf'),
      photoId(),
    ])
    const res = await get(app, `/requests/${s.requestId}`, { cookie: s.cookie })
    const body = await bodyText(res)
    expect(body).toContain('march-payslip.pdf')
    expect(body).toContain('id.jpg')
    expect(body).toContain('Payslip')
    expect(body).toContain('Photo ID')
    expect(body).toContain('clean')
    expect(body).not.toContain('None yet.')
  })
})
