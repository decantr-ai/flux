import type { IncomingQuestion } from './types'

export interface AnswerScope { projectId: string; sessionId: string }
export interface AnswerDraft { questionId: string; questionText: string; options: string[]; answer: string }
export interface AnswerCollection extends AnswerScope { version: 1; drafts: AnswerDraft[] }
export const answerStorageKey = (scope: AnswerScope) => `flux:answer-drafts:v1:${JSON.stringify([scope.projectId, scope.sessionId])}`
export const sameAnswerScope = (a: AnswerScope, b: AnswerScope) => a.projectId === b.projectId && a.sessionId === b.sessionId
export const emptyAnswers = (scope: AnswerScope): AnswerCollection => ({ version: 1, ...scope, drafts: [] })
export const answerFingerprint = (question: Pick<IncomingQuestion, 'id' | 'text' | 'options'>) => JSON.stringify([question.id, question.text, question.options ?? []])
export const draftFingerprint = (draft: AnswerDraft) => JSON.stringify([draft.questionId, draft.questionText, draft.options])
export const readyAnswer = (draft: AnswerDraft) => Boolean(draft.answer.trim())
export function editAnswer(collection: AnswerCollection, question: IncomingQuestion, answer: string): AnswerCollection {
  const fingerprint = answerFingerprint(question)
  const draft: AnswerDraft = { questionId: question.id, questionText: question.text, options: [...(question.options ?? [])], answer }
  const index = collection.drafts.findIndex(value => draftFingerprint(value) === fingerprint)
  return { ...collection, drafts: index < 0 ? [...collection.drafts, draft] : collection.drafts.map((value, i) => i === index ? draft : value) }
}
export function discardAnswer(collection: AnswerCollection, fingerprint: string): AnswerCollection {
  return { ...collection, drafts: collection.drafts.filter(draft => draftFingerprint(draft) !== fingerprint) }
}
export function restoreAnswers(raw: string | null, scope: AnswerScope): AnswerCollection {
  if (!raw) return emptyAnswers(scope)
  const saved = JSON.parse(raw) as AnswerCollection
  if (saved.version !== 1 || !sameAnswerScope(saved, scope) || !Array.isArray(saved.drafts)) return emptyAnswers(scope)
  const seen = new Set<string>()
  const drafts = saved.drafts.filter(value => value && typeof value.questionId === 'string' && typeof value.questionText === 'string' && typeof value.answer === 'string' && Array.isArray(value.options) && value.options.every(option => typeof option === 'string')).filter(value => {
    const key = draftFingerprint(value); if (seen.has(key)) return false; seen.add(key); return true
  })
  return { version: 1, ...scope, drafts }
}
export function saveAnswers(storage: Pick<Storage, 'setItem'>, collection: AnswerCollection, scope: AnswerScope) {
  if (!sameAnswerScope(collection, scope)) return false
  storage.setItem(answerStorageKey(scope), JSON.stringify(collection)); return true
}
export function partitionAnswers(collection: AnswerCollection, pending: IncomingQuestion[]) {
  const pendingKeys = new Set(pending.map(answerFingerprint))
  return { ready: collection.drafts.filter(draft => pendingKeys.has(draftFingerprint(draft)) && readyAnswer(draft)), recovery: collection.drafts.filter(draft => !pendingKeys.has(draftFingerprint(draft)) && readyAnswer(draft)) }
}
export const formatAnswers = (drafts: AnswerDraft[]) => drafts.map(draft => `Question: ${draft.questionText}\nFlux question ID: ${draft.questionId}\nYour answer:\n${draft.answer}`).join('\n\n---\n\n')
export async function copyAnswers(clipboard: Pick<Clipboard, 'writeText'>, drafts: AnswerDraft[], stillCurrent: () => 'same' | 'changed' | 'scope_changed') {
  try { await clipboard.writeText(formatAnswers(drafts)) } catch { return stillCurrent() === 'scope_changed' ? 'scope_changed' : 'failed' }
  const state = stillCurrent()
  return state === 'same' ? 'copied' : state
}
