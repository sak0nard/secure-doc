import { z } from 'zod'

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_OWNER_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().min(1),
  BASE_URL: z.url(),
  OTP_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  RETENTION_DAYS: z.coerce.number().int().positive().default(2555),
  TRUST_PROXY: bool,
  MOCK_OUTBOX_ENABLED: bool,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
})

export type Config = {
  databaseUrl: string
  databaseOwnerUrl: string
  s3: {
    endpoint: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    region: string
  }
  baseUrl: URL
  otpPepper: string
  retentionDays: number
  trustProxy: boolean
  mockOutboxEnabled: boolean
  port: number
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`)
  }
  const e = parsed.data
  return {
    databaseUrl: e.DATABASE_URL,
    databaseOwnerUrl: e.DATABASE_OWNER_URL,
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      region: e.S3_REGION,
    },
    baseUrl: new URL(e.BASE_URL),
    otpPepper: e.OTP_PEPPER,
    retentionDays: e.RETENTION_DAYS,
    trustProxy: e.TRUST_PROXY,
    mockOutboxEnabled: e.MOCK_OUTBOX_ENABLED,
    port: e.PORT,
  }
}
