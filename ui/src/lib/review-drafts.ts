import type { ReviewFeedbackDraft, SourceRecord } from './types'
import type { QuestionScope } from './question-drafts'
import { sameQuestionScope, hasQuestionReceipt } from './question-drafts'

export interface ReviewComposerDraft {
  id: string
  note: string
  groupId: string
  itemIds: string[]
  affectedItemIds: string[]
  recordIds: string[]
  availableRecordIds: string[]
  intent?: 'request_changes'
  mode: 'compose' | 'view'
  requestId?: string
  basedOnRequestId?: string
  deliveryError?: string
  priorDeliveryError?: string
  previewNotice?: string
}
export interface ReviewCollection extends QuestionScope { version: 1; activeId?: string; drafts: ReviewComposerDraft[] }
export type ReviewAction =
  | { type: 'add'; draft: ReviewComposerDraft }
  | { type: 'activate'; id: string }
  | { type: 'edit'; id: string; patch: Partial<Pick<ReviewComposerDraft, 'note' | 'groupId' | 'itemIds' | 'affectedItemIds' | 'recordIds' | 'intent'>> }
  | { type: 'prepared'; id: string; requestId: string; submittedSignature: string }
  | { type: 'delivery-error'; id: string; error: string }

export const reviewStorageKey = (scope: QuestionScope) => `flux:review-composers:v1:${JSON.stringify([scope.projectId, scope.sessionId])}`
export const emptyReviews = (scope: QuestionScope): ReviewCollection => ({ version: 1, ...scope, drafts: [] })
export const reviewSignature = (draft: ReviewComposerDraft) => JSON.stringify([draft.intent, draft.note, draft.groupId, draft.itemIds, draft.affectedItemIds, draft.recordIds])
export function restoreReviews(raw: string | null, scope: QuestionScope): ReviewCollection {
  if (!raw) return emptyReviews(scope)
  const saved = JSON.parse(raw) as ReviewCollection
  if (saved.version !== 1 || !sameQuestionScope(saved, scope) || !Array.isArray(saved.drafts)) return emptyReviews(scope)
  const drafts = saved.drafts.filter(draft => typeof draft.id === 'string' && typeof draft.note === 'string' && typeof draft.groupId === 'string' && ['compose','view'].includes(draft.mode) &&
    [draft.itemIds,draft.affectedItemIds,draft.recordIds,draft.availableRecordIds].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string')))
  return { version: 1, ...scope, activeId: drafts.some(draft => draft.id === saved.activeId) ? saved.activeId : undefined, drafts }
}
export function saveReviews(storage: Pick<Storage, 'setItem'>, state: ReviewCollection, scope: QuestionScope) {
  if (!sameQuestionScope(state, scope)) return false
  storage.setItem(reviewStorageKey(scope), JSON.stringify(state)); return true
}
export function reviewReducer(state: ReviewCollection, action: ReviewAction): ReviewCollection {
  if (action.type === 'add') return { ...state, activeId: action.draft.id, drafts: [...state.drafts,action.draft] }
  if (action.type === 'activate') return state.drafts.some(draft => draft.id === action.id) ? { ...state, activeId: action.id } : state
  return { ...state, drafts: state.drafts.map(draft => {
    if (draft.id !== action.id) return draft
    if (action.type === 'edit') return draft.mode === 'compose' ? { ...draft, ...action.patch } : draft
    if (action.type === 'prepared') return draft.mode !== 'compose' ? draft : reviewSignature(draft) === action.submittedSignature
      ? { ...draft, mode: 'view', requestId: action.requestId, deliveryError: undefined, previewNotice: undefined }
      : { ...draft, previewNotice: 'An earlier preview is saved in change-request history. Your newer note and scope are preserved; review them again before sending.' }
    return { ...draft, deliveryError: action.error }
  }) }
}
export function reviewInScope(feedback: ReviewFeedbackDraft, scope: QuestionScope, events: SourceRecord[]) {
  if (feedback.projectId && feedback.projectId !== scope.projectId || feedback.sessionId && feedback.sessionId !== scope.sessionId) return false
  const sources = events.filter(event => event.kind === 'review_feedback_request' && (event.data?.feedback as ReviewFeedbackDraft | undefined)?.id === feedback.id)
  if (sources.length > 1) return false
  if (sources.length === 1) {
    const original = sources[0].data?.feedback as ReviewFeedbackDraft
    if (sources[0].projectId && sources[0].projectId !== scope.projectId || sources[0].sessionId !== scope.sessionId || sources[0].source?.type !== 'flux_review' || sources[0].source.ref !== feedback.groupId || original.groupId !== feedback.groupId ||
      original.projectId && original.projectId !== scope.projectId || original.sessionId && original.sessionId !== scope.sessionId) return false
  }
  return Boolean(scope.sessionId) && (feedback.projectId === scope.projectId && feedback.sessionId === scope.sessionId || sources.length === 1)
}
export function reviewFromRequest(feedback: ReviewFeedbackDraft, id: string, edit = false): ReviewComposerDraft {
  return { id, note: feedback.note, groupId: feedback.groupId, itemIds: [...feedback.itemIds], affectedItemIds: [...(feedback.affectedItemIds ?? [])],
    recordIds: [...(feedback.recordIds ?? [])], availableRecordIds: [...(feedback.recordIds ?? [])], intent: feedback.intent,
    mode: edit ? 'compose' : 'view', requestId: edit ? undefined : feedback.id, basedOnRequestId: edit ? feedback.id : undefined,
    priorDeliveryError: edit && !hasQuestionReceipt(feedback) ? feedback.error : undefined }
}
