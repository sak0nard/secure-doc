import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { seed } from "../src/db/seed";

export const config = loadConfig(process.env);
export const ownerDb = createDb(config.databaseOwnerUrl);
export const appDb = createDb(config.databaseUrl);

/** Empty every table (as owner, so audit rows can go too) and re-seed. */
export async function resetDb(): Promise<void> {
  const rows = await ownerDb.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = [...rows].map((r) => `"${r.tablename}"`).join(", ");
  if (names) await ownerDb.execute(sql.raw(`truncate ${names} restart identity cascade`));
  await seed(ownerDb);
}
