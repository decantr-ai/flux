import type { FluxSnapshot, Proposal } from './types'

export const proposalKey = (proposal: Pick<Proposal, 'kind' | 'id'>) => JSON.stringify([proposal.kind, proposal.id])
export function proposalCatalog(snapshot: FluxSnapshot): Proposal[] {
  if (snapshot.proposals) return snapshot.proposals
  const values = [...snapshot.overview.openWork.proposals, ...(snapshot.overview.history?.decisions ?? []).filter(item => /^(proposed|suggested|proposal|idea|optional)$/i.test(item.status))]
  const seen = new Set<string>()
  return values.flatMap(value => {
    const kind = snapshot.project.items.some(item => item.id === value.id) ? 'item' as const : 'decision' as const
    const key = proposalKey({ kind, id: value.id })
    if (seen.has(key)) return []
    seen.add(key)
    return [{ id: value.id, kind, title: value.title, rationale: value.rationale, status: value.status, sourceIds: value.sourceIds ?? [], proposedBy: null, proposedAt: null, proposalSourceId: null, disposition: 'suggested', implementation: { status: 'unknown', completedText: null, remainingText: null, provenance: 'unknown', sourceIds: [] } }]
  })
}
export const proposalActionsAvailable = (snapshot: FluxSnapshot) => Array.isArray(snapshot.proposals) && snapshot.proposalActions?.available === true
export const proposalDispositionLabel = (value: Proposal['disposition']) => ({ suggested: 'To consider', planned: 'Added to plan', later: 'For later', dismissed: 'Dismissed' })[value]
export const proposalImplementationLabel = (value: Proposal['implementation']['status']) => ({ unknown: 'Not assessed', not_started: 'Not started', partial: 'Partly implemented', in_progress: 'In progress', complete: 'Reported complete', research_only: 'Research only' })[value]
