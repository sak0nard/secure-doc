import { eq } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client'
import { users } from '../../db/schema'
import type { User } from './sessions'

/** Everyone who can sign in. Stands in for the SSO directory. */
export function listUsers(db: Db | Tx): Promise<User[]> {
  return db.select().from(users).orderBy(users.name)
}

export async function findUser(db: Db | Tx, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  return row ?? null
}
