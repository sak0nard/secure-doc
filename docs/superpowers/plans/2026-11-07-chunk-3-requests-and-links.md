# Chunk 3: Requests and Upload Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A banker creates a request and sees its upload link exactly once.
- Bankers and compliance see the requests they're allowed to see, with a status that includes Expired and Link locked.
- A banker can reissue (revoking the old link) or close a request.
- A customer opening a revoked, expired or unknown link gets one generic refusal.

**Architecture:**
- **`src/modules/requests/`** owns requests and their links. Every state change is a domain function that takes a transaction and an `ActionContext` and writes its audit events inside that transaction.
- **`src/modules/access/policy.ts`** holds the single authorisation table. Routes ask it before acting. On a refusal, routes write `access.denied` in a separate transaction that commits, then respond 403.
- **Display status:** "Expired" is computed by one pure function from the request's stored status and its latest link.

**Tech Stack:** as chunks 1–2.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§5 requests, upload_links, request status; §6.1; §6.5 policy; §7 routes)

**Depends on chunk 2:** `appendAudit(tx, AuditInput)`, `AuditInput`, `verifyChain` from `src/modules/audit/audit.ts`. If chunk 2 landed different names, use those and ledger a ruling.

**Scope note:**
- The policy module and the `access.denied` handling for request routes land here, because these routes need them. Chunk 6 reuses both for documents and the compliance audit page.
- `GET /u/:token` lands here in minimal form (valid → placeholder, refused → generic page), so that AC-5 is testable over HTTP. Chunk 4 replaces the valid-link page.

## Global Constraints

- **Link token:** 32 random bytes, base64url (43 characters), from `randomToken()`. Only `sha256Hex(token)` is stored.
- **Link URL:** `${config.baseUrl.origin}/u/${token}`. It appears only in the response to `POST /requests` and `POST /requests/:id/reissue`.
- **Link lifetime:** `expiresAt = issuedAt + 72h`. A link is usable iff `state = 'active'` and `now < expiresAt`.
- **Single active link:** at most one active link per request (DB index from chunk 1). Reissue revokes the old active link and issues a new one in one transaction, with audit events `link.revoked` then `link.issued`.
- **Generic refusal page:**
  - Status **404**, body text exactly `This link is no longer valid. Contact your banker.`
  - The same body for unknown, used, revoked, locked and expired links.
  - The real reason goes only to the audit event `link.refused` (`detail: { reason, tokenHashPrefix }`, where the prefix is the first 8 hex characters of the hash).
- **Policy:**
  - `request.create`: bankers only.
  - `request.view` and `request.reissue`: the owning banker. Compliance may also view, but not reissue.
  - `request.close`: the owning banker, or compliance.
  - `document.download`: same as `request.view`.
  - `audit.view`: compliance only.
- **Denied:**
  - Respond 403 with the body `You don't have access to this.`
  - Write audit `access.denied` with outcome `denied`, actor = the user, the target, and `detail: { action }`. It is committed even though the action didn't happen.
- **Reissue** is allowed only while the stored status is `open`. **Close** is allowed only from `received`. Otherwise respond 409 with the body `This request can't be changed in its current state.`
- **Malformed `:id`** (not a UUID) or an unknown id: 404.
- **Mobile masking:** every digit except the last two becomes `•`; `+` is kept. So `+61400000101` → `+••••••••••01`.
- **Displayed request detail:** writes audit `request.viewed`.
- **Every action is audited:** every state change writes audit events in the same transaction as the change (`request.created`, `link.issued`, `link.revoked`, `request.closed`).
- **Testing:** test-first. Tests live in `tests/`; code lives in `src/`.
- **Wording:** documents never mention time limits.

## Review Focus

1. **Two reissues of the same request at once** must leave exactly one active link and never return a 500. *Task 3 test.*
2. **A hostile token in the URL** (5,000 characters, `%00`, `..%2F`, non-ASCII) gets the generic 404 refusal, never a 500. *Task 4 test.*
3. **A malformed request id** (`/requests/not-a-uuid`) returns 404, not 500. *Task 3 test.*
4. **Reissuing an expired request** shows it as Open again with a usable link. *Task 3 test.*
5. **Repeated or invalid `documentTypes`** in the create form (duplicates, an unknown value, none): unknown or none is a 400, and duplicates are stored once. *Task 2 test.*

---

## File Structure

```
src/modules/access/policy.ts        Action type, authorise()
src/modules/requests/status.ts      displayStatus(), maskMobile()
src/modules/requests/requests.ts    createRequest, reissueLink, closeRequest, listRequests, getRequest
src/modules/requests/links.ts       issueLink (internal to module), resolveLink
src/web/deny.tsx                    denied(deps, ctx, action, target) → 403 Response
src/web/routes/requests.tsx         GET /, GET /requests/new, POST /requests, GET /requests/:id, POST reissue/close
src/web/routes/customer.tsx         GET /u/:token (minimal)
src/web/routes/login.tsx            (modify) remove placeholder GET /
tests/policy.test.ts, tests/status.test.ts, tests/requests.test.ts, tests/links.test.ts
evidence/*.md                       (modify)
```

---

### Task 1: Policy and display status (pure units)

**Files:**
- Create: `src/modules/access/policy.ts`, `src/modules/requests/status.ts`
- Test: `tests/policy.test.ts`, `tests/status.test.ts`

**Interfaces:**
- Consumes: `User` (`src/modules/access/sessions.ts`).
- Produces:
  - `type Action = "request.create" | "request.view" | "request.reissue" | "request.close" | "document.download" | "audit.view"`
  - `authorise(user: User, action: Action, request?: { bankerId: string }): boolean`. Actions about a request return `false` when `request` is missing.
  - `type DisplayStatus = { label: "Open" | "Expired" | "Received" | "Closed"; linkLocked: boolean }`
  - `displayStatus(status: "open" | "received" | "closed", latestLink: { state: "active" | "used" | "revoked" | "locked"; expiresAt: Date } | null, now: Date): DisplayStatus`
  - `maskMobile(e164: string): string`

- [ ] **Step 1: Write failing tests.**
  - `tests/policy.test.ts` is table-driven. One `test.each` row per (role, action, owns?) → expected, covering every cell of the policy in Global Constraints:
    - banker owner: view, reissue, close and download are true; audit.view is false.
    - banker non-owner: all request actions are false.
    - compliance: view, close, download and audit.view are true; create and reissue are false.
    - banker create: true.
    - Request actions with no request: false.
  - `tests/status.test.ts`:
    - `"open with an active, unexpired link is Open"`
    - `"open whose active link has reached its expiry is Expired"`: `now` equal to `expiresAt` → Expired.
    - `"open with a locked link is Open and flagged locked"` → `{ label: "Open", linkLocked: true }`.
    - `"received and closed ignore the link"`.
    - `"maskMobile keeps only the last two digits"`: `maskMobile("+61400000101")` is `"+••••••••••01"`.
- [ ] **Step 2: Run** `bun test tests/policy.test.ts tests/status.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** Write the policy as a lookup table keyed by role and action, with owner-only cells marked; avoid an if/else chain.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat: authorisation policy and derived request status"`

---

### Task 2: Create a request; show the link once; list requests

**Files:**
- Create: `src/modules/requests/requests.ts`, `src/modules/requests/links.ts`, `src/web/deny.tsx`, `src/web/routes/requests.tsx`
- Modify: `src/web/routes/login.tsx` (drop the placeholder `GET /`; keep `requireUser` export), `src/app.ts` (mount the request routes)
- Test: `tests/requests.test.ts`

**Interfaces:**
- Consumes:
  - `appendAudit`, `AuditInput`
  - `authorise`, `displayStatus`
  - `randomToken`, `sha256Hex`
  - `requireUser`, `sourceIp`, `page`, `Layout`
  - `SEED`, `testApp`, `post`, `get`
- Produces:
  - `type ActionContext = { actor: AuditInput["actor"]; ip: string; now: Date }` (exported from `src/modules/audit/audit.ts` if not already there; otherwise from `requests.ts`).
  - `createRequest(tx: Tx, ctx: ActionContext, input: { bankerId: string; customerId: string; documentTypes: DocumentType[] }): Promise<{ requestId: string; token: string }>`. Writes `request.created` and `link.issued`.
  - `issueLink(tx, ctx, requestId): Promise<{ linkId: string; token: string }>`. Internal to the module; used by create and reissue.
  - `type RequestSummary = { id; customerName; documentTypes; createdAt; bankerName; status: DisplayStatus }`
  - `listRequests(db, user: User, now: Date): Promise<RequestSummary[]>`. Bankers see their own; compliance sees all; newest first.
  - `denied(deps, ctx: ActionContext, action: Action, target: { type: string; id: string }, requestId?: string): Promise<Response>`
  - `type DocumentType = "payslip" | "bank_statement" | "photo_id" | "other"`, from the schema enum.

**Home page:**
- `GET /` keeps the line `Signed in as {name} ({role})` and the sign-out form; existing login tests rely on both.
- Below them is the request list: customer, document types, banker, created, status label, and a "Link locked" badge.

**Create form:**
- `GET /requests/new`: a customer `<select>` (name + masked mobile) and one checkbox per document type.
- `POST /requests` is validated by Zod: `customerId` UUID of an existing customer; `documentTypes` a non-empty array of enum values, deduplicated.
- The response is 200 with a page holding the link in a read-only `<input>` and the note "Copy this link now. It won't be shown again."

- [ ] **Step 1: Write failing tests** in `tests/requests.test.ts` (`beforeEach(resetDb)`; helper `signIn(app, userId)` returns a cookie, reusing the login flow; `create(app, cookie, form)` posts to `/requests`):
  - `"AC-1: banker creates a request and sees the upload link exactly once"`:
    - Alice creates a request for dana with `payslip` and `photo_id` → 200.
    - The body contains one URL matching `/http:\/\/localhost:3000\/u\/[A-Za-z0-9_-]{43}/`.
    - The `upload_links` row's `tokenHash` equals `sha256Hex(token)`, and no `upload_links` or `audit_events` row contains the token anywhere (`JSON.stringify`).
    - `GET /requests/:id` and `GET /` with Alice's cookie do not contain the token.
  - `"creating a request is audited with its link"`: the audit actions for the request are `["request.created", "link.issued"]` in `seq` order, actor alice, outcome success.
  - `"both selected document types are stored, duplicates once"`: the form sends `payslip`, `photo_id`, `payslip` → the request has `documentTypes` `["payslip", "photo_id"]`.
  - `"create rejects missing or unknown document types and unknown customers"`: no types → 400; `documentTypes=passport` → 400; random customer UUID → 400. Zero requests are created.
  - `"compliance cannot create requests, and the attempt is logged"`: Carol posts a valid form → 403; zero requests; one `access.denied` event with actor carol and `detail.action "request.create"`.
  - `"bankers see only their own requests; compliance sees all"`: Alice creates 1 and Bob creates 1. Alice's `/` lists only hers (by customer name), Bob's only his, and Carol's both.
  - `"compliance home has no new-request button"`: Carol's `/` doesn't contain `href="/requests/new"`; Alice's does.
- [ ] **Step 2: Run** `bun test tests/requests.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Repeated checkbox keys: verify how Elysia parses them; the test is the contract. If needed, read `await request.formData()` and `getAll("documentTypes")` before Zod.
  - Compute the client IP with `sourceIp(request, server, deps.config.trustProxy)` in each route and build `ActionContext` there.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: create requests with show-once upload links and role-scoped list"`

---

### Task 3: Request detail, reissue and close

**Files:**
- Modify: `src/modules/requests/requests.ts`, `src/web/routes/requests.tsx`
- Test: `tests/requests.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type RequestDetail = { id; bankerId; customer: { name; maskedMobile }; documentTypes; status: DisplayStatus; link: { state; expiresAt } | null; createdAt }`
  - `getRequest(db, id: string, now: Date): Promise<RequestDetail | null>`
  - `reissueLink(tx, ctx, requestId): Promise<{ token: string } | { conflict: true }>`
    - Locks the request row (`SELECT … FOR UPDATE`) first, so concurrent reissues queue.
    - Returns `conflict` unless the stored status is `open`.
    - Revokes the active link (if any), then issues a new one.
  - `closeRequest(tx, ctx, requestId): Promise<"closed" | "conflict">`. Only from `received`; writes `request.closed`.
  - `markReceivedForTest` is **not** added. Tests set `status = 'received'` directly via `appDb`, until chunk 5 provides the real path.

**Detail page:**
- Shows the customer name, masked mobile, document types, the status label (and "Link locked: reissue required" when locked), and the link state with its expiry time.
- It has a "Documents" section, which shows "None yet" (chunk 5 fills it).
- The Reissue and Close forms are shown only when `authorise` allows them *and* the state allows them.
- Every successful display writes `request.viewed`.

- [ ] **Step 1: Write failing tests** (extend `tests/requests.test.ts`):
  - `"the owning banker sees the detail page, and the view is audited"`: 200; the body contains the customer name, `+••••••••••01` and not `+61400000101`; one `request.viewed` event.
  - `"another banker is denied the detail page, and the attempt is logged"`: Bob GETs Alice's request → 403 with the body `You don't have access to this.`; an `access.denied` event with actor bob, `requestId` set, `detail.action "request.view"`.
  - `"compliance can view any request"`: Carol → 200.
  - `"malformed or unknown request ids are 404"`: `/requests/not-a-uuid` → 404 and a random UUID → 404. Neither is a 500.
  - `"reissue revokes the old link and shows the new one once"`: Alice reissues → 200 with a new URL ≠ the old one. The DB has exactly one `active` link for the request, and the old one is `revoked`. The audit order for the reissue is `link.revoked`, `link.issued`.
  - `"another banker and compliance cannot reissue"`: Bob → 403 and Carol → 403, each with `access.denied`. Alice's original link is still the only active one.
  - `"two reissues at once leave one active link"`: `Promise.all` of two reissue POSTs by Alice → both 200. Exactly one `active` link, and three links in total (one original, two from the reissues).
  - `"reissuing an expired request makes it Open again"`: with an injected clock, create, then advance 72h → `/` shows `Expired`. Reissue → `/` shows `Open`.
  - `"reissue and close are refused in the wrong state"`: on a fresh `open` request, close → 409. Set `status = 'received'` via `appDb`: reissue → 409, close by Alice → 303 to `/requests/:id`, and the status is `closed` with a `request.closed` event. Close again → 409.
  - `"compliance can close a received request"`: Carol closes → `closed`.
- [ ] **Step 2: Run** `bun test tests/requests.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** as specified. On close, redirect `303` to the detail page. On reissue, respond 200 with the show-once link page (the same component as create).
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: request detail, reissue with revocation, close"`

---

### Task 4: Customer link check (minimal `GET /u/:token`)

**Files:**
- Modify: `src/modules/requests/links.ts`
- Create: `src/web/routes/customer.tsx`
- Modify: `src/app.ts`
- Test: `tests/links.test.ts`

**Interfaces:**
- Produces:
  - `type LinkResolution = { ok: true; linkId: string; requestId: string } | { ok: false; reason: "unknown" | "used" | "revoked" | "locked" | "expired"; linkId?: string; requestId?: string }`
  - `resolveLink(db: Db | Tx, token: string, now: Date): Promise<LinkResolution>`. Chunk 4 calls this from the code routes.
  - `REFUSED_LINK_TEXT = "This link is no longer valid. Contact your banker."`, exported for chunk 4.
- **Route:**
  - `GET /u/:token` valid → 200 with the placeholder text `Secure document upload` (chunk 4 replaces the body).
  - Refused → 404 with `REFUSED_LINK_TEXT`, plus a `link.refused` event: actor `customer`, id = `linkId` or `"anonymous"`; target `link`, id = `linkId` or `"unknown"`; `requestId` when known; outcome `failure`; `detail { reason, tokenHashPrefix }`.

- [ ] **Step 1: Write failing tests** in `tests/links.test.ts` (create requests through the HTTP flow from Task 2 and pull the token from the response):
  - `"a fresh link is accepted"` → 200.
  - `"AC-5: a reissued (revoked) link is refused"`: old token → 404 with `REFUSED_LINK_TEXT`; the new token → 200; a `link.refused` event with `detail.reason "revoked"`.
  - `"AC-5: an expired link is refused"`: clock at `issuedAt + 72h - 1s` → 200; at `+72h` → 404; the event reason is `"expired"`.
  - `"a locked link is refused"`: set the link `state = 'locked'` via `appDb` → 404, reason `"locked"`. *(The real lock path arrives in chunk 4.)*
  - `"unknown and hostile tokens get the same refusal, never a 500"`: for `"x"`, `"a".repeat(5000)`, `"%00"`, `"..%2F..%2Fetc"` and `"%E2%9C%93"` → 404 with exactly the same body as the revoked case; the event reason is `"unknown"`.
  - `"refusal events never contain the raw token"`: no `audit_events` row's JSON contains the token. `detail.tokenHashPrefix` is 8 hex characters.
  - `"refusal pages send no-referrer"`: the `referrer-policy` header is `no-referrer` on both 200 and 404.
- [ ] **Step 2: Run** `bun test tests/links.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolveLink`: look up by `sha256Hex(token)`, then map state and expiry to a reason. The route writes `link.refused` in its own transaction.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: generic refusal for unusable upload links"`

AC-5's "used" case is tested in chunk 5, when submission marks a link used.

---

### Task 5: Evidence

**Files:**
- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/decisions.md`, `evidence/operate.md`

- [ ] **Step 1: `design.md`**
  - Security table: the rows for database leak (links), insider browsing (requests) and forwarded link (revocation and expiry) move to *Built* where now true.
  - Add an "Authorisation" subsection with the policy table, the denied-and-logged behaviour, and the single decision point.
- [ ] **Step 2: `verify.md`**
  - Record the real results.
  - Add "Requests and links" and "Authorisation" test groups.
  - Mark AC-1 *Met*; mark AC-5 *Partly met* (revoked and expired; used comes with uploads).
  - Note that AC-7 is partly covered (request pages; documents come later).
- [ ] **Step 3: `decisions.md`.** Under D5, note that reissue locks the request row so concurrent reissues can't produce two active links.
- [ ] **Step 4: `operate.md`.** Under Status, describe the request list labels (Open, Expired, Received, Closed, Link locked) and what a banker does for each.
- [ ] **Step 5: Commit**: `git commit -m "docs: record requests, links and authorisation in evidence"`
