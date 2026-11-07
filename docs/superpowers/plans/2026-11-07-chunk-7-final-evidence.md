# Chunk 7: Review, Wrap-Up and Final Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the slice is independently reviewed, runs cleanly from an empty checkout, has a CI pipeline definition matching what verify.md promises, and the four evidence documents describe exactly what was built and verified.

**Architecture:** no new features. This chunk does four things:

- an independent review of chunks 2–6 (only chunk 1 has had one)
- removal of leftovers
- a pipeline file
- a final pass over the evidence, so every claim matches a command that was run

**Tech Stack:** as before, plus GitHub Actions YAML and the `playwright-cli` skill for a browser walkthrough.

**Spec:** `docs/superpowers/specs/2026-11-07-secure-doc-portal-design.md` (§9, §10, §12)

## Global Constraints

- **Documentation:**
  - Every number or result written in `evidence/` comes from a command run in this chunk, quoted with the command.
  - `evidence/decisions.md` holds **3–5** decision records, plus the "Intentionally not built" table. Merge or trim records to fit.
  - Documents never mention time limits.
- **Review fixes:** every Critical or Important finding is fixed with a test that failed first. Minor findings are listed, not fixed.
- **Pipeline:** the pipeline file is not run here. `verify.md` says so plainly and lists what was checked locally instead.
- **Process:** run `bun fmt` before each commit. Use no destructive git or Docker commands (`docker compose down -v` only in Task 3's clean-start check, on this project's own volumes).

## Review Focus

1. **Evidence claims that drift from the code** (for example "Designed" rows that are now built, or test counts from an older run). _Task 4 check._
2. **A fresh checkout following only README.md** must reach a working sign-in. _Task 3 check._
3. **Phone-width customer pages**: no horizontal scroll and readable forms. _Task 3 walkthrough._
4. **Pipeline service setup** (bucket creation, app role, test DB) matches compose. _Task 2 review._
5. **Cross-chunk lock ordering**: every transaction takes row locks before its first audit write. _Task 1 review focus._

---

### Task 1: Independent review of chunks 2–6

- [ ] **Step 1:** build the review package for `0151791..HEAD` (`.claude/skills/subagent-driven-development/scripts/review-package`).
- [ ] **Step 2:** dispatch a fresh reviewer on the most capable model with `.claude/skills/requesting-code-review/code-reviewer.md`, the package, the spec and the chunk 2–6 plans. Ask it specifically to check:
  - lock order across `requests`, `otp` and `documents` transactions (row locks before `appendAudit`)
  - that every state change writes its audit event in the same transaction, and every refusal commits its own event
  - that no raw token, code or file name reaches audit detail, logs or error pages
  - the single authorisation decision point, with no route bypassing `authorise`
  - each AC test genuinely exercising its criterion
- [ ] **Step 3:** re-grade the findings by effect. Fix each Critical and Important finding: failing test, fix, full suite. Record each fix in `verify.md` under "Review findings".
- [ ] **Step 4:** commit: `git commit -m "fix: address independent review findings"` (one commit per fix if they are unrelated).

### Task 2: Leftovers and pipeline

**Files:**

- Delete: `index.ts`
- Modify: `package.json` (drop `"module"`; pin `@types/bun` to the installed version)
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1:** remove the leftovers and run `bun install && bun run typecheck && bun test`. Expected: all pass.
- [ ] **Step 2:** write `ci.yml`, run on pull requests and pushes to `main`, with:
  - **services:**
    - `postgres:18`, with the same env as compose; the app role and test DB are created by running `docker/postgres/init.sh` through `psql` in a setup step
    - `rustfs/rustfs` at the pinned tag
  - **steps:**
    1. checkout
    2. `oven-sh/setup-bun` (pinned major)
    3. `bun install --frozen-lockfile`
    4. `bun fmt --check`
    5. `bun run typecheck`
    6. create the buckets (aws-cli, same commands as compose)
    7. `bun test` with `.env.test` values pointing at the service ports
    8. `bunx drizzle-kit generate` followed by `git diff --exit-code src/db/migrations` (schema and migrations agree)
    9. a dependency audit (`bun audit`, failing on high severity, if available in the installed Bun; otherwise note it)
  - Secret scanning and SAST are listed in `verify.md` as organisation-level checks, not in this file.
- [ ] **Step 3:** check the YAML parses: `bunx --bun yaml-lint .github/workflows/ci.yml`, or `bun -e "Bun.YAML.parse(await Bun.file('.github/workflows/ci.yml').text())"`. Expected: no error.
- [ ] **Step 4:** commit: `git commit -m "chore: remove init leftovers; add CI pipeline definition"`

### Task 3: Clean-start run and browser walkthrough

- [ ] **Step 1: clean start, following only `README.md`.**
  - Run `docker compose down -v`, then exactly the README's run commands.
  - Expected: every command exits 0; `/login` loads.
- [ ] **Step 2: walk the main journey** in a real browser with the `playwright-cli` skill, at desktop width and at 390 px wide for the customer pages:
  1. Alice creates a request for Dana (payslip and photo ID) and copies the link.
  2. Open the link, tap "Text me a code", and read the code from `/dev/outbox`.
  3. Enter the code and upload a PDF and a JPG.
  4. Alice sees Received and downloads.
  5. Bob is refused.
  6. Carol opens the audit trail and sees "Chain intact".

  Save one screenshot per step to `evidence/screenshots/NN-step.png`. Note any page that scrolls horizontally at 390 px and fix it, test-first where behaviour changes.

- [ ] **Step 3: alternate journeys,** each with a screenshot:
  - a wrong code five times shows the lock message
  - a `.pdf`-named executable is rejected with its reason
  - a reissued link gives the generic refusal
- [ ] **Step 4:** commit: `git commit -m "docs: walkthrough screenshots of the main and alternate journeys"`

### Task 4: Final evidence pass

**Files:**

- Modify: `evidence/design.md`, `evidence/verify.md`, `evidence/operate.md`, `evidence/decisions.md`, `README.md`

- [ ] **Step 1: `verify.md`.**
  - Replace the results with a fresh `bun test`, `bun run typecheck` and `bun fmt --check` run, quoted.
  - The acceptance-criteria table names the test(s) for each AC.
  - Add a "Manual walkthrough" section linking the screenshots.
  - Add "Review findings" (from Task 1).
  - Tidy known gaps and accepted risks, combining the deferred minors from every chunk into one list.
  - The "Local versus pipeline" table references `ci.yml`, says it hasn't been run here, and lists the organisation-level checks.
- [ ] **Step 2: `design.md`.**
  - Every security-table row says _Built_, or says plainly why not (out of scope).
  - Remove "Status" notes about future work, and check the data-flow steps match the code (route names, limits, messages).
- [ ] **Step 3: `operate.md`.** Re-check every command by running it. Make sure the failure modes table has no remaining "_Designed:_" for built behaviour.
- [ ] **Step 4: `decisions.md`.** Consolidate to 3–5 records. Suggested set:
  1. server-rendered pages
  2. hashes only, with keyed code hashes
  3. audit integrity (chain, database protections, same-transaction writes)
  4. the customer requests the code, with limits and lockout
  5. files are never rendered on the portal origin (one input per type, attachment-only downloads)

  Fold derived Expired into the trade-offs in `design.md` if needed to stay within five. Keep the "Intentionally not built" table current.

- [ ] **Step 5: `README.md`.** Add a short "What to look at first" list for a reviewer:
  - the evidence docs
  - the AC test file names
  - where the policy and audit modules live
- [ ] **Step 6:** commit: `git commit -m "docs: final evidence pass"`
