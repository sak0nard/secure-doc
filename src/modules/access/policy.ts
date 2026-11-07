import type { User } from './sessions'

export type Action =
  | 'request.create'
  | 'request.view'
  | 'request.reissue'
  | 'request.close'
  | 'document.download'
  | 'audit.view'

/** `own` allows only the banker who raised the request; `any` allows every request. */
type Grant = 'any' | 'own' | 'never'

/** The single authorisation table. Every route asks `authorise`; no page decides access. */
const POLICY: Record<User['role'], Record<Action, Grant>> = {
  banker: {
    'request.create': 'any',
    'request.view': 'own',
    'request.reissue': 'own',
    'request.close': 'own',
    'document.download': 'own',
    'audit.view': 'never',
  },
  compliance: {
    'request.create': 'never',
    'request.view': 'any',
    'request.reissue': 'never',
    'request.close': 'any',
    'document.download': 'any',
    'audit.view': 'any',
  },
}

/** Actions that are always about one request; without the request they are refused. */
const ABOUT_A_REQUEST = new Set<Action>([
  'request.view',
  'request.reissue',
  'request.close',
  'document.download',
])

export function authorise(
  user: User,
  action: Action,
  request?: { bankerId: string }
): boolean {
  if (ABOUT_A_REQUEST.has(action) && !request) return false
  const grant = POLICY[user.role][action]
  if (grant === 'own') return request?.bankerId === user.id
  return grant === 'any'
}
