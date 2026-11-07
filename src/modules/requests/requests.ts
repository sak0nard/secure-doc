import { desc, eq, sql } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { customers, documentType, requests, uploadLinks, users } from '../../db/schema'
import { authorise } from '../access/policy'
import type { User } from '../access/sessions'
import { type ActionContext, auditAction } from '../audit/audit'
import { issueLink } from './links'
import { type DisplayStatus, displayStatus } from './status'

export const DOCUMENT_TYPES = documentType.enumValues
export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export type Customer = { id: string; name: string; mobile: string }

/** Stands in for the customer master record. */
export function listCustomers(db: Db | Tx): Promise<Customer[]> {
  return db.select().from(customers).orderBy(customers.name)
}

export async function findCustomer(db: Db | Tx, id: string): Promise<Customer | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id))
  return row ?? null
}

export async function createRequest(
  tx: Tx,
  ctx: ActionContext,
  input: { bankerId: string; customerId: string; documentTypes: DocumentType[] }
): Promise<{ requestId: string; token: string }> {
  const [request] = await tx
    .insert(requests)
    .values({ ...input, createdAt: ctx.now, updatedAt: ctx.now })
    .returning({ id: requests.id })
  const requestId = request!.id
  await auditAction(tx, ctx, {
    action: 'request.created',
    target: { type: 'request', id: requestId },
    requestId,
    outcome: 'success',
    detail: { customerId: input.customerId, documentTypes: input.documentTypes },
  })
  const { token } = await issueLink(tx, ctx, requestId)
  return { requestId, token }
}

/**
 * The link that decides a request's display status: its active link if it has one,
 * otherwise the most recently issued.
 */
function currentLinks(db: Db | Tx) {
  return db
    .selectDistinctOn([uploadLinks.requestId], {
      requestId: uploadLinks.requestId,
      state: uploadLinks.state,
      expiresAt: uploadLinks.expiresAt,
    })
    .from(uploadLinks)
    .orderBy(
      uploadLinks.requestId,
      desc(sql`${uploadLinks.state} = 'active'`),
      desc(uploadLinks.issuedAt)
    )
    .as('current_link')
}

export type RequestSummary = {
  id: string
  customerName: string
  documentTypes: DocumentType[]
  createdAt: Date
  bankerName: string
  status: DisplayStatus
}

/** The requests `user` may view, newest first. */
export async function listRequests(
  db: Db | Tx,
  user: User,
  now: Date
): Promise<RequestSummary[]> {
  const link = currentLinks(db)
  const rows = await db
    .select({
      id: requests.id,
      bankerId: requests.bankerId,
      customerName: customers.name,
      documentTypes: requests.documentTypes,
      createdAt: requests.createdAt,
      bankerName: users.name,
      status: requests.status,
      linkState: link.state,
      linkExpiresAt: link.expiresAt,
    })
    .from(requests)
    .innerJoin(customers, eq(customers.id, requests.customerId))
    .innerJoin(users, eq(users.id, requests.bankerId))
    .leftJoin(link, eq(link.requestId, requests.id))
    .orderBy(desc(requests.createdAt), desc(requests.id))
  return rows
    .filter((r) => authorise(user, 'request.view', r))
    .map((r) => ({
      id: r.id,
      customerName: r.customerName,
      documentTypes: r.documentTypes,
      createdAt: r.createdAt,
      bankerName: r.bankerName,
      status: displayStatus(
        r.status,
        r.linkState && r.linkExpiresAt
          ? { state: r.linkState, expiresAt: r.linkExpiresAt }
          : null,
        now
      ),
    }))
}
