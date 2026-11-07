# Secure Document Request Portal — Slice Design

Source of truth for requirements: `evidence/intent.md`. This document covers only the in-scope slice. Requirement IDs (FR-n) and acceptance criteria (AC-n, numbered in the order they appear in intent.md) are the reference points.

## 1. Intent

Bankers today collect payslips, statements and ID by email. Documents sit in inboxes forever, customers learn to attach documents to emails (which phishing exploits), and there is no record of who saw what. The portal replaces email: a banker raises a request, the customer uploads through a single-use link protected by a one-time code sent to a separate channel, only the requesting banker and compliance can view the documents, and every action lands in a tamper-evident audit log.

This slice is built for **engineering review**. Reviewers will read the code and run the tests to judge the security logic. That sets the priorities:

1. The security invariants are real and covered by tests that map one-to-one to the acceptance criteria.
2. The code is small and easy to follow: few layers, explicit SQL-shaped data, one place for each rule.
3. The pages are plain, server-rendered and functional. Polish is not a goal.

### Goals

- The full journey runs end to end: create request → link shown once → open link → code → upload → banker/compliance view → audit trail.
- Every acceptance criterion in intent.md has an automated test.
- External integrations (SMS, SSO, object storage, malware scan, customer master) sit behind small interfaces with local implementations.
- The four evidence documents (`evidence/design.md`, `verify.md`, `operate.md`, `decisions.md`) describe the result accurately.

**Scope change from intent.md:** code resends with a rate limit (FR-7) are **in scope**. A customer whose code expires can request a new one, as with standard MFA. This overrides intent.md's out-of-scope line "single code per link session" and is the decision of the product owner.

### Non-goals (this slice)

- Retention purge job (FR-15). The retention date is still recorded on every file.
- Banker notifications (FR-16). Status shows in the UI.
- Request cancellation, legal hold, bulk requests.
- Real SMS, SSO, malware scanning, customer-master integration.
- WCAG conformance testing, TLS/HSTS termination, and network-level rate limiting. These are assumed to be handled at the infrastructure layer.
- Encryption at rest.

### Anti-goals (would be a failure even if it "works")

- A raw upload token or one-time code is persisted anywhere: DB, logs, or audit detail.
- An action that changes state commits without its audit event, or an audit event is written for an action that rolled back.
- A user-supplied filename, extension or `Content-Type` decides how a file is stored or served.
- An authorisation check lives in a page template rather than in one policy function that every route calls.
- Mocks leak into business logic. Swapping a provider must not change any domain module.

## 2. Approaches considered

| Approach | Trade-off | Outcome |
| --- | --- | --- |
| Server-rendered React JSX on Elysia, forms posting back | One codebase, no client state, React escapes output by default, and every rule is enforced server-side where reviewers look | **Chosen** |
| React browser app + JSON API (Bun fullstack bundling) | Smoother UI and Zod shared across both sides, but two surfaces to build and review, plus client-side state, for a review focused on server security | Rejected |
| Plain `Bun.serve` without a framework | No dependencies, but hand-rolled escaping, cookies and routing are more code for a security reviewer to distrust | Rejected |

The user chose the rest of the stack: **Elysia**, **Zod**, **Drizzle ORM**, **Postgres** and **RustFS** (S3-compatible), with the last two running in Docker via `compose.yml`.

## 3. Technology

| Concern | Choice | Notes |
| --- | --- | --- |
| Runtime | Bun (already initialised) | `bun test` is the test runner |
| HTTP | Elysia | Routes, cookies, lifecycle hooks for headers/auth |
| Rendering | React JSX rendered on the server with `react-dom/server` `renderToString`, returned as `text/html` | No hydration and no client bundle. Auto-escaping is the XSS control. *Builder's call:* a minimal inline script is allowed only if needed, under a CSP nonce |
| Validation | Zod (v4) for every external input: params, form bodies, multipart fields, config | Elysia accepts Standard Schema validators |
| DB | Postgres 18 in Docker | `drizzle-orm` with the `bun-sql` driver; migrations via `drizzle-kit` (generated SQL committed), plus one hand-written SQL migration for audit protections (§6.6) |
| Object storage | RustFS in Docker, accessed through Bun's built-in `S3Client` | Bucket created on startup if missing |
| Container orchestration | `compose.yml` with `postgres` and `rustfs` services | The app runs on the host with `bun run`. *Builder's call:* whether the app is also a compose service |

## 4. Architecture

```
Browser ──HTTP──▶ Elysia app
                   ├─ web/          routes + JSX pages (thin: parse with Zod → call domain → render)
                   ├─ modules/      domain modules (own the rules, own their tables)
                   │    requests/   request lifecycle + upload links (FR-1..4, FR-11)
                   │    otp/        one-time codes, resend limit, lockout, customer session (FR-5..7)
                   │    documents/  upload validation, storage, scan hook, viewing (FR-8..10, FR-12, FR-17)
                   │    audit/      hash-chained append + verify (FR-13, FR-14)
                   │    access/     user identity (mock login) + the single authorisation policy
                   ├─ ports (interfaces) + local adapters
                   │    ObjectStore    → S3Client against RustFS
                   │    SmsSender      → writes to `outbox` table, shown on /dev/outbox
                   │    MalwareScanner → always returns clean
                   │    (Identity is the mock-login session; customer data comes from the seeded `customers` table)
                   └─ db/  Drizzle schema, migrations, seed
```

**Layout:** all application code lives under `src/` (`src/web/`, `src/modules/`, `src/db/`, adapters). All tests live under `tests/`, never next to the code. Only tool config (`compose.yml`, `drizzle.config.ts`, `bunfig.toml`, `docker/`) sits at the repo root.

**Component boundaries**

- Routes do not touch tables. Routes call domain functions, and domain functions take a transaction handle (`tx`) so that a state change and its audit event commit together.
- `audit.append(tx, event)` is the only way to write an audit event. Every domain function that changes state calls it inside the same transaction.
- `access.authorise(user, action, request)` is the only authorisation decision point. It returns allow/deny. On deny, the caller writes a `denied` audit event in its own transaction (which commits) and responds 403. A denial is never rolled back.
- Ports are plain TypeScript interfaces passed in through one `deps` object built at startup. Tests use the same real adapters against the compose services. A fake is used only where the real one is the mock anyway (SMS outbox, scanner).

## 5. Data model

All IDs are UUIDv4 (`gen_random_uuid()`), except `audit_events.seq`, which is a bigint sequence giving the chain order. Timestamps are `timestamptz`, UTC.

**users** (seeded): `id`, `name`, `role` (`banker` | `compliance`).
Seed: two bankers ("Alice Banker", "Bob Banker") and one compliance officer ("Carol Compliance").

**customers** (seeded): `id`, `name`, `mobile` (E.164). Seed: about three synthetic customers.

**requests**: `id`, `customer_id`, `banker_id`, `document_types` (`text[]`, values from a fixed enum: `payslip`, `bank_statement`, `photo_id`, `other`), `status`, `created_at`, `updated_at`.

**upload_links**: `id`, `request_id`, `token_hash` (unique, hex SHA-256 of the raw token), `state` (`active` | `used` | `revoked` | `locked`), `issued_at`, `expires_at` (`issued_at + 72h`), `failed_code_attempts` (int), `codes_sent` (int), `last_code_sent_at`.
A partial unique index allows only one `active` link per request.
Expiry is not a stored state. A link is usable only if `state = 'active' AND now() < expires_at`.

**otp_codes**: `id`, `link_id`, `code_hash` (HMAC-SHA-256, see §6.2), `expires_at` (`sent_at + 5m`), `consumed_at`. Only the latest unconsumed, unexpired code for a link is valid. Sending a new code consumes (invalidates) any earlier one.

**customer_sessions**: `id`, `link_id`, `token_hash`, `expires_at` (`created + 15m`), `ended_at`.

**documents**: `id`, `request_id`, `storage_key` (random UUID; the key in the bucket), `document_type` (one of the request's `document_types`, chosen by the customer), `original_filename` (display only, never used for storage or serving), `detected_type` (`pdf` | `jpeg` | `png`), `size_bytes`, `sha256`, `scan_status` (`pending` | `clean` | `infected`), `retention_until` (date), `uploaded_at`.

**outbox** (mock SMS): `id`, `to_mobile`, `body`, `created_at`, plus `link_id` for the dev page. This table deliberately holds the plaintext code, because it stands in for the customer's phone. It is the one documented exception, available only when `MOCK_OUTBOX_ENABLED=true`, and is noted in the evidence docs.

**audit_events**: see §6.6.

### Request status (FR-11, in-scope part)

```
Open ──(customer submits files)──▶ Received ──(banker or compliance closes)──▶ Closed
  │
  └── shown as "Expired" when status = Open and there is no usable link (latest link expired)
      Reissue moves it back to a usable Open
```

- Stored statuses: `open`, `received`, `closed`.
- **Expired is derived, not stored.** It is computed in one function/SQL expression from the request and its latest link, so no background job is needed and nothing can drift. *(Designer's call.)*
- A locked link shows the request as Open with a "Link locked: reissue required" badge.
- Reissue is allowed only while status is `open`. Close is allowed only from `received`.

## 6. Security design

### 6.1 Upload link token (FR-2, FR-3, FR-4)

- 32 random bytes from `crypto.getRandomValues`, base64url-encoded, giving 43 characters and 256 bits of entropy.
- Only `sha256(token)` is stored. Lookup is by hash equality on the unique index. Constant-time comparison isn't needed because the attacker doesn't control a stored secret being compared.
- The URL is `${BASE_URL}/u/${token}`. It is rendered once, in the response to the create/reissue POST. That response sets `Cache-Control: no-store`. Reloading the request page never shows it again, because the server cannot reconstruct it.
- Reissue runs in a single transaction: set the previous active link to `revoked`, insert the new link, and write audit events `link.revoked` and `link.issued`.
- A link is refused with one generic page ("This link is no longer valid. Contact your banker.") whether it is unknown, used, revoked, locked or expired. The distinct reason is written to the audit log only. *(Designer's call: don't tell an attacker which state a link is in.)*

### 6.2 One-time code (FR-5, FR-6, FR-7)

- 6 digits from a CSPRNG, uniform (rejection sampling).
- Stored as `HMAC-SHA-256(OTP_PEPPER, link_id || ":" || code)`. A plain SHA-256 of a 6-digit code can be reversed by enumerating all 10⁶ values if the DB leaks. The keyed hash satisfies the "stored only as a SHA-256 hash" invariant and removes that weakness. *(Designer's call, recorded in decisions.md.)*
- **Sending:** `GET /u/:token` validates the link and shows a page with a "Text me a code" button. The button POSTs to `/u/:token/code`, which sends the code. *(Designer's call; deviates from FR-5's literal "opening the link triggers a code". Email security scanners and link previewers fetch GET URLs automatically, which would burn the resend allowance and spam the customer. The customer flow remains: open link → [send code] → enter code → upload.)*
- **Resend limit (FR-7):** at most **3 codes per link** in total, and at least **30 seconds** between sends. Over the limit, the page says "Too many codes requested; contact your banker", and the banker must reissue. Each send writes `otp.sent`, and each refused send writes `otp.send_refused`.
- **Verify** at `POST /u/:token/verify`:
  - Correct, unexpired code: mark it consumed, create a customer session, and redirect to `/u/upload`.
  - Wrong or expired code: increment `failed_code_attempts` on the **link** (counts across resends). At 5, set the link to `locked` and write `otp.locked` with outcome `suspicious`.
  - Attempts on a locked link are refused and audited.
  - The counter increment uses `UPDATE … SET failed_code_attempts = failed_code_attempts + 1 … RETURNING` in the same transaction, so concurrent guesses cannot exceed 5.

### 6.3 Customer upload session

- After verification, the server sets a cookie `cs` holding a random 32-byte session token. Only its SHA-256 is stored.
  - Cookie attributes: `HttpOnly`, `SameSite=Strict`, `Path=/u`, `Secure` when `BASE_URL` is https, and a lifetime of 15 minutes.
- The upload page and POST no longer carry the link token in the URL, so the token appears in only two places: the first GET and the code POSTs.
- **Submit (FR-3):** a successful upload POST ends the session, sets the link to `used`, and moves the request to `received`, all in one transaction with audit events.

### 6.4 Upload validation and storage (FR-8, FR-9, FR-10, FR-17)

- **One form, one submit.** The customer selects 1–10 files, picks a document type for each from the request's requested types, and submits. *(Designer's call: keeps "single-use" unambiguous. Each submit is all-or-nothing.)*
- **Completeness (product owner's decision):** submit is refused unless every requested type has at least one file. Quantities (e.g. "two payslips") are not stored or enforced; the banker judges them. A type that wasn't requested is refused. Missing types are listed on the page, and the session stays open so the customer can fix it.
- **Per-file checks:**
  - Size must be at most 10 MB (10 × 1024 × 1024 bytes).
  - The type is detected from magic bytes:
    - PDF: `25 50 44 46 2D` (`%PDF-`)
    - PNG: `89 50 4E 47 0D 0A 1A 0A`
    - JPEG: `FF D8 FF`
  - The extension and client `Content-Type` are ignored for the decision.
- **Any failure rejects the whole submission.** No file is stored, the session stays open, and the page lists each rejected file with its reason (type or size) so the customer can retry. An `upload.rejected` audit event is written. Elysia's/Bun's max body size is set to 10 files × 10 MB plus overhead.
- **Accepted files:**
  1. Compute the SHA-256 of the bytes.
  2. Run `MalwareScanner.scan(bytes)`. The mock returns clean.
  3. Put the object at key `documents/<uuid>` with a fixed content type for the detected type.
  4. Insert the `documents` row with `scan_status`, `retention_until = today + RETENTION_DAYS`, and the hash.
- **Ordering and failure:**
  - Objects are written to storage **before** the DB transaction commits.
  - If the transaction fails, the code makes a best-effort attempt to delete the objects it wrote.
  - A crash between put and commit leaves an orphan object with no row. It is unreachable because every read goes through a `documents` row. This is noted as a known gap, to be swept by the purge job in production.
- **Scan gating:** only documents with `scan_status = 'clean'` can be viewed or downloaded. The scan hook runs synchronously in the slice. Production would run it asynchronously with quarantine.

### 6.5 User identity and authorisation (FR-12, FR-14)

- **Mock login** at `GET /login` lists the seeded users. `POST /login` with a user id sets a user session.
  - The session is a server-side row in `user_sessions` (`id`, `user_id`, `token_hash`, `expires_at` = 8h). The cookie is `sid`, `HttpOnly`, `SameSite=Strict`, `Path=/`.
  - The mock sits behind an `Identity` concept: production swaps the login route for SSO (OIDC), and the session/authorisation code is unchanged.
- **Policy**, in one module (`access/policy.ts`):

| Action | Banker | Compliance |
| --- | --- | --- |
| `request.create` | yes | **no** |
| `request.view` / `document.download` / `request.reissue` | only if `request.banker_id = user.id` | view/download yes; reissue no |
| `request.close` | own requests | yes |
| `audit.view` (per request and chain verification) | no | yes |

- Customers never get a user session and have no route that returns document bytes.
- **Denied:** respond 403 with a generic page, and write an audit event with `outcome = 'denied'` and the actor, target and IP. Covers AC-7.
- **CSRF:** cookies are `SameSite=Strict`, and every state-changing POST checks that the `Origin` header matches `BASE_URL`. A missing or mismatched `Origin` is refused.

### 6.6 Audit log (FR-13, FR-14)

**Table `audit_events`:**
- `seq` (bigserial, PK), `at`
- `actor_type` (`user` | `customer` | `system`), `actor_id` (user id, link id for customers, or `system`)
- `action` (dotted name, e.g. `request.created`, `link.issued`, `otp.verify_failed`, `document.viewed`, `access.denied`)
- `target_type`, `target_id`, `request_id` (nullable, for per-request queries)
- `source_ip`, `outcome` (`success` | `failure` | `denied` | `suspicious`), `detail` (jsonb)
- `prev_hash`, `hash`

**Chain:**
- `hash = sha256(prev_hash || canonical_json(all fields except hash))`.
- The genesis `prev_hash` is 64 zeros.
- Canonical JSON has sorted keys and an ISO timestamp. The timestamp is generated in app code, not by `now()` default, so the hashed value equals the stored value.

**Serialised appends:**
- `audit.append` takes `pg_advisory_xact_lock(<constant>)`, reads the latest `hash`, then inserts.
- Appends from concurrent transactions are serialised, so the chain never forks.
- The lock is held until commit. That is acceptable at slice scale and noted as a production scaling point.

**Append-only enforcement:**
- A migration adds a trigger that raises on `UPDATE` or `DELETE` of `audit_events`.
- The app's DB role is granted only `INSERT, SELECT` on the table.
- Tamper tests connect as the owner role, disable the trigger, and edit or delete rows to simulate a privileged attacker. The verifier must then detect it.

**Verification:**
- `audit.verify()` walks rows in `seq` order and recomputes each hash. It reports the first `seq` where the stored hash mismatches (an edit) or where `prev_hash` ≠ the previous row's `hash` (a deletion or reorder).
- Compliance sees "Chain intact (N events)" or "Chain broken at event #seq" on the audit page.

**Known gap:** deleting the newest events (tail truncation) cannot be detected by the chain alone. The production mitigation is to periodically anchor the head hash in external WORM storage. This goes in verify.md.

**Detail hygiene:** `detail` never holds tokens, codes or file contents. It may hold the `token_hash` prefix (first 8 hex characters) for correlation.

### 6.7 HTTP hardening

- A global `onAfterHandle` hook sets:
  - `Referrer-Policy: no-referrer`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'`
  - `Cache-Control: no-store` on all authenticated and customer pages
- Applying the headers globally is simpler than only on `/u/*`, and stricter. *(Designer's call.)*
- Downloads are served with:
  - `Content-Type` from `detected_type`
  - `Content-Disposition: attachment; filename="<sanitised original name>"`
  - `nosniff`
- **Request logging:** one line per request (method, path, status, duration). The path is passed through `maskTokens()`, which rewrites `/u/<token>` to `/u/****`. A unit test pins this behaviour.
- **Source IP:** taken from `server.requestIP(request)`. `X-Forwarded-For` is used only when `TRUST_PROXY=true`.

## 7. Routes and pages

Signed-in users (session required):

| Route | Page / effect |
| --- | --- |
| `GET /login`, `POST /login`, `POST /logout` | Mock login |
| `GET /` | Request list. Bankers see their own; compliance sees all. Shows status, including derived Expired and Link locked |
| `GET /requests/new`, `POST /requests` | Pick customer + document types; the response shows the link once |
| `GET /requests/:id` | Detail: customer, types, status, link state, documents (view/download), Reissue / Close buttons by policy |
| `POST /requests/:id/reissue` | The response shows the new link once |
| `POST /requests/:id/close` | Received → Closed |
| `GET /documents/:id` | Download as `attachment` (audited `document.downloaded`). There is no inline viewer: download is how a document is "viewed" (FR-12, AC-8), so uploaded content is never rendered on the app origin. Opening the request detail with its document list is audited as `request.viewed` *(designer's call)* |
| `GET /requests/:id/audit` | Compliance: events for the request + whole-chain verification result |

Customer (no account):

| Route | Page / effect |
| --- | --- |
| `GET /u/:token` | Valid → "Text me a code" button; invalid → generic refusal |
| `POST /u/:token/code` | Send code (limits apply) → code entry form |
| `POST /u/:token/verify` | Verify → session cookie → redirect `/u/upload` |
| `GET /u/upload`, `POST /u/upload` | File form; submit → "Thanks, your banker has been notified" page (session ends) |

Dev only (`MOCK_OUTBOX_ENABLED=true`):

| Route | Page / effect |
| --- | --- |
| `GET /dev/outbox` | Latest mock SMS messages, newest first |

**Page sketch (customer, phone width):**

```
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ Secure document upload    │   │ Enter the 6-digit code    │   │ Upload: Payslip, Photo ID │
│ Requested by your banker  │   │ sent to ••• ••• •89       │   │ file1.pdf [Payslip ▾]     │
│ [ Text me a code ]        │   │ [______]  [Verify]        │   │ id.jpg    [Photo ID ▾]    │
│                           │   │ Didn't get it? [Resend]   │   │ [ Submit documents ]      │
└───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

(The mobile number is masked except for the last two digits.)

## 8. Configuration

All configuration comes from environment variables, parsed once at startup by a Zod schema. The app fails fast if any are invalid. `.env.example` is committed; `.env` is git-ignored.

- `DATABASE_URL` (app role), `DATABASE_OWNER_URL` (migrations/tests only)
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`
- `BASE_URL`, `OTP_PEPPER` (≥32 bytes), `RETENTION_DAYS` (default 2555 ≈ 7 years), `TRUST_PROXY`, `MOCK_OUTBOX_ENABLED`, `PORT`

There is no separate session secret: session tokens are random, and only their hashes are stored.

## 9. Testing strategy

- `bun test` runs against the compose Postgres and RustFS. The test harness migrates a fresh schema and truncates tables (as owner) between test files.
- Tests drive the Elysia app through `app.handle(new Request(...))`, using real HTTP semantics without opening a port. They assert on responses, DB rows the user can observe through the app, the outbox and the audit log.
- **Acceptance-criteria suite**, one test file with one `test` per AC, named after the AC:

| AC | Test outline |
| --- | --- |
| AC-1 link shown once | Create request → response contains a URL; GET request detail → URL absent; DB holds only the hash |
| AC-2 valid link + code → PDF upload | Full customer flow with a real PDF fixture → document row, object in RustFS, status Received |
| AC-3 renamed executable rejected | ELF/MZ bytes named `payslip.pdf` → rejected with a type reason; nothing stored |
| Completeness | Request for payslip + photo ID, submit only a payslip → refused, lists missing type; nothing stored; link still active |
| AC-4 >10 MB rejected | 10 MB + 1 byte PDF-headed file → rejected with a size reason |
| AC-5 used/expired/revoked refused | Three cases. Expiry is tested with an injectable clock (`deps.now`), not by sleeping |
| AC-6 five wrong codes lock + suspicious event | 5 wrong → link locked, `otp.locked` event with `suspicious`; 6th attempt with correct code refused |
| AC-7 other banker denied + logged | Bob GETs Alice's request and document → 403; `access.denied` events exist |
| AC-8 compliance sees document + audit trail | Carol downloads; audit page lists the events for the request and "Chain intact" |
| AC-9 tamper detected | As owner: update one event's detail → verify reports that seq; separately delete a middle event → verify reports the break |

- **Focused unit tests** where the rule is pure:
  - magic-byte detection
  - token masking
  - the derived-status function
  - the canonical-JSON hash
  - the policy table
  - resend limit and cooldown
  - code expiry at 5 minutes
- **Optional:** one Playwright smoke test of the happy path in a real browser, if time allows. *(Builder's call.)*
- `bun run typecheck` and the test suite are the checks. verify.md records which run locally versus in a PR pipeline: in a pipeline, compose services run as job services, alongside dependency audit and secret scanning.

## 10. Evidence documents

These live in `evidence/`. Each restates its content rather than linking here, and each is updated by the plan chunk that changes what it describes:

- `design.md` — architecture, data flow, boundaries, trade-offs, security/privacy, technology, production/cloud shape (e.g. AWS ap-southeast-2: ECS/Fargate behind ALB+WAF, RDS Postgres encrypted with KMS, S3 with SSE-KMS and Object Lock for audit anchors, SNS/Pinpoint for SMS, the bank's IdP via OIDC, GuardDuty/Macie hooks).
- `verify.md` — the checks above, actual results, known gaps (tail truncation, orphan objects, synchronous mock scan, no load test), and local vs pipeline.
- `operate.md` — `docker compose up`, migrate, seed, run; logs and the outbox; config/secrets (env locally, Secrets Manager in cloud; pepper rotation implications); failure modes (DB down → 503, storage down → upload refused with retry message and no partial state, scanner down → fail closed); rollback (forward-only migrations, expand/contract).
- `decisions.md` — 3–5 records, for example: server-rendered JSX over SPA; HMAC-peppered OTP hashes; derived Expired status; button-triggered code send vs FR-5 literal; Postgres advisory lock for the audit chain. Plus an "intentionally not built" list.

## 11. Implementation chunks (one plan each, in order)

1. **Foundation.** compose.yml (Postgres + RustFS), config schema, Drizzle schema + migrations (including the audit trigger and app role grants), seed, Elysia skeleton with security headers, request logging with masking, mock login + user sessions, test harness.
2. **Audit chain.** `audit.append` and `audit.verify`, and the AC-9 tests.
3. **Requests and links.** Create, show-once, reissue/revoke, expiry, derived status, list/detail pages, close. Tests: AC-1, AC-5 (revoked/expired parts).
4. **One-time code.** Customer link page, send/resend limits, verify, lockout, customer session, outbox page. Tests: AC-6.
5. **Uploads.** Validation, storage, scan hook, submit → used/received. Tests: AC-2, AC-3, AC-4, AC-5 (used).
6. **Viewing and compliance.** Policy wiring, download, denied logging, compliance audit page. Tests: AC-7, AC-8.
7. **Evidence pass.** Bring the four evidence docs to final state, record actual test results.

Each chunk ends green (typecheck + tests) and updates whichever evidence docs it affects.

## 12. Left to the builder

- File and folder names within the module layout in §4.
- Visual styling (a small inline stylesheet is enough).
- Whether the app also runs as a compose service.
- Exact wording of pages and error messages, within the "generic refusal" rule.
- Whether to add the Playwright smoke test.
