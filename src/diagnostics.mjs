import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compileContext, validateSources, inSession, ContextError as DiagnosticError } from './context.mjs';

const execute = promisify(execFile);
const dispatches = new WeakMap();
const cut = (value, length) => String(value ?? '').slice(0, length);
const words = value => String(value ?? '').trim().split(/\s+/).length;
export { DiagnosticError };

export function buildDiagnostic(snapshot, input, { id = randomUUID(), projectDir } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DiagnosticError('A diagnostic request must be an object.');
  if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1000) throw new DiagnosticError('Provide a question of 1–1000 characters.');
  if (input.dispatch !== undefined && typeof input.dispatch !== 'boolean') throw new DiagnosticError('dispatch must be a boolean.');
  if (input.expectedRevision !== snapshot.contextRevision && !(typeof input.expectedRevision === 'number' && input.expectedRevision === snapshot.revision)) throw new DiagnosticError('The plan or current instruction changed. Refresh and preview again.', 409, { revision: snapshot.revision, contextRevision: snapshot.contextRevision });
  const { recordIds } = validateSources(snapshot, input.recordIds);
  const selected = input.selectedItemId ? snapshot.project.items.find(item => item.id === input.selectedItemId && inSession(item, snapshot.project.sessionId)) : null;
  const baseline = input.baselinePlanId ? snapshot.project.plans.find(plan => plan.id === input.baselinePlanId && inSession(plan, snapshot.project.sessionId)) : null;
  if (input.selectedItemId && !selected) throw new DiagnosticError('The selected work item does not exist in this chat.');
  if (input.baselinePlanId && !baseline) throw new DiagnosticError('The selected plan does not exist in this chat.');
  const context = compileContext(snapshot, { id, mode: 'audit', question: input.question.trim(), recordIds, selectedItem: selected, baseline, projectDir });
  return { id, projectId: snapshot.project.id, sessionId: snapshot.project.sessionId, status: 'prepared', ...context, recordIds, question: input.question.trim(), selectedItemId: input.selectedItemId ?? null, baselinePlanId: input.baselinePlanId ?? null, baselineRevision: snapshot.revision, contextRevision: snapshot.contextRevision, dispatch: Boolean(input.dispatch) };
}

/** Uses argument arrays: prompt text is never interpreted by a shell. */
export async function queueWithCodex({ sessionId, prompt }) {
  return execute('codex', ['queue', '--thread', sessionId, '--message', prompt], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
}

export async function runDiagnostic(store, input, { queueCommand = queueWithCodex, projectDir } = {}) {
  const initial = store.snapshot();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DiagnosticError('A diagnostic request must be an object.');
  if (input.dispatch !== undefined && typeof input.dispatch !== 'boolean') throw new DiagnosticError('dispatch must be a boolean.');
  if (input.dispatch !== true) {
    if (input.requestId !== undefined) throw new DiagnosticError('A prepared request ID may only be used when dispatching.');
    const request = buildDiagnostic(initial, input, { projectDir });
    store.append({ id: `diagnostic-request:${request.id}`, kind: 'diagnostic_request', actor: 'Flux', provenance: 'user', sessionId: initial.project.sessionId,
      summary: request.question, source: { type: 'flux', ref: request.id }, data: { ...request, requestId: request.id } });
    return { ...request, revision: store.snapshot().revision };
  }
  if (typeof input.requestId !== 'string' || !input.requestId.trim()) throw new DiagnosticError('Dispatch requires a prepared diagnostic request ID.');
  const reviewed = initial.requests.find(record => record.id === input.requestId);
  if (!reviewed) throw new DiagnosticError('The prepared diagnostic request does not exist.', 404);
  const source = initial.events.find(event => event.id === reviewed.sourceEventId && event.kind === 'diagnostic_request');
  const project = initial.project;
  if (!project.id || !project.sessionId || !project.sessions?.some(session => session.id === project.sessionId)
      || !source || source.source?.type !== 'flux' || source.source.ref !== reviewed.id || source.sessionId !== project.sessionId
      || reviewed.sessionId && reviewed.sessionId !== project.sessionId || reviewed.projectId && reviewed.projectId !== project.id
      || source.projectId && source.projectId !== project.id) throw new DiagnosticError('The diagnostic belongs to another or ambiguous enrolled project or chat.', 404);
  if (input.question !== reviewed.question || JSON.stringify(input.recordIds) !== JSON.stringify(reviewed.recordIds)
      || (input.selectedItemId ?? null) !== (reviewed.selectedItemId ?? null) || (input.baselinePlanId ?? null) !== (reviewed.baselinePlanId ?? null)
      || input.expectedRevision === undefined || input.expectedRevision !== reviewed.contextRevision && input.expectedRevision !== reviewed.baselineRevision) {
    throw new DiagnosticError('The reviewed question or selected context changed. Preview again.', 409, { contextRevision: initial.contextRevision });
  }
  if (typeof reviewed.prompt !== 'string' || !reviewed.prompt) throw new DiagnosticError('The reviewed prompt is unavailable. Preview again.', 409);
  const request = { ...reviewed, dispatch: true };
  const pending = dispatches.get(store) ?? new Map();
  dispatches.set(store, pending);
  if (pending.has(request.id)) return pending.get(request.id);
  if (['queued', 'acknowledged', 'completed'].includes(request.status)) return { ...request, revision: initial.revision };
  if (request.status !== 'prepared') throw new DiagnosticError('Only a prepared diagnostic request can be queued. Preview again.', 409);
  if (reviewed.contextRevision !== initial.contextRevision) throw new DiagnosticError('The plan or current instruction changed. Refresh and preview again.', 409, { revision: initial.revision, contextRevision: initial.contextRevision });
  // Revalidate current membership and sources without regenerating the reviewed prompt.
  validateSources(initial, reviewed.recordIds);
  if (reviewed.selectedItemId && !project.items.some(item => item.id === reviewed.selectedItemId && inSession(item, project.sessionId)) ||
      reviewed.baselinePlanId && !project.plans.some(plan => plan.id === reviewed.baselinePlanId && inSession(plan, project.sessionId))) throw new DiagnosticError('The reviewed scope is no longer available. Preview again.', 409);
  // The prompt was frozen by preview. Coalesce repeated clicks while delivery is
  // pending; later retries use the persisted request status above.
  const dispatch = Promise.resolve().then(async () => {
    if (!initial.project.sessionId || !initial.project.sessions.some(session => session.id === initial.project.sessionId)) {
      request.status = 'failed'; request.error = 'No enrolled destination chat is configured.';
    } else {
      try {
        await queueCommand({ sessionId: initial.project.sessionId, prompt: request.prompt, requestId: request.id });
        request.status = 'queued';
      } catch (error) {
        request.status = 'failed'; request.error = cut(error.stderr || error.message || 'Codex could not queue the request.', 600);
      }
    }
    store.append({ id: `diagnostic-status:${request.id}`, kind: 'diagnostic_status', actor: 'Flux', provenance: 'observed', sessionId: initial.project.sessionId,
      summary: request.status === 'queued' ? 'Diagnostic queued; receipt and completion are not yet verified.' : `Delivery unconfirmed: ${request.error}`,
      source: { type: 'flux', ref: request.id }, data: { requestId: request.id, status: request.status, ...(request.error ? { error: request.error } : {}) } });
    return { ...request, revision: store.snapshot().revision };
  });
  pending.set(request.id, dispatch);
  try { return await dispatch; }
  finally { pending.delete(request.id); }
}

export function validateDiagnosticResult(result) {
  if (typeof result !== 'string' || !result.trim()) throw new DiagnosticError('A diagnostic result is required.');
  if (words(result) > 200) throw new DiagnosticError('A diagnostic result must be no more than 200 words.');
  return result.trim();
}
