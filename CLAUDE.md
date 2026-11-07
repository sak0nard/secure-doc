# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth

`evidence/intent.md` is the spec for a **Secure Document Request Portal**: bankers request documents, customers upload through a single-use link plus a one-time code, and every access is audited. Read it before designing or changing anything. Requirement IDs (FR-1 … FR-17) and the acceptance criteria are the reference points for scope and tests.

## Time-boxed slice: what is real vs mocked

Build the full journey end to end with **real security logic**, and mock only the external integrations:
- SMS → a mock outbox page shows the code
- SSO → RBAC with seeded users and roles (banker, compliance officer, customer, system)
- Object storage → local or simulated storage
- Malware scan → a hook that always passes
- Customer master → seeded synthetic records
- Database → local, not encrypted at rest

In scope, beyond the original slice list: customers can request a new one-time code when it expires, and code resends are rate-limited per link (FR-7).

Out of scope for the slice: the retention purge job (FR-15, but still record the retention date on each file), notifications (FR-16), cancellation, legal hold and bulk requests, plus WCAG testing, TLS and rate limiting (assumed handled at the infrastructure layer).

## Invariants that cut across the design

- Upload tokens and one-time codes are stored **only as SHA-256 hashes**. The raw token is shown to the banker once and can never be retrieved again. Mask tokens in logs.
- A link is single-use. It expires after 72h, or when the upload session is submitted, or when it is reissued (the old link is revoked immediately). The code expires after 5 minutes, and 5 wrong attempts lock the link and log a suspicious-activity event.
- Uploads accept PDF, JPG and PNG up to 10 MB, with type checked by **magic bytes**, not extension. Stored files get a random internal name, a SHA-256 hash and a retention date. Store them outside the web root.
- Only the requesting banker and compliance officers can view documents. Customers can upload but never view. Denied attempts are logged.
- The audit log is append-only. Each event records actor, action, target, time, source IP and outcome, plus the **hash of the previous event**, so any edit or deletion breaks the chain and is detectable.
- Storage, messaging and identity sit behind interfaces so the mocks can be swapped for real providers without changing business logic.
- Set `Referrer-Policy: no-referrer` on customer link pages.

## Documents

- `docs/superpowers/specs/` holds the single design spec for the slice. It covers in-scope items only.
- `docs/superpowers/plans/` holds small, separately reviewable implementation plans, one per chunk of the spec.
- `evidence/` holds the reviewer-facing record. Keep these four files current as the work lands, and restate the content in each one rather than linking to the spec:
  - `evidence/design.md`: architecture overview, data flow, component boundaries, key trade-offs, security and privacy considerations, technology choices, and the likely production/cloud shape.
  - `evidence/verify.md`: tests and checks run, their results, known gaps, and which checks run locally versus in a PR or pipeline.
  - `evidence/operate.md`: how to run the solution, logs and status, the config and secrets approach, failure modes, rollback/degrade thinking, and local-to-cloud considerations.
  - `evidence/decisions.md`: 3–5 short decision records, including important trade-offs and what was intentionally not built.

## Working conventions

Use the project skill `software-design-principles` (`.claude/skills/`) when planning or making code changes. It covers minimal layers and state, small verifiable units (failing test first, then the fix), and testing behaviour rather than implementation. Write tests against the acceptance criteria in `evidence/intent.md`.
