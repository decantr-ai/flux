import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/store.mjs';
import { chooseProposal, projectProposals } from '../src/proposals.mjs';
import { buildOverview } from '../src/overview.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'flux-proposals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  store.setProject({ id: 'p', sessionId: 's', sessions: [{ id: 's' }, { id: 'other' }], items: [], decisions: [], plans: [] });
  store.append({ id: 'origin', kind: 'decision_recorded', projectId: 'p', sessionId: 's', actor: 'Codex', at: '2026-10-01T10:00:00Z', provenance: 'agent_report', data: { decision: { id: 'idea', title: 'Optional followup', status: 'proposed', rationale: 'Investigate a useful path' } } });
  const choose = (choice, extra = {}) => chooseProposal(store, { proposalId: 'idea', proposalKind: 'decision', choice, expectedRevision: store.snapshot().contextRevision, ...extra });
  return { dir, store, choose };
}

test('origin is the first semantic declaration; assessment needs explicit scoped evidence', t => {
  const { store } = fixture(t);
  store.append({ id: 'check', kind: 'test_result', projectId: 'p', sessionId: 's', provenance: 'observed' });
  store.append({ id: 'update', kind: 'decision_recorded', projectId: 'p', sessionId: 's', actor: 'Other agent', at: '2026-10-28T11:00:00Z', provenance: 'agent_report', data: { decision: { id: 'idea', title: 'Refined idea', implementation: { status: 'partial', completedText: 'A test exists', remainingText: 'Implementation awaits review', sourceIds: ['check'], provenance: 'agent_report' } } } });
  let snapshot = store.snapshot(), proposal = snapshot.proposals[0];
  assert.equal(proposal.proposedBy, 'Codex');
  assert.equal(proposal.proposedAt, '2026-10-01T10:00:00Z');
  assert.equal(proposal.proposalSourceId, 'origin');
  assert.equal(proposal.title, 'Refined idea');
  assert.equal(proposal.implementation.status, 'partial');
  assert.equal(proposal.implementation.provenance, 'agent_report');
  assert.deepEqual(proposal.implementation.sourceIds, ['check']);
  assert.equal(buildOverview(snapshot).history.decisions[0].status, 'proposed');
  assert.equal(buildOverview(snapshot).openWork.proposals[0].proposedBy, 'Codex');
  store.append({ id: 'unlinked', kind: 'decision_recorded', projectId: 'p', sessionId: 's', data: { decision: { id: 'idea', implementation: { status: 'complete', completedText: 'An unsupported completion claim' } } } });
  proposal = store.snapshot().proposals[0];
  assert.equal(proposal.implementation.status, 'unknown');
  assert.equal(proposal.implementation.completedText, null);
});

test('the first actual proposal supplies the proposer, date and original reference', t => {
  const f = fixture(t);
  f.store.append({ id: 'user-work', kind: 'item_updated', projectId: 'p', sessionId: 's', actor: 'You', at: '2026-09-01T10:00:00Z', data: { item: { id: 'work-idea', title: 'Existing work', status: 'in_progress' } } });
  f.store.append({ id: 'agent-proposal', kind: 'item_updated', projectId: 'p', sessionId: 's', actor: 'Codex', at: '2026-10-02T10:00:00Z', data: { item: { id: 'work-idea', title: 'A followup idea', status: 'suggested' } } });
  f.store.append({ id: 'proposal-update', kind: 'item_updated', projectId: 'p', sessionId: 's', actor: 'Later agent', data: { item: { id: 'work-idea', status: 'proposed', rationale: 'A refinement' } } });
  const proposal = f.store.snapshot().proposals.find(value => value.id === 'work-idea');
  assert.equal(proposal.proposedBy, 'Codex');
  assert.equal(proposal.proposedAt, '2026-10-02T10:00:00Z');
  assert.equal(proposal.proposalSourceId, 'agent-proposal');
  const result = chooseProposal(f.store, { proposalId: proposal.id, proposalKind: 'item', choice: 'later', expectedRevision: f.store.snapshot().contextRevision });
  assert.equal(result.event.source.ref, 'agent-proposal');
});

test('unchosen ideas stop projecting when their semantic lifecycle becomes committed or closed', t => {
  for (const status of ['accepted', 'complete', 'completed', 'in_progress']) {
    const f = fixture(t);
    f.store.append({ id: `resolved-${status}`, kind: 'decision_recorded', projectId: 'p', sessionId: 's', data: { decision: { id: 'idea', status } } });
    const snapshot = f.store.snapshot(), overview = buildOverview(snapshot);
    assert.deepEqual(snapshot.proposals, [], status);
    assert.deepEqual(overview.openWork.proposals, [], status);
    assert.equal(overview.history.decisions[0].status, status);
    assert.equal(snapshot.project.decisions[0].status, status);
    assert.throws(() => f.choose('plan'), error => error.statusCode === 404);
  }
});

test('a planned user choice survives later semantic completion and source-linked assessment', t => {
  const f = fixture(t), planned = f.choose('plan');
  f.store.append({ id: 'verification', kind: 'test_result', projectId: 'p', sessionId: 's', provenance: 'observed' });
  f.store.append({ id: 'completed-decision', kind: 'decision_recorded', projectId: 'p', sessionId: 's', actor: 'Later agent', data: { decision: { id: 'idea', status: 'accepted', implementation: { status: 'complete', completedText: 'Verified work is complete', sourceIds: ['verification'], provenance: 'agent_report' } } } });
  const proposal = f.store.snapshot().proposals[0];
  assert.equal(proposal.status, 'accepted');
  assert.equal(proposal.disposition, 'planned');
  assert.equal(proposal.implementation.status, 'complete');
  assert.equal(proposal.proposedBy, 'Codex');
  assert.equal(proposal.proposalSourceId, 'origin');
  assert.equal(proposal.plannedItemId, planned.item.id);
  assert.equal(f.choose('plan').item.id, planned.item.id);
});

test('mixed foreign, cross-project or missing assessment sources fail closed as unknown', t => {
  const f = fixture(t);
  f.store.append({ id: 'local-check', kind: 'test_result', projectId: 'p', sessionId: 's', provenance: 'observed' });
  f.store.append({ id: 'foreign-check', kind: 'test_result', projectId: 'p', sessionId: 'other', provenance: 'observed' });
  f.store.append({ id: 'cross-project-check', kind: 'test_result', projectId: 'another-project', sessionId: 's', provenance: 'observed' });
  for (const invalid of ['foreign-check', 'cross-project-check', 'missing-check']) {
    f.store.append({ id: `assessment-${invalid}`, kind: 'decision_recorded', projectId: 'p', sessionId: 's', data: { decision: { id: 'idea', implementation: { status: 'complete', completedText: 'Unsupported complete claim', remainingText: 'Unsupported scope', sourceIds: ['local-check', invalid], provenance: 'agent_report' } } } });
    assert.deepEqual(f.store.snapshot().proposals[0].implementation, { status: 'unknown', completedText: null, remainingText: null, provenance: 'unknown', sourceIds: [] });
  }
});

test('plan is one atomic fact, durable and idempotent across stores and later revisions', t => {
  const f = fixture(t), before = f.store.snapshot(), input = { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: before.contextRevision };
  const result = chooseProposal(f.store, input), snapshot = f.store.snapshot();
  assert.equal(snapshot.revision, before.revision + 1);
  assert.equal(result.proposal.disposition, 'planned');
  assert.equal(result.item.status, 'pending');
  assert.equal(result.item.sourceProposalId, 'idea');
  assert.equal(result.item.sourceProposalKind, 'decision');
  assert.equal(result.event.actor, 'You');
  assert.equal(result.event.provenance, 'user');
  assert.deepEqual(result.event.source, { type: 'flux_proposal', ref: 'origin' });
  assert.equal(snapshot.project.items.length, 1);
  assert.equal(snapshot.requests.length, 0);
  assert.equal(snapshot.events.filter(event => event.kind === 'item_updated').length, 0);
  assert.equal(snapshot.events.filter(event => /queued|diagnostic|submission/.test(event.kind)).length, 0);
  f.store.append({ id: 'later-human', kind: 'message.user', projectId: 'p', sessionId: 's', provenance: 'user', text: 'Review another detail' });
  const reopened = createStore(f.dir), revision = reopened.snapshot().revision;
  assert.equal(chooseProposal(reopened, input).item.id, result.item.id);
  assert.equal(reopened.snapshot().revision, revision);
  assert.throws(() => f.choose('dismiss'), /already planned/);
  assert.throws(() => f.choose('later'), /already planned/);
  assert.throws(() => f.choose('restore'), /already planned/);
  f.store.append({ id: 'work-update', kind: 'item_updated', projectId: 'p', sessionId: 's', data: { item: { id: result.item.id, status: 'completed' } } });
  assert.equal(f.store.snapshot().project.items[0].status, 'completed');
  assert.equal(f.store.snapshot().proposals[0].disposition, 'planned');
});

test('later/dismiss/restore keep historical evidence and agent updates preserve choices', t => {
  const f = fixture(t), original = f.store.snapshot();
  f.choose('later');
  let snapshot = f.store.snapshot();
  assert.equal(snapshot.proposals[0].disposition, 'later');
  assert.notEqual(snapshot.contextRevision, original.contextRevision);
  assert.equal(snapshot.project.items.length, 0);
  assert.equal(buildOverview(snapshot).openWork.parked.length, 0);
  f.store.append({ id: 'agent-later', kind: 'decision_recorded', projectId: 'p', sessionId: 's', actor: 'New agent', data: { decision: { id: 'idea', status: 'proposed', rationale: 'Updated rationale' } } });
  assert.equal(f.store.snapshot().proposals[0].disposition, 'later');
  f.choose('restore'); assert.equal(f.store.snapshot().proposals[0].disposition, 'suggested');
  f.choose('dismiss'); assert.equal(f.store.snapshot().proposals[0].disposition, 'dismissed');
  f.choose('restore'); snapshot = f.store.snapshot();
  assert.equal(snapshot.proposals[0].proposalSourceId, 'origin');
  assert.equal(snapshot.proposals[0].proposedBy, 'Codex');
  assert.deepEqual(snapshot.events.filter(event => event.kind === 'proposal_choice_recorded').map(event => event.data.choice), ['later', 'restore', 'dismiss', 'restore']);
});

test('stale choices, unknown payloads and stale locks fail without appending', t => {
  const f = fixture(t), previous = f.store.snapshot();
  f.store.append({ id: 'new-human', kind: 'message.user', projectId: 'p', sessionId: 's', provenance: 'user', text: 'A new direction' });
  const revision = f.store.snapshot().revision;
  assert.throws(() => f.choose('plan', { expectedRevision: previous.contextRevision }), error => error.statusCode === 409);
  assert.throws(() => f.choose('plan', { title: 'Client-supplied replacement' }), error => error.statusCode === 400);
  assert.throws(() => f.choose('plan', { proposalId: 'missing' }), error => error.statusCode === 404);
  mkdirSync(join(f.dir, 'proposal-choice.lock'));
  assert.throws(() => f.choose('plan'), error => error.statusCode === 409 && /lock/.test(error.message));
  assert.equal(f.store.snapshot().revision, revision);
});

test('same-id foreign declarations cannot change local origin, content, assessment or linked work', t => {
  const f = fixture(t);
  f.store.append({ id: 'foreign', kind: 'decision_recorded', projectId: 'other-project', sessionId: 'other', actor: 'Foreign', data: { decision: { id: 'idea', title: 'Foreign title', status: 'proposed', implementation: { status: 'complete', sourceIds: ['foreign'] } } } });
  f.store.append({ id: 'foreign-legacy', kind: 'decision_recorded', actor: 'Foreign legacy', data: { decision: { id: 'idea', title: 'Foreign legacy title', sourceIds: ['foreign'] } } });
  f.store.append({ id: 'ambiguous-legacy', kind: 'decision_recorded', actor: 'Unknown chat', data: { decision: { id: 'idea', title: 'Ambiguous unscoped title' } } });
  assert.equal(f.store.snapshot().proposals[0].title, 'Optional followup');
  const result = f.choose('plan');
  f.store.append({ id: 'foreign-item', kind: 'item_updated', projectId: 'p', sessionId: 'other', data: { item: { id: result.item.id, title: 'Wrong chat', status: 'completed' } } });
  assert.equal(f.store.snapshot().project.items[0].title, 'Optional followup');
  assert.equal(f.store.snapshot().project.items[0].status, 'pending');
  const other = createStore(f.dir); other.setProject({ ...other.snapshot().project, sessionId: 'other' });
  assert.throws(() => chooseProposal(other, { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: other.snapshot().contextRevision }), /unavailable/);
});

test('legacy unscoped origins need current evidence; bare same-id matching is insufficient', () => {
  const project = { id: 'p', sessionId: 's', items: [], decisions: [] };
  const events = [
    { id: 'wrong-original', kind: 'decision_recorded', actor: 'Wrong', data: { decision: { id: 'idea', title: 'Wrong', status: 'proposed' } } },
    { id: 'source', kind: 'message.assistant', projectId: 'p', sessionId: 's' },
    { id: 'legacy', kind: 'decision_recorded', actor: 'Codex', at: '2026-10-01T10:00:00Z', data: { decision: { id: 'idea', title: 'Scoped evidence', status: 'proposed', sourceIds: ['source'] } } },
    { id: 'update', kind: 'decision_recorded', projectId: 'p', sessionId: 's', data: { decision: { id: 'idea', rationale: 'Update' } } },
  ];
  const result = projectProposals(project, events).proposals[0];
  assert.equal(result.proposalSourceId, 'legacy');
  assert.equal(result.proposedBy, 'Codex');
  assert.equal(result.title, 'Scoped evidence');
  assert.ok(!result.sourceIds.includes('wrong-original'));
});

test('decision/item identity stays separate and projection is pure', t => {
  const f = fixture(t);
  f.store.append({ id: 'item-origin', kind: 'item_updated', projectId: 'p', sessionId: 's', actor: 'You', data: { item: { id: 'idea', title: 'Item idea', status: 'suggested' } } });
  const original = f.store.snapshot();
  const result = chooseProposal(f.store, { proposalId: 'idea', proposalKind: 'item', choice: 'plan', expectedRevision: original.contextRevision });
  assert.equal(f.store.snapshot().proposals.find(value => value.kind === 'decision').disposition, 'suggested');
  assert.equal(result.item.sourceProposalKind, 'item');
  const before = structuredClone(original), projected = projectProposals(original.project, original.events);
  projected.proposals[0].sourceIds.push('mutated');
  assert.deepEqual(original, before);
});

test('trusted bookkeeping verifies its human source and keeps normal work review updates', t => {
  const f = fixture(t);
  assert.throws(() => chooseProposal(f.store, { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: f.store.snapshot().contextRevision }, { sourceId: 'origin' }), /human instruction/);
  f.store.append({ id: 'approval', kind: 'message.user', projectId: 'p', sessionId: 's', provenance: 'user', text: 'Proceed with this step' });
  const result = chooseProposal(f.store, { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: f.store.snapshot().contextRevision }, { sourceId: 'approval' });
  assert.equal(result.event.data.intentSourceId, 'approval');
  assert.ok(result.item.sourceIds.includes('approval'));
  f.store.append({ id: 'review', kind: 'review_group_recorded', sessionId: 's', data: { items: [{ id: result.item.id, status: 'completed', review: { outcome: 'accepted' } }] } });
  assert.equal(f.store.snapshot().project.items[0].status, 'completed');
  f.store.append({ id: 'feedback', kind: 'review_feedback_request', sessionId: 's', data: { feedback: { id: 'f', projectId: 'p', sessionId: 's', requestVersion: 2, intent: 'request_changes', affectedItemIds: [result.item.id], note: 'Recheck this' } } });
  f.store.append({ id: 'feedback-status', kind: 'review_feedback_status', sessionId: 's', data: { id: 'f', status: 'queued' } });
  assert.equal(f.store.snapshot().project.items[0].status, 'in_progress');
  assert.equal(f.store.snapshot().project.items[0].review.feedbackId, 'f');
  assert.equal(f.store.snapshot().proposals[0].disposition, 'planned');
});

test('simultaneous processes cannot duplicate a plan intent', async t => {
  const f = fixture(t), input = { proposalId: 'idea', proposalKind: 'decision', choice: 'plan', expectedRevision: f.store.snapshot().contextRevision };
  const storeUrl = pathToFileURL(join(process.cwd(), 'src/store.mjs')).href, proposalsUrl = pathToFileURL(join(process.cwd(), 'src/proposals.mjs')).href;
  const script = `import fs from 'node:fs';import {createStore} from ${JSON.stringify(storeUrl)};import {chooseProposal} from ${JSON.stringify(proposalsUrl)};const [dir,input,ready,barrier]=process.argv.slice(1);const store=createStore(dir);fs.writeFileSync(ready,'ready');while(!fs.existsSync(barrier))await new Promise(r=>setTimeout(r,5));try{const r=chooseProposal(store,JSON.parse(input));console.log(JSON.stringify({id:r.item.id}))}catch(e){console.log(JSON.stringify({error:e.message,code:e.statusCode}))}`;
  const barrier = join(f.dir, 'go');
  const start = index => {
    const ready = join(f.dir, `ready-${index}`), child = spawn(process.execPath, ['--input-type=module', '-e', script, f.dir, JSON.stringify(input), ready, barrier], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    const result = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(Error(errors))); });
    t.after(() => child.kill()); return { ready, result };
  };
  const first = start(1), second = start(2), deadline = Date.now() + 5000;
  while (!existsSync(first.ready) || !existsSync(second.ready)) { if (Date.now() > deadline) throw Error('children did not reach barrier'); await new Promise(resolve => setTimeout(resolve, 10)); }
  writeFileSync(barrier, 'go');
  const results = await Promise.all([first.result, second.result]), snapshot = f.store.snapshot();
  assert.ok(results.some(value => value.id));
  assert.ok(results.every(value => value.id || value.code === 409));
  assert.equal(new Set(results.filter(value => value.id).map(value => value.id)).size, 1);
  assert.equal(snapshot.project.items.length, 1);
  assert.equal(snapshot.events.filter(event => event.kind === 'proposal_choice_recorded').length, 1);
});
