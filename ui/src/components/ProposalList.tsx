import { ArrowUpRight, ListPlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { HelpHint } from './ui/HelpHint'
import { chooseProposal } from '../lib/api'
import { formatDate, getEvidenceLabel } from '../lib/helpers'
import { proposalActionsAvailable, proposalCatalog, proposalDispositionLabel, proposalImplementationLabel, proposalKey } from '../lib/proposals'
import type { FluxSnapshot, Proposal, WorkItem } from '../lib/types'

type Choice = 'plan' | 'later' | 'dismiss' | 'restore'
function ProposalCard({ proposal, snapshot, onSelect, onChoice, busy, enabled }: { proposal: Proposal; snapshot: FluxSnapshot; onSelect: (item: WorkItem) => void; onChoice: (proposal: Proposal, choice: Choice) => void; busy: boolean; enabled: boolean }) {
  const assessmentSources = proposal.implementation.sourceIds.filter(id => snapshot.events.some(event => event.id === id && (!event.sessionId || event.sessionId === snapshot.project.sessionId) && (!event.projectId || event.projectId === snapshot.project.id)))
  const assessed = proposal.implementation.status !== 'unknown' && assessmentSources.length > 0
  const linkedWork = snapshot.project.items.find(item => item.id === proposal.plannedItemId && (!item.sessionId || item.sessionId === snapshot.project.sessionId))
  const sourceIds = [...new Set([proposal.proposalSourceId, proposal.choiceSourceId, ...proposal.sourceIds, ...assessmentSources].filter((id): id is string => Boolean(id)))].filter(id => snapshot.events.some(event => event.id === id && (!event.sessionId || event.sessionId === snapshot.project.sessionId) && (!event.projectId || event.projectId === snapshot.project.id)))
  const source = snapshot.events.find(event => event.id === proposal.proposalSourceId && (!event.sessionId || event.sessionId === snapshot.project.sessionId) && (!event.projectId || event.projectId === snapshot.project.id))
  const details: WorkItem = { id: source?.id || proposal.id, title: proposal.title, status: proposalDispositionLabel(proposal.disposition), purpose: proposal.rationale || 'The rationale was not recorded.', sourceIds, provenance: source?.provenance, actor: source?.actor }
  return <article className="proposal-card" data-proposal-disposition={proposal.disposition}>
    <header><h4>{proposal.title}</h4><Badge>{proposalDispositionLabel(proposal.disposition)}</Badge></header>
    <p className="proposal-origin">{proposal.proposedBy ? `Suggested by ${proposal.proposedBy}` : 'Suggestor not recorded'} · {proposal.proposedAt ? formatDate(proposal.proposedAt) : 'Date not recorded'}</p>
    {proposal.rationale && <p className="proposal-rationale">{proposal.rationale}</p>}
    <div className="proposal-assessment"><span className="field-label">Implementation</span><strong>{assessed ? proposalImplementationLabel(proposal.implementation.status) : 'Not assessed'}</strong>{assessed && <><span className="proposal-provenance">{getEvidenceLabel(proposal.implementation.provenance)} · source-backed report</span>{proposal.implementation.completedText && <p><b>Recorded progress</b> {proposal.implementation.completedText}</p>}{proposal.implementation.remainingText && <p><b>Remaining</b> {proposal.implementation.remainingText}</p>}</>}{!assessed && <p>Implementation has not been established by linked evidence.</p>}</div>
    <footer><Button variant="ghost" size="small" onClick={() => onSelect(details)}>Details<ArrowUpRight size={13} aria-hidden="true" /></Button>
      {proposal.disposition === 'planned' ? linkedWork ? <Button variant="secondary" size="small" onClick={() => onSelect(linkedWork)}>View planned work</Button> : <span className="empty-inline">Linked work is unavailable in this capture.</span>
        : proposal.disposition === 'dismissed' ? <Button variant="secondary" size="small" disabled={!enabled || busy} onClick={() => onChoice(proposal, 'restore')}>Restore idea</Button>
          : <><Button variant="secondary" size="small" disabled={!enabled || busy} onClick={() => onChoice(proposal, 'plan')}><ListPlus size={14} aria-hidden="true" />Add to plan</Button>{proposal.disposition === 'later' && <Button variant="quiet" size="small" disabled={!enabled || busy} onClick={() => onChoice(proposal, 'restore')}>Restore idea</Button>}{proposal.disposition !== 'later' && <Button variant="quiet" size="small" disabled={!enabled || busy} onClick={() => onChoice(proposal, 'later')}>Later</Button>}<Button variant="quiet" size="small" disabled={!enabled || busy} onClick={() => onChoice(proposal, 'dismiss')}>Dismiss</Button></>}
    </footer>
    {!proposal.proposalSourceId && <p className="empty-inline">A recorded declaration is needed before choices can be saved for this idea.</p>}
  </article>
}

export function ProposalList({ snapshot, onSelect, refresh }: { snapshot: FluxSnapshot; onSelect: (item: WorkItem) => void; refresh?: () => Promise<void> }) {
  const proposals = proposalCatalog(snapshot)
  const scope = JSON.stringify([snapshot.project.id, snapshot.project.sessionId])
  const owner = useRef({ scope, epoch: 0 })
  if (owner.current.scope !== scope) owner.current = { scope, epoch: owner.current.epoch + 1 }
  const operation = useRef<{ scope: string; epoch: number } | null>(null)
  const [busy, setBusy] = useState<{ scope: string; epoch: number; key: string } | null>(null)
  const [notice, setNotice] = useState<{ scope: string; epoch: number; message: string } | null>(null)
  const available = proposalActionsAvailable(snapshot)
  const owns = (captured: { scope: string; epoch: number }) => captured.scope === owner.current.scope && captured.epoch === owner.current.epoch
  async function act(proposal: Proposal, choice: Choice) {
    if (!available || !proposal.proposalSourceId || operation.current?.scope === scope) return
    const captured = { ...owner.current }
    operation.current = captured; setBusy({ ...captured, key: proposalKey(proposal) }); setNotice(null)
    try {
      await chooseProposal(snapshot, proposal.id, proposal.kind, choice)
      if (owns(captured)) setNotice({ ...captured, message: ({ plan: 'Added to the Flux plan as linked to-do work. Nothing was sent or started.', later: 'Kept as an idea for later, separate from parked commitments.', dismiss: 'Dismissed from current ideas. It remains available to restore.', restore: 'Restored to ideas to consider.' })[choice] })
    } catch (cause) { if (owns(captured)) setNotice({ ...captured, message: cause instanceof Error ? cause.message : 'This choice could not be saved. Refresh and try again.' }) }
    finally { await refresh?.().catch(() => {}); if (operation.current === captured) { operation.current = null; setBusy(null) } }
  }
  if (!proposals.length) return null
  const groups = [{ disposition: 'suggested' as const, title: 'Other ideas' }, { disposition: 'later' as const, title: 'Ideas for later' }, { disposition: 'planned' as const, title: 'Ideas added to plan' }]
  const dismissed = proposals.filter(value => value.disposition === 'dismissed')
  const cards = (values: Proposal[]) => <div className="proposal-list">{values.map(proposal => <ProposalCard key={proposalKey(proposal)} proposal={proposal} snapshot={snapshot} onSelect={onSelect} onChoice={(value, choice) => void act(value, choice)} busy={Boolean(busy && owns(busy))} enabled={available && !!proposal.proposalSourceId} />)}</div>
  return <section className="proposal-section" aria-label="Ideas and choices">
    <header className="section-heading"><div><p className="eyebrow">Suggestions and choices</p><div className="help-heading"><h3>Other ideas</h3><span className="heading-count">{proposals.length}</span><HelpHint topic="other-ideas" /></div></div></header>
    <p className="proposal-action-hint">Add to plan creates linked to-do work in Flux. It does not send a request to Codex or start execution.</p>
    {!available && <p className="storage-notice" role="status">Restart the updated Flux service and refresh to save choices. Idea details remain available.</p>}
    {notice && owns(notice) && <p className="storage-notice" role="status">{notice.message}</p>}
    {groups.map(group => { const values = proposals.filter(value => value.disposition === group.disposition); return values.length ? <div key={group.disposition} className="proposal-group">{group.disposition !== 'suggested' && <h4 className="proposal-group-heading">{group.title} <span className="heading-count">{values.length}</span></h4>}{cards(values)}</div> : null })}
    {!!dismissed.length && <details className="proposal-dismissed"><summary>Dismissed ideas <span className="heading-count">{dismissed.length}</span></summary>{cards(dismissed)}</details>}
  </section>
}
