import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Test the same pure state/transport modules consumed by React; browser journeys
// exercise the rendered controls separately, without adding a DOM dependency.
async function loadTypeScript(path) {
  const { outputFiles } = await build({ entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,write:false,format:'esm',target:'es2022',platform:'node' });
  const code=outputFiles[0].text;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
const state = await loadTypeScript('../ui/src/lib/question-drafts.ts');
const api = await loadTypeScript('../ui/src/lib/api.ts');
const reviewState = await loadTypeScript('../ui/src/lib/review-drafts.ts');
const scope = { projectId: 'project-A', sessionId: 'chat-A' };
const authored = id => ({ id, question: 'Why is this workflow grouped?', recordIds: ['selected'], availableRecordIds: ['selected','excluded'], mode: 'edit' });
const request = (patch = {}) => ({ id: 'server-1', question: 'Original question', recordIds: ['selected'], prompt: 'Frozen original prompt', status: 'prepared', contextRevision: 'context-1', ...scope, ...patch });

test('close/reopen/reload retains authored edits and excluded sources', () => {
  let collection = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: authored('local-1') });
  collection = state.questionReducer(collection, { type: 'edit', id: 'local-1', question: 'Edited question', recordIds: [] });
  const reopened = state.restoreQuestions(JSON.stringify(collection), scope);
  assert.equal(reopened.activeId, 'local-1');
  assert.equal(reopened.drafts[0].question, 'Edited question');
  assert.deepEqual(reopened.drafts[0].recordIds, []);
  assert.deepEqual(reopened.drafts[0].availableRecordIds, ['selected','excluded']);
});

test('a disappearing selected source remains selected and is not silently discarded', () => {
  const collection = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: authored('local-1') });
  const next = state.restoreQuestions(JSON.stringify(collection), scope);
  const events = []; // A passive snapshot no longer supplies the selected record.
  assert.deepEqual(next.drafts[0].recordIds, ['selected']);
  assert.equal(state.currentQuestionRequest(next.drafts[0], [], scope, events), undefined);
  assert.deepEqual(next.drafts[0].availableRecordIds, ['selected','excluded']);
});

test('project/chat switch before autosave cannot overwrite the new scope', () => {
  const otherProject = { ...scope, projectId: 'project-B' }, otherChat = { ...scope, sessionId: 'chat-B' };
  const collection = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: authored('local-1') });
  const writes = [];
  const storage = { setItem: (key,value) => writes.push([key,value]) };
  assert.equal(state.saveQuestions(storage, collection, otherProject), false);
  assert.equal(state.saveQuestions(storage, collection, otherChat), false);
  assert.deepEqual(writes, []);
  state.saveQuestions(storage, collection, collection);
  assert.equal(writes[0][0], state.questionStorageKey(scope));
  assert.deepEqual(state.restoreQuestions(writes[0][1], otherProject).drafts, []);
  assert.deepEqual(state.restoreQuestions(writes[0][1], otherChat).drafts, []);
  assert.notEqual(state.questionStorageKey({projectId:'a:b',sessionId:'c'}), state.questionStorageKey({projectId:'a',sessionId:'b:c'}));
});

test('storage unavailable leaves in-memory authored state intact', () => {
  const collection = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: authored('local-1') });
  assert.throws(() => state.saveQuestions({ setItem() { throw Error('Storage denied'); } }, collection, scope), /Storage denied/);
  const resumed = state.questionReducer(collection, { type: 'activate', id: 'local-1' });
  assert.equal(resumed.drafts[0].question, authored('local-1').question);
  assert.deepEqual(resumed.drafts[0].recordIds, ['selected']);
});

test('new Ask draft preserves earlier unsent work without reusing old text/context', () => {
  const first = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: authored('old') });
  const next = state.questionReducer(first, { type: 'add', draft: { ...authored('new'), question: 'A separate group question', recordIds: ['group-source'], availableRecordIds: ['group-source'] } });
  assert.equal(next.drafts.length, 2);
  assert.equal(next.activeId, 'new');
  assert.deepEqual(next.drafts[0], first.drafts[0]);
  assert.deepEqual(next.drafts[1].recordIds, ['group-source']);
});

test('editing a prepared request creates a separate draft and requires a new reviewed ID', () => {
  const original = request();
  const oldView = state.draftFromRequest(original, 'old-view');
  let collection = state.questionReducer(state.emptyQuestions(scope), { type: 'add', draft: oldView });
  collection = state.questionReducer(collection, { type: 'edit', id: 'old-view', question: 'Must not mutate preview' });
  assert.equal(collection.drafts[0].question, original.question);
  collection = state.questionReducer(collection, { type: 'add', draft: state.draftFromRequest(original, 'new-edit', true) });
  assert.equal(collection.drafts[1].requestId, undefined);
  assert.equal(collection.drafts[1].mode, 'edit');
  collection = state.questionReducer(collection, { type: 'edit', id: 'new-edit', question: 'Revised question', recordIds: [] });
  collection = state.questionReducer(collection, { type: 'prepared', id: 'new-edit', requestId: 'server-2',submittedQuestion:'Revised question',submittedRecordIds:[] });
  assert.equal(collection.drafts[1].requestId, 'server-2');
  assert.equal(collection.drafts[0].requestId, 'server-1');
  assert.equal(original.prompt, 'Frozen original prompt');
  assert.deepEqual(original.recordIds, ['selected']);
});

test('late question prepare response preserves newer text/exclusions and never activates another draft', () => {
  let collection=state.questionReducer(state.emptyQuestions(scope),{type:'add',draft:authored('pending')});
  const submitted=structuredClone(collection.drafts[0]);
  collection=state.questionReducer(collection,{type:'edit',id:'pending',question:'Newer bytes while preparing',recordIds:[]});
  collection=state.questionReducer(collection,{type:'add',draft:authored('another-active')});
  collection=state.questionReducer(collection,{type:'prepared',id:'pending',requestId:'old-preview',submittedQuestion:submitted.question,submittedRecordIds:submitted.recordIds});
  assert.equal(collection.activeId,'another-active');
  assert.equal(collection.drafts[0].mode,'edit');
  assert.equal(collection.drafts[0].question,'Newer bytes while preparing');
  assert.deepEqual(collection.drafts[0].recordIds,[]);
  assert.equal(collection.drafts[0].requestId,undefined);
  assert.match(collection.drafts[0].previewNotice,/newer edits are preserved/);
});

test('known queued/acknowledged/completed receipts supersede persisted transport uncertainty', () => {
  for(const status of ['queued','acknowledged','completed']) {
    const known=request({status,error:'Earlier timeout'});
    assert.equal(state.questionDeliveryUnconfirmed(known,'Persisted network error'),false);
    assert.equal(state.draftFromRequest(known,'new',true).priorDeliveryError,undefined);
  }
  assert.equal(state.questionDeliveryUnconfirmed(request(),'Transport error'),true);
  assert.equal(state.questionDeliveryUnconfirmed(request({status:'failed'})),true);
});

test('receipt arriving after retry question/review drafts are already open supersedes prior uncertainty without editing them',()=>{
  const questionRetry=state.draftFromRequest(request({status:'failed',error:'Original delivery timeout'}),'open-question-retry',true);
  questionRetry.question='Newer authored question';questionRetry.recordIds=[];
  const reviewRetry=reviewState.reviewFromRequest(feedback({status:'failed',error:'Original change delivery timeout'}),'open-review-retry',true);
  reviewRetry.note='Newer authored change note';reviewRetry.affectedItemIds=['a'];reviewRetry.recordIds=[];
  const questionCopy=structuredClone(questionRetry),reviewCopy=structuredClone(reviewRetry);
  assert.equal(state.earlierDeliveryNotice(questionRetry.priorDeliveryError,request({status:'failed'})).kind,'uncertain');
  assert.equal(state.earlierDeliveryNotice(reviewRetry.priorDeliveryError,feedback({status:'failed'})).kind,'uncertain');
  for(const status of ['queued','acknowledged','completed']) {
    assert.deepEqual(state.earlierDeliveryNotice(questionRetry.priorDeliveryError,request({status})),{kind:'receipt',status});
    assert.deepEqual(state.earlierDeliveryNotice(reviewRetry.priorDeliveryError,feedback({status})),{kind:'receipt',status});
  }
  assert.deepEqual(questionRetry,questionCopy);
  assert.deepEqual(reviewRetry,reviewCopy);
});

test('late duplicate prepare callbacks cannot replace an already associated question or review request',()=>{
  let questions=state.questionReducer(state.emptyQuestions(scope),{type:'add',draft:authored('q')});
  const qa={type:'prepared',id:'q',requestId:'first-question',submittedQuestion:authored('q').question,submittedRecordIds:['selected']};
  questions=state.questionReducer(questions,qa);
  questions=state.questionReducer(questions,{...qa,requestId:'late-question'});
  assert.equal(questions.drafts[0].requestId,'first-question');
  let reviews=reviewState.reviewReducer(reviewState.emptyReviews(scope),{type:'add',draft:reviewDraft('r')});
  const ra={type:'prepared',id:'r',requestId:'first-review',submittedSignature:reviewState.reviewSignature(reviews.drafts[0])};
  reviews=reviewState.reviewReducer(reviews,ra);
  reviews=reviewState.reviewReducer(reviews,{...ra,requestId:'late-review'});
  assert.equal(reviews.drafts[0].requestId,'first-review');
});

test('missing selected feedback source remains a visible removable choice', () => {
  const choices=state.sourceChoicesForDraft(['visible'],['missing-selected'],[{id:'visible',kind:'verification'}]);
  assert.deepEqual(choices.map(choice=>choice.id),['visible','missing-selected']);
  assert.equal(choices[1].record,undefined);
  const selected=['missing-selected'];
  assert.deepEqual(selected.filter(id=>id!==choices[1].id),[]);
});

test('failed recovery preserves original error/text/sources and never enables blind resend', () => {
  const failed = request({ status: 'failed', error: 'Native delivery timed out; receipt unknown' });
  const draft = state.draftFromRequest(failed, 'retry', true);
  assert.equal(draft.question, failed.question);
  assert.deepEqual(draft.recordIds, failed.recordIds);
  assert.equal(draft.priorDeliveryError, failed.error);
  assert.equal(draft.requestId, undefined);
  assert.equal(draft.basedOnRequestId, failed.id);
  assert.equal(state.canSendQuestion(failed, scope, 'context-1'), false);
  assert.equal(state.canSendQuestion(request(), scope, 'context-1', 'Network error; delivery unknown'), false);
  assert.equal(state.canSendQuestion(request({ id:'new-reviewed-id' }), scope, 'context-1'), true);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Native delivery timed out; receipt unknown');
});

test('an answer arriving on the open request is visible without overwriting edit text or sources', () => {
  const open = state.draftFromRequest(request({status:'queued'}), 'open-view');
  const editing = authored('editing');
  const completed = request({ status:'completed', result:'The recorded answer' });
  const records = [request({id:'unrelated',status:'completed',result:'FOREIGN ANSWER'}), completed];
  assert.equal(state.currentQuestionRequest(open, records, scope, []).result, 'The recorded answer');
  assert.equal(state.currentQuestionRequest(editing, records, scope, []), undefined);
  assert.deepEqual(editing, authored('editing'));
  assert.equal(state.canSendQuestion(completed, scope, 'context-1'), false);
});

test('request lists scope legacy records through source events and hide unknown/foreign records', () => {
  const legacy = request({ projectId:undefined, sessionId:undefined, sourceEventId:'legacy-source' });
  const source = { id:'legacy-source',kind:'diagnostic_request',sessionId:'chat-A',data:{requestId:legacy.id} };
  assert.equal(state.requestInQuestionScope(legacy, scope, [source]), true);
  assert.equal(state.requestInQuestionScope(legacy, scope, []), false);
  assert.equal(state.requestInQuestionScope(legacy, scope, [{...source,sessionId:'chat-B'}]), false);
  assert.equal(state.requestInQuestionScope(legacy, scope, [{...source,projectId:'project-B'}]), false);
  assert.equal(state.requestInQuestionScope(request({projectId:'project-B'}), scope, []), false);
  assert.equal(state.requestInQuestionScope(request({sessionId:'chat-B'}), scope, []), false);
  assert.equal(state.canSendQuestion(legacy, scope, 'context-1'), false, 'Legacy preview must be prepared again');
});

test('explicit foreign source wins over an earlier colliding local request ID; ambiguous fallback stays hidden', () => {
  const local = { id:'local-source',kind:'diagnostic_request',sessionId:'chat-A',data:{requestId:'shared-id'} };
  const foreign = { id:'foreign-source',kind:'diagnostic_request',sessionId:'chat-B',data:{requestId:'shared-id'} };
  const legacy = request({ id:'shared-id',projectId:undefined,sessionId:undefined,sourceEventId:'foreign-source' });
  assert.equal(state.requestInQuestionScope(legacy,scope,[local,foreign]),false);
  assert.equal(state.requestInQuestionScope({...legacy,sourceEventId:undefined},scope,[local,foreign]),false);
  assert.equal(state.requestInQuestionScope({...legacy,sourceEventId:'missing'},scope,[local]),false);
  assert.equal(state.requestInQuestionScope({...legacy,sourceEventId:'local-source'},scope,[local,foreign]),true);
});

test('API Ask prepares read-only diagnostics and feedback sends exactly the reviewed v2 subset', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (path, options) => { const body=JSON.parse(options.body); calls.push({path,body}); return {ok:true,json:async()=>({...body,id:'prepared-id',status:body.dispatch?'queued':'prepared'})}; };
  try {
    const snapshot={csrfToken:'synthetic-csrf',contextRevision:'current-context'};
    await api.prepareQuestion(snapshot, 'Why is this workflow grouped?', ['related-source']);
    assert.equal(calls[0].path, '/api/diagnostics');
    assert.equal(calls[0].body.dispatch, false);
    assert.equal(calls[0].body.question, 'Why is this workflow grouped?');
    assert.deepEqual(calls[0].body.recordIds, ['related-source']);
    const prepared=await api.prepareReviewFeedback(snapshot,'group-ab',[{id:'b'},{id:'a'}],['b'],'Change B only',[]);
    assert.equal(calls[1].body.intent,'request_changes');
    assert.deepEqual(calls[1].body.itemIds,['a','b']);
    assert.deepEqual(calls[1].body.affectedItemIds,['b']);
    assert.deepEqual(calls[1].body.recordIds,[]);
    const frozen={...prepared,requestVersion:2,intent:'request_changes',affectedItemIds:['b'],recordIds:[],contextRevision:'reviewed-context'};
    await api.sendReviewFeedback({...snapshot,contextRevision:'newer-context'},frozen);
    assert.deepEqual(calls[2].body,{intent:'request_changes',affectedItemIds:['b'],requestId:'prepared-id',groupId:'group-ab',itemIds:['a','b'],note:'Change B only',recordIds:[],expectedRevision:'reviewed-context',dispatch:true});
    await api.sendQuestion({...snapshot,contextRevision:'newer-context'},request());
    assert.equal(calls[3].body.requestId,'server-1');
    assert.equal(calls[3].body.expectedRevision,'context-1');
    assert.deepEqual(calls[3].body.recordIds,['selected']);
  } finally {globalThis.fetch=previous;}
});

const reviewDraft=id=>({id,note:'Change B only; keep A intact.',groupId:'saved-group',itemIds:['a','b'],affectedItemIds:['b'],recordIds:['selected'],availableRecordIds:['selected','excluded'],intent:'request_changes',mode:'compose'});
const feedback=(patch={})=>({id:'feedback-1',...scope,requestVersion:2,intent:'request_changes',groupId:'saved-group',itemIds:['a','b'],affectedItemIds:['b'],recordIds:['selected'],note:'Change B only; keep A intact.',question:'Change B only; keep A intact.',prompt:'Frozen change packet',contextRevision:'context-1',status:'prepared',...patch});

test('review note/context/affected/source choices survive close/reload and remain project/chat isolated',()=>{
  let collection=reviewState.reviewReducer(reviewState.emptyReviews(scope),{type:'add',draft:reviewDraft('local-review')});
  collection=reviewState.reviewReducer(collection,{type:'edit',id:'local-review',patch:{note:'Exact revised note\nwith qualification',recordIds:[]}});
  const restored=reviewState.restoreReviews(JSON.stringify(collection),scope);
  assert.deepEqual(restored,collection);
  assert.deepEqual(restored.drafts[0].affectedItemIds,['b']);
  assert.deepEqual(restored.drafts[0].itemIds,['a','b']);
  assert.deepEqual(restored.drafts[0].recordIds,[]);
  assert.deepEqual(restored.drafts[0].availableRecordIds,['selected','excluded']);
  assert.deepEqual(reviewState.restoreReviews(JSON.stringify(collection),{...scope,sessionId:'other-chat'}).drafts,[]);
  assert.deepEqual(reviewState.restoreReviews(JSON.stringify(collection),{...scope,projectId:'other-project'}).drafts,[]);
  const writes=[];
  assert.equal(reviewState.saveReviews({setItem:(...args)=>writes.push(args)},collection,{...scope,sessionId:'other-chat'}),false);
  assert.deepEqual(writes,[]);
  assert.throws(()=>reviewState.saveReviews({setItem(){throw Error('Storage denied')}},collection,scope));
  assert.deepEqual(collection.drafts[0].itemIds,['a','b']);
});

test('each pending review prepare field is revision-guarded against hiding a newer composer',()=>{
  for(const patch of [{note:'Newer note'},{affectedItemIds:['a']},{itemIds:['a'],groupId:'new-group'},{recordIds:[]},{intent:undefined}]) {
    let collection=reviewState.reviewReducer(reviewState.emptyReviews(scope),{type:'add',draft:reviewDraft('pending')});
    const submittedSignature=reviewState.reviewSignature(collection.drafts[0]);
    collection=reviewState.reviewReducer(collection,{type:'edit',id:'pending',patch});
    const newer=structuredClone(collection.drafts[0]);
    collection=reviewState.reviewReducer(collection,{type:'add',draft:reviewDraft('another-active')});
    collection=reviewState.reviewReducer(collection,{type:'prepared',id:'pending',requestId:'old-prepared',submittedSignature});
    assert.equal(collection.activeId,'another-active');
    assert.equal(collection.drafts[0].mode,'compose');
    assert.equal(collection.drafts[0].requestId,undefined);
    for(const key of ['note','itemIds','affectedItemIds','recordIds','intent','groupId'])assert.deepEqual(collection.drafts[0][key],newer[key]);
    assert.match(collection.drafts[0].previewNotice,/newer note and scope are preserved/);
  }
});

test('prepared review association survives reload; editing/retry keeps immutable old record and separate unsent draft',()=>{
  const original=feedback({status:'failed',error:'Queue timeout; delivery unknown'});
  const originalCopy=structuredClone(original);
  let collection=reviewState.reviewReducer(reviewState.emptyReviews(scope),{type:'add',draft:reviewDraft('unsent')});
  collection=reviewState.reviewReducer(collection,{type:'add',draft:reviewState.reviewFromRequest(original,'old-view')});
  collection=reviewState.restoreReviews(JSON.stringify(collection),scope);
  assert.equal(collection.drafts[1].requestId,original.id);
  const retry=reviewState.reviewFromRequest(original,'retry',true);
  collection=reviewState.reviewReducer(collection,{type:'add',draft:retry});
  assert.equal(retry.priorDeliveryError,original.error);
  assert.equal(retry.requestId,undefined);
  assert.equal(retry.basedOnRequestId,original.id);
  assert.deepEqual(retry.itemIds,['a','b']);
  assert.deepEqual(retry.affectedItemIds,['b']);
  assert.deepEqual(retry.recordIds,['selected']);
  assert.deepEqual(collection.drafts[0],reviewDraft('unsent'));
  const signature=reviewState.reviewSignature(retry);
  collection=reviewState.reviewReducer(collection,{type:'prepared',id:'retry',requestId:'fresh-reviewed-id',submittedSignature:signature});
  assert.equal(collection.drafts[2].requestId,'fresh-reviewed-id');
  assert.deepEqual(original,originalCopy);
});

test('queued review recovery keeps now-in-progress/missing affected IDs until explicit removal',()=>{
  const queued=feedback({status:'queued',affectedItemIds:['b','missing'],itemIds:['a','b','missing'],error:'Earlier uncertainty'});
  const draft=reviewState.reviewFromRequest(queued,'next',true);
  assert.deepEqual(draft.affectedItemIds,['b','missing']);
  assert.deepEqual(draft.itemIds,['a','b','missing']);
  assert.equal(draft.priorDeliveryError,undefined,'Known queue receipt supersedes earlier local error');
  let collection=reviewState.reviewReducer(reviewState.emptyReviews(scope),{type:'add',draft});
  collection=reviewState.reviewReducer(collection,{type:'edit',id:'next',patch:{affectedItemIds:['b']}});
  assert.deepEqual(collection.drafts[0].itemIds,['a','b','missing'],'Changing affected selection never silently narrows full context');
});

test('review history rejects foreign/ambiguous legacy events and never infers all affected items',()=>{
  const legacy=feedback({projectId:undefined,sessionId:undefined,requestVersion:undefined,intent:undefined,affectedItemIds:undefined});
  const event={id:'legacy',kind:'review_feedback_request',sessionId:'chat-A',source:{type:'flux_review',ref:'saved-group'},data:{feedback:legacy}};
  assert.equal(reviewState.reviewInScope(legacy,scope,[event]),true);
  assert.equal(reviewState.reviewInScope(legacy,scope,[]),false);
  assert.equal(reviewState.reviewInScope(legacy,scope,[event,{...event,id:'foreign',sessionId:'chat-B'}]),false);
  assert.equal(reviewState.reviewInScope(legacy,scope,[{...event,sessionId:'chat-B'}]),false);
  assert.equal(reviewState.reviewInScope(legacy,scope,[{...event,projectId:'project-B'}]),false);
  const edit=reviewState.reviewFromRequest(legacy,'legacy-edit',true);
  assert.deepEqual(edit.affectedItemIds,[]);
  assert.equal(edit.intent,undefined);
  assert.deepEqual(edit.itemIds,['a','b']);
});
