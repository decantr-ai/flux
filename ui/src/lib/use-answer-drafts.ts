import { useCallback, useEffect, useRef, useState } from 'react'
import { answerStorageKey, discardAnswer, editAnswer, emptyAnswers, restoreAnswers, sameAnswerScope, saveAnswers } from './answer-drafts'
import type { AnswerCollection, AnswerScope } from './answer-drafts'
import type { IncomingQuestion } from './types'

const unavailable = 'Browser storage is unavailable. Drafts remain in memory for this visit; reloading may lose edits.'
export function useAnswerDrafts(scope: AnswerScope) {
  const key = answerStorageKey(scope)
  const activeKey = useRef(key); activeKey.current = key
  const memory = useRef(new Map<string, AnswerCollection>())
  const [collection, setCollection] = useState<AnswerCollection | null>(null)
  const failures = useRef(new Map<string, string>())
  const [, setFailureVersion] = useState(0)
  function recordFailure(owner: string, failed: boolean) {
    const changed = failed ? !failures.current.has(owner) : failures.current.has(owner)
    if (failed) failures.current.set(owner, unavailable); else failures.current.delete(owner)
    if (changed) setFailureVersion(version => version + 1)
  }
  useEffect(() => {
    const cached = memory.current.get(key)
    if (cached) { setCollection(cached); return }
    try { setCollection(restoreAnswers(localStorage.getItem(key), scope)); recordFailure(key, false) }
    catch { setCollection(emptyAnswers(scope)); recordFailure(key, true) }
  }, [key])
  useEffect(() => {
    if (!collection) return
    memory.current.set(answerStorageKey(collection), collection)
    const owner = answerStorageKey(collection)
    try { saveAnswers(localStorage, collection, collection); recordFailure(owner, false) }
    catch { recordFailure(owner, true) }
  }, [collection])
  const edit = useCallback((question: IncomingQuestion, answer: string) => {
    if (activeKey.current !== key) return
    setCollection(current => activeKey.current === key ? editAnswer(current && sameAnswerScope(current, scope) ? current : emptyAnswers(scope), question, answer) : current)
  }, [key])
  const discard = useCallback((fingerprint: string) => {
    if (activeKey.current !== key) return
    setCollection(current => current && sameAnswerScope(current, scope) && activeKey.current === key ? discardAnswer(current, fingerprint) : current)
  }, [key])
  const ready = Boolean(collection && sameAnswerScope(collection, scope))
  return { collection: ready ? collection! : emptyAnswers(scope), ready, edit, discard, storageNotice: failures.current.get(key) ?? '' }
}
