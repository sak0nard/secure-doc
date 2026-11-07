import { Elysia } from 'elysia'
import type { Deps } from '../../deps'
import { sha256Hex } from '../../modules/access/crypto'
import { appendAudit } from '../../modules/audit/audit'
import {
  REFUSED_LINK_TEXT,
  resolveLink,
  tokenHashPrefix,
} from '../../modules/requests/links'
import { sourceIp } from '../http'
import { Layout, page } from '../render'

/** The same page for every unusable link: unknown, used, revoked, locked or expired. */
export function refusedLinkPage() {
  return page(
    <Layout title="Link not valid">
      <p>{REFUSED_LINK_TEXT}</p>
    </Layout>,
    { status: 404 }
  )
}

/** Customer pages. No account: the link token in the URL is the only credential. */
export function customerRoutes(deps: Deps) {
  return new Elysia().get('/u/:token', async ({ params, request, server }) => {
    const now = deps.now()
    const link = await resolveLink(deps.db, params.token, now)
    if (!link.ok) {
      // The real reason goes to the audit log only, never to the page.
      await deps.db.transaction((tx) =>
        appendAudit(tx, {
          at: now,
          actor: { type: 'customer', id: link.linkId ?? 'anonymous' },
          action: 'link.refused',
          target: { type: 'link', id: link.linkId ?? 'unknown' },
          requestId: link.requestId,
          sourceIp: sourceIp(request, server, deps.config.trustProxy),
          outcome: 'failure',
          detail: {
            reason: link.reason,
            tokenHashPrefix: tokenHashPrefix(sha256Hex(params.token)),
          },
        })
      )
      return refusedLinkPage()
    }
    // Placeholder until the one-time-code flow replaces this page.
    return page(
      <Layout title="Secure document upload">
        <h1>Secure document upload</h1>
        <p>Your banker has asked you for some documents.</p>
      </Layout>
    )
  })
}
