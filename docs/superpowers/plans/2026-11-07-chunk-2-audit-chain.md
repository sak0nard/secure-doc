# Chunk 2: Audit Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hash-chained, append-only audit log that every later action writes to, a verifier that finds the first broken event, and sign-in/sign-out as the first audited actions.

**Architecture:** `src/modules/audit/audit.ts` owns three things: the chain format (canonical JSON + SHA-256), `appendAudit(tx, event)` and `verifyChain(db)`.
- **Atomic writes:** appends take a Postgres transaction-scoped advisory lock, so concurrent writers queue instead of forking the chain. The event commits or rolls back with the action it records.
- **Stored time is hashed time:** the timestamp is generated in app code, so the value that is hashed equals the value stored.

**Tech Stack:** as chunk 1 (Bun, Elysia, Drizzle `bun-sql`, Postgres 18).

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§4 component boundaries, §6.6 audit log, §9 AC-9 row)

## Global Constraints

- **Chain format:**
  - `hash = sha256Hex(prevHash + canonicalJson(fields))`, where `fields` are every column except `seq` and `hash`: `at` (ISO-8601 string), `actorType`, `actorId`, `action`, `targetType`, `targetId`, `requestId` (null when absent), `sourceIp`, `outcome`, `detail`, `prevHash`.
  - The genesis `prevHash` is `"0".repeat(64)`.
- **Canonical JSON:** keys sorted at every depth, no whitespace, arrays kept in order.
- **Advisory lock key:** one constant, `AUDIT_CHAIN_LOCK = 7_210_001`, taken with `pg_advisory_xact_lock`.
- **Audit hygiene:** `detail` never holds raw tokens, codes, passwords or file contents.
- **Outcomes:** `success | failure | denied | suspicious`.
- **Actor types:** `user | customer | system`. Use `actorId: "anonymous"` when no one is signed in.
- **Tamper simulation:** tests tamper as the owner role, with the trigger disabled inside a transaction. The trigger itself is never loosened.
- **Accepted risk (not to be "fixed" here):** the owner can truncate or rewrite the audit table.
- **Testing:** test-first. Tests live in `tests/`; code lives in `src/`.
- **Wording:** documents never mention time limits.

## Review Focus

1. **Many requests auditing at the same moment** must still produce one unbroken chain. *Task 1 test: 25 concurrent appends.*
2. **`detail` with keys in any order, nested objects or numbers** must verify after a round trip through `jsonb`, which reorders keys. *Task 1 test.*
3. **An action that fails after writing its audit event** must leave no event. *Task 1 rollback test.*
4. **A failed sign-in** (unknown user) is still audited, with no session created. *Task 2 test.*
5. **The client IP behind a trusted proxy** is the one recorded in the event. *Task 2 test.*

---

## File Structure

```
src/modules/audit/audit.ts     canonicalJson, appendAudit, verifyChain, types
src/web/routes/login.tsx       (modify) audit sign-in, failed sign-in, sign-out
tests/audit.test.ts            chain behaviour + AC-9
tests/login.test.ts            (modify) audit assertions
tests/helpers.ts               (modify) tamperAsOwner(), headers option on get/post
evidence/*.md                  (modify) record what is now built
```

---

### Task 1: Append and verify the chain

**Files:**
- Create: `src/modules/audit/audit.ts`
- Modify: `tests/helpers.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: `Db`, `Tx` (`src/db/client.ts`), `auditEvents` (`src/db/schema.ts`), `sha256Hex` (`src/modules/access/crypto.ts`).
- Produces:
  - `type AuditInput = { at: Date; actor: { type: "user" | "customer" | "system"; id: string }; action: string; target: { type: string; id: string }; requestId?: string; sourceIp: string; outcome: "success" | "failure" | "denied" | "suspicious"; detail?: Record<string, unknown> }`
  - `appendAudit(tx: Tx, e: AuditInput): Promise<{ seq: number; hash: string }>`. It must be called inside a transaction, because the lock is transaction-scoped.
  - `type ChainResult = { ok: true; count: number } | { ok: false; count: number; brokenAt: number; reason: "hash_mismatch" | "link_mismatch" }`
  - `verifyChain(db: Db | Tx): Promise<ChainResult>`
  - `canonicalJson(value: unknown): string`
  - Test helper: `tamperAsOwner(fn: (tx: Tx) => Promise<void>): Promise<void>`. Runs `fn` in an owner transaction between `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only` and `ENABLE TRIGGER`.

**Verify algorithm** (the signature and tests don't fix the order of checks):

```
prev = GENESIS
for row in audit_events order by seq:
  if row.prevHash != prev            → { ok:false, brokenAt: row.seq, reason: "link_mismatch" }
  if hash(row fields) != row.hash    → { ok:false, brokenAt: row.seq, reason: "hash_mismatch" }
  prev = row.hash
→ { ok:true, count }
```

`count` is the number of rows checked so far, including the broken one.

- [ ] **Step 1: Write failing tests** in `tests/audit.test.ts` (`beforeEach(resetDb)`; `ev(n)` builds an `AuditInput` with `action: "test.e" + n`, `actor {system, "system"}`, `target {none, "none"}`, `sourceIp "127.0.0.1"`, `outcome "success"`; `append(e)` = `appDb.transaction(tx => appendAudit(tx, e))`):
  - `"canonicalJson sorts keys at every depth"`: `canonicalJson({ b: 1, a: { d: [2, 1], c: null } })` is exactly `'{"a":{"c":null,"d":[2,1]},"b":1}'`.
  - `"an empty log verifies"`: `verifyChain(appDb)` → `{ ok: true, count: 0 }`.
  - `"the first event links to the genesis hash"`: after one append, the row's `prevHash` is `"0".repeat(64)` and its `hash` is 64 hex characters, not equal to `prevHash`.
  - `"each event links to the one before"`: after three appends, rows in `seq` order satisfy `rows[i].prevHash === rows[i-1].hash`, and `verifyChain` → `{ ok: true, count: 3 }`.
  - `"detail survives a jsonb round trip"`: append with `detail: { zeta: 1, alpha: { y: "x", b: [3, 1] }, n: 2.5 }` → `verifyChain` ok.
  - `"concurrent appends never fork the chain"`: `Promise.all` of 25 `append` calls → `verifyChain` → `{ ok: true, count: 25 }`, and the 25 `prevHash` values are all distinct.
  - `"a rolled-back action leaves no audit event"`: inside `appDb.transaction`, append, then throw → the transaction rejects, and `audit_events` has 0 rows.
  - `"AC-9: editing an audit event is detected"`: append 3. Then `tamperAsOwner` updates the `detail` of `seq 2` to `{ edited: true }` → `verifyChain` → `{ ok: false, brokenAt: 2, reason: "hash_mismatch", count: 2 }`.
  - `"AC-9: editing an event and recomputing its hash is detected"`: append 3. `tamperAsOwner` sets `seq 2`'s `outcome` to `"failure"` **and** its `hash` to a recomputed value → `{ ok: false, brokenAt: 3, reason: "link_mismatch" }`. *(For the recomputed hash, use the exported `canonicalJson` and `sha256Hex` with the same field list as the Global Constraints.)*
  - `"AC-9: deleting an audit event is detected"`: append 3; `tamperAsOwner` deletes `seq 2` → `{ ok: false, brokenAt: 3, reason: "link_mismatch" }`.
- [ ] **Step 2: Run** `bun test tests/audit.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `src/modules/audit/audit.ts`.
  - `appendAudit`:
    1. `select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`.
    2. Read the latest row's `hash` by `seq desc limit 1`, or use genesis if there's none.
    3. Build the fields, compute the hash, insert, and return `seq` and `hash`.
  - The hashed `at` is `e.at.toISOString()`. On verify, rebuild it from the stored `timestamptz` with `toISOString()`; millisecond precision round-trips.
  - Put the field list in one `hashFields(row)` function used by both append and verify.
- [ ] **Step 4: Run** `bun test`. Expected: all PASS. Then `bun run typecheck`. Expected: no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: hash-chained audit log with verification"`

---

### Task 2: Audit sign-in and sign-out

**Files:**
- Modify: `src/web/routes/login.tsx`, `tests/helpers.ts` (`headers?: Record<string,string>` option on `get`/`post`)
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes: `appendAudit`, `sourceIp(request, server, trustProxy)` (`src/web/http.ts`), `createUserSession`, `endUserSession`, `resolveUserSession`.
- Produces: audit actions `user.signed_in`, `user.sign_in_failed`, `user.signed_out`, the pattern later chunks copy. That pattern:
  1. Compute `ip = sourceIp(request, server, deps.config.trustProxy)` in the route.
  2. Open `deps.db.transaction`.
  3. Do the change and call `appendAudit` with `at: deps.now()`.
  4. Commit together.

**Event shapes:**

| Action | Actor | Target | Outcome |
| --- | --- | --- | --- |
| `user.signed_in` | `user`, signed-in id | `user`, same id | `success` |
| `user.sign_in_failed` | `user`, `"anonymous"` | `user`, the submitted id if it is a valid UUID, else `"invalid"` | `failure` |
| `user.signed_out` | `user`, the id of the session being ended | `user`, same id | `success` |

A sign-out with no valid session writes no event.

- [ ] **Step 1: Write failing tests**, appended to `tests/login.test.ts`:
  - `"sign-in is audited"`: after login as alice, exactly one `audit_events` row has `action "user.signed_in"`, `actorType "user"`, `actorId SEED.users.alice`, `outcome "success"`; its `detail` doesn't contain the cookie value.
  - `"failed sign-in is audited without creating a session"`: post `userId: crypto.randomUUID()` → one `user.sign_in_failed` row, `outcome "failure"`, `targetId` equal to that UUID; `user_sessions` has 0 rows.
  - `"sign-out is audited"`: login, then logout → one `user.signed_out` row with `actorId` alice.
  - `"audit records the client IP from a trusted proxy"`: `testApp({ config: { ...config, trustProxy: true } })`, login with header `x-forwarded-for: 10.9.9.9, 203.0.113.7` → the `user.signed_in` row has `sourceIp "203.0.113.7"`.
  - `"the chain stays intact across sign-in activity"`: login, a failed login, logout → `verifyChain(appDb)` → `{ ok: true, count: 3 }`.
- [ ] **Step 2: Run** `bun test tests/login.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **Sign-in:** wrap `createUserSession` and `appendAudit` in one transaction.
  - **Failed sign-in:** write its event in its own transaction before returning 400.
  - **Sign-out:** to learn the actor, `resolveUserSession` runs *before* `endUserSession`. Both, plus the append, go in one transaction.
  - **Client IP:** Elysia exposes `server` on the handler context. Under `app.handle` it's `null`, and `sourceIp` already returns `"unknown"`.
- [ ] **Step 4: Run** `bun test && bun run typecheck`. Expected: all PASS, no errors.
- [ ] **Step 5: Commit**: `git commit -m "feat: audit sign-in, failed sign-in and sign-out"`

---

### Task 3: Evidence

**Files:**
- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/decisions.md`, `evidence/operate.md`

- [ ] **Step 1: `design.md`**
  - Security table: the "Audit tampering" row becomes *Built*, naming the chain format.
  - Add a short "Audit chain" subsection:
    - the hashed fields
    - genesis
    - canonical JSON
    - the advisory lock
    - same-transaction writes
    - what verification reports
- [ ] **Step 2: `verify.md`**
  - Update the results to real numbers from `bun test`.
  - Add an "Audit chain" group listing the Task 1 tests, and sign-in auditing under "Sign-in and sessions".
  - Mark the AC-9 row *Met*, naming its three tests.
- [ ] **Step 3: `decisions.md` D3.** Add one line: verification reports the first broken event and why (edited content vs a broken link), and tamper tests simulate a privileged attacker without weakening the trigger.
- [ ] **Step 4: `operate.md`.** Under Logs, add that who-did-what is in `audit_events`, plus one `psql` query to read a request's events in order.
- [ ] **Step 5: Commit**: `git commit -m "docs: record the audit chain in evidence"`
