import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview } from '../src/overview.mjs';

const at = '2026-10-14T14:00:00Z';
const user = (id, text, extra = {}) => ({ id, kind: 'message.user', sessionId: 'chat', at, provenance: 'user', text, ...extra });
const event = (id, kind, extra = {}) => ({ id, kind, sessionId: 'chat', at, provenance: 'observed', ...extra });
function fixture() {
  return {
    project: {
      id: 'flux', goal: 'Make ongoing work easy to understand', goalSourceIds: ['goal-source'],
      sessionId: 'chat', sessions: [{ id: 'chat', title: 'Flux chat' }, { id: 'other', title: 'Other chat' }],
      focus: { title: 'Apply the approved overview', status: 'working', why: 'The current view hides current work.', next: { text: 'Verify the overview against the saved records', status: 'planned' }, sourceIds: ['focus-source'], intentSourceId: 'approval', updatedAt: at },
      items: [], plans: [], decisions: [],
    },
    events: [
      user('goal-source', 'Make ongoing work easy to understand'),
      user('approval', 'Apply the approved overview'),
      event('focus-source', 'project_patch', { provenance: 'agent_report', data: { patch: { focus: { title: 'Apply the approved overview' } } } }),
    ],
  };
}

test('explicit anchored focus supplies the source-linked overview with reported rationale', () => {
  const snapshot = fixture();
  const result = buildOverview(snapshot);
  assert.deepEqual(result.session, { id: 'chat', title: 'Flux chat', status: 'known' });
  assert.equal(result.goal.text, snapshot.project.goal);
  assert.deepEqual(result.goal.sourceIds, ['goal-source']);
  assert.equal(result.direction.text, 'Apply the approved overview');
  assert.deepEqual(result.direction.sourceIds, ['approval']);
  assert.equal(result.focus.status, 'current');
  assert.equal(result.now.text, snapshot.project.focus.title);
  assert.equal(result.now.status, 'working');
  assert.equal(result.why.text, snapshot.project.focus.why);
  assert.equal(result.why.provenance, 'agent_report');
  assert.deepEqual(result.why.sourceIds, ['focus-source']);
  assert.equal(result.next.text, snapshot.project.focus.next.text);
  assert.equal(result.next.status, 'planned');
});

test('the latest actual human direction supersedes stored summaries and makes old focus stale', () => {
  const snapshot = fixture();
  snapshot.project.latestIntent = 'Keep applying the previous plan';
  snapshot.project.latestIntentSourceId = 'approval';
  snapshot.events.push(user('new-direction', 'Pause the implementation and inspect the existing result.', { at: '2026-10-14T14:05:00Z' }));
  snapshot.events.push(user('generated', 'Flux diagnostic request-123. Inspect the supplied work record.'));
  const result = buildOverview(snapshot);
  assert.equal(result.direction.text, 'Pause the implementation and inspect the existing result.');
  assert.deepEqual(result.direction.sourceIds, ['new-direction']);
  assert.equal(result.focus.status, 'needs_update');
  assert.equal(result.now.text, snapshot.project.focus.title);
  assert.equal(result.now.status, 'working');
  assert.equal(result.now.provenance, 'agent_report');
  assert.equal(result.why.text, snapshot.project.focus.why);
  assert.equal(result.next.text, snapshot.project.focus.next.text);
  assert.equal(result.next.status, 'planned');
  assert.equal(result.focus.title, 'Apply the approved overview', 'the older report is retained with its stale status');
  assert.ok(!result.events.some(value => value.id === 'generated'));
});

test('passive activity and queued diagnostic prompts preserve the focus', () => {
  const snapshot = fixture();
  const before = buildOverview(snapshot);
  snapshot.events.push(
    event('tool', 'tool.returned', { summary: 'Done' }),
    event('turn', 'turn.finished', { summary: 'Done' }),
    event('model', 'model.configured', { data: { model: 'model-a' } }),
    event('tokens', 'usage.tokens', { data: { usage: { total_tokens: 10 } } }),
    event('coverage', 'coverage_updated'),
    event('assistant', 'message.assistant', { provenance: 'agent_report', text: 'I finished the current step.', data: { channel: 'commentary' } }),
    event('queued', 'diagnostic_status', { data: { requestId: 'request', status: 'queued' } }),
    user('generated', '  Flux diagnostic request-123. Inspect the supplied work record.'),
  );
  const after = buildOverview(snapshot);
  for (const key of ['focus', 'now', 'why', 'next', 'direction', 'events']) assert.deepEqual(after[key], before[key]);
});

test('journal order handles missing or inconsistent timestamps without inventing them', () => {
  const snapshot = fixture();
  snapshot.events.push(user('newer-record', 'Use the newest instruction.', { at: '2020-01-01T00:00:00Z' }));
  assert.equal(buildOverview(snapshot).focus.status, 'needs_update');
  snapshot.events.at(-1).at = undefined;
  const result = buildOverview(snapshot);
  assert.equal(result.focus.status, 'needs_update');
  assert.equal(result.direction.at, null);
  assert.equal(result.now.at, snapshot.project.focus.updatedAt);
  assert.ok(result.unknowns.includes('direction_time'));
  assert.equal(result.events.find(value => value.id === 'newer-record').at, null);
});

test('session scoping excludes other chat instructions, focus, work, and evidence', () => {
  const snapshot = fixture();
  snapshot.events.push(user('foreign-human', 'OTHER CHAT INSTRUCTION', { sessionId: 'other' }));
  snapshot.events.push(event('foreign-work', 'item_updated', { sessionId: 'other', data: { item: { id: 'other-work' } } }));
  snapshot.project.items = [
    { id: 'local', title: 'Local work', sessionId: 'chat', status: 'active', sourceIds: ['approval', 'foreign-work', 'not-a-record'] },
    { id: 'other-work', title: 'Foreign work', status: 'working', sessionId: 'other', sourceIds: ['foreign-work'] },
    { id: 'foreign-sources', title: 'Work from another chat', status: 'working', sourceIds: ['foreign-work'] },
  ];
  const enrolled = buildOverview(snapshot);
  assert.equal(enrolled.focus.status, 'current');
  assert.equal(enrolled.direction.text, 'Apply the approved overview');
  assert.deepEqual(enrolled.openWork.active.map(value => value.id), ['local']);
  assert.deepEqual(enrolled.openWork.active[0].sourceIds, ['approval']);
  assert.ok(enrolled.events.every(value => value.sessionId !== 'other'));
  const other = buildOverview(snapshot, { sessionId: 'other' });
  assert.equal(other.session.title, 'Other chat');
  assert.equal(other.direction.text, 'OTHER CHAT INSTRUCTION');
  assert.equal(other.focus.status, 'unknown');
  assert.equal(other.now.text, null);
  assert.equal(other.why.text, null);
  assert.deepEqual(other.goal.sourceIds, []);
  assert.deepEqual(other.openWork.active.map(value => value.id), ['other-work', 'foreign-sources']);
});

test('unscoped project records remain available without guessing their chat', () => {
  const snapshot = fixture();
  snapshot.events.push({ id: 'manual', kind: 'decision_recorded', provenance: 'agent_report', summary: 'Use explicit source anchors' });
  snapshot.project.decisions.push({ id: 'decision', title: 'Use explicit source anchors', sourceIds: ['manual'] });
  const result = buildOverview(snapshot);
  assert.equal(result.events[0].sessionId, null);
  assert.equal(result.events[0].at, null);
  assert.equal(result.history.decisions[0].provenance, 'unknown');
  assert.deepEqual(result.history.decisions[0].sourceIds, ['manual']);
});

test('completed historical checkpoints never supply live focus, rationale, next actions, or completion', () => {
  const snapshot = fixture();
  delete snapshot.project.focus;
  snapshot.project.plans.push({ id: 'old-plan', title: 'Previous delivery', at, sourceIds: ['old-checkpoint'], steps: [{ id: 'old-step', title: 'Delivered the old feature', status: 'completed', sourceIds: ['old-checkpoint'] }] });
  snapshot.events.push(event('old-checkpoint', 'plan_saved', { provenance: 'agent_report', data: { plan: snapshot.project.plans[0] } }));
  snapshot.events.push(event('finished-turn', 'turn.finished', { summary: 'Everything is done' }));
  const result = buildOverview(snapshot);
  assert.equal(result.focus.status, 'unknown');
  assert.equal(result.now.text, null);
  assert.equal(result.why.text, null);
  assert.equal(result.next.text, null);
  assert.equal(result.goal.status, 'declared');
  assert.equal(result.history.plans[0].steps[0].status, 'completed');
  assert.equal(result.history.plans[0].provenance, 'agent_report');
  assert.equal(result.events[0].category, 'checkpoint');
  assert.ok(!Object.hasOwn(result, 'completed'));
});

test('missing focus fields remain unknown without deriving rationale or future work from items', () => {
  const snapshot = fixture();
  snapshot.project.focus = { title: 'Review records', intentSourceId: 'approval', sourceIds: ['approval'], status: 'working' };
  snapshot.project.items.push({ id: 'item', title: 'Possible followup', status: 'proposed', purpose: 'A tempting rationale' });
  const result = buildOverview(snapshot);
  assert.equal(result.focus.status, 'current');
  assert.equal(result.now.text, 'Review records');
  assert.equal(result.now.at, null);
  assert.equal(result.why.text, null);
  assert.equal(result.next.text, null);
  assert.equal(result.why.provenance, 'unknown');
  assert.ok(result.unknowns.includes('focus_time'));
});

test('missing, foreign, diagnostic, and nonhuman focus anchors cannot establish current work', () => {
  for (const anchorId of [undefined, 'missing', 'foreign', 'generated', 'assistant']) {
    const snapshot = fixture();
    snapshot.project.focus.intentSourceId = anchorId;
    snapshot.events.push(user('foreign', 'Other direction', { sessionId: 'other' }));
    snapshot.events.push(user('generated', 'Flux diagnostic request. Inspect the supplied work record.'));
    snapshot.events.push(event('assistant', 'message.assistant', { provenance: 'agent_report', text: 'User approved this', data: { channel: 'final' } }));
    const result = buildOverview(snapshot);
    assert.equal(result.focus.status, 'unknown', String(anchorId));
    assert.equal(result.focus.intentSourceId, null);
    assert.equal(result.now.text, null);
    assert.equal(result.why.text, null);
    assert.equal(result.next.text, null);
    assert.deepEqual(result.direction.sourceIds, ['approval']);
    assert.ok(result.unknowns.includes('focus_anchor'));
  }
});

test('an absent snapshot has explicit unknowns and no fabricated records', () => {
  const result = buildOverview();
  assert.deepEqual(result.session, { id: null, title: null, status: 'unknown' });
  for (const key of ['goal', 'direction', 'now', 'why', 'next']) {
    assert.equal(result[key].text, null);
    assert.equal(result[key].status, 'unknown');
    assert.equal(result[key].at, null);
    assert.deepEqual(result[key].sourceIds, []);
  }
  assert.equal(result.focus.intentSourceId, null);
  assert.equal(result.focus.updatedAt, null);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.history, { plans: [], decisions: [], items: [] });
});

test('open work separates active commitments, parked options, proposals, and unknown statuses', () => {
  const snapshot = fixture();
  snapshot.project.items = [
    { id: 'active', title: 'Build overview', status: 'working', sourceIds: ['approval'] },
    { id: 'review', title: 'Review the new overview', status: 'ready_for_review', provenance: 'agent_report', sourceIds: ['approval'] },
    { id: 'blocked', title: 'External dependency', status: 'blocked' },
    { id: 'claimed', title: 'Reported done without verification', status: 'claimed_complete', provenance: 'agent_report' },
    { id: 'parked', title: 'Optional native hooks', status: 'parked', optional: true, returnCondition: 'Revisit only when capture is needed' },
    { id: 'proposal', title: 'Consider a new chart', status: 'proposed' },
    { id: 'unknown', title: 'Work without a status' },
    { id: 'closed', title: 'Explicitly completed task', status: 'completed', provenance: 'agent_report' },
  ];
  snapshot.project.decisions = [
    { id: 'proposed-decision', title: 'Consider startup reuse later', status: 'proposed', sourceIds: ['approval'] },
    { id: 'accepted-decision', title: 'Apply the approved overview', status: 'accepted' },
    { id: 'foreign-decision', title: 'Other chat proposal', status: 'proposed', sessionId: 'other' },
  ];
  snapshot.events.push(event('tool', 'tool.returned', { summary: 'All done' }));
  const result = buildOverview(snapshot);
  assert.deepEqual(result.openWork.active.map(value => value.id), ['active', 'review', 'blocked', 'claimed']);
  assert.equal(result.openWork.active.find(value => value.id === 'review').status, 'ready_for_review', 'Ready for review remains open work');
  assert.deepEqual(result.openWork.parked.map(value => value.id), ['parked']);
  assert.equal(result.openWork.parked[0].optional, true);
  assert.equal(result.openWork.parked[0].returnCondition, 'Revisit only when capture is needed');
  assert.deepEqual(result.openWork.proposals.map(value => value.id), ['proposal', 'proposed-decision']);
  assert.deepEqual(result.openWork.proposals.map(value => value.entityType), ['item', 'decision']);
  assert.equal(result.openWork.proposals[1].status, 'proposed');
  assert.deepEqual(result.openWork.proposals[1].sourceIds, ['approval']);
  for (const group of ['active', 'parked', 'unknown']) assert.ok(result.openWork[group].every(value => value.entityType === 'item'));
  assert.deepEqual(result.openWork.unknown.map(value => value.id), ['unknown']);
  assert.equal(result.openWork.unknown[0].status, 'unknown');
  assert.deepEqual(result.history.items.map(value => value.id), ['closed']);
  assert.equal(result.history.items[0].provenance, 'agent_report');
  assert.equal(result.history.items[0].entityType, 'item');
  assert.equal(result.openWork.active[0].status, 'working');
});

test('meaningful activity includes explicit outcomes and excludes bookkeeping and routine commentary', () => {
  const snapshot = fixture();
  snapshot.events.push(
    event('decision', 'decision_recorded'), event('item', 'item_updated'),
    event('verification', 'verification_recorded'), event('artifact', 'artifact_created'),
    event('answer', 'diagnostic_result'),
    event('final', 'message.assistant', { provenance: 'agent_report', data: { channel: 'final_answer' }, text: 'Verification passed' }),
    event('commentary', 'message.assistant', { provenance: 'agent_report', data: { channel: 'commentary' }, text: 'Running checks' }),
    event('tool-started', 'tool.started'), event('tool-returned', 'tool.returned'),
    event('turn-started', 'turn.started'), event('turn-finished', 'turn.finished'),
    event('model', 'model.configured'), event('usage', 'usage.tokens'), event('coverage', 'coverage_updated'),
    event('unrelated-patch', 'project_patch', { data: { patch: { sessions: [] } } }),
  );
  const result = buildOverview(snapshot);
  assert.deepEqual(result.events.map(value => value.id), ['final', 'answer', 'artifact', 'verification', 'item', 'decision', 'focus-source', 'approval', 'goal-source']);
  assert.equal(result.events[0].provenance, 'agent_report');
});

test('explicit per-field sources are filtered and projected evidence refers only to real scoped records', () => {
  const snapshot = fixture();
  snapshot.project.goalSourceIds.push('missing');
  snapshot.project.focus.sourceIds.push('not-an-event');
  snapshot.project.focus.why = { text: 'Because the user asked for it', provenance: 'user', sourceIds: ['approval', 'missing'] };
  snapshot.project.focus.next = { text: 'Check saved evidence', status: 'planned', provenance: 'agent_report', sourceIds: ['focus-source', 'missing'] };
  snapshot.project.plans.push({ id: 'plan', sourceIds: ['missing', 'approval'], steps: [{ id: 'step', sourceIds: ['missing', 'approval'] }] });
  const result = buildOverview(snapshot);
  assert.equal(result.why.provenance, 'user');
  assert.deepEqual(result.why.sourceIds, ['approval']);
  assert.deepEqual(result.next.sourceIds, ['focus-source']);
  assert.deepEqual(result.history.plans[0].steps[0].sourceIds, ['approval']);
  const actualIds = new Set(snapshot.events.map(value => value.id));
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'sourceIds') assert.ok(child.every(id => actualIds.has(id)));
      else visit(child);
    }
  };
  visit(result);
});

test('the projection is pure and return values do not share mutable source records', () => {
  const snapshot = fixture();
  snapshot.project.items.push({ id: 'item', title: 'Build', status: 'working', sourceIds: ['approval'], metadata: { note: 'Original' } });
  snapshot.events[0].source = { type: 'transcript', ref: 'chat#line1' };
  const before = structuredClone(snapshot);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(snapshot);
  const result = buildOverview(snapshot);
  result.openWork.active[0].metadata.note = 'Changed';
  result.openWork.active[0].sourceIds.push('other');
  result.events.at(-1).source.ref = 'changed';
  assert.deepEqual(snapshot, before);
});

test('checkpoint metadata is inherited transparently and reports stay distinct from checks',()=>{
  const snapshot=fixture();
  snapshot.project.plans=[{id:'v1',title:'Old checkpoint',sourceIds:['approval'],steps:[{id:'one',title:'Step',status:'verified'}]}];
  snapshot.events.push(event('plan-record','plan_saved',{data:{plan:{id:'v1'}},provenance:'agent_report'}));
  snapshot.project.items=[{id:'reported',status:'verified',sourceIds:['approval']},{id:'tested',status:'completed',sourceIds:['checks']}];
  snapshot.events.push(event('checks','verification',{summary:'Targeted checks passed'}));
  const result=buildOverview(snapshot);
  const plan=result.history.plans[0];
  assert.equal(plan.at,at);
  assert.equal(plan.steps[0].evidenceScope,'checkpoint');
  assert.ok(plan.steps[0].sourceIds.includes('plan-record'));
  assert.equal(plan.steps[0].evidence.kind,'reported');
  assert.equal(result.workItems[0].evidence.kind,'reported');
  assert.equal(result.workItems[1].evidence.kind,'checks_recorded');
});
