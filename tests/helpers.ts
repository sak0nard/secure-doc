import { sql } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { seed } from "../src/db/seed";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";

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

type App = { handle: (req: Request) => Promise<Response> };

/** Builds the app against the test database. `logs` collects request log lines. */
export function testApp(overrides: Partial<Deps> = {}) {
  const logs: string[] = [];
  const deps: Deps = { config, db: appDb, now: () => new Date(), log: (l) => logs.push(l), ...overrides };
  return { app: createApp(deps), logs, deps };
}

const url = (path: string) => new URL(path, config.baseUrl).toString();

export function get(app: App, path: string, opts: { cookie?: string } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return app.handle(new Request(url(path), { headers }));
}

/** Posts a urlencoded form. Sends a same-site Origin unless `origin` is given (`null` omits it). */
export function post(
  app: App,
  path: string,
  form: Record<string, string>,
  opts: { cookie?: string; origin?: string | null } = {},
) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const origin = opts.origin === undefined ? config.baseUrl.origin : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return app.handle(new Request(url(path), { method: "POST", headers, body: new URLSearchParams(form) }));
}
