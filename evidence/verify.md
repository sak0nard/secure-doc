# Verification

## How to run the checks

```bash
bun run services     # Postgres and RustFS in Docker
bun test             # migrates the test database, then runs every test
bun run typecheck
```

The tests run against real Postgres and RustFS in Docker, not in-memory fakes. They drive the app through its HTTP interface (`app.handle(new Request(...))`) without opening a port. Each database test starts from an emptied, re-seeded database.

## Latest results

| Check               | Result                                       |
| ------------------- | -------------------------------------------- |
| `bun test`          | 127 pass, 0 fail (11 files, 1389 assertions) |
| `bun run typecheck` | No type errors                               |

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

## Acceptance criteria

| Acceptance criterion                                                     | Status                                                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A banker creates a request and sees the upload link exactly once         | Met: "AC-1: banker creates a request and sees the upload link exactly once"                                                                                 |
| A valid link plus the correct code lets the customer upload a PDF        | Not yet built                                                                                                                                               |
| A renamed executable with a .pdf extension is rejected                   | Not yet built                                                                                                                                               |
| A file over 10 MB is rejected                                            | Not yet built                                                                                                                                               |
| A used, expired or reissued link is refused                              | Partly met: "AC-5: a reissued (revoked) link is refused", "AC-5: an expired link is refused". The used case comes with uploads                              |
| Five wrong codes lock the link and log a suspicious-activity event       | Met: "AC-6: five wrong codes lock the link and log a suspicious-activity event"                                                                             |
| Another banker gets access denied, and the attempt is logged             | Partly met for request pages: "another banker is denied the detail page, and the attempt is logged". Documents come later                                   |
| Compliance can view the document and the full audit trail                | Not yet built                                                                                                                                               |
| Editing or deleting an audit event breaks the hash chain and is detected | Met: "AC-9: editing an audit event is detected", "AC-9: editing an event and recomputing its hash is detected", "AC-9: deleting an audit event is detected" |

Each criterion will get its own named test.

## Known gaps

- **Audit tail truncation:** deleting the newest audit events cannot be detected by the hash chain alone. Production fix: periodically anchor the latest hash in write-once storage.
- **Future tables aren't automatically granted** to the app role; every table exists today, but a later table would need its own grant.
- **Log timing:** request log lines are written just after the response is sent, so two tests wait 5 ms before checking. This could be flaky on a heavily loaded machine.
- **Request list scale:** the list reads every request and keeps the ones the policy allows, so the policy stays the only access decision. At production volumes it needs a database filter derived from the same policy, and paging.
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
