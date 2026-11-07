import { Elysia } from 'elysia'
import type { Deps } from '../../deps'
import { latestOutbox } from '../../ports/sms'
import { Layout, page } from '../render'

/** The mock phone: shows texted codes. Mounted only when MOCK_OUTBOX_ENABLED=true. */
export function devRoutes(deps: Deps) {
  return new Elysia().get('/dev/outbox', async () => {
    const rows = await latestOutbox(deps.db)
    return page(
      <Layout title="Mock SMS outbox">
        <h1>Mock SMS outbox</h1>
        <p>Development only. These messages stand in for texts to the customer.</p>
        {rows.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sent</th>
                <th>To</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{m.createdAt.toISOString()}</td>
                  <td>{m.toMobile}</td>
                  <td>{m.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Layout>
    )
  })
}
