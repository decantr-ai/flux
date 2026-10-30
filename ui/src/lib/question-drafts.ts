import type { DiagnosticRequest, SourceRecord } from './types'

export interface QuestionScope { projectId: string; sessionId: string }
export interface QuestionDraft {
  id: string
  question: string
  recordIds: string[]
  availableRecordIds: string[]
  selectedItemId?: string | null
  baselinePlanId?: string | null
  requestId?: string
  basedOnRequestId?: string
  mode: 'edit' | 'view'
  deliveryError?: string
  priorDeliveryError?: string
  previewNotice?: string
}
export interface QuestionCollection extends QuestionScope { version: 1; activeId?: string; drafts: QuestionDraft[] }
export type QuestionAction =
  | { type: 'add'; draft: QuestionDraft }
  | { type: 'activate'; id: string }
  | { type: 'edit'; id: string; question?: string; recordIds?: string[] }
  | { type: 'prepared'; id: string; requestId: string; submittedQuestion: string; submittedRecordIds: string[] }
  | { type: 'delivery-error'; id: string; error: string }

export const questionStorageKey = (scope: QuestionScope) => `flux:questions:v1:${JSON.stringify([scope.projectId, scope.sessionId])}`
export const emptyQuestions = (scope: QuestionScope): QuestionCollection => ({ version: 1, ...scope, drafts: [] })
export const sameQuestionScope = (a: QuestionScope, b: QuestionScope) => a.projectId === b.projectId && a.sessionId === b.sessionId
export function saveQuestions(storage: Pick<Storage, 'setItem'>, collection: QuestionCollection, scope: QuestionScope) {
  if (!sameQuestionScope(collection, scope)) return false
  storage.setItem(questionStorageKey(scope), JSON.stringify(collection))
  return true
}

export function requestInQuestionScope(request: DiagnosticRequest, scope: QuestionScope, events: SourceRecord[]) {
  if (request.projectId && request.projectId !== scope.projectId || request.sessionId && request.sessionId !== scope.sessionId) return false
  const candidates = events.filter(event => event.kind === 'diagnostic_request' &&
    (request.sourceEventId ? event.id === request.sourceEventId : event.data?.requestId === request.id))
  // A stored source reference is authoritative. Never replace it with an earlier
  // same-request-ID event; ambiguous fallback matches do not prove enrollment.
  if (candidates.length > 1 || request.sourceEventId && candidates.length !== 1) return false
  const source = candidates[0]
  if (source && (source.data?.requestId ?? source.data?.id ?? source.id) !== request.id) return false
  if (source?.projectId && source.projectId !== scope.projectId) return false
  if (typeof source?.data?.projectId === 'string' && source.data.projectId !== scope.projectId) return false
  if (source?.sessionId && source.sessionId !== scope.sessionId) return false
  if (typeof source?.data?.sessionId === 'string' && source.data.sessionId !== scope.sessionId) return false
  // Legacy requests require an explicit originating session, never the active chat by default.
  return (request.sessionId || source?.sessionId || source?.data?.sessionId) === scope.sessionId && Boolean(scope.sessionId)
}

export function currentQuestionRequest(local: QuestionDraft, requests: DiagnosticRequest[], scope: QuestionScope, events: SourceRecord[]) {
  return local.mode === 'view' ? requests.find(request => request.id === local.requestId && requestInQuestionScope(request, scope, events)) : undefined
}

export function canSendQuestion(request: DiagnosticRequest | undefined, scope: QuestionScope, contextRevision: string, deliveryError?: string) {
  return Boolean(request && request.status === 'prepared' && request.projectId === scope.projectId && request.sessionId === scope.sessionId &&
    request.contextRevision === contextRevision && request.prompt && request.recordIds && !deliveryError)
}
export const hasQuestionReceipt = (request?: Pick<DiagnosticRequest, 'status'>) => Boolean(request && ['queued','acknowledged','completed'].includes(request.status))
export const questionDeliveryUnconfirmed = (request: DiagnosticRequest | undefined, transportError?: string) => request?.status === 'failed' || Boolean(transportError && !hasQuestionReceipt(request))
export function earlierDeliveryNotice(priorError: string | undefined, predecessor?: Pick<DiagnosticRequest, 'status'>) {
  return hasQuestionReceipt(predecessor) ? { kind: 'receipt' as const, status: predecessor!.status } : priorError ? { kind: 'uncertain' as const, error: priorError } : { kind: 'none' as const }
}
export function sourceChoicesForDraft(candidates: string[], selected: string[], events: SourceRecord[]) {
  const byId = new Map(events.map(event => [event.id, event]))
  return [...new Set([...candidates, ...selected])].map(id => ({ id, record: byId.get(id) }))
}

export function restoreQuestions(raw: string | null, scope: QuestionScope): QuestionCollection {
  if (!raw) return emptyQuestions(scope)
  const saved = JSON.parse(raw) as QuestionCollection
  if (saved.version !== 1 || !sameQuestionScope(saved, scope) || !Array.isArray(saved.drafts)) return emptyQuestions(scope)
  const drafts = saved.drafts.filter(draft => typeof draft.id === 'string' && typeof draft.question === 'string' &&
    ['edit','view'].includes(draft.mode) && Array.isArray(draft.recordIds) && draft.recordIds.every(id => typeof id === 'string') &&
    Array.isArray(draft.availableRecordIds) && draft.availableRecordIds.every(id => typeof id === 'string'))
  return { version: 1, ...scope, activeId: drafts.some(draft => draft.id === saved.activeId) ? saved.activeId : undefined, drafts }
}

export function questionReducer(state: QuestionCollection, action: QuestionAction): QuestionCollection {
  if (action.type === 'add') return { ...state, activeId: action.draft.id, drafts: [...state.drafts, action.draft] }
  if (action.type === 'activate') return state.drafts.some(draft => draft.id === action.id) ? { ...state, activeId: action.id } : state
  return { ...state, drafts: state.drafts.map(draft => {
    if (draft.id !== action.id) return draft
    if (action.type === 'edit') return draft.mode === 'edit' ? { ...draft, question: action.question ?? draft.question, recordIds: action.recordIds ?? draft.recordIds } : draft
    if (action.type === 'prepared') {
      if (draft.mode !== 'edit') return draft
      if (draft.question !== action.submittedQuestion || JSON.stringify(draft.recordIds) !== JSON.stringify(action.submittedRecordIds)) return { ...draft, previewNotice: 'A preview for earlier text is saved in question history. Your newer edits are preserved; review them again before sending.' }
      return { ...draft, requestId: action.requestId, mode: 'view', deliveryError: undefined, previewNotice: undefined }
    }
    return { ...draft, deliveryError: action.error }
  }) }
}

export function draftFromRequest(request: DiagnosticRequest, id: string, edit = false): QuestionDraft {
  return { id, question: request.question, recordIds: [...(request.recordIds ?? [])], availableRecordIds: [...(request.recordIds ?? [])],
    selectedItemId: request.selectedItemId, baselinePlanId: request.baselinePlanId,
    mode: edit ? 'edit' : 'view', requestId: edit ? undefined : request.id, basedOnRequestId: edit ? request.id : undefined,
    priorDeliveryError: edit && !hasQuestionReceipt(request) ? request.error : undefined }
}

export const requestActionLabel = (status: string) => status === 'prepared' ? 'Review and send' : status === 'completed' ? 'View answer' : status === 'failed' ? 'Prepare another attempt' : 'View status'
