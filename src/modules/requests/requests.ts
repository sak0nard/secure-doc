import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { customers, documentType, requests, uploadLinks, users } from '../../db/schema'
import { authorise } from '../access/policy'
import type { User } from '../access/sessions'
import { type ActionContext, auditAction } from '../audit/audit'
import { issueLink, tokenHashPrefix } from './links'
import {
  type DisplayStatus,
  displayStatus,
  type LinkState,
  maskMobile,
  type StoredStatus,
} from './status'

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

/** The one stored status each change may start from. Pages read it to decide which buttons to show. */
export const CHANGE_ALLOWED_FROM = { reissue: 'open', close: 'received' } as const

/** Locks the request row, so concurrent changes to the same request queue behind each other. */
async function lockStatus(tx: Tx, requestId: string): Promise<StoredStatus | null> {
  const [row] = await tx
    .select({ status: requests.status })
    .from(requests)
    .where(eq(requests.id, requestId))
    .for('update')
  return row?.status ?? null
}

/** Revokes the request's active link, if any, and issues a new one. Only while open. */
export async function reissueLink(
  tx: Tx,
  ctx: ActionContext,
  requestId: string
): Promise<{ token: string } | { conflict: true }> {
  if ((await lockStatus(tx, requestId)) !== CHANGE_ALLOWED_FROM.reissue)
    return { conflict: true }
  const revoked = await tx
    .update(uploadLinks)
    .set({ state: 'revoked' })
    .where(and(eq(uploadLinks.requestId, requestId), eq(uploadLinks.state, 'active')))
    .returning({ id: uploadLinks.id, tokenHash: uploadLinks.tokenHash })
  for (const link of revoked)
    await auditAction(tx, ctx, {
      action: 'link.revoked',
      target: { type: 'link', id: link.id },
      requestId,
      outcome: 'success',
      detail: { tokenHashPrefix: tokenHashPrefix(link.tokenHash) },
    })
  const { token } = await issueLink(tx, ctx, requestId)
  await tx
    .update(requests)
    .set({ updatedAt: ctx.now })
    .where(eq(requests.id, requestId))
  return { token }
}

/** Received → Closed. */
export async function closeRequest(
  tx: Tx,
  ctx: ActionContext,
  requestId: string
): Promise<'closed' | 'conflict'> {
  if ((await lockStatus(tx, requestId)) !== CHANGE_ALLOWED_FROM.close) return 'conflict'
  await tx
    .update(requests)
    .set({ status: 'closed', updatedAt: ctx.now })
    .where(eq(requests.id, requestId))
  await auditAction(tx, ctx, {
    action: 'request.closed',
    target: { type: 'request', id: requestId },
    requestId,
    outcome: 'success',
  })
  return 'closed'
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

const currentLink = (state: LinkState | null, expiresAt: Date | null) =>
  state && expiresAt ? { state, expiresAt } : null

export type RequestDetail = {
  id: string
  bankerId: string
  customer: { name: string; maskedMobile: string }
  documentTypes: DocumentType[]
  stored: StoredStatus
  status: DisplayStatus
  link: { state: LinkState; expiresAt: Date } | null
  createdAt: Date
}

/** One request with its current link, or null if there is no such request. */
export async function getRequest(
  db: Db | Tx,
  id: string,
  now: Date
): Promise<RequestDetail | null> {
  const link = currentLinks(db)
  const [row] = await db
    .select({
      id: requests.id,
      bankerId: requests.bankerId,
      customerName: customers.name,
      mobile: customers.mobile,
      documentTypes: requests.documentTypes,
      status: requests.status,
      createdAt: requests.createdAt,
      linkState: link.state,
      linkExpiresAt: link.expiresAt,
    })
    .from(requests)
    .innerJoin(customers, eq(customers.id, requests.customerId))
    .leftJoin(link, eq(link.requestId, requests.id))
    .where(eq(requests.id, id))
  if (!row) return null
  const current = currentLink(row.linkState, row.linkExpiresAt)
  return {
    id: row.id,
    bankerId: row.bankerId,
    customer: { name: row.customerName, maskedMobile: maskMobile(row.mobile) },
    documentTypes: row.documentTypes,
    stored: row.status,
    status: displayStatus(row.status, current, now),
    link: current,
    createdAt: row.createdAt,
  }
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
      status: displayStatus(r.status, currentLink(r.linkState, r.linkExpiresAt), now),
    }))
}
