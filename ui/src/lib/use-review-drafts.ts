import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuestionScope } from './question-drafts'
import { sameQuestionScope } from './question-drafts'
import { emptyReviews, restoreReviews, reviewReducer, reviewStorageKey, saveReviews } from './review-drafts'
import type { ReviewAction, ReviewCollection } from './review-drafts'

const unavailable = 'Browser storage is unavailable. Review notes remain in memory for this visit; reloading may lose edits.'
export function useReviewDrafts(scope: QuestionScope) {
  const key = reviewStorageKey(scope), activeKey = useRef(key)
  activeKey.current = key
  const memory = useRef(new Map<string, ReviewCollection>())
  const [collection, setCollection] = useState<ReviewCollection | null>(null)
  const [storageNotice, setStorageNotice] = useState('')
  useEffect(() => {
    const cached = memory.current.get(key)
    if (cached) { setCollection(cached); return }
    try { setCollection(restoreReviews(localStorage.getItem(key), scope)); setStorageNotice('') }
    catch { setCollection(emptyReviews(scope)); setStorageNotice(unavailable) }
  }, [key])
  useEffect(() => {
    if (!collection) return
    memory.current.set(reviewStorageKey(collection), collection)
    try { saveReviews(localStorage, collection, collection) }
    catch { setStorageNotice(unavailable) }
  }, [key,collection])
  const dispatch = useCallback((action: ReviewAction) => {
    if (activeKey.current !== key) return
    setCollection(current => activeKey.current === key ? reviewReducer(current && sameQuestionScope(current, scope) ? current : emptyReviews(scope), action) : current)
  }, [key])
  return { collection: collection && sameQuestionScope(collection, scope) ? collection : emptyReviews(scope), dispatch, storageNotice }
}
