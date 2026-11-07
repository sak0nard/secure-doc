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

Verification reports the first broken event and why (edited content, or a broken link to the event before it). The tamper tests act as a privileged attacker: as the owner, with the trigger disabled inside their own transaction, so the trigger itself is never weakened.

**Why:**

- The chain makes tampering _detectable_, and the permissions and trigger make it _hard_.
- Writing the event in the same transaction means there is never an action without its event, or an event for an action that rolled back.

**Cost:**

- Deleting the most recent events (tail truncation) can't be detected by the chain alone. This needs the database owner role, and is an accepted risk for the slice (see verify.md). Production should periodically copy the latest hash to write-once storage.
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

**How a send is recorded:** the code's hash, the link's send counter and the text message are written in one transaction. Locally the message is a row in the `outbox` table. In production the same table becomes a transactional outbox: a separate SMS relay reads new rows and hands them to the provider. Either way, a code is never counted as sent unless its message exists, and a message is never sent for a code that was rolled back.

## D5. Customer files are handled as untrusted content: typed by box, never rendered by the portal

**Decision:**

- **Upload:** the form has one file input per requested document type, each accepting several files, so the box a file comes through is its type. The server checks the real type from the file's first bytes, the size and completeness, and refuses the whole submission on any problem.
- **Download:** every document is served as an attachment, with its content type taken from the detected type, `nosniff`, and a sanitised file name with the extension of the detected type. There is no inline viewer, so uploaded content is never rendered on the portal's origin. Downloading is how staff "view" a document, and each download is audited before any bytes are sent.

**Why:**

- A per-file type dropdown needs script to add a row for each chosen file, and the content security policy allows no inline script (D1). One box per type gives the same outcome without script: every file is tagged with a requested type.
- A customer's file is untrusted. Rendering it on the portal's origin, as a PDF in the browser viewer or an image a browser might sniff as HTML, would give a crafted file a chance to run alongside the staff session. An attachment goes to the operating system instead.

**Cost:**

- A file put in the wrong box is sent under the wrong type. The banker sees the type and file name and can ask again.
- Each document opens outside the browser. Production could add a viewer on a separate, sandboxed origin that holds no session.

## Intentionally not built

| Not built                                            | Why                                                                                         | Production path                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Retention purge job (FR-15)                          | The retention date is recorded on every file, so deletion can be added without data changes | Scheduled job deletes expired files and writes an audit event for each                                                                     |
| Banker notifications (FR-16)                         | Status is visible in the portal                                                             | Email or in-app notification on upload                                                                                                     |
| Real malware scanning (FR-17)                        | The scan step exists and always passes                                                      | Asynchronous scan with quarantine; files viewable only once clean                                                                          |
| Real SMS                                             | Codes appear on a mock outbox page                                                          | SMS provider behind the same interface                                                                                                     |
| Single sign-on                                       | Mock sign-in with seeded users and roles; anyone can sign in as any seeded user             | The bank's identity provider via OIDC; sessions and authorisation code unchanged. Remove the mock login route before any shared deployment |
| Cancellation, legal hold, bulk requests              | Outside the requested scope                                                                 | —                                                                                                                                          |
| Encryption at rest, TLS, rate limiting, WCAG testing | Assumed at the infrastructure layer or outside scope                                        | Managed encrypted storage with KMS, TLS at the load balancer, WAF rate limits, accessibility audit                                         |
