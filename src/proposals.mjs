import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContextError, isHumanDirection } from './context.mjs';

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const timestamp = value => text(value) && Number.isFinite(Date.parse(value)) ? value : null;
const proposalStatuses = new Set(['proposal', 'proposed', 'suggested', 'idea', 'optional']);
const implementationStatuses = new Set(['unknown', 'not_started', 'partial', 'in_progress', 'complete', 'research_only']);
const provenances = new Set(['user', 'observed', 'agent_report', 'inferred']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (kind, id) => JSON.stringify([kind, id]);
const scoped = (event, project) => event?.sessionId === project.sessionId && (!event.projectId || event.projectId === project.id);
const compatible = (value, project) => value && (!value.sessionId || value.sessionId === project.sessionId) && (!value.projectId || value.projectId === project.id);
export const plannedProposalItemId = (project, kind, id) => `proposal-work:${hash([project.id, project.sessionId, kind, id])}`;

/** Exact semantic identities only. User disposition and agent assessment are separate facts. */
export function projectProposals(project = {}, events = []) {
  if (!text(project.id) || !text(project.sessionId)) return { proposals: [], plannedItems: [] };
  const allById = new Map(events.map(event => [event.id, event]));
  const localById = new Map(events.filter(event => scoped(event, project)).map(event => [event.id, event]));
  const sources = ids => [...new Set(list(ids).filter(id => localById.has(id)))];
  const declarations = [];
  const extract = event => {
    if (event.kind === 'decision_recorded') return [['decision', event.data?.decision]];
    if (event.kind === 'item_updated') return [['item', event.data?.item]];
    if (event.kind === 'review_group_recorded') return list(event.data?.items).map(value => ['item', value]);
    if (event.kind === 'project_patch') return [
      ...list(event.data?.patch?.decisions).map(value => ['decision', value]),
      ...list(event.data?.patch?.items).map(value => ['item', value]),
    ];
    return [];
  };
  const scopedIdentities = new Set();
  const foreignIdentities = new Set(events.flatMap(event => extract(event).filter(([, value]) => text(value?.id) && (!compatible(event, project) || !compatible(value, project))).map(([kind, value]) => key(kind, value.id))));
  for (const event of events) for (const [kind, value] of extract(event)) {
    if (!compatible(value, project) || !text(value.id) || !compatible(event, project)) continue;
    // Legacy unscoped declarations require actual selected-chat evidence. An
    // identically named foreign record never supplies scope or metadata.
    const known = list(value.sourceIds).map(id => allById.get(id)).filter(Boolean);
    if (known.some(source => !compatible(source, project))) continue;
    const anchored = sources(value.sourceIds).length > 0;
    const inheritedScope = scopedIdentities.has(key(kind, value.id)) && !foreignIdentities.has(key(kind, value.id));
    if (!scoped(event, project) && !(event.sessionId == null && (anchored || inheritedScope))) continue;
    declarations.push({ kind, value, event });
    localById.set(event.id, event);
    if (scoped(event, project)) scopedIdentities.add(key(kind, value.id));
  }
  const entities = new Map();
  for (const { kind, value, event } of declarations) {
    const identity = key(kind, value.id), previous = entities.get(identity);
    const isProposal = proposalStatuses.has(text(value.status)?.toLowerCase());
    entities.set(identity, { kind, value: { ...(previous?.value ?? {}), ...structuredClone(value) }, firstProposal: previous?.firstProposal ?? (isProposal ? event : null),
      last: event, everProposed: Boolean(previous?.everProposed || isProposal) });
  }
  // Base-file records can predate the journal. Keep them only with explicit
  // chat identity or current source evidence; missing origin stays unknown.
  for (const [kind, values] of [['decision', project.decisions], ['item', project.items]]) for (const value of list(values)) {
    if (!compatible(value, project) || !text(value.id) || entities.has(key(kind, value.id))) continue;
    const known = list(value.sourceIds).map(id => allById.get(id)).filter(Boolean);
    if (!(value.sessionId === project.sessionId || sources(value.sourceIds).length) || known.some(event => !compatible(event, project))) continue;
    entities.set(key(kind, value.id), { kind, value: structuredClone(value), firstProposal: null, last: null, everProposed: proposalStatuses.has(text(value.status)?.toLowerCase()) });
  }
  const byIdentity = new Map();
  for (const [identity, { kind, value, firstProposal: first, last, everProposed }] of entities) {
    if (!everProposed) continue;
    const assessment = value.implementation, assessmentSources = sources(assessment?.sourceIds);
    const implementation = assessment && implementationStatuses.has(assessment.status) && assessmentSources.length && list(assessment.sourceIds).every(id => localById.has(id)) ? {
      status: assessment.status, completedText: text(assessment.completedText), remainingText: text(assessment.remainingText),
      provenance: provenances.has(assessment.provenance) ? assessment.provenance : 'agent_report', sourceIds: assessmentSources,
    } : { status: 'unknown', completedText: null, remainingText: null, provenance: 'unknown', sourceIds: [] };
    byIdentity.set(identity, { ...structuredClone(value), id: value.id, kind, entityType: kind, projectId: project.id, sessionId: project.sessionId,
      sourceIds: sources([...list(value.sourceIds), first?.id, last?.id]), provenance: provenances.has(value.provenance ?? last?.provenance) ? value.provenance ?? last.provenance : 'unknown',
      proposedBy: text(first?.actor), proposedAt: timestamp(first?.at), proposalSourceId: first?.id ?? null,
      implementation, disposition: 'suggested', choiceSourceId: null, plannedItemId: null,
    });
  }
  const plannedItems = new Map(), feedback = new Map(), statuses = new Map();
  const declarationsByEvent = new Map();
  for (const declaration of declarations) {
    const values = declarationsByEvent.get(declaration.event.id) ?? [];
    values.push(declaration); declarationsByEvent.set(declaration.event.id, values);
  }
  for (const event of events) {
    for (const { kind, value } of declarationsByEvent.get(event.id) ?? []) if (text(value.status)) statuses.set(key(kind, value.id), text(value.status).toLowerCase());
    if (scoped(event, project)) {
      const updates = event.kind === 'item_updated' ? [event.data?.item] : event.kind === 'review_group_recorded' ? list(event.data?.items) : event.kind === 'project_patch' ? list(event.data?.patch?.items) : [];
      for (const update of updates) if (update && plannedItems.has(update.id) && compatible(update, project)) {
        const previous = plannedItems.get(update.id);
        plannedItems.set(update.id, { ...previous, ...structuredClone(update), sourceProposalId: previous.sourceProposalId, sourceProposalKind: previous.sourceProposalKind, projectId: project.id, sessionId: project.sessionId });
      }
      if (event.kind === 'review_feedback_request' && event.data?.feedback?.id && compatible(event.data.feedback, project)) feedback.set(event.data.feedback.id, event.data.feedback);
      if (event.kind === 'review_feedback_status' && event.data?.status === 'queued') {
        const request = feedback.get(event.data.id);
        const changed = request?.requestVersion === 2 ? (request.intent === 'request_changes' ? list(request.affectedItemIds) : []) : list(request?.itemIds);
        for (const id of changed) if (plannedItems.has(id)) plannedItems.set(id, { ...plannedItems.get(id), status: 'in_progress', review: { outcome: 'changes_requested', note: request.note, at: event.at, feedbackId: request.id } });
      }
    }
    if (event.kind !== 'proposal_choice_recorded' || !scoped(event, project) || event.projectId !== project.id || event.provenance !== 'user' || event.actor !== 'You') continue;
    const value = event.data ?? {}, proposal = byIdentity.get(key(value.proposalKind, value.proposalId));
    if (!proposal || proposal.disposition === 'planned' || !['plan', 'later', 'dismiss', 'restore'].includes(value.choice) || value.proposalSourceId !== proposal.proposalSourceId || !proposal.proposalSourceId || event.source?.type !== 'flux_proposal' || event.source.ref !== proposal.proposalSourceId) continue;
    // A choice must begin while this identity is an actual proposal. Later
    // agent lifecycle updates cannot undo a choice already made by the user.
    if (!proposal.choiceSourceId && !proposalStatuses.has(statuses.get(key(proposal.kind, proposal.id)))) continue;
    if (value.choice === 'restore' && !['later', 'dismissed'].includes(proposal.disposition)) continue;
    if (value.choice === 'plan') {
      const item = value.item, id = plannedProposalItemId(project, proposal.kind, proposal.id);
      if (!item || item.id !== id || item.sourceProposalId !== proposal.id || item.sourceProposalKind !== proposal.kind || item.status !== 'pending' || item.projectId !== project.id || item.sessionId !== project.sessionId) continue;
      plannedItems.set(id, structuredClone(item));
      proposal.plannedItemId = id;
    }
    proposal.disposition = { plan: 'planned', later: 'later', dismiss: 'dismissed', restore: 'suggested' }[value.choice];
    proposal.choiceSourceId = event.id;
  }
  return { proposals: [...byIdentity.values()].filter(value => value.choiceSourceId || proposalStatuses.has(text(value.status)?.toLowerCase())), plannedItems: [...plannedItems.values()] };
}

const fail = (message, code = 409) => { throw new ContextError(message, code); };
export function chooseProposal(store, input, { sourceId } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !['proposalId', 'proposalKind', 'choice', 'expectedRevision'].includes(name)) || !text(input.proposalId) || input.proposalId.length > 4096 || !['decision', 'item'].includes(input.proposalKind) || !['plan', 'later', 'dismiss', 'restore'].includes(input.choice) || !text(input.expectedRevision)) fail('Choose a proposal, action and reviewed context revision.', 400);
  const lock = join(store.dataDir, 'proposal-choice.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('Proposal choices are locked or a previous lock needs manual recovery. Refresh and try again.'); throw error; }
  try {
    store.refresh();
    const snapshot = store.snapshot(), project = snapshot.project;
    if (!project.id || !project.sessionId || !project.sessions?.some(value => value.id === project.sessionId)) fail('An enrolled project and chat are required.');
    // Trusted local callers may attach the human instruction that authorized
    // bookkeeping. The browser input cannot supply this internal option.
    if (sourceId !== undefined && !snapshot.events.some(event => event.id === sourceId && scoped(event, project) && isHumanDirection(event))) fail('The choice needs a human instruction from this chat.', 400);
    const proposal = snapshot.proposals.find(value => value.id === input.proposalId && value.kind === input.proposalKind);
    if (!proposal || !proposal.proposalSourceId) fail('The original proposal is unavailable in this chat.', 404);
    const existing = proposal.plannedItemId && snapshot.project.items.find(item => item.id === proposal.plannedItemId);
    // The exact same plan intent is safe to repeat after its own write (or a
    // later journal update). Every other stale or changed payload fails closed.
    if (input.choice === 'plan' && proposal.disposition === 'planned' && existing) return { proposal, item: existing, event: snapshot.events.find(event => event.id === proposal.choiceSourceId) };
    if (input.expectedRevision !== snapshot.contextRevision) fail('The chat context changed. Refresh and review this idea again.');
    if (proposal.disposition === 'planned') fail('This idea is already planned. Manage its work item in Plan.');
    if (input.choice === 'plan' && !text(proposal.title)) fail('This idea needs a recorded title before it can be planned.');
    if (input.choice === 'restore' && !['later', 'dismissed'].includes(proposal.disposition)) fail('Only a deferred or dismissed idea can be restored.');
    if ((input.choice === 'later' && proposal.disposition === 'later') || (input.choice === 'dismiss' && proposal.disposition === 'dismissed')) fail('This idea already has that choice.');
    const eventId = `proposal-choice:${randomUUID()}`;
    const item = input.choice === 'plan' ? {
      id: plannedProposalItemId(project, proposal.kind, proposal.id), title: proposal.title, status: 'pending',
      purpose: proposal.rationale ?? proposal.purpose ?? '', projectId: project.id, sessionId: project.sessionId,
      sourceProposalId: proposal.id, sourceProposalKind: proposal.kind, sourceIds: [...new Set([...proposal.sourceIds, eventId, ...(sourceId ? [sourceId] : [])])], provenance: 'user',
    } : null;
    if (item && project.items.some(value => value.id === item.id)) fail('The linked work identity is already in use. Refresh and review Plan.');
    const event = store.append({ id: eventId, kind: 'proposal_choice_recorded', projectId: project.id, sessionId: project.sessionId,
      actor: 'You', provenance: 'user', summary: { plan: 'Idea added to plan', later: 'Idea saved for later', dismiss: 'Idea dismissed', restore: 'Idea restored' }[input.choice],
      source: { type: 'flux_proposal', ref: proposal.proposalSourceId },
      data: { proposalId: proposal.id, proposalKind: proposal.kind, proposalSourceId: proposal.proposalSourceId, choice: input.choice, ...(sourceId ? { intentSourceId: sourceId } : {}), ...(item ? { item } : {}) },
    });
    return { proposal: store.snapshot().proposals.find(value => value.id === proposal.id && value.kind === proposal.kind), item, event };
  } finally { rmdirSync(lock); }
}
