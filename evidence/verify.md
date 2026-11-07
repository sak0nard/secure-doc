# Verification

## How to run the checks

```bash
bun run services     # Postgres and RustFS in Docker
bun test             # migrates the test database, then runs every test
bun run typecheck
```

The tests run against real Postgres and RustFS in Docker, not in-memory fakes. They drive the app through its HTTP interface (`app.handle(new Request(...))`) without opening a port. Each database test starts from an emptied, re-seeded database.

## Latest results

| Check               | Result                                    |
| ------------------- | ----------------------------------------- |
| `bun test`          | 46 pass, 0 fail (5 files, 104 assertions) |
| `bun run typecheck` | No type errors                            |

## What the tests prove so far

**Configuration** (`tests/config.test.ts`)

- Defaults: 2555-day retention, proxy headers not trusted, mock outbox off, port 3000.
- A one-time-code secret shorter than 32 characters is rejected.
- Every invalid variable is reported at once, not just the first.
- Booleans accept only `true` or `false`.

**Database protections** (`tests/db.test.ts`)

- The app's database role can insert and read audit events.
- The app's role is denied updates and deletes on audit events (Postgres reports "permission denied").
- A trigger blocks even the owner from editing or deleting audit events.
- A request can have only one active upload link; revoked links don't count.
- Seeding twice leaves the same rows; seeded roles are correct.

**HTTP hardening** (`tests/http.test.ts`)

- The four security headers are on every response, including 404s and errors.
- Link tokens are masked in request logs.
- POSTs without an `Origin` header, or from another origin, are refused with 403.
- Unexpected errors return a generic 500 page. The details go to the server log, never to the client.
- The client IP ignores `X-Forwarded-For` unless the proxy is trusted. When it is trusted, the IP comes from the entry the proxy appended, not from a value the client supplied.

**Audit chain** (`tests/audit.test.ts`)

- Canonical JSON sorts keys at every depth.
- An empty log verifies.
- The first event links to the genesis hash (64 zeros).
- Each event links to the one before, and the chain verifies.
- `detail` with keys in any order, nested objects and numbers still verifies after Postgres stores it as `jsonb`.
- `detail` holding values with a JSON form, such as dates, still verifies.
- 25 concurrent appends produce one unbroken chain, never a fork.
- An action that fails after writing its audit event leaves no event.
- Editing an event is detected at that event (AC-9).
- Editing an event and recomputing its hash is detected at the next event (AC-9).
- Deleting an event is detected at the next event (AC-9).

**Sign-in and sessions** (`tests/login.test.ts`)

- Sign-in sets an `HttpOnly`, `SameSite=Strict` cookie and lands on the home page.
- Only the SHA-256 of the session token is stored.
- Missing, garbage, malformed or expired session cookies are treated as signed out, never as an error.
- Sign-out ends the session server-side, so the old cookie stops working.
- Unknown or malformed user ids are rejected with 400 and no cookie.
- User-supplied text is escaped in pages.
- Request logs record the real status of redirects.
- Sign-in, failed sign-in and sign-out are each audited. A failed sign-in creates no session, and a malformed user id is recorded as `invalid`.
- Signing out without a session writes no event.
- Behind a trusted proxy, the audit event records the client IP the proxy saw.
- The chain stays intact across sign-in activity.

## Acceptance criteria

| Acceptance criterion                                                     | Status                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A banker creates a request and sees the upload link exactly once         | Not yet built                                                                                                                                               |
| A valid link plus the correct code lets the customer upload a PDF        | Not yet built                                                                                                                                               |
| A renamed executable with a .pdf extension is rejected                   | Not yet built                                                                                                                                               |
| A file over 10 MB is rejected                                            | Not yet built                                                                                                                                               |
| A used, expired or reissued link is refused                              | Not yet built (the one-active-link rule is enforced and tested)                                                                                             |
| Five wrong codes lock the link and log a suspicious-activity event       | Not yet built                                                                                                                                               |
| Another banker gets access denied, and the attempt is logged             | Not yet built                                                                                                                                               |
| Compliance can view the document and the full audit trail                | Not yet built                                                                                                                                               |
| Editing or deleting an audit event breaks the hash chain and is detected | Met: "AC-9: editing an audit event is detected", "AC-9: editing an event and recomputing its hash is detected", "AC-9: deleting an audit event is detected" |

Each criterion will get its own named test.

## Known gaps

- **Audit tail truncation:** deleting the newest audit events cannot be detected by the hash chain alone. Production fix: periodically anchor the latest hash in write-once storage.
- **Future tables aren't automatically granted** to the app role; every table exists today, but a later table would need its own grant.
- **Log timing:** request log lines are written just after the response is sent, so two tests wait 5 ms before checking. This could be flaky on a heavily loaded machine.
- **Not tested:** load, availability, accessibility (WCAG 2.1 AA), and behaviour behind a real TLS proxy.

## Accepted risks

- **The database owner can empty or rewrite the audit table.** The row trigger does not block TRUNCATE, and the owner can disable the trigger. The app's role can do neither. This is accepted: the owner role is held only by the migration pipeline, not by the running app or day-to-day staff, and the production audit anchor (above) would reveal it.

## Local versus pipeline

| Check                                  | Locally                            | In a pull request pipeline                                                                                 |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Type check                             | `bun run typecheck`                | Yes                                                                                                        |
| Unit and integration tests             | `bun test` against Docker services | Yes, with Postgres and RustFS as job services                                                              |
| Migrations apply cleanly from empty    | Implicit in `bun test`             | Yes, plus a check that the generated migrations match the schema (`drizzle-kit generate` produces no diff) |
| Dependency vulnerability audit         | Optional                           | Yes, failing on high severity                                                                              |
| Secret scanning                        | Optional                           | Yes, on every push                                                                                         |
| Static analysis for security (SAST)    | —                                  | Yes                                                                                                        |
| Container image scan                   | —                                  | Yes, on the release image                                                                                  |
| Browser smoke test of the main journey | Optional (Playwright)              | Yes, against a deployed preview                                                                            |
