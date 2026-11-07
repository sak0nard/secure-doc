import { Elysia } from "elysia";
import type { Deps } from "./deps";
import { maskTokens, originAllowed, SECURITY_HEADERS } from "./web/http";
import { STYLESHEET } from "./web/render";
import { loginRoutes } from "./web/routes/login";

export function createApp(deps: Deps) {
  const started = new WeakMap<Request, number>();

  return new Elysia()
    .onRequest(({ request, set }) => {
      started.set(request, performance.now());
      Object.assign(set.headers, SECURITY_HEADERS);
      if (!originAllowed(request, deps.config.baseUrl)) {
        set.status = 403;
        return "Forbidden";
      }
    })
    .onAfterResponse(({ request, set, responseValue }) => {
      // Handlers that return a Response carry their own status; set.status only covers the rest.
      const status = responseValue instanceof Response ? responseValue.status : (set.status ?? 200);
      const ms = Math.round(performance.now() - (started.get(request) ?? performance.now()));
      deps.log(`${request.method} ${maskTokens(new URL(request.url).pathname)} ${status} ${ms}ms`);
    })
    .get("/styles.css", ({ set }) => {
      set.headers["content-type"] = "text/css; charset=utf-8";
      return STYLESHEET;
    })
    .use(loginRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
