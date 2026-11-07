/** Hex SHA-256. Used for every stored token hash. */
export function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

/** 32 random bytes, base64url-encoded (43 characters, 256 bits). */
export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
