# Chunk 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local Postgres + RustFS running from `compose.yml`, the full data model migrated and seeded, and an Elysia app that serves server-rendered pages with security headers, masked request logs, an Origin check and mock user login.

**Architecture:** One Elysia app built by `createApp(deps)`, so tests drive it with `app.handle(new Request(...))` without opening a port. All config is parsed once by a Zod schema. The whole schema from spec §5 lands now (data first), including the audit table's append-only trigger and the restricted app DB role. Later chunks add behaviour, not tables.

**Tech Stack:** Bun 1.4, Elysia 1.4, React 19 (`react-dom/server`), Zod 4, Drizzle ORM 0.45 (`drizzle-orm/bun-sql`) + drizzle-kit 0.31, Postgres 18, RustFS.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§3, §4, §5, §6.5 login/session, §6.7, §8, §9 harness)

## Global Constraints

- **Raw secrets are never stored:** raw session tokens are never stored; only `sha256` hex of them.
- **User session cookie:**
  - Name `sid`, `HttpOnly`, `SameSite=Strict`, `Path=/`.
  - `Secure` when `BASE_URL` starts with `https://`.
  - Session lifetime is 8h.
- **Headers on every response:**
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'`
  - `Cache-Control: no-store`
- **Origin check:** every non-GET/HEAD request must carry `Origin` equal to the origin of `BASE_URL`. If it's missing or mismatched, respond 403.
- **Request log line:** method, masked path, status, duration in ms. `/u/<anything>` is logged as `/u/****`, except the fixed path `/u/upload`.
- **App DB role:** `secure_doc_app`. It has `SELECT, INSERT, UPDATE, DELETE` on all tables, but only `SELECT, INSERT` on `audit_events`.
- **`audit_events` trigger:** raises on `UPDATE` and `DELETE`.
- **IDs and timestamps:** IDs are UUIDv4 via `gen_random_uuid()`, except `audit_events.seq` (`bigserial`). All timestamps are `timestamptz`.
- **Config:**
  - `RETENTION_DAYS` defaults to 2555.
  - `OTP_PEPPER` must be at least 32 characters.
  - The app exits on invalid config with a message naming each bad variable.
- **No production code without a failing test first** (CLAUDE.md, software-design-principles).
- **Wording:** documents never mention time limits.

## Review Focus

1. **A garbage, tampered or expired `sid` cookie** must be treated as signed out (redirect to `/login`), never a 500. *Task 4 test.*
2. **`POST /login` with a non-UUID or unknown user id** returns 400 and sets no cookie. *Task 4 test.*
3. **A POST without an `Origin` header** (some clients strip it), including `/logout`, is refused with 403. *Task 3 test.*
4. **Missing or short env vars** stop startup with a message listing every bad variable, not just the first. *Task 1 test.*
5. **Running the seed twice** leaves the same rows (idempotent) and does not fail. *Task 2 test.*

---

## File Structure

```
compose.yml                         Postgres 18 + RustFS
docker/postgres/init.sh             creates app role + test database on first boot
.env.example / .env.test            documented local settings (.env.test committed: local-only dummy values)
bunfig.toml                         test preload
drizzle.config.ts
src/config.ts                       Zod config schema → Config
src/db/schema.ts                    every table + enum from spec §5 and §6.6
src/db/client.ts                    createDb(url) → Db
src/db/migrate.ts                   runMigrations(ownerUrl); CLI entry
src/db/seed.ts                      SEED ids + seed(db); CLI entry
src/db/migrations/                  drizzle-kit output + custom audit_protections.sql
src/deps.ts                         Deps type + buildDeps(config)
src/app.ts                          createApp(deps): Elysia
src/server.ts                       entry: loadConfig → buildDeps → createApp → listen
src/web/render.tsx                  page(element, init?) → Response; <Layout>
src/web/http.ts                     securityHeaders, maskTokens, checkOrigin, sourceIp
src/web/routes/login.tsx            GET/POST /login, POST /logout, GET /
src/modules/access/sessions.ts      user session create/resolve/end
tests/setup.ts                      preload: migrate test DB once
tests/helpers.ts                    resetDb(), ownerDb, testApp(), post()/get() helpers
tests/*.test.ts
```

---

### Task 1: Local services and config

**Files:**
- Create: `compose.yml`, `docker/postgres/init.sh`, `.env.example`, `.env.test`, `src/config.ts`
- Test: `tests/config.test.ts`
- Modify: `package.json` (add deps: `elysia`, `zod`, `drizzle-orm`, `react`, `react-dom`; dev: `drizzle-kit`, `@types/react`, `@types/react-dom`; scripts below)

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): Config`, which throws `ConfigError` (message lists every invalid key).
  - `type Config = { databaseUrl; databaseOwnerUrl; s3: { endpoint; bucket; accessKeyId; secretAccessKey; region }; baseUrl: URL; otpPepper; retentionDays: number; trustProxy: boolean; mockOutboxEnabled: boolean; port: number }`

**Compose details:**
- `postgres:18`:
  - `POSTGRES_USER=secure_doc_owner`, `POSTGRES_DB=secure_doc`, port 5432.
  - Mounts `docker/postgres/init.sh` into `/docker-entrypoint-initdb.d/`.
  - Named volume, healthcheck `pg_isready`.
- `rustfs/rustfs`:
  - Pin the current stable tag at implementation time.
  - API on 9000, console on 9001, access/secret keys from env, named volume.
- `init.sh` creates:
  - Role `secure_doc_app LOGIN PASSWORD '$APP_DB_PASSWORD'`.
  - Database `secure_doc_test` owned by `secure_doc_owner`.

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`:

```ts
const valid = { DATABASE_URL: "postgres://a", DATABASE_OWNER_URL: "postgres://o", S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "docs", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_REGION: "ap-southeast-2",
  BASE_URL: "http://localhost:3000", OTP_PEPPER: "x".repeat(32) };
test("defaults retention to 2555 days, proxy trust off, outbox off, port 3000", () => {
  const c = loadConfig(valid);
  expect([c.retentionDays, c.trustProxy, c.mockOutboxEnabled, c.port]).toEqual([2555, false, false, 3000]);
});
test("rejects a pepper shorter than 32 characters", () => {
  expect(() => loadConfig({ ...valid, OTP_PEPPER: "short" })).toThrow(/OTP_PEPPER/);
});
test("names every invalid variable at once", () => {
  const { DATABASE_URL, BASE_URL, ...rest } = valid;
  expect(() => loadConfig(rest)).toThrow(/DATABASE_URL[\s\S]*BASE_URL|BASE_URL[\s\S]*DATABASE_URL/);
});
test("parses booleans strictly", () => {
  expect(loadConfig({ ...valid, TRUST_PROXY: "true", MOCK_OUTBOX_ENABLED: "true" }).trustProxy).toBe(true);
  expect(() => loadConfig({ ...valid, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
});
```

- [ ] **Step 2: Run** `bun test tests/config.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `loadConfig` in `src/config.ts`** with one `z.object` over the env, using `safeParse`. On failure, throw `ConfigError` whose message joins each issue as `KEY: reason`. Booleans accept only `"true"` or `"false"`.
- [ ] **Step 4: Run** `bun test tests/config.test.ts`. Expected: PASS.
- [ ] **Step 5: Bring up services.**
  - Write `compose.yml`, `init.sh`, `.env.example` and `.env.test`. `.env.test` points `DATABASE_URL` at `secure_doc_test` as `secure_doc_app`, and has `MOCK_OUTBOX_ENABLED=true`.
  - Run `docker compose up -d --wait`. Expected: both services `healthy`/`running`.
  - Run `docker compose exec postgres psql -U secure_doc_owner -l`. Expected: it lists `secure_doc_test`.
- [ ] **Step 6: Add scripts** to `package.json`: `"services": "docker compose up -d --wait"`, `"db:migrate": "bun src/db/migrate.ts"`, `"db:seed": "bun src/db/seed.ts"`, `"dev": "bun --watch src/server.ts"`, `"test": "bun test"`, and keep `typecheck`.
- [ ] **Step 7: Commit**: `git add -A && git commit -m "feat: local services and validated config"`

---

### Task 2: Schema, migrations, seed, test harness

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/seed.ts`, `drizzle.config.ts`, `src/db/migrations/*` (generated + `audit_protections` custom), `bunfig.toml`, `tests/setup.ts`, `tests/helpers.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: `loadConfig`.
- Produces:
  - `createDb(url: string): Db` (a Drizzle `bun-sql` instance; `type Db`, and `type Tx` for a transaction handle).
  - `runMigrations(ownerUrl: string): Promise<void>`.
  - `seed(db: Db): Promise<void>`.
  - `SEED = { users: { alice, bob, carol }, customers: { dana, eli, fay } }`: fixed UUID strings.
  - Schema exports: `users, customers, requests, uploadLinks, otpCodes, customerSessions, userSessions, documents, outbox, auditEvents`, plus enums `role, requestStatus, linkState, documentType, detectedType, scanStatus, auditOutcome, actorType`.
  - Test helpers: `resetDb(): Promise<void>` (truncate every table as owner, restart identities, re-seed), `ownerDb: Db`, `appDb: Db`.

**Schema notes** (columns exactly as spec §5/§6.6, plus):
- `user_sessions`: `id, user_id → users, token_hash unique, expires_at, ended_at`.
- `upload_links`:
  - Partial unique index on `(request_id) WHERE state = 'active'`.
  - `failed_code_attempts` and `codes_sent` default 0.
- `audit_events.request_id` has an index. `hash` and `prev_hash` are `char(64)`.
- `documents.request_id` → `requests`.
- Seed customers have E.164 mobiles in the `+61 4xx` range, clearly synthetic.

**Custom migration `audit_protections`** (`drizzle-kit generate --custom --name audit_protections`):
- A trigger function raising `'audit_events is append-only'` `BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW`.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO secure_doc_app`.
- `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO secure_doc_app`.
- `REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM secure_doc_app`.

- [ ] **Step 1: Write failing tests** in `tests/db.test.ts`:
  - `"app role can insert and read audit events"`: as `appDb`, insert one `audit_events` row → select returns it.
  - `"app role cannot update or delete audit events"`: as `appDb`, `update(auditEvents).set({outcome:"failure"})` rejects; `delete(auditEvents)` rejects.
  - `"trigger blocks even the owner from editing audit events"`: as `ownerDb`, the update rejects with `/append-only/`.
  - `"only one active link per request"`: insert a request (as alice, for dana), two `active` links → the second rejects. An `active` link plus a `revoked` one → OK.
  - `"seed is idempotent"`: call `seed(appDb)` twice → `users` count 3, `customers` count 3.
  - `"seeded roles"`: alice and bob are `banker`; carol is `compliance`.
- [ ] **Step 2: Run** `bun test tests/db.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the schema, `createDb`, `runMigrations` (`drizzle-orm/bun-sql/migrator`, as owner), and `seed` (fixed UUIDs, `onConflictDoNothing`). Generate migrations with `bunx drizzle-kit generate`, then add the custom migration. `tests/setup.ts` (preloaded via `bunfig.toml` `[test] preload`) calls `runMigrations(DATABASE_OWNER_URL)`. `beforeEach(resetDb)` lives in each DB-touching test file.
- [ ] **Step 4: Run** `bun test`. Expected: all PASS. Also run `bun run db:migrate && bun run db:seed` against `.env` (dev DB) and expect it to exit 0 twice in a row.
- [ ] **Step 5: Commit**: `git commit -m "feat: data model, append-only audit table, seed"`

---

### Task 3: App skeleton: rendering, headers, logging, Origin check

**Files:**
- Create: `src/deps.ts`, `src/app.ts`, `src/server.ts`, `src/web/render.tsx`, `src/web/http.ts`
- Test: `tests/http.test.ts`, `tests/helpers.ts` (extend)

**Interfaces:**
- Consumes: `Config`, `createDb`.
- Produces:
  - `type Deps = { config: Config; db: Db; now: () => Date; log: (line: string) => void }`; `buildDeps(config): Deps`.
  - `createApp(deps: Deps): Elysia`.
  - `page(el: ReactElement, init?: { status?: number }): Response` (renders `<!doctype html>` + `renderToString(el)`, `text/html; charset=utf-8`).
  - `<Layout title>` component.
  - `maskTokens(path: string): string`.
  - `sourceIp(request, server, trustProxy): string`.
  - Test helpers: `testApp(overrides?: Partial<Deps>)` returns `{ app, logs: string[] }`; `get(app, path, {cookie?})`; `post(app, path, form: Record<string,string>, {cookie?, origin?})`. `post` sets `Origin` to `BASE_URL` unless `origin` is passed (`null` = omit).

- [ ] **Step 1: Write failing tests** in `tests/http.test.ts`:

```ts
test("security headers on every response, including 404", async () => {
  for (const path of ["/login", "/does-not-exist"]) {
    const res = await get(testApp().app, path);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors 'none'; form-action 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
});
test("maskTokens hides link tokens but keeps fixed customer paths", () => {
  expect(maskTokens("/u/AbC-123_xyz")).toBe("/u/****");
  expect(maskTokens("/u/AbC-123_xyz/verify")).toBe("/u/****/verify");
  expect(maskTokens("/u/upload")).toBe("/u/upload");
  expect(maskTokens("/requests/1")).toBe("/requests/1");
});
test("request log line never contains the raw token", async () => {
  const { app, logs } = testApp();
  await get(app, "/u/SECRETTOKENVALUE");
  expect(logs.join("\n")).not.toContain("SECRETTOKENVALUE");
  expect(logs.some(l => l.includes("GET /u/**** "))).toBe(true);
});
test("POST without Origin is refused", async () => {
  expect((await post(testApp().app, "/logout", {}, { origin: null })).status).toBe(403);
});
test("POST from a foreign Origin is refused", async () => {
  expect((await post(testApp().app, "/logout", {}, { origin: "https://evil.example" })).status).toBe(403);
});
```

- [ ] **Step 2: Run** `bun test tests/http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pieces above. Apply headers in one global hook that also covers 404 and error responses; if Elysia's `set.headers` doesn't reach returned `Response` objects, set them in `mapResponse`/`onAfterHandle` (the test is the contract). The Origin check is an `onBeforeHandle` global guard. Log from an `onAfterResponse` hook through `deps.log`. The `server.ts` entry exits with code 1 and prints `ConfigError.message` on bad config.
- [ ] **Step 4: Run** `bun test`. Expected: PASS. Then `bun run dev` and `curl -sI localhost:3000/login`. Expected: the four headers.
- [ ] **Step 5: Commit**: `git commit -m "feat: app skeleton with security headers, masked logs, origin check"`

---

### Task 4: Mock login and user sessions

**Files:**
- Create: `src/modules/access/sessions.ts`, `src/web/routes/login.tsx`
- Modify: `src/app.ts` (mount routes; user-session resolver)
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes: `Deps`, `SEED`, `page`, `Layout`, `post`/`get` helpers.
- Produces:
  - `createUserSession(db: Db | Tx, userId: string, now: Date): Promise<{ token: string; expiresAt: Date }>`. The token is 32 random bytes, base64url; only its sha256 hex is stored.
  - `resolveUserSession(db, token: string | undefined, now: Date): Promise<User | null>`.
  - `endUserSession(db, token, now): Promise<void>`.
  - `type User = { id: string; name: string; role: "banker" | "compliance" }`.
  - Elysia: a `requireUser` guard/derive giving handlers `user: User`. With no valid session it responds `303 Location: /login`. Later chunks mount signed-in routes under it.
  - `sha256Hex(input: string | Uint8Array): string` in `src/modules/access/crypto.ts` (shared by later chunks).

**Routes:**
- `GET /login`: a form with one radio button per user (name + role) and a submit.
- `POST /login` (`userId`, validated as a Zod UUID that must exist): sets `sid` and responds `303 /`.
- `POST /logout`: ends the session, clears the cookie, `303 /login`.
- `GET /` (signed in): placeholder "Signed in as {name} ({role})" plus a logout form. Chunk 3 replaces the body with the request list.

- [ ] **Step 1: Write failing tests** in `tests/login.test.ts`:
  - `"login sets a hardened session cookie and lands on home"`: `post /login {userId: SEED.users.alice}` → 303 to `/`. `set-cookie` contains `sid=`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and no `Secure` (BASE_URL is http). `get / ` with that cookie → 200, body contains `Alice Banker`.
  - `"session token is stored only as a hash"`: after login, the `user_sessions.token_hash` equals `sha256Hex(cookieValue)`, and no column contains `cookieValue`.
  - `"home without a session redirects to login"`: `get /` → 303 `/login`.
  - `"garbage or unknown cookie is treated as signed out"`: `sid=not-a-token` → 303 `/login` (not 500).
  - `"expired session is refused"`: log in via `testApp({ now })`, then advance the clock 8h + 1s → 303 `/login`.
  - `"logout ends the session"`: log in, `post /logout` with the cookie → 303 `/login`. Reusing the old cookie on `/` → 303 `/login`.
  - `"login rejects unknown or malformed user ids"`: `userId: "nope"` → 400; a random UUID → 400. Neither response has `set-cookie`.
  - `"user names are escaped in pages"`: insert a user named `<script>x</script>` and log in. The body contains `&lt;script&gt;` and not `<script>x`.
- [ ] **Step 2: Run** `bun test tests/login.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the sessions module and routes. Use the clock from `deps.now()` everywhere (never `new Date()` in modules). Set `Secure` when `config.baseUrl.protocol === "https:"`.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no type errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: mock user login with hashed server-side sessions"`

Login and logout audit events are added in chunk 2, once `audit.append` exists.

---

### Task 5: Run it end to end and start the evidence docs

**Files:**
- Modify: `README.md`
- Create: `evidence/operate.md`, `evidence/design.md`

- [ ] **Step 1: Fresh-clone check.**
  - Run `docker compose down -v && bun run services && cp .env.example .env && bun run db:migrate && bun run db:seed && bun run dev`.
  - Open `/login` and sign in as Carol. Expected: the home page shows "Carol Compliance (compliance)".
- [ ] **Step 2: README:** replace the bun-init text with a short "Run locally" section (the commands above, plus `bun test`).
- [ ] **Step 3: `evidence/operate.md`** first sections:
  - How to run (as above).
  - Configuration: each env var, its meaning and default.
  - Secrets approach: `.env` locally (git-ignored); `.env.test` holds local-only dummy values and is committed deliberately; production uses a secrets manager.
  - Database roles: an owner for migrations, and the `secure_doc_app` role for the app, which cannot update or delete audit rows.
  - Logs: one line per request, tokens masked.
- [ ] **Step 4: `evidence/design.md`** first sections:
  - Technology choices and why (from spec §2–§3).
  - Component boundaries (spec §4).
  - The data model summary.
  - HTTP hardening (§6.7).
  
  Mark the later sections "to be completed" headings only.
- [ ] **Step 5: Commit**: `git commit -m "docs: run instructions and initial evidence"`
