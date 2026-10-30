// Projection of explicit question evidence. Identity is exact and session-scoped;
// similar wording never merges questions.
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const normalizeStatus = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
const terminal = new Map([['done','resolved'],['complete','resolved'],['completed','resolved'],['verified','resolved'],['verified_complete','resolved'],['resolved','resolved'],['superseded','superseded'],['cancelled','cancelled'],['canceled','cancelled'],['abandoned','cancelled'],['replied','replied']]);
export const questionId = (projectId, sessionId, origin, id) => `incoming:${JSON.stringify([projectId, sessionId, origin, id])}`;

export function projectIncomingQuestions(project = {}, events = [], { legacyFlagged = new Map() } = {}) {
  const sessionId = text(project.sessionId);
  const projectId = text(project.id);
  if (!sessionId || !projectId) return { pending: [], history: [] };
  const scoped = events.filter(event => event?.sessionId === sessionId && (!event.projectId || event.projectId === projectId));
  const byId = new Map(scoped.filter(event => text(event.id)).map(event => [event.id, event]));
  const allById = new Map(events.filter(event => text(event?.id)).map(event => [event.id, event]));
  const sources = ids => [...new Set(list(ids).filter(id => typeof id === 'string' && byId.has(id)))];
  const questions = new Map();
  for (const item of list(project.items)) {
    if (!item || (item.sessionId && item.sessionId !== sessionId) || (item.projectId && item.projectId !== projectId)) continue;
    const previousFlag = scoped.findLast(event => event.kind === 'item_updated' && event.data?.item?.id === item.id && event.data.item.requiresUserDecision === true);
    const cleared = item.requiresUserDecision === false && (Boolean(previousFlag) || legacyFlagged.has(item.id));
    if (item.requiresUserDecision !== true && !cleared) continue;
    const known = list(item.sourceIds).map(id => allById.get(id)).filter(Boolean);
    if (known.some(event => event.sessionId !== sessionId || (event.projectId && event.projectId !== projectId))) continue;
    if (!text(item.id) || !text(item.title)) continue;
    const status = cleared ? 'resolved' : terminal.get(normalizeStatus(item.status)) || 'pending';
    const id = questionId(projectId, sessionId, 'work_item', item.id);
    const itemEvent = scoped.findLast(event => event.kind === 'item_updated' && event.data?.item?.id === item.id);
    questions.set(id, { id, projectId, sessionId, text: item.title, status, origin: 'work_item', sourceItemId: item.id, sourceIds: sources([...list(item.sourceIds), previousFlag?.id, legacyFlagged.get(item.id), itemEvent?.id]), ...(item.at ? { askedAt: item.at } : {}), ...(item.provenance ? { provenance: item.provenance } : {}) });
  }
  for (const event of scoped) {
    if (event.kind !== 'question_recorded' || event.projectId !== projectId) continue;
    const q = event.data?.question;
    if (!q || !text(q.id) || !text(q.text) || !['codex_tool','recorded'].includes(q.origin) || (q.projectId && q.projectId !== projectId) || (q.sessionId && q.sessionId !== sessionId)) continue;
    const id = questionId(projectId, sessionId, q.origin, q.id);
    const status = 'pending';
    if (questions.has(id)) continue;
    questions.set(id, { id, projectId, sessionId, text: q.text, status, origin: q.origin, sourceIds: sources([event.id, ...list(q.sourceIds)]), askedAt: event.at, ...(Array.isArray(q.options) ? { options: q.options.filter(option => typeof option === 'string') } : {}), provenance: event.provenance || 'unknown' });
  }
  // Resolve only by exact identity. A reply seen before its call can be retained
  // safely and applied when that same tuple is later available on replay.
  for (const event of scoped) {
    if (event.kind !== 'question_resolved' || event.projectId !== projectId) continue;
    const r = event.data?.resolution;
    if (!r || (r.projectId && r.projectId !== projectId) || (r.sessionId && r.sessionId !== sessionId)) continue;
    const id = r?.questionId || (r?.origin && r?.id ? questionId(projectId, sessionId, r.origin, r.id) : null);
    const q = questions.get(id);
    if (!q || (r.questionText && r.questionText !== q.text)) continue;
    const status = terminal.get(normalizeStatus(r.status));
    if (!status || (status === 'replied' && !text(r.answer))) continue;
    for (const key of ['answer','reason','resolutionNote']) delete q[key];
    Object.assign(q, { status, updatedAt: event.at, resolutionSourceIds: sources([event.id, ...list(r.sourceIds)]), resolutionProvenance: event.provenance || 'unknown' });
    for (const key of ['answer','reason','resolutionNote']) if (text(r[key])) q[key] = r[key];
  }
  const values = [...questions.values()];
  return { pending: values.filter(q => q.status === 'pending'), history: values.filter(q => q.status !== 'pending') };
}

export function validateQuestionInput(input, snapshot, resolving = false) {
  const sessionId = text(snapshot.project?.sessionId);
  if (!sessionId || !snapshot.project?.sessions?.some(session => session.id === sessionId)) throw new Error('An enrolled current session is required');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Question input must be an object');
  if ((input.projectId !== undefined && input.projectId !== snapshot.project.id) || (input.sessionId !== undefined && input.sessionId !== sessionId)) throw new Error('Question project or session does not match the current chat');
  const sourceIds = list(input.sourceIds);
  const validSources = new Set(list(snapshot.events).filter(event => event.sessionId === sessionId && (!event.projectId || event.projectId === snapshot.project.id)).map(event => event.id));
  if (!sourceIds.length || sourceIds.some(id => typeof id !== 'string' || !validSources.has(id))) throw new Error('sourceIds must refer to records in the current session');
  if (!text(input.id) || (!resolving && input.id.length > 500) || (resolving && input.id.length > 4096)) throw new Error('A valid question id is required');
  if (!resolving) {
    if (!text(input.text) || input.text.length > 4000) throw new Error('Question text is required (maximum 4000 characters)');
    if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 20 || input.options.some(value => !text(value) || value.length > 500))) throw new Error('Options must be nonempty strings');
    const existing = [...snapshot.incomingQuestions.pending, ...snapshot.incomingQuestions.history].find(q => q.id === questionId(snapshot.project.id, sessionId, 'recorded', input.id));
    if (existing && (existing.text !== input.text || JSON.stringify(existing.options ?? []) !== JSON.stringify(input.options ?? []))) throw new Error('Question id already exists with different content');
    if (existing) return { existing };
    return { id: input.id, text: input.text, origin: 'recorded', sourceIds, ...(input.options ? { options: input.options } : {}) };
  }
  const known = [...snapshot.incomingQuestions.pending, ...snapshot.incomingQuestions.history].find(q => q.id === input.id);
  if (!known) throw new Error('Unknown question id in current session');
  if (!['replied','resolved','cancelled','superseded'].includes(input.status)) throw new Error('Resolution status must be replied, resolved, cancelled, or superseded');
  for (const key of ['answer','reason','resolutionNote']) if (input[key] !== undefined && (!text(input[key]) || input[key].length > 4000)) throw new Error(`${key} must be nonempty and at most 4000 characters`);
  if (input.status === 'replied' && !text(input.answer)) throw new Error('A reply requires an answer');
  if (input.answer && !list(snapshot.events).some(event => sourceIds.includes(event.id) && event.kind === 'message.user' && event.provenance === 'user' && typeof event.text === 'string' && event.text.includes(input.answer))) throw new Error('Answer must appear in a source-linked human message');
  if (input.status !== 'replied' && !text(input.reason) && !text(input.resolutionNote) && !text(input.answer)) throw new Error('Closure requires a reason, note, or source-linked answer');
  return { questionId: input.id, status: input.status, sourceIds, ...Object.fromEntries(['answer','reason','resolutionNote'].filter(key => input[key] !== undefined).map(key => [key,input[key]])) };
}
