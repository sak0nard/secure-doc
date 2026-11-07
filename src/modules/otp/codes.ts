import { and, eq, isNull } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { customers, otpCodes, requests, uploadLinks } from '../../db/schema'
import type { SmsSender } from '../../ports/sms'
import { type ActionContext, auditAction } from '../audit/audit'
import { maskMobile } from '../requests/status'

/** The largest multiple of 10⁶ below 2³². Values at or above it would bias the low codes. */
const UNBIASED_LIMIT = 4_294_000_000

const randomUint32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!

/** A uniform 6-digit code from a CSPRNG, by rejection sampling. Leading zeros are kept. */
export function generateCode(nextUint32: () => number = randomUint32): string {
  let value = nextUint32()
  while (value >= UNBIASED_LIMIT) value = nextUint32()
  return String(value % 1_000_000).padStart(6, '0')
}

/** Hex HMAC-SHA-256. */
export function hmacHex(key: string, message: string): string {
  return new Bun.CryptoHasher('sha256', key).update(message).digest('hex')
}

/**
 * The only form in which a code is stored. Keyed, so a leaked table cannot be reversed by
 * hashing all 10⁶ codes; bound to the link, so a hash is useless for any other link.
 */
export const hashCode = (pepper: string, linkId: string, code: string) =>
  hmacHex(pepper, `${linkId}:${code}`)

export const CODE_TTL_MS = 5 * 60_000
export const MAX_CODES_PER_LINK = 3
export const RESEND_COOLDOWN_MS = 30_000

const smsBody = (code: string) =>
  `Your secure document upload code is ${code}. It expires in 5 minutes. We will never ask for this code by phone or email.`

/** What the customer's link page shows: where codes go, what is asked for, and whether one was sent. */
export async function linkForCustomer(db: Db | Tx, linkId: string) {
  const [row] = await db
    .select({
      mobile: customers.mobile,
      documentTypes: requests.documentTypes,
      codesSent: uploadLinks.codesSent,
    })
    .from(uploadLinks)
    .innerJoin(requests, eq(requests.id, uploadLinks.requestId))
    .innerJoin(customers, eq(customers.id, requests.customerId))
    .where(eq(uploadLinks.id, linkId))
  if (!row) throw new Error(`no link ${linkId}`)
  const { mobile, ...rest } = row
  return { maskedMobile: maskMobile(mobile), ...rest }
}

/**
 * Texts a new code to the customer's mobile unless the link has used its allowance or the
 * last code went out under 30 seconds ago. Earlier codes stop working. Locks the link row
 * first, so concurrent sends for one link queue and cannot overshoot the limit.
 */
export async function sendCode(
  tx: Tx,
  ctx: ActionContext,
  linkId: string,
  opts: { pepper: string; sms: SmsSender }
): Promise<
  { sent: true; maskedMobile: string } | { sent: false; reason: 'limit' | 'cooldown' }
> {
  const [link] = await tx
    .select({
      requestId: uploadLinks.requestId,
      codesSent: uploadLinks.codesSent,
      lastCodeSentAt: uploadLinks.lastCodeSentAt,
      mobile: customers.mobile,
    })
    .from(uploadLinks)
    .innerJoin(requests, eq(requests.id, uploadLinks.requestId))
    .innerJoin(customers, eq(customers.id, requests.customerId))
    .where(eq(uploadLinks.id, linkId))
    .for('update', { of: uploadLinks })
  if (!link) throw new Error(`no link ${linkId}`)
  const now = ctx.now
  const audit = (action: string, outcome: 'success' | 'failure', detail: object) =>
    auditAction(tx, ctx, {
      action,
      target: { type: 'link', id: linkId },
      requestId: link.requestId,
      outcome,
      detail: { ...detail },
    })

  const tooSoon =
    link.lastCodeSentAt !== null &&
    now.getTime() - link.lastCodeSentAt.getTime() < RESEND_COOLDOWN_MS
  const reason =
    link.codesSent >= MAX_CODES_PER_LINK ? 'limit' : tooSoon ? 'cooldown' : null
  if (reason) {
    await audit('otp.send_refused', 'failure', { reason })
    return { sent: false, reason }
  }

  await tx
    .update(otpCodes)
    .set({ consumedAt: now })
    .where(and(eq(otpCodes.linkId, linkId), isNull(otpCodes.consumedAt)))
  const code = generateCode()
  await tx.insert(otpCodes).values({
    linkId,
    codeHash: hashCode(opts.pepper, linkId, code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  })
  const codesSent = link.codesSent + 1
  await tx
    .update(uploadLinks)
    .set({ codesSent, lastCodeSentAt: now })
    .where(eq(uploadLinks.id, linkId))
  await opts.sms.send(tx, { to: link.mobile, body: smsBody(code), linkId })
  await audit('otp.sent', 'success', { codesSent })
  return { sent: true, maskedMobile: maskMobile(link.mobile) }
}
