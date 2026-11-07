export const SECURITY_HEADERS: Record<string, string> = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
  'cache-control': 'no-store',
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/**
 * Hides customer link tokens before a path is logged. Masks the segment after any
 * `u` segment (except the fixed `upload` page) and any segment shaped like a token,
 * so malformed paths such as `//u/<token>` or `/U/<token>` never leak one.
 */
export function maskTokens(path: string): string {
  const parts = path.split('/')
  return parts
    .map((part, i) => {
      const afterU = i > 0 && parts[i - 1]!.toLowerCase() === 'u'
      const hide =
        TOKEN_SHAPE.test(part) || (afterU && part !== '' && part !== 'upload')
      return hide ? '****' : part
    })
    .join('/')
}

/** Drizzle appends bound parameters (codes, hashes, mobiles) to its error messages. */
export function withoutParams(message: string): string {
  return message.split('\nparams:')[0]!
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

/** State-changing requests must come from our own origin (CSRF defence alongside SameSite=Strict). */
export function originAllowed(request: Request, baseUrl: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return true
  const origin = request.headers.get('origin')
  if (origin === baseUrl.origin) return true
  // Under Referrer-Policy: no-referrer, browsers send `Origin: null` even for
  // same-site form posts. Fall back to Sec-Fetch-Site, which pages cannot forge.
  const opaque = origin === null || origin === 'null'
  return opaque && request.headers.get('sec-fetch-site') === 'same-origin'
}

type IpServer =
  { requestIP(req: Request): { address: string } | null } | null | undefined

export function sourceIp(
  request: Request,
  server: IpServer,
  trustProxy: boolean
): string {
  if (trustProxy) {
    // The trusted proxy appends the address it saw; anything to its left is client-supplied.
    const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
    if (forwarded) return forwarded
  }
  return server?.requestIP(request)?.address ?? 'unknown'
}
