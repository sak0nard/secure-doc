import { beforeEach, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { auditEvents, customers, requests, uploadLinks, users } from "../src/db/schema";
import { SEED, seed } from "../src/db/seed";
import { appDb, ownerDb, resetDb } from "./helpers";

beforeEach(resetDb);

// Drizzle queries are thenables and wrap driver errors; unwrap both so assertions see the Postgres error.
const run = async (q: PromiseLike<unknown>) => {
  try {
    return await q;
  } catch (e) {
    throw (e as Error).cause ?? e;
  }
};

const event = {
  at: new Date(),
  actorType: "system" as const,
  actorId: "system",
  action: "test.event",
  targetType: "none",
  targetId: "none",
  sourceIp: "127.0.0.1",
  outcome: "success" as const,
  detail: {},
  prevHash: "0".repeat(64),
  hash: "1".repeat(64),
};

test("app role can insert and read audit events", async () => {
  await appDb.insert(auditEvents).values(event);
  const rows = await appDb.select().from(auditEvents);
  expect(rows.map((r) => r.action)).toEqual(["test.event"]);
});

test("app role cannot update or delete audit events", async () => {
  await appDb.insert(auditEvents).values(event);
  await expect(run(appDb.update(auditEvents).set({ outcome: "failure" }))).rejects.toThrow(/permission denied/);
  await expect(run(appDb.delete(auditEvents))).rejects.toThrow(/permission denied/);
});

test("trigger blocks even the owner from editing audit events", async () => {
  await appDb.insert(auditEvents).values(event);
  await expect(run(ownerDb.update(auditEvents).set({ outcome: "failure" }))).rejects.toThrow(/append-only/);
  await expect(run(ownerDb.delete(auditEvents))).rejects.toThrow(/append-only/);
});

async function newRequest() {
  const [r] = await appDb
    .insert(requests)
    .values({ customerId: SEED.customers.dana, bankerId: SEED.users.alice, documentTypes: ["payslip"], status: "open" })
    .returning();
  return r!;
}

function link(requestId: string, state: "active" | "revoked", n: number) {
  const now = new Date();
  return { requestId, tokenHash: n.toString(16).padStart(64, "0"), state, issuedAt: now, expiresAt: new Date(now.getTime() + 72 * 3600_000) };
}

test("only one active link per request", async () => {
  const r = await newRequest();
  await appDb.insert(uploadLinks).values(link(r.id, "active", 1));
  await expect(run(appDb.insert(uploadLinks).values(link(r.id, "active", 2)))).rejects.toThrow(/upload_links_one_active_per_request/);
  await appDb.insert(uploadLinks).values(link(r.id, "revoked", 3));
});

test("seed is idempotent", async () => {
  await seed(appDb);
  await seed(appDb);
  const [u] = await appDb.select({ n: count() }).from(users);
  const [c] = await appDb.select({ n: count() }).from(customers);
  expect([u!.n, c!.n]).toEqual([3, 3]);
});

test("seeded roles", async () => {
  const role = async (id: string) => (await appDb.select().from(users).where(eq(users.id, id)))[0]!.role;
  expect([await role(SEED.users.alice), await role(SEED.users.bob), await role(SEED.users.carol)]).toEqual([
    "banker",
    "banker",
    "compliance",
  ]);
});
