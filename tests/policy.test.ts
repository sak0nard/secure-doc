import { expect, test } from 'bun:test'
import { type Action, authorise } from '../src/modules/access/policy'
import type { User } from '../src/modules/access/sessions'

const alice: User = { id: 'alice', name: 'Alice', role: 'banker' }
const carol: User = { id: 'carol', name: 'Carol', role: 'compliance' }
const alicesRequest = { bankerId: 'alice' }
const bobsRequest = { bankerId: 'bob' }

const REQUEST_ACTIONS: Action[] = [
  'request.view',
  'request.reissue',
  'request.close',
  'document.download',
]

type Row = [string, User, Action, { bankerId: string } | undefined, boolean]

const rows: Row[] = [
  ['banker creates', alice, 'request.create', undefined, true],
  ['banker owner views', alice, 'request.view', alicesRequest, true],
  ['banker owner reissues', alice, 'request.reissue', alicesRequest, true],
  ['banker owner closes', alice, 'request.close', alicesRequest, true],
  ['banker owner downloads', alice, 'document.download', alicesRequest, true],
  ['banker views the audit', alice, 'audit.view', alicesRequest, false],
  ...REQUEST_ACTIONS.map((a): Row => [
    `banker non-owner: ${a}`,
    alice,
    a,
    bobsRequest,
    false,
  ]),
  ['compliance creates', carol, 'request.create', undefined, false],
  ['compliance views', carol, 'request.view', bobsRequest, true],
  ['compliance reissues', carol, 'request.reissue', bobsRequest, false],
  ['compliance closes', carol, 'request.close', bobsRequest, true],
  ['compliance downloads', carol, 'document.download', bobsRequest, true],
  ['compliance views the audit', carol, 'audit.view', bobsRequest, true],
  ...REQUEST_ACTIONS.flatMap((a): Row[] => [
    [`banker, no request: ${a}`, alice, a, undefined, false],
    [`compliance, no request: ${a}`, carol, a, undefined, false],
  ]),
]

test.each(rows)('%s', (_name, user, action, request, expected) => {
  expect(authorise(user, action, request)).toBe(expected)
})
