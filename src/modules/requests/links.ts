import { eq } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { uploadLinks } from '../../db/schema'
import { randomToken, sha256Hex } from '../access/crypto'
import { type ActionContext, auditAction } from '../audit/audit'

export const LINK_TTL_MS = 72 * 3600_000

/** The one refusal every unusable link gets, so the page never reveals why. */
export const REFUSED_LINK_TEXT = 'This link is no longer valid. Contact your banker.'

export type LinkResolution =
  | { ok: true; linkId: string; requestId: string }
  | {
      ok: false
      reason: 'unknown' | 'used' | 'revoked' | 'locked' | 'expired'
      linkId?: string
      requestId?: string
    }

/**
 * Finds the link for a raw token and says whether it can be used now, and if not, why.
 * With `lock`, holds the link's row lock until the transaction ends, so the answer stays
 * true while the caller acts on it (take it before any audit write).
 */
export async function resolveLink(
  db: Db | Tx,
  token: string,
  now: Date,
  opts: { lock?: boolean } = {}
): Promise<LinkResolution> {
  const query = db
    .select({
      linkId: uploadLinks.id,
      requestId: uploadLinks.requestId,
      state: uploadLinks.state,
      expiresAt: uploadLinks.expiresAt,
    })
    .from(uploadLinks)
    .where(eq(uploadLinks.tokenHash, sha256Hex(token)))
  const [link] = await (opts.lock ? query.for('update') : query)
  if (!link) return { ok: false, reason: 'unknown' }
  const { linkId, requestId, state, expiresAt } = link
  if (state !== 'active') return { ok: false, reason: state, linkId, requestId }
  if (now.getTime() >= expiresAt.getTime())
    return { ok: false, reason: 'expired', linkId, requestId }
  return { ok: true, linkId, requestId }
}

/** First 8 hex characters of a token hash: enough to correlate audit events, useless to an attacker. */
export const tokenHashPrefix = (tokenHash: string) => tokenHash.slice(0, 8)

/**
 * Issues a new active link for a request. Only the token's hash is stored; the raw token is
 * returned once for the banker and cannot be recovered afterwards.
 */
export async function issueLink(
  tx: Tx,
  ctx: ActionContext,
  requestId: string
): Promise<{ linkId: string; token: string }> {
  const token = randomToken()
  const tokenHash = sha256Hex(token)
  const expiresAt = new Date(ctx.now.getTime() + LINK_TTL_MS)
  const [link] = await tx
    .insert(uploadLinks)
    .values({ requestId, tokenHash, issuedAt: ctx.now, expiresAt })
    .returning({ id: uploadLinks.id })
  await auditAction(tx, ctx, {
    action: 'link.issued',
    target: { type: 'link', id: link!.id },
    requestId,
    outcome: 'success',
    detail: { tokenHashPrefix: tokenHashPrefix(tokenHash), expiresAt },
  })
  return { linkId: link!.id, token }
}
