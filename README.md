# Secure Document Request Portal

Bankers request documents from customers. Customers upload through a single-use link protected by a one-time code. Every access is audited.

- Requirements: `evidence/intent.md`
- Design and evidence: `evidence/design.md`, `evidence/verify.md`, `evidence/operate.md`, `evidence/decisions.md`

## Run locally

Requires Bun 1.4+ and Docker.

```bash
bun install
cp .env.example .env
bun run services      # Postgres 18 (host port 5433), RustFS (9000, console 9001), buckets
bun run db:migrate
bun run db:seed
bun run dev           # http://localhost:3000
```

Sign in at `/login` as any seeded user. Sign-in is mocked; there are no passwords.

## Test

```bash
bun run services      # tests use the secure_doc_test database in the same container
bun test
bun run typecheck
```

## Format

```bash
bun fmt            # format everything
bun fmt --check    # verify without writing
```

The style lives in the `[fmt]` section of `bunfig.toml`.
