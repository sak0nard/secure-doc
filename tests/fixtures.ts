/** Small files that start with the right magic bytes, plus look-alikes that must be refused. */

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p))
  )

export const pdf = () =>
  bytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
export const png = () =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 0x0d], 'IHDR')
export const jpeg = () => bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0])
/** A Windows executable (`MZ` header). */
export const exe = () => bytes('MZ', [0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
/** A Linux executable (`7F 45 4C 46`). */
export const elf = () => bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])

/** `prefix` padded with zeros to exactly `total` bytes. */
export function sized(prefix: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total)
  out.set(prefix.subarray(0, total))
  return out
}
