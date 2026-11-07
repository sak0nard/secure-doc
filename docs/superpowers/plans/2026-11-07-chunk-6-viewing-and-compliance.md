# Chunk 6: Viewing and Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**

- The requesting banker and compliance officers can download clean documents, and every download is audited.
- Anyone else is refused, and the refusal is audited.
- Compliance can read a request's full audit trail and see whether the whole hash chain is intact.

**Architecture:** no new modules. This chunk joins pieces that exist:

- the policy (`authorise`, `document.download`, `audit.view`)
- `denied()`
- the storage port's `get`
- `verifyChain`
- a new per-request audit query

Downloads are always served as attachments, with a content type taken from the detected file type and a sanitised file name. Uploaded content is never rendered on the portal's own origin.

**Tech Stack:** as chunks 1–5.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§6.4 scan gating; §6.5 policy; §6.6 verification; §6.7 download headers; §7 routes; §9 AC-7/AC-8 rows)

**Depends on chunks 3–5** (merged before this runs; use the landed names and ledger any difference):

- `authorise`, `Action`, `denied(deps, ctx, action, target, requestId?)`
- `getRequest`, `ActionContext`, `auditAction`, `verifyChain`
- `ObjectStore.get`, `listDocuments`
- Test helpers: `signIn`, `createRequestVia`, `bodyText`, `tamperAsOwner`, and chunk 5's helper for a verified session plus upload

## Global Constraints

- **Download route:** `GET /documents/:id` (signed-in users only; `requireUser`).
  - Malformed or unknown id: 404.
  - Not allowed by `authorise(user, "document.download", request)`: `denied()`, which returns 403 with `access.denied`, `detail.action "document.download"`, target `{ type: "document", id }` and `requestId`.
  - `scanStatus !== "clean"`: 409 with the body `This document is still being checked.`
  - Row present but object missing: 404 with `This document isn't available.`, logged as `ERROR` with the document id (no file name).
- **Download response:**
  - `Content-Type` from `detectedType` (`application/pdf`, `image/png`, `image/jpeg`).
  - `Content-Disposition: attachment; filename="{safe}"; filename*=UTF-8''{encoded}`.
  - `X-Content-Type-Options: nosniff`, plus the global headers.
- **Safe file name:**
  - Take the original name without its extension.
  - Keep only `[A-Za-z0-9 ._-]` and replace everything else with `_`.
  - Trim to 80 characters, then append the extension for the **detected** type (`.pdf`, `.png`, `.jpg`).
  - Fall back to `document` when nothing is left.
  - `filename*` is the RFC 5987 percent-encoding of the same safe name.
- **Audit `document.downloaded`:**
  - Written after the bytes have been read from storage and before the response is returned, in its own transaction.
  - `detail { sha256 }`, `requestId` set.
  - If the audit write fails, the download fails, because a download without its event must not happen.
- **Audit page:** `GET /requests/:id/audit` is for compliance only, via `authorise(user, "audit.view")`; others get `denied()`.
  - It lists every event with this `requestId` in `seq` order, with columns: `#seq`, time (ISO), actor (user name for `user` actors, `Customer` for customer actors, `System`), action, target, outcome, source IP and detail (as JSON text).
  - Above the table it shows the whole-chain result: `Chain intact ({count} events)` or `Chain broken at event #{brokenAt} ({reason})`, where `reason` is `content edited` for `hash_mismatch` and `link broken` for `link_mismatch`.
  - Viewing it writes `audit.viewed` (`requestId` set).
- **Detail page:**
  - Each document name links to `/documents/:id`, but only when the viewer may download it and it is clean. Otherwise the name is plain text with its scan status.
  - Compliance sees a link `Audit trail` to `/requests/:id/audit`.
  - Link line wording: `Link: active until {ISO time}` when usable; `Link: expired` / `Link: locked` / `Link: revoked` / `Link: used` otherwise. This fixes chunk 3's "locked, valid until …".
- **Testing:** test-first. Tests live in `tests/`; code lives in `src/`.
- **Formatting:** run `bun fmt` before each commit.
- **Wording:** documents never mention time limits.

## Review Focus

1. **A document still pending its scan** cannot be downloaded by anyone, compliance included. _Task 1 test._
2. **A database row whose object is missing** gives a 404 page and a logged error, never a 500 with internals. _Task 1 test._
3. **A hostile original file name** (quotes, CR/LF, `;`, non-ASCII, path separators) cannot inject headers or change the extension. _Task 1 unit test._
4. **A customer's upload-session cookie** gives no access to staff routes: `/documents/:id` with only `cs` redirects to `/login`. _Task 1 test._
5. **The audit page escapes detail JSON and names**, so stored text containing `<script>` is shown as text. _Task 2 test._

---

## File Structure

```
src/modules/documents/documents.ts    (modify) getDocument, safeDownloadName
src/modules/audit/audit.ts            (modify) listRequestEvents
src/web/routes/documents.tsx          GET /documents/:id
src/web/routes/requests.tsx           (modify) detail page links + wording; GET /requests/:id/audit
src/app.ts                            (modify) mount document routes
tests/download.test.ts, tests/compliance.test.ts, tests/download-name.test.ts
evidence/*.md                         (modify)
```

---

### Task 1: Download documents (AC-7 for documents)

**Files:**

- Modify: `src/modules/documents/documents.ts`, `src/app.ts`
- Create: `src/web/routes/documents.tsx`
- Test: `tests/download-name.test.ts`, `tests/download.test.ts`

**Interfaces:**

- Produces:
  - `getDocument(db: Db | Tx, id: string): Promise<{ id; requestId; storageKey; detectedType; originalFilename; sha256; scanStatus } | null>`
  - `safeDownloadName(originalFilename: string, detectedType: "pdf" | "png" | "jpeg"): string`
  - `contentDisposition(safeName: string): string`

- [ ] **Step 1: Write failing unit tests** in `tests/download-name.test.ts`:
  - `"keeps ordinary names and uses the detected extension"`: `("Payslip March.pdf", "pdf")` → `"Payslip March.pdf"`; `("scan.PNG", "jpeg")` → `"scan.jpg"`.
  - `"neutralises header-breaking characters"`: `('a"b\r\nX-Evil: 1;.pdf', "pdf")` → a result with no `"`, `\r`, `\n` or `;`, ending in `.pdf`. `contentDisposition` of it contains no CR/LF.
  - `"strips path separators"`: `("../../etc/passwd.pdf", "pdf")` contains no `/` or `\`.
  - `"falls back when nothing safe is left"`: `("<<>>.pdf", "pdf")` → `"____.pdf"`, and `("", "png")` → `"document.png"`.
  - `"caps the length"`: a 500-character base → at most 80 characters plus the extension.
- [ ] **Step 2: Write failing route tests** in `tests/download.test.ts` (set up via chunk 5's verified-session and upload helpers: Alice's request for Dana with one `pdf()` payslip):
  - `"the requesting banker downloads the document as an attachment"`:
    - → 200, and the body bytes equal the uploaded bytes.
    - `content-type` is `application/pdf`; `content-disposition` starts with `attachment; filename="`; `x-content-type-options` is `nosniff`.
    - There is one `document.downloaded` event with actor alice, `requestId` and `detail.sha256`.
  - `"AC-7: another banker is denied the document and the attempt is logged"`: Bob → 403 `You don't have access to this.` with no document bytes in the body. There is an `access.denied` event with actor bob, target `document`, `detail.action "document.download"` and `requestId`.
  - `"compliance can download any document"`: Carol → 200.
  - `"a document still being scanned cannot be downloaded"`: set `scanStatus = 'pending'` via `appDb` → Alice 409 and Carol 409; no `document.downloaded` event.
  - `"a missing object is a clean 404, logged"`: delete the object through `deps.storage.delete(storageKey)` → 404 `This document isn't available.`; the logs contain an `ERROR` line with the document id.
  - `"an upload-session cookie gives no staff access"`: `GET /documents/:id` with only the `cs` cookie → 303 to `/login`.
  - `"malformed and unknown document ids are 404"`.
- [ ] **Step 3: Run** `bun test tests/download-name.test.ts tests/download.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Order in the route:
  1. Parse the id.
  2. `getDocument`.
  3. `getRequest` for the banker id.
  4. `authorise`.
  5. Scan gate.
  6. `storage.get`.
  7. The audit transaction.
  8. `new Response(bytes, { headers })`.
- [ ] **Step 5: Run** `bun test && bun run typecheck && bun fmt --check`. Expected: all pass.
- [ ] **Step 6: Commit**: `git commit -m "feat: audited document download for banker and compliance"`

---

### Task 2: Compliance audit trail (AC-8)

**Files:**

- Modify: `src/modules/audit/audit.ts`, `src/web/routes/requests.tsx`
- Test: `tests/compliance.test.ts`

**Interfaces:**

- Produces: `type AuditRow = { seq; at; actorType; actorId; actorName: string | null; action; targetType; targetId; outcome; sourceIp; detail }`; `listRequestEvents(db, requestId: string): Promise<AuditRow[]>`. Ordered by `seq`. `actorName` comes from a left join to `users` when `actorType = 'user'`.

- [ ] **Step 1: Write failing tests** in `tests/compliance.test.ts` (one full journey per test: create → code → verify → upload → Alice downloads):
  - `"AC-8: compliance can view the document and the full audit trail"`:
    - Carol downloads the document → 200.
    - Carol `GET /requests/:id/audit` → 200. `bodyText` contains, in this order: `request.created`, `link.issued`, `otp.sent`, `otp.verified`, `document.uploaded`, `request.received`, `document.downloaded`. It also contains `Alice Banker`, `Customer`, `Chain intact (` and an IP column.
    - There is an `audit.viewed` event with actor carol.
  - `"the audit page reports a tampered chain"`: after the journey, `tamperAsOwner` edits one event's `detail` → the page contains `Chain broken at event #{that seq} (content edited)`.
  - `"bankers cannot view the audit trail, and the attempt is logged"`: Alice (the owner) → 403; `access.denied` with `detail.action "audit.view"`.
  - `"the audit trail shows only this request's events"`: a second request's `request.created` doesn't appear (count `request.created` occurrences = 1).
  - `"stored text is escaped on the audit page"`: insert a user named `<script>x</script>` who creates a request → the page contains `&lt;script&gt;` and not `<script>x`.
- [ ] **Step 2: Run** `bun test tests/compliance.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the query and page. The chain check runs `verifyChain(deps.db)` on each page view; that is fine at this scale and is noted in verify.md.
- [ ] **Step 4: Run** `bun test && bun run typecheck && bun fmt --check`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "feat: compliance audit trail with chain verification"`

---

### Task 3: Detail page links and wording

**Files:**

- Modify: `src/web/routes/requests.tsx`
- Test: `tests/requests.test.ts` (extend)

- [ ] **Step 1: Write failing tests:**
  - `"document names link to the download only when allowed and clean"`:
    - Alice's detail page contains `href="/documents/{id}"`.
    - With `scanStatus` set to `pending`: no link, and the text shows `pending`.
  - `"compliance sees the audit trail link; bankers don't"`: `href="/requests/{id}/audit"` is present for Carol and absent for Alice.
  - `"link state wording matches the link"`:
    - fresh → `Link: active until`
    - after a lock (set via `appDb`) → `Link: locked`, with no `until`
    - after 72h → `Link: expired`
    - after an upload → `Link: used`
- [ ] **Step 2: Run** `bun test tests/requests.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test && bun run typecheck && bun fmt --check`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "feat: download and audit links on the request page"`

---

### Task 4: Evidence

**Files:**

- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/decisions.md`, `evidence/operate.md`

- [ ] **Step 1: `design.md`.**
  - In the security table, "Insider viewing documents" becomes _Built_ (download policy, denied logging).
  - Add the download headers and file-name sanitising to HTTP hardening.
  - Describe the compliance audit page.
- [ ] **Step 2: `verify.md`.**
  - Record the real results.
  - Add "Downloads" and "Compliance audit trail" test groups.
  - Mark AC-7 and AC-8 _Met_, so every acceptance criterion is met.
  - Add known gaps:
    - the audit trail is queryable by request only; actor and date filters are a production addition (NFR auditability)
    - whole-chain verification runs on every page view
    - the request list filters in the app
- [ ] **Step 3: `decisions.md`.** Add a short record: documents are only ever downloaded as attachments and never rendered inline on the portal origin. Trade-off: less convenient review; production could add a sandboxed viewer on a separate origin.
- [ ] **Step 4: `operate.md`.** Add "How compliance checks the audit chain" (the page, what a break means, the incident response in the failure-modes table). Also add one `psql` query for events by actor and date range, as the interim way to meet the queryable-by-actor-and-date need.
- [ ] **Step 5: Commit**: `git commit -m "docs: record viewing and compliance in evidence"`
