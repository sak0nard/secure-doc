import { Elysia } from 'elysia'
import type { Tx } from '../../db/client'
import type { Deps } from '../../deps'
import { sha256Hex } from '../../modules/access/crypto'
import { type ActionContext, appendAudit } from '../../modules/audit/audit'
import { linkForCustomer, sendCode } from '../../modules/otp/codes'
import {
  REFUSED_LINK_TEXT,
  resolveLink,
  tokenHashPrefix,
} from '../../modules/requests/links'
import { sourceIp } from '../http'
import { Layout, page, types } from '../render'

const SEND_REFUSED_TEXT = {
  limit: 'Too many codes requested; contact your banker.',
  cooldown: 'Please wait a moment before requesting another code.',
} as const

/** The same page for every unusable link: unknown, used, revoked, locked or expired. */
export function refusedLinkPage() {
  return page(
    <Layout title="Link not valid">
      <p>{REFUSED_LINK_TEXT}</p>
    </Layout>,
    { status: 404 }
  )
}

function SendCodeForm({ token, label }: { token: string; label: string }) {
  return (
    <form method="post" action={`/u/${token}/code`}>
      <button type="submit">{label}</button>
    </form>
  )
}

function CodeForm({ token }: { token: string }) {
  return (
    <form method="post" action={`/u/${token}/verify`}>
      <label>
        Enter the 6-digit code{' '}
        <input
          type="text"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
      </label>
      <button type="submit">Verify</button>
    </form>
  )
}

/** The code-entry page, with an optional notice (e.g. a refused resend) above the form. */
function codePage(token: string, notice: string, status = 200) {
  return page(
    <Layout title="Enter your code">
      <h1>Enter your code</h1>
      <p>{notice}</p>
      <CodeForm token={token} />
      <p>Didn't get it?</p>
      <SendCodeForm token={token} label="Send a new code" />
    </Layout>,
    { status }
  )
}

/** Customer pages. No account: the link token in the URL is the only credential. */
export function customerRoutes(deps: Deps) {
  /**
   * Runs `fn` in a transaction holding the link's row lock, so the link stays usable while
   * `fn` acts on it. An unusable link gets the generic refusal; the real reason goes to the
   * audit log only.
   */
  const withLink = (
    token: string,
    request: Request,
    server: Parameters<typeof sourceIp>[1],
    fn: (tx: Tx, ctx: ActionContext, linkId: string) => Promise<Response>
  ) =>
    deps.db.transaction(async (tx) => {
      const now = deps.now()
      const ip = sourceIp(request, server, deps.config.trustProxy)
      const link = await resolveLink(tx, token, now, { lock: true })
      if (link.ok)
        return fn(
          tx,
          { actor: { type: 'customer', id: link.linkId }, ip, now },
          link.linkId
        )
      await appendAudit(tx, {
        at: now,
        actor: { type: 'customer', id: link.linkId ?? 'anonymous' },
        action: 'link.refused',
        target: { type: 'link', id: link.linkId ?? 'unknown' },
        requestId: link.requestId,
        sourceIp: ip,
        outcome: 'failure',
        detail: {
          reason: link.reason,
          tokenHashPrefix: tokenHashPrefix(sha256Hex(token)),
        },
      })
      return refusedLinkPage()
    })

  return new Elysia()
    .get('/u/:token', ({ params, request, server }) =>
      withLink(params.token, request, server, async (tx, _ctx, linkId) => {
        const link = await linkForCustomer(tx, linkId)
        return page(
          <Layout title="Secure document upload">
            <h1>Secure document upload</h1>
            <p>Your banker has asked you for: {types(link.documentTypes)}.</p>
            <p>We'll text a code to {link.maskedMobile}.</p>
            <SendCodeForm token={params.token} label="Text me a code" />
            {link.codesSent > 0 && <CodeForm token={params.token} />}
          </Layout>
        )
      })
    )
    .post('/u/:token/code', ({ params, request, server }) =>
      withLink(params.token, request, server, async (tx, ctx, linkId) => {
        const result = await sendCode(tx, ctx, linkId, {
          pepper: deps.config.otpPepper,
          sms: deps.sms,
        })
        if (result.sent)
          return codePage(params.token, `We sent a code to ${result.maskedMobile}.`)
        return codePage(params.token, SEND_REFUSED_TEXT[result.reason], 429)
      })
    )
}
