import { desc, eq, sql } from 'drizzle-orm'
import { loadConfig } from '../src/config'
import { createDb, type Tx } from '../src/db/client'
import { outbox, uploadLinks } from '../src/db/schema'
import { SEED, seed } from '../src/db/seed'
import { createApp } from '../src/app'
import type { Deps } from '../src/deps'
import { sha256Hex } from '../src/modules/access/crypto'
import { alwaysClean } from '../src/ports/scanner'
import { outboxSms } from '../src/ports/sms'
import { s3Store } from '../src/ports/storage'
import type { DocumentType } from '../src/modules/requests/requests'

export const config = loadConfig(process.env)
export const ownerDb = createDb(config.databaseOwnerUrl)
export const appDb = createDb(config.databaseUrl)
/** The real object store against the test bucket. */
export const testStore = s3Store(config.s3)

/** Empty every table (as owner, so audit rows can go too) and re-seed. */
export async function resetDb(): Promise<void> {
  const rows = await ownerDb.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`
  )
  const names = [...rows].map((r) => `"${r.tablename}"`).join(', ')
  if (names)
    await ownerDb.execute(sql.raw(`truncate ${names} restart identity cascade`))
  await seed(ownerDb)
}

/**
 * Simulates a privileged attacker: as the owner, with the append-only trigger disabled
 * for this transaction only. The trigger itself is never loosened.
 */
export async function tamperAsOwner(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await ownerDb.transaction(async (tx) => {
    await tx.execute(
      sql`alter table audit_events disable trigger audit_events_append_only`
    )
    await fn(tx)
    await tx.execute(
      sql`alter table audit_events enable trigger audit_events_append_only`
    )
  })
}

type App = { handle: (req: Request) => Promise<Response> }

/** Builds the app against the test database. `logs` collects request log lines. */
export function testApp(overrides: Partial<Deps> = {}) {
  const logs: string[] = []
  const deps: Deps = {
    config,
    db: appDb,
    sms: outboxSms,
    storage: testStore,
    scanner: alwaysClean,
    now: () => new Date(),
    log: (l) => logs.push(l),
    ...overrides,
  }
  return { app: createApp(deps), logs, deps }
}

const url = (path: string) => new URL(path, config.baseUrl).toString()

export function get(
  app: App,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string> } = {}
) {
  const headers = new Headers(opts.headers)
  if (opts.cookie) headers.set('cookie', opts.cookie)
  return app.handle(new Request(url(path), { headers }))
}

/**
 * Posts a urlencoded form. Sends a same-site Origin unless `origin` is given (`null` omits it).
 * Pass pairs to repeat a key, as checkboxes do.
 */
export function post(
  app: App,
  path: string,
  form: Record<string, string> | [string, string][],
  opts: {
    cookie?: string
    origin?: string | null
    headers?: Record<string, string>
  } = {}
) {
  const headers = new Headers({
    ...opts.headers,
    'content-type': 'application/x-www-form-urlencoded',
  })
  const origin = opts.origin === undefined ? config.baseUrl.origin : opts.origin
  if (origin !== null) headers.set('origin', origin)
  if (opts.cookie) headers.set('cookie', opts.cookie)
  return app.handle(
    new Request(url(path), { method: 'POST', headers, body: new URLSearchParams(form) })
  )
}

const ENTITIES: Record<string, string> = {
  '&#x27;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
}

/** A response body with React's HTML escapes decoded, so tests match the wording a reader sees. */
export async function bodyText(res: Response): Promise<string> {
  return (await res.text()).replace(
    /&#x27;|&quot;|&lt;|&gt;|&amp;/g,
    (e) => ENTITIES[e]!
  )
}

/** Signs in through the mock login and returns the session cookie header value. */
export async function signIn(app: App, userId: string): Promise<string> {
  const res = await post(app, '/login', { userId })
  return `sid=${res.headers.get('set-cookie')?.match(/sid=([^;]*)/)?.[1] ?? ''}`
}

/** The upload-link token shown on a create or reissue page, or null if none is shown. */
export function linkToken(html: string): string | null {
  return html.match(/\/u\/([A-Za-z0-9_-]{43})/)?.[1] ?? null
}

/**
 * Creates a request through the HTTP flow (default: Alice for Dana, one payslip) and
 * returns its id, the raw link token taken from the show-once page, and the link's id.
 */
export async function createRequestVia(
  app: App,
  opts: {
    banker?: string
    customer?: string
    cookie?: string
    documentTypes?: DocumentType[]
  } = {}
): Promise<{ requestId: string; token: string; linkId: string; cookie: string }> {
  const cookie = opts.cookie ?? (await signIn(app, opts.banker ?? SEED.users.alice))
  const types = opts.documentTypes ?? ['payslip']
  const res = await post(
    app,
    '/requests',
    [
      ['customerId', opts.customer ?? SEED.customers.dana],
      ...types.map((t): [string, string] => ['documentTypes', t]),
    ],
    { cookie }
  )
  const html = await res.text()
  const token = linkToken(html)
  const requestId = html.match(/href="\/requests\/([0-9a-f-]{36})"/)?.[1]
  if (res.status !== 200 || !token || !requestId)
    throw new Error(`create failed: ${res.status}`)
  const [link] = await appDb
    .select({ id: uploadLinks.id })
    .from(uploadLinks)
    .where(eq(uploadLinks.tokenHash, sha256Hex(token)))
  return { requestId, token, linkId: link!.id, cookie }
}

/** The `cs=<token>` cookie a response sets, ready to send back, or null if none is set. */
export function customerCookie(res: Response): string | null {
  const value = res.headers.get('set-cookie')?.match(/(?:^|[;,]\s*)cs=([^;]*)/)?.[1]
  return value ? `cs=${value}` : null
}

/**
 * Walks the customer journey up to the upload page: creates a request (as
 * `createRequestVia`), texts a code, and verifies it. Returns the request, the link and
 * the customer's session cookie (`cs=…`) for `/u/upload`.
 */
export async function customerSessionVia(
  app: App,
  opts: Parameters<typeof createRequestVia>[1] = {}
) {
  const created = await createRequestVia(app, opts)
  await post(app, `/u/${created.token}/code`, {})
  const code = await latestOutboxCode(created.linkId)
  const res = await post(app, `/u/${created.token}/verify`, { code: code ?? '' })
  const cs = customerCookie(res)
  if (res.status !== 303 || !cs) throw new Error(`verify failed: ${res.status}`)
  return { ...created, customerCookie: cs }
}

/** The 6-digit code in the newest mock SMS for a link, as the customer's phone shows it. */
export async function latestOutboxCode(linkId: string): Promise<string | null> {
  const [row] = await appDb
    .select({ body: outbox.body })
    .from(outbox)
    .where(eq(outbox.linkId, linkId))
    .orderBy(desc(outbox.createdAt))
    .limit(1)
  return row?.body.match(/\b(\d{6})\b/)?.[1] ?? null
}
