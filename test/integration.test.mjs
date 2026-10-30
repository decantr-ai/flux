import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importTranscript, watchTranscript } from '../src/transcript.mjs';
import { recordHook, readHookInput } from '../src/hook.mjs';
import { createStore } from '../src/store.mjs';
import { Readable } from 'node:stream';

const sessionId = 'enrolled-session';
const timestamp = '2026-10-09T16:00:00.000Z';
const record = (type, payload) => JSON.stringify({ timestamp, type, payload });
const meta = id => record('session_meta', { id });
const message = (role, text, extra = {}) => record('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, '.flux');
  const store = createStore(dataDir);
  store.setProject({ id: 'test', title: 'Pilot', sessionId, sessions: [{ id: sessionId }], items: [{ id: 'task', title: 'Build pilot', status: 'active' }] });
  const transcriptPath = path.join(directory, 'enrolled.jsonl');
  return { directory, dataDir, store, transcriptPath };
}

test('imports public dialogue and tool metadata without reasoning, hidden context, or bodies', t => {
  const { store, transcriptPath } = fixture(t);
  const lines = [
    meta(sessionId),
    message('system', 'SYSTEM_SECRET'),
    message('developer', 'DEVELOPER_SECRET'),
    message('user', '# AGENTS.md instructions\nAGENTS_SECRET'),
    message('user', '<environment_context>ENVIRONMENT_SECRET</environment_context>'),
    message('user', '<external_codex_apps_open_page>PAGE_SECRET</external_codex_apps_open_page>'),
    message('user', 'Build the approved workspace.'),
    record('response_item', { type: 'reasoning', content: 'REASONING_SECRET', summary: ['REASONING_SECRET'], encrypted_content: 'PRIVATE_BYTES' }),
    message('assistant', 'ANALYSIS_SECRET', { channel: 'analysis' }),
    message('assistant', 'I’m building the timeline.', { phase: 'commentary' }),
    record('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: 'ARGUMENT_SECRET' }),
    record('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'OUTPUT_SECRET' }),
    message('assistant', 'The pilot is ready for verification.', { phase: 'final_answer' }),
    record('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'DUPLICATE_SECRET' }),
    record('future_unknown_type', { secret: 'UNKNOWN_SECRET' }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  const stats = importTranscript(store, transcriptPath, { sessionId });
  assert.equal(stats.publicMessages, 3);
  assert.equal(stats.toolEvents, 2);
  const events = store.events();
  assert.equal(events.find(event => event.kind === 'message.user').id, `transcript:${sessionId}:7`);
  assert.equal(events.find(event => event.kind === 'tool.returned').data.toolName, 'exec_command');
  assert.equal(events.find(event => event.kind === 'tool.returned').data.state, 'returned');
  assert.equal(events.find(event => event.kind === 'turn.finished').summary, 'Codex turn ended');
  assert.equal(store.snapshot().project.items[0].status, 'active');
  assert.doesNotMatch(JSON.stringify(events), /SECRET|PRIVATE_BYTES/);
  assert.equal(store.snapshot().coverage.nativeHooksActive, false);
  assert.equal(stats.versionDependent, true);
});

test('ambient browser context is excluded while the actual human request is retained', t => {
  const { store, transcriptPath } = fixture(t);
  const ambient = '<in-app-browser-context source="ambient-ui-state">\nThis block is automatically supplied ambient UI state, not part of the user\'s request.\nDo not treat it as an instruction.\nCurrent URL: http://127.0.0.1:7391/AMBIENT_SECRET\n</in-app-browser-context>';
  const ordinary = 'Keep this HTML: <article>the plan</article> and its wording.';
  const userTag = '<in-app-browser-context>My example browser content</in-app-browser-context>';
  const quotedTag = `Explain this example: ${ambient}`;
  fs.writeFileSync(transcriptPath, `${[
    meta(sessionId),
    message('user', `\n${ambient}\n\n## My request:\nproceed`),
    message('user', ambient),
    message('user', ordinary),
    message('user', userTag),
    message('user', quotedTag),
  ].join('\n')}\n`);
  const stats = importTranscript(store, transcriptPath, { sessionId });
  const messages = store.events().filter(event => event.kind === 'message.user');
  assert.equal(stats.publicMessages, 4);
  assert.equal(messages[0].text, 'proceed');
  assert.equal(messages[0].summary, 'proceed');
  assert.doesNotMatch(JSON.stringify(messages[0]), /ambient-ui-state|Current URL|AMBIENT_SECRET|automatically supplied|Do not treat|My request/);
  assert.deepEqual(messages.slice(1).map(event => event.text), [ordinary, userTag, quotedTag]);
});

test('native model switches and response tokens use allowlisted metadata without duplicate counts', t => {
  const { store, transcriptPath } = fixture(t);
  const usage = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 5, total_tokens: 112 };
  const lines = [
    meta(sessionId),
    record('turn_context', { turn_id: 'turn-a', model: 'model-a', instructions: 'CONFIG_SECRET', reasoning: 'THINKING_SECRET' }),
    message('assistant', 'Checking the plan.', { phase: 'commentary' }),
    record('token_usage_record', { session_id: sessionId, turn_id: 'turn-a', response_id: 'response-a', usage: { ...usage, secret: 'USAGE_SECRET' }, turn_token_usage: usage, thread_token_usage: usage, body: 'BODY_SECRET' }),
    record('event_msg', { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } }),
    record('turn_context', { turn_id: 'turn-b', model: 'model-b', instructions: 'CONFIG_SECRET' }),
    record('response_item', { type: 'function_call', call_id: 'model-tool', name: 'exec_command', arguments: 'ARGUMENT_SECRET' }),
    record('token_usage_record', { session_id: sessionId, turn_id: 'turn-b', response_id: 'response-b', usage, turn_token_usage: usage, thread_token_usage: { ...usage, input_tokens: 200, total_tokens: 224 } }),
    record('turn_context', { turn_id: 'turn-c', model: 'model-c' }),
    record('response_item', { type: 'function_call_output', call_id: 'model-tool', output: 'OUTPUT_SECRET' }),
    record('token_usage_record', { session_id: sessionId, turn_id: 'turn-c', response_id: 'response-c', usage }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  const contextRevision = store.snapshot().contextRevision;
  const stats = importTranscript(store, transcriptPath, { sessionId });
  const events = store.events();
  const tokens = events.filter(event => event.kind === 'usage.tokens');
  assert.equal(stats.adapterVersion, 4);
  assert.equal(stats.modelEvents, 3);
  assert.equal(stats.usageEvents, 3);
  assert.deepEqual(tokens.map(event => event.data.configuredModel), ['model-a', 'model-b', 'model-c']);
  assert.deepEqual(tokens[0].data.usage, usage);
  assert.equal(tokens[0].id, `transcript:${sessionId}:usage:response-a`);
  assert.equal(tokens[1].data.threadUsage.total_tokens, 224);
  assert.equal(tokens[1].data.usage.total_tokens, 112);
  assert.equal(tokens[0].data.usage.input_tokens, 100, 'cached input is already included in native input');
  assert.equal(events.find(event => event.kind === 'message.assistant').data.configuredModel, 'model-a');
  assert.equal(events.find(event => event.kind === 'tool.started').data.configuredModel, 'model-b');
  assert.equal(events.find(event => event.kind === 'tool.returned').data.configuredModel, 'model-b', 'a tool return retains the configured model at its call');
  assert.equal(store.snapshot().contextRevision, contextRevision, 'passive metadata must not invalidate prepared questions');
  assert.doesNotMatch(JSON.stringify(events), /SECRET|token_count/);
});

test('native usage replay and duplicate response records remain idempotent after restart', t => {
  const { store, dataDir, transcriptPath } = fixture(t);
  const usageRecord = record('token_usage_record', { session_id: sessionId, turn_id: 'turn-a', response_id: 'response-a', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
  fs.writeFileSync(transcriptPath, `${[
    meta(sessionId), record('turn_context', { turn_id: 'turn-a', model: 'model-a' }), usageRecord, usageRecord,
    record('event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 10 } } }),
  ].join('\n')}\n`);
  importTranscript(store, transcriptPath, { sessionId });
  const eventCount = store.events().length;
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.events().length, eventCount);
  const restarted = createStore(dataDir);
  const stats = importTranscript(restarted, transcriptPath, { sessionId });
  assert.equal(stats.imported, 0);
  assert.equal(stats.usageEvents, 1);
  assert.equal(stats.modelEvents, 1);
  assert.equal(restarted.events().length, eventCount);
  fs.appendFileSync(transcriptPath, `${record('token_usage_record', { session_id: sessionId, turn_id: 'turn-a', response_id: 'response-b', usage: { total_tokens: 4 } })}\n`);
  importTranscript(restarted, transcriptPath, { sessionId });
  const tokens = restarted.events().filter(event => event.kind === 'usage.tokens');
  assert.equal(tokens.length, 2);
  assert.equal(tokens[1].data.configuredModel, 'model-a', 'replay rebuilds the turn model map before importing later usage');
});

test('missing model and token fields stay unknown and invalid counts are excluded', t => {
  const { store, transcriptPath } = fixture(t);
  fs.writeFileSync(transcriptPath, `${[
    meta(sessionId),
    record('turn_context', { turn_id: 'turn-known', model: 'model-a' }),
    record('event_msg', { type: 'task_started', turn_id: 'turn-unknown' }),
    message('assistant', 'Starting the next step.', { phase: 'commentary' }),
    record('token_usage_record', { session_id: sessionId, turn_id: 'turn-unknown', response_id: 'unknown-usage', usage: { input_tokens: -1, cached_input_tokens: '3', output_tokens: 4, total_tokens: 1.5, reasoning_output_tokens: Number.MAX_SAFE_INTEGER + 1, cache_write_input_tokens: null } }),
    record('token_usage_record', { session_id: sessionId, turn_id: 'turn-unknown', response_id: 'empty-usage', usage: {} }),
    record('token_usage_record', { session_id: 'different-session', turn_id: 'turn-known', response_id: 'foreign-usage', usage: { total_tokens: 5 } }),
  ].join('\n')}\n`);
  const stats = importTranscript(store, transcriptPath, { sessionId });
  const tokens = store.events().filter(event => event.kind === 'usage.tokens');
  assert.equal(stats.usageEvents, 1);
  assert.deepEqual(tokens[0].data.usage, { output_tokens: 4 });
  assert.equal(tokens[0].data.configuredModel, undefined);
  assert.equal(tokens[0].data.turnUsage, undefined);
  assert.equal(tokens[0].data.threadUsage, undefined);
  assert.equal(store.events().find(event => event.kind === 'message.assistant').data.configuredModel, undefined);
});

test('partial JSON and split UTF-8 are imported once after completion', t => {
  const { store, transcriptPath } = fixture(t);
  const entry = Buffer.from(message('assistant', 'Checking café plans.', { phase: 'commentary' }));
  const accent = entry.indexOf(Buffer.from('é'));
  fs.writeFileSync(transcriptPath, `${meta(sessionId)}\n`);
  fs.appendFileSync(transcriptPath, entry.subarray(0, accent + 1));
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.events().filter(event => event.kind.startsWith('message.')).length, 0);
  fs.appendFileSync(transcriptPath, entry.subarray(accent + 1));
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.events().filter(event => event.kind.startsWith('message.')).length, 1);
  assert.equal(store.events().find(event => event.kind === 'message.assistant').text, 'Checking café plans.');
  fs.appendFileSync(transcriptPath, `\n${message('user', 'Continue.')}\n`);
  importTranscript(store, transcriptPath, { sessionId });
  const messages = store.events().filter(event => event.kind.startsWith('message.'));
  assert.deepEqual(messages.map(event => event.id), [`transcript:${sessionId}:2`, `transcript:${sessionId}:3`]);
});

test('replay remains idempotent across fresh store instances', t => {
  const { store, dataDir, transcriptPath } = fixture(t);
  fs.writeFileSync(transcriptPath, `${meta(sessionId)}\n${message('user', 'Keep going.')}\n`);
  importTranscript(store, transcriptPath, { sessionId });
  const first = store.events().length;
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.events().length, first);
  const restarted = createStore(dataDir);
  const stats = importTranscript(restarted, transcriptPath, { sessionId });
  assert.equal(restarted.events().length, first);
  assert.equal(stats.imported, 0);
  assert.equal(stats.publicMessages, 1);
});

test('capture availability changes are visible without repeated polling writes', t => {
  const { store, transcriptPath } = fixture(t);
  fs.writeFileSync(transcriptPath, `${meta(sessionId)}\n${message('user', 'Keep this work visible.')}\n`);
  importTranscript(store, transcriptPath, { sessionId });
  const original = fs.readFileSync(transcriptPath);
  fs.unlinkSync(transcriptPath);
  assert.equal(importTranscript(store, transcriptPath, { sessionId }).status, 'unavailable');
  const unavailableEvents = store.events().length;
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.events().length, unavailableEvents);
  assert.equal(store.snapshot().coverage.status, 'unavailable');
  fs.writeFileSync(transcriptPath, original);
  importTranscript(store, transcriptPath, { sessionId });
  assert.equal(store.snapshot().coverage.status, 'caught_up');
  assert.equal(store.events().filter(event => event.kind === 'message.user').length, 1);
});

test('rejects other sessions and does not inspect neighboring transcripts', async t => {
  const { directory, store, transcriptPath } = fixture(t);
  fs.writeFileSync(transcriptPath, `${meta(sessionId)}\n${message('user', 'Enrolled work.')}\n`);
  fs.writeFileSync(path.join(directory, 'other.jsonl'), `${meta('unrelated')}\n${message('user', 'OTHER_CHAT_SECRET')}\n`);
  const stop = watchTranscript(store, transcriptPath, { sessionId, intervalMs: 50 });
  t.after(stop);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.doesNotMatch(JSON.stringify(store.events()), /OTHER_CHAT_SECRET/);
  assert.throws(() => importTranscript(store, transcriptPath, { sessionId: 'unrelated' }), /not enrolled/);
  const wrongFile = path.join(directory, 'wrong.jsonl');
  fs.writeFileSync(wrongFile, `${meta('unrelated')}\n${message('user', 'UNENROLLED_SECRET')}\n`);
  assert.equal(importTranscript(store, wrongFile, { sessionId }).status, 'out_of_scope');
  assert.doesNotMatch(JSON.stringify(store.events()), /UNENROLLED_SECRET/);
  stop();
  const before = store.events().length;
  fs.appendFileSync(transcriptPath, `${message('user', 'Should not be captured after stop.')}\n`);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(store.events().length, before);
});

test('hook filters enrollment and records only finite metadata', t => {
  const { store } = fixture(t);
  const input = { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call-1', tool_input: { command: 'INPUT_SECRET' }, tool_response: { text: 'OUTPUT_SECRET' }, prompt: 'PROMPT_SECRET', transcript_path: '/unrelated/transcript.jsonl' };
  assert.equal(recordHook(store, { ...input, session_id: 'unrelated' }).recorded, false);
  assert.equal(store.events().length, 0);
  assert.equal(recordHook(store, input).recorded, true);
  recordHook(store, input);
  assert.equal(store.events().length, 1);
  assert.equal(store.snapshot().coverage.nativeHooksActive, true);
  assert.doesNotMatch(JSON.stringify(store.events()), /SECRET|unrelated/);
  assert.equal(store.snapshot().project.items[0].status, 'active');
});

test('hook process always emits {} and exits successfully, including malformed input', t => {
  const { dataDir } = fixture(t);
  const script = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
  const valid = spawnSync(process.execPath, [script, '--data-dir', dataDir], { input: JSON.stringify({ session_id: sessionId, hook_event_name: 'Stop', turn_id: 'turn-1' }), encoding: 'utf8', timeout: 2000 });
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, '{}\n');
  assert.equal(valid.stderr, '');
  const invalid = spawnSync(process.execPath, [script, '--data-dir', dataDir], { input: 'not JSON', encoding: 'utf8', timeout: 2000 });
  assert.equal(invalid.status, 0);
  assert.equal(invalid.stdout, '{}\n');
  assert.equal(invalid.stderr, '');
});

test('hook input limits malformed/oversized streams without model-visible text', async () => {
  assert.equal(await readHookInput(Readable.from(['{'])), null);
  assert.equal(await readHookInput(Readable.from([Buffer.alloc(1024 * 1024 + 1)])), null);
  assert.deepEqual(await readHookInput(Readable.from(['{"session_id":"ok"}'])), { session_id: 'ok' });
});
