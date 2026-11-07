/** Checks file content for malware. A scanner that throws means "unknown", which callers treat as a failure. */
export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<'clean' | 'infected'>
}

/** Local adapter: the slice has no scanning engine, so every file passes. */
export const alwaysClean: MalwareScanner = {
  scan: async () => 'clean',
}
