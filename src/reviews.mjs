import { DiagnosticError } from './diagnostics.mjs';

// A review changes work lifecycle, not the truth of a recorded test result.
export function reviewWork(store, input) {
  const snapshot = store.snapshot();
  if (input?.expectedRevision !== snapshot.contextRevision) throw new DiagnosticError('The work changed. Refresh and review it again.', 409);
  if (!['accepted', 'changes_requested'].includes(input?.outcome)) throw new DiagnosticError('Choose accepted or changes_requested.');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) throw new DiagnosticError('Review notes must be at most 2000 characters.');
  if (Array.isArray(input.itemIds)) {
    const ids = [...new Set(input.itemIds)];
    if (!ids.length || ids.length !== input.itemIds.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new DiagnosticError('Choose a unique group of 1–100 review items.');
    const ordered = [...ids].sort();
    if (typeof input.groupId !== 'string' || input.groupId !== `flux-ui-${groupHash(ordered)}`) throw new DiagnosticError('This grouped review is out of date. Refresh it before continuing.', 409);
    const work = ordered.map(id => snapshot.project.items.find(item => item.id === id));
    if (work.some(item => !item || item.status !== 'ready_for_review' && item.status !== 'ready-for-review' || item.sessionId && item.sessionId !== snapshot.project.sessionId)) {
      throw new DiagnosticError('One or more items are no longer in this group.', 409);
    }
    const at = new Date().toISOString();
    const review = { outcome: input.outcome, note: input.note?.trim() || '', at, groupId: input.groupId };
    const items = work.map(item => ({
      ...item,
      status: input.outcome === 'accepted' ? 'completed' : 'in_progress',
      review,
    }));
    return store.append({
      kind: 'review_group_recorded', actor: 'You', provenance: 'user', sessionId: snapshot.project.sessionId,
      summary: `${input.outcome === 'accepted' ? 'Accepted' : 'Changes requested'}: Flux interface update (${items.length} items)`,
      source: { type: 'user_review_group', ref: input.groupId },
      data: {
        reviewGroup: { id: input.groupId, itemIds: ordered, outcome: review.outcome, note: review.note, at },
        items,
      },
    });
  }
  const item = snapshot.project.items.find(value => value.id === input.itemId);
  if (!item || (item.sessionId && item.sessionId !== snapshot.project.sessionId)) throw new DiagnosticError('Work item not found in this chat.', 404);
  if (!['ready_for_review', 'ready-for-review'].includes(item.status)) throw new DiagnosticError('This item is no longer awaiting review.', 409);
  const at = new Date().toISOString();
  const review = { outcome: input.outcome, note: input.note?.trim() || '', at };
  return store.append({ kind: 'item_updated', actor: 'You', provenance: 'user', sessionId: snapshot.project.sessionId,
    summary: `${input.outcome === 'accepted' ? 'Accepted' : 'Changes requested'}: ${item.title}`, source: { type: 'user_review', ref: item.id },
    data: { item: { ...item, status: input.outcome === 'accepted' ? 'completed' : 'in_progress', review } } });
}

function groupHash(ids) {
  let hash = 2166136261;
  for (const char of ids.join('\n')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
