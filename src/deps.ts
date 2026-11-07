import type { Config } from './config'
import { createDb, type Db } from './db/client'

/** Everything the app needs from the outside world, built once at startup and swapped in tests. */
export type Deps = {
  config: Config
  db: Db
  now: () => Date
  log: (line: string) => void
}

export function buildDeps(config: Config): Deps {
  return {
    config,
    db: createDb(config.databaseUrl),
    now: () => new Date(),
    log: (l) => console.log(l),
  }
}
