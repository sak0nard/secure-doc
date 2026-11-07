import { expect, test } from 'bun:test'
import { displayStatus, maskMobile } from '../src/modules/requests/status'

const now = new Date('2026-11-07T12:00:00Z')
const later = new Date(now.getTime() + 3600_000)

test('open with an active, unexpired link is Open', () => {
  expect(displayStatus('open', { state: 'active', expiresAt: later }, now)).toEqual({
    label: 'Open',
    linkLocked: false,
  })
})

test('open whose active link has reached its expiry is Expired', () => {
  expect(displayStatus('open', { state: 'active', expiresAt: now }, now)).toEqual({
    label: 'Expired',
    linkLocked: false,
  })
})

test('open with a locked link is Open and flagged locked', () => {
  expect(displayStatus('open', { state: 'locked', expiresAt: later }, now)).toEqual({
    label: 'Open',
    linkLocked: true,
  })
})

test('received and closed ignore the link', () => {
  const link = { state: 'locked' as const, expiresAt: now }
  expect(displayStatus('received', link, now)).toEqual({
    label: 'Received',
    linkLocked: false,
  })
  expect(displayStatus('closed', link, now)).toEqual({
    label: 'Closed',
    linkLocked: false,
  })
})

test('maskMobile keeps only the last two digits', () => {
  expect(maskMobile('+61400000101')).toBe('+•••••••••01')
})
