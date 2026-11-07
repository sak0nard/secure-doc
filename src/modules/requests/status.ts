import type { linkState, requestStatus } from '../../db/schema'

export type StoredStatus = (typeof requestStatus.enumValues)[number]
export type LinkState = (typeof linkState.enumValues)[number]

export type DisplayStatus = {
  label: 'Open' | 'Expired' | 'Received' | 'Closed'
  linkLocked: boolean
}

const SETTLED = { received: 'Received', closed: 'Closed' } as const

/**
 * The status people see. "Expired" is derived, never stored: an open request whose latest
 * link is no longer usable. A locked link keeps the request Open, flagged for reissue.
 */
export function displayStatus(
  status: StoredStatus,
  latestLink: { state: LinkState; expiresAt: Date } | null,
  now: Date
): DisplayStatus {
  if (status !== 'open') return { label: SETTLED[status], linkLocked: false }
  if (latestLink?.state === 'locked') return { label: 'Open', linkLocked: true }
  const usable =
    latestLink?.state === 'active' && now.getTime() < latestLink.expiresAt.getTime()
  return { label: usable ? 'Open' : 'Expired', linkLocked: false }
}

/** Every digit except the last two becomes a bullet: `+61400000101` → `+••••••••••01`. */
export function maskMobile(e164: string): string {
  const digits = e164.replace(/\D/g, '').length
  let seen = 0
  return e164.replace(/\d/g, (d) => (++seen > digits - 2 ? d : '•'))
}
