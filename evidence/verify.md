# Verification

## How to run the checks

```bash
bun run services     # Postgres and RustFS in Docker, plus the storage buckets
bun test             # migrates the test database, then runs every test
bun run typecheck
```

The tests run against real Postgres and RustFS in Docker, not in-memory fakes. They drive the app through its HTTP interface (`app.handle(new Request(...))`) without opening a port. Each database test starts from an emptied, re-seeded database.

## Latest results

Run on 2026-11-07 against the final commit, with the services freshly created from empty volumes:

| Check                                  | Result                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test`                             | 187 pass, 0 fail (17 files, 1607 assertions)                                                                                                    |
| `bun run typecheck`                    | No type errors in 54 files                                                                                                                      |
| `bun fmt --check`                      | All 250 files are formatted                                                                                                                     |
| `bun audit --audit-level=high`         | No vulnerabilities at high or above. One moderate advisory: esbuild's dev server, pulled in by drizzle-kit (dev-only; we never run that server) |
| `bunx drizzle-kit generate`            | No schema changes: the committed migrations match the schema                                                                                    |
| Clean start following only `README.md` | Every command exits 0 from a fresh clone with empty volumes; the bucket job creates both buckets                                                |

## What the tests prove

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
- A real browser form post, which sends `Origin: null` because of `Referrer-Policy: no-referrer`, is accepted only with `Sec-Fetch-Site: same-origin`. `Origin: null` from another site, or with no `Sec-Fetch-Site`, is refused, and so is a foreign `Origin`, whatever `Sec-Fetch-Site` claims.
- Link tokens are masked even on malformed or oddly cased paths (`//u/<token>`, `/U/<token>`, any token-shaped segment).
- Database errors are logged without their bound parameters, so codes, hashes and mobiles never reach the error log.

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

**Authorisation** (`tests/policy.test.ts`)

- One row per role, action and ownership covers every cell of the policy: a banker may create requests and view, reissue, close and download on their own requests only; compliance may view, close, download and see the audit trail, but may not create or reissue; a banker may not see the audit trail.
- An action about a request is refused when no request is given.

**Request status** (`tests/status.test.ts`)

- An open request with a usable link shows as Open; once the link reaches its expiry it shows as Expired.
- A locked link keeps the request Open, flagged as locked.
- Received and Closed ignore the link.
- Mobile numbers are masked to the last two digits.

**Requests and links** (`tests/requests.test.ts`, `tests/links.test.ts`)

- A banker creates a request and the link appears on that one response (AC-1). Only the SHA-256 of the token is stored; the token is in no link row, no audit event, the request page or the list.
- Creating a request writes `request.created` then `link.issued`, by the banker.
- Selected document types are stored once each. No types, an unknown type, an unknown customer or a malformed customer id is refused with 400 and creates nothing.
- Compliance cannot create a request: 403, nothing created, and an `access.denied` event.
- Bankers see only their own requests; compliance sees all. Only bankers get the "New request" link.
- The owning banker and compliance can open a request; the mobile number is masked, and each view writes `request.viewed`. Another banker gets 403 and an `access.denied` event (AC-7 for request pages).
- A malformed or unknown request id gets 404, never a 500.
- Reissue revokes the old link and shows a new one once; the audit order is `link.revoked`, then `link.issued`. Another banker and compliance cannot reissue, and each attempt is logged.
- Two reissues at the same moment both succeed and leave exactly one active link.
- An open request whose link has passed its expiry shows as Expired; reissuing makes it Open again.
- Reissue is refused (409) once a request is received; close is refused (409) unless it is received. Closing writes `request.closed`. Compliance can close; another banker cannot.
- A locked link is flagged on the list and on the request page.
- A fresh link opens (AC-5 counterpart). A revoked, expired or locked link gets the generic "no longer valid" page with status 404 (AC-5), and a `link.refused` event records the real reason.
- An unknown or hostile token (one character, 5,000 characters, `%00`, `..%2F..%2Fetc`, non-ASCII) gets exactly the same page, never a 500.
- Refusal events hold an 8-character hash prefix, never the token.
- Link pages, valid or refused, send `Referrer-Policy: no-referrer`.

**One-time codes and customer sessions** (`tests/otp-units.test.ts`, `tests/otp.test.ts`)

- Codes are six digits and keep leading zeros. Random values that would bias the distribution are rejected and redrawn. 1,000 real codes are all six digits.
- The stored code hash depends on the link and on the pepper, and is an HMAC, not a plain SHA-256.
- Opening a valid link offers "Text me a code" with the masked mobile and sends nothing.
- Requesting a code texts the mobile on the customer's record with the agreed wording. The stored hash matches the code, and the code appears in no `otp_codes` row and no audit event. One `otp.sent` event has the link as actor and the request id.
- A second code within 30 seconds is refused (429, `otp.send_refused` with reason `cooldown`, no message sent); at exactly 30 seconds it is sent. This also covers a double tap.
- A fourth code is refused (429, reason `limit`).
- A reissued link cannot request codes; it gets the generic refusal.
- `/dev/outbox` shows sent codes when the mock is enabled and is 404 otherwise.
- The correct code redirects to the upload page and sets `cs` with `HttpOnly`, `SameSite=Strict`, `Path=/u` and a 15-minute `Max-Age`; `Secure` is added only over https. Only the SHA-256 of the session token is stored, and `otp.verified` is written.
- A code works only once; a second use counts as a wrong attempt.
- A code works just before 5 minutes and is expired at exactly 5 minutes; a new code then works.
- A new code replaces the previous one.
- AC-6: four wrong codes get "didn't work" (400); the fifth gets the locked page (403). The link is `locked`, there is exactly one `otp.locked` event with outcome `suspicious`, and five `otp.verify_failed` events. Afterwards even the correct code gets the generic refusal, recorded as `link.refused` with reason `locked`, and the banker's list shows "Link locked".
- Wrong attempts count across resends: three, then a new code, then two more lock the link.
- Ten simultaneous wrong guesses stop at exactly five attempts and one `otp.locked` event, with no 500.
- Empty, 5-digit, 7-digit, alphabetic and 5,000-character codes, and a missing field, count as wrong attempts and never error.
- `/u/upload` without a cookie or with a garbage cookie gets 403 with the "session has ended" page.
- The upload session works just before 15 minutes and has ended at exactly 15 minutes.
- Reissuing the link ends an upload session started on the old link.
- After a lockout and a reissue, the new link can send and verify a code.

**Uploads** (`tests/storage.test.ts`, `tests/checks.test.ts`, `tests/uploads.test.ts`)

- Storage (real RustFS, test bucket): stored bytes come back unchanged; a missing object reads as null; a deleted object is gone, and deleting it again is not an error. The mock scanner passes everything.
- Types are recognised from content only: PDF, PNG and JPEG fixtures are recognised; Windows (`MZ`) and Linux (ELF) executables, an empty file and a 2-byte `%P` are not.
- An executable named `payslip.pdf` is rejected (AC-3, unit). A PDF of 10 MB + 1 byte is rejected; exactly 10 MB is accepted (AC-4, unit).
- Every requested type needs a file (`Missing: Photo ID`); a file under an unrequested or unknown type is rejected; 11 files are rejected; all problems are reported together; accepted files carry their document type and detected type.
- The upload page has one `multiple` file input per requested type, the size note and "Send documents".
- AC-2: after a valid link and the correct code, the customer uploads a PDF payslip and a JPEG photo ID. Two document rows hold the right type, detected type, size, SHA-256, `clean` scan status and a retention date 2555 days ahead; each key is `documents/<uuid>`; the stored object has the same bytes; the request is Received on the banker's list.
- Submitting uses up the link and ends the session: the upload page and a second submit get 403. AC-5: opening the used link gets the generic refusal, recorded with reason `used`.
- Uploads are audited: one `document.uploaded` per file (with SHA-256, no file name) and one `request.received`; the chain verifies.
- AC-3: a renamed executable sent as `application/pdf` gets 422 with `payslip.pdf: not a PDF, JPG or PNG file` and the form again; nothing is written to storage or the database; `upload.rejected` records the problem without the file name; a retry with valid files succeeds.
- AC-4: a 10 MB + 1 byte file gets 422 with `big.pdf: larger than 10 MB`; nothing stored.
- Only a payslip for a payslip-and-photo-ID request gets 422 with `Missing: Photo ID`. A file box left empty counts as missing, not as a bad file.
- A hostile file name (`../../etc/<b>x</b>.pdf`) is accepted as a display name only: the key is random, and the banker's page shows it escaped.
- An infected result refuses the whole submission (422, `failed the security scan`); nothing is written.
- A storage failure on the second file answers 503 with the retry text; the first object is deleted, no rows are written, and a retry succeeds.
- A scanner failure answers 503 (fail closed); nothing is written.
- A reissue that lands while the files are being stored refuses the submit (403); the written objects are deleted and no rows are written.
- Two tabs submitting at once on one session: exactly one gets 200 and the other 403; only the winner's documents exist, and the loser's objects are deleted.
- The banker's request page lists each document's file name, type and scan status.

**Downloads** (`tests/download-name.test.ts`, `tests/download.test.ts`)

- Download names: ordinary names are kept; the extension always comes from the detected type (`scan.PNG` detected as JPEG downloads as `scan.jpg`). Quotes, CR/LF, `;`, path separators and non-ASCII characters are replaced, so the `Content-Disposition` header has no line break. A name with nothing left becomes `document`; names are capped at 80 characters plus the extension.
- The requesting banker downloads a document: 200, the same bytes that were uploaded, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="…"` and `nosniff`. One `document.downloaded` event records the banker, the document, the request and the SHA-256.
- AC-7: another banker gets 403 with the generic page and no document bytes; an `access.denied` event records Bob, the document, the request and the refused action `document.download`.
- Compliance can download any document.
- A document whose scan is still pending answers 409 "This document is still being checked." to the banker and to compliance, and writes no download event.
- A document row whose object is missing answers 404 "This document isn't available." and logs an `ERROR` line with the document id but not the file name.
- When the download's audit event cannot be written, the answer is the generic 500 and no bytes are sent.
- A customer upload-session cookie gives no staff access: `/documents/:id` redirects to `/login`.
- Malformed and unknown document ids get 404.
- On the request page, a file name links to its download for the banker and compliance only while the document is clean; while pending, it is plain text with `pending` shown.

**Compliance audit trail** (`tests/compliance.test.ts`, `tests/requests.test.ts`)

- AC-8: after a full journey (create, code, verify, upload, the banker downloads), compliance downloads the document and opens the audit page. It lists `request.created`, `link.issued`, `otp.sent`, `otp.verified`, `document.uploaded`, `request.received` and `document.downloaded` in that order, names Alice and the customer as actors, shows the source IP column and "Chain intact". Viewing it writes `audit.viewed`.
- After an event's detail is edited as the database owner, the page shows `Chain broken at event #<that event> (content edited)`.
- The owning banker is refused the audit page (403), and an `access.denied` event records the refused action `audit.view`.
- The page shows only this request's events.
- A user named `<script>x</script>` appears escaped.
- Unknown and malformed request ids get 404.
- Only compliance sees the "Audit trail" link on the request page.
- The link line on the request page reads `Link: active until <ISO time>` while the link is usable, and `Link: locked`, `Link: used` or `Link: expired` otherwise.

## Acceptance criteria

| Acceptance criterion                                                     | Status                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A banker creates a request and sees the upload link exactly once         | Met: "AC-1: banker creates a request and sees the upload link exactly once"                                                                                                                                                                                                                |
| A valid link plus the correct code lets the customer upload a PDF        | Met: "AC-2: a valid link plus the correct code lets the customer upload a PDF"                                                                                                                                                                                                             |
| A renamed executable with a .pdf extension is rejected                   | Met: "AC-3: a renamed executable is rejected and nothing is stored"                                                                                                                                                                                                                        |
| A file over 10 MB is rejected                                            | Met: "AC-4: a file over 10 MB is rejected"                                                                                                                                                                                                                                                 |
| A used, expired or reissued link is refused                              | Met: "AC-5: a used link is refused", "AC-5: a reissued (revoked) link is refused", "AC-5: an expired link is refused"                                                                                                                                                                      |
| Five wrong codes lock the link and log a suspicious-activity event       | Met: "AC-6: five wrong codes lock the link and log a suspicious-activity event"                                                                                                                                                                                                            |
| Another banker gets access denied, and the attempt is logged             | Met: "another banker is denied the detail page, and the attempt is logged", "AC-7: another banker is denied the document and the attempt is logged"                                                                                                                                        |
| Compliance can view the document and the full audit trail                | Met: "AC-8: compliance can view the document and the full audit trail"                                                                                                                                                                                                                     |
| Editing or deleting an audit event breaks the hash chain and is detected | Met: "AC-9: editing an audit event is detected", "AC-9: editing an event and recomputing its hash is detected", "AC-9: deleting an audit event is detected". Deleting only the newest events is not detected by the chain alone; this needs the owner role and is an accepted risk (below) |

Every acceptance criterion is met, each by a named test.

## Manual walkthrough

The main journey and three alternate journeys were run by hand in Chromium against a fresh clone started from empty volumes. Customer pages were checked at phone width (360 px, Chromium mobile emulation): none scrolls sideways. Safari/WebKit was not tested.

| Step                                                                      | Screenshot                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Alice signs in (real browser form post)                                   | `screenshots/01-sign-in.png`                                              |
| Alice requests a payslip and photo ID from Dana                           | `screenshots/02-new-request.png`                                          |
| The upload link is shown once                                             | `screenshots/03-link-shown-once.png`                                      |
| Dana opens the link on a phone                                            | `screenshots/04-customer-link-phone.png`                                  |
| The code arrives in the mock outbox                                       | `screenshots/05-mock-outbox.png`                                          |
| Dana enters the code                                                      | `screenshots/06-enter-code-phone.png`                                     |
| Alternate: a renamed executable is rejected with its reason               | `screenshots/07-alt-renamed-executable-rejected.png`                      |
| Dana uploads a PDF and a JPG                                              | `screenshots/08-upload-phone.png`, `screenshots/09-upload-done-phone.png` |
| Alternate: the used link is refused                                       | `screenshots/10-alt-used-link-refused.png`                                |
| Alice sees Received and the documents, and downloads one as an attachment | `screenshots/11-banker-request-received.png`                              |
| Bob is refused the request and the document                               | `screenshots/12-other-banker-denied.png`                                  |
| Carol sees the full audit trail and "Chain intact (17 events)"            | `screenshots/13-compliance-audit-trail.png`                               |
| Alternate: five wrong codes lock the link                                 | `screenshots/14-alt-five-wrong-codes-locked.png`                          |
| Alice sees "Link locked: reissue required"                                | `screenshots/15-banker-sees-link-locked.png`                              |
| Alternate: after a reissue, the old link is refused                       | `screenshots/16-alt-reissued-link-refused.png`                            |

## Review findings

Two fresh reviews ran over the finished code, in addition to an earlier review of the foundation.

**Independent code review** (everything after the foundation): no critical issues. Lock order, the single authorisation point, the upload pipeline and every AC test were judged sound. Fixed, each with a test that failed first:

- Link tokens reached the request log on malformed paths such as `//u/<token>` or `/U/<token>`.
- A database error message could carry bound parameters, including a raw code, into the error log.
- An unknown upload field name of any length was copied into the permanent audit log; it is now recorded as `(other)`.

**Security review** (whole codebase, using the security-review method): no high or medium findings. Fixed:

- Local Docker ports listened on every network interface with published placeholder passwords; they now listen on 127.0.0.1 only.
- CI actions were pinned to movable tags; they are now pinned to commit SHAs.

The reviews' remaining minor points are listed under known gaps.

## Known gaps

- **Audit tail truncation:** deleting the newest audit events cannot be detected by the hash chain alone. Production fix: periodically anchor the latest hash in write-once storage.
- **Future tables aren't automatically granted** to the app role; every table exists today, but a later table would need its own grant.
- **Log timing:** request log lines are written just after the response is sent, so two tests wait 5 ms before checking. This could be flaky on a heavily loaded machine.
- **Request list scale:** the list reads every request and keeps the ones the policy allows, so the policy stays the only access decision. At production volumes it needs a database filter derived from the same policy, and paging.
- **Orphan objects:** objects are written before the database transaction commits. A crash between the write and the commit (or a failed best-effort delete) leaves an object with no `documents` row. It is unreachable, because every read goes through a row; in production the purge job would sweep keys with no row.
- **Body size limit is configuration only:** the 101 MB request-body cap is set on the server, but the tests drive the app without a server, so it is not exercised.
- **Audit trail queries:** the portal shows the audit trail for one request at a time. Filtering by actor or date range is a production addition (NFR auditability); until then it is a database query (see operate.md).
- **Chain verification cost:** the audit page verifies the whole chain on every view. That is fine at slice scale; in production it would verify incrementally from the last anchored hash.
- **Not tested:** load, availability, accessibility (WCAG 2.1 AA), and behaviour behind a real TLS proxy.
- **Browsers without Fetch Metadata are refused on every form post.** Under `no-referrer` they send `Origin: null` and no `Sec-Fetch-Site`, for example Safari on iOS before 16.4. A per-form CSRF token would cover them.
- **Some refusals are not audited:** reissue or close in the wrong state (409), the scan gate on download (409), and a non-multipart upload body (400). Successful link opens and upload-page views are not audited either, so link previewers don't flood the log.
- **`HEAD /documents/:id`** runs the download and writes a `document.downloaded` event without sending a body: extra events, never a missing one.
- **Failed cleanup is silent:** if deleting an object after a failed upload also fails, nothing is logged.
- **Mock login has no switch:** unlike the outbox page, the mock sign-in route is always on and lets anyone sign in as any seeded user. It must be removed before any shared deployment.
- **Unbounded request body on every route:** the 101 MB cap applies to all routes; rate and size limits are assumed at the infrastructure layer.
- **The audit trail's AC-8 test checks the compliance download's status only;** the byte-for-byte check is in the download tests.

## Accepted risks

- **The database owner can empty, rewrite or truncate the newest part of the audit table.** The row trigger does not block TRUNCATE, the owner can disable the trigger, and deleting only the newest events leaves an intact-looking chain. The app's role can do none of this. Accepted: the owner role is held only by the migration pipeline, not by the running app or day-to-day staff, and locally the database listens on 127.0.0.1 only. Production would anchor the latest hash in write-once storage.

## Local versus pipeline

The pipeline is defined in `.github/workflows/ci.yml`. It has not been run here (the repository has no remote); every command in it was run locally and passes.

| Check                                                  | Locally                                        | In `ci.yml`                                                                |
| ------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Format                                                 | `bun fmt --check`                              | Yes                                                                        |
| Type check                                             | `bun run typecheck`                            | Yes                                                                        |
| Dependency audit, failing on high or critical          | `bun audit --audit-level=high`                 | Yes                                                                        |
| Unit and integration tests against Postgres and RustFS | `bun test` against Docker services             | Yes, as job services set up with the same init script and bucket           |
| Migrations match the schema                            | `bunx drizzle-kit generate` produces no change | Yes, failing on any diff                                                   |
| Browser walkthrough of the main journey                | By hand with Playwright (above)                | Planned: automate against a deployed preview                               |
| Secret scanning                                        | —                                              | Planned: GitHub secret scanning or gitleaks, enabled at organisation level |
| Static analysis for security (SAST)                    | Security review (above)                        | Planned: CodeQL or semgrep                                                 |
| Container image scan                                   | —                                              | Planned: on the release image, once one is built                           |
