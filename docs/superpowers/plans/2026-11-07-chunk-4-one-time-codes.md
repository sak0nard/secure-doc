# Chunk 4: One-Time Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer who opens a valid link can text themselves a one-time code (limited resends), enter it to start a short upload session, and is locked out after five wrong codes, with a suspicious-activity event logged.

**Architecture:**

- **`src/modules/otp/`** owns code generation, keyed hashing, the resend limit, verification with lockout, and customer upload sessions.
- **SMS** goes through a `SmsSender` port. The local adapter inserts into the `outbox` table _inside the same transaction_, so a code is never recorded as sent unless its message exists. `/dev/outbox` shows those messages.
- **Locking:** every code operation locks the link row (`SELECT … FOR UPDATE`) first, so concurrent requests for one link queue. Counters can't overshoot, and only one lock event is written.

**Tech Stack:** as chunks 1–3.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§5 otp_codes, customer_sessions, outbox; §6.2; §6.3; §7 customer routes)

**Depends on chunk 3 (merged; use these exact names):**

- `src/modules/requests/links.ts`: `resolveLink(db, token, now) → LinkResolution`, `REFUSED_LINK_TEXT`, `tokenHashPrefix(tokenHash)`
- `src/modules/audit/audit.ts`: `ActionContext = { actor; ip; now }`, `auditAction(tx, ctx, e)` (`appendAudit` with actor, IP and time from the context), `appendAudit`, `verifyChain`
- `src/modules/requests/status.ts`: `maskMobile(e164)`
- `src/web/routes/customer.tsx`: `customerRoutes(deps)` with `GET /u/:token` (the valid branch is a placeholder to replace) and `refusedLinkPage()`, which writes `link.refused`
- `tests/helpers.ts`:
  - `signIn(app, userId) → cookie`
  - `createRequestVia(app, { banker?, customer?, cookie? }) → { requestId, token, cookie }` (default: Alice for Dana, payslip)
  - `bodyText(res)`: decodes React's HTML escapes so tests can match wording like "don't"
  - `post(app, path, Record | [key, value][], opts)`

**Chunk 3 notes to respect:**

- **Register `/u/upload` explicitly.** Today it falls through to `/u/:token` and is refused as an unknown token.
- **Lock order:** take every row lock (link or request) **before** the first `appendAudit` or `auditAction` in a transaction. The audit advisory lock comes last; otherwise transactions can deadlock.
- **Mount order:** keep `customerRoutes` mounted before `requestRoutes` in `src/app.ts`, because `requireUser` is scoped inside `requestRoutes`.

## Global Constraints

- **Code format:** exactly 6 digits, uniform, from a CSPRNG with rejection sampling. Leading zeros are kept.
- **Code storage:** only `hmacHex(OTP_PEPPER, linkId + ":" + code)` (HMAC-SHA-256, hex) is stored. Raw codes appear only in the outbox row (the mock phone) and never in `otp_codes`, `audit_events` or logs.
- **Code lifetime:** 5 minutes. A code is valid iff `now < expiresAt` and it is unconsumed. Sending a new code consumes every earlier unconsumed code for that link.
- **Resend limit:** at most **3** codes per link in total, and at least **30 seconds** between sends (`now - lastCodeSentAt >= 30s` is allowed).
- **Responses to refused sends** (both 429):
  - limit: `Too many codes requested; contact your banker.`
  - cooldown: `Please wait a moment before requesting another code.`
  - Audit `otp.send_refused`, outcome `failure`, `detail { reason: "limit" | "cooldown" }`.
- **Lockout:**
  - Every failed verification (wrong, expired, consumed, missing or malformed code) adds 1 to `upload_links.failed_code_attempts`, across resends.
  - The 5th failure sets the link to `locked` and writes `otp.locked` with outcome `suspicious`.
  - Each failure also writes `otp.verify_failed` (outcome `failure`).
- **Verify responses:**
  - Wrong, not yet locked: 400 with `That code didn't work. Check it and try again, or request a new code.`
  - The locking attempt: 403 with `Too many incorrect codes. This link is now locked; contact your banker.`
  - Any later attempt on the link: the generic refusal (404 `REFUSED_LINK_TEXT`, `link.refused` reason `locked`).
- **Customer session cookie:**
  - `cs`, 32 random bytes base64url; only its SHA-256 is stored.
  - Attributes: `HttpOnly; SameSite=Strict; Path=/u; Max-Age=900`, plus `Secure` when `BASE_URL` is https.
  - A session is valid iff unended, `now < expiresAt` (15 minutes), and its link is still `active` and unexpired.
- **No session:** `/u/upload` without a valid session gives 403 with `Your upload session has ended. Open the link from your banker again.`
- **SMS body:** `Your secure document upload code is {code}. It expires in 5 minutes. We will never ask for this code by phone or email.`
- **Audit actor** for all customer events: `{ type: "customer", id: linkId }`, with `requestId` set. Actions: `otp.sent`, `otp.send_refused`, `otp.verified`, `otp.verify_failed`, `otp.locked`.
- **`/dev/outbox`:** mounted only when `MOCK_OUTBOX_ENABLED=true`; otherwise 404.
- **Testing:** test-first. Tests live in `tests/`; code lives in `src/`.
- **Formatting:** run `bun fmt` before each commit.
- **Wording:** documents never mention time limits.

## Review Focus

1. **Concurrent wrong guesses** against one link must stop at exactly 5 attempts and one `otp.locked` event. _Task 3 test._
2. **Malformed code input** (empty, 5 or 7 digits, letters, 5,000 characters) counts as a wrong attempt, never a 500. _Task 3 test._
3. **A reissued link must end any upload session** started on the old one. _Task 3 test._
4. **Exact time boundaries:**
   - a code at exactly 5 minutes is expired
   - a resend at exactly 30 seconds is allowed
   - a session at exactly 15 minutes is ended

   _Tasks 2–3 tests._

5. **Double-tapping "Text me a code"** sends one code; the second tap gets the cooldown message. _Task 2 test (covered by the cooldown test with no clock advance)._

---

## File Structure

```
src/ports/sms.ts                    SmsSender interface + outboxSms adapter
src/deps.ts                         (modify) add sms: SmsSender
src/modules/otp/codes.ts            generateCode, hmacHex, sendCode, verifyCode
src/modules/otp/sessions.ts         createCustomerSession, resolveCustomerSession, endCustomerSession
src/web/routes/customer.tsx         (modify) link page, POST code, POST verify, GET /u/upload placeholder
src/web/routes/dev.tsx              GET /dev/outbox
tests/otp-units.test.ts, tests/otp.test.ts
tests/helpers.ts                    (modify) createRequestVia documentTypes + linkId, latestOutboxCode()
evidence/*.md                       (modify)
```

---

### Task 1: Code generation and keyed hashing (pure units)

**Files:**

- Create: `src/modules/otp/codes.ts` (the pure part only)
- Test: `tests/otp-units.test.ts`

**Interfaces:**

- Produces:
  - `generateCode(nextUint32?: () => number): string`. It defaults to `crypto.getRandomValues`. It rejects values `>= 4_294_000_000` (the largest multiple of 10⁶ below 2³²) and returns `value % 1_000_000`, zero-padded to 6.
  - `hmacHex(key: string, message: string): string` (use `new Bun.CryptoHasher("sha256", key)`).
  - `hashCode(pepper: string, linkId: string, code: string): string` = `hmacHex(pepper, `${linkId}:${code}`)`.

- [ ] **Step 1: Write failing tests:**
  - `"codes are six digits and keep leading zeros"`: a source yielding `42` gives `"000042"`.
  - `"values that would bias the distribution are rejected"`: a source yielding `4_294_967_295`, then `4_294_000_000`, then `7` gives `"000007"`, and the source was called 3 times.
  - `"real codes are always six digits"`: 1,000 calls with the default source all match `/^\d{6}$/`.
  - `"the code hash depends on the link and the pepper"`: the same code with two link ids gives different hashes, and two peppers give different hashes. The output matches `/^[0-9a-f]{64}$/`.
  - `"the code hash is an HMAC, not a plain SHA-256"`: `hashCode(p, l, c) !== sha256Hex(`${l}:${c}`)`.
- [ ] **Step 2: Run** `bun test tests/otp-units.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat: one-time code generation and keyed hashing"`

---

### Task 2: Text me a code (send, resend limits, outbox)

**Files:**

- Create: `src/ports/sms.ts`, `src/web/routes/dev.tsx`
- Modify: `src/modules/otp/codes.ts`, `src/deps.ts`, `src/web/routes/customer.tsx`, `src/app.ts`, `tests/helpers.ts`
- Test: `tests/otp.test.ts`

**Interfaces:**

- Consumes: `resolveLink`, `REFUSED_LINK_TEXT`, `ActionContext`, `appendAudit`, `maskMobile`, `customers`, `uploadLinks`, `otpCodes`, `outbox`.
- Produces:
  - `interface SmsSender { send(tx: Tx, msg: { to: string; body: string; linkId: string }): Promise<void> }`; `outboxSms: SmsSender`.
  - `Deps` gains `sms: SmsSender`. `buildDeps` uses `outboxSms`.
  - `sendCode(tx: Tx, ctx: ActionContext, linkId: string, opts: { pepper: string; sms: SmsSender }): Promise<{ sent: true; maskedMobile: string } | { sent: false; reason: "limit" | "cooldown" }>`
    - Locks the link row, checks the limits, consumes earlier codes, inserts the new code hash, updates `codesSent` and `lastCodeSentAt`, sends, and writes the audit event.
  - Test helpers:
    - Extend `createRequestVia` with a `documentTypes?: DocumentType[]` option (default `['payslip']`) and add `linkId` to its result. The link id is found by `sha256Hex(token)`.
    - `latestOutboxCode(linkId): Promise<string | null>`. Pulls the 6 digits from the newest outbox body.

**Pages:**

- `GET /u/:token` (valid):
  - Heading `Secure document upload`, the requested document types, and `We'll text a code to {maskedMobile}`.
  - A form POSTing to `/u/:token/code` with the button `Text me a code`.
  - If `codesSent > 0`, the code entry form too.
- `POST /u/:token/code`, on success: 200 with `We sent a code to {maskedMobile}`, then the code form (`name="code"`, `inputmode="numeric"`, `autocomplete="one-time-code"`) POSTing to `/u/:token/verify`, plus a resend button.

- [ ] **Step 1: Write failing tests** in `tests/otp.test.ts` (`beforeEach(resetDb)`; use an injected clock throughout):
  - `"opening a valid link offers to text a code and sends nothing"`: GET → 200, contains `Text me a code` and `+•••••••••01`; the outbox has 0 rows.
  - `"requesting a code texts the mobile on the customer record"`:
    - POST code → 200. The outbox has one row with `toMobile "+61400000101"` and a body matching the SMS template.
    - The `otp_codes.codeHash` equals `hashCode(config.otpPepper, linkId, code)`.
    - The code string appears in no `otp_codes` or `audit_events` row.
    - There is one `otp.sent` event with actor `customer`/linkId and `requestId` set.
  - `"codes are at least 30 seconds apart"`: send, then send again with no clock change → 429 cooldown text, an `otp.send_refused` event with reason `cooldown`, and 1 outbox row. At +30s → 200, 2 rows.
  - `"at most three codes per link"`: send 3 times, 30s apart, then a 4th at +30s → 429 limit text, reason `limit`, 3 outbox rows.
  - `"codes cannot be requested on a refused link"`: reissue, then POST code with the old token → 404 `REFUSED_LINK_TEXT`, 0 outbox rows.
  - `"outbox page lists codes only when the mock is enabled"`: with the test config (enabled), `GET /dev/outbox` → 200 and the body contains the sent code. With `testApp({ config: { ...config, mockOutboxEnabled: false } })` → 404.
- [ ] **Step 2: Run** `bun test tests/otp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The send route wraps `sendCode` and the response choice in one transaction. A refused send's audit event commits too, because nothing throws.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: text a one-time code with resend limits and mock outbox"`

---

### Task 3: Verify, lock out, start the upload session

**Files:**

- Create: `src/modules/otp/sessions.ts`
- Modify: `src/modules/otp/codes.ts`, `src/web/routes/customer.tsx`
- Test: `tests/otp.test.ts` (extend)

**Interfaces:**

- Produces:
  - `verifyCode(tx: Tx, ctx: ActionContext, linkId: string, submitted: string, pepper: string): Promise<"verified" | "wrong" | "locked">`
    - Locks the link row.
    - Finds the newest unconsumed code with `now < expiresAt` and compares hashes in constant time (`crypto.timingSafeEqual` on the hex buffers).
    - On success, consumes the code and writes `otp.verified`.
    - On failure, increments the counter and writes `otp.verify_failed`. At 5 it locks the link and writes `otp.locked` (`suspicious`).
    - Submitted values not matching `/^\d{6}$/` skip the lookup and count as wrong.
  - `createCustomerSession(tx, linkId: string, now: Date): Promise<{ token: string }>`
  - `resolveCustomerSession(db: Db | Tx, token: string | undefined, now: Date): Promise<{ sessionId: string; linkId: string; requestId: string } | null>`. Chunk 5 calls this.
  - `endCustomerSession(tx, sessionId: string, now: Date): Promise<void>`. Chunk 5 calls this on submit.
  - `CUSTOMER_COOKIE = "cs"`
- **Routes:**
  - `POST /u/:token/verify`:
    1. `resolveLink`. If refused → the generic refusal plus `link.refused`, as in chunk 3.
    2. `verifyCode`. On `verified` → `createCustomerSession`, set the `cs` cookie, then `303 /u/upload`.
  - `GET /u/upload`: with a valid session → 200 with the placeholder `Upload your documents` (chunk 5 replaces it). Otherwise → 403 with the session-ended text.

- [ ] **Step 1: Write failing tests** (extend `tests/otp.test.ts`; helper `verify(app, token, code)`):
  - `"the correct code starts a short upload session"`:
    - → 303 to `/u/upload`. `set-cookie` has `cs=`, `HttpOnly`, `SameSite=Strict`, `Path=/u`, `Max-Age=900` and no `Secure`.
    - The `customer_sessions.tokenHash` equals `sha256Hex(cookie)`.
    - `GET /u/upload` with the cookie → 200, and there is an `otp.verified` event.
  - `"a code works only once"`: verify correctly, then verify the same code again → 400, and `failed_code_attempts` is 1.
  - `"a code expires after five minutes"`: send at t; verify at t+5m → 400; a new code at t+5m verifies.
  - `"a new code replaces the previous one"`: send A; at +30s send B; verify A → 400; verify B → 303.
  - `"AC-6: five wrong codes lock the link and log a suspicious-activity event"`:
    - Four wrong → 400 each. The 5th wrong → 403 with the locked text.
    - The link `state` is `locked`, and there is exactly one `otp.locked` event with outcome `suspicious` and `requestId` set.
    - The correct code after that → 404 `REFUSED_LINK_TEXT`, and the `link.refused` reason is `locked`. `GET /u/:token` → 404.
    - The banker's `/` shows `Link locked`.
  - `"wrong attempts count across resends"`: 3 wrong; resend at +30s; 2 wrong → locked.
  - `"concurrent wrong guesses stop at five"`: `Promise.all` of 10 wrong verifies → `failed_code_attempts` is 5 and there is exactly 1 `otp.locked` event. No response is 500.
  - `"malformed codes count as wrong and never error"`: `""`, `"12345"`, `"1234567"`, `"abcdef"` and `"1".repeat(5000)` → the first four get 400 and the fifth gets the 403 locked page; the counter ends at 5 and the link is locked
  - `"upload session needs a valid cookie"`: no cookie → 403; `cs=garbage` → 403.
  - `"upload session ends after fifteen minutes"`: at +15m → 403.
  - `"reissuing the link ends an upload session on the old link"`: verify, the banker reissues, then `GET /u/upload` with the old `cs` → 403.
  - `"a locked request gets a fresh allowance after reissue"`: lock the link, the banker reissues, and the new link can send and verify a code.
- [ ] **Step 2: Run** `bun test tests/otp.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `bun test && bun run typecheck && bun fmt --check`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "feat: verify one-time codes with lockout and customer upload session"`

---

### Task 4: Evidence

**Files:**

- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/decisions.md`, `evidence/operate.md`

- [ ] **Step 1: `design.md`.**
  - In the security table, the rows for forwarded link, code guessing and database leak (codes, customer sessions) become _Built_.
  - Add a "One-time codes" subsection:
    - keyed hash
    - lifetime
    - resend limits
    - lockout across resends
    - row lock for concurrency
    - the session cookie scope (`Path=/u`)
    - the outbox as the mock SMS channel, sent in the same transaction
- [ ] **Step 2: `verify.md`.**
  - Record the real results.
  - Add a "One-time codes and customer sessions" test group.
  - Mark AC-6 _Met_.
- [ ] **Step 3: `decisions.md` D4.** Note that the outbox insert shares the transaction. In production that becomes a transactional outbox drained by an SMS relay, so a code is never counted as sent without a message.
- [ ] **Step 4: `operate.md`.**
  - Describe `/dev/outbox` and that it must be off in production (`MOCK_OUTBOX_ENABLED=false`).
  - Explain what a banker does when a customer is locked out (reissue).
  - Note that rotating `OTP_PEPPER` invalidates outstanding codes only.
- [ ] **Step 5: Commit**: `git commit -m "docs: record one-time codes in evidence"`
