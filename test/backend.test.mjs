import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createStore } from '../src/store.mjs';
import { buildDiagnostic, runDiagnostic } from '../src/diagnostics.mjs';
import { reviewWork } from '../src/reviews.mjs';
import { startServer } from '../src/server.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'flux-backend-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createStore(directory);
  store.setProject({ id: 'pilot', title: 'Pilot', goal: 'Build a trustworthy companion', directory: '/tmp/flux', sessionId: 'enrolled', sessions: [{ id: 'enrolled', title: 'Pilot chat' }],
    items: [{ id: 'work', title: 'Implementation', status: 'working', purpose: 'SECRET EXCLUDED PURPOSE', sourceIds: ['excluded'] }],
    plans: [{ id: 'old-plan', title: 'Earlier plan', steps: [{ id: 'secret', title: 'SECRET EXCLUDED STEP' }], sourceIds: ['excluded'] }], decisions: [], constraints: [] });
  store.append({ id: 'intent', at: '2026-10-09T10:00:00Z', kind: 'message.user', provenance: 'user', summary: 'Build this and dogfood this chat', source: { type: 'transcript', ref: 'chat#line1' } });
  store.append({ id: 'included', at: '2026-10-09T10:01:00Z', kind: 'tool.returned', provenance: 'observed', summary: 'Persistence test passed', source: { type: 'transcript', ref: 'chat#line2' } });
  store.append({ id: 'excluded', at: '2026-10-09T10:02:00Z', kind: 'message.assistant', provenance: 'agent_report', summary: 'SECRET EXCLUDED BODY', source: { type: 'transcript', ref: 'chat#line3' } });
  return { directory, store };
}

test('journal persistence, stable revisions, idempotency and immutable event ownership', t => {
  const { directory, store } = fixture(t);
  const input = { id: 'ownership', kind: 'tool.returned', data: { file: 'a.mjs' } };
  const saved = store.append(input);
  input.data.file = 'b.mjs'; saved.data.file = 'c.mjs';
  const before = store.snapshot().revision;
  assert.equal(store.append({ id: 'ownership', kind: 'different', data: {} }).data.file, 'a.mjs');
  assert.equal(store.snapshot().revision, before);
  const reopened = createStore(directory);
  assert.equal(reopened.snapshot().revision, before);
  assert.deepEqual(reopened.events(), store.events());
  assert.equal(readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').length, store.events().length);
});

test('tool and turn completion do not complete the goal; semantic updates carry their own status', t => {
  const { store } = fixture(t);
  store.append({ kind: 'turn.finished', summary: 'Done', provenance: 'observed' });
  store.append({ kind: 'tool.returned', summary: 'File edited', provenance: 'observed' });
  assert.equal(store.snapshot().project.items[0].status, 'working');
  store.append({ kind: 'item_updated', provenance: 'agent_report', data: { item: { id: 'work', status: 'claimed_complete' } } });
  assert.equal(store.snapshot().project.items[0].status, 'claimed_complete');
});

test('separate CLI and hook stores refresh the active journal without losing records or revisions', t => {
  const { store, directory } = fixture(t);
  const cliStore = createStore(directory);
  const before = store.snapshot().revision;
  let notification;
  store.subscribe(revision => { notification = revision; });
  cliStore.append({ id: 'external-hook', kind: 'hook.fact', source: { type: 'hook', ref: 'external' } });
  assert.equal(store.refresh(), true);
  assert.equal(notification, before + 1);
  store.append({ id: 'local-write', kind: 'item_updated', data: { item: { id: 'work', status: 'waiting' } } });
  assert.equal(cliStore.snapshot().revision, before + 2);
  assert.equal(cliStore.snapshot().project.items[0].status, 'waiting');
  assert.equal(store.events().filter(event => event.id === 'external-hook').length, 1);
});

test('generated diagnostic messages do not replace the explicit project instruction', t => {
  const { store } = fixture(t);
  store.setProject({ ...store.snapshot().project, latestIntent: 'Approved: build the companion and dogfood this chat.', latestIntentSourceId: 'intent' });
  store.append({ id: 'queued-user-prompt', kind: 'message.user', provenance: 'user', text: 'Flux diagnostic aabb-1234. Inspect the supplied work record and answer the user\'s question.' });
  const diagnostic = buildDiagnostic(store.snapshot(), { question: 'Where are we?', recordIds: [], expectedRevision: store.snapshot().revision });
  assert.match(diagnostic.prompt, /Approved: build the companion and dogfood this chat/);
  assert.doesNotMatch(diagnostic.prompt, /queued-user-prompt/);
});

test('a newer direct human instruction supersedes the recorded intent anchor', t => {
  const { store } = fixture(t);
  store.setProject({ ...store.snapshot().project, latestIntent: 'Approved: build the companion and dogfood this chat.', latestIntentSourceId: 'intent' });
  store.append({ id: 'new-human-direction', kind: 'message.user', provenance: 'user', text: 'Pause dispatch and examine only the saved plan.' });
  const diagnostic = buildDiagnostic(store.snapshot(), { question: 'Where are we?', recordIds: [], expectedRevision: store.snapshot().revision });
  assert.match(diagnostic.prompt, /Pause dispatch and examine only the saved plan/);
  assert.doesNotMatch(diagnostic.prompt, /Approved: build the companion/);
  assert.deepEqual(diagnostic.requiredRecordIds, ['new-human-direction']);
});

test('an unanchored stored instruction cannot override the latest actual human direction', t => {
  const { store } = fixture(t);
  store.setProject({ ...store.snapshot().project, latestIntent: 'STALE UNANCHORED SUMMARY', latestIntentSourceId: 'missing-anchor' });
  store.append({ id: 'current-human', kind: 'message.user', provenance: 'user', text: 'Review the clearer UX before doing integration work.' });
  const diagnostic=buildDiagnostic(store.snapshot(), { question:'What now?', recordIds:[], expectedRevision:store.snapshot().contextRevision });
  assert.match(diagnostic.prompt,/Review the clearer UX before doing integration work/);
  assert.doesNotMatch(diagnostic.prompt,/STALE UNANCHORED SUMMARY/);
  assert.deepEqual(diagnostic.requiredRecordIds,['current-human']);
});

test('diagnostic context respects excluded records and derived summaries while retaining latest intent', t => {
  const { store } = fixture(t);
  const response = buildDiagnostic(store.snapshot(), { question: 'Where are we?', selectedItemId: 'work', baselinePlanId: 'old-plan', recordIds: ['included'], expectedRevision: store.snapshot().revision, dispatch: false }, { id: 'check' });
  assert.match(response.prompt, /Build this and dogfood this chat/);
  assert.match(response.prompt, /Persistence test passed/);
  assert.doesNotMatch(response.prompt, /SECRET EXCLUDED/);
  assert.match(response.prompt, /Its summary is omitted/);
  assert.deepEqual(response.requiredRecordIds, ['intent']);
  assert.ok(response.prompt.length <= 6000);
});

test('selected semantic plan records include their steps while excluded plans and arbitrary payloads remain absent', t => {
  const { store } = fixture(t);
  store.append({ id: 'selected-plan-record', kind: 'plan_saved', summary: 'Checkpoint saved', data: { plan: { id: 'visible-plan', title: 'Current plan', steps: [{ id: 'verify', title: 'Verify imported chat', status: 'working' }] }, unrelated: 'ARBITRARY PAYLOAD' } });
  store.append({ id: 'excluded-plan-record', kind: 'plan_saved', summary: 'Other plan saved', data: { plan: { id: 'hidden-plan', steps: [{ title: 'EXCLUDED SEMANTIC STEP' }] } } });
  store.append({ id: 'tool-metadata-record', kind: 'tool.returned', summary: 'Tool returned', data: { output: 'RAW TOOL OUTPUT' } });
  const diagnostic = buildDiagnostic(store.snapshot(), { question: 'Where are we with this plan?', recordIds: ['selected-plan-record', 'tool-metadata-record'], expectedRevision: store.snapshot().contextRevision });
  assert.match(diagnostic.prompt, /Verify imported chat/);
  assert.match(diagnostic.prompt, /Recorded plan:/);
  assert.doesNotMatch(diagnostic.prompt, /EXCLUDED SEMANTIC STEP|ARBITRARY PAYLOAD|RAW TOOL OUTPUT/);
  assert.ok(diagnostic.prompt.length <= 6000);
});

test('selected native model and response usage evidence keeps safe metadata within the selected context', t => {
  const { store } = fixture(t);
  const usage = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 5, total_tokens: 112 };
  store.append({ id: 'selected-model', kind: 'model.configured', summary: 'Configured model setting', data: { model: 'model-a', actualModel: 'ACTUAL_MODEL_SECRET', secret: 'MODEL_PAYLOAD_SECRET' } });
  store.append({ id: 'selected-usage', kind: 'usage.tokens', summary: 'Model response token usage', data: { configuredModel: 'model-a', usage: { ...usage, secret: 'USAGE_PAYLOAD_SECRET' }, threadUsage: { total_tokens: 987654 }, body: 'RAW_BODY_SECRET' } });
  store.append({ id: 'invalid-usage', kind: 'usage.tokens', summary: 'Partially reported response', data: { usage: { input_tokens: -1, cached_input_tokens: '3', cache_write_input_tokens: null, output_tokens: 1.5, reasoning_output_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: 9 } } });
  store.append({ id: 'excluded-usage', kind: 'usage.tokens', summary: 'EXCLUDED_USAGE_SECRET', data: { configuredModel: 'EXCLUDED_MODEL_SECRET', usage: { total_tokens: 123456 } } });
  const diagnostic = buildDiagnostic(store.snapshot(), { question: 'What do the selected native records report?', recordIds: ['selected-model', 'selected-usage', 'invalid-usage'], expectedRevision: store.snapshot().contextRevision });
  assert.match(diagnostic.prompt, /Configured model: "model-a" \(setting only; actual execution model is unknown\)/);
  assert.ok(diagnostic.prompt.includes(`Native per-response token counts: ${JSON.stringify(usage)}`));
  assert.ok(diagnostic.prompt.includes('Native per-response token counts: {"total_tokens":9}'));
  assert.match(diagnostic.prompt, /Cached input is included in input; reasoning output is included in output/);
  assert.doesNotMatch(diagnostic.prompt, /SECRET|987654|123456|"input_tokens":-1|"cached_input_tokens":"3"|"output_tokens":1\.5/);
  assert.deepEqual(diagnostic.recordIds, ['selected-model', 'selected-usage', 'invalid-usage']);
  assert.deepEqual(diagnostic.requiredRecordIds, ['intent']);
  assert.ok(diagnostic.prompt.length <= 6000);
});

test('stale diagnostics never dispatch or append; queue success is only queued until a result arrives', async t => {
  const { store, directory } = fixture(t);
  let calls = 0;
  const queueCommand = async ({ sessionId, prompt }) => { calls++; assert.equal(sessionId, 'enrolled'); assert.match(prompt, /Flux diagnostic/); };
  const revision = store.snapshot().revision;
  await assert.rejects(runDiagnostic(store, { question: 'Check', recordIds: [], expectedRevision: revision - 1, dispatch: false }, { queueCommand }), error => error.statusCode === 409);
  assert.equal(calls, 0); assert.equal(store.snapshot().revision, revision);
  const input = { question: 'Check', recordIds: ['included'], expectedRevision: revision };
  const preview = await runDiagnostic(store, input);
  const queued = await runDiagnostic(store, { ...input, requestId: preview.id, dispatch: true }, { queueCommand });
  assert.equal(calls, 1); assert.equal(queued.status, 'queued');
  assert.equal(createStore(directory).snapshot().requests.at(-1).status, 'queued');
  assert.equal(store.snapshot().project.items[0].status, 'working');
  store.append({ kind: 'diagnostic_result', provenance: 'agent_report', data: { requestId: queued.id, result: 'The test passed; coverage is incomplete.' } });
  store.append({ kind: 'diagnostic_status', data: { requestId: queued.id, status: 'queued' } });
  assert.equal(store.snapshot().requests.at(-1).status, 'completed');
  assert.equal(store.snapshot().project.items[0].status, 'working');
});

test('queueing a reviewed draft preserves its request ID and frozen prompt without another draft', async t => {
  const { store, directory } = fixture(t);
  const input = { question: 'Check the selected test result.', recordIds: ['included'], selectedItemId: 'work', baselinePlanId: 'old-plan', expectedRevision: store.snapshot().contextRevision, dispatch: false };
  const preview = await runDiagnostic(store, input, { projectDir: '/tmp/reviewed-project' });
  store.append({ kind: 'tool.returned', summary: 'A later passive tool result.' });
  store.append({ kind: 'message.assistant', provenance: 'agent_report', summary: 'Another routine report.' });
  let delivered;
  const queued = await runDiagnostic(store, { ...input, requestId: preview.id, dispatch: true }, {
    projectDir: '/tmp/a-different-call-option', queueCommand: async request => { delivered = request; },
  });
  assert.equal(queued.id, preview.id);
  assert.equal(delivered.requestId, preview.id);
  assert.equal(delivered.prompt, preview.prompt, 'dispatch must send exactly the reviewed prompt, including its original revision and result command');
  assert.equal(queued.prompt, preview.prompt);
  assert.equal(queued.status, 'queued');
  const persisted = createStore(directory).snapshot();
  assert.equal(persisted.requests.length, 1);
  assert.equal(persisted.requests[0].id, preview.id);
  assert.equal(persisted.requests[0].status, 'queued');
  assert.equal(persisted.events.filter(event => event.kind === 'diagnostic_request').length, 1);
  assert.equal(persisted.events.filter(event => event.kind === 'diagnostic_status').length, 1);
});

test('unknown drafts and changes to the reviewed question or selection never dispatch or append', async t => {
  const { store } = fixture(t);
  const input = { question: 'Check the reviewed work.', recordIds: ['included', 'intent'], selectedItemId: 'work', baselinePlanId: 'old-plan', expectedRevision: store.snapshot().contextRevision, dispatch: false };
  const preview = await runDiagnostic(store, input);
  const dispatch = { ...input, requestId: preview.id, dispatch: true };
  const revision = store.snapshot().revision;
  const queueCommand = async () => assert.fail('Changed or unknown drafts must not queue');
  for (const change of [
    { question: 'Check different work.' },
    { question: `${preview.question} ` },
    { recordIds: ['included'] },
    { recordIds: ['intent', 'included'] },
    { recordIds: ['included', 'intent', 'included'] },
    { selectedItemId: null },
    { baselinePlanId: null },
  ]) {
    await assert.rejects(runDiagnostic(store, { ...dispatch, ...change }, { queueCommand }), error => error.statusCode === 409 && /reviewed/.test(error.message));
    assert.equal(store.snapshot().revision, revision);
  }
  await assert.rejects(runDiagnostic(store, { ...dispatch, requestId: 'unknown-draft' }, { queueCommand }), error => error.statusCode === 404);
  await assert.rejects(runDiagnostic(store, { ...dispatch, dispatch: false }, { queueCommand }), error => error.statusCode === 400);
  assert.equal(store.snapshot().revision, revision);
  assert.equal(store.snapshot().requests[0].status, 'prepared');
});

test('a stale reviewed draft rejects dispatch even when the client sends the latest context revision', async t => {
  const { store } = fixture(t);
  const input = { question: 'Check the reviewed work.', recordIds: ['included'], expectedRevision: store.snapshot().contextRevision, dispatch: false };
  const preview = await runDiagnostic(store, input);
  store.append({ kind: 'message.user', provenance: 'user', text: 'Pause and investigate the evidence first.' });
  const changed = store.snapshot();
  await assert.rejects(runDiagnostic(store, { ...input, requestId: preview.id, expectedRevision: changed.contextRevision, dispatch: true }, {
    queueCommand: async () => assert.fail('A stale reviewed prompt must not queue'),
  }), error => error.statusCode === 409 && error.contextRevision === changed.contextRevision);
  assert.equal(store.snapshot().revision, changed.revision);
  assert.equal(store.snapshot().requests[0].status, 'prepared');
});

test('repeated queued, acknowledged and completed draft dispatches return persisted status without another delivery', async t => {
  const { store, directory } = fixture(t);
  const input = { question: 'Check the reviewed work.', recordIds: ['included'], expectedRevision: store.snapshot().contextRevision, dispatch: false };
  const preview = await runDiagnostic(store, input);
  const dispatch = { ...input, requestId: preview.id, dispatch: true };
  let deliveries = 0;
  const queueCommand = async () => { deliveries++; };
  await runDiagnostic(store, dispatch, { queueCommand });
  for (const status of ['queued', 'acknowledged', 'completed']) {
    if (status === 'acknowledged') store.append({ kind: 'diagnostic_status', data: { requestId: preview.id, status } });
    if (status === 'completed') store.append({ kind: 'diagnostic_result', data: { requestId: preview.id, result: 'Evidence reviewed; more verification is needed.' } });
    const before = store.snapshot().revision;
    const existing = await runDiagnostic(createStore(directory), dispatch, { queueCommand });
    assert.equal(existing.id, preview.id);
    assert.equal(existing.status, status);
    assert.equal(existing.prompt, preview.prompt);
    if (status === 'completed') assert.equal(existing.result, 'Evidence reviewed; more verification is needed.');
    assert.equal(deliveries, 1);
    assert.equal(store.snapshot().revision, before, 'an idempotent retry must not append another status');
  }
  assert.equal(store.snapshot().requests.length, 1);
});

test('concurrent dispatches of one prepared request share a single pending delivery', async t => {
  const { store } = fixture(t);
  const input = { question: 'Check the reviewed work.', recordIds: [], expectedRevision: store.snapshot().contextRevision, dispatch: false };
  const preview = await runDiagnostic(store, input);
  const dispatch = { ...input, requestId: preview.id, dispatch: true };
  let release, deliveries = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const queueCommand = async () => { deliveries++; await pending; };
  const first = runDiagnostic(store, dispatch, { queueCommand });
  const second = runDiagnostic(store, dispatch, { queueCommand });
  await Promise.resolve();
  assert.equal(deliveries, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.id === preview.id && result.status === 'queued'));
  assert.equal(store.snapshot().events.filter(event => event.kind === 'diagnostic_request').length, 1);
  assert.equal(store.snapshot().events.filter(event => event.kind === 'diagnostic_status').length, 1);
});

test('passive activity and preview logs preserve frozen diagnostic source context', async t => {
  const { store, directory } = fixture(t);
  const contextRevision = store.snapshot().contextRevision;
  const preview = await runDiagnostic(store, { question: 'Check the selected test result.', recordIds: ['included'], expectedRevision: contextRevision, dispatch: false });
  assert.equal(preview.contextRevision, contextRevision);
  assert.equal(store.snapshot().contextRevision, contextRevision);
  store.append({ kind: 'tool.started', provenance: 'observed', summary: 'Another task continues.' });
  store.append({ kind: 'coverage_updated', data: { captured: 25 } });
  store.append({ kind: 'message.assistant', provenance: 'agent_report', summary: 'Routine progress update.' });
  store.append({ kind: 'message.user', provenance: 'user', text: 'Flux diagnostic aaaa-1234. Inspect the supplied work record.' });
  store.append({ kind: 'diagnostic_result', data: { requestId: 'other-request', result: 'A previous diagnostic finished.' } });
  assert.equal(store.snapshot().contextRevision, contextRevision);
  assert.ok(store.snapshot().revision > preview.revision);
  assert.equal(createStore(directory).snapshot().contextRevision, contextRevision);
  let dispatched;
  const queued = await runDiagnostic(store, { question: preview.question, recordIds: preview.recordIds, expectedRevision: preview.contextRevision, requestId: preview.id, dispatch: true }, { queueCommand: async request => { dispatched = request; } });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.contextRevision, contextRevision);
  assert.match(dispatched.prompt, /Persistence test passed/);
  assert.doesNotMatch(dispatched.prompt, /Another task continues|Routine progress update|A previous diagnostic finished/);
});

test('changed plan and actual user direction invalidate the semantic diagnostic version', async t => {
  const { store } = fixture(t);
  const baseline = store.snapshot().contextRevision;
  const draft = await runDiagnostic(store, { question: 'Check', recordIds: [], expectedRevision: baseline });
  store.append({ kind: 'plan_saved', data: { plan: { id: 'new-plan', title: 'Revised plan', steps: [] } } });
  assert.notEqual(store.snapshot().contextRevision, baseline);
  const planned = store.snapshot().contextRevision;
  await assert.rejects(runDiagnostic(store, { question: 'Check', recordIds: [], expectedRevision: baseline, requestId: draft.id, dispatch: true }, { queueCommand: async () => assert.fail('Stale plan must not dispatch') }), error => error.statusCode === 409 && error.contextRevision === planned);
  store.append({ id: 'changed-human-intent', kind: 'message.user', provenance: 'user', text: 'Change direction: investigate the existing result first.' });
  const newest = store.snapshot().contextRevision;
  assert.notEqual(newest, planned);
  assert.throws(() => buildDiagnostic(store.snapshot(), { question: 'Check', recordIds: [], expectedRevision: planned }), error => error.statusCode === 409 && error.contextRevision === newest);
  store.append({ kind: 'item_updated', data: { item: { id: 'work', status: 'blocked' } } });
  assert.notEqual(store.snapshot().contextRevision, newest);
});

test('failed queues persist failure and never imply acknowledgment', async t => {
  const { store } = fixture(t);
  const input = { question: 'Check', recordIds: [], expectedRevision: store.snapshot().contextRevision };
  const draft = await runDiagnostic(store, input);
  const response = await runDiagnostic(store, { ...input, requestId: draft.id, dispatch: true }, { queueCommand: async () => { throw new Error('queue unavailable'); } });
  assert.equal(response.status, 'failed'); assert.match(response.error, /queue unavailable/);
  assert.equal(store.snapshot().requests.at(-1).status, 'failed');
});

test('coverage reports transcript freshness and requires an actual hook event to claim native hooks', t => {
  const { store } = fixture(t);
  store.append({ kind: 'coverage_updated', data: { adapter: 'local transcript', nativeHooksActive: true }, source: { type: 'transcript', ref: 'chat' } });
  assert.equal(store.snapshot().coverage.nativeHooksActive, false);
  assert.equal(store.snapshot().coverage.importedEvents, 3);
  assert.equal(store.snapshot().coverage.lastImportedAt, '2026-10-09T10:02:00Z');
  store.append({ kind: 'hook.fact', source: { type: 'hook', ref: 'call' } });
  assert.equal(store.snapshot().coverage.nativeHooksActive, true);
});

test('loopback HTTP rejects origin, host and CSRF attacks and accepts current authenticated JSON', async t => {
  const { store, directory } = fixture(t);
  const app = await startServer({ dataDir: directory, store, queueCommand: async () => {} });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  const state = await fetch(`${app.address}/api/state`).then(response => response.json());
  assert.equal(state.overview.direction.text, 'Build this and dogfood this chat');
  assert.equal(state.overview.focus.status, 'unknown');
  assert.equal(state.overview.now.text, null, 'a historical plan is not current work');
  const input = { question: 'Where are we?', recordIds: ['included'], expectedRevision: state.revision, dispatch: false };
  const send = headers => fetch(`${app.address}/api/diagnostics`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await send({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await send({ 'Content-Type': 'application/json', 'X-Flux-CSRF': state.csrfToken, Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await send({ 'Content-Type': 'text/plain', 'X-Flux-CSRF': state.csrfToken })).status, 415);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${app.address}/api/state`, { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
  const prepared = await send({ 'Content-Type': 'application/json', 'X-Flux-CSRF': state.csrfToken, Origin: app.address });
  assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).status, 'prepared');
  assert.equal((await send({ 'Content-Type': 'application/json', 'X-Flux-CSRF': state.csrfToken })).status, 409);
});

test('review acceptance and requested changes preserve provenance without inventing checks', t => {
  const {store}=fixture(t);
  for(const outcome of ['accepted','changes_requested']){
    store.append({kind:'item_updated',provenance:'agent_report',data:{item:{id:'work',status:'ready_for_review',review:null}}});
    const event=reviewWork(store,{itemId:'work',outcome,note:' Reviewed carefully. ',expectedRevision:store.snapshot().contextRevision});
    assert.equal(event.provenance,'user');
    assert.equal(event.source.type,'user_review');
    const item=store.snapshot().project.items[0];
    assert.equal(item.status,outcome==='accepted'?'completed':'in_progress');
    assert.equal(item.review.note,'Reviewed carefully.');
    assert.deepEqual(item.sourceIds,['excluded']);
    assert.ok(!store.events().some(event=>event.kind==='verification'));
    assert.throws(()=>reviewWork(store,{itemId:'work',outcome,expectedRevision:store.snapshot().contextRevision}),error=>error.statusCode===409);
  }
});

test('reviews reject stale work, foreign work, invalid outcomes and oversized notes before writing', t => {
  const {store}=fixture(t);
  store.append({kind:'item_updated',data:{item:{id:'work',status:'ready_for_review'}}});
  store.append({kind:'item_updated',data:{item:{id:'foreign',status:'ready_for_review',sessionId:'other'}}});
  const snapshot=store.snapshot();
  const valid={itemId:'work',outcome:'accepted',expectedRevision:snapshot.contextRevision};
  for(const patch of [{expectedRevision:'old'}, {itemId:'foreign'}, {itemId:'missing'}, {outcome:'verified'}, {note:'x'.repeat(2001)}]){
    assert.throws(()=>reviewWork(store,{...valid,...patch}),error=>[400,404,409].includes(error.statusCode));
    assert.equal(store.snapshot().revision,snapshot.revision);
  }
});

test('review API shares CSRF protection and reports the running model version', async t => {
  const {store,directory}=fixture(t);
  store.append({kind:'item_updated',data:{item:{id:'work',status:'ready_for_review'}}});
  let queued=0;
  const app=await startServer({dataDir:directory,store,queueCommand:async()=>{queued++;}});
  t.after(()=>app.close());
  const state=await fetch(`${app.address}/api/state`).then(response=>response.json());
  assert.equal(state.runtime.modelVersion,10);
  assert.equal(state.runtime.restartRequired,false);
  assert.equal(state.runtime.buildId.length,16);
  const body=JSON.stringify({itemId:'work',outcome:'accepted',expectedRevision:state.contextRevision});
  const send=headers=>fetch(`${app.address}/api/reviews`,{method:'POST',headers,body});
  assert.equal((await send({'Content-Type':'application/json'})).status,403);
  assert.equal((await send({'Content-Type':'application/json','X-Flux-CSRF':state.csrfToken,Origin:'https://elsewhere.test'})).status,403);
  assert.equal((await send({'Content-Type':'application/json','X-Flux-CSRF':state.csrfToken})).status,200);
  assert.equal((await send({'Content-Type':'application/json','X-Flux-CSRF':state.csrfToken})).status,409);
  assert.equal(queued,0);
});

test('bounded question previews report omitted source coverage explicitly', t=>{
  const {store}=fixture(t);
  for(let i=0;i<15;i++)store.append({id:'large-'+i,kind:'message.assistant',text:'long evidence '.repeat(100)});
  const result=buildDiagnostic(store.snapshot(),{question:'What is verified?',recordIds:Array.from({length:15},(_,i)=>'large-'+i),expectedRevision:store.snapshot().contextRevision});
  assert.ok(result.omittedRecordCount>0);
  assert.equal(result.includedRecordIds.length+result.omittedRecordCount,15);
  assert.ok(result.prompt.length<=6000);
  assert.match(result.prompt,/coverage is incomplete/);
});

test('a selected focus source includes its declared why and next without unrelated patch data', t=>{
  const {store}=fixture(t);
  store.append({id:'focus',kind:'project_patch',data:{patch:{focus:{title:'Review flow',why:'Keep users informed',next:{text:'Inspect live UI',status:'planned'}},unrelated:'EXCLUDED_PATCH_FIELD'}}});
  const result=buildDiagnostic(store.snapshot(),{question:'What now?',recordIds:['focus'],expectedRevision:store.snapshot().contextRevision});
  assert.match(result.prompt,/Keep users informed/);assert.match(result.prompt,/Inspect live UI/);assert.doesNotMatch(result.prompt,/EXCLUDED_PATCH_FIELD/);
});
