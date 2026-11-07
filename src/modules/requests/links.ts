import type { Tx } from '../../db/client'
import { uploadLinks } from '../../db/schema'
import { randomToken, sha256Hex } from '../access/crypto'
import { type ActionContext, auditAction } from '../audit/audit'

export const LINK_TTL_MS = 72 * 3600_000

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
