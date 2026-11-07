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
    .onAfterResponse(({ request, set }) => {
      const ms = Math.round(performance.now() - (started.get(request) ?? performance.now()));
      deps.log(`${request.method} ${maskTokens(new URL(request.url).pathname)} ${set.status ?? 200} ${ms}ms`);
    })
    .get("/styles.css", ({ set }) => {
      set.headers["content-type"] = "text/css; charset=utf-8";
      return STYLESHEET;
    })
    .use(loginRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
