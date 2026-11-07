import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db, Tx } from "../../db/client";
import { users, userSessions } from "../../db/schema";
import { randomToken, sha256Hex } from "./crypto";

export type User = { id: string; name: string; role: "banker" | "compliance" };

export const USER_SESSION_TTL_MS = 8 * 3600_000;

export async function createUserSession(db: Db | Tx, userId: string, now: Date) {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + USER_SESSION_TTL_MS);
  await db.insert(userSessions).values({ userId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

/** Returns the signed-in user, or null for a missing, unknown, ended or expired token. */
export async function resolveUserSession(db: Db | Tx, token: string | undefined, now: Date): Promise<User | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(eq(userSessions.tokenHash, sha256Hex(token)), isNull(userSessions.endedAt), gt(userSessions.expiresAt, now)),
    );
  return row ?? null;
}

export async function endUserSession(db: Db | Tx, token: string | undefined, now: Date): Promise<void> {
  if (!token) return;
  await db
    .update(userSessions)
    .set({ endedAt: now })
    .where(and(eq(userSessions.tokenHash, sha256Hex(token)), isNull(userSessions.endedAt)));
}
