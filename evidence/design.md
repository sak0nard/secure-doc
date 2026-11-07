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

## Architecture overview

```
Banker / compliance ──┐                         ┌── Postgres: requests, links, sessions,
                      ├── HTTPS ── Elysia app ──┤   document metadata, audit log
Customer (phone) ─────┘    (server-rendered     ├── Object storage (S3 API): document files
                            pages)              ├── SMS sender (mock outbox locally)
                                                └── Malware scanner (always-clean mock locally)
```

- There is one app process. It has no client-side application, no background workers and no message queue.
- External services sit behind small interfaces, so a mock can be replaced by a real provider without changing the rules:
  - storage: RustFS → S3
  - SMS: outbox table → SMS provider
  - scanning: mock → real scanner
  - identity: mock sign-in → OIDC

**Status:** configuration, the data model, the database protections, HTTP hardening and sign-in are built. The rest of this document describes the agreed design for what comes next.

## Data flow

**Main journey:**

1. **Request.** A banker signs in, picks a customer and the document types needed, and submits.
   - The server creates the request and an upload link in one transaction, together with their audit events.
   - The link token is random (256 bits); only its SHA-256 is stored.
   - The full link is shown on that one response and never again.
2. **Open the link.** The customer opens the link on their phone.
   - The server hashes the token from the URL and finds an active, unexpired link.
   - Any other state (unknown, used, revoked, locked or expired) gets the same generic "no longer valid" page; the real reason goes only to the audit log.
3. **Code.** The customer taps "Text me a code".
   - A 6-digit code goes to the mobile number already on the customer's record, never to the channel that carried the link.
   - Only a keyed hash of the code is stored, and it expires after 5 minutes.
4. **Verify.** The customer enters the code.
   - A correct code starts a 15-minute upload session (an `HttpOnly` cookie limited to `/u`). The link token no longer appears in URLs after this point.
   - Wrong codes count against the link. The fifth locks it and records a suspicious-activity event.
5. **Upload.** The customer picks files and tags each with one of the requested document types, then submits.
   - The server checks each file's real type from its first bytes (PDF, JPEG or PNG), its size (10 MB at most), and that every requested type is present.
   - Any failure rejects the whole submission with reasons, and the customer can retry.
   - On success, each file is hashed, passed through the scan step and stored under a random key. Its metadata, including the retention date, is recorded.
   - The link is marked used, the session ends and the request moves to Received, all in one transaction.
6. **Review.** The requesting banker or a compliance officer opens the request and downloads documents.
   - Every view and download is audited.
   - Anyone else is refused, and the refusal is audited.
7. **Audit.** Compliance can see every event for a request, and whether the whole hash chain is intact.

## Security and privacy

| Threat | Control | Status |
| --- | --- | --- |
| Database leak exposes live links or sessions | Tokens stored only as SHA-256; codes as keyed HMAC-SHA-256 | Built for user sessions; designed for links, codes and customer sessions |
| Stolen or forwarded link | The code is sent to the mobile on file, never the channel that carried the link. Links are single-use, expire in 72 hours, and are revoked on reissue | Designed |
| Guessing tokens or codes | 256-bit tokens; a link locks after 5 wrong codes; at most 3 codes per link, 30 seconds apart | Designed |
| Token leaking through the Referer header or logs | `Referrer-Policy: no-referrer` on every response; tokens masked in request logs | Built |
| Cross-site request forgery | `SameSite=Strict` cookies, plus an `Origin` check on every state-changing request | Built |
| Cross-site scripting | React escapes all output; the content security policy allows no inline scripts and no framing | Built |
| Internal details leaking in errors | Generic error pages; details only in the server log | Built |
| Spoofed client IP in the audit log | `X-Forwarded-For` is used only when the proxy is trusted, and only the entry the proxy added | Built |
| Malicious upload | Type checked from file contents, not the name; 10 MB limit; scan step; random storage keys; files always served as downloads, never rendered on the portal's domain | Designed |
| Insider browsing documents | One authorisation policy: the requesting banker and compliance only. Every view and every refusal audited | Designed |
| Audit tampering | Hash chain, plus database permissions and a trigger that block edits and deletes | Database protections built; chain designed |
| Keeping data too long | Retention date recorded on every file (purge job out of scope) | Designed |

**Privacy:**
- All customer data in this build is synthetic.
- Customer mobile numbers are shown masked, except the last two digits.
- Audit details never contain tokens, codes or file contents.
- Original file names are kept for display only and never used to store or serve files.

## Key trade-offs

- **Server-rendered pages over a browser app:** simpler and easier to secure, but plainer screens. See decisions D1.
- **Real Postgres and object storage in tests, not fakes:** the tests prove the actual database protections and storage behaviour. The cost is that Docker must be running to test.
- **Whole data model created up front:** later work adds behaviour, not tables, and the database permissions are granted once. The cost is that some tables exist before the code that uses them.
- **One submission per link:** a submission is all-or-nothing, so "single-use" is unambiguous. If the customer needs to send more, the banker raises a new request.
- **Synchronous scan step:** simple and enough for the always-clean mock. A real scanner would run asynchronously, with files held until clean.
- **Serialised audit writes:** guarantee one unbroken chain, but limit audit write throughput.

## Production and cloud shape

Assuming AWS in the Sydney region (ap-southeast-2) for data residency:

| Concern | Local | Production |
| --- | --- | --- |
| App | `bun` process on a laptop | Containers on ECS Fargate across availability zones, behind an Application Load Balancer with AWS WAF (TLS, HSTS, rate limiting) |
| Database | Postgres 18 in Docker | Amazon RDS for PostgreSQL, Multi-AZ, encrypted with KMS, automated backups and point-in-time recovery |
| Files | RustFS | Amazon S3 with KMS encryption, Block Public Access, versioning, and lifecycle rules aligned to retention |
| Audit anchor | — | The latest audit hash copied regularly to an S3 bucket with Object Lock (write-once), so tail truncation is detectable |
| SMS | Outbox table and `/dev/outbox` page | An SMS provider (e.g. Amazon SNS or Pinpoint) behind the same interface; outbox page disabled |
| Identity | Mock sign-in | The bank's identity provider via OIDC, with roles mapped from groups |
| Malware scanning | Always-clean mock | Asynchronous scanning on upload, with quarantine |
| Secrets | `.env` file | AWS Secrets Manager, injected at start-up |
| Monitoring | Request log on stdout | Central logs; alerts on lockouts, denied access and audit-chain breaks; feed to the bank's security monitoring (SIEM) |
