import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A synthetic queue spy, not a Codex/native transport. The production receipt
// adapter still validates exact captured message bytes before projecting replies.
const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), '../..');
const marker = '.answer-submissions-lab';
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJSON = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function validate(directory) {
  const lab = realpathSync(directory);
  if (!lab.startsWith('/private/tmp/flux-incoming-questions-') || !existsSync(join(lab, marker))) throw Error('Expected a marked synthetic answer-submissions fixture.');
  return lab;
}
async function load(lab) {
  const fixture = readJSON(join(lab, 'fixture.json'));
  const [{ createStore }, { importTranscript }, { buildOverview }] = await Promise.all(['store.mjs', 'transcript.mjs', 'overview.mjs'].map(file => import(pathToFileURL(join(lab, 'baseline/src', file)))));
  return { fixture, store: createStore(fixture.dataDir), importTranscript, buildOverview };
}
function evidence(lab, stage, store, buildOverview) {
  const snapshot = store.snapshot();
  const counts = { pending: snapshot.incomingQuestions.pending.length, history: snapshot.incomingQuestions.history.length, holds: snapshot.answerHolds.length, submissions: snapshot.answerSubmissions.length, outboundDiagnostics: snapshot.requests.length };
  const state = { stage, counts, submissions: snapshot.answerSubmissions.map(value => ({ id: value.id, status: value.status, answerCount: value.answers.length, payloadHash: value.payloadHash, receiptSourceId: value.receiptSourceId, outcomes: value.outcomes })), snapshot: { ...snapshot, overview: buildOverview(snapshot) } };
  writeJSON(join(lab, 'evidence', `${stage}.json`), state);
  return { counts, submissions: state.submissions, evidencePath: join(lab, 'evidence', `${stage}.json`) };
}
const [mode, directory, argument] = process.argv.slice(2);
if (mode === '--prepare') {
  const result = spawnSync(process.execPath, [join(repository, 'scripts/harness/incoming-questions.mjs'), '--prepare'], { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Fixture preparation failed.');
  const { lab } = JSON.parse(result.stdout);
  writeFileSync(join(lab, marker), 'Synthetic answer message queue/capture fixture v1\n');
  cpSync(script, join(lab, 'answer-submissions.mjs'));
  writeJSON(join(lab, 'queue-mode.json'), { mode: 'accept' });
  const { fixture, store, buildOverview } = await load(lab);
  store.setProject({ ...store.snapshot().project, title: 'Synthetic · Send answer messages', goal: 'Review and send synthetic answer messages through an isolated queue spy' });
  assert.equal(store.snapshot().incomingQuestions.pending.length, 4);
  assert.deepEqual(store.snapshot().answerTransport, { mode: 'chat_message', available: true, nativeWidgetSync: false });
  const html = readFileSync(join(lab, 'baseline/public/build/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/(build\/assets\/(?:index-[^"/]+\.(?:js|css)))"/g)].map(match => match[1]);
  const manifest = { lab, synthetic: true, nativeCalls: 0, transcriptWatcher: false, queue: 'Injected spy records exact requests and accepts by default; --mode fail rejects without contacting Codex.', projectId: fixture.projectId, sessionId: fixture.sessionId, sourceHashes: { ...fixture.sourceHashes, 'answer-submissions.mjs': sha(readFileSync(join(lab, 'baseline/src/answer-submissions.mjs'))) }, uiSourceHashes: Object.fromEntries(['ui/src/components/IncomingQuestions.tsx','ui/src/components/AnswerSubmissionDialog.tsx','ui/src/lib/answer-submissions.ts','ui/src/lib/api.ts','ui/src/lib/types.ts','ui/src/lib/use-answer-drafts.ts','ui/src/lib/answer-drafts.ts','ui/src/views/Overview.tsx','ui/src/shell/FluxApp.tsx','ui/src/styles.css'].map(file => [file, sha(readFileSync(join(repository, file)))])), assets: assets.map(path => ({ path, SHA256: sha(readFileSync(join(lab, 'baseline/public', path))), matchesCurrentBuild: sha(readFileSync(join(lab, 'baseline/public', path))) === sha(readFileSync(join(repository, 'public', path))) })) };
  writeJSON(join(lab, 'answer-submissions-manifest.json'), manifest);
  console.log(JSON.stringify({ lab, ...evidence(lab, 'answer-messages-initial', store, buildOverview), manifest: join(lab, 'answer-submissions-manifest.json'), launch: `node ${join(lab, 'answer-submissions.mjs')} --launch ${lab}`, capture: `node ${join(lab, 'answer-submissions.mjs')} --capture ${lab} SUBMISSION_ID`, fail: `node ${join(lab, 'answer-submissions.mjs')} --mode ${lab} fail`, state: `node ${join(lab, 'answer-submissions.mjs')} --state ${lab}` }, null, 2));
} else if (mode === '--launch') {
  const lab = validate(directory);
  const child = spawn(process.execPath, [join(lab, 'answer-submissions.mjs'), '--serve', lab], { cwd: lab, detached: true, stdio: ['ignore', openSync(join(lab, 'server.log'), 'a'), openSync(join(lab, 'server-error.log'), 'a')] });
  child.unref();
  const processInfo = { lab, pid: child.pid, cleanup: `kill -TERM ${child.pid}` };
  writeJSON(join(lab, 'process.json'), processInfo); console.log(JSON.stringify(processInfo));
} else if (mode === '--serve') {
  const lab = validate(directory), { fixture, store } = await load(lab);
  const { startServer } = await import(pathToFileURL(join(lab, 'baseline/src/server.mjs')));
  const queueCalls = join(lab, 'queue-calls.jsonl');
  const queueCommand = async request => {
    assert.equal(request.sessionId, fixture.sessionId, 'The spy accepts only its exact synthetic chat.');
    const control = readJSON(join(lab, 'queue-mode.json'));
    appendFileSync(queueCalls, JSON.stringify({ at: new Date().toISOString(), mode: control.mode, promptSHA256: sha(request.prompt), ...request }) + '\n');
    if (control.mode === 'fail') throw Error('Synthetic queue failure; no native call was made.');
  };
  const app = await startServer({ dataDir: fixture.dataDir, store, port: 0, watch: true, publicDir: join(lab, 'baseline/public'), queueCommand, contentOptions: { reveal: async () => { throw Error('Native reveal is disabled in this fixture.'); } } });
  const response = await fetch(app.address + '/api/state'); assert.equal(response.status, 200);
  writeJSON(join(lab, 'evidence/answer-messages-initial-http.json'), await response.json());
  const connection = { lab, pid: process.pid, url: app.address, queueCalls, queueMode: join(lab, 'queue-mode.json'), nativeCalls: 0, transcriptWatcher: false, journalRefreshWatcher: true, cleanup: `kill -TERM ${process.pid}` };
  writeJSON(join(lab, 'connection.json'), connection); console.log(JSON.stringify(connection, null, 2));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
} else if (mode === '--mode') {
  const lab = validate(directory); assert(['accept','fail'].includes(argument), 'Mode must be accept or fail.');
  writeJSON(join(lab, 'queue-mode.json'), { mode: argument }); console.log(JSON.stringify({ lab, mode: argument, nativeCalls: 0 }));
} else if (mode === '--capture') {
  const lab = validate(directory), { fixture, store, importTranscript, buildOverview } = await load(lab);
  const submission = store.snapshot().answerSubmissions.find(value => value.id === argument);
  assert(submission && submission.projectId === fixture.projectId && submission.sessionId === fixture.sessionId, 'Choose a submission in this exact synthetic fixture.');
  assert(['sending','queued','delivery_unconfirmed','received'].includes(submission.status), 'A merely prepared answer cannot be captured as delivered.');
  const existing = store.snapshot().events.find(event => event.kind === 'message.user' && event.sessionId === fixture.sessionId && event.text === submission.prompt);
  if (!existing) appendFileSync(fixture.transcriptPath, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', session_id: fixture.sessionId, content: [{ type: 'input_text', text: submission.prompt }] } }) + '\n');
  importTranscript(store, fixture.transcriptPath, { sessionId: fixture.sessionId });
  const received = store.snapshot().answerSubmissions.find(value => value.id === submission.id);
  assert.equal(received.status, 'received');
  const source = store.snapshot().events.find(event => event.id === received.receiptSourceId);
  assert.equal(source.text, submission.prompt, 'Only exact captured public message bytes produce this receipt.');
  console.log(JSON.stringify({ lab, requestId: received.id, receiptSourceId: received.receiptSourceId, outcomes: received.outcomes, ...evidence(lab, `answer-message-captured-${received.id}`, store, buildOverview), nativeCalls: 0 }, null, 2));
} else if (mode === '--state') {
  const lab = validate(directory), { store, buildOverview } = await load(lab);
  console.log(JSON.stringify({ lab, ...evidence(lab, 'answer-messages-current', store, buildOverview) }, null, 2));
} else throw Error('Usage: answer-submissions.mjs --prepare | --launch <lab> | --serve <lab> | --mode <lab> accept|fail | --capture <lab> <submission-id> | --state <lab>');
