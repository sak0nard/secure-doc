import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb } from "./client";

export const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

/** Applies pending migrations as the owner role. Safe to run repeatedly. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const db = createDb(ownerUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.close();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error("DATABASE_OWNER_URL is required");
  await runMigrations(url);
  console.log("migrations applied");
}
