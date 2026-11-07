import { asc, eq } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { documents } from '../../db/schema'
import type { DetectedType } from './checks'

export type DocumentSummary = Pick<
  typeof documents.$inferSelect,
  | 'id'
  | 'documentType'
  | 'originalFilename'
  | 'detectedType'
  | 'sizeBytes'
  | 'sha256'
  | 'scanStatus'
  | 'uploadedAt'
  | 'retentionUntil'
>

/** A request's documents, oldest upload first. Leaves out the storage key: pages name a document by its id. */
export function listDocuments(
  db: Db | Tx,
  requestId: string
): Promise<DocumentSummary[]> {
  return db
    .select({
      id: documents.id,
      documentType: documents.documentType,
      originalFilename: documents.originalFilename,
      detectedType: documents.detectedType,
      sizeBytes: documents.sizeBytes,
      sha256: documents.sha256,
      scanStatus: documents.scanStatus,
      uploadedAt: documents.uploadedAt,
      retentionUntil: documents.retentionUntil,
    })
    .from(documents)
    .where(eq(documents.requestId, requestId))
    .orderBy(
      asc(documents.uploadedAt),
      asc(documents.documentType),
      asc(documents.originalFilename)
    )
}

export type StoredDocument = Pick<
  typeof documents.$inferSelect,
  | 'id'
  | 'requestId'
  | 'storageKey'
  | 'detectedType'
  | 'originalFilename'
  | 'sha256'
  | 'scanStatus'
>

/** One document with where its bytes live, or null if there is no such document. */
export async function getDocument(
  db: Db | Tx,
  id: string
): Promise<StoredDocument | null> {
  const [row] = await db
    .select({
      id: documents.id,
      requestId: documents.requestId,
      storageKey: documents.storageKey,
      detectedType: documents.detectedType,
      originalFilename: documents.originalFilename,
      sha256: documents.sha256,
      scanStatus: documents.scanStatus,
    })
    .from(documents)
    .where(eq(documents.id, id))
  return row ?? null
}

const EXTENSIONS: Record<DetectedType, string> = {
  pdf: '.pdf',
  png: '.png',
  jpeg: '.jpg',
}
const MAX_BASE = 80

/**
 * The name a download is saved under: the customer's name without its extension, cut down
 * to `[A-Za-z0-9 ._-]` and 80 characters, plus the extension of the type we detected.
 * Nothing in it can break out of a header value or name a path.
 */
export function safeDownloadName(originalFilename: string, detectedType: DetectedType) {
  const dot = originalFilename.lastIndexOf('.')
  const base = dot === -1 ? originalFilename : originalFilename.slice(0, dot)
  const safe = base.replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, MAX_BASE)
  return `${safe || 'document'}${EXTENSIONS[detectedType]}`
}

/** `Content-Disposition` for a name from `safeDownloadName`. */
export const contentDisposition = (safeName: string) =>
  `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
