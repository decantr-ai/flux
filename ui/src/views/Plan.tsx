import { HelpHint } from '../components/ui/HelpHint'
import { ChevronRight, List, Network } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { UiAccordion } from '../components/ui/UiAccordion'
import { ProposalList } from '../components/ProposalList'
import { proposalCatalog } from '../lib/proposals'
import { CheckpointPicker } from '../components/CheckpointPicker'
import { checkpointCatalog, resolveCheckpoint } from '../lib/checkpoint-selection'
import type { CheckpointSelection } from '../lib/checkpoint-selection'
import { statusVariant, collectReviewGroups, isClosed, labelFor } from '../lib/helpers'
import type { FluxSnapshot, WorkItem } from '../lib/types'
import { cn } from '../lib/cn'

function WorkCard({ item, onSelect, depth = 0 }: { item: WorkItem; onSelect: (item: WorkItem) => void; depth?: number }) {
  return <button className={cn('work-card', 'group', item.status === 'ready_for_review' && 'work-card-ready')} style={{ marginLeft: depth ? Math.min(depth, 4) * 16 : 0 }} onClick={() => onSelect(item)}>
    <span className="work-card-copy"><strong>{item.title}</strong><small>{item.purpose || item.owner || 'Purpose not recorded.'}</small></span>
    <Badge variant={statusVariant(item.review?.outcome === 'accepted' ? 'accepted' : item.status)}>{labelFor(item.review?.outcome === 'accepted' ? 'Accepted by you' : item.status)}</Badge>
    <ChevronRight className="work-card-arrow" size={16} aria-hidden="true" />
  </button>
}

function RecordTree({ items, onSelect, parentId, depth = 0 }: { items: WorkItem[]; onSelect: (item: WorkItem) => void; parentId?: string; depth?: number }) {
  return <ul className={cn('work-tree', depth > 0 && 'work-tree-child')}>
    {items.filter(item => item.parentId === parentId).map(item => <li key={item.id}>
      <WorkCard item={item} onSelect={onSelect} depth={depth} />
      {items.some(child => child.parentId === item.id) && <RecordTree items={items} onSelect={onSelect} parentId={item.id} depth={depth + 1} />}
    </li>)}
  </ul>
}

export function PlanView({ snapshot, session, actor, mode, onMode, checkpointSelection, onCheckpoint, onSelect, refresh }: {
  snapshot: FluxSnapshot
  refresh?: () => Promise<void>
  session: string
  actor: string
  mode: 'list' | 'map'
  onMode: (mode: 'list' | 'map') => void
  checkpointSelection: CheckpointSelection
  onCheckpoint: (id: string | null) => void
  onSelect: (item: WorkItem) => void
}) {
  const ideaItemIds = new Set(proposalCatalog(snapshot).filter(proposal => proposal.kind === 'item').map(proposal => proposal.id))
  const visible = snapshot.overview.workItems.filter(item => !ideaItemIds.has(item.id) && !/^(proposal|proposed|suggested|idea|optional)$/i.test(item.status)).filter(item => (!session || !item.sessionId || item.sessionId === session) && (!actor || !item.owner || item.owner === actor))
  const parked = visible.filter(item => /^(parked|deferred|shelved|paused|on_hold|on-hold)$/i.test(item.status))
  const later = parked
  const reviewGroups = collectReviewGroups(snapshot)
  const open = visible.filter(item => !isClosed(item) && !later.includes(item) && item.status !== 'ready_for_review' && item.status !== 'ready-for-review')
  const completed = visible.filter(isClosed)
  const byId = new Map(visible.map(item => [item.id, item]))
  const rootItems = visible.filter(item => !item.parentId || !byId.has(item.parentId))
  const plans = checkpointCatalog(snapshot)
  const { checkpoint, missing } = resolveCheckpoint(checkpointSelection, plans)
  const checkpointOptions = plans
  const completedSection = completed.length > 0 ? <section className="plan-subsection"><UiAccordion sections={[{ value: 'completed-work', title: <>Completed and superseded <Badge variant="neutral">{completed.length}</Badge></>, children: <div className="work-list">{completed.map(item => <WorkCard key={item.id} item={item} onSelect={onSelect} />)}</div> }]} /></section> : null

  return <div className="detail-view plan-view">
    <header className="detail-heading"><div><p className="eyebrow">Work and checkpoints</p><h2>Plan</h2><p>Current commitments and saved snapshots have their own status and evidence.</p></div><Badge variant="neutral">{visible.length} items</Badge></header>
    {snapshot.overview.focus.title && <section className="last-focus"><span className="eyebrow">{snapshot.overview.focus.status === 'needs_update' ? 'Last saved focus' : 'Current focus'}</span><strong>{snapshot.overview.focus.title}</strong>{snapshot.overview.focus.status === 'needs_update' && <p>The newest request needs to be reconciled with this checkpoint.</p>}</section>}
    <section className="plan-work-section">
      <header className="section-heading"><div><p className="eyebrow">Now</p><div className="help-heading"><h3>Active work <span className="heading-count">{open.length}</span></h3><HelpHint topic="work-map" /></div></div><div className="segmented-switch" role="group" aria-label="Plan layout">
        <Button variant={mode === 'list' ? 'primary' : 'quiet'} size="small" aria-pressed={mode === 'list'} onClick={() => onMode('list')}><List size={14} />List</Button>
        <Button variant={mode === 'map' ? 'primary' : 'quiet'} size="small" aria-pressed={mode === 'map'} onClick={() => onMode('map')}><Network size={14} />Work map</Button>
      </div></header>
      {mode === 'map' ? <div className="work-map"><p className="map-note">Lines show only the recorded parent relationships.</p><div className="map-goal">{snapshot.project.goal}</div><RecordTree items={visible} onSelect={onSelect} />{rootItems.length === 0 && <p className="empty-state">No recorded work in this scope.</p>}</div>
        : <div className="work-list">{open.map(item => <WorkCard key={item.id} item={item} onSelect={onSelect} />)}{open.length === 0 && <p className="empty-state">No active work is recorded.</p>}</div>}
    </section>
    {reviewGroups.length > 0 && <section className="plan-subsection"><header className="section-heading"><div><p className="eyebrow">Grouped changes</p><h3>Ready for review <span className="heading-count">{reviewGroups.reduce((n, group) => n + group.items.length, 0)}</span></h3></div></header>
      <UiAccordion sections={reviewGroups.map(group => ({ value: group.id, title: <><span className="accordion-name">{group.title}</span><Badge variant="rose">{group.items.length}</Badge></>, children: <div className="work-list">{group.items.map(item => <WorkCard key={item.id} item={item} onSelect={onSelect} />)}</div> }))} />
    </section>}
    {parked.length > 0 && <section className="plan-subsection"><header className="section-heading"><div><p className="eyebrow">For later</p><div className="help-heading"><h3>Parked work <span className="heading-count">{parked.length}</span></h3><HelpHint topic="parked-work" /></div></div></header><div className="work-list">{parked.map(item => <WorkCard key={item.id} item={item} onSelect={onSelect} />)}</div></section>}
    <section className="checkpoint-section"><header className="section-heading"><div><p className="eyebrow">History</p><div className="help-heading"><h3>Saved checkpoints <span className="heading-count">{checkpointOptions.length}</span></h3><HelpHint topic="plan-checkpoints" /></div></div></header>
      <CheckpointPicker plans={plans} selection={checkpointSelection} onSelect={onCheckpoint} />
      {checkpoint ? <><UiAccordion key={checkpoint.id} defaultValue={[checkpoint.id]} sections={[{ value: checkpoint.id, title: <span className="accordion-name">{checkpoint.title} · {checkpoint.steps.length} steps</span>, children: <><p className="checkpoint-scope">{checkpoint.scopeId ? `Work scope: ${snapshot.project.items.find(item => item.id === checkpoint.scopeId)?.title || checkpoint.scopeId}` : 'Scope was not recorded. Comparisons use stable work IDs when possible.'}</p><div className="work-list">{checkpoint.steps.map(step => <WorkCard key={step.id} item={{ ...step, status: step.status, owner: 'Codex', provenance: step.provenance ?? 'agent_report', sourceIds: step.sourceIds }} onSelect={onSelect} />)}</div></> }]} /></> : !missing && <p className="empty-state">No saved checkpoints.</p>}
    </section>
    {completedSection}
    <ProposalList snapshot={snapshot} onSelect={onSelect} refresh={refresh} />
  </div>
}
