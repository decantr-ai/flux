import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
async function load(path) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', target: 'es2022', format: 'cjs', jsx: 'automatic', packages: 'external' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const [selection, { PlanView }, { ChangesView }, { ProposalList }, { ContextCoverage }, api] = await Promise.all([
  load('../ui/src/lib/checkpoint-selection.ts'), load('../ui/src/views/Plan.tsx'), load('../ui/src/views/Changes.tsx'), load('../ui/src/components/ProposalList.tsx'), load('../ui/src/components/ContextCoverage.tsx'), load('../ui/src/lib/api.ts'),
]);
const owner = { projectId: 'project', sessionId: 'chat' };
const plan = (id, title, patch = {}) => ({ id, title, sessionId: 'chat', scopeId: 'scope', sourceIds: [], steps: [{ id: 'stable', title: `${title} exact saved step`, status: 'todo' }], ...patch });
function snapshot(plans = []) {
  return { revision: 10, contextRevision: 'context', csrfToken: 'synthetic', project: { id: 'project', sessionId: 'chat', title: 'Synthetic', goal: 'Inspect', items: [], plans }, events: [], overview: { focus: {}, workItems: [], openWork: { active: [], parked: [], proposals: [] }, history: { plans, decisions: [] } } };
}
const render = (View, props) => renderToStaticMarkup(React.createElement(View, { onSelect() {}, refresh: async () => {}, onCheckpoint() {}, onBaselinePlan() {}, onMode() {}, session: '', actor: '', mode: 'list', ...props }));

test('follow latest derives from the shared scoped catalog as new checkpoints arrive', () => {
  const a = plan('a', 'Earlier'), b = plan('b', 'Latest');
  const state = selection.followLatest(owner), current = snapshot([a]);
  assert.equal(selection.resolveCheckpoint(state, selection.checkpointCatalog(current)).checkpoint.id, 'a');
  current.overview.history.plans.push(b, plan('foreign', 'Foreign', { sessionId: 'other' }));
  assert.equal(selection.resolveCheckpoint(state, selection.checkpointCatalog(current)).checkpoint.id, 'b');
  assert.equal(state.mode, 'follow_latest');
});

test('explicit pin preserves exact historical steps, advertises newer checkpoints and returns to real latest', () => {
  const plans = [plan('a', 'Earlier'), plan('b', 'Later')];
  const pinned = selection.chooseCheckpoint(selection.followLatest(owner), owner, 'a');
  const resolved = selection.resolveCheckpoint(pinned, plans);
  assert.equal(resolved.checkpoint, plans[0]);
  assert.equal(resolved.newerAvailable, true);
  const current = snapshot(plans);
  const html = render(PlanView, { snapshot: current, checkpointSelection: pinned });
  assert(html.includes('Viewing history'));
  assert(html.includes('Newer checkpoint available'));
  assert(html.includes('Return to latest'));
  assert(html.includes('Earlier exact saved step'));
  assert(!html.includes('Later exact saved step'));
  plans.push(plan('c', 'Newest'));
  assert.equal(selection.resolveCheckpoint(pinned, plans).checkpoint.id, 'a');
  const following = selection.chooseCheckpoint(pinned, owner, null);
  assert.equal(selection.resolveCheckpoint(following, plans).checkpoint.id, 'c');
});

test('missing pinned checkpoints never silently substitute latest, including in Changes', () => {
  const pinned = selection.chooseCheckpoint(selection.followLatest(owner), owner, 'missing');
  const state = snapshot([plan('a', 'Available')]);
  assert.equal(selection.resolveCheckpoint(pinned, state.overview.history.plans).checkpoint, undefined);
  for (const View of [PlanView, ChangesView]) {
    const html = render(View, { snapshot: state, checkpointSelection: pinned });
    assert(html.includes('pinned checkpoint is unavailable'));
    assert(html.includes('Return to latest'));
    assert(!html.includes('Available exact saved step'));
  }
});

test('scope resets pins and baselines; comparisons reject unrelated, missing or later baselines', () => {
  const pinned = { ...selection.chooseCheckpoint(selection.followLatest(owner), owner, 'a'), baselineId: 'baseline' };
  const changed = selection.scopedCheckpointSelection(pinned, { ...owner, sessionId: 'other' });
  assert.deepEqual(changed, selection.followLatest({ ...owner, sessionId: 'other' }));
  assert.equal(selection.scopedCheckpointSelection(changed, owner).mode, 'follow_latest');
  const plans = [plan('a', 'Earlier'), plan('b', 'After'), plan('c', 'Later'), plan('unrelated', 'Unrelated', { scopeId: 'different', steps: [{ id: 'other', title: 'Other', status: 'todo' }] })];
  for (const id of ['missing', 'c', 'unrelated']) assert.equal(selection.resolveBaseline({ ...pinned, baselineId: id }, plans, plans[1]).before, undefined);
  assert.equal(selection.resolveBaseline({ ...pinned, baselineId: '' }, plans, plans[1]).before.id, 'a');
  assert.equal(selection.checkpointOptionId(selection.checkpointOption('latest')), 'latest', 'A literal checkpoint named latest remains pinnable.');
});

test('older same-scope HTTP snapshots cannot regress following; a lower revision in another scope is accepted', () => {
  const current = snapshot(); current.revision = 20;
  const older = snapshot(); older.revision = 19;
  assert.equal(selection.snapshotIsFresh(current, older), false);
  older.project.sessionId = 'different';
  assert.equal(selection.snapshotIsFresh(current, older), true);
});

const manifest = patch => ({ version: 'test', mode: 'audit', includedCount: 1, selectedCount: 3, omittedRecordIds: ['plan', 'work'], shortenedRecordIds: [], targetDetailsShortened: false, latestDirectionShortened: false, goalShortened: false, focusRelation: 'aligned', unlinkedConstraintCount: 0, sources: [], ...patch });
test('coverage names plan, open work and checks and distinguishes budget omission from an unselected plan', () => {
  const roleCoverage = [{ role: 'plan', label: 'Current plan', selectedCount: 1, includedCount: 0, omittedCount: 1, shortenedCount: 0 }, { role: 'work', label: 'Open work', selectedCount: 1, includedCount: 0, omittedCount: 1, shortenedCount: 0 }, { role: 'check', label: 'Recorded checks', selectedCount: 1, includedCount: 1, omittedCount: 0, shortenedCount: 1 }];
  const omitted = render(ContextCoverage, { manifest: manifest({ roleCoverage, essentialCoverage: { currentPlan: 'budget_omitted' } }) });
  for (const value of ['Current plan left out to fit the message', 'Open work', 'Recorded checks', '1 left out', '1 excerpted']) assert(omitted.includes(value));
  assert(!omitted.includes('3 of 3 optional sources included'));
  const unselected = render(ContextCoverage, { manifest: manifest({ essentialCoverage: { currentPlan: 'not_selected' } }) });
  assert(unselected.includes('Current plan not selected'));
  assert(!unselected.includes('Current plan left out'));
  const unavailable = render(ContextCoverage, { manifest: manifest({ essentialCoverage: { currentPlan: 'not_available' } }) });
  assert(unavailable.includes('Current plan not available'));
  const legacy = render(ContextCoverage, { manifest: manifest({}) });
  assert(!legacy.includes('context-essential-warning'));
});

function proposal(id, disposition = 'suggested', patch = {}) {
  return { id, kind: 'decision', title: `Idea ${id}`, rationale: 'Recorded rationale', status: 'proposed', sourceIds: ['original'], proposedBy: 'Original Codex', proposedAt: '2026-09-01T12:00:00Z', proposalSourceId: 'original', disposition, implementation: { status: 'unknown', completedText: null, remainingText: null, provenance: 'unknown', sourceIds: [] }, ...patch };
}
test('proposal cards separate original suggestion, user choice and source-backed implementation without implying execution', () => {
  const state = snapshot();
  state.proposalActions = { available: true };
  state.events = [{ id: 'original', sessionId: 'chat', kind: 'decision_recorded' }, { id: 'assessment', sessionId: 'chat', kind: 'verification' }];
  state.project.items = [{ id: 'planned-work', title: 'Linked work', status: 'pending' }];
  state.proposals = [proposal('consider', 'suggested', { implementation: { status: 'partial', completedText: 'Selection UI recorded.', remainingText: 'More capture coverage.', provenance: 'agent_report', sourceIds: ['assessment'] } }), proposal('defer', 'later'), proposal('planned', 'planned', { plannedItemId: 'planned-work' }), proposal('dismissed', 'dismissed')];
  const html = render(ProposalList, { snapshot: state });
  for (const value of ['Original Codex', 'To consider', 'Ideas for later', 'Added to plan', 'Dismissed ideas', 'Restore idea', 'Partly implemented', 'Recorded progress', 'Selection UI recorded.', 'More capture coverage.', 'Agent report', 'View planned work']) assert(html.includes(value));
  assert(html.includes('does not send a request to Codex or start execution'));
  assert(!html.includes('>Proposed<'));
  assert(!html.includes('>Completed<'));
  assert.equal((html.match(/>Add to plan<\/button>/g) || []).length, 2);
  assert(!html.includes('>Send<'));
});

test('legacy proposal details remain available while lifecycle actions require capability and original declaration', () => {
  const state = snapshot(); state.proposals = [proposal('legacy', 'suggested', { proposalSourceId: null })];
  const html = render(ProposalList, { snapshot: state });
  assert(html.includes('Restart the updated Flux service'));
  assert(html.includes('recorded declaration is needed'));
  assert(html.includes('Details'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Add to plan<\/button>/);
});

test('proposal actions send only the exact scoped choice and current revision to the proposal API', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; };
  try {
    for (const choice of ['plan', 'later', 'dismiss', 'restore']) await api.chooseProposal(snapshot(), 'idea', 'decision', choice);
    assert.deepEqual(calls.map(value => value.path), Array(4).fill('/api/proposals'));
    assert.deepEqual(calls[0].body, { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: 'context' });
    assert(calls.every(value => !('dispatch' in value.body)));
  } finally { globalThis.fetch = original; }
});
