import { Elysia } from 'elysia'
import { z } from 'zod'
import type { Deps } from '../../deps'
import { authorise } from '../../modules/access/policy'
import { type ActionContext, auditAction } from '../../modules/audit/audit'
import { CONTENT_TYPES } from '../../modules/documents/checks'
import {
  contentDisposition,
  getDocument,
  safeDownloadName,
} from '../../modules/documents/documents'
import { getRequest } from '../../modules/requests/requests'
import { denied } from '../deny'
import { sourceIp } from '../http'
import { requireUser } from '../session'
import { message } from './requests'

const unavailable = () =>
  message('Not available', "This document isn't available.", 404)

/**
 * Downloads, always as attachments: uploaded content is never rendered on the portal's
 * own origin. Only clean documents leave storage, and every download is audited.
 */
export function documentRoutes(deps: Deps) {
  return new Elysia()
    .use(requireUser(deps))
    .get('/documents/:id', async ({ user, params, request, server }) => {
      const ctx: ActionContext = {
        actor: { type: 'user', id: user!.id },
        ip: sourceIp(request, server, deps.config.trustProxy),
        now: deps.now(),
      }
      const id = z.uuid().safeParse(params.id)
      const doc = id.success ? await getDocument(deps.db, id.data) : null
      const req = doc && (await getRequest(deps.db, doc.requestId, ctx.now))
      if (!doc || !req) return message('Not found', 'There is no such document.', 404)
      if (!authorise(user!, 'document.download', req))
        return denied(
          deps,
          ctx,
          'document.download',
          { type: 'document', id: doc.id },
          req.id
        )
      if (doc.scanStatus !== 'clean')
        return message('Not ready', 'This document is still being checked.', 409)

      const bytes = await deps.storage.get(doc.storageKey)
      if (!bytes) {
        deps.log(`ERROR GET /documents/${doc.id}: stored object is missing`)
        return unavailable()
      }
      // A download without its audit event must not happen: if this throws, nothing is sent.
      await deps.db.transaction((tx) =>
        auditAction(tx, ctx, {
          action: 'document.downloaded',
          target: { type: 'document', id: doc.id },
          requestId: req.id,
          outcome: 'success',
          detail: { sha256: doc.sha256 },
        })
      )
      return new Response(bytes, {
        headers: {
          'content-type': CONTENT_TYPES[doc.detectedType],
          'content-disposition': contentDisposition(
            safeDownloadName(doc.originalFilename, doc.detectedType)
          ),
          'x-content-type-options': 'nosniff',
        },
      })
    })
}
