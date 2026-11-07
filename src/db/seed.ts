import { customers, users } from "./schema";
import { createDb, type Db } from "./client";

/** Fixed ids so tests and demos can refer to seeded records. All data is synthetic. */
export const SEED = {
  users: {
    alice: "00000000-0000-4000-8000-00000000a11c",
    bob: "00000000-0000-4000-8000-000000000b0b",
    carol: "00000000-0000-4000-8000-0000000ca201",
  },
  customers: {
    dana: "00000000-0000-4000-8000-0000000da7a0",
    eli: "00000000-0000-4000-8000-0000000000e1",
    fay: "00000000-0000-4000-8000-000000000fa1",
  },
} as const;

export async function seed(db: Db): Promise<void> {
  await db
    .insert(users)
    .values([
      { id: SEED.users.alice, name: "Alice Banker", role: "banker" },
      { id: SEED.users.bob, name: "Bob Banker", role: "banker" },
      { id: SEED.users.carol, name: "Carol Compliance", role: "compliance" },
    ])
    .onConflictDoNothing();
  await db
    .insert(customers)
    .values([
      { id: SEED.customers.dana, name: "Dana Customer", mobile: "+61400000101" },
      { id: SEED.customers.eli, name: "Eli Customer", mobile: "+61400000102" },
      { id: SEED.customers.fay, name: "Fay Customer", mobile: "+61400000103" },
    ])
    .onConflictDoNothing();
}

if (import.meta.main) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error("DATABASE_OWNER_URL is required");
  const db = createDb(url);
  await seed(db);
  await db.$client.close();
  console.log("seed applied");
}
