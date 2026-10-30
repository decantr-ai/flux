import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '../..');
const questions = [
  'Which audience should this demo target?',
  'Which device size should we prioritize?',
  'Which sample project should we use?',
  'Should the demo use Light or Dark?',
];
const stamp = index => new Date(Date.UTC(2026, 9, 29, 16, 0, index)).toISOString();
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const validate = directory => {
  const path = realpathSync(directory);
  if (!path.startsWith('/private/tmp/flux-four-questions-20261029-') || !existsSync(join(path, '.four-questions-lab'))) throw Error('Expected an isolated marked four-question lab beneath /private/tmp.');
  return path;
};
const mode = process.argv[2];

if (mode === '--launch') {
  const lab = validate(process.argv[3]);
  const child = spawn(process.execPath, [join(lab, 'four-questions.mjs'), '--serve', lab], { cwd: lab, detached: true, stdio: ['ignore', openSync(join(lab, 'server.log'), 'a'), openSync(join(lab, 'server-error.log'), 'a')] });
  child.unref();
  writeJSON(join(lab, 'process.json'), { pid: child.pid, lab, command: [process.execPath, join(lab, 'four-questions.mjs'), '--serve', lab], cleanup: `kill -TERM ${child.pid}` });
  console.log(JSON.stringify({ lab, pid: child.pid, connection: join(lab, 'connection.json') }));
} else if (mode === '--serve') {
  const lab = validate(process.argv[3]);
  const baseline = join(lab, 'baseline');
  const { createStore } = await import(pathToFileURL(join(baseline, 'src/store.mjs')));
  const { startServer } = await import(pathToFileURL(join(baseline, 'src/server.mjs')));
  const result = JSON.parse(readFileSync(join(lab, 'results.json')));
  const apps = [];
  const queueLog = join(lab, 'blocked-sends.jsonl');
  const queueCommand = async request => { appendFileSync(queueLog, JSON.stringify({ at: new Date().toISOString(), request }) + '\n'); throw Error('Synthetic four-question lab: all native sends are blocked.'); };
  for (const item of result.cases.filter(item => ['four-separate-messages', 'four-explicit-waiting-items'].includes(item.id))) {
    const dataDir = join(lab, 'cases', item.id, 'data');
    const app = await startServer({ dataDir, store: createStore(dataDir), port: 0, watch: false, publicDir: join(baseline, 'public'), queueCommand, contentOptions: { reveal: async () => { throw Error('Synthetic lab: native reveal is blocked.'); } } });
    apps.push(app); item.url = app.address;
    const response = await fetch(app.address + '/api/state');
    assert.equal(response.status, 200);
    writeJSON(join(lab, 'cases', item.id, 'http-state.json'), await response.json());
  }
  const connection = { lab, pid: process.pid, queueLog, watcher: false, productionStateTouched: false, servers: result.cases.filter(item => item.url).map(({ id, url, snapshotPath }) => ({ id, url, snapshotPath })), cleanup: `kill -TERM ${process.pid}` };
  writeJSON(join(lab, 'connection.json'), connection);
  console.log(JSON.stringify(connection, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await Promise.all(apps.map(app => app.close())); process.exit(0); });
} else {
  if (mode && mode !== '--prepare') throw Error('Usage: four-questions.mjs [--prepare | --launch <lab> | --serve <lab>]');
  const lab = mkdtempSync('/private/tmp/flux-four-questions-20261029-');
  writeFileSync(join(lab, '.four-questions-lab'), 'Synthetic transcript/explicit-record capture experiment. No native integration.\n');
  const baseline = join(lab, 'baseline'); mkdirSync(baseline);
  cpSync(join(repository, 'src'), join(baseline, 'src'), { recursive: true });
  cpSync(join(repository, 'public'), join(baseline, 'public'), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  cpSync(script, join(lab, 'four-questions.mjs'));
  const load = name => import(pathToFileURL(join(baseline, 'src', name)));
  const { createStore } = await load('store.mjs');
  const { importTranscript } = await load('transcript.mjs');
  const { buildOverview } = await load('overview.mjs');
  const message = (role, text, at) => ({ timestamp: stamp(at), type: 'response_item', payload: { type: 'message', role, ...(role === 'assistant' ? { channel: 'commentary' } : {}), content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
  const tool = (questionBatch, index) => [
    { timestamp: stamp(index + 2), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: `synthetic-input-${index}`, arguments: JSON.stringify({ questions: questionBatch.map((question, offset) => ({ id: `synthetic-question-${index}-${offset}`, header: 'Demo choice', question, options: [{ label: 'Synthetic option A', description: 'Fixture choice only.' }, { label: 'Synthetic option B', description: 'Fixture choice only.' }] })) }) } },
    { timestamp: stamp(index + 3), type: 'response_item', payload: { type: 'function_call_output', call_id: `synthetic-input-${index}`, output: JSON.stringify({ fixture: 'response stub only; no native user interaction', answers: {} }) } },
  ];
  const variants = [
    { id: 'four-separate-messages', type: 'plain-transcript', rows: questions.map((question, index) => message('assistant', question, index + 2)), expectedMessages: 4, expectedTools: 0, expectedPending: 0 },
    { id: 'one-numbered-message', type: 'plain-transcript', rows: [message('assistant', questions.map((question, index) => `${index + 1}. ${question}`).join('\n'), 2)], expectedMessages: 1, expectedTools: 0, expectedPending: 0 },
    { id: 'four-async-tool-calls', type: 'tool-lifecycle-fixture', rows: questions.flatMap((question, index) => tool([question], index * 2)), expectedMessages: 0, expectedTools: 8, expectedPending: 0 },
    { id: 'four-explicit-waiting-items', type: 'explicit-semantic-records', rows: questions.map((question, index) => message('assistant', question, index + 2)), explicit: true, expectedMessages: 4, expectedTools: 0, expectedPending: 4 },
    { id: 'explicit-items-normal-user-answer', type: 'explicit-semantic-records-plus-answer', rows: questions.map((question, index) => message('assistant', question, index + 2)), explicit: true, answer: true, expectedMessages: 4, expectedTools: 0, expectedPending: 4 },
    { id: 'explicit-items-wrapped-user-reply', type: 'filtered-reply-wrapper', rows: questions.map((question, index) => message('assistant', question, index + 2)), explicit: true, answer: true, wrapped: true, expectedMessages: 4, expectedTools: 0, expectedPending: 4 },
    { id: 'explicit-terminal-statuses', type: 'terminal-status-filter-probe', rows: questions.map((question, index) => message('assistant', question, index + 2)), explicit: true, terminal: true, expectedMessages: 4, expectedTools: 0, expectedPending: 4 },
    { id: 'explicit-items-one-completed', type: 'explicit-status-update', rows: questions.map((question, index) => message('assistant', question, index + 2)), explicit: true, answer: true, complete: true, expectedMessages: 4, expectedTools: 0, expectedPending: 3 },
  ];
  const cases = [];
  for (const variant of variants) {
    const directory = join(lab, 'cases', variant.id); mkdirSync(directory, { recursive: true });
    const dataDir = join(directory, 'data'), transcriptPath = join(directory, 'synthetic-transcript.jsonl'), sessionId = `synthetic-${variant.id}`;
    const store = createStore(dataDir);
    store.setProject({ id: variant.id, title: `Four questions · ${variant.id}`, goal: 'Inspect how four synthetic Codex questions appear in Flux', directory, sessionId, sessions: [{ id: sessionId, title: 'Synthetic four-question fixture' }], focus: { title: 'Inspect synthetic questions and explicit decision records', status: 'in_progress', sessionId, intentSourceId: `transcript:${sessionId}:2`, sourceIds: [`transcript:${sessionId}:2`], updatedAt: stamp(1), why: { text: 'Reproduce existing capture and display behavior without live sends.' }, next: { text: 'Inspect Overview, Timeline and item evidence in this isolated fixture.', status: 'planned' } }, items: [], plans: [], decisions: [], constraints: [] });
    const records = [{ timestamp: stamp(0), type: 'session_meta', payload: { id: sessionId } }, message('user', 'Prepare a synthetic demo. Ask me the four demo choices.', 1), ...variant.rows];
    writeFileSync(transcriptPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const capture = importTranscript(store, transcriptPath, { sessionId });
    if (variant.explicit) {
      const sources = store.events().filter(event => event.kind === 'message.assistant');
      questions.forEach((question, index) => store.append({ id: `explicit-question-${index}`, at: stamp(12 + index), sessionId, kind: 'item_updated', provenance: 'agent_report', data: { item: { id: `demo-question-${index}`, title: question, status: 'waiting', requiresUserDecision: true, sessionId, sourceIds: [sources[index].id], returnCondition: 'An explicit answer is recorded and this work item is updated.' } } }));
    }
    let answerCapture;
    if (variant.answer) {
      appendFileSync(transcriptPath, JSON.stringify(message('user', variant.wrapped ? '<send_user_message_question_reply>Synthetic answers: developers; laptop; sample project Alpha; Light.</send_user_message_question_reply>' : 'Synthetic answers: developers; laptop; sample project Alpha; Light.', 20)) + '\n');
      answerCapture = importTranscript(store, transcriptPath, { sessionId });
    }
    if (variant.terminal) ['done', 'cancelled', 'superseded'].forEach((status, index) => store.append({ id: `explicit-terminal-${index}`, at: stamp(21 + index), sessionId, kind: 'item_updated', provenance: 'agent_report', data: { item: { id: `demo-question-${index}`, status } } }));
    if (variant.complete) store.append({ id: 'explicit-completion', at: stamp(21), sessionId, kind: 'item_updated', provenance: 'agent_report', data: { item: { id: 'demo-question-0', status: 'completed' } } });
    const raw = store.snapshot(), overview = buildOverview(raw), snapshot = { ...raw, overview };
    const assistant = raw.events.filter(event => event.kind === 'message.assistant'), tools = raw.events.filter(event => event.kind.startsWith('tool.'));
    const pending = overview.workItems.filter(item => item.requiresUserDecision === true && item.status !== 'completed');
    const presentQuestions = questions.filter(question => assistant.some(event => event.text?.includes(question)));
    assert.equal(assistant.length, variant.expectedMessages, variant.id);
    assert.equal(tools.length, variant.expectedTools, variant.id);
    assert.equal(pending.length, variant.expectedPending, variant.id);
    assert.equal(raw.events.filter(event => event.kind === 'message.user').length - 1, variant.answer && !variant.wrapped ? 1 : 0, 'Only ordinary public answer text is retained.');
    assert.equal(raw.requests.length, 0, 'Codex-to-user questions must not be conflated with Ask Codex requests.');
    if (tools.length) assert(tools.every(event => !('arguments' in event.data) && !('output' in event.data) && !event.text));
    const snapshotPath = join(directory, 'snapshot.json'); writeJSON(snapshotPath, snapshot);
    const item = { id: variant.id, type: variant.type, outcome: variant.terminal ? 'terminal-status-pending-gap-reproduced' : variant.wrapped ? 'wrapped-reply-filtering-observed' : variant.explicit ? 'explicit-record-behavior-observed' : 'question-inbox-gap-reproduced', transcriptPath, snapshotPath, capture, answerCapture, observed: { capturedUserReplyMessages: raw.events.filter(event => event.kind === 'message.user').length - 1, decisionsTabRecords: overview.history.decisions.length, assistantMessages: assistant.length, questionsRetainedInPublicMessageBodies: presentQuestions.length, toolLifecycleEvents: tools.length, pendingDecisionItems: pending.length, overviewDecisionRowsFromCurrentSlice: Math.min(pending.length, 3), askCodexRequests: raw.requests.length, projectDecisionRecords: raw.project.decisions.length, nativeHooksActive: raw.coverage.nativeHooksActive }, pendingItemIds: pending.map(item => item.id), capturedToolData: tools.map(event => event.data) };
    writeJSON(join(directory, 'observations.json'), item); cases.push(item);
  }
  const result = { lab, createdAt: new Date().toISOString(), questions, scope: 'Synthetic frozen-source transcript capture and explicit semantic-record projection only. No model calls, native tool invocation, native user input, chat send, current-chat enrollment, transcript watcher, or production .flux writes.', interpretation: 'Plain messages are captured but do not become pending decisions. Async tool fixtures retain lifecycle metadata and discard argument/output bodies. Four explicit waiting items project four pending items; a normal user answer does not resolve them automatically. Overview currently renders only its first three decision rows. The Decisions tab uses separate decision records. A wrapped send_user_message_question_reply is filtered out; done/cancelled/superseded items with requiresUserDecision still count in the current pending filter.', limitations: ['Four separate async calls are serialized transcript fixtures, not actual native tool invocations or a live integration test.', 'Server queueCommand rejects every attempted send and records attempts in blocked-sends.jsonl.', 'Expected-observation assertions reproduce existing behavior; they are not product acceptance for a question inbox.'], sourceHashes: Object.fromEntries(['transcript.mjs', 'store.mjs', 'overview.mjs', 'server.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(baseline, 'src', file))).digest('hex')])), cases };
  writeJSON(join(lab, 'results.json'), result);
  console.log(JSON.stringify({ lab, results: join(lab, 'results.json'), cases: cases.map(({ id, outcome, observed }) => ({ id, outcome, observed })), launch: `node ${join(lab, 'four-questions.mjs')} --launch ${lab}` }, null, 2));
}
