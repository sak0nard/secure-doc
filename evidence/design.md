# Design

## Technology choices

| Concern        | Choice                                   | Why                                                                                                                      |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Runtime        | Bun                                      | Fast start-up, built-in test runner, Postgres client, S3 client and crypto                                               |
| Web framework  | Elysia                                   | Small, typed, lifecycle hooks for headers, CSRF and auth in one place                                                    |
| Pages          | React JSX rendered to HTML on the server | No client app or client state. React escapes every interpolated value, which is the main XSS control                     |
| Validation     | Zod                                      | Every external input (forms, params, config) is parsed before use                                                        |
| Database       | Postgres 18 with Drizzle ORM             | Typed schema, generated SQL migrations committed to the repo, plus hand-written SQL where it matters (audit protections) |
| Object storage | RustFS locally, through the S3 API       | The same code talks to AWS S3 in production                                                                              |

**Alternatives considered:**

- **A React browser app with a JSON API.** It gives a smoother UI, but means two surfaces to secure and review, and adds client-side state.
- **A plain Bun server with no framework.** It has no dependencies, but escaping, cookies and routing would be hand-rolled, which a security reviewer would rightly distrust.

## Component boundaries

```
src/
  web/        HTTP only: routes, pages, cookies, security headers, CSRF check
  modules/    domain rules; each module owns its tables
    access/   sign-in sessions and the single authorisation policy
    audit/    hash-chained append and verification; the only way to write an audit event
    requests/ requests, upload links, and the derived status shown to people
    otp/      one-time codes (send, resend limits, verify, lockout) and customer upload sessions
  ports/      interfaces to external services, with their local adapters (SMS → outbox table)
  db/         schema, migrations, seed
  config.ts   validated configuration
  deps.ts     everything external (config, db, SMS, clock, logger), built once and swapped in tests
```

- Routes parse input and call module functions; they do not contain business rules.
- All time comes from `deps.now()`, so expiry rules can be tested with a fake clock.

## Data model

| Table               | Holds                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | Seeded bankers and compliance officers (stands in for SSO)                                                                       |
| `user_sessions`     | Signed-in sessions; only the SHA-256 of the session token is stored                                                              |
| `customers`         | Seeded synthetic customers and their mobile numbers (stands in for the customer master)                                          |
| `requests`          | Who asked whom for which document types, and the status (open, received, closed)                                                 |
| `upload_links`      | Hash of each link token, its state, expiry and attempt counters. At most one active link per request, enforced by a unique index |
| `otp_codes`         | Keyed hashes of one-time codes, with expiry                                                                                      |
| `customer_sessions` | Short upload sessions created after a correct code; token stored as a hash                                                       |
| `documents`         | Metadata for each stored file: random storage key, detected type, SHA-256, scan status, retention date                           |
| `outbox`            | Mock SMS messages                                                                                                                |
| `audit_events`      | Append-only, hash-chained audit log                                                                                              |

## HTTP hardening

These headers are on every response, including errors:

- `Referrer-Policy: no-referrer`, so link tokens never leak to other sites.
- `X-Content-Type-Options: nosniff`.
- `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'`. No inline scripts or styles, and no framing.
- `Cache-Control: no-store`, so pages showing links or documents aren't cached.

Request forgery is blocked two ways:

- Session cookies are `HttpOnly` and `SameSite=Strict`.
- Every state-changing request must prove it came from the portal: an `Origin` header matching `BASE_URL`, or, when the browser sends `Origin: null`, a `Sec-Fetch-Site: same-origin` header. Anything else gets 403.
  - Browsers send `Origin: null` on same-site form posts because every page sets `Referrer-Policy: no-referrer`, which we keep to protect link tokens.
  - Pages cannot forge `Sec-Fetch-Site`, and a post from another site always arrives as `cross-site`.

Request logs mask customer link tokens.

Downloads (`GET /documents/:id`) are always attachments, never rendered on the portal's origin:

- `Content-Type` comes from the type detected from the file's first bytes (`application/pdf`, `image/png`, `image/jpeg`), never from the customer's browser or file name.
- `Content-Disposition: attachment; filename="<safe name>"; filename*=UTF-8''<same name, percent-encoded>`, plus `X-Content-Type-Options: nosniff`.
- The safe name is the customer's file name without its extension, with every character outside `A–Z a–z 0–9 space . _ -` replaced by `_`, cut to 80 characters, then the extension of the detected type (`.pdf`, `.png`, `.jpg`). An empty result becomes `document`. Quotes, `;`, CR/LF, path separators and non-ASCII characters therefore cannot inject a header, name a path or change the extension.

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

**Status:** configuration, the data model, the database protections, HTTP hardening, sign-in, the audit chain, the authorisation policy, and requests with their upload links (create, list, detail, reissue, close, and the refusal of unusable links), one-time codes with the customer upload session, customer uploads (checks, scan step, storage, submit), audited document downloads, and the compliance audit trail are built.

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
5. **Upload.** The customer chooses files under each requested document type (one file box per type), then submits.
   - The server checks each file's real type from its first bytes (PDF, JPEG or PNG), its size (10 MB at most), and that every requested type is present.
   - Any failure rejects the whole submission with reasons, and the customer can retry.
   - On success, each file is hashed, passed through the scan step and stored under a random key. Its metadata, including the retention date, is recorded.
   - The link is marked used, the session ends and the request moves to Received, all in one transaction.
6. **Review.** The requesting banker or a compliance officer opens the request and downloads documents.
   - Every view and download is audited.
   - Anyone else is refused, and the refusal is audited.
7. **Audit.** Compliance can see every event for a request, and whether the whole hash chain is intact.

## Security and privacy

| Threat                                           | Control                                                                                                                                                             | Status |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Database leak exposes live links or sessions     | Tokens stored only as SHA-256; codes as keyed HMAC-SHA-256                                                                                                          | Built  |
| Stolen or forwarded link                         | The code is sent to the mobile on file, never the channel that carried the link. Links are single-use, expire in 72 hours, and are revoked on reissue               | Built  |
| Guessing tokens or codes                         | 256-bit tokens; a link locks after 5 wrong codes; at most 3 codes per link, 30 seconds apart                                                                        | Built  |
| Token leaking through the Referer header or logs | `Referrer-Policy: no-referrer` on every response; tokens masked in request logs                                                                                     | Built  |
| Cross-site request forgery                       | `SameSite=Strict` cookies, plus an `Origin` check on every state-changing request                                                                                   | Built  |
| Cross-site scripting                             | React escapes all output; the content security policy allows no inline scripts and no framing                                                                       | Built  |
| Internal details leaking in errors               | Generic error pages; details only in the server log                                                                                                                 | Built  |
| Spoofed client IP in the audit log               | `X-Forwarded-For` is used only when the proxy is trusted, and only the entry the proxy added                                                                        | Built  |
| Malicious upload                                 | Type checked from file contents, not the name; 10 MB limit; scan step; random storage keys; files always served as downloads, never rendered on the portal's domain | Built  |
| Insider viewing documents                        | One authorisation policy: the requesting banker and compliance only. Every view, download and refusal audited                                                       | Built  |
| Audit tampering                                  | SHA-256 hash chain over every event field (canonical JSON), plus database permissions and a trigger that block edits and deletes                                    | Built  |
| Keeping data too long                            | Retention date recorded on every file (purge job out of scope)                                                                                                      | Built  |

**Privacy:**

- All customer data in this build is synthetic.
- Customer mobile numbers are shown masked, except the last two digits.
- Audit details never contain tokens, codes or file contents.
- Original file names are kept for display only and never used to store or serve files.

## One-time codes

- **Keyed hash:** a code is 6 digits from a CSPRNG (rejection sampling keeps it uniform, leading zeros kept). Only `HMAC-SHA-256(OTP_PEPPER, linkId + ":" + code)` is stored. A plain SHA-256 of a 6-digit code could be reversed by trying all 10⁶ values; the key stops that, and binding the link id makes a hash useless for any other link. Verification compares hashes in constant time.
- **Lifetime:** a code works once, and only before 5 minutes have passed (at exactly 5 minutes it has expired). Sending a new code retires every earlier one.
- **Resend limits:** at most 3 codes per link, at least 30 seconds apart. A refused send returns 429 with a plain message and writes `otp.send_refused` with the reason (`limit` or `cooldown`). A double tap on "Text me a code" sends one code.
- **Lockout across resends:** every failed verification (wrong, expired, already used, none sent, or malformed input of any length) adds one to the link's counter, whichever code it was aimed at. The fifth sets the link to `locked` and writes `otp.locked` with outcome `suspicious`. After that the link gets the generic refusal, and the banker sees "Link locked" and reissues; the new link starts with a fresh allowance.
- **Row lock for concurrency:** each code request opens one transaction, locks the link row (`SELECT … FOR UPDATE`), checks the link is still usable, and only then acts and writes its audit events. Concurrent requests for one link queue, so ten simultaneous wrong guesses stop at exactly five with one `otp.locked` event, and the limits cannot overshoot. The link lock is always taken before the audit lock, matching reissue, so the two cannot deadlock.
- **Customer session:** a correct code starts a 15-minute session. The cookie `cs` holds a random 256-bit token (only its SHA-256 is stored) and is `HttpOnly; SameSite=Strict; Path=/u`, plus `Secure` over https. `Path=/u` keeps it off staff pages. A session works only while it is unended, unexpired, and its link is still active and unexpired, so reissuing or locking the link ends it at once.
- **Outbox as the mock SMS channel:** the SMS sender is an interface. The local adapter inserts the message into the `outbox` table inside the same transaction that records the code, so a code is never counted as sent without its message. `/dev/outbox` shows those messages and exists only when `MOCK_OUTBOX_ENABLED=true`. The outbox is the one place a raw code is stored, because it stands in for the customer's phone.

Customer events (`otp.sent`, `otp.send_refused`, `otp.verified`, `otp.verify_failed`, `otp.locked`) have the link as actor (`customer`) and target, and carry the request id. Their details hold counts and reasons only, never a code.

## Uploads

- **One file box per document type:** the upload form has one `multiple` file input for each requested type, named after the type. The box a file arrives through is its type, so every file is tagged without any client-side script (the content security policy allows none). An empty box counts as that type missing.
- **All or nothing:** the checks are a pure function over the whole submission and report every problem at once:
  - type from the first bytes only (PDF `%PDF-`, PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`); the name and the browser's content type are ignored, so an empty or 2-byte file is the wrong type;
  - at most 10 MB per file (exactly 10 MB is accepted);
  - 1 to 10 files;
  - every requested type present, and no file under a type that was not requested.

  Any problem refuses the whole submission with status 422 and the reasons listed against each file (`payslip.pdf: not a PDF, JPG or PNG file`, `Missing: Photo ID`). Nothing is stored, the session stays open for a retry, and `upload.rejected` is audited with each problem's type field and reason, never the file name.

- **Order of work:** hash (SHA-256) and scan every file first; an `infected` result refuses the submission (fail closed). Then write each object under `documents/<random UUID>`, with the content type taken from the detected type only (`application/pdf`, `image/png`, `image/jpeg`). Then commit one transaction: the document rows (with hash, scan result and `retention_until` = today + `RETENTION_DAYS`, in UTC), the end of the session, the link set to `used`, the request set to Received, one `document.uploaded` event per file and one `request.received`.
- **Re-check under the link lock:** the transaction locks the request row, then the link row, then re-reads the session. If the session or link stopped being usable while the files were being stored (the banker reissued, or a second tab submitted first), nothing is written and the customer gets the "session ended" page. Two tabs submitting at once: exactly one succeeds. The lock order (request, link, audit) matches reissue, so the two queue instead of deadlocking.
- **Cleanup of written objects:** every outcome other than success after objects were written (a refused re-check, a storage failure partway, a database error) deletes them, best effort. A scanner or storage failure answers 503 "We couldn't process your files right now. Please try again." with no rows written and the session still open.
- **File names:** the customer's file name is stored (up to 255 characters) for display only. It never forms part of a storage key and is escaped on every page.
- **Body size:** the server accepts request bodies up to 10 × 10 MB plus 1 MB of multipart overhead.

## Audit chain

- **Hashed fields:** every column except `seq` and `hash`: `at` (ISO-8601), `actorType`, `actorId`, `action`, `targetType`, `targetId`, `requestId`, `sourceIp`, `outcome`, `detail` and `prevHash`. Each event's `hash` is `sha256(prevHash + canonicalJson(fields))`.
- **Genesis:** the first event's `prevHash` is 64 zeros.
- **Canonical JSON:** keys sorted at every depth, no whitespace, arrays in order. Postgres `jsonb` reorders keys, so the hash must not depend on storage order.
- **Stored time is hashed time:** the app sets `at`, not a database default, so the stored value is the hashed value.
- **One writer at a time:** each append takes a Postgres transaction-scoped advisory lock, reads the latest hash, then inserts. Concurrent appends queue instead of forking the chain.
- **Same transaction:** an event commits or rolls back with the action it records. A failed sign-in changes nothing else, so its event gets a transaction of its own.
- **Verification** walks the events in order. It reports "intact, N events", or the first broken event and why: its content was edited (`hash_mismatch`), or it no longer links to the event before it (`link_mismatch`, after a deletion, a reorder or a recomputed hash).

Audited actions so far:

- Sign-in (`user.signed_in`), failed sign-in (`user.sign_in_failed`) and sign-out (`user.signed_out`).
- Requests: `request.created`, `request.viewed` (each time the detail page is shown) and `request.closed`.
- Links: `link.issued`, `link.revoked` (on reissue, before the new link's `link.issued`) and `link.refused` (an unusable link was opened; the real reason is recorded here only).
- Refusals: `access.denied`, with the action that was refused.
- One-time codes: `otp.sent`, `otp.send_refused`, `otp.verified`, `otp.verify_failed` and `otp.locked` (outcome `suspicious`).
- Downloads: `document.downloaded` (with the document's SHA-256), written after the bytes are read from storage and before they are sent. If it cannot be written, nothing is sent.
- Compliance: `audit.viewed`, each time a request's audit trail is shown.
- Uploads: `document.uploaded` (one per file: type, detected type, size and SHA-256), `request.received`, and `upload.rejected` (outcome `failure`, the problems without file names).

Link events carry the first 8 hex characters of the token's hash for correlation, never the token.

**Compliance audit page** (`GET /requests/:id/audit`, compliance only; others get the 403 page and an `access.denied` event):

- Above the table, the result of verifying the whole chain, not just this request's events: `Chain intact (N events)`, or `Chain broken at event #seq (content edited)` for an edited event and `(link broken)` for a deleted, reordered or re-hashed one.
- Every event with this request's id, in order: number, time (ISO-8601), actor (the user's name, `Customer` or `System`), action, target, outcome, source IP and the detail as JSON. All of it is escaped, so stored text shows as text.
- The request page shows compliance an "Audit trail" link to it.

## Authorisation

One function, `authorise(user, action, request)`, decides every access. It reads a single table:

| Action                                 | Banker                    | Compliance |
| -------------------------------------- | ------------------------- | ---------- |
| Create a request                       | Yes                       | No         |
| View a request, download its documents | Only requests they raised | Yes        |
| Reissue a request's link               | Only requests they raised | No         |
| Close a request                        | Only requests they raised | Yes        |
| View the audit trail                   | No                        | Yes        |

- Every route asks this function before acting, and pages ask it before showing a button. No page or query makes its own access decision; the request list keeps only the rows the policy lets the user view.
- **Denied and logged:** a refusal returns a plain 403 page ("You don't have access to this.") and writes an `access.denied` event with the user, the target, the source IP and the refused action. That event commits in its own transaction, because the action it records never happened.
- **State rules come after access:** reissue is allowed only while a request is open, and close only once it is received. Otherwise the answer is 409, and nothing changes.
- **Unknown or malformed request and document ids** get 404.
- **Downloads are gated on the scan:** a document whose scan is not `clean` answers 409 "This document is still being checked." for everyone, compliance included. The request page links a file name to its download only when the viewer may download it and it is clean.
- **A document row whose stored object is missing** answers 404 "This document isn't available." and logs an `ERROR` line with the document id, never the file name.
- **Concurrent changes queue:** reissue and close lock the request row first, so two reissues at once leave exactly one active link.

## Key trade-offs

- **Server-rendered pages over a browser app:** simpler and easier to secure, but plainer screens. See decisions D1.
- **Real Postgres and object storage in tests, not fakes:** the tests prove the actual database protections and storage behaviour. The cost is that Docker must be running to test.
- **Whole data model created up front:** later work adds behaviour, not tables, and the database permissions are granted once. The cost is that some tables exist before the code that uses them.
- **One submission per link:** a submission is all-or-nothing, so "single-use" is unambiguous. If the customer needs to send more, the banker raises a new request.
- **Synchronous scan step:** simple and enough for the always-clean mock. A real scanner would run asynchronously, with files held until clean.
- **Serialised audit writes:** guarantee one unbroken chain, but limit audit write throughput.

## Production and cloud shape

Assuming AWS in the Sydney region (ap-southeast-2) for data residency:

| Concern          | Local                               | Production                                                                                                                       |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| App              | `bun` process on a laptop           | Containers on ECS Fargate across availability zones, behind an Application Load Balancer with AWS WAF (TLS, HSTS, rate limiting) |
| Database         | Postgres 18 in Docker               | Amazon RDS for PostgreSQL, Multi-AZ, encrypted with KMS, automated backups and point-in-time recovery                            |
| Files            | RustFS                              | Amazon S3 with KMS encryption, Block Public Access, versioning, and lifecycle rules aligned to retention                         |
| Audit anchor     | —                                   | The latest audit hash copied regularly to an S3 bucket with Object Lock (write-once), so tail truncation is detectable           |
| SMS              | Outbox table and `/dev/outbox` page | An SMS provider (e.g. Amazon SNS or Pinpoint) behind the same interface; outbox page disabled                                    |
| Identity         | Mock sign-in                        | The bank's identity provider via OIDC, with roles mapped from groups                                                             |
| Malware scanning | Always-clean mock                   | Asynchronous scanning on upload, with quarantine                                                                                 |
| Secrets          | `.env` file                         | AWS Secrets Manager, injected at start-up                                                                                        |
| Monitoring       | Request log on stdout               | Central logs; alerts on lockouts, denied access and audit-chain breaks; feed to the bank's security monitoring (SIEM)            |
