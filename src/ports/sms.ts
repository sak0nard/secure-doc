import { desc } from 'drizzle-orm'
import type { Db, Tx } from '../db/client'
import { outbox } from '../db/schema'

/**
 * Sends a text message. Takes the caller's transaction so a code is never recorded as sent
 * unless its message is recorded too (a transactional outbox, drained by a relay in production).
 */
export interface SmsSender {
  send(tx: Tx, msg: { to: string; body: string; linkId: string }): Promise<void>
}

/** Local adapter: the `outbox` table stands in for the customer's phone. */
export const outboxSms: SmsSender = {
  async send(tx, msg) {
    await tx
      .insert(outbox)
      .values({ toMobile: msg.to, body: msg.body, linkId: msg.linkId })
  },
}

/** The newest mock text messages, for the dev outbox page. */
export function latestOutbox(db: Db, limit = 50) {
  return db.select().from(outbox).orderBy(desc(outbox.createdAt)).limit(limit)
}
