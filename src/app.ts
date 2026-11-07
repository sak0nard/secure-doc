import { Elysia } from 'elysia'
import type { Deps } from './deps'
import { maskTokens, originAllowed, SECURITY_HEADERS } from './web/http'
import { STYLESHEET } from './web/render'
import { customerRoutes } from './web/routes/customer'
import { loginRoutes } from './web/routes/login'
import { requestRoutes } from './web/routes/requests'

export function createApp(deps: Deps) {
  const started = new WeakMap<Request, number>()

  return new Elysia()
    .onRequest(({ request, set }) => {
      started.set(request, performance.now())
      Object.assign(set.headers, SECURITY_HEADERS)
      if (!originAllowed(request, deps.config.baseUrl)) {
        set.status = 403
        return 'Forbidden'
      }
    })
    .onError(({ code, error, request, set }) => {
      if (code === 'NOT_FOUND') return
      if (code === 'VALIDATION' || code === 'PARSE') {
        set.status = 400
        return 'Bad Request'
      }
      // Never show internals (SQL, parameters, stack) to the client; keep them in the server log.
      const path = maskTokens(new URL(request.url).pathname)
      deps.log(
        `ERROR ${request.method} ${path}: ${error instanceof Error ? error.message : String(error)}`
      )
      set.status = 500
      return 'Something went wrong. Please try again.'
    })
    .onAfterResponse(({ request, set, responseValue }) => {
      // Handlers that return a Response carry their own status; set.status only covers the rest.
      const status =
        responseValue instanceof Response ? responseValue.status : (set.status ?? 200)
      const ms = Math.round(
        performance.now() - (started.get(request) ?? performance.now())
      )
      deps.log(
        `${request.method} ${maskTokens(new URL(request.url).pathname)} ${status} ${ms}ms`
      )
    })
    .get('/styles.css', ({ set }) => {
      set.headers['content-type'] = 'text/css; charset=utf-8'
      return STYLESHEET
    })
    .use(loginRoutes(deps))
    .use(customerRoutes(deps))
    .use(requestRoutes(deps))
}

export type App = ReturnType<typeof createApp>
