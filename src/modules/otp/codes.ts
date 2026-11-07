/** The largest multiple of 10⁶ below 2³². Values at or above it would bias the low codes. */
const UNBIASED_LIMIT = 4_294_000_000

const randomUint32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!

/** A uniform 6-digit code from a CSPRNG, by rejection sampling. Leading zeros are kept. */
export function generateCode(nextUint32: () => number = randomUint32): string {
  let value = nextUint32()
  while (value >= UNBIASED_LIMIT) value = nextUint32()
  return String(value % 1_000_000).padStart(6, '0')
}

/** Hex HMAC-SHA-256. */
export function hmacHex(key: string, message: string): string {
  return new Bun.CryptoHasher('sha256', key).update(message).digest('hex')
}

/**
 * The only form in which a code is stored. Keyed, so a leaked table cannot be reversed by
 * hashing all 10⁶ codes; bound to the link, so a hash is useless for any other link.
 */
export const hashCode = (pepper: string, linkId: string, code: string) =>
  hmacHex(pepper, `${linkId}:${code}`)
