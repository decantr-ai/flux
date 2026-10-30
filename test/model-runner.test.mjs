import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCollector, buildArgs, infer, allocateBudget, WRAPPER, DEVELOPER_INSTRUCTIONS } from '../scripts/harness/model-runner.mjs';
import { grade, blindBundle } from '../scripts/harness/model-grade.mjs';

test('JSONL allowlist excludes reasoning, tool arguments and raw errors', () => {
  const c = makeCollector();
  c.accept({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING_SENTINEL' } });
  c.accept({ type: 'item.completed', item: { type: 'analysis', text: 'PRIVATE_ANALYSIS_SENTINEL' } });
  c.accept({ type: 'item.completed', item: { type: 'command_execution', command: 'TOOL_ARGUMENT_SENTINEL', output: 'PRIVATE_TOOL_RESULT' } });
  c.accept({ type: 'item.completed', item: { type: 'agent_message', phase: 'analysis', text: 'PRIVATE_PHASE_SENTINEL' } });
  c.accept({ type: 'item.completed', item: { type: 'agent_message', channel: 'analysis', text: 'PRIVATE_CHANNEL_SENTINEL' } });
  c.accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Public answer' } });
  c.accept({ type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 4, output_tokens: 2, secret: 'PRIVATE_USAGE_SENTINEL' } });
  c.accept({ type: 'turn.failed', error: { message: 'PRIVATE_UNKNOWN_ERROR' } });
  const saved = JSON.stringify(c.state);
  assert.doesNotMatch(saved, /PRIVATE_|TOOL_ARGUMENT/);
  assert.equal(c.state.answer, 'Public answer');
  assert.deepEqual(c.state.toolActions, ['command_execution']);
  assert.deepEqual(c.state.usage, { input_tokens: 11, cached_input_tokens: 4, output_tokens: 2 });
  assert.equal(c.state.reportedModel, null);
});

test('invocation keeps read-only, user rules and ephemeral boundary', () => {
  const args = buildArgs({ model: 'test', effort: 'low' }, '/tmp/empty', '/tmp/final');
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!args.includes('--ignore-rules'));
  assert.ok(!args.some(x => /bypass/.test(x)));
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'skill_search', 'multi_agent']) assert.ok(args.includes(feature));
  assert.match(WRAPPER, /do not execute/i);
  assert.match(DEVELOPER_INSTRUCTIONS, /only the supplied packet/);
});

test('call allocation prevents fast configurations starving later configurations', () => {
  assert.deepEqual(allocateBudget(40, 4), [10,10,10,10]);
  assert.deepEqual(allocateBudget(7, 4), [2,2,2,1]);
  assert.deepEqual(allocateBudget(1, 4), [1,0,0,0]);
});

test('non-action CLI warnings remain visible and rejected tools hard-fail', () => {
  const c = makeCollector();
  c.accept({ type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled: skip_host_skill_discovery' } });
  c.accept({ type: 'item.completed', item: { type: 'error', message: 'Some model fallback warning PRIVATE_DISCARDED_TEXT' } });
  c.accept({ type: 'item.completed', item: { type: 'error', message: 'Unknown tool PRIVATE_TOOL_NAME' } });
  assert.deepEqual(c.state.diagnosticCategories, ['known-experimental-feature-warning','model-or-route-warning','tool-or-configuration-warning']);
  assert.deepEqual(c.state.toolActions, ['tool-rejection']);
  assert.doesNotMatch(JSON.stringify(c.state), /PRIVATE_/);
});

test('hard gates identify tool, length, sentinel and fabricated action claims; rubric remains exact', () => {
  const fixture = { mode: 'audit', expected: { sentinels: ['EXCLUDED_X'], facts: ['fact'], rubric: ['Exact reviewer rubric'] } };
  const result = { status: 'completed', answer: 'I verified EXCLUDED_X. ' + 'word '.repeat(202), toolActions: ['command_execution'], unsupportedActions: ['unknown'] };
  const g = grade(result, fixture);
  assert.equal(g.status, 'hard-fail');
  assert.deepEqual(g.hardFailures.sort(), ['audit-over-200-words','excluded-or-foreign-sentinel','invented-action-or-verification-claim','tool-attempt','unsupported-action'].sort());
  assert.deepEqual(g.expected.rubric, fixture.expected.rubric);
  assert.equal(g.semanticReviewRequired, true);
});

test('blind reviewer bundle omits model identities but preserves prompt and rubric', () => {
  const cases = [{ id: 'case', mode: 'audit', prompt: 'frozen prompt', expected: { rubric: ['review this'] } }];
  const output = blindBundle([{ id: 'private-config-case-0', configId: 'private-config', caseId: 'case', requestedModel: 'private-model', status: 'completed', answer: 'answer' }], cases, new Map([['private-config','Configuration A']]));
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /private-config|private-model/);
  assert.equal(output[0].prompt, 'frozen prompt');
  assert.deepEqual(output[0].grading.expected.rubric, ['review this']);
});

test('subprocess capture persists only allowed data and removes empty working directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flux-runner-test-'));
  const binary = join(dir, 'fake-codex.mjs');
  await writeFile(binary, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv;\nwriteFileSync(args[args.indexOf('-o')+1], 'Public final');\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_DO_NOT_SAVE'}}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Public final'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}));\nconsole.error('PRIVATE_STDERR_DO_NOT_SAVE');\n`, { mode: 0o700 });
  try {
    const result = await infer({ model: 'fake', effort: 'low' }, 'synthetic', { binary, timeoutMs: 1000 });
    assert.equal(result.status, 'completed');
    assert.equal(result.answer, 'Public final');
    assert.deepEqual(result.nativeUsage, { input_tokens: 3, output_tokens: 2 });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
