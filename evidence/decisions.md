# Decisions

Short records of the choices that shape the portal. Each says what was decided, why, and what it costs.

## D1. Server-rendered pages instead of a browser app

**Decision:** pages are React JSX rendered to HTML on the server by Elysia. Forms post back to the server. There is no client-side app, hydration or JSON API.

**Why:**
- The review is about security logic, and server-side rendering keeps every rule in one place a reviewer can read.
- React escapes every interpolated value, which closes the most common XSS mistake by default.
- There's no client state, no token handling in the browser and no second surface to secure.

**Alternatives:**
- **A React browser app with a JSON API:** smoother screens and Zod schemas shared by both sides, but two surfaces to build and review.
- **A plain Bun server with no framework:** no dependencies, but hand-rolled escaping, cookies and routing.

**Cost:** the pages are plain. Anything interactive, such as upload progress, needs a small script allowed by the content security policy.

## D2. Secrets are stored only as hashes; one-time codes use a keyed hash

**Decision:**
- Upload link tokens, customer session tokens and user session tokens are random 256-bit values, stored only as SHA-256.
- One-time codes are stored as HMAC-SHA-256 with a server-side secret (`OTP_PEPPER`), bound to the link.

**Why:**
- A leaked database must not give anyone a usable link or session. A 256-bit token cannot be recovered from its SHA-256.
- A 6-digit code is different: there are only a million possibilities, so a plain SHA-256 can be reversed by trying them all in moments.
- Keying the hash means a database leak alone reveals nothing. This still meets the requirement that codes are stored only as SHA-256-based hashes.

**Cost:**
- The raw link is shown to the banker once and can never be shown again; a lost link means a reissue.
- Rotating `OTP_PEPPER` invalidates codes already sent. That's acceptable because codes last 5 minutes.

## D3. The audit log is protected in the database, not only in code

**Decision:** three layers protect the audit log.
1. **Hash chain:** each event stores the hash of the previous one, so an edit or a deletion in the middle breaks the chain.
2. **Database permissions:** the app's database role may only insert and read audit rows; it has no update, delete or truncate rights.
3. **Trigger:** a trigger rejects any update or delete, even from the owner role.

Appends are serialised with a Postgres advisory lock so concurrent events can't fork the chain. Each event is written in the same transaction as the change it records.

**Why:**
- The chain makes tampering *detectable*, and the permissions and trigger make it *hard*.
- Writing the event in the same transaction means there is never an action without its event, or an event for an action that rolled back.

**Cost:**
- Deleting the most recent events (tail truncation) can't be detected by the chain alone. Production should periodically copy the latest hash to write-once storage.
- The advisory lock serialises every audit write. That is fine at this scale but is a known scaling point.

## D4. The customer asks for the code, and resends are limited

**Decision:**
- Opening the link shows a "Text me a code" button; the code is sent when the customer presses it, not when the page loads.
- A customer may request a new code: at most 3 codes per link, at least 30 seconds apart.
- Five wrong codes in total, across all resends, lock the link.

**Why:**
- Email security scanners and link previewers open links automatically. Sending on page load would spend the customer's code allowance and send unwanted texts.
- Allowing a new code when one expires is standard for one-time codes. Without it, a customer who is a few minutes late needs the banker to reissue the link.

**Cost:**
- The customer flow has one extra tap, which differs from the literal wording of FR-5.
- Code resends (FR-7) were originally out of scope; they are now in scope.

## D5. Expired is worked out when read, not stored

**Decision:** a request's stored status is only `open`, `received` or `closed`. "Expired" is shown when a request is open and its latest link has passed its 72-hour expiry. It's computed in one place whenever a request is read.

**Why:** there's no background job to run, monitor or fail, and the status can't drift from the link's real expiry.

**Cost:** queries that filter on "expired" have to use the same expression rather than a simple column match.

## Intentionally not built

| Not built | Why | Production path |
| --- | --- | --- |
| Retention purge job (FR-15) | The retention date is recorded on every file, so deletion can be added without data changes | Scheduled job deletes expired files and writes an audit event for each |
| Banker notifications (FR-16) | Status is visible in the portal | Email or in-app notification on upload |
| Real malware scanning (FR-17) | The scan step exists and always passes | Asynchronous scan with quarantine; files viewable only once clean |
| Real SMS | Codes appear on a mock outbox page | SMS provider behind the same interface |
| Single sign-on | Mock sign-in with seeded users and roles | The bank's identity provider via OIDC; sessions and authorisation code unchanged |
| Cancellation, legal hold, bulk requests | Outside the requested scope | — |
| Encryption at rest, TLS, rate limiting, WCAG testing | Assumed at the infrastructure layer or outside scope | Managed encrypted storage with KMS, TLS at the load balancer, WAF rate limits, accessibility audit |
