import { randomUUID } from 'node:crypto';
import { DiagnosticError, queueWithCodex } from './diagnostics.mjs';
import { compileContext, suggestContext, validateSources } from './context.mjs';

const queues = new WeakMap();
const cut = (value, length) => String(value ?? '').slice(0, length);
export function reviewGroupId(itemIds) {
  let hash = 2166136261;
  for (const char of [...itemIds].sort().join('\n')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `flux-ui-${(hash >>> 0).toString(36)}`;
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DiagnosticError('A feedback request must be an object.');
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 1000) throw new DiagnosticError('Add feedback of 1–1000 characters.');
  if (input.dispatch !== undefined && typeof input.dispatch !== 'boolean') throw new DiagnosticError('dispatch must be a boolean.');
  if (!Array.isArray(input.itemIds) || input.itemIds.length < 1 || input.itemIds.length > 20 || input.itemIds.some(value => typeof value !== 'string' || value.length > 256)) throw new DiagnosticError('Choose 1–20 work items for grouped feedback.');
  if(input.intent!=='request_changes') throw new DiagnosticError('Choose the request_changes intent.');
  if(!Array.isArray(input.affectedItemIds)||!input.affectedItemIds.length||input.affectedItemIds.some(id=>typeof id!=='string'||!id||!input.itemIds.includes(id))||new Set(input.affectedItemIds).size!==input.affectedItemIds.length) throw new DiagnosticError('Choose a nonempty unique affected subset of the grouped work items.');
  const itemIds = [...new Set(input.itemIds)].sort();
  if (itemIds.length !== input.itemIds.length || input.groupId !== reviewGroupId(itemIds)) throw new DiagnosticError('The grouped update changed. Refresh before preparing feedback.', 409);
  return itemIds;
}
function targets(snapshot, itemIds) {
  const items=itemIds.map(id=>snapshot.project.items.find(item=>item.id===id));
  if(items.some(item=>!item||!['ready_for_review','ready-for-review'].includes(item.status)||item.sessionId&&item.sessionId!==snapshot.project.sessionId)) throw new DiagnosticError('One or more changes are no longer in this update.',409);
  if(!snapshot.project.sessionId||!snapshot.project.sessions.some(session=>session.id===snapshot.project.sessionId))throw new DiagnosticError('No enrolled chat is configured.',409);
  return items;
}
export function buildReviewFeedback(snapshot, input, { id=randomUUID() }={}) {
  const itemIds=validateInput(input), items=targets(snapshot,itemIds);
  const {recordIds}=validateSources(snapshot,input.recordIds??suggestContext(snapshot,{itemIds,limit:8}).map(source=>source.id));
  const affectedItemIds=[...input.affectedItemIds].sort();
  const context=compileContext(snapshot,{id,mode:'change',question:input.note,recordIds,items,affectedItemIds});
  context.contextManifest.sourceSelection=input.recordIds===undefined?'suggested':'explicit';
  return { id, requestVersion:2, intent:'request_changes', projectId:snapshot.project.id, sessionId:snapshot.project.sessionId,groupId:input.groupId,itemIds,affectedItemIds,note:input.note,question:input.note,...context,recordIds,status:'prepared',contextRevision:snapshot.contextRevision,baselineRevision:snapshot.revision };
}

/** Send the frozen reviewed message, even when passive activity arrives later. */
export async function reviewFeedback(store,input,{queueCommand=queueWithCodex}={}) {
  const initial=store.snapshot();
  if(input?.dispatch===true && typeof input.requestId==='string') {
    const old=initial.reviewFeedback.find(value=>value.id===input.requestId);
    if(old && (old.requestVersion!==2 || old.intent!=='request_changes' || !Array.isArray(old.affectedItemIds))) {
      if(old.status==='prepared') throw new DiagnosticError('Prepare and review again.',409);
      if(!['queued','acknowledged','completed'].includes(old.status)) throw new DiagnosticError('Only reviewed feedback can be sent. Prepare and review again.',409);
      const records=initial.events.filter(event=>event.kind==='review_feedback_request' && event.data?.feedback?.id===old.id);
      const event=records[0], original=event?.data?.feedback, project=initial.project;
      // Legacy requests lack project IDs. A unique immutable request event scoped to
      // the currently enrolled session is the only acceptable legacy proof.
      if(records.length!==1 || !project.id || !project.sessionId || !project.sessions?.some(session=>session.id===project.sessionId)
        || event.sessionId!==project.sessionId || event.source?.type!=='flux_review' || event.source.ref!==original.groupId
        || original.sessionId && original.sessionId!==project.sessionId || original.projectId && original.projectId!==project.id
        || event.projectId && event.projectId!==project.id) throw new DiagnosticError('The feedback belongs to another or ambiguous enrolled chat.',404);
      if(!Array.isArray(input.itemIds) || new Set(input.itemIds).size!==input.itemIds.length
        || input.intent!==undefined || input.affectedItemIds!==undefined || input.groupId!==original.groupId || input.note!==original.note
        || JSON.stringify([...input.itemIds].sort())!==JSON.stringify(original.itemIds)
        || JSON.stringify(input.recordIds)!==JSON.stringify(original.recordIds) || input.expectedRevision===undefined
        || input.expectedRevision!==original.contextRevision) throw new DiagnosticError('The reviewed feedback or context was edited. Prepare it again.',409);
      return {...old,...original,status:old.status,revision:initial.revision};
    }
  }
  const itemIds=validateInput(input), affectedItemIds=[...input.affectedItemIds].sort();
  if(input.requestId!==undefined&&(typeof input.requestId!=='string'||!input.requestId.trim()||input.dispatch!==true))throw new DiagnosticError('A prepared request ID may only be used when sending.');
  let saved;
  if(input.dispatch===true){
    if(!input.requestId)throw new DiagnosticError('Review feedback needs an existing prepared request.');
    saved=initial.reviewFeedback.find(value=>value.id===input.requestId);
    if(!saved)throw new DiagnosticError('The prepared feedback request no longer exists.',404);
    if(saved.projectId!==initial.project.id||saved.sessionId!==initial.project.sessionId||!initial.project.sessions?.some(session=>session.id===initial.project.sessionId))throw new DiagnosticError('The feedback belongs to another enrolled chat.',404);
    if(saved.requestVersion!==2||saved.intent!==input.intent||saved.groupId!==input.groupId||saved.note!==input.note||JSON.stringify(saved.itemIds)!==JSON.stringify(itemIds)||JSON.stringify(saved.affectedItemIds)!==JSON.stringify(affectedItemIds)
      || JSON.stringify(saved.recordIds??[])!==JSON.stringify(input.recordIds)
      || input.expectedRevision!==saved.contextRevision)throw new DiagnosticError('The reviewed feedback or context was edited. Prepare it again.',409);
    // Queueing changes item state and semantic revision. An identical repeat is
    // still the same delivered request; it must not send or mutate a second time.
    if(['queued','acknowledged','completed'].includes(saved.status))return {...saved,revision:initial.revision};
    if(saved.status!=='prepared')throw new DiagnosticError('Only reviewed feedback can be sent.',409);
    const inFlight=queues.get(store)?.get(saved.id);
    if(inFlight)return inFlight;
  }
  if(input.expectedRevision!==initial.contextRevision||saved&&saved.contextRevision!==initial.contextRevision)throw new DiagnosticError('The work changed. Refresh and prepare the feedback again.',409,{contextRevision:initial.contextRevision});
  if(!saved){
    const feedback=buildReviewFeedback(initial,input);
    store.append({id:`review-feedback:${feedback.id}`,kind:'review_feedback_request',actor:'You',provenance:'user',sessionId:initial.project.sessionId,summary:'Review feedback prepared',source:{type:'flux_review',ref:feedback.groupId},data:{feedback}});
    return {...feedback,revision:store.snapshot().revision};
  }
  targets(initial,itemIds);
  const pending=queues.get(store)??new Map();queues.set(store,pending);
  if(pending.has(saved.id))return pending.get(saved.id);
  const dispatch=Promise.resolve().then(async()=>{
    let status='queued',error='';
    try{await queueCommand({sessionId:initial.project.sessionId,prompt:saved.prompt,requestId:saved.id});}
    catch(cause){status='failed';error=cut(cause?.stderr||cause?.message||'Codex could not accept the feedback.',600);}
    store.append({id:`review-feedback-status:${saved.id}`,kind:'review_feedback_status',actor:'Flux',provenance:'observed',sessionId:initial.project.sessionId,summary:status==='queued'?'Grouped review feedback queued to Codex':`Delivery unconfirmed: ${error}`,source:{type:'flux_review',ref:saved.groupId},data:{id:saved.id,status,...(status==='queued'?{userInstruction:saved.note}:{}),...(error?{error}:{})}});
    return {...saved,status,...(error?{error}:{}),revision:store.snapshot().revision};
  });
  pending.set(saved.id,dispatch);
  try{return await dispatch;}finally{pending.delete(saved.id);}
}
