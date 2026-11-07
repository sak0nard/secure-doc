# Chunk 5: Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**

- A verified customer uploads PDF, JPG or PNG files, one or more per requested document type.
- Files are checked by their content and size, scanned, stored under random keys with a SHA-256 hash and a retention date, and the request moves to Received.
- The link is then used up.
- Any problem rejects the whole submission and lets the customer retry.

**Architecture:**

- **Pure checks** (`src/modules/documents/checks.ts`) decide whether a submission is acceptable: type by magic bytes, size, count and completeness.
- **`submitUpload`** (`src/modules/documents/uploads.ts`) runs the side effects:
  1. Hash and scan every file.
  2. Write the objects.
  3. In one transaction: lock the link, re-check the session, insert the document rows, end the session, mark the link used, move the request to received, and audit.
  4. If anything fails after objects were written, delete them.
- **Ports:** storage and scanning sit behind `ObjectStore` and `MalwareScanner` in `deps`. The local adapters are RustFS (via Bun's S3 client) and an always-clean scanner.

**Tech Stack:** as chunks 1–4, plus Bun `S3Client`.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§5 documents; §6.3 submit; §6.4; §9 AC-2/3/4/5 rows)

**Depends on chunks 3–4:** `resolveCustomerSession`, `endCustomerSession`, `CUSTOMER_COOKIE`, `ActionContext`, `appendAudit`, `createRequestVia` (with `documentTypes` and `linkId`, from chunk 4), `bodyText`, `auditAction`, and code-verify helpers in tests. Take every row lock before the first audit write in a transaction. Chunk 3's detail page gains a document list here. If names differ, use the landed ones and ledger a ruling.

## Global Constraints

- **Accepted types**, by magic bytes only:
  - PDF `25 50 44 46 2D`
  - PNG `89 50 4E 47 0D 0A 1A 0A`
  - JPEG `FF D8 FF`

  The extension and client content type are ignored.

- **Stored content type:** `application/pdf`, `image/png` or `image/jpeg`, from the detected type only.
- **Size:** at most `10 * 1024 * 1024` bytes per file. An empty file is rejected as an unrecognised type.
- **Count:** 1–10 files per submission.
- **How the customer picks a type:**
  - The upload form has **one file input per requested document type**: `name` is the type value, with `multiple`. The input a file comes through is its document type.
  - This replaces the per-file dropdown in the spec's sketch, which can't work without client-side script under our CSP. The outcome (option A: tagged and complete) is unchanged. _Ledger as a ruling._
- **Completeness:** every requested type has at least one file. A file under a type that wasn't requested is rejected.
- **Rejection reasons** (exact text, shown per file or for the whole submission):
  - `{name}: not a PDF, JPG or PNG file`
  - `{name}: larger than 10 MB`
  - `Missing: {type label}`
  - `Too many files (at most 10)`
  - `{name}: failed the security scan`
- **On rejection:**
  - The page is 422 and lists the reasons, with the form again.
  - Nothing is stored, and the session stays open.
  - Audit `upload.rejected`, outcome `failure`, `detail { problems: [{ field, reason }] }`. File names are left out of audit detail.
- **Storage key:** `documents/${crypto.randomUUID()}`. `original_filename` (truncated to 255 characters) is for display only.
- **Retention:** `retention_until = UTC date of now + RETENTION_DAYS days`.
- **Scan:** results are stored in `scan_status`. If any file is `infected`, the whole submission is rejected (fail closed).
- **Outage:** if the scanner or storage throws, respond 503 with `We couldn't process your files right now. Please try again.` No rows are written, every object already written is deleted (best effort), and the session stays open.
- **Successful submit**, in one transaction:
  - the documents are inserted
  - `customer_sessions.ended_at` is set
  - the link `state = 'used'`
  - the request `status = 'received'`
  - audit `document.uploaded` (one per file: `detail { documentType, detectedType, sizeBytes, sha256 }`) and `request.received`

  Then 200 with `Thank you. Your documents have been sent to your banker.`

- **Re-check under lock:** the transaction locks the link row first, then confirms the session is still valid and the link still active. If not (reissued, or a second tab submitted first) → roll back, delete the written objects, and respond 403 with the session-ended text.
- **Body limit:** Elysia/Bun `maxRequestBodySize` is set to `10 * 10 MB + 1 MB`.
- **Testing:** test-first. Tests live in `tests/`; code lives in `src/`.
- **Formatting:** run `bun fmt` before each commit.
- **Wording:** documents never mention time limits.

## Review Focus

1. **The banker reissues the link while the customer is uploading:** the submit is refused, and no rows or objects remain. _Task 3 test._
2. **Two tabs submit at once on the same session:** exactly one succeeds; the other gets 403, and its objects are deleted. _Task 3 test._
3. **Zero-byte, 2-byte and 10 MB-exactly files:** the first two are rejected as the wrong type; exactly 10 MB is accepted. _Task 2 tests._
4. **A hostile file name** (`../../etc/<b>x</b>.pdf`) never affects the storage key and is escaped on the banker's page. _Task 3 test._
5. **Scanner or storage failure mid-submission** leaves no rows, no objects and an open session. _Task 3 tests with stub ports._

---

## File Structure

```
compose.yml                              (modify) one-off bucket-creation job
src/ports/storage.ts                     ObjectStore + s3Store(config)
src/ports/scanner.ts                     MalwareScanner + alwaysClean
src/deps.ts                              (modify) storage, scanner
src/app.ts                               (modify) maxRequestBodySize
src/modules/documents/checks.ts          detectType, checkSubmission (pure)
src/modules/documents/uploads.ts         submitUpload
src/modules/documents/documents.ts       listDocuments(db, requestId)
src/web/routes/customer.tsx              (modify) GET/POST /u/upload
src/web/routes/requests.tsx              (modify) document list on the detail page
tests/fixtures.ts                        pdf(), png(), jpeg(), exe(), elf(), sized(bytes, n)
tests/storage.test.ts, tests/checks.test.ts, tests/uploads.test.ts
evidence/*.md                            (modify)
```

---

### Task 1: Storage and scanner ports

**Files:**

- Create: `src/ports/storage.ts`, `src/ports/scanner.ts`
- Modify: `compose.yml`, `src/deps.ts`, `tests/helpers.ts` (`testApp` gets real `storage` and `scanner` by default)
- Test: `tests/storage.test.ts`

**Interfaces:**

- Produces:
  - `interface ObjectStore { put(key: string, bytes: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array | null>; delete(key: string): Promise<void> }`
  - `s3Store(s3: Config["s3"]): ObjectStore`. Bun `S3Client` with `endpoint`, `bucket`, `region` and keys. `get` returns `null` when the object doesn't exist.
  - `interface MalwareScanner { scan(bytes: Uint8Array): Promise<"clean" | "infected"> }`; `alwaysClean: MalwareScanner`.
  - `Deps` gains `storage: ObjectStore` and `scanner: MalwareScanner`.

**Compose job:**

- A `createbuckets` service, `amazon/aws-cli` (pin a tag at least two weeks old).
- It `depends_on: rustfs` and runs: `aws --endpoint-url http://rustfs:9000 s3 mb s3://secure-doc` and `s3://secure-doc-test`, ignoring "already exists".
- Its credentials come from the same env defaults as RustFS.
- `bun run services` (`--wait`) must still exit 0, so make sure `--wait` treats a completed one-off job as success. If it doesn't, give the job `restart: "no"` and ledger the approach.
- _Ruling to ledger:_ this replaces the spec's "bucket created on startup", because Bun's S3 client cannot create buckets.

- [ ] **Step 1: Write failing tests** in `tests/storage.test.ts` (real RustFS, test bucket):
  - `"stored bytes come back unchanged"`: put 1 KB of random bytes under `documents/${uuid}` → `get` returns equal bytes.
  - `"a missing object reads as null"`: `get("documents/does-not-exist")` → `null`.
  - `"deleted objects are gone"`: put, delete, get → `null`. Deleting again doesn't throw.
  - `"the mock scanner passes everything"`: `alwaysClean.scan(new Uint8Array([1]))` → `"clean"`.
- [ ] **Step 2: Run** `bun test tests/storage.test.ts`. Expected: FAIL (module missing; bucket missing).
- [ ] **Step 3: Implement.** Add the compose job, run `bun run services`, and confirm both buckets exist (`docker compose run --rm createbuckets` is idempotent).
- [ ] **Step 4: Run** `bun test`. Expected: all PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat: object storage and scanner ports with local adapters"`

---

### Task 2: Submission checks (pure)

**Files:**

- Create: `src/modules/documents/checks.ts`, `tests/fixtures.ts`
- Test: `tests/checks.test.ts`

**Interfaces:**

- Produces:
  - `detectType(bytes: Uint8Array): "pdf" | "png" | "jpeg" | null`
  - `MAX_FILE_BYTES = 10 * 1024 * 1024`; `MAX_FILES = 10`
  - `type IncomingFile = { field: string; name: string; bytes: Uint8Array }`
  - `type AcceptedFile = IncomingFile & { documentType: DocumentType; detectedType: "pdf" | "png" | "jpeg" }`
  - `checkSubmission(files: IncomingFile[], requested: DocumentType[]): { ok: true; files: AcceptedFile[] } | { ok: false; problems: { field?: string; reason: string }[] }`
    - Reports every problem, not just the first.
    - Each `reason` is one of the exact texts in Global Constraints.
    - Type labels: `payslip` → `Payslip`, `bank_statement` → `Bank statement`, `photo_id` → `Photo ID`, `other` → `Other`.
  - Fixtures: `pdf()`, `png()`, `jpeg()` (small valid-looking files starting with the right magic bytes), `exe()` (`MZ` header), `elf()` (`7F 45 4C 46`), `sized(prefix: Uint8Array, total: number)`.

- [ ] **Step 1: Write failing tests:**
  - `"types are recognised by content"`: `pdf()` → `pdf`, `png()` → `png`, `jpeg()` → `jpeg`; `exe()`, `elf()`, an empty array and `[0x25, 0x50]` → `null`.
  - `"AC-3 (unit): an executable named .pdf is rejected"`: `{ field: "payslip", name: "payslip.pdf", bytes: exe() }` with `requested ["payslip"]` → problems contain `payslip.pdf: not a PDF, JPG or PNG file`.
  - `"AC-4 (unit): a file over 10 MB is rejected; exactly 10 MB is accepted"`: `sized(pdf(), MAX_FILE_BYTES + 1)` → the `larger than 10 MB` reason; `sized(pdf(), MAX_FILE_BYTES)` → ok.
  - `"every requested type needs a file"`: requested `["payslip", "photo_id"]` with only a payslip → `Missing: Photo ID`.
  - `"files under an unrequested type are rejected"`: a `field: "bank_statement"` file when only payslip is requested → a problem with field `bank_statement`. `field: "passport"` is rejected too.
  - `"more than ten files are rejected"`: 11 valid payslips → `Too many files (at most 10)`.
  - `"all problems are reported together"`: one exe and one oversize file, with a missing type → 3 problems.
  - `"an accepted submission tags each file with its type"`: two payslips plus one photo ID → 3 accepted files carrying the right `documentType` and `detectedType`.
- [ ] **Step 2: Run** `bun test tests/checks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat: upload checks by magic bytes, size and completeness"`

---

### Task 3: Upload page and submit

**Files:**

- Create: `src/modules/documents/uploads.ts`, `src/modules/documents/documents.ts`
- Modify: `src/web/routes/customer.tsx`, `src/web/routes/requests.tsx`, `src/app.ts`
- Test: `tests/uploads.test.ts`

**Interfaces:**

- Consumes: `checkSubmission`, `ObjectStore`, `MalwareScanner`, `resolveCustomerSession`, `endCustomerSession`, `appendAudit`, `ActionContext`, `sha256Hex`.
- Produces:
  - `submitUpload(deps: Pick<Deps, "db" | "storage" | "scanner" | "config">, ctx: ActionContext, session: { sessionId: string; linkId: string; requestId: string }, files: IncomingFile[]): Promise<{ result: "submitted"; documentIds: string[] } | { result: "rejected"; problems: { field?: string; reason: string }[] } | { result: "session_ended" } | { result: "unavailable" }>`
  - `type DocumentSummary = { id; documentType; originalFilename; detectedType; sizeBytes; sha256; scanStatus; uploadedAt; retentionUntil }`
  - `listDocuments(db: Db | Tx, requestId: string): Promise<DocumentSummary[]>`. Chunk 6 adds the download links.
- **Pages:**
  - `GET /u/upload` (valid session):
    - Heading `Upload your documents`.
    - One `<input type="file" name="{type}" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">` per requested type, labelled with the type label.
    - The note `PDF, JPG or PNG, up to 10 MB each.`
    - The submit button `Send documents`.
    - `enctype="multipart/form-data"`.
  - `POST /u/upload`: collect the files from the multipart body. Check how Elysia exposes repeated file fields and see chunk 3's ruling on form parsing; `request.formData()` with `getAll(type)` is the fallback. Then call `submitUpload` and map the result:
    - `submitted` → 200 thank-you
    - `rejected` → 422 with the reasons and the form
    - `session_ended` → 403
    - `unavailable` → 503
  - Request detail page (`GET /requests/:id`): the "Documents" section lists each document (type label, original name, detected type, size, uploaded time, scan status) instead of "None yet".

- [ ] **Step 1: Write failing tests** in `tests/uploads.test.ts` (`beforeEach(resetDb)`):
  - Helper `verifiedSession(app)`: `createRequestVia(app, { documentTypes: ['payslip', 'photo_id'] })`, send a code, verify, and return `{ cs, token, requestId }`.
  - Helper `upload(app, cs, parts: { field, name, bytes, type? }[])`: builds a multipart `FormData` POST with the same-site Origin.
  - Tests:
    - `"AC-2: a valid link plus the correct code lets the customer upload a PDF"`:
      - Upload `pdf()` as payslip and `jpeg()` as photo_id → 200 thank-you.
      - Two `documents` rows have the right `documentType`, `detectedType`, `sizeBytes`, `sha256 === sha256Hex(bytes)`, `scanStatus "clean"` and `retentionUntil` = today + 2555 days. Each `storageKey` matches `/^documents\/[0-9a-f-]{36}$/`.
      - `storage.get(storageKey)` returns the same bytes.
      - The request status is `received` and the banker's `/` shows `Received`.
    - `"submitting uses up the link and ends the session"`: after a successful upload, `GET /u/upload` with the same `cs` → 403. A second `POST /u/upload` → 403.
    - `"AC-5: a used link is refused"`: `GET /u/{token}` → 404 `REFUSED_LINK_TEXT`, with `link.refused` reason `used`.
    - `"upload is audited per file and as received"`: the actions include two `document.uploaded` events (detail with `sha256` and no file name) and one `request.received`. `verifyChain(appDb)` is ok.
    - `"AC-3: a renamed executable is rejected and nothing is stored"`: `exe()` named `payslip.pdf` with `type: "application/pdf"`, plus a valid photo ID → 422, the body contains `payslip.pdf: not a PDF, JPG or PNG file`, 0 `documents` rows, and the session still works (a retry with valid files → 200). There is an `upload.rejected` event.
    - `"AC-4: a file over 10 MB is rejected"`: `sized(pdf(), 10 MB + 1)` → 422, the body contains `larger than 10 MB`, 0 rows.
    - `"a missing document type is refused with the type named"`: only a payslip → 422, `Missing: Photo ID`.
    - `"a hostile file name is display-only and escaped"`: the name `../../etc/<b>x</b>.pdf` → accepted. The storage key is random, and the banker's detail page contains `&lt;b&gt;x&lt;/b&gt;` and not `<b>x</b>`.
    - `"an infected file fails the whole submission"`: `testApp({ scanner: { scan: async () => "infected" } })` → 422 `failed the security scan`, 0 rows, and no objects were written (use a recording `ObjectStore` wrapper around the real one).
    - `"a storage outage leaves no rows, no objects, and an open session"`: a store whose second `put` throws → 503. The first object was deleted (`get` → null), there are 0 rows, and a retry with the real store → 200.
    - `"a scanner outage fails closed"`: the scanner throws → 503, 0 rows, no objects.
    - `"reissue during upload refuses the submission"`: verify, the banker reissues, then upload → 403, 0 rows, and the written objects were deleted.
    - `"two tabs submitting at once: exactly one succeeds"`: `Promise.all` of two valid uploads with the same `cs` → statuses `[200, 403]` in some order, the documents come from one submission only, and the losing submission's objects are deleted.
    - `"the banker sees the uploaded documents"`: Alice's detail page lists both file names, type labels and `clean`.
- [ ] **Step 2: Run** `bun test tests/uploads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `submitUpload` in the order given under Architecture. Keep a list of written keys, and delete them in a `catch` or on any non-`submitted` outcome after writes began.
- [ ] **Step 4: Run** `bun test && bun run typecheck && bun fmt --check`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "feat: customer upload with content checks, storage, scan and submit"`

---

### Task 4: Evidence

**Files:**

- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/decisions.md`, `evidence/operate.md`

- [ ] **Step 1: `design.md`.**
  - In the security table, "Malicious upload" and "Keeping data too long" (retention date) become _Built_.
  - Add an "Uploads" subsection covering:
    - one input per type
    - all-or-nothing checks
    - the order of hash, scan, store, then commit
    - the re-check under the link lock
    - cleanup of written objects
    - stored content type from detection only
- [ ] **Step 2: `verify.md`.**
  - Record the real results.
  - Add the "Uploads" test group.
  - Mark AC-2, AC-3 and AC-4 _Met_, and AC-5 _Met_ (used, revoked, expired).
  - Keep the orphan-object gap (crash between put and commit).
- [ ] **Step 3: `decisions.md`.** Add a short record, or extend D1: the upload form uses one input per document type, because a per-file dropdown needs client script. Same outcome, no JavaScript.
- [ ] **Step 4: `operate.md`.**
  - Storage: the compose bucket job, the RustFS console for browsing objects, and the S3 buckets used in production.
  - Failure-mode rows for storage and scanner move from _Designed_ to built behaviour (503, nothing stored, session kept).
- [ ] **Step 5: Commit**: `git commit -m "docs: record uploads in evidence"`
