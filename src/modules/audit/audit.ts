import { asc, desc, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client";
import { auditEvents } from "../../db/schema";
import { sha256Hex } from "../access/crypto";

/** Every append takes this transaction-scoped advisory lock, so concurrent writers queue instead of forking the chain. */
export const AUDIT_CHAIN_LOCK = 7_210_001;
const GENESIS = "0".repeat(64);

export type AuditInput = {
  at: Date;
  actor: { type: "user" | "customer" | "system"; id: string };
  action: string;
  target: { type: string; id: string };
  requestId?: string;
  sourceIp: string;
  outcome: "success" | "failure" | "denied" | "suspicious";
  /** Never raw tokens, codes, passwords or file contents. */
  detail?: Record<string, unknown>;
};

export type ChainResult =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: number; reason: "hash_mismatch" | "link_mismatch" };

/** JSON with keys sorted at every depth and no whitespace; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type Row = typeof auditEvents.$inferSelect;

/** The chain format: every column except `seq` and `hash`, chained onto the previous hash. */
function hashOf(row: Omit<Row, "seq" | "hash">): string {
  const fields = {
    at: row.at.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    sourceIp: row.sourceIp,
    outcome: row.outcome,
    detail: row.detail,
    prevHash: row.prevHash,
  };
  return sha256Hex(row.prevHash + canonicalJson(fields));
}

/** The only way to write an audit event. Call it inside the transaction of the action it records. */
export async function appendAudit(tx: Tx, e: AuditInput): Promise<{ seq: number; hash: string }> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK}::bigint)`);
  const [last] = await tx
    .select({ hash: auditEvents.hash })
    .from(auditEvents)
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  const row = {
    at: e.at,
    actorType: e.actor.type,
    actorId: e.actor.id,
    action: e.action,
    targetType: e.target.type,
    targetId: e.target.id,
    requestId: e.requestId ?? null,
    sourceIp: e.sourceIp,
    outcome: e.outcome,
    detail: e.detail ?? {},
    prevHash: last?.hash ?? GENESIS,
  };
  const hash = hashOf(row);
  const [inserted] = await tx
    .insert(auditEvents)
    .values({ ...row, hash })
    .returning({ seq: auditEvents.seq });
  return { seq: inserted!.seq, hash };
}

/** Walks the log in order and reports the first event whose link or content does not check out. */
export async function verifyChain(db: Db | Tx): Promise<ChainResult> {
  const rows = await db.select().from(auditEvents).orderBy(asc(auditEvents.seq));
  let prev = GENESIS;
  let count = 0;
  for (const row of rows) {
    count++;
    if (row.prevHash !== prev) return { ok: false, count, brokenAt: row.seq, reason: "link_mismatch" };
    if (hashOf(row) !== row.hash) return { ok: false, count, brokenAt: row.seq, reason: "hash_mismatch" };
    prev = row.hash;
  }
  return { ok: true, count };
}
