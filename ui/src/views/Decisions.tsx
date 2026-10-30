import { HelpHint } from '../components/ui/HelpHint'
import { useMemo } from 'react'
import { Check, CircleHelp, Lightbulb, X } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { ProposalList } from '../components/ProposalList'
import { proposalCatalog } from '../lib/proposals'
import { UiAccordion } from '../components/ui/UiAccordion'
import { formatDate, labelFor } from '../lib/helpers'
import type { Decision, FluxSnapshot, WorkItem } from '../lib/types'

function DecisionLine({ decision, onSelect }: { decision: Decision; onSelect: (item: WorkItem) => void }) {
  const symbol = /superseded|rejected|cancelled/i.test(decision.status) ? X : /proposed|suggested/i.test(decision.status) ? Lightbulb : /accepted|approved|user_direction/i.test(decision.status) ? Check : CircleHelp
  const Icon = symbol
  return <article className="decision-line">
    <button className="decision-select" onClick={() => onSelect({ ...decision, status: decision.status, sourceIds: decision.sourceIds ?? [], purpose: decision.rationale })}>
      <span className="decision-icon"><Icon size={16} /></span><span><strong>{decision.title}</strong><small>{decision.rationale || 'Rationale was not recorded.'}</small></span>
    </button>
    <div className="decision-meta"><Badge variant={/proposed|suggested/i.test(decision.status) ? 'warning' : /accepted|approved|user_direction/i.test(decision.status) ? 'success' : 'neutral'}>{labelFor(decision.status)}</Badge><span>{formatDate(decision.at)} · {(decision.sourceIds ?? []).length} sources</span></div>
  </article>
}

export function DecisionsView({ snapshot, onSelect, refresh }: { snapshot: FluxSnapshot; onSelect: (item: WorkItem) => void; refresh?: () => Promise<void> }) {
  const proposalIds = new Set(proposalCatalog(snapshot).filter(proposal => proposal.kind === 'decision').map(proposal => proposal.id))
  const decisions = snapshot.overview.history.decisions.filter(decision => !proposalIds.has(decision.id))
  const groups = useMemo(() => ({
    current: decisions.filter(item => !/superseded|cancelled|rejected|proposed|suggested|verified|completed/i.test(item.status)),
    history: decisions.filter(item => /superseded|cancelled|rejected|verified|completed/i.test(item.status)),
  }), [decisions])
  return <div className="detail-view">
    <header className="detail-heading"><div><p className="eyebrow">Choices and their evidence</p><div className="help-heading"><h2>Decisions</h2><HelpHint topic="decisions" /></div><p>Recorded instructions, accepted choices, suggestions, and superseded directions stay distinct.</p></div><Badge variant="neutral">{snapshot.overview.history.decisions.length} records</Badge></header>
    {groups.current.length > 0 ? <section className="decision-section"><h3>Current decisions and instructions</h3>{groups.current.slice().reverse().map(item => <DecisionLine key={item.id} decision={item} onSelect={onSelect} />)}</section> : <p className="empty-state">No current decisions are recorded.</p>}
    <ProposalList snapshot={snapshot} onSelect={onSelect} refresh={refresh} />
    {groups.history.length > 0 && <UiAccordion className="decision-history" sections={[{ value: 'past-decisions', title: <>Superseded choices and outcomes <Badge variant="neutral">{groups.history.length}</Badge></>, children: groups.history.slice().reverse().map(item => <DecisionLine key={item.id} decision={item} onSelect={onSelect} />) }]} />}
    <p className="evidence-note">A recorded choice, its implementation, and its checks are separate facts.</p>
  </div>
}
