import { Elysia } from 'elysia'
import { z } from 'zod'
import type { Deps } from '../../deps'
import { authorise } from '../../modules/access/policy'
import type { User } from '../../modules/access/sessions'
import type { ActionContext } from '../../modules/audit/audit'
import {
  createRequest,
  DOCUMENT_TYPES,
  type DocumentType,
  findCustomer,
  listCustomers,
  listRequests,
} from '../../modules/requests/requests'
import { type DisplayStatus, maskMobile } from '../../modules/requests/status'
import { denied } from '../deny'
import { sourceIp } from '../http'
import { Layout, page } from '../render'
import { requireUser } from '../session'

const DOCUMENT_LABELS: Record<DocumentType, string> = {
  payslip: 'Payslip',
  bank_statement: 'Bank statement',
  photo_id: 'Photo ID',
  other: 'Other',
}

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

const types = (t: DocumentType[]) => t.map((d) => DOCUMENT_LABELS[d]).join(', ')
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
}
