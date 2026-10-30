import { HelpHint } from './ui/HelpHint'
import { Accordion } from '@base-ui/react/accordion'
import { BadgeCheck, ChevronDown, ClipboardList, FileQuestion, ListMinus, MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { Badge } from './ui/Badge'
import { ContextCoverage } from './ContextCoverage'
import { Button } from './ui/Button'
import { FieldLabel, Textarea } from './ui/Field'
import { UiDialog } from './ui/UiDialog'
import { prepareReviewFeedback, recordReviewGroup, sendReviewFeedback } from '../lib/api'
import { getEvidenceLabel, labelFor, reviewGroupId } from '../lib/helpers'
import { earlierDeliveryNotice, hasQuestionReceipt, questionDeliveryUnconfirmed, sourceChoicesForDraft } from '../lib/question-drafts'
import { reviewInScope, reviewSignature } from '../lib/review-drafts'
import type { ReviewComposerDraft } from '../lib/review-drafts'
import type { FluxSnapshot, ReviewFeedbackDraft, WorkItem } from '../lib/types'

export function ReviewUpdateDialog({ snapshot, open, onOpenChange, local, onEdit, onPrepared, onDeliveryError, onRevise, onViewRequest, onNew, storageNotice, onReviewed, onAsk }: {
  snapshot:FluxSnapshot; open:boolean; onOpenChange:(open:boolean)=>void; local:ReviewComposerDraft
  onEdit:(patch:Partial<Pick<ReviewComposerDraft,'note'|'groupId'|'itemIds'|'affectedItemIds'|'recordIds'|'intent'>>)=>void
  onPrepared:(requestId:string,submittedSignature:string)=>void; onDeliveryError:(error:string)=>void
  onRevise:(feedback:ReviewFeedbackDraft)=>void; onNew:()=>void; storageNotice:string
  onViewRequest:(feedback:ReviewFeedbackDraft)=>void
  onReviewed:()=>Promise<void>; onAsk:(question:string,recordIds:string[])=>void
}) {
  const [busy,setBusy] = useState(false), [error,setError] = useState('')
  const scope={projectId:snapshot.project.id,sessionId:snapshot.project.sessionId}
  const enrolled=snapshot.project.sessions.some(session=>session.id===scope.sessionId)
  const preview=local.mode==='view'&&enrolled?snapshot.reviewFeedback?.find(value=>value.id===local.requestId&&reviewInScope(value,scope,snapshot.events)):undefined
  const predecessor=enrolled?snapshot.reviewFeedback?.find(value=>value.id===local.basedOnRequestId&&reviewInScope(value,scope,snapshot.events)):undefined
  const earlier=earlierDeliveryNotice(local.priorDeliveryError,predecessor)
  const knownReceipt=hasQuestionReceipt(preview)
  const failed=questionDeliveryUnconfirmed(preview,preview?.error||local.deliveryError)
  const legacy=preview&&(preview.requestVersion!==2||preview.intent!=='request_changes'||!preview.affectedItemIds?.length||preview.projectId!==scope.projectId||preview.sessionId!==scope.sessionId)
  const stale=preview?.status==='prepared'&&preview.contextRevision!==snapshot.contextRevision
  const ready=preview?.status==='prepared'&&!legacy&&!stale&&!failed
  const items:WorkItem[]=local.itemIds.map(id=>snapshot.project.items.find(item=>item.id===id)||{id,title:`Item unavailable: ${id}`,status:'unavailable'})
  const contextReady=items.length>0&&items.every(item=>['ready_for_review','ready-for-review'].includes(item.status)&&(!item.sessionId||item.sessionId===scope.sessionId))
  const choices=sourceChoicesForDraft(local.availableRecordIds,local.recordIds,snapshot.events)
  const name=(id:string)=>snapshot.project.items.find(item=>item.id===id)?.title||`Item unavailable: ${id}`
  const affectedChoices=[...new Set([...local.itemIds,...local.affectedItemIds])]

  async function accept() {
    if(busy||!contextReady)return
    setBusy(true);setError('')
    try {await recordReviewGroup(snapshot,local.groupId,local.itemIds,'accepted',local.note);await onReviewed();onOpenChange(false)}
    catch(cause){setError(cause instanceof Error?cause.message:'The grouped review could not be saved.')}
    finally{setBusy(false)}
  }
  async function prepare() {
    if(busy||!contextReady||local.intent!=='request_changes'||!local.note.trim()||!local.affectedItemIds.length)return
    if(!local.affectedItemIds.every(id=>local.itemIds.includes(id))){setError('Remove affected items outside the saved context group before preparing.');return}
    const submittedSignature=reviewSignature(local)
    setBusy(true);setError('')
    try {const prepared=await prepareReviewFeedback(snapshot,local.groupId,items,local.affectedItemIds,local.note,local.recordIds);await onReviewed();onPrepared(prepared.id,submittedSignature)}
    catch(cause){setError(cause instanceof Error?cause.message:'The change request could not be prepared.')}
    finally{setBusy(false)}
  }
  async function send() {
    if(!preview||busy||!ready)return
    setBusy(true);setError('')
    try {const result=await sendReviewFeedback(snapshot,preview);if(result.status==='failed')onDeliveryError(result.error||'The delivery attempt failed.');await onReviewed()}
    catch(cause){onDeliveryError(cause instanceof Error?cause.message:'The change request could not be sent.');await onReviewed()}
    finally{setBusy(false)}
  }
  function removeContext(id:string) {
    const itemIds=local.itemIds.filter(value=>value!==id)
    onEdit({itemIds,groupId:reviewGroupId(itemIds.map(value=>({id:value}))),affectedItemIds:local.affectedItemIds.filter(value=>value!==id)})
  }

  return <UiDialog open={open} onOpenChange={onOpenChange} title={local.mode==='view'?'Review this change request':'Review this Flux update'} description="Ask a read-only question, request changes to an explicit subset, or record acceptance in Flux." width="max-w-3xl">
    {storageNotice&&<p className="storage-notice" role="status">{storageNotice}</p>}
    {local.mode==='view'?!preview?<div className="question-preview"><p className="form-error" role="alert">This change request is unavailable in the current project and chat. The saved note and scope remain preserved.</p><Button onClick={onNew}>Start another review draft</Button></div>:<div className="feedback-preview">
      {failed?<div className="question-callout warning" role="alert"><FileQuestion size={16}/><span><strong>Delivery not confirmed.</strong><p>{preview.error||local.deliveryError}</p><p>The native client may have received this message. Check before preparing another attempt. Flux will not automatically resend.</p></span></div>
        :knownReceipt?<div className="question-callout"><BadgeCheck size={16}/><span>{preview.status==='acknowledged'?'Receipt acknowledged.':'Accepted by the queue.'} Completed changes are not established; this receipt is separate from work completion.</span></div>
        :legacy||stale?<div className="question-callout warning"><FileQuestion size={16}/><span>{legacy?'This earlier preview lacks current explicit intent or project/chat scope.':'Current direction or work changed.'} Edit a new draft and review a fresh preview.</span></div>
        :<div className="question-callout"><FileQuestion size={16}/><span>Explicit intent: Request changes. Review the exact affected subset and note before sending.</span></div>}
      <div className="preview-question"><span className="eyebrow">Your exact change note · {preview.status}</span><p>{preview.note}</p></div>
      <div className="review-scope-columns"><section><h3>Affected items · {preview.affectedItemIds?.length??0}</h3><ul>{preview.affectedItemIds?.map(id=><li key={id}>{name(id)}</li>)}</ul></section><section><h3>Context group · {preview.itemIds.length}</h3><ul>{preview.itemIds.map(id=><li key={id}>{name(id)}</li>)}</ul><p>Other context items are preserved.</p></section></div>
      <ContextCoverage manifest={preview.contextManifest}/>
      <details className="question-evidence"><summary>Reviewed optional sources · {preview.recordIds?.length??0}</summary><ul>{preview.recordIds?.map(id=><li key={id}>{snapshot.events.find(source=>source.id===id)?.summary||`Source unavailable: ${id}`}</li>)}</ul></details>
      <details className="exact-context"><summary>Exact reviewed message</summary><pre>{preview.prompt}</pre></details>
      <div className="review-dialog-actions"><HelpHint topic="preview-send" /><Button variant="secondary" disabled={busy} onClick={()=>onRevise(preview)}>{failed?'Prepare another change attempt':knownReceipt?'Draft another change request':'Edit and prepare again'}</Button>{ready&&<Button variant="primary" disabled={busy} onClick={()=>void send()}>{busy?'Sending…':'Send reviewed change request'}<MessageSquareText size={15}/></Button>}</div>
    </div>:<>
      {local.basedOnRequestId&&<p className="question-description">This is a new draft. The earlier immutable request remains in change-request history.</p>}
      {local.previewNotice&&<p className="storage-notice" role="status">{local.previewNotice}</p>}
      {earlier.kind==='receipt'&&predecessor?<div className="question-callout"><BadgeCheck size={16}/><span><strong>The earlier change request is now {earlier.status}.</strong><p>Your current note and scope are preserved. Review the earlier status before deciding whether another message is needed; this status does not prove the changes are complete.</p><Button size="small" variant="secondary" disabled={busy} onClick={()=>onViewRequest(predecessor)}>View earlier change status</Button></span></div>:earlier.kind==='uncertain'&&<div className="question-callout warning" role="alert"><FileQuestion size={16}/><span><strong>Earlier delivery not confirmed.</strong><p>{earlier.error}</p><p>Check the native client before preparing another attempt.</p></span></div>}
      <div className="review-scope-note"><strong>Saved context group · {local.itemIds.length} items</strong><span>Ask never changes work. Request changes authorizes only your explicitly selected subset and reviewed note. Passive updates do not replace this saved context.</span></div>
      {!contextReady&&<div className="question-callout warning"><FileQuestion size={16}/><span>Some context items are missing or no longer ready for review. They stay visible below. Explicitly remove them from this draft or start another draft for the current group.</span></div>}
      <Accordion.Root multiple className="review-groups"><Accordion.Item value="saved-context" className="review-group"><Accordion.Header className="help-heading"><Accordion.Trigger className="review-group-trigger"><ChevronDown size={16} className="review-group-chevron"/><span className="review-group-name">Saved review context</span><Badge>{items.length} items</Badge></Accordion.Trigger><HelpHint topic="saved-review-context" /></Accordion.Header><Accordion.Panel><ul className="review-change-list">{items.map(item=><li className="review-change" key={item.id}><span className="review-change-copy"><strong><ClipboardList size={14} aria-hidden="true"/><span>{item.title}</span></strong><span>{item.purpose||labelFor(item.status)}</span></span><span className="review-change-meta"><Badge>{labelFor(item.status)}</Badge><Button size="small" variant="quiet" disabled={busy} onClick={()=>removeContext(item.id)}><ListMinus size={14} aria-hidden="true"/>{local.affectedItemIds.includes(item.id)?'Remove from context and affected scope':'Remove from context'}</Button></span></li>)}</ul></Accordion.Panel></Accordion.Item></Accordion.Root>
      <Button variant="quiet" size="small" disabled={busy} onClick={onNew}>Start another draft for current group</Button>
      <div className="review-note-field"><FieldLabel htmlFor="group-review-note">Your question or change note</FieldLabel><Textarea id="group-review-note" value={local.note} maxLength={1000} disabled={busy} onChange={event=>onEdit({note:event.target.value})} placeholder="Write your question or describe the requested changes…"/><span className="review-note-help">Ask opens a read-only question with exactly this text and the selected sources. Request changes exposes explicit affected scope.</span></div>
      <div className="review-intent-actions"><Button variant="secondary" disabled={busy||!local.note.trim()} onClick={()=>onAsk(local.note,local.recordIds)}><FileQuestion size={16}/>Ask</Button><Button variant={local.intent==='request_changes'?'primary':'secondary'} disabled={busy} aria-pressed={local.intent==='request_changes'} onClick={()=>onEdit({intent:'request_changes'})}><MessageSquareText size={16}/>Request changes</Button></div>
      {local.intent==='request_changes'&&<fieldset className="affected-item-picker"><legend><span className="help-inline">Which items may Codex change?<HelpHint topic="affected-items" /></span></legend><p>Nothing is selected automatically. Unavailable or changed items remain visible until you remove them.</p><div className="review-intent-actions"><Button size="small" variant="secondary" disabled={busy} onClick={()=>onEdit({affectedItemIds:[...new Set([...local.affectedItemIds,...local.itemIds])]})}>Select all</Button><Button size="small" variant="quiet" disabled={busy} onClick={()=>onEdit({affectedItemIds:[]})}>Clear selection</Button></div>{affectedChoices.map(id=><label key={id}><input type="checkbox" disabled={busy} checked={local.affectedItemIds.includes(id)} onChange={event=>onEdit({affectedItemIds:event.target.checked?[...new Set([...local.affectedItemIds,id])]:local.affectedItemIds.filter(value=>value!==id)})}/><span>{name(id)}<small className="message-link-notice">{snapshot.project.items.find(item=>item.id===id)?.status||'Unavailable'}{!local.itemIds.includes(id)?' · outside saved context':''}</small></span></label>)}</fieldset>}
      <details className="question-evidence review-context"><summary>Saved group context sources <Badge>{local.recordIds.length} selected</Badge></summary><div className="help-inline"><span className="empty-inline">Choose optional sources for the preview.</span><HelpHint topic="source-selection" /></div><div className="question-evidence-list">{choices.map(({id,record})=><label key={id}><input type="checkbox" disabled={busy} checked={local.recordIds.includes(id)} onChange={event=>onEdit({recordIds:event.target.checked?[...new Set([...local.recordIds,id])]:local.recordIds.filter(value=>value!==id)})}/><span><strong>{record?.summary||record?.kind||`Source unavailable: ${id}`}</strong><small>{getEvidenceLabel(record?.provenance)}</small></span></label>)}</div></details>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="review-dialog-actions">{local.intent==='request_changes'&&<Button variant="primary" disabled={busy||!contextReady||!local.note.trim()||!local.affectedItemIds.length} onClick={()=>void prepare()}>{busy?'Preparing…':'Review change request'}</Button>}<span className="help-inline"><Button variant="secondary" disabled={busy||!contextReady} onClick={()=>void accept()}>Accept all {local.itemIds.length} in Flux</Button><HelpHint topic="review-accept" /></span></div>
    </>}
  </UiDialog>
}
