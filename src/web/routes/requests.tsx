import { Elysia } from 'elysia'
import { z } from 'zod'
import type { Deps } from '../../deps'
import { type Action, authorise } from '../../modules/access/policy'
import type { User } from '../../modules/access/sessions'
import { type ActionContext, auditAction } from '../../modules/audit/audit'
import { type DocumentSummary, listDocuments } from '../../modules/documents/documents'
import {
  CHANGE_ALLOWED_FROM,
  closeRequest,
  createRequest,
  getRequest,
  reissueLink,
  type RequestDetail,
  DOCUMENT_TYPES,
  type DocumentType,
  findCustomer,
  listCustomers,
  listRequests,
} from '../../modules/requests/requests'
import { type DisplayStatus, maskMobile } from '../../modules/requests/status'
import { denied } from '../deny'
import { sourceIp } from '../http'
import { DOCUMENT_LABELS, Layout, page, types } from '../render'
import { requireUser } from '../session'

/** Checkboxes arrive as a string for one value and an array for several. */
const CreateForm = z.object({
  customerId: z.uuid(),
  documentTypes: z
    .preprocess(
      (v) => (v === undefined ? [] : [v].flat()),
      z.array(z.enum(DOCUMENT_TYPES)).min(1)
    )
    .transform((types) => [...new Set(types)]),
})

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

function StatusLabel({ status }: { status: DisplayStatus }) {
  return (
    <>
      {status.label}
      {status.linkLocked && <strong> · Link locked</strong>}
    </>
  )
}

/** The only place a raw link token is ever rendered: the response to create or reissue. */
function linkIssuedPage(url: string, requestId: string) {
  return page(
    <Layout title="Upload link">
      <h1>Upload link</h1>
      <p>Copy this link now. It won't be shown again.</p>
      <input type="text" readOnly value={url} size={70} aria-label="Upload link" />
      <p>Send it to the customer. They will also need a code sent to their mobile.</p>
      <p>
        <a href={`/requests/${requestId}`}>View request</a> ·{' '}
        <a href="/">All requests</a>
      </p>
    </Layout>
  )
}

function badForm() {
  return page(
    <Layout title="New request">
      <p>
        Choose a customer and at least one document type.{' '}
        <a href="/requests/new">Try again</a>.
      </p>
    </Layout>,
    { status: 400 }
  )
}

function message(title: string, text: string, status: number) {
  return page(
    <Layout title={title}>
      <p>{text}</p>
      <p>
        <a href="/">Back to requests</a>
      </p>
    </Layout>,
    { status }
  )
}

const notFound = () => message('Not found', 'There is no such request.', 404)
const conflict = () =>
  message('Not changed', "This request can't be changed in its current state.", 409)

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

function DocumentList({ docs }: { docs: DocumentSummary[] }) {
  if (docs.length === 0) return <p>None yet.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>File</th>
          <th>Format</th>
          <th>Size</th>
          <th>Uploaded</th>
          <th>Scan</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id}>
            <td>{DOCUMENT_LABELS[d.documentType]}</td>
            <td>{d.originalFilename}</td>
            <td>{d.detectedType.toUpperCase()}</td>
            <td>{size(d.sizeBytes)}</td>
            <td>{when(d.uploadedAt)}</td>
            <td>{d.scanStatus}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function detailPage(r: RequestDetail, docs: DocumentSummary[], user: User) {
  const canReissue =
    authorise(user, 'request.reissue', r) && r.stored === CHANGE_ALLOWED_FROM.reissue
  const canClose =
    authorise(user, 'request.close', r) && r.stored === CHANGE_ALLOWED_FROM.close
  return page(
    <Layout title="Request">
      <p>
        <a href="/">All requests</a>
      </p>
      <h1>Request for {r.customer.name}</h1>
      <dl>
        <dt>Customer</dt>
        <dd>
          {r.customer.name} ({r.customer.maskedMobile})
        </dd>
        <dt>Documents requested</dt>
        <dd>{types(r.documentTypes)}</dd>
        <dt>Created</dt>
        <dd>{when(r.createdAt)}</dd>
        <dt>Status</dt>
        <dd>
          {r.status.label}
          {r.status.linkLocked && <strong> · Link locked: reissue required</strong>}
        </dd>
        <dt>Upload link</dt>
        <dd>
          {r.link ? `${r.link.state}, valid until ${when(r.link.expiresAt)}` : 'None'}
        </dd>
      </dl>
      {canReissue && (
        <form method="post" action={`/requests/${r.id}/reissue`}>
          <button type="submit">Reissue link</button> The current link stops working.
        </form>
      )}
      {canClose && (
        <form method="post" action={`/requests/${r.id}/close`}>
          <button type="submit">Close request</button>
        </form>
      )}
      <h2>Documents</h2>
      <DocumentList docs={docs} />
    </Layout>
  )
}

export function requestRoutes(deps: Deps) {
  const context = (
    user: User,
    request: Request,
    server: Parameters<typeof sourceIp>[1]
  ): ActionContext => ({
    actor: { type: 'user', id: user.id },
    ip: sourceIp(request, server, deps.config.trustProxy),
    now: deps.now(),
  })
  const linkUrl = (token: string) => `${deps.config.baseUrl.origin}/u/${token}`

  /** Loads the request named in the URL and asks the policy; any refusal comes back as a response. */
  const forRequest = async (
    id: string,
    action: Action,
    user: User,
    request: Request,
    server: Parameters<typeof sourceIp>[1]
  ): Promise<{ refusal: Response } | { req: RequestDetail; ctx: ActionContext }> => {
    const ctx = context(user, request, server)
    const parsed = z.uuid().safeParse(id)
    const req = parsed.success ? await getRequest(deps.db, parsed.data, ctx.now) : null
    if (!req) return { refusal: notFound() }
    if (!authorise(user, action, req))
      return {
        refusal: await denied(
          deps,
          ctx,
          action,
          { type: 'request', id: req.id },
          req.id
        ),
      }
    return { req, ctx }
  }

  return new Elysia()
    .use(requireUser(deps))
    .get('/', async ({ user }) => {
      const rows = await listRequests(deps.db, user!, deps.now())
      return page(
        <Layout title="Requests">
          <p>
            Signed in as {user!.name} ({user!.role})
          </p>
          <form method="post" action="/logout">
            <button type="submit">Sign out</button>
          </form>
          <h1>Requests</h1>
          {authorise(user!, 'request.create') && (
            <p>
              <a href="/requests/new">New request</a>
            </p>
          )}
          {rows.length === 0 ? (
            <p>No requests yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Documents</th>
                  <th>Banker</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/requests/${r.id}`}>{r.customerName}</a>
                    </td>
                    <td>{types(r.documentTypes)}</td>
                    <td>{r.bankerName}</td>
                    <td>{when(r.createdAt)}</td>
                    <td>
                      <StatusLabel status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Layout>
      )
    })
    .get('/requests/new', async ({ user, request, server }) => {
      if (!authorise(user!, 'request.create'))
        return denied(deps, context(user!, request, server), 'request.create', {
          type: 'request',
          id: 'new',
        })
      const all = await listCustomers(deps.db)
      return page(
        <Layout title="New request">
          <h1>New request</h1>
          <form method="post" action="/requests">
            <label>
              Customer{' '}
              <select name="customerId" required>
                {all.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({maskMobile(c.mobile)})
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Documents needed</legend>
              {DOCUMENT_TYPES.map((t) => (
                <label key={t}>
                  <input type="checkbox" name="documentTypes" value={t} />{' '}
                  {DOCUMENT_LABELS[t]}
                </label>
              ))}
            </fieldset>
            <button type="submit">Create request</button>
          </form>
        </Layout>
      )
    })
    .post('/requests', async ({ user, body, request, server }) => {
      const ctx = context(user!, request, server)
      if (!authorise(user!, 'request.create'))
        return denied(deps, ctx, 'request.create', { type: 'request', id: 'new' })
      const form = CreateForm.safeParse(body)
      if (!form.success || !(await findCustomer(deps.db, form.data.customerId)))
        return badForm()
      const { requestId, token } = await deps.db.transaction((tx) =>
        createRequest(tx, ctx, { bankerId: user!.id, ...form.data })
      )
      return linkIssuedPage(linkUrl(token), requestId)
    })
    .get('/requests/:id', async ({ user, params, request, server }) => {
      const found = await forRequest(params.id, 'request.view', user!, request, server)
      if ('refusal' in found) return found.refusal
      const { req, ctx } = found
      await deps.db.transaction((tx) =>
        auditAction(tx, ctx, {
          action: 'request.viewed',
          target: { type: 'request', id: req.id },
          requestId: req.id,
          outcome: 'success',
        })
      )
      return detailPage(req, await listDocuments(deps.db, req.id), user!)
    })
    .post('/requests/:id/reissue', async ({ user, params, request, server }) => {
      const found = await forRequest(
        params.id,
        'request.reissue',
        user!,
        request,
        server
      )
      if ('refusal' in found) return found.refusal
      const { req, ctx } = found
      const result = await deps.db.transaction((tx) => reissueLink(tx, ctx, req.id))
      if ('conflict' in result) return conflict()
      return linkIssuedPage(linkUrl(result.token), req.id)
    })
    .post('/requests/:id/close', async ({ user, params, request, server }) => {
      const found = await forRequest(params.id, 'request.close', user!, request, server)
      if ('refusal' in found) return found.refusal
      const { req, ctx } = found
      const result = await deps.db.transaction((tx) => closeRequest(tx, ctx, req.id))
      if (result === 'conflict') return conflict()
      return new Response(null, {
        status: 303,
        headers: { location: `/requests/${req.id}` },
      })
    })
}
