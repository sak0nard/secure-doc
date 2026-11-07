# Operating the portal

## Run locally

Requires Bun 1.4+ and Docker.

```bash
bun install
cp .env.example .env
bun run services      # Postgres and RustFS (waits until ready), then creates the buckets
bun run db:migrate    # applies src/db/migrations as the owner role; safe to re-run
bun run db:seed       # synthetic users and customers; safe to re-run
bun run dev           # http://localhost:3000, restarts on change
```

| Service         | Address                 | Notes                                                                                                          |
| --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| App             | `http://localhost:3000` | `bun run start` for a run without file watching                                                                |
| Postgres 18     | `localhost:5433`        | Host port defaults to 5433 to avoid clashing with other local Postgres instances. Override with `PG_HOST_PORT` |
| RustFS (S3 API) | `http://localhost:9000` | S3-compatible object storage                                                                                   |
| RustFS console  | `http://localhost:9001` | Browse stored objects                                                                                          |

To start from empty, run `docker compose down -v`, then repeat the steps above.

## Storage

- **Buckets:** `secure-doc` (the app) and `secure-doc-test` (the tests). The compose job `createbuckets` creates both with the AWS CLI and exits; it skips a bucket that already exists, so it is safe to re-run with `docker compose run --rm createbuckets`. The app never creates buckets (Bun's S3 client cannot), so a missing bucket shows up as a failed upload.
- **Browsing objects:** the RustFS console at `http://localhost:9001`, signed in with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Objects are named `documents/<random UUID>`; the `documents` table maps each key to its request, type and original file name.
- **Production:** an S3 bucket per environment in ap-southeast-2, with SSE-KMS, public access blocked, and access only from the app's role. The bucket is created by infrastructure code, not by the app.

## Configuration

All settings come from environment variables. The app parses them once at startup. If any are missing or invalid, it prints every problem and exits with code 1 instead of starting half-configured.

| Variable                                   | Meaning                                                                                       | Default              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------- |
| `DATABASE_URL`                             | App connection, as the restricted `secure_doc_app` role                                       | required             |
| `DATABASE_OWNER_URL`                       | Owner connection, for migrations and seed only                                                | required             |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`    | Object storage location                                                                       | required             |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage credentials                                                                    | required             |
| `BASE_URL`                                 | Public origin. Used for links and the CSRF Origin check; `https://` turns on `Secure` cookies | required             |
| `OTP_PEPPER`                               | Secret key for one-time-code hashes; at least 32 characters                                   | required             |
| `RETENTION_DAYS`                           | Retention period recorded on each uploaded file                                               | 2555 (about 7 years) |
| `TRUST_PROXY`                              | Take the client IP from `X-Forwarded-For`. Enable only behind a trusted proxy                 | `false`              |
| `MOCK_OUTBOX_ENABLED`                      | Show mock SMS messages at `/dev/outbox`                                                       | `false`              |
| `PORT`                                     | Listen port                                                                                   | 3000                 |

## Secrets

- **Local:** `.env`, git-ignored. `.env.example` documents every variable with placeholder values.
- **Tests:** `.env.test` is committed on purpose. It holds only local placeholder values for the throwaway test database, and `bun test` loads it automatically.
- **Production:** values come from a secrets manager, injected as environment variables. Nothing secret is baked into images.

## Database roles

| Role               | Used by                                                     | Rights                                                                                 |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `secure_doc_owner` | Migrations, seed, tests that simulate a privileged attacker | Owns the schema                                                                        |
| `secure_doc_app`   | The running app                                             | Read and write on all tables, except `audit_events`, where it can only insert and read |

A trigger also rejects any `UPDATE` or `DELETE` on `audit_events`, even from the owner, unless it is deliberately disabled.

## Logs

- The app writes one line per request to stdout: `METHOD path status duration`, for example `POST /login 303 12ms`.
- Customer link tokens are masked: `/u/<token>` is logged as `/u/****`.
- Who did what is recorded in the audit log (`audit_events`), not in request logs. Sign-in, request and link changes, request views, refused links, one-time codes, uploads, downloads, audit-trail views and denied access are audited. To read one request's events in order:

  ```bash
  psql "$DATABASE_URL" -c "select seq, at, actor_type, actor_id, action, outcome, source_ip
    from audit_events where request_id = '<request id>' order by seq"
  ```

- Unexpected errors are logged as `ERROR METHOD path: message`, with the path masked the same way, and the client gets a generic 500 page.
- A document whose stored object is missing is logged as `ERROR GET /documents/<id>: stored object is missing`; the user gets a 404 "This document isn't available." Check storage for the key in that document's row.

## Status

- The signed-in home page shows who you are, your role, and the requests you may see: a banker sees their own, compliance sees all.
- Each request shows one of these labels:

| Label       | Meaning                                                                    | What the banker does                                                         |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Open        | The customer's link is usable and nothing has been submitted yet           | Wait, or remind the customer through the usual channel                       |
| Expired     | Still open, but the link has passed its expiry                             | Reissue the link from the request page and send the new link to the customer |
| Link locked | Shown with Open: too many wrong codes were entered, so the link was locked | Check with the customer, then reissue                                        |
| Received    | The customer has submitted documents                                       | Review the documents, then close the request                                 |
| Closed      | Finished                                                                   | Nothing                                                                      |

- A reissued link replaces the old one at once; the old link shows the customer the generic "no longer valid" page.
- A lost link can't be shown again. Reissue it.

## One-time codes

- **Mock SMS:** `/dev/outbox` lists the mock text messages, newest first, including the codes in full. It is mounted only when `MOCK_OUTBOX_ENABLED=true`; otherwise it is 404. It must be off in production (`MOCK_OUTBOX_ENABLED=false`), where a real SMS provider replaces the outbox.
- **A customer is locked out** (five wrong codes; the banker's list shows "Link locked"): check with the customer through the usual channel that the attempts were theirs, then reissue the link from the request page and send them the new link. The new link has a fresh allowance of codes and attempts. The lockout is recorded as an `otp.locked` event with outcome `suspicious`.
- **A customer used up their codes** (three per link) and still has none that works: reissue the link.
- **Rotating `OTP_PEPPER`** invalidates only codes that are outstanding at that moment; customers request a new code. Links, sessions and documents are unaffected.
- Code activity is audited as `otp.sent`, `otp.send_refused`, `otp.verified`, `otp.verify_failed` and `otp.locked`.

## How compliance checks the audit chain

- A compliance officer opens a request and follows "Audit trail" (`/requests/<id>/audit`). Bankers are refused, and the refusal is logged.
- The line above the table verifies the **whole** audit log, every request and sign-in, not just this request:
  - `Chain intact (N events)`: every event's content matches its hash and links to the one before.
  - `Chain broken at event #seq (content edited)`: that event was changed after it was written.
  - `Chain broken at event #seq (link broken)`: the event before it was deleted, events were reordered, or a hash was recomputed to hide an edit.
- The table lists the request's events in order, with actor, action, target, outcome, source IP and detail. Each view is itself audited as `audit.viewed`.
- A break means someone with database owner rights changed the log, since the app cannot. Treat it as a security incident (see the failure-modes table): keep the database as it is, compare with the anchored head hash (production), and find who held the owner role.
- Deleting only the newest events is not visible to the chain; the anchored head hash (production) covers that.
- **Queries by actor and date range** are not in the portal yet. Until they are, run them against the database:

  ```bash
  psql "$DATABASE_URL" -c "select seq, at, actor_type, actor_id, action, target_type, target_id, request_id, outcome, source_ip
    from audit_events
    where actor_id = '<user id>' and at >= '2026-11-01' and at < '2026-12-01'
    order by seq"
  ```

## Failure modes

| Failure                                                | What happens                                                                                                                                                                                                                                                 | What to do                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Invalid or missing configuration                       | The app refuses to start and lists every bad variable                                                                                                                                                                                                        | Fix the environment and restart                                              |
| Database unreachable                                   | Requests fail with a generic 500 page; the error is logged with details                                                                                                                                                                                      | Restore the database; the app recovers without a restart                     |
| Object storage unreachable                             | An upload answers 503 "We couldn't process your files right now. Please try again." Objects already written are deleted, no rows are written, and the customer's session stays open. A download fails with the generic 500 page and writes no download event | Restore storage; customers retry within their session or the banker reissues |
| SMS provider down                                      | _Designed:_ the code send fails and the customer is asked to try again. The attempt still counts toward the resend limit only if a message was actually sent                                                                                                 | Restore the provider                                                         |
| Malware scanner down                                   | Fail closed: an upload answers 503 with the same retry message; nothing is stored and the session stays open. (Production, with asynchronous scanning: files stay pending and cannot be viewed until scanned)                                                | Restore the scanner, then rescan pending files                               |
| Crash between storing a file and committing its record | An orphan object with no database row. It can't be reached, because every read goes through a database row                                                                                                                                                   | A periodic sweep removes objects with no row (production)                    |
| Audit chain broken                                     | The compliance audit page reports the first broken event                                                                                                                                                                                                     | Treat as a security incident; compare with the anchored hash                 |

## Rollback and degrade

- **App:** releases are immutable container images, so rolling back means redeploying the previous image.
- **Database migrations:** these only move forward. Schema changes follow expand-then-contract: add new columns and tables first, deploy code that uses them, and remove old ones in a later release. That way the previous app version keeps working after a migration and a rollback needs no down-migration.
- **Degrade, don't fail open:** if the scanner, SMS or storage is unavailable, the affected step is refused. Access checks, audit writes and file validation are never skipped to keep things running. An action whose audit event can't be written does not happen.

## Local to cloud

- **Same code, different adapters:** S3 instead of RustFS, an SMS provider instead of the outbox, OIDC instead of mock sign-in, and a real scanner. Only the startup wiring changes.
- **Configuration:** the same variables, supplied from Secrets Manager. `BASE_URL` becomes the `https://` origin, which turns on `Secure` cookies. `TRUST_PROXY=true` sits behind the load balancer. `MOCK_OUTBOX_ENABLED=false`.
- **Database roles:** the migration pipeline holds the owner role. The running app uses only the restricted role, and nobody signs in as owner day to day.
- **Hosting region:** an Australian region, for documents and audit data alike.
