import { ArrowRight, CheckCheck, ChevronDown, GitBranch, MessageSquareText, Sparkles } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { HelpHint } from '../components/ui/HelpHint'
import { NewRequestBanner } from '../components/NewRequestBanner'
import { ReviewUpdateCard } from '../components/ReviewUpdateCard'
import { ProposalList } from '../components/ProposalList'
import { IncomingQuestions } from '../components/IncomingQuestions'
import { getEvidenceLabel, formatDate, labelFor, statusVariant } from '../lib/helpers'
import { sourceRecords } from '../lib/helpers'
import type { FluxSnapshot, WorkItem } from '../lib/types'
import type { ReactNode } from 'react'

export function Overview({ snapshot, onReview, onAsk, onSelect, questionHistory, refresh }: {
  snapshot: FluxSnapshot
  onReview: () => void
  onAsk: (question: string, records?: string[]) => void
  onSelect: (item: WorkItem) => void
  refresh?: () => Promise<void>
  questionHistory: ReactNode
}) {
  const { overview, requests } = snapshot
  const stale = overview.focus.status === 'needs_update'
  const reviewGroupsCount = snapshot.overview.workItems.filter(item => item.status === 'ready_for_review' || item.status === 'ready-for-review').length
  const reviewWait = requests.some(request => request.status === 'queued' || request.status === 'acknowledged')
  const recent = overview.events.filter(event => ['verification', 'answer', 'artifact'].includes(event.category)).slice(0, 3)
  const openItems = overview.openWork.active.filter(item => item.status !== 'ready_for_review' && item.status !== 'ready-for-review' && !/^(blocked|waiting)$/i.test(item.status)).slice(0, 4)
  const { parked } = overview.openWork
  const auditRecords = sourceRecords(snapshot, [...overview.direction.sourceIds, ...overview.why.sourceIds, ...overview.now.sourceIds, ...overview.next.sourceIds])
    .sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || ''))

  return <div className="overview-page">
    {stale && <NewRequestBanner request={overview.direction} at={overview.direction.at} busyQuestion={reviewWait} />}

    <section className="overview-hero" aria-label="Current work">
      <div className="overview-hero-main">
        <div className="state-row"><span className="now-marker"><span className="now-dot" />{stale ? 'Last recorded' : 'Now'}</span><HelpHint topic="overview-focus" /><Badge variant={stale ? 'warning' : statusVariant(overview.focus.workStatus || overview.now.status)}>{stale ? 'Needs update' : labelFor(overview.focus.workStatus || overview.now.status)}</Badge><span className="provenance"><Sparkles size={14} />{getEvidenceLabel(overview.now.provenance)}</span></div>
        <h2>{overview.now.text || 'Current focus is not recorded.'}</h2>
        <p className="checkpoint-stamp">{overview.focus.updatedAt ? `Last checkpoint ${formatDate(overview.focus.updatedAt)}` : 'Checkpoint time not recorded'}</p>
        <div className="focus-reason"><strong>Why</strong><p>{overview.why.text || 'The reason for the current work is not recorded.'}</p></div>
        {auditRecords.length > 0 && <details className="audit-disclosure">
          <summary><GitBranch size={15} />How we got here<span className="audit-total">{auditRecords.length} records</span><ChevronDown size={14} className="disclosure-chevron" /></summary>
          <ol className="audit-list">{auditRecords.map(event => <li key={event.id}><span className="audit-point" /><span><strong>{event.summary || event.kind}</strong><small>{getEvidenceLabel(event.provenance)} · {event.actor || 'Not recorded'} · {formatDate(event.at)}</small></span></li>)}</ol>
        </details>}
      </div>
        <div className="overview-next">
        <div className="next-heading"><div className="section-kicker"><ArrowRight size={15} />{stale ? 'Previously recommended next step' : 'Recommended next step'}<HelpHint topic="recommended-next" /></div><Badge variant={overview.next.status === 'planned' ? 'rose' : 'neutral'}>{overview.next.status === 'planned' ? 'Planned' : overview.next.status === 'suggested' ? 'Suggested' : labelFor(overview.next.status)}</Badge></div>
        <p>{overview.next.text || 'The next step is not recorded.'}</p>
      </div>
    </section>

    <IncomingQuestions snapshot={snapshot} onSelect={onSelect} refresh={refresh} />

    <section className="overview-ask" aria-label="Ask Codex">
      <div className="overview-ask-copy"><div className="help-heading"><h3>Ask Codex</h3><HelpHint topic="ask-codex" /></div><p>Get a fresh assessment or edit your question before sending.</p></div>
      <Button variant="primary" className="ask-progress" onClick={() => onAsk('Where are we with the current plan?')}><MessageSquareText size={16} />Ask about progress</Button>
    </section>

    <section className="review-overview" aria-label="Review updates">
      {reviewGroupsCount > 0 && <ReviewUpdateCard snapshot={snapshot} onReview={onReview} />}
      {reviewGroupsCount === 0 && <div className="review-quiet"><CheckCheck size={17} /><span>No grouped updates are waiting for review.</span></div>}
    </section>

    {questionHistory}

    <section className="overview-lower" aria-label="Recent and later work" data-solo-column={!openItems.length && !parked.length}>
      <div className="recent-column"><header className="section-heading"><div><p className="eyebrow">What changed</p><h3>Recent outcomes</h3></div><span className="subtle-count">{recent.length}</span></header>
        {recent.length ? recent.map(event => <button key={event.id} className="outcome-row" onClick={() => onSelect({ id: event.id, title: event.summary || event.kind, status: event.category, kind: 'activity', purpose: event.text || event.summary, sourceIds: [event.id], provenance: event.provenance, at: event.at, actor: event.actor, sessionId: event.sessionId })}><span className="outcome-icon"><CheckCheck size={15} /></span><span><strong>{event.summary}</strong><small>{getEvidenceLabel(event.provenance)} · {formatDate(event.at)}</small></span><ArrowRight size={15} /></button>) : <p className="empty-inline">No outcomes are recorded yet.</p>}
      </div>
      {(openItems.length > 0 || parked.length > 0) && <div className="open-column">{openItems.length > 0 && <header className="section-heading"><div><p className="eyebrow">In progress</p><h3>Current work</h3></div><span className="subtle-count">{openItems.length}</span></header>}
        {openItems.map(item => <button key={item.id} className="compact-work-row" onClick={() => onSelect(item)}><span><strong>{item.title}</strong>{item.purpose && <small>{item.purpose}</small>}</span><Badge variant="neutral">{labelFor(item.status)}</Badge></button>)}

        {parked.length > 0 && <div className="later-group"><details className="later-disclosure"><summary>Parked work<span className="subtle-count">{parked.length}</span></summary>{parked.map(item => <button key={item.id} className="compact-work-row" onClick={() => onSelect(item)}><span><strong>{item.title}</strong>{item.purpose && <small>{item.purpose}</small>}{item.returnCondition && <small>Return when: {item.returnCondition}</small>}</span><Badge variant="neutral">{labelFor(item.status)}</Badge></button>)}</details><HelpHint topic="parked-work" /></div>}
        <button className="text-link" onClick={() => onAsk('Find unfinished work')}>Find unfinished work <ArrowRight size={14} /></button>
      </div>}
    </section>
    <ProposalList snapshot={snapshot} onSelect={onSelect} refresh={refresh} />
  </div>
}
