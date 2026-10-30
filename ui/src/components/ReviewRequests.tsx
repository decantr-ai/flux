import { HelpHint } from './ui/HelpHint'
import { useState } from 'react'
import type { ReviewFeedbackDraft } from '../lib/types'
import type { ReviewComposerDraft } from '../lib/review-drafts'
import { questionDeliveryUnconfirmed } from '../lib/question-drafts'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'

type Entry = { kind:'draft'; draft:ReviewComposerDraft } | { kind:'request'; request:ReviewFeedbackDraft }
export function ReviewRequests({ drafts, requests, storageNotice, onResume, onRequest, onEdit, onNew }: {
  drafts:ReviewComposerDraft[]; requests:ReviewFeedbackDraft[]; storageNotice:string
  onResume:(id:string)=>void; onRequest:(request:ReviewFeedbackDraft)=>void; onEdit:(request:ReviewFeedbackDraft)=>void; onNew:()=>void
}) {
  const [showAll,setShowAll] = useState(false)
  const entries:Entry[] = [...drafts.filter(draft=>draft.mode==='compose').reverse().map(draft=>({kind:'draft' as const,draft})), ...[...requests].reverse().map(request=>({kind:'request' as const,request}))]
  if (!entries.length) return null
  const visible = showAll ? entries : entries.slice(0,6)
  return <section className="question-history" aria-label="Change requests and review drafts"><header className="section-heading"><div><p className="eyebrow">Review workflow</p><div className="help-heading"><h3>Change requests and review drafts</h3><HelpHint topic="change-requests" /></div></div><Button variant="secondary" size="small" onClick={onNew}>New review draft</Button></header>
    {storageNotice && <p className="storage-notice" role="status">{storageNotice}</p>}
    {visible.map(entry=>{
      if(entry.kind==='draft')return <div className="question-history-row" key={'draft:'+entry.draft.id}><span><strong>{entry.draft.note || 'Untitled review note'}</strong><small>{entry.draft.affectedItemIds.length} explicitly affected · {entry.draft.itemIds.length} context items</small></span><Badge>Draft</Badge><Button size="small" variant="secondary" onClick={()=>onResume(entry.draft.id)}>Resume review draft</Button></div>
      const request=entry.request, error=request.error||drafts.find(draft=>draft.requestId===request.id)?.deliveryError
      const retry=questionDeliveryUnconfirmed(request,error)
      return <div className="question-history-row" key={'request:'+request.id}><span><strong>{request.note}</strong><small>{retry?'Delivery not confirmed: '+(error||'The attempt failed.'):request.status==='queued'?'Queue acceptance is not work completion.':request.status}</small></span><Badge variant={retry?'warning':'neutral'}>{request.status}</Badge><Button size="small" variant="secondary" onClick={()=>retry?onEdit(request):onRequest(request)}>{retry?'Prepare another change attempt':request.status==='prepared'?'Review change preview':'View change status'}</Button></div>
    })}
    {entries.length>6&&<div className="question-history-more"><span className="empty-inline">Showing {visible.length} of {entries.length}; all notes and requests are retained.</span><Button size="small" variant="quiet" onClick={()=>setShowAll(value=>!value)}>{showAll?'Show recent':'Show all change requests'}</Button></div>}
  </section>
}
