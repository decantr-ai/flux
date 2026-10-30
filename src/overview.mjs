import { isHumanDirection, directionText } from './context.mjs';
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const concise = (value, maximum = 360) => {
  const text = string(value)?.replace(/\s+/g, ' ') ?? null;
  return text && text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
};
const timestamp = value => string(value) && Number.isFinite(Date.parse(value)) ? value : null;
const provenance = (value, fallback = 'unknown') => ['user', 'observed', 'agent_report', 'inferred'].includes(value) ? value : fallback;
const messageText = event => string(directionText(event));
const humanDirection = isHumanDirection;
const ACTIVE = new Set(['active', 'working', 'in_progress', 'in-progress', 'started', 'pending', 'waiting', 'blocked', 'queued', 'todo', 'open', 'claimed_complete', 'unverified', 'ready_for_review', 'ready-for-review']);
const PARKED = new Set(['parked', 'deferred', 'shelved', 'paused', 'on_hold', 'on-hold']);
const PROPOSALS = new Set(['proposal', 'proposed', 'suggested', 'idea', 'optional']);
const CLOSED = new Set(['done', 'complete', 'completed', 'verified', 'verified_complete', 'superseded', 'cancelled', 'canceled', 'abandoned']);

function eventCategory(event) {
  if (humanDirection(event)) return 'direction';
  if (['message.assistant', 'assistant_message'].includes(event.kind)) {
    return ['final', 'final_answer'].includes(event.data?.channel) ? 'report' : null;
  }
  if (['plan_saved', 'checkpoint_saved', 'checkpoint'].includes(event.kind)) return 'checkpoint';
  if (event.kind === 'decision_recorded') return 'decision';
  if (event.kind === 'proposal_choice_recorded') return 'decision';
  if (event.kind === 'question_recorded') return 'question';
  if (event.kind === 'question_resolved') return 'reply';
  if (event.kind === 'item_updated') return 'work';
  if (event.kind === 'review_group_recorded') return 'work';
  if (event.kind === 'goal_updated' || event.kind === 'focus_updated') return 'update';
  if (event.kind === 'project_patch' && ['focus', 'goal', 'items', 'plans', 'decisions', 'latestIntent'].some(key => Object.hasOwn(event.data?.patch ?? {}, key))) return 'update';
  if (/^verification(?:[._]|$)/.test(event.kind) || ['test_result', 'test.result'].includes(event.kind)) return 'verification';
  if (/^artifact(?:[._]|$)/.test(event.kind)) return 'artifact';
  if (event.kind === 'diagnostic_result') return 'answer';
  if (event.kind === 'review_feedback_status' && event.data?.status === 'queued') return 'answer';
  return null;
}

/**
 * Project explicit work records into a concise overview without changing them.
 * Journal order determines which human direction follows a focus anchor; clocks,
 * assistant messages, tool lifecycle and historical checkpoints cannot do so.
 * A missing or foreign anchor leaves current work unknown. All sourceIds refer
 * to existing records in the selected session or to unscoped project records.
 */
export function buildOverview(snapshot = {}, { sessionId } = {}) {
  const project = snapshot?.project ?? {};
  const selectedId = string(sessionId) ?? string(project.sessionId);
  const inScope = value => !string(value?.sessionId) || value.sessionId === selectedId;
  const events = list(snapshot?.events).filter(event => event && typeof event === 'object' && inScope(event) && (!['question_recorded','question_resolved'].includes(event.kind) || event.projectId === project.id));
  const byId = new Map(events.filter(event => string(event.id)).map(event => [event.id, event]));
  const allById = new Map(list(snapshot?.events).filter(event => string(event?.id)).map(event => [event.id, event]));
  const sources = ids => [...new Set(list(ids).filter(id => typeof id === 'string' && byId.has(id)))];
  const unknowns = [];
  const card = (text = null, options = {}) => ({
    text: concise(text), status: options.status ?? (string(text) ? 'recorded' : 'unknown'),
    sourceIds: sources(options.sourceIds), provenance: provenance(options.provenance), at: timestamp(options.at),
  });
  const latest = predicate => [...events].reverse().find(predicate);
  const session = list(project.sessions).find(value => value.id === selectedId);
  if (!selectedId || !session) unknowns.push('session');

  const goalValue = typeof project.goal === 'object' && project.goal ? project.goal : { text: project.goal };
  const goalText = string(goalValue.text) ?? string(goalValue.title);
  const goalEvent = latest(event => event.kind === 'goal_updated' && event.data?.goal === goalText
    || event.kind === 'project_patch' && event.data?.patch?.goal === goalText && goalText);
  const goal = card(concise(goalText, 240), {
    status: goalText ? 'declared' : 'unknown',
    sourceIds: [...list(goalValue.sourceIds), ...list(project.goalSourceIds), project.goalSourceId, ...(goalEvent ? [goalEvent.id] : [])],
    provenance: goalValue.provenance ?? goalEvent?.provenance,
    at: goalValue.at ?? goalEvent?.at,
  });
  if (!goal.text) unknowns.push('goal');
  if (goal.text && !goal.sourceIds.length) unknowns.push('goal_sources');

  const latestHuman = latest(humanDirection);
  const direction = card(messageText(latestHuman ?? {}), {
    status: latestHuman ? 'current' : 'unknown', sourceIds: latestHuman ? [latestHuman.id] : [],
    provenance: latestHuman ? 'user' : 'unknown', at: latestHuman?.at,
  });
  if (!direction.text) unknowns.push('direction');
  if (direction.text && !direction.at) unknowns.push('direction_time');

  const storedFocus = project.focus && typeof project.focus === 'object' && !Array.isArray(project.focus) ? project.focus : null;
  const focusInScope = storedFocus && inScope(storedFocus)
    && (string(storedFocus.sessionId) || !string(project.sessionId) || project.sessionId === selectedId);
  const anchor = focusInScope ? byId.get(storedFocus.intentSourceId) : null;
  const validAnchor = anchor && humanDirection(anchor);
  const newerDirection = validAnchor && latestHuman && events.indexOf(latestHuman) > events.indexOf(anchor);
  const focusStatus = !focusInScope || !validAnchor ? 'unknown' : newerDirection ? 'needs_update' : 'current';
  const whyValue = typeof storedFocus?.why === 'object' && storedFocus.why ? storedFocus.why : { text: storedFocus?.why };
  const nextValue = typeof storedFocus?.next === 'object' && storedFocus.next ? storedFocus.next : { text: storedFocus?.next };
  const focusSourceIds = focusInScope ? sources(storedFocus.sourceIds) : [];
  const focus = {
    status: focusStatus, title: focusInScope ? concise(storedFocus.title) : null,
    workStatus: focusInScope ? string(storedFocus.status) : null,
    why: focusInScope ? concise(whyValue.text) : null,
    next: { text: focusInScope ? concise(nextValue.text) : null, status: focusInScope ? string(nextValue.status) ?? 'unknown' : 'unknown' },
    sourceIds: focusSourceIds, intentSourceId: validAnchor ? anchor.id : null,
    updatedAt: focusInScope ? timestamp(storedFocus.updatedAt) : null,
  };
  if (focusStatus === 'unknown') unknowns.push('focus');
  if (focusInScope && !validAnchor) unknowns.push('focus_anchor');
  if (focusInScope && !focus.updatedAt) unknowns.push('focus_time');

  let now = card(), why = card(), next = card();
  // Keep the last anchored checkpoint readable while a newer request awaits
  // reconciliation. It is history, never permission to resume obsolete work.
  if (focusStatus === 'current' || focusStatus === 'needs_update') {
    now = card(storedFocus.title, { status: string(storedFocus.status) ?? 'unknown', sourceIds: focusSourceIds, provenance: storedFocus.provenance ?? 'agent_report', at: storedFocus.updatedAt });
    why = card(whyValue.text, { sourceIds: whyValue.sourceIds ?? focusSourceIds, provenance: whyValue.provenance ?? 'agent_report', at: storedFocus.updatedAt });
    next = card(nextValue.text, { status: string(nextValue.status) ?? 'unknown', sourceIds: nextValue.sourceIds ?? focusSourceIds, provenance: nextValue.provenance ?? 'agent_report', at: storedFocus.updatedAt });
  }
  // Empty fields stay unknown even when other focus fields were supplied.
  for (const [name, value] of Object.entries({ now, why, next })) {
    if (!value.text) { value.status = 'unknown'; value.provenance = 'unknown'; value.sourceIds = []; unknowns.push(name); }
  }

  const entityInScope = entity => {
    if (!entity || !inScope(entity)) return false;
    const knownSources = list(entity.sourceIds).map(id => allById.get(id)).filter(Boolean);
    return !knownSources.length || knownSources.some(inScope);
  };
  const sanitize = value => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'sourceIds' ? sources(child) : sanitize(child)]));
  };
  const entityRecord = (entity, kind, key) => {
    const event = latest(value => value.kind === kind && value.data?.[key]?.id === entity.id
      || key === 'item' && value.kind === 'review_group_recorded' && value.data?.items?.some(item => item.id === entity.id));
    return {
      ...sanitize(structuredClone(entity)),
      entityType: key,
      at: timestamp(entity.at ?? event?.at), status: string(entity.status) ?? 'unknown',
      sourceIds: sources([...list(entity.sourceIds), ...(event ? [event.id] : [])]),
      provenance: provenance(entity.provenance ?? event?.provenance),
      ...(key === 'decision' && entity.rationale ? { rationaleProvenance: provenance(entity.rationaleProvenance, 'agent_report') } : {}),
    };
  };
  const evidenceFor = record => {
    const ids = sources(record.sourceIds);
    const checks = ids.filter(id => /^(verification|test[._]result)/.test(byId.get(id)?.kind || '') && byId.get(id)?.provenance === 'observed');
    return { kind: checks.length ? 'checks_recorded' : ids.length ? 'reported' : 'not_linked', sourceIds: checks };
  };
  const openWork = { active: [], parked: [], proposals: [], unknown: [] };
  const closedItems = [];
  const workItems = [];
  for (const item of list(project.items).filter(entityInScope)) {
    const record = entityRecord(item, 'item_updated', 'item');
    record.evidence = evidenceFor(record);
    workItems.push(record);
    const status = record.status.toLowerCase();
    if (CLOSED.has(status)) { closedItems.push(record); continue; }
    const group = PARKED.has(status) ? 'parked' : PROPOSALS.has(status) ? 'proposals' : ACTIVE.has(status) ? 'active' : 'unknown';
    openWork[group].push(record);
  }
  const decisions = list(project.decisions).filter(entityInScope).map(decision => entityRecord(decision, 'decision_recorded', 'decision'));
  openWork.proposals.push(...decisions.filter(decision => PROPOSALS.has(decision.status.toLowerCase())));
  if (Array.isArray(snapshot.proposals)) {
    openWork.proposals = snapshot.proposals.filter(value => value.sessionId === selectedId && value.projectId === project.id).map(value => ({ ...sanitize(structuredClone(value)), entityType: value.kind }));
  }

  const meaningfulEvents = [...events].reverse().flatMap(event => {
    const category = eventCategory(event);
    if (!category || !byId.has(event.id)) return [];
    return [{
      id: event.id, at: timestamp(event.at), kind: event.kind, category,
      actor: string(event.actor), sessionId: string(event.sessionId),
      summary: concise(event.summary ?? event.text), text: string(event.text),
      source: event.source ? structuredClone(event.source) : null,
      sourceIds: [event.id], provenance: provenance(event.provenance),
    }];
  });
  return {
    session: { id: selectedId, title: string(session?.title), status: session ? 'known' : 'unknown' },
    goal, direction, focus, now, why, next, openWork, workItems, events: meaningfulEvents,
    history: {
      plans: list(project.plans).filter(entityInScope).map(plan => {
        const record = entityRecord(plan, 'plan_saved', 'plan');
        record.steps = list(record.steps).map(step => {
          const own = sources(step.sourceIds);
          const value = { ...step, sourceIds: own.length ? own : record.sourceIds, evidenceScope: own.length ? 'step' : 'checkpoint', provenance: step.provenance ?? record.provenance };
          value.evidence = evidenceFor(value);
          return value;
        });
        return record;
      }),
      decisions,
      items: closedItems,
    },
    unknowns,
  };
}
