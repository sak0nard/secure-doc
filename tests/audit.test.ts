import { beforeEach, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { auditEvents } from "../src/db/schema";
import { sha256Hex } from "../src/modules/access/crypto";
import { appendAudit, canonicalJson, verifyChain, type AuditInput } from "../src/modules/audit/audit";
import { appDb, resetDb, tamperAsOwner } from "./helpers";

beforeEach(resetDb);

const GENESIS = "0".repeat(64);

const ev = (n: number, extra: Partial<AuditInput> = {}): AuditInput => ({
  at: new Date(),
  actor: { type: "system", id: "system" },
  action: `test.e${n}`,
  target: { type: "none", id: "none" },
  sourceIp: "127.0.0.1",
  outcome: "success",
  ...extra,
});

const append = (e: AuditInput) => appDb.transaction((tx) => appendAudit(tx, e));
const rows = () => appDb.select().from(auditEvents).orderBy(asc(auditEvents.seq));
const appendThree = async () => {
  for (const n of [1, 2, 3]) await append(ev(n));
};

test("canonicalJson sorts keys at every depth", () => {
  expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
});

test("an empty log verifies", async () => {
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 0 });
});

test("the first event links to the genesis hash", async () => {
  await append(ev(1));
  const [row] = await rows();
  expect(row!.prevHash).toBe(GENESIS);
  expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row!.hash).not.toBe(row!.prevHash);
});

test("each event links to the one before", async () => {
  await appendThree();
  const all = await rows();
  for (let i = 1; i < all.length; i++) expect(all[i]!.prevHash).toBe(all[i - 1]!.hash);
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 3 });
});

test("detail survives a jsonb round trip", async () => {
  await append(ev(1, { detail: { zeta: 1, alpha: { y: "x", b: [3, 1] }, n: 2.5 } }));
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 1 });
});

test("detail values with a JSON form, such as dates, still verify", async () => {
  await append(ev(1, { detail: { expiresAt: new Date("2026-11-10T00:00:00.000Z"), skipped: undefined } }));
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 1 });
});

test("concurrent appends never fork the chain", async () => {
  await Promise.all(Array.from({ length: 25 }, (_, n) => append(ev(n))));
  expect(await verifyChain(appDb)).toEqual({ ok: true, count: 25 });
  expect(new Set((await rows()).map((r) => r.prevHash)).size).toBe(25);
});

test("a rolled-back action leaves no audit event", async () => {
  const failing = appDb.transaction(async (tx) => {
    await appendAudit(tx, ev(1));
    throw new Error("action failed after auditing");
  });
  await expect(failing).rejects.toThrow("action failed after auditing");
  expect(await rows()).toHaveLength(0);
});

test("AC-9: editing an audit event is detected", async () => {
  await appendThree();
  await tamperAsOwner(async (tx) => {
    await tx.update(auditEvents).set({ detail: { edited: true } }).where(eq(auditEvents.seq, 2));
  });
  expect(await verifyChain(appDb)).toEqual({ ok: false, count: 2, brokenAt: 2, reason: "hash_mismatch" });
});

test("AC-9: editing an event and recomputing its hash is detected", async () => {
  await appendThree();
  const row = (await rows())[1]!;
  const { seq, hash, at, ...rest } = row;
  const forged = sha256Hex(row.prevHash + canonicalJson({ ...rest, at: at.toISOString(), outcome: "failure" }));
  await tamperAsOwner(async (tx) => {
    await tx.update(auditEvents).set({ outcome: "failure", hash: forged }).where(eq(auditEvents.seq, seq));
  });
  expect(await verifyChain(appDb)).toEqual({ ok: false, count: 3, brokenAt: 3, reason: "link_mismatch" });
});

test("AC-9: deleting an audit event is detected", async () => {
  await appendThree();
  await tamperAsOwner(async (tx) => {
    await tx.delete(auditEvents).where(eq(auditEvents.seq, 2));
  });
  expect(await verifyChain(appDb)).toEqual({ ok: false, count: 2, brokenAt: 3, reason: "link_mismatch" });
});
