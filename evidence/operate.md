# Operating the portal

## Run locally

Requires Bun 1.4+ and Docker.

```bash
bun install
cp .env.example .env
bun run services      # docker compose up -d --wait
bun run db:migrate    # applies src/db/migrations as the owner role; safe to re-run
bun run db:seed       # synthetic users and customers; safe to re-run
bun run dev           # http://localhost:3000, restarts on change
```

| Service | Address | Notes |
| --- | --- | --- |
| App | `http://localhost:3000` | `bun run start` for a run without file watching |
| Postgres 18 | `localhost:5433` | Host port defaults to 5433 to avoid clashing with other local Postgres instances. Override with `PG_HOST_PORT` |
| RustFS (S3 API) | `http://localhost:9000` | S3-compatible object storage |
| RustFS console | `http://localhost:9001` | Browse stored objects |

To start from empty, run `docker compose down -v`, then repeat the steps above.

## Configuration

All settings come from environment variables. The app parses them once at startup. If any are missing or invalid, it prints every problem and exits with code 1 instead of starting half-configured.

| Variable | Meaning | Default |
| --- | --- | --- |
| `DATABASE_URL` | App connection, as the restricted `secure_doc_app` role | required |
| `DATABASE_OWNER_URL` | Owner connection, for migrations and seed only | required |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` | Object storage location | required |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage credentials | required |
| `BASE_URL` | Public origin. Used for links and the CSRF Origin check; `https://` turns on `Secure` cookies | required |
| `OTP_PEPPER` | Secret key for one-time-code hashes; at least 32 characters | required |
| `RETENTION_DAYS` | Retention period recorded on each uploaded file | 2555 (about 7 years) |
| `TRUST_PROXY` | Take the client IP from `X-Forwarded-For`. Enable only behind a trusted proxy | `false` |
| `MOCK_OUTBOX_ENABLED` | Show mock SMS messages at `/dev/outbox` | `false` |
| `PORT` | Listen port | 3000 |

## Secrets

- **Local:** `.env`, git-ignored. `.env.example` documents every variable with placeholder values.
- **Tests:** `.env.test` is committed on purpose. It holds only local placeholder values for the throwaway test database, and `bun test` loads it automatically.
- **Production:** values come from a secrets manager, injected as environment variables. Nothing secret is baked into images.

## Database roles

| Role | Used by | Rights |
| --- | --- | --- |
| `secure_doc_owner` | Migrations, seed, tests that simulate a privileged attacker | Owns the schema |
| `secure_doc_app` | The running app | Read and write on all tables, except `audit_events`, where it can only insert and read |

A trigger also rejects any `UPDATE` or `DELETE` on `audit_events`, even from the owner, unless it is deliberately disabled.

## Logs

- The app writes one line per request to stdout: `METHOD path status duration`, for example `POST /login 303 12ms`.
- Customer link tokens are masked: `/u/<token>` is logged as `/u/****`.
- Who did what is recorded in the audit log, not in request logs.
- Unexpected errors are logged as `ERROR METHOD path: message`, with the path masked the same way, and the client gets a generic 500 page.

## Status

- The signed-in home page shows who you are and your role.
- Request status (Open, Received, Closed, and Expired worked out from the link) will appear in the request list.
- `/dev/outbox` (only with `MOCK_OUTBOX_ENABLED=true`) will show mock SMS messages.

## Failure modes

| Failure | What happens | What to do |
| --- | --- | --- |
| Invalid or missing configuration | The app refuses to start and lists every bad variable | Fix the environment and restart |
| Database unreachable | Requests fail with a generic 500 page; the error is logged with details | Restore the database; the app recovers without a restart |
| Object storage unreachable | *Designed:* uploads are refused with a "try again" message and nothing is half-stored. Downloads fail with a generic error | Restore storage; customers retry within their session or the banker reissues |
| SMS provider down | *Designed:* the code send fails and the customer is asked to try again. The attempt still counts toward the resend limit only if a message was actually sent | Restore the provider |
| Malware scanner down | *Designed:* fail closed. Files stay pending and cannot be viewed until scanned | Restore the scanner, then rescan pending files |
| Crash between storing a file and committing its record | An orphan object with no database row. It can't be reached, because every read goes through a database row | A periodic sweep removes objects with no row (production) |
| Audit chain broken | The compliance audit page reports the first broken event | Treat as a security incident; compare with the anchored hash |

## Rollback and degrade

- **App:** releases are immutable container images, so rolling back means redeploying the previous image.
- **Database migrations:** these only move forward. Schema changes follow expand-then-contract: add new columns and tables first, deploy code that uses them, and remove old ones in a later release. That way the previous app version keeps working after a migration and a rollback needs no down-migration.
- **Degrade, don't fail open:** if the scanner, SMS or storage is unavailable, the affected step is refused. Access checks, audit writes and file validation are never skipped to keep things running. An action whose audit event can't be written does not happen.

## Local to cloud

- **Same code, different adapters:** S3 instead of RustFS, an SMS provider instead of the outbox, OIDC instead of mock sign-in, and a real scanner. Only the startup wiring changes.
- **Configuration:** the same variables, supplied from Secrets Manager. `BASE_URL` becomes the `https://` origin, which turns on `Secure` cookies. `TRUST_PROXY=true` sits behind the load balancer. `MOCK_OUTBOX_ENABLED=false`.
- **Database roles:** the migration pipeline holds the owner role. The running app uses only the restricted role, and nobody signs in as owner day to day.
- **Hosting region:** an Australian region, for documents and audit data alike.
