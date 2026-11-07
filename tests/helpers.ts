import { sql } from 'drizzle-orm'
import { loadConfig } from '../src/config'
import { createDb, type Tx } from '../src/db/client'
import { SEED, seed } from '../src/db/seed'
import { createApp } from '../src/app'
import type { Deps } from '../src/deps'

export const config = loadConfig(process.env)
export const ownerDb = createDb(config.databaseOwnerUrl)
export const appDb = createDb(config.databaseUrl)

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
 * returns its id and the raw link token taken from the show-once page.
 */
export async function createRequestVia(
  app: App,
  opts: { banker?: string; customer?: string; cookie?: string } = {}
): Promise<{ requestId: string; token: string; cookie: string }> {
  const cookie = opts.cookie ?? (await signIn(app, opts.banker ?? SEED.users.alice))
  const res = await post(
    app,
    '/requests',
    [
      ['customerId', opts.customer ?? SEED.customers.dana],
      ['documentTypes', 'payslip'],
    ],
    { cookie }
  )
  const html = await res.text()
  const token = linkToken(html)
  const requestId = html.match(/href="\/requests\/([0-9a-f-]{36})"/)?.[1]
  if (res.status !== 200 || !token || !requestId)
    throw new Error(`create failed: ${res.status}`)
  return { requestId, token, cookie }
}
