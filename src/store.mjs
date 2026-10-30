import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { latestHuman, directionText } from './context.mjs';
import { projectIncomingQuestions } from './incoming-questions.mjs';
import { markVerifiedAnswerMessages, projectAnswerSubmissions } from './answer-submissions.mjs';
import { projectProposals } from './proposals.mjs';

const clone = value => structuredClone(value);
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stableValue(value[key])]));
  return value;
};
const contextVersion = (project, events, incomingQuestions, answerHolds, proposals) => {
  const latestUser = latestHuman({ project, events });
  const state = { project, incomingQuestions, answerHolds, proposals, latestUser: latestUser ? { id: latestUser.id, text: directionText(latestUser) } : null };
  return `context:${createHash('sha256').update(JSON.stringify(stableValue(state))).digest('hex')}`;
};
const emptyProject = () => ({ id: 'flux', title: 'Flux', goal: '', sessionId: null, sessions: [], items: [], plans: [], decisions: [], constraints: [] });
const upsert = (list, value) => {
  if (!value?.id) return list;
  const index = list.findIndex(item => item.id === value.id);
  return index < 0 ? [...list, clone(value)] : list.map((item, i) => i === index ? { ...item, ...clone(value) } : item);
};

/** Persistent event facts; only explicit semantic events change plan projections. */
export function createStore(dataDir) {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const journalPath = join(directory, 'events.jsonl');
  const projectPath = join(directory, 'project.json');
  let base = emptyProject();
  let projectRevision = 0;
  if (existsSync(projectPath)) {
    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    base = { ...base, ...(saved.project ?? saved) };
    projectRevision = saved.projectRevision ?? 0;
  }
  const journal = [];
  const ids = new Map();
  if (existsSync(journalPath)) {
    const raw = readFileSync(journalPath, 'utf8');
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let event;
      try { event = JSON.parse(lines[index]); }
      catch (error) {
        // A process can stop midway through its final append. Preserve that fragment,
        // delimit it before the next append, and ignore it in the projection.
        if (index === lines.length - 1 && !raw.endsWith('\n')) continue;
        throw new Error(`Invalid journal record at line ${index + 1}: ${error.message}`);
      }
      if (!event.id || ids.has(event.id)) continue;
      journal.push(event);
      ids.set(event.id, event);
    }
    // Preserve incomplete journal bytes in a recovery file so a subsequent append
    // cannot turn the fragment into a corrupt middle record.
    if (raw && !raw.endsWith('\n')) {
      const tail = lines.at(-1);
      try { JSON.parse(tail); appendFileSync(journalPath, '\n', { mode: 0o600 }); }
      catch {
        writeFileSync(join(directory, `recovery-${randomUUID()}.txt`), tail, { mode: 0o600 });
        writeFileSync(journalPath, raw.slice(0, raw.lastIndexOf('\n') + 1), { mode: 0o600 });
      }
    }
  }
  const listeners = new Set();
  const revision = () => projectRevision + journal.length;
  const notify = () => { for (const listener of listeners) { try { listener(revision()); } catch {} } };
  const signature = path => {
    try { const stat = statSync(path, { bigint: true }); return `${stat.mtimeNs}:${stat.size}`; }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  let journalSignature = signature(journalPath);
  let projectSignature = signature(projectPath);

  function refresh() {
    let changed = false;
    const nextProjectSignature = signature(projectPath);
    if (nextProjectSignature !== projectSignature && nextProjectSignature) {
      const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
      base = { ...emptyProject(), ...(saved.project ?? saved) };
      projectRevision = saved.projectRevision ?? 0;
      projectSignature = nextProjectSignature;
      changed = true;
    }
    const nextJournalSignature = signature(journalPath);
    if (nextJournalSignature !== journalSignature && nextJournalSignature) {
      const raw = readFileSync(journalPath, 'utf8');
      const lines = raw.split('\n');
      const next = [], nextIds = new Map();
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        let event;
        try { event = JSON.parse(lines[index]); }
        catch (error) {
          if (index === lines.length - 1 && !raw.endsWith('\n')) continue;
          throw new Error(`Invalid journal record at line ${index + 1}: ${error.message}`);
        }
        if (event.id && !nextIds.has(event.id)) { next.push(event); nextIds.set(event.id, event); }
      }
      journal.splice(0, journal.length, ...next);
      ids.clear(); for (const [id, event] of nextIds) ids.set(id, event);
      journalSignature = nextJournalSignature;
      changed = true;
    }
    if (changed) notify();
    return changed;
  }

  function append(input) {
    refresh();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Event must be an object');
    if (input.id && ids.has(input.id)) return clone(ids.get(input.id));
    const event = clone({ ...input, id: input.id ?? randomUUID(), at: input.at ?? new Date().toISOString() });
    if (typeof event.kind !== 'string' || !event.kind) throw new TypeError('Event kind is required');
    appendFileSync(journalPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    // Reload the journal after appending so another process's concurrent append
    // cannot be hidden behind this process's latest file signature.
    refresh();
    return clone(event);
  }

  function snapshot() {
    refresh();
    let project = clone(base);
    const requests = new Map();
    const reviewGroups = new Map();
    const reviewFeedback = new Map();
    let coverageEvent;
    let lastTranscript;
    let lastHook;
    let imported = 0;
    for (const event of journal) {
      const data = event.data ?? {};
      if (event.kind === 'project_patch' && data.patch) project = { ...project, ...clone(data.patch) };
      if (event.kind === 'plan_saved' && data.plan) project.plans = upsert(project.plans ?? [], data.plan);
      if (event.kind === 'decision_recorded' && data.decision) project.decisions = upsert(project.decisions ?? [], data.decision);
      if (event.kind === 'item_updated' && data.item) project.items = upsert(project.items ?? [], data.item);
      if (event.kind === 'review_group_recorded' && data.reviewGroup && Array.isArray(data.items)) {
        project.items = data.items.reduce((list, item) => upsert(list, item), project.items ?? []);
        reviewGroups.set(data.reviewGroup.id, clone(data.reviewGroup));
      }
      if (event.kind === 'goal_updated' && typeof data.goal === 'string') project.goal = data.goal;
      if (event.kind === 'diagnostic_request') requests.set(data.requestId ?? event.id, {
        ...clone(data), id: data.requestId ?? event.id, at: event.at, status: data.status ?? 'prepared', sourceEventId: event.id,
      });
      if (event.kind === 'diagnostic_status') {
        const request = requests.get(data.requestId ?? data.id);
        if (request && request.status !== 'completed' && ['prepared', 'queued', 'failed', 'acknowledged'].includes(data.status)) Object.assign(request, clone(data), { updatedAt: event.at });
      }
      if (event.kind === 'diagnostic_result') {
        const request = requests.get(data.requestId ?? data.id);
        if (request && (typeof data.result === 'string' || typeof data.text === 'string')) {
          Object.assign(request, { status: 'completed', result: data.result ?? data.text, resultSourceId: event.id, updatedAt: event.at });
        }
      }
      if (event.kind === 'review_feedback_request' && data.feedback?.id) reviewFeedback.set(data.feedback.id, clone(data.feedback));
      if (event.kind === 'review_feedback_status') {
        const feedback = reviewFeedback.get(data.id);
        if (feedback) {
          Object.assign(feedback, clone(data), { updatedAt: event.at });
          if (data.status === 'queued') {
            const changed = new Set(feedback.requestVersion === 2 ? (feedback.intent === 'request_changes' && Array.isArray(feedback.affectedItemIds) ? feedback.affectedItemIds : []) : (feedback.itemIds ?? []));
            project.items = (project.items ?? []).map(item => changed.has(item.id) ? {
              ...item,
              status: 'in_progress',
              review: { outcome: 'changes_requested', note: feedback.note, at: event.at, feedbackId: feedback.id },
            } : item);
          }
        }
      }
      if (['coverage', 'coverage_updated'].includes(event.kind)) coverageEvent = event;
      if (event.source?.type === 'transcript' && !['coverage', 'coverage_updated'].includes(event.kind)) { imported++; lastTranscript = event; }
      if (event.source?.type === 'hook' || event.kind === 'native_hook') lastHook = event;
    }
    const coverage = {
      ...(coverageEvent?.data ?? {}),
      adapter: coverageEvent?.data?.adapter ?? (lastTranscript ? 'local transcript' : 'manual journal'),
      versionDependent: Boolean(lastTranscript) || Boolean(coverageEvent?.data?.versionDependent),
      importedEvents: imported,
      lastImportedAt: lastTranscript?.at ?? coverageEvent?.at ?? null,
      lastUpdateAt: journal.at(-1)?.at ?? null,
      source: coverageEvent?.data?.source ?? lastTranscript?.source?.ref ?? null,
      nativeHooksActive: Boolean(lastHook),
      lastHookAt: lastHook?.at ?? null,
      notes: lastTranscript ? ['Captures public messages, tool metadata, and allowlisted question titles, options and public replies from the enrolled local transcript.'] : ['No local transcript events have been imported yet.'],
    };
    // Rebuild legacy question items in the selected session. General project
    // projection predates session isolation and can otherwise merge foreign
    // item updates with the same id into the selected chat.
    let questionItems = clone(base.items ?? []);
    const legacyFlagged = new Map();
    const rememberFlagged = (item, eventId) => {
      if (!item?.id || item.requiresUserDecision !== true || (item.sessionId && item.sessionId !== project.sessionId) || (item.projectId && item.projectId !== project.id)) return;
      legacyFlagged.set(item.id, eventId || null);
    };
    for (const item of questionItems) rememberFlagged(item);
    for (const event of journal) {
      if ((event.sessionId && event.sessionId !== project.sessionId) || (event.projectId && event.projectId !== project.id)) continue;
      const data = event.data ?? {};
      if (event.kind === 'project_patch' && Array.isArray(data.patch?.items)) {
        questionItems = clone(data.patch.items);
        for (const item of questionItems) rememberFlagged(item, event.id);
      }
      if (event.kind === 'item_updated' && data.item) {
        rememberFlagged(data.item, event.id);
        questionItems = upsert(questionItems, data.item);
      }
      if (event.kind === 'review_group_recorded' && Array.isArray(data.items)) {
        for (const item of data.items) rememberFlagged(item, event.id);
        questionItems = data.items.reduce((items, item) => upsert(items, item), questionItems);
      }
    }
    const { proposals, plannedItems } = projectProposals(project, journal);
    // Scoped replay includes later ordinary edits and reviews of linked work.
    for (const item of plannedItems) project.items = upsert(project.items, item);
    const incomingQuestions = projectIncomingQuestions({ ...project, items: questionItems }, journal, { legacyFlagged });
    const { answerSubmissions, answerHolds } = projectAnswerSubmissions(journal, project);
    const projectedEvents = markVerifiedAnswerMessages(clone(journal), answerSubmissions);
    return { project, proposals, proposalActions: { available: true }, incomingQuestions, answerSubmissions, answerHolds, answerTransport: { mode: 'chat_message', available: true, nativeWidgetSync: false }, events: projectedEvents, requests: [...requests.values()], reviewGroups: [...reviewGroups.values()], reviewFeedback: [...reviewFeedback.values()], revision: revision(), contextRevision: contextVersion(project, projectedEvents, incomingQuestions, answerHolds, proposals), coverage };
  }

  function setProject(input) {
    refresh();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Project must be an object');
    const next = { ...emptyProject(), ...clone(input) };
    if (JSON.stringify(next) === JSON.stringify(base)) return clone(base);
    const nextRevision = projectRevision + 1;
    const temporary = `${projectPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ project: next, projectRevision: nextRevision }, null, 2), { mode: 0o600 });
    renameSync(temporary, projectPath);
    base = next;
    projectRevision = nextRevision;
    projectSignature = signature(projectPath);
    notify();
    return clone(base);
  }

  return { append, events: () => { refresh(); return clone(journal); }, snapshot, setProject, refresh, dataDir: directory,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
