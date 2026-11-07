import type { Config } from './config'
import { createDb, type Db } from './db/client'
import { outboxSms, type SmsSender } from './ports/sms'

/** Everything the app needs from the outside world, built once at startup and swapped in tests. */
export type Deps = {
  config: Config
  db: Db
  sms: SmsSender
  now: () => Date
  log: (line: string) => void
}

export function buildDeps(config: Config): Deps {
  return {
    config,
    db: createDb(config.databaseUrl),
    sms: outboxSms,
    now: () => new Date(),
    log: (l) => console.log(l),
  }
}
