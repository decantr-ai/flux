import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function loadView(path) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', target: 'es2022', format: 'cjs', jsx: 'automatic', packages: 'external' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const [{ IncomingQuestions }, { Overview }] = await Promise.all([
  loadView('../ui/src/components/IncomingQuestions.tsx'),
  loadView('../ui/src/views/Overview.tsx'),
]);
const questions = [
  'Which audience should this demo target?',
  'Which device size should we prioritize?',
  'Which sample project should we use?',
  'Should the demo use Light or Dark?',
];
const incoming = (index, patch = {}) => ({ id: `opaque-question-${index}`, projectId: 'demo', sessionId: 'demo-chat', text: questions[index], status: 'pending', origin: 'codex_tool', sourceIds: [`source-${index}`], ...patch });
const card = text => ({ text, status: 'recorded', sourceIds: [], provenance: 'agent_report' });
function snapshot(pending = [], history = []) {
  return {
    project: { id: 'demo', sessionId: 'demo-chat', items: [], plans: [] },
    incomingQuestions: { pending, history },
    events: questions.map((text, index) => ({ id: `source-${index}`, kind: 'incoming_question', text, sessionId: 'demo-chat', provenance: 'observed' })),
    requests: [],
    overview: { focus: { status: 'current' }, now: card('Current recorded work'), why: card('Recorded reason'), next: card('Next recorded step'), direction: card('Direction'), events: [], workItems: [], openWork: { active: [], parked: [], proposals: [] } },
  };
}
function render(state, view = IncomingQuestions) {
  let selected = 0;
  const html = renderToStaticMarkup(React.createElement(view, { snapshot: state, onSelect() { selected++; }, onAsk() { assert.fail('Rendering does not ask Codex.'); }, onReview() { assert.fail('Rendering does not review work.'); }, questionHistory: React.createElement('div', null, 'Outgoing question history') }));
  assert.equal(selected, 0, 'Rendering never opens evidence automatically.');
  return html;
}

test('all four incoming questions are visible with a true count and source inspection', () => {
  const pending = questions.map((_, index) => incoming(index, index === 0 ? { reason: 'Choose an appropriate demo.', options: ['Developers', 'Designers'] } : {}));
  const html = render(snapshot(pending));
  for (const question of questions) assert(html.includes(question));
  assert.equal((html.match(/data-question-status="pending"/g) || []).length, 4);
  assert(html.includes('aria-label="4 waiting"'));
  assert.equal((html.match(/>View source</g) || []).length, 4);
  assert(html.includes('0 answers ready to send'));
  assert(html.includes('Restart the Flux service and refresh to enable answer sending. Copy remains available.'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Review and send 0 answers<\/button>/);
  assert(html.indexOf('Review and send 0 answers') < html.indexOf('Questions waiting for you'));
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 2);
  assert(!html.includes('Choose an appropriate demo.'), 'A resolution reason is not presented as why a pending question was asked.');
  assert(!html.includes('Why Codex asked'));
  assert(html.includes('Developers'));
  assert(html.includes('Designers'));
  assert.equal((html.match(/<textarea\b/g) || []).length, 4, 'Only pending questions have editable local drafts.');
  assert.equal((html.match(/aria-describedby=/g) || []).length >= 4, true);
  assert(!/<form\b/.test(html), 'Rendering does not submit an answer.');
  assert(!html.includes('Open chat'));
});

test('Overview places incoming questions before Ask Codex and replaces the old flagged-work counter', () => {
  const state = snapshot(questions.map((_, index) => incoming(index)));
  state.overview.workItems = questions.map((title, index) => ({ id: `work-${index}`, title, status: 'waiting', requiresUserDecision: true }));
  const html = render(state, Overview);
  assert(html.indexOf('Current recorded work') < html.indexOf('Questions for you'));
  assert(html.indexOf('Questions for you') < html.indexOf('aria-label="Ask Codex"'));
  assert(html.indexOf('Questions for you') < html.indexOf('Outgoing question history'));
  assert(!html.includes('Decisions needed'));
  state.incomingQuestions.pending = [];
  const empty = render(state, Overview);
  assert(empty.includes('No recorded questions are waiting.'));
  assert(!empty.includes('data-question-status="pending"'), 'The UI trusts the incoming projection, not requiresUserDecision flags.');
});

test('reply and closure history keeps every record accessible while initially collapsed', () => {
  const history = [
    incoming(0, { status: 'replied', answer: 'Developers', resolutionSourceIds: ['reply-source'], resolutionProvenance: 'user' }),
    incoming(1, { status: 'resolved', resolutionNote: 'Device choice settled.', reason: 'The demo now targets laptop screens.', resolutionSourceIds: ['closure-source'], resolutionProvenance: 'agent_report' }),
    incoming(2, { status: 'cancelled' }),
    incoming(3, { status: 'superseded' }),
  ];
  const state = snapshot([], history);
  state.events.push({ id: 'reply-source', kind: 'incoming_question_reply', text: 'Developers', sessionId: 'demo-chat' }, { id: 'closure-source', kind: 'incoming_question_closed', text: 'Device choice settled.', sessionId: 'demo-chat' });
  const html = render(state);
  assert(!/<textarea\b/.test(html), 'History stays read-only.');
  assert.match(html, /<details class="incoming-question-history"><summary>/);
  for (const question of questions) assert(html.includes(question));
  for (const label of ['Reply recorded', 'Closed', 'Cancelled', 'Superseded', 'View reply source', 'View closure source']) assert(html.includes(label));
  assert(html.includes('Developers'));
  assert(html.includes('Device choice settled.'));
  assert(html.includes('Closure reason'));
  assert(html.includes('The demo now targets laptop screens.'));
  assert(html.includes('Reply evidence · You'));
  assert(html.includes('Recorded closure · Agent report'));
  assert(html.includes('A recorded reply does not mean the decision is closed.'));
  assert.equal((html.match(/data-question-status=/g) || []).length, 4);
});

test('a recorded reply remains distinct from a closed decision', () => {
  const html = render(snapshot([], [incoming(0, { status: 'replied', answer: 'Developers' })]));
  assert(html.includes('Reply recorded'));
  assert(!html.includes('>Closed<'));
  assert(html.includes('Reply or closure source is unavailable in this capture.'));
});

test('missing and foreign source records stay honest instead of opening fabricated evidence', () => {
  const state = snapshot([incoming(0), incoming(1), incoming(2)]);
  state.events = [
    { id: 'source-0', kind: 'incoming_question', text: questions[0], sessionId: 'other-chat' },
    { id: 'source-1', kind: 'incoming_question', text: questions[1], sessionId: 'demo-chat', projectId: 'other-project' },
  ];
  const html = render(state);
  assert.equal((html.match(/Original source is unavailable in this capture./g) || []).length, 3);
  assert(!html.includes('>View source<'));
});

test('older snapshots without incoming capture render the explicit empty state', () => {
  const state = snapshot();
  delete state.incomingQuestions;
  const html = render(state);
  assert(html.includes('Questions for you'));
  assert(html.includes('No recorded questions are waiting.'));
  assert(html.includes('aria-label="0 waiting"'));
});


test('legacy work-item closure reports its record provenance without implying native acknowledgment', () => {
  const html = render(snapshot([], [incoming(0, { status: 'resolved', origin: 'work_item', provenance: 'agent_report' })]));
  assert(html.includes('Recorded work status · Agent report'));
  assert(html.includes('>Closed<'));
  assert(!html.includes('Receipt acknowledged'));
});


test('answer sending requires the exact server capability and shows held delivery state after reload', () => {
  const state = snapshot([incoming(0)]);
  state.answerTransport = { mode: 'chat_message', available: true, nativeWidgetSync: false };
  state.answerSubmissions = [{ id: 'saved-send', projectId: 'demo', sessionId: 'demo-chat', status: 'queued', answers: [{ questionId: 'opaque-question-0', questionText: questions[0], questionFingerprint: 'fingerprint', answer: 'Developers' }], prompt: 'Frozen message', payloadHash: 'hash', contextRevision: 'old-context' }];
  state.answerHolds = [{ questionId: 'opaque-question-0', submissionId: 'saved-send', status: 'queued' }];
  const html = render(state);
  assert(html.includes('1 awaiting delivery'));
  assert(html.includes('Answer messages'));
  assert(html.includes('Queued'));
  assert(html.includes('This question has an answer message awaiting delivery.'));
  assert(!html.includes('Restart the Flux service'));
  assert(!html.includes('Reply recorded from chat'));
});
