import { runMigrations } from '../src/db/migrate'

await runMigrations(process.env.DATABASE_OWNER_URL!)
