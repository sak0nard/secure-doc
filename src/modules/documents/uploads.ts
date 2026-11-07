import { and, eq } from 'drizzle-orm'
import { documents, requests, uploadLinks } from '../../db/schema'
import type { Deps } from '../../deps'
import { sha256Hex } from '../access/crypto'
import { type ActionContext, auditAction } from '../audit/audit'
import {
  type CustomerSession,
  endCustomerSession,
  lockCustomerSession,
} from '../otp/sessions'
import {
  CONTENT_TYPES,
  checkSubmission,
  type IncomingFile,
  type Problem,
} from './checks'

export type SubmitResult =
  | { result: 'submitted'; documentIds: string[] }
  | { result: 'rejected'; problems: Problem[] }
  | { result: 'session_ended' }
  | { result: 'unavailable' }

const DAY_MS = 86_400_000

/** The UTC date `days` days after `now`, as Postgres `date` text. */
const dateAfter = (now: Date, days: number) =>
  new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10)

/**
 * Accepts a customer's submission as a whole, or nothing of it.
 *
 * 1. Check every file (type by content, size, count, completeness).
 * 2. Hash and scan every file; any infected file rejects the submission.
 * 3. Write the objects under random keys.
 * 4. In one transaction: lock the link, re-check the session, insert the documents, end
 *    the session, use up the link, move the request to received, and audit.
 *
 * Any outcome other than `submitted` deletes the objects already written (best effort).
 * A scanner or storage failure is `unavailable`; the session stays open for a retry.
 */
export async function submitUpload(
  deps: Pick<Deps, 'db' | 'storage' | 'scanner' | 'config'>,
  ctx: ActionContext,
  session: CustomerSession,
  files: IncomingFile[]
): Promise<SubmitResult> {
  const [request] = await deps.db
    .select({ documentTypes: requests.documentTypes })
    .from(requests)
    .where(eq(requests.id, session.requestId))
  const checked = checkSubmission(files, request!.documentTypes)
  if (!checked.ok) return reject(deps, ctx, session, checked.problems)

  let scanned
  try {
    scanned = await Promise.all(
      checked.files.map(async (f) => ({
        ...f,
        sha256: sha256Hex(f.bytes),
        scanStatus: await deps.scanner.scan(f.bytes),
      }))
    )
  } catch {
    return { result: 'unavailable' }
  }
  const infected = scanned.filter((f) => f.scanStatus === 'infected')
  if (infected.length)
    return reject(
      deps,
      ctx,
      session,
      infected.map((f) => ({
        field: f.field,
        file: f.name,
        reason: 'failed the security scan',
      }))
    )

  const written: string[] = []
  const removeWritten = () =>
    Promise.allSettled(written.map((key) => deps.storage.delete(key)))
  const toStore = scanned.map((f) => ({
    ...f,
    storageKey: `documents/${crypto.randomUUID()}`,
  }))
  try {
    for (const f of toStore) {
      // Recorded before the put, so a put that fails partway is cleaned up too.
      written.push(f.storageKey)
      await deps.storage.put(f.storageKey, f.bytes, CONTENT_TYPES[f.detectedType])
    }
  } catch {
    await removeWritten()
    return { result: 'unavailable' }
  }

  try {
    const outcome = await deps.db.transaction(async (tx) => {
      // Request row first, then the link row: the same order as a reissue, so the two
      // queue instead of deadlocking. Audit writes come after both.
      await tx
        .select({ id: requests.id })
        .from(requests)
        .where(eq(requests.id, session.requestId))
        .for('update')
      if (!(await lockCustomerSession(tx, session, ctx.now))) return null
      const inserted = await tx
        .insert(documents)
        .values(
          toStore.map((f) => ({
            requestId: session.requestId,
            storageKey: f.storageKey,
            documentType: f.documentType,
            originalFilename: f.name.slice(0, 255),
            detectedType: f.detectedType,
            sizeBytes: f.bytes.length,
            sha256: f.sha256,
            scanStatus: f.scanStatus,
            retentionUntil: dateAfter(ctx.now, deps.config.retentionDays),
            uploadedAt: ctx.now,
          }))
        )
        .returning({ id: documents.id, storageKey: documents.storageKey })
      await endCustomerSession(tx, session.sessionId, ctx.now)
      await tx
        .update(uploadLinks)
        .set({ state: 'used' })
        .where(eq(uploadLinks.id, session.linkId))
      await tx
        .update(requests)
        .set({ status: 'received', updatedAt: ctx.now })
        .where(and(eq(requests.id, session.requestId), eq(requests.status, 'open')))
      for (const f of toStore) {
        const id = inserted.find((d) => d.storageKey === f.storageKey)!.id
        await auditAction(tx, ctx, {
          action: 'document.uploaded',
          target: { type: 'document', id },
          requestId: session.requestId,
          outcome: 'success',
          detail: {
            documentType: f.documentType,
            detectedType: f.detectedType,
            sizeBytes: f.bytes.length,
            sha256: f.sha256,
          },
        })
      }
      await auditAction(tx, ctx, {
        action: 'request.received',
        target: { type: 'request', id: session.requestId },
        requestId: session.requestId,
        outcome: 'success',
        detail: { documents: inserted.length },
      })
      return inserted.map((d) => d.id)
    })
    if (outcome) return { result: 'submitted', documentIds: outcome }
    await removeWritten()
    return { result: 'session_ended' }
  } catch (e) {
    await removeWritten()
    throw e
  }
}

/** Records a refused submission. File names stay out of the audit log. */
async function reject(
  deps: Pick<Deps, 'db'>,
  ctx: ActionContext,
  session: CustomerSession,
  problems: Problem[]
): Promise<SubmitResult> {
  await deps.db.transaction((tx) =>
    auditAction(tx, ctx, {
      action: 'upload.rejected',
      target: { type: 'request', id: session.requestId },
      requestId: session.requestId,
      outcome: 'failure',
      detail: { problems: problems.map(({ field, reason }) => ({ field, reason })) },
    })
  )
  return { result: 'rejected', problems }
}
