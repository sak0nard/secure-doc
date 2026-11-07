import { S3Client } from 'bun'
import type { Config } from '../config'

/** Where uploaded files live. Keys are ours (`documents/<uuid>`); never a customer's file name. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** The object's bytes, or null if there is no such object. */
  get(key: string): Promise<Uint8Array | null>
  /** Deleting a missing object is not an error. */
  delete(key: string): Promise<void>
}

/** Local adapter: RustFS (S3-compatible) through Bun's S3 client. The bucket must exist. */
export function s3Store(s3: Config['s3']): ObjectStore {
  const client = new S3Client({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })
  return {
    async put(key, bytes, contentType) {
      await client.write(key, bytes, { type: contentType })
    },
    async get(key) {
      try {
        return await client.file(key).bytes()
      } catch (e) {
        if ((e as { code?: string }).code === 'NoSuchKey') return null
        throw e
      }
    },
    async delete(key) {
      await client.delete(key)
    },
  }
}
