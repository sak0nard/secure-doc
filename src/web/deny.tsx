import type { Deps } from '../deps'
import type { Action } from '../modules/access/policy'
import { type ActionContext, auditAction } from '../modules/audit/audit'
import { Layout, page } from './render'

/**
 * Records a refused action and returns the generic 403 page. The audit event commits in its
 * own transaction, because the action it records never happened.
 */
export async function denied(
  deps: Deps,
  ctx: ActionContext,
  action: Action,
  target: { type: string; id: string },
  requestId?: string
): Promise<Response> {
  await deps.db.transaction((tx) =>
    auditAction(tx, ctx, {
      action: 'access.denied',
      target,
      requestId,
      outcome: 'denied',
      detail: { action },
    })
  )
  return page(
    <Layout title="Access denied">
      <h1>Access denied</h1>
      <p>You don't have access to this.</p>
      <p>
        <a href="/">Back to requests</a>
      </p>
    </Layout>,
    { status: 403 }
  )
}
