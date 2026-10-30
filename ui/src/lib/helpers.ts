import type { FluxSnapshot, GroupReview, Plan, Provenance, ReviewFeedbackDraft, ReviewOutcome, WorkItem } from './types'

export const TABS = [
  { id: 'overview', label: 'Overview', icon: 'house' },
  { id: 'plan', label: 'Plan', icon: 'list-checks' },
  { id: 'timeline', label: 'Timeline', icon: 'clock-3' },
  { id: 'changes', label: 'Changes', icon: 'git-compare-arrows' },
  { id: 'decisions', label: 'Decisions', icon: 'messages-square' },
  { id: 'context', label: 'Context', icon: 'files' },
] as const

export type TabId = typeof TABS[number]['id']

export const formatDate = (value?: string | null, options: Intl.DateTimeFormatOptions = {}) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Time not recorded'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...options }).format(new Date(value))
}

export const labelFor = (value?: string) => ({
  agent_report: 'Agent report', observed: 'Observed', inferred: 'Inferred', user: 'You',
  ready_for_review: 'Ready for review', 'ready-for-review': 'Ready for review', in_progress: 'In progress',
  plan_saved: 'Checkpoint', item_updated: 'Work status', project_patch: 'Project update',
  diagnostic_result: 'Answer', 'message.user': 'User message', 'message.assistant': 'Codex message',
}[value ?? ''] ?? (value || 'Not recorded').replace(/[_.-]/g, ' ').replace(/^\w/, char => char.toUpperCase()))

export const isReviewReady = (item: WorkItem) => item.status === 'ready_for_review' || item.status === 'ready-for-review'
export const isClosed = (item: WorkItem) => /^(done|complete|completed|verified|superseded|cancelled|canceled|abandoned)$/i.test(item.status)
export const isDecision = (item: WorkItem) => item.requiresUserDecision === true
export const getEvidenceLabel = (provenance?: Provenance) => labelFor(provenance)

export function statusVariant(status?: string): 'neutral' | 'rose' | 'success' | 'warning' | 'danger' {
  if (/^(completed|complete|verified|accepted)$/.test(status || '')) return 'success'
  if (/^(failed|error)$/.test(status || '')) return 'danger'
  if (/^(blocked|waiting|needs_update|changes_requested)$/.test(status || '')) return 'warning'
  if (/^(in_progress|ready_for_review|ready-for-review|queued)$/.test(status || '')) return 'rose'
  return 'neutral'
}

export interface ReviewGroup {
  id: string
  title: string
  items: WorkItem[]
  groupId: string
  review?: GroupReview
  feedback?: ReviewFeedbackDraft
}

function stableGroupHash(value: string) {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
}

export function reviewGroupId(items: Array<Pick<WorkItem, 'id'>>) {
  const ids = items.map(item => item.id).sort()
  return `flux-ui-${stableGroupHash(ids.join('\n'))}`
}

export function collectReviewGroups(snapshot: FluxSnapshot): ReviewGroup[] {
  const items = snapshot.overview.workItems.filter(isReviewReady)
  const byId = new Map(items.map(item => [item.id, item]))
  const allById = new Map(snapshot.project.items.map(item => [item.id, item]))
  const children = new Map<string, WorkItem[]>()
  for (const item of items) if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
  const clusters = new Map<string, { title: string; items: WorkItem[] }>()
  const assigned = new Set<string>()

  for (const [parentId, siblings] of children) {
    if (siblings.length < 2 || siblings.some(item => assigned.has(item.id))) continue
    const parent = allById.get(parentId)
    if (!parent) continue
    const related = [...siblings, ...(byId.has(parentId) ? [byId.get(parentId)!] : [])]
    const key = `parent:${parentId}`
    clusters.set(key, { title: parent.title, items: related })
    related.forEach(item => assigned.add(item.id))
  }

  const ungrouped = items.filter(item => !assigned.has(item.id))
  if (ungrouped.length) clusters.set('unlinked', { title: 'Other changes without recorded parent links', items: ungrouped })

  const latestReview = new Map((snapshot.reviewGroups ?? []).map(review => [review.id, review]))
  const latestFeedback = new Map((snapshot.reviewFeedback ?? []).map(feedback => [feedback.groupId, feedback]))
  const groups = [...clusters.entries()].map(([id, cluster]) => {
    const sorted = [...cluster.items].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.title.localeCompare(b.title))
    const groupId = reviewGroupId(sorted)
    return { id, title: cluster.title, items: sorted, groupId, review: latestReview.get(groupId), feedback: latestFeedback.get(groupId) }
  })
  return groups.sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title))
}

export function currentPlan(snapshot: FluxSnapshot): Plan | undefined {
  return snapshot.project.plans.at(-1)
}

export function comparablePlans(a: Plan | undefined, b: Plan | undefined) {
  return Boolean(a && b && a.id !== b.id && (!(a.sessionId && b.sessionId) || a.sessionId === b.sessionId) &&
    (a.scopeId && b.scopeId ? a.scopeId === b.scopeId : a.steps.some(step => b.steps.some(other => other.id === step.id))))
}

export function sourceRecords(snapshot: FluxSnapshot, ids: string[] = []) {
  const byId = new Map(snapshot.events.map(event => [event.id, event]))
  return [...new Set(ids)].map(id => byId.get(id)).filter((value): value is NonNullable<typeof value> => Boolean(value))
}

export function reviewOutcomeLabel(outcome: ReviewOutcome) {
  return outcome === 'accepted' ? 'Accepted by you' : 'Changes requested by you'
}
