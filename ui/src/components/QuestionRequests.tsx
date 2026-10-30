import { HelpHint } from './ui/HelpHint'
import { useState } from 'react'
import type { DiagnosticRequest } from '../lib/types'
import type { QuestionDraft } from '../lib/question-drafts'
import { requestActionLabel, questionDeliveryUnconfirmed } from '../lib/question-drafts'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'

type Entry = { kind: 'draft'; draft: QuestionDraft } | { kind: 'request'; request: DiagnosticRequest }

export function QuestionRequests({ drafts, requests, storageNotice, onResume, onRequest, onEditRequest, onNew }: {
  drafts: QuestionDraft[]
  requests: DiagnosticRequest[]
  storageNotice: string
  onResume: (id: string) => void
  onRequest: (request: DiagnosticRequest) => void
  onEditRequest: (request: DiagnosticRequest) => void
  onNew: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const entries: Entry[] = [
    ...drafts.filter(draft => draft.mode === 'edit').reverse().map(draft => ({ kind: 'draft' as const, draft })),
    ...[...requests].reverse().map(request => ({ kind: 'request' as const, request })),
  ]
  const visible = showAll ? entries : entries.slice(0, 6)
  return <section className="question-history" aria-label="Questions and drafts">
    <header className="section-heading"><div><p className="eyebrow">Ask Codex</p><div className="help-heading"><h3>Questions and drafts</h3><HelpHint topic="questions" /></div></div><Button variant="secondary" size="small" onClick={onNew}>New question</Button></header>
    <p className="empty-inline help-inline">Drafts and request delivery <HelpHint topic="request-delivery" /></p>
    {storageNotice && <p className="storage-notice" role="status">{storageNotice}</p>}
    {!entries.length && <p className="empty-inline">Your drafts, previews, delivery status and recorded answers will appear here.</p>}
    {visible.map(entry => {
      if (entry.kind === 'draft') {
        const { draft } = entry
        return <div className="question-history-row" key={'draft:' + draft.id}><span><strong>{draft.question || 'Untitled question'}</strong><small>Unsent draft · source selection preserved</small></span><Badge>Draft</Badge><Button size="small" variant="secondary" onClick={() => onResume(draft.id)}>Resume</Button></div>
      }
      const { request } = entry
      const deliveryError = request.error || drafts.find(draft => draft.requestId === request.id)?.deliveryError
      const retry = questionDeliveryUnconfirmed(request, deliveryError)
      const caption = retry ? `Delivery not confirmed: ${deliveryError || 'The delivery attempt failed.'}` : request.status === 'queued' ? 'Queued; receipt and answer not yet verified' : request.status === 'completed' ? 'Answer recorded; work completion not established' : request.status
      const action = retry ? 'Prepare another attempt' : request.status === 'prepared' && (!request.projectId || !request.sessionId) ? 'Review and prepare again' : requestActionLabel(request.status)
      return <div className="question-history-row" key={'request:' + request.id}><span><strong>{request.question}</strong><small>{caption}</small></span><Badge variant={retry ? 'warning' : 'neutral'}>{request.status}</Badge><div className="question-history-actions">{request.status === 'prepared' && !retry && <Button size="small" variant="quiet" onClick={() => onEditRequest(request)}>Edit</Button>}<Button size="small" variant="secondary" onClick={() => retry ? onEditRequest(request) : onRequest(request)}>{action}</Button></div></div>
    })}
    {entries.length > 6 && <div className="question-history-more"><span className="empty-inline">Showing {visible.length} of {entries.length}; every draft and request is retained.</span><Button size="small" variant="quiet" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show recent' : 'Show all questions and drafts'}</Button></div>}
  </section>
}
