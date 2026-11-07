import type { Config } from './config'
import { createDb, type Db } from './db/client'
import { alwaysClean, type MalwareScanner } from './ports/scanner'
import { outboxSms, type SmsSender } from './ports/sms'
import { type ObjectStore, s3Store } from './ports/storage'

/** Everything the app needs from the outside world, built once at startup and swapped in tests. */
export type Deps = {
  config: Config
  db: Db
  sms: SmsSender
  storage: ObjectStore
  scanner: MalwareScanner
  now: () => Date
  log: (line: string) => void
}

export function buildDeps(config: Config): Deps {
  return {
    config,
    db: createDb(config.databaseUrl),
    sms: outboxSms,
    storage: s3Store(config.s3),
    scanner: alwaysClean,
    now: () => new Date(),
    log: (l) => console.log(l),
  }
}
