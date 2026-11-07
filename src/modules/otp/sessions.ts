import { and, eq, gt, isNull, type SQL } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { customerSessions, uploadLinks } from '../../db/schema'
import { randomToken, sha256Hex } from '../access/crypto'

/** The customer's upload-session cookie. Scoped to `/u`, so it never reaches staff pages. */
export const CUSTOMER_COOKIE = 'cs'
export const CUSTOMER_SESSION_TTL_MS = 15 * 60_000

export type CustomerSession = { sessionId: string; linkId: string; requestId: string }

/** Starts an upload session after a verified code. Only the token's hash is stored. */
export async function createCustomerSession(
  tx: Tx,
  linkId: string,
  now: Date
): Promise<{ token: string }> {
  const token = randomToken()
  await tx.insert(customerSessions).values({
    linkId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(now.getTime() + CUSTOMER_SESSION_TTL_MS),
  })
  return { token }
}

/** Sessions matching `match` that are still usable: see `resolveCustomerSession`. */
function usableSessions(db: Db | Tx, match: SQL, now: Date) {
  return db
    .select({
      sessionId: customerSessions.id,
      linkId: customerSessions.linkId,
      requestId: uploadLinks.requestId,
    })
    .from(customerSessions)
    .innerJoin(uploadLinks, eq(uploadLinks.id, customerSessions.linkId))
    .where(
      and(
        match,
        isNull(customerSessions.endedAt),
        gt(customerSessions.expiresAt, now),
        eq(uploadLinks.state, 'active'),
        gt(uploadLinks.expiresAt, now)
      )
    )
}

/**
 * The session for a cookie value, or null. A session is valid while it is unended and
 * unexpired and its link is still active and unexpired, so a reissue, lock or submit
 * ends it without touching the session row.
 */
export async function resolveCustomerSession(
  db: Db | Tx,
  token: string | undefined,
  now: Date
): Promise<CustomerSession | null> {
  if (!token) return null
  const [row] = await usableSessions(
    db,
    eq(customerSessions.tokenHash, sha256Hex(token)),
    now
  )
  return row ?? null
}

/**
 * Takes the session's link row lock, then says whether the session is still usable. The
 * answer holds until the transaction ends, so a reissue or another submit cannot slip in
 * between. Call it before any audit write in the transaction.
 */
export async function lockCustomerSession(
  tx: Tx,
  session: CustomerSession,
  now: Date
): Promise<boolean> {
  await tx
    .select({ id: uploadLinks.id })
    .from(uploadLinks)
    .where(eq(uploadLinks.id, session.linkId))
    .for('update')
  const [row] = await usableSessions(
    tx,
    eq(customerSessions.id, session.sessionId),
    now
  )
  return row !== undefined
}

/** Ends a session (e.g. on submit). Ending an already-ended session changes nothing. */
export async function endCustomerSession(
  tx: Tx,
  sessionId: string,
  now: Date
): Promise<void> {
  await tx
    .update(customerSessions)
    .set({ endedAt: now })
    .where(and(eq(customerSessions.id, sessionId), isNull(customerSessions.endedAt)))
}
