import { Elysia } from 'elysia'
import { z } from 'zod'
import type { Deps } from '../../deps'
import {
  createUserSession,
  endUserSession,
  resolveUserSession,
  USER_SESSION_TTL_MS,
} from '../../modules/access/sessions'
import { findUser, listUsers } from '../../modules/access/users'
import { appendAudit } from '../../modules/audit/audit'
import { sourceIp } from '../http'
import { Layout, page } from '../render'
import { readCookie, SESSION_COOKIE } from '../session'

const LoginForm = z.object({ userId: z.uuid() })

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location })
  if (cookie) headers.set('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

export function loginRoutes(deps: Deps) {
  const secure = deps.config.baseUrl.protocol === 'https:' ? '; Secure' : ''
  const sessionCookie = (value: string, maxAgeSeconds: number) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`

  return new Elysia()
    .get('/login', async () => {
      const all = await listUsers(deps.db)
      return page(
        <Layout title="Sign in">
          <h1>Sign in</h1>
          <p>Mock sign-in for the demo. Production uses the bank's single sign-on.</p>
          <form method="post" action="/login">
            {all.map((u, i) => (
              <label key={u.id}>
                <input
                  type="radio"
                  name="userId"
                  value={u.id}
                  required
                  defaultChecked={i === 0}
                />{' '}
                {u.name} ({u.role})
              </label>
            ))}
            <button type="submit">Sign in</button>
          </form>
        </Layout>
      )
    })
    .post('/login', async ({ body, request, server }) => {
      const ip = sourceIp(request, server, deps.config.trustProxy)
      const parsed = LoginForm.safeParse(body)
      const user = parsed.success ? await findUser(deps.db, parsed.data.userId) : null
      if (!user) {
        const targetId = parsed.success ? parsed.data.userId : 'invalid'
        await deps.db.transaction((tx) =>
          appendAudit(tx, {
            at: deps.now(),
            actor: { type: 'user', id: 'anonymous' },
            action: 'user.sign_in_failed',
            target: { type: 'user', id: targetId },
            sourceIp: ip,
            outcome: 'failure',
          })
        )
        return page(
          <Layout title="Sign in">
            <p>
              Unknown user. <a href="/login">Try again</a>.
            </p>
          </Layout>,
          { status: 400 }
        )
      }
      const { token } = await deps.db.transaction(async (tx) => {
        const now = deps.now()
        const session = await createUserSession(tx, user.id, now)
        await appendAudit(tx, {
          at: now,
          actor: { type: 'user', id: user.id },
          action: 'user.signed_in',
          target: { type: 'user', id: user.id },
          sourceIp: ip,
          outcome: 'success',
        })
        return session
      })
      return redirect('/', sessionCookie(token, USER_SESSION_TTL_MS / 1000))
    })
    .post('/logout', async ({ request, server }) => {
      const ip = sourceIp(request, server, deps.config.trustProxy)
      const token = readCookie(request, SESSION_COOKIE)
      await deps.db.transaction(async (tx) => {
        const now = deps.now()
        const user = await resolveUserSession(tx, token, now)
        await endUserSession(tx, token, now)
        if (!user) return
        await appendAudit(tx, {
          at: now,
          actor: { type: 'user', id: user.id },
          action: 'user.signed_out',
          target: { type: 'user', id: user.id },
          sourceIp: ip,
          outcome: 'success',
        })
      })
      return redirect('/login', sessionCookie('', 0))
    })
}
