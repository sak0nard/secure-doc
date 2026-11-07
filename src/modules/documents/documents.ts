import { asc, eq } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { documents } from '../../db/schema'

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
