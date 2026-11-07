import {
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  type DocumentType,
} from '../requests/requests'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 10

export type DetectedType = 'pdf' | 'png' | 'jpeg'

/** The only content type each detected type is ever stored or served as. */
export const CONTENT_TYPES: Record<DetectedType, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
}

const MAGIC: [DetectedType, number[]][] = [
  ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpeg', [0xff, 0xd8, 0xff]],
]

/** The file's type from its first bytes. The name and the client's content type play no part. */
export function detectType(bytes: Uint8Array): DetectedType | null {
  for (const [type, magic] of MAGIC)
    if (magic.every((b, i) => bytes[i] === b)) return type
  return null
}

/** A file as posted: `field` is the form input it came through, which names its document type. */
export type IncomingFile = { field: string; name: string; bytes: Uint8Array }
export type AcceptedFile = IncomingFile & {
  documentType: DocumentType
  detectedType: DetectedType
}
/**
 * Why a submission was refused. `reason` never contains the file name, so it is safe to
 * audit; `file` is the customer's name for the file, for display only.
 */
export type Problem = { field?: string; file?: string; reason: string }

/** A problem as the customer reads it, e.g. "payslip.pdf: larger than 10 MB". */
export const problemText = (p: Problem) =>
  p.file ? `${p.file}: ${p.reason}` : p.reason

const isDocumentType = (v: string): v is DocumentType =>
  (DOCUMENT_TYPES as readonly string[]).includes(v)

/**
 * Decides whether a submission can be accepted as a whole: every file a PDF, JPG or PNG
 * of at most 10 MB under a requested type, 1–10 files, and every requested type present.
 * Reports every problem at once so the customer can fix them in one go.
 */
export function checkSubmission(
  files: IncomingFile[],
  requested: DocumentType[]
): { ok: true; files: AcceptedFile[] } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = []
  const accepted: AcceptedFile[] = []
  if (files.length > MAX_FILES) problems.push({ reason: 'Too many files (at most 10)' })
  for (const f of files) {
    const before = problems.length
    const documentType =
      isDocumentType(f.field) && requested.includes(f.field) ? f.field : null
    if (!documentType)
      problems.push({
        field: f.field,
        file: f.name,
        reason: 'not a requested document',
      })
    const detectedType = detectType(f.bytes)
    if (!detectedType)
      problems.push({
        field: f.field,
        file: f.name,
        reason: 'not a PDF, JPG or PNG file',
      })
    if (f.bytes.length > MAX_FILE_BYTES)
      problems.push({ field: f.field, file: f.name, reason: 'larger than 10 MB' })
    if (problems.length === before && documentType && detectedType)
      accepted.push({ ...f, documentType, detectedType })
  }
  for (const t of requested)
    if (!files.some((f) => f.field === t))
      problems.push({ field: t, reason: `Missing: ${DOCUMENT_LABELS[t]}` })
  return problems.length ? { ok: false, problems } : { ok: true, files: accepted }
}
