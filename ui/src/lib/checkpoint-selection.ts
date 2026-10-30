import { comparablePlans } from './helpers'
import type { FluxSnapshot, Plan } from './types'

export interface CheckpointScope { projectId: string; sessionId: string }
export interface CheckpointSelection extends CheckpointScope { mode: 'follow_latest' | 'pinned'; pinnedId: string; baselineId: string }
export const checkpointScopeKey = (scope: CheckpointScope) => JSON.stringify([scope.projectId, scope.sessionId])
export const followLatest = (scope: CheckpointScope): CheckpointSelection => ({ ...scope, mode: 'follow_latest', pinnedId: '', baselineId: '' })
export const scopedCheckpointSelection = (selection: CheckpointSelection, scope: CheckpointScope) => checkpointScopeKey(selection) === checkpointScopeKey(scope) ? selection : followLatest(scope)
export const checkpointCatalog = (snapshot: FluxSnapshot) => snapshot.overview.history.plans.filter(plan => (!plan.sessionId || plan.sessionId === snapshot.project.sessionId) && (!plan.projectId || plan.projectId === snapshot.project.id))
export function chooseCheckpoint(selection: CheckpointSelection, scope: CheckpointScope, id: string | null): CheckpointSelection {
  const current = scopedCheckpointSelection(selection, scope)
  return id === null ? { ...current, mode: 'follow_latest', pinnedId: '' } : { ...current, mode: 'pinned', pinnedId: id }
}
export function resolveCheckpoint(selection: CheckpointSelection, plans: Plan[]) {
  const latest = plans.at(-1)
  const checkpoint = selection.mode === 'follow_latest' ? latest : plans.find(plan => plan.id === selection.pinnedId)
  return { latest, checkpoint, missing: selection.mode === 'pinned' && !checkpoint, newerAvailable: selection.mode === 'pinned' && Boolean(latest && latest.id !== selection.pinnedId) }
}
export function resolveBaseline(selection: CheckpointSelection, plans: Plan[], after: Plan | undefined) {
  const afterIndex = plans.findIndex(plan => plan.id === after?.id)
  const candidates = plans.slice(0, Math.max(0, afterIndex)).filter(plan => comparablePlans(plan, after))
  const before = selection.baselineId ? candidates.find(plan => plan.id === selection.baselineId) : candidates.at(-1)
  return { candidates, before, unavailable: Boolean(selection.baselineId && !before) }
}
export const checkpointOption = (id: string) => `checkpoint:${JSON.stringify(id)}`
export function checkpointOptionId(value: string): string | null {
  if (value === 'latest') return null
  if (!value.startsWith('checkpoint:')) throw new Error('Unknown checkpoint option')
  const id: unknown = JSON.parse(value.slice('checkpoint:'.length))
  if (typeof id !== 'string') throw new Error('Unknown checkpoint identity')
  return id
}

export const snapshotIsFresh = (current: Pick<FluxSnapshot, 'project' | 'revision'> | null, next: Pick<FluxSnapshot, 'project' | 'revision'>) => !current || checkpointScopeKey({ projectId: current.project.id, sessionId: current.project.sessionId }) !== checkpointScopeKey({ projectId: next.project.id, sessionId: next.project.sessionId }) || next.revision >= current.revision
