import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
async function load(file) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
}
const ui = await load('../ui/src/lib/answer-submissions.ts');
const api = await load('../ui/src/lib/api.ts');
const scope = { projectId: 'project', sessionId: 'chat' };
const submission = (patch = {}) => ({ id: 'submission', ...scope, status: 'prepared', answers: [{ questionId: 'q1', questionText: 'Audience?', questionFingerprint: '["q1","Audience?",[]]', answer: '  Developers\n' }], prompt: 'Exact frozen message', payloadHash: 'hash', contextRevision: 'reviewed-context', ...patch });
const snapshot = (patch = {}) => ({ project: { id: 'project', sessionId: 'chat' }, answerTransport: { mode: 'chat_message', available: true, nativeWidgetSync: false }, ...patch });

test('transport gating distinguishes message sending from old-server capture and native widget sync', () => {
  assert.equal(ui.answerTransportAvailable(snapshot()), true);
  for (const answerTransport of [undefined, { mode: 'chat_message', available: false, nativeWidgetSync: false }, { mode: 'other', available: true, nativeWidgetSync: false }, { mode: 'chat_message', available: true, nativeWidgetSync: true }]) assert.equal(ui.answerTransportAvailable(snapshot({ answerTransport })), false);
});

test('server sending, queued and uncertain attempts hold answers across reload while received releases them', () => {
  for (const status of ['sending', 'queued', 'delivery_unconfirmed']) {
    const current = snapshot({ answerSubmissions: [submission({ status })] });
    const merged = ui.mergeAnswerSubmissions(current, []);
    assert.equal(ui.answerHolds(current, merged).get('q1').status, status);
  }
  const received = snapshot({ answerSubmissions: [submission({ status: 'received' })] });
  assert.equal(ui.answerHolds(received, ui.mergeAnswerSubmissions(received, [])).size, 0);
});

test('receipt merging preserves latest status and excludes a different project/chat', () => {
  const current = snapshot({ answerSubmissions: [submission({ status: 'prepared' }), submission({ id: 'foreign', projectId: 'other', status: 'queued' })] });
  assert.equal(ui.mergeAnswerSubmissions(current, [submission({ status: 'sending' })])[0].status, 'sending');
  current.answerSubmissions = [submission({ status: 'received' })];
  assert.equal(ui.mergeAnswerSubmissions(current, [submission({ status: 'delivery_unconfirmed' })])[0].status, 'received');
  assert.equal(ui.mergeAnswerSubmissions(current, [submission({ sessionId: 'other', id: 'other' })]).length, 1);
  assert.equal(ui.answerSubmissionLabel(submission({ status: 'received', outcomes: [{ questionId: 'q1', status: 'reply_recorded' }] })), 'Reply recorded from chat');
  assert.equal(ui.answerSubmissionLabel(submission({ status: 'received', outcomes: [{ questionId: 'q1', status: 'conflict' }] })), 'Message captured');
});

test('prepared preview identity and async ownership preserve newer draft bytes and scope changes', () => {
  const draft = { questionId: 'q1', questionText: 'Audience?', options: [], answer: '  Developers\n' };
  assert.equal(ui.sameSubmissionAnswers(submission(), [draft]), true);
  assert.equal(ui.sameSubmissionAnswers(submission(), [{ ...draft, answer: 'Developers' }]), false);
  const owner = { key: 'scope-A', epoch: 1 };
  assert.equal(ui.sameAnswerOwner(owner, { key: 'scope-B', epoch: 2 }), false);
  assert.equal(ui.sameAnswerOwner(owner, { key: 'scope-A', epoch: 3 }), false, 'Returning to a scope does not activate an earlier async preview.');
  assert.equal(ui.sameAnswerOwner(owner, { key: 'scope-A', epoch: 1 }), true);
});

test('prepare never dispatches; final send uses the same immutable ID and reviewed bytes despite later context', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => submission() }; };
  try {
    const current = { csrfToken: 'synthetic', contextRevision: 'current-context' };
    await api.prepareAnswers(current, [{ questionId: 'q1', answer: '  Developers\n' }]);
    assert.deepEqual(calls[0], { path: '/api/answers', body: { answers: [{ questionId: 'q1', answer: '  Developers\n' }], expectedRevision: 'current-context', dispatch: false } });
    await api.sendAnswers({ ...current, contextRevision: 'later-context' }, submission());
    assert.deepEqual(calls[1].body, { requestId: 'submission', answers: [{ questionId: 'q1', answer: '  Developers\n' }], expectedRevision: 'reviewed-context', dispatch: true });
  } finally { globalThis.fetch = original; }
});
