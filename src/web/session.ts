import { Elysia } from 'elysia'
import type { Deps } from '../deps'
import { resolveUserSession } from '../modules/access/sessions'

export const SESSION_COOKIE = 'sid'

/** Reads the session cookie straight from the header so malformed values can never throw. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=') || undefined
  }
  return undefined
}

/** Guard for signed-in pages: gives handlers `user`, or redirects to /login. */
export function requireUser(deps: Deps) {
  return new Elysia({ name: 'require-user' })
    .resolve({ as: 'scoped' }, async ({ request }) => ({
      user: await resolveUserSession(
        deps.db,
        readCookie(request, SESSION_COOKIE),
        deps.now()
      ),
    }))
    .onBeforeHandle({ as: 'scoped' }, ({ user, set }) => {
      if (!user) {
        set.status = 303
        set.headers.location = '/login'
        return ''
      }
    })
}
