import type { AnswerSubmission, DiagnosticDraft, FluxSnapshot, ReviewFeedbackDraft, ReviewOutcome, WorkItem } from './types'

export class FluxApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function post<T>(snapshot: FluxSnapshot, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flux-CSRF': snapshot.csrfToken },
    body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new FluxApiError(String(result.error ?? `Flux returned ${response.status}.`), response.status)
  return result as T
}

export const getSnapshot = async (signal?: AbortSignal) => {
  const response = await fetch('/api/state', { cache: 'no-store', signal })
  if (!response.ok) throw new FluxApiError(`Flux returned ${response.status}.`, response.status)
  return response.json() as Promise<FluxSnapshot>
}

export const prepareQuestion = (snapshot: FluxSnapshot, question: string, recordIds: string[], baselinePlanId?: string, selectedItemId?: string): Promise<DiagnosticDraft> =>
  post(snapshot, '/api/diagnostics', { question, recordIds, baselinePlanId, selectedItemId, expectedRevision: snapshot.contextRevision, dispatch: false })

export const sendQuestion = (snapshot: FluxSnapshot, draft: DiagnosticDraft): Promise<DiagnosticDraft> =>
  post(snapshot, '/api/diagnostics', { question: draft.question, recordIds: draft.recordIds, selectedItemId: draft.selectedItemId ?? undefined, baselinePlanId: draft.baselinePlanId ?? undefined, expectedRevision: draft.contextRevision, requestId: draft.id, dispatch: true })

export const recordReviewGroup = (snapshot: FluxSnapshot, groupId: string, itemIds: string[], outcome: ReviewOutcome, note: string) =>
  post<{ event: { id: string } }>(snapshot, '/api/reviews', { groupId, itemIds, outcome, note, expectedRevision: snapshot.contextRevision })

export const prepareReviewFeedback = (snapshot: FluxSnapshot, groupId: string, items: WorkItem[], affectedItemIds: string[], note: string, recordIds: string[]) =>
  post<ReviewFeedbackDraft>(snapshot, '/api/review-feedback', { intent: 'request_changes', groupId, itemIds: items.map(item => item.id).sort(), affectedItemIds, note, recordIds, expectedRevision: snapshot.contextRevision, dispatch: false })

export const sendReviewFeedback = (snapshot: FluxSnapshot, draft: ReviewFeedbackDraft) =>
  post<ReviewFeedbackDraft>(snapshot, '/api/review-feedback', { intent: draft.intent, affectedItemIds: draft.affectedItemIds, requestId: draft.id, groupId: draft.groupId, itemIds: draft.itemIds, note: draft.note, recordIds: draft.recordIds, expectedRevision: draft.contextRevision, dispatch: true })

export const prepareAnswers = (snapshot: FluxSnapshot, answers: Array<{ questionId: string; answer: string }>) =>
  post<AnswerSubmission>(snapshot, '/api/answers', { answers, expectedRevision: snapshot.contextRevision, dispatch: false })

export const sendAnswers = (snapshot: FluxSnapshot, submission: AnswerSubmission) =>
  post<AnswerSubmission>(snapshot, '/api/answers', { requestId: submission.id, answers: submission.answers.map(({ questionId, answer }) => ({ questionId, answer })), expectedRevision: submission.contextRevision, dispatch: true })

export const chooseProposal = (snapshot: FluxSnapshot, proposalId: string, proposalKind: 'decision' | 'item', choice: 'plan' | 'later' | 'dismiss' | 'restore') =>
  post(snapshot, '/api/proposals', { proposalId, proposalKind, choice, expectedRevision: snapshot.contextRevision })
