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
