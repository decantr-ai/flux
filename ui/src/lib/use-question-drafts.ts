import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyQuestions, questionReducer, questionStorageKey, restoreQuestions, sameQuestionScope, saveQuestions } from './question-drafts'
import type { QuestionAction, QuestionCollection, QuestionScope } from './question-drafts'

const unavailable = 'Browser storage is unavailable. Your drafts remain in memory for this visit; reloading may lose edits.'

export function useQuestionDrafts(scope: QuestionScope) {
  const key = questionStorageKey(scope)
  const activeKey = useRef(key)
  activeKey.current = key
  const memory = useRef(new Map<string, QuestionCollection>())
  const [collection, setCollection] = useState<QuestionCollection | null>(null)
  const [storageNotice, setStorageNotice] = useState('')
  useEffect(() => {
    const cached = memory.current.get(key)
    if (cached) { setCollection(cached); return }
    try { setCollection(restoreQuestions(localStorage.getItem(key), scope)); setStorageNotice('') }
    catch { setCollection(emptyQuestions(scope)); setStorageNotice(unavailable) }
  }, [key]) // Scope is encoded in the key; passive snapshots never hydrate over edits.
  useEffect(() => {
    // Persist using the collection's owner, never a newly selected chat's key.
    if (!collection) return
    memory.current.set(questionStorageKey(collection), collection)
    try { saveQuestions(localStorage, collection, collection) }
    catch { setStorageNotice(unavailable) }
  }, [key, collection])
  const dispatch = useCallback((action: QuestionAction) => {
    // A response started in the previous chat cannot replace active chat drafts.
    if (activeKey.current !== key) return
    setCollection(current => activeKey.current === key ? questionReducer(current && sameQuestionScope(current, scope) ? current : emptyQuestions(scope), action) : current)
  }, [key])
  const current = collection && sameQuestionScope(collection, scope) ? collection : emptyQuestions(scope)
  return { collection: current, dispatch, storageNotice }
}
