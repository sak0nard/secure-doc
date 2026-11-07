# Design

## Technology choices

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Bun | Fast start-up, built-in test runner, Postgres client, S3 client and crypto |
| Web framework | Elysia | Small, typed, lifecycle hooks for headers, CSRF and auth in one place |
| Pages | React JSX rendered to HTML on the server | No client app or client state. React escapes every interpolated value, which is the main XSS control |
| Validation | Zod | Every external input (forms, params, config) is parsed before use |
| Database | Postgres 18 with Drizzle ORM | Typed schema, generated SQL migrations committed to the repo, plus hand-written SQL where it matters (audit protections) |
| Object storage | RustFS locally, through the S3 API | The same code talks to AWS S3 in production |

**Alternatives considered:**
- **A React browser app with a JSON API.** It gives a smoother UI, but means two surfaces to secure and review, and adds client-side state.
- **A plain Bun server with no framework.** It has no dependencies, but escaping, cookies and routing would be hand-rolled, which a security reviewer would rightly distrust.

## Component boundaries

```
src/
  web/        HTTP only: routes, pages, cookies, security headers, CSRF check
  modules/    domain rules; each module owns its tables
    access/   sign-in sessions and (later) the single authorisation policy
  db/         schema, migrations, seed
  config.ts   validated configuration
  deps.ts     everything external (config, db, clock, logger), built once and swapped in tests
```

- Routes parse input and call module functions; they do not contain business rules.
- All time comes from `deps.now()`, so expiry rules can be tested with a fake clock.

## Data model

| Table | Holds |
| --- | --- |
| `users` | Seeded bankers and compliance officers (stands in for SSO) |
| `user_sessions` | Signed-in sessions; only the SHA-256 of the session token is stored |
| `customers` | Seeded synthetic customers and their mobile numbers (stands in for the customer master) |
| `requests` | Who asked whom for which document types, and the status (open, received, closed) |
| `upload_links` | Hash of each link token, its state, expiry and attempt counters. At most one active link per request, enforced by a unique index |
| `otp_codes` | Keyed hashes of one-time codes, with expiry |
| `customer_sessions` | Short upload sessions created after a correct code; token stored as a hash |
| `documents` | Metadata for each stored file: random storage key, detected type, SHA-256, scan status, retention date |
| `outbox` | Mock SMS messages |
| `audit_events` | Append-only, hash-chained audit log |

## HTTP hardening

These headers are on every response, including errors:
- `Referrer-Policy: no-referrer`, so link tokens never leak to other sites.
- `X-Content-Type-Options: nosniff`.
- `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'`. No inline scripts or styles, and no framing.
- `Cache-Control: no-store`, so pages showing links or documents aren't cached.

Request forgery is blocked two ways:
- Session cookies are `HttpOnly` and `SameSite=Strict`.
- Every state-changing request must carry an `Origin` header matching `BASE_URL`. Without one it gets 403.

Request logs mask customer link tokens.

## Data flow

*To be completed.*

## Security and privacy

*To be completed.*

## Key trade-offs

*To be completed.*

## Production and cloud shape

*To be completed.*
