export const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
  "cache-control": "no-store",
};

/** Customer link tokens live in `/u/<token>`; `/u/upload` is a fixed page, not a token. */
export function maskTokens(path: string): string {
  return path.replace(/^\/u\/([^/]+)/, (whole, segment: string) => (segment === "upload" ? whole : "/u/****"));
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** State-changing requests must come from our own origin (CSRF defence alongside SameSite=Strict). */
export function originAllowed(request: Request, baseUrl: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  return request.headers.get("origin") === baseUrl.origin;
}

type IpServer = { requestIP(req: Request): { address: string } | null } | null | undefined;

export function sourceIp(request: Request, server: IpServer, trustProxy: boolean): string {
  if (trustProxy) {
    // The trusted proxy appends the address it saw; anything to its left is client-supplied.
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return server?.requestIP(request)?.address ?? "unknown";
}
