// This is a codex-exec TEST ADAPTER experiment, not production codex queue.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeLab, assertLab, seed } from './fixtures.mjs';
import { infer, WRAPPER } from './model-runner.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const requireTrue = (condition, message) => { if (!condition) throw Error(message); };
const delay = ms => new Promise(done => setTimeout(done, ms));

async function main() {
  const index = process.argv.indexOf('--lab');
  if (index < 0 || !process.argv[index + 1]) throw Error('Usage: node scripts/harness/real-roundtrip.mjs --lab /private/tmp/SEALED_LAB');
  const lab = assertLab(process.argv[index + 1]);
  const out = initializeLab(join(lab, 'real-roundtrip'));
  const dataDir = join(out, '.flux');
  const results = {
    version: 1, experiment: 'isolated-real-model-http-roundtrip-via-codex-exec-test-adapter',
    scoredBenchmark: false, nativeCodexQueueIntegration: false,
    limitation: 'Production HTTP preparation/dispatch, request projection, result projection, SSE and persistence are exercised. queueCommand is an injected codex-exec test adapter, not production codex queue. The host adapter validates and records the model answer; the model performs no recording or product edits. Review-feedback completion is outside this diagnostic-only experiment.',
    startedAt: new Date().toISOString(), requestedPort: 0, expectedSyntheticSession: 'synthetic-chat',
    adapterSourceSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    fixtureSourceSha256: hash(await readFile(fileURLToPath(new URL('./fixtures.mjs', import.meta.url)))),
    runnerSha256: hash(await readFile(fileURLToPath(new URL('./model-runner.mjs', import.meta.url)))),
    baselineModuleHashes: {}, http: [], sseRevisions: [], inferenceCalls: 0, adapterDeliveries: 0,
    checks: {}, status: 'in-progress',
  };
  const save = () => writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  let app, restartedApp, sseController, sseTask, modelTask;
  try {
    const baseline = join(lab, 'baseline');
    const manifest = JSON.parse(await readFile(join(lab, 'baseline.json'), 'utf8'));
    for (const file of ['src/store.mjs','src/diagnostics.mjs','src/context.mjs','src/server.mjs','src/overview.mjs','src/reviews.mjs','src/review-feedback.mjs','src/content-links.mjs','src/markdown.mjs']) {
      const actual = hash(await readFile(join(baseline, file)));
      requireTrue(actual === manifest.manifest.find(item => item.path === file)?.sha256, 'Frozen production module manifest mismatch');
      results.baselineModuleHashes[file] = actual;
    }
    const load = file => import(pathToFileURL(join(baseline, 'src', file)).href);
    const { createStore } = await load('store.mjs');
    const { validateDiagnosticResult } = await load('diagnostics.mjs');
    const { startServer } = await load('server.mjs');
    const store = createStore(dataDir); seed(store, out);
    const expectedSeed = store.snapshot();
    requireTrue(expectedSeed.project.sessionId === 'synthetic-chat' && expectedSeed.project.directory === out, 'Synthetic-only fixture boundary failed');
    let frozenPrompt, requestId;

    // Deliberately acknowledge delivery immediately, independently of inference.
    // There is no production queue invocation or access to a real enrolled chat.
    const codexExecTestAdapter = async delivery => {
      results.adapterDeliveries++;
      requireTrue(delivery.sessionId === 'synthetic-chat', 'Adapter refused a non-synthetic session');
      requireTrue(results.adapterDeliveries === 1, 'Adapter refused duplicate inference');
      requireTrue(delivery.requestId === requestId && delivery.prompt === frozenPrompt, 'Prepared request or frozen prompt changed at delivery');
      results.adapterReceived = { sessionId: delivery.sessionId, requestId: delivery.requestId, promptSha256: hash(delivery.prompt) };
      modelTask = (async () => {
        results.inferenceCalls++;
        results.model = await infer({ id: 'integration-sol-low', model: 'gpt-6.1-sol', effort: 'low' }, WRAPPER + delivery.prompt, { timeoutMs: 110000 });
        requireTrue(results.model.status === 'completed', 'Real inference did not complete cleanly');
        requireTrue(!results.model.toolActions.length && !results.model.unsupportedActions.length, 'Model attempted a forbidden action');
        const answer = validateDiagnosticResult(results.model.answer);
        results.answer = answer;
        results.answerWords = answer.split(/\s+/u).length;
        results.resultRecordedBy = 'host codex-exec test adapter';
        const event = store.append({
          kind: 'diagnostic_result', sessionId: 'synthetic-chat', actor: 'Codex-exec test adapter',
          summary: 'Test adapter recorded a real public model answer', text: answer,
          provenance: 'agent_report', source: { type: 'diagnostic', ref: delivery.requestId },
          data: { requestId: delivery.requestId, result: answer },
        });
        results.recordedEvent = { id: event.id, kind: event.kind, requestId: event.data.requestId, resultSha256: hash(event.data.result) };
        results.completionRevision = store.snapshot().revision;
      })().catch(error => { results.adapterFailure = error.message; });
      return { acknowledged: true, adapter: 'codex-exec-test-adapter' };
    };
    app = await startServer({ dataDir, store, port: 0, watch: false, publicDir: join(baseline, 'public'), queueCommand: codexExecTestAdapter });
    results.firstAddress = app.address;
    requireTrue(new URL(app.address).port !== '7391', 'Refused live product port');
    const state = await fetch(app.address + '/api/state').then(response => response.json());
    const input = { question: 'What is the current state, observed evidence, and next step? Answer within 200 words.', recordIds: ['focus','plan','check'], expectedRevision: state.contextRevision };
    const post = async (label, body) => {
      const response = await fetch(app.address + '/api/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flux-csrf': state.csrfToken }, body: JSON.stringify(body) });
      const payload = await response.json();
      results.http.push({ label, httpStatus: response.status, requestId: payload.id, status: payload.status, revision: payload.revision });
      requireTrue(response.status === 200, 'Diagnostic HTTP request failed');
      return payload;
    };
    sseController = new AbortController();
    const stream = await fetch(app.address + '/api/events', { signal: sseController.signal });
    requireTrue(stream.status === 200 && stream.headers.get('content-type')?.includes('text/event-stream'), 'SSE subscription failed');
    sseTask = (async () => {
      let pending = '';
      try {
        for await (const chunk of stream.body) {
          pending += Buffer.from(chunk).toString('utf8');
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const event = pending.slice(0,end); pending = pending.slice(end+2);
            const line = event.split('\n').find(value => value.startsWith('data: '));
            if (line) {
              const revision = JSON.parse(line.slice(6)).revision;
              if (typeof revision === 'number') results.sseRevisions.push(revision);
            }
          }
        }
      } catch (error) { if (error.name !== 'AbortError') results.sseFailure = 'SSE stream failed'; }
    })();
    const prepared = await post('prepare', input);
    frozenPrompt = prepared.prompt; requestId = prepared.id;
    results.prepared = { requestId, status: prepared.status, prompt: frozenPrompt, promptSha256: hash(frozenPrompt), requestSha256: hash(JSON.stringify(prepared)), contextManifest: prepared.contextManifest };
    results.submittedPromptSha256 = hash(WRAPPER + frozenPrompt);
    requireTrue(prepared.status === 'prepared', 'HTTP preview did not prepare request');
    const dispatch = { ...input, requestId, dispatch: true };
    const sent = await post('send', dispatch);
    const duplicate = await post('send-same-id-again', dispatch);
    const queuedState = await fetch(app.address + '/api/state').then(response => response.json());
    const queued = queuedState.requests.find(item => item.id === requestId);
    results.queued = { requestId: queued?.id, status: queued?.status, revision: queuedState.revision };
    requireTrue(sent.status === 'queued' && duplicate.status === 'queued' && queued?.status === 'queued', 'Queued state was not observed through HTTP');
    requireTrue(modelTask, 'Adapter did not start inference');
    await modelTask;
    requireTrue(!results.adapterFailure, 'Test adapter model/result operation failed');
    const completedState = await fetch(app.address + '/api/state').then(response => response.json());
    const completed = completedState.requests.find(item => item.id === requestId);
    results.completed = { requestId: completed?.id, status: completed?.status, resultSha256: hash(completed?.result || ''), resultSourceId: completed?.resultSourceId, revision: completedState.revision };
    requireTrue(completed?.status === 'completed' && completed.result === results.answer, 'HTTP did not expose the same-ID real result');
    for (let i = 0; i < 100 && !results.sseRevisions.includes(results.completionRevision); i++) await delay(25);
    results.checks.sseCompletionRevision = results.sseRevisions.includes(results.completionRevision);
    sseController.abort(); await sseTask;
    await app.close(); app = null;
    const restartedStore = createStore(dataDir);
    restartedApp = await startServer({ dataDir, store: restartedStore, port: 0, watch: false, publicDir: join(baseline, 'public'), queueCommand: async () => { throw Error('No dispatch is allowed after restart'); } });
    results.restartAddress = restartedApp.address;
    requireTrue(new URL(restartedApp.address).port !== '7391', 'Refused live product port after restart');
    const restartState = await fetch(restartedApp.address + '/api/state').then(response => response.json());
    const persisted = restartState.requests.find(item => item.id === requestId);
    const resultEvents = restartState.events.filter(event => event.kind === 'diagnostic_result' && event.data.requestId === requestId);
    results.restarted = { requestId: persisted?.id, status: persisted?.status, resultSha256: hash(persisted?.result || ''), matchingResultEvents: resultEvents.length, resultSourceId: persisted?.resultSourceId };
    Object.assign(results.checks, {
      preparedThenQueuedThenCompleted: results.prepared.status === 'prepared' && results.queued.status === 'queued' && completed.status === 'completed',
      duplicateSendOneDelivery: results.adapterDeliveries === 1,
      exactlyOneInference: results.inferenceCalls === 1,
      exactFrozenPrompt: results.adapterReceived.promptSha256 === results.prepared.promptSha256,
      exactSameRequestId: [sent.id, duplicate.id, queued.id, completed.id, persisted?.id, results.recordedEvent.requestId].every(id => id === requestId),
      answerWithin200Words: results.answerWords <= 200,
      restartPersistence: persisted?.status === 'completed' && persisted.result === results.answer && resultEvents.length === 1,
      syntheticSessionOnly: restartState.project.sessionId === 'synthetic-chat' && restartState.project.directory === out,
      unchangedRunner: results.runnerSha256 === hash(await readFile(fileURLToPath(new URL('./model-runner.mjs', import.meta.url)))),
      unchangedAdapter: results.adapterSourceSha256 === hash(await readFile(fileURLToPath(import.meta.url))),
    });
    requireTrue(Object.values(results.checks).every(Boolean), 'One or more roundtrip checks failed');
    results.status = 'passed';
  } catch (error) {
    results.status = 'failed'; results.failure = error.message;
  } finally {
    if (modelTask) await modelTask;
    sseController?.abort(); if (sseTask) await sseTask;
    if (app) await app.close(); if (restartedApp) await restartedApp.close();
    results.finishedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ out, status: results.status, requestId: results.prepared?.requestId, inferenceCalls: results.inferenceCalls, checks: results.checks, failure: results.failure }));
  if (results.status !== 'passed') process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
