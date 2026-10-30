import type { AnswerDraft, AnswerScope } from './answer-drafts'
import type { AnswerSubmission, FluxSnapshot } from './types'

export const answerSubmissionInScope = (submission: AnswerSubmission, scope: AnswerScope) => submission.projectId === scope.projectId && submission.sessionId === scope.sessionId
export const answerTransportAvailable = (snapshot: FluxSnapshot) => snapshot.answerTransport?.mode === 'chat_message' && snapshot.answerTransport.available === true && snapshot.answerTransport.nativeWidgetSync === false
export const heldAnswerStatus = (status: AnswerSubmission['status']) => ['sending', 'queued', 'delivery_unconfirmed'].includes(status)
export function mergeAnswerSubmissions(snapshot: FluxSnapshot, local: AnswerSubmission[]) {
  const scope = { projectId: snapshot.project.id, sessionId: snapshot.project.sessionId }
  const rank = { prepared: 0, sending: 1, queued: 2, delivery_unconfirmed: 2, received: 3 }
  const merged = new Map<string, AnswerSubmission>()
  for (const submission of [...local, ...(snapshot.answerSubmissions ?? [])]) {
    if (!answerSubmissionInScope(submission, scope)) continue
    const previous = merged.get(submission.id)
    if (!previous || rank[submission.status] >= rank[previous.status]) merged.set(submission.id, submission)
  }
  return [...merged.values()]
}
export function answerHolds(snapshot: FluxSnapshot, submissions: AnswerSubmission[]) {
  const held = new Map<string, { submissionId: string; status: AnswerSubmission['status'] }>()
  for (const submission of submissions) if (heldAnswerStatus(submission.status)) for (const answer of submission.answers) held.set(answer.questionId, { submissionId: submission.id, status: submission.status })
  for (const hold of snapshot.answerHolds ?? []) if (heldAnswerStatus(hold.status)) held.set(hold.questionId, hold)
  return held
}
export const submissionAnswers = (drafts: AnswerDraft[]) => drafts.map(({ questionId, answer }) => ({ questionId, answer }))
export const sameSubmissionAnswers = (submission: AnswerSubmission, drafts: AnswerDraft[]) => JSON.stringify(submission.answers.map(({ questionId, answer }) => ({ questionId, answer }))) === JSON.stringify(submissionAnswers(drafts))
export const answerSubmissionLabel = (submission: AnswerSubmission) => ({ prepared: 'Prepared', sending: 'Sending', queued: 'Queued', delivery_unconfirmed: 'Delivery unconfirmed', received: submission.outcomes?.length && submission.outcomes.every(outcome => outcome.status !== 'conflict') ? 'Reply recorded from chat' : 'Message captured' })[submission.status]

export const sameAnswerOwner = (owner: { key: string; epoch: number }, current: { key: string; epoch: number }) => owner.key === current.key && owner.epoch === current.epoch
