import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Synthetic browser fixture only. Every mutation is confined to its marked lab.
// Native input tools and queue transport are never invoked by this harness.
const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '../..');
const marker = '.incoming-questions-lab';
const stamp = index => new Date(Date.UTC(2026, 9, 29, 18, 0, index)).toISOString();
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const tuple = (callId, index) => JSON.stringify(['request_user_input_async', callId, index]);
const message = (text, index) => ({ timestamp: stamp(index), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
function validate(directory) {
  const lab = realpathSync(directory);
  if (!lab.startsWith('/private/tmp/flux-incoming-questions-') || !existsSync(join(lab, marker))) throw Error('Expected a marked incoming-question fixture beneath /private/tmp.');
  return lab;
}
async function modules(lab) {
  const load = file => import(pathToFileURL(join(lab, 'baseline/src', file)));
  const [{ createStore }, { importTranscript }, { buildOverview }] = await Promise.all([load('store.mjs'), load('transcript.mjs'), load('overview.mjs')]);
  const fixture = readJSON(join(lab, 'fixture.json'));
  return { fixture, store: createStore(fixture.dataDir), importTranscript, buildOverview };
}
function saveStage(lab, stage, store, buildOverview, details = {}) {
  const snapshot = store.snapshot();
  const counts = { pending: snapshot.incomingQuestions.pending.length, history: snapshot.incomingQuestions.history.length, replied: snapshot.incomingQuestions.history.filter(question => question.status === 'replied').length, outboundRequests: snapshot.requests.length };
  const path = join(lab, 'evidence', `${stage}.json`);
  writeJSON(path, { stage, counts, details, snapshot: { ...snapshot, overview: buildOverview(snapshot) } });
  const resultsPath = join(lab, 'results.json');
  const results = existsSync(resultsPath) ? readJSON(resultsPath) : { scope: 'Synthetic serialized transcript capture through frozen production adapter and local UI. This is not native integration, a live user response, work completion, or a model run.', stages: [] };
  results.stages = [...results.stages.filter(item => item.stage !== stage), { stage, counts, path, details }];
  writeJSON(resultsPath, results);
  return { counts, path };
}
function appendReplies(fixture, replies, index) {
  appendFileSync(fixture.transcriptPath, JSON.stringify(message(`<send_user_message_question_reply>${JSON.stringify(replies)}</send_user_message_question_reply>`, index)) + '\n');
}

const [mode, inputDirectory] = process.argv.slice(2);
if (mode === '--prepare') {
  const lab = mkdtempSync('/private/tmp/flux-incoming-questions-20261029-');
  writeFileSync(join(lab, marker), 'Synthetic incoming-question browser fixture v1\n');
  mkdirSync(join(lab, 'baseline'));
  mkdirSync(join(lab, 'evidence'));
  cpSync(join(repository, 'src'), join(lab, 'baseline/src'), { recursive: true });
  cpSync(join(repository, 'public'), join(lab, 'baseline/public'), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(lab, 'baseline/node_modules'), 'dir');
  cpSync(script, join(lab, 'incoming-questions.mjs'));
  const sessionId = 'synthetic-four-native-questions', projectId = 'synthetic-incoming-questions', callId = 'synthetic-demo-choice-call';
  const questions = [
    { title: 'Which audience should this demo target? [Synthetic Q1]', options: ['Developers', 'Designers'], answer: 'Developers — synthetic fixture reply.' },
    { title: 'Which device size should we prioritize? [Synthetic Q2]', options: ['Laptop', 'Phone'], answer: 'Laptop — synthetic fixture reply.' },
    { title: 'Which sample project should we use? [Synthetic Q3]', answer: 'Sample project Alpha — synthetic freeform fixture reply.' },
    { title: 'Should the demo use Light or Dark? [Synthetic Q4]', options: ['Light', 'Dark'], answer: 'Light — synthetic fixture reply.' },
  ];
  const fixture = { lab, projectId, sessionId, callId, dataDir: join(lab, 'data'), transcriptPath: join(lab, 'synthetic-transcript.jsonl'), questions: questions.map((question, index) => ({ ...question, questionItemId: tuple(callId, index) })), sourceHashes: Object.fromEntries(['transcript.mjs', 'store.mjs', 'incoming-questions.mjs', 'overview.mjs', 'server.mjs'].map(file => [file, createHash('sha256').update(readFileSync(join(lab, 'baseline/src', file))).digest('hex')])) };
  writeJSON(join(lab, 'fixture.json'), fixture);
  const { store, importTranscript, buildOverview } = await modules(lab);
  const intentSourceId = `transcript:${sessionId}:2`;
  store.setProject({ id: projectId, title: 'Synthetic · Questions for you', goal: 'Inspect four synthetic incoming questions and their recorded replies', directory: lab, sessionId, sessions: [{ id: sessionId, title: 'Synthetic question capture only' }], items: [], plans: [], decisions: [], constraints: [], focus: { title: 'Inspect the four synthetic questions below', status: 'in_progress', sessionId, intentSourceId, sourceIds: [intentSourceId], updatedAt: stamp(1), why: { text: 'Check incoming-question capture and source inspection without native interaction.' }, next: { text: 'Record a synthetic partial reply through the isolated harness.', status: 'planned' } } });
  const records = [
    { timestamp: stamp(0), type: 'session_meta', payload: { id: sessionId } },
    message(`Synthetic fixture only. Ask four demo choices in call ${callId}; identities are request_user_input_async/${callId}/0 through /3. This does not contact a real chat.`, 1),
    { timestamp: stamp(2), type: 'response_item', payload: { type: 'function_call', name: 'functions.request_user_input_async', call_id: callId, arguments: JSON.stringify({ questions: questions.map(({ title, options }) => ({ title, ...(options ? { options } : {}) })) }) } },
    { timestamp: stamp(3), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '{"fixture":"Lifecycle response stub only; no user reply or native acknowledgment."}' } },
  ];
  writeFileSync(fixture.transcriptPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const capture = importTranscript(store, fixture.transcriptPath, { sessionId });
  const current = store.snapshot();
  assert.equal(current.incomingQuestions.pending.length, 4, 'The final adapter must support four title/options questions, including optional options.');
  assert.equal(current.incomingQuestions.history.length, 0);
  for (const question of current.incomingQuestions.pending) assert(question.sourceIds.some(id => current.events.some(event => event.id === id && event.text === question.text)));
  const revision = current.revision;
  importTranscript(store, fixture.transcriptPath, { sessionId });
  assert.equal(store.snapshot().revision, revision, 'Duplicate import is idempotent.');
  const stage = saveStage(lab, '01-initial-four-pending', store, buildOverview, { capture, duplicateImportIdempotent: true });
  console.log(JSON.stringify({ lab, ...stage, launch: `node ${join(lab, 'incoming-questions.mjs')} --launch ${lab}`, replyOne: `node ${join(lab, 'incoming-questions.mjs')} --reply-one ${lab}`, replyRest: `node ${join(lab, 'incoming-questions.mjs')} --reply-rest ${lab}` }, null, 2));
} else if (mode === '--launch') {
  const lab = validate(inputDirectory);
  const child = spawn(process.execPath, [join(lab, 'incoming-questions.mjs'), '--serve', lab], { cwd: lab, detached: true, stdio: ['ignore', openSync(join(lab, 'server.log'), 'a'), openSync(join(lab, 'server-error.log'), 'a')] });
  child.unref();
  const processInfo = { lab, pid: child.pid, cleanup: `kill -TERM ${child.pid}` };
  writeJSON(join(lab, 'process.json'), processInfo);
  console.log(JSON.stringify(processInfo));
} else if (mode === '--serve') {
  const lab = validate(inputDirectory);
  const { fixture, store } = await modules(lab);
  const { startServer } = await import(pathToFileURL(join(lab, 'baseline/src/server.mjs')));
  const queueLog = join(lab, 'blocked-sends.jsonl');
  const app = await startServer({ dataDir: fixture.dataDir, store, port: 0, watch: true, publicDir: join(lab, 'baseline/public'), queueCommand: async request => { appendFileSync(queueLog, JSON.stringify({ at: new Date().toISOString(), request }) + '\n'); throw Error('Synthetic incoming-question fixture blocks every native send.'); }, contentOptions: { reveal: async () => { throw Error('Native reveal is disabled in this synthetic fixture.'); } } });
  const response = await fetch(app.address + '/api/state');
  assert.equal(response.status, 200);
  writeJSON(join(lab, 'evidence/initial-http-state.json'), await response.json());
  const connection = { lab, pid: process.pid, url: app.address, queueLog, transcriptWatcher: false, journalRefreshWatcher: true, synthetic: true, productionStateTouched: false, cleanup: `kill -TERM ${process.pid}` };
  writeJSON(join(lab, 'connection.json'), connection);
  console.log(JSON.stringify(connection, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
} else if (mode === '--reply-one' || mode === '--reply-rest') {
  const lab = validate(inputDirectory);
  const { fixture, store, importTranscript, buildOverview } = await modules(lab);
  importTranscript(store, fixture.transcriptPath, { sessionId: fixture.sessionId });
  const before = store.snapshot().incomingQuestions;
  const isFirst = mode === '--reply-one';
  const chosen = isFirst ? fixture.questions.slice(0, 1) : fixture.questions.slice(1);
  const answeredTitles = new Set(before.history.filter(question => question.status === 'replied').map(question => question.text));
  const replies = chosen.filter(question => !answeredTitles.has(question.title)).map(question => ({ questionItemId: question.questionItemId, question: question.title, answer: question.answer }));
  if (replies.length) appendReplies(fixture, replies, isFirst ? 10 : 20);
  const capture = importTranscript(store, fixture.transcriptPath, { sessionId: fixture.sessionId });
  const after = store.snapshot();
  assert.equal(after.incomingQuestions.pending.length, isFirst ? 3 : 0);
  assert.equal(after.incomingQuestions.history.length, isFirst ? 1 : 4);
  assert(after.incomingQuestions.history.every(question => question.status === 'replied'));
  const revision = after.revision;
  importTranscript(store, fixture.transcriptPath, { sessionId: fixture.sessionId });
  assert.equal(store.snapshot().revision, revision, 'Repeated import must not create another reply.');
  const stage = saveStage(lab, isFirst ? '02-one-reply-recorded' : '04-all-four-replies-recorded', store, buildOverview, { capture, duplicateImportIdempotent: true, noDecisionClosureClaimed: true });
  if (isFirst) {
    const projected = structuredClone(store.snapshot().incomingQuestions);
    appendReplies(fixture, [{ questionItemId: tuple(fixture.callId, 999), answer: 'Synthetic unmatched reply.' }, { questionItemId: fixture.questions[1].questionItemId, question: fixture.questions[1].title, answer: '' }], 11);
    importTranscript(store, fixture.transcriptPath, { sessionId: fixture.sessionId });
    assert.deepEqual(store.snapshot().incomingQuestions, projected, 'Unknown identities and empty answers leave the projected inbox unchanged.');
    saveStage(lab, '03-unknown-and-empty-replies-ignored', store, buildOverview, { incomingProjectionUnchanged: true });
  }
  console.log(JSON.stringify({ lab, ...stage, results: join(lab, 'results.json') }, null, 2));
} else {
  throw Error('Usage: incoming-questions.mjs --prepare | --launch <lab> | --serve <lab> | --reply-one <lab> | --reply-rest <lab>');
}
