import { HelpHint } from '../components/ui/HelpHint'
import { useMemo } from 'react'
import { ArrowRight, Equal, Minus, Plus } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { UiSelect } from '../components/ui/Select'
import { CheckpointPicker } from '../components/CheckpointPicker'
import { checkpointCatalog, checkpointOption, checkpointOptionId, resolveBaseline, resolveCheckpoint } from '../lib/checkpoint-selection'
import type { CheckpointSelection } from '../lib/checkpoint-selection'
import { formatDate, labelFor } from '../lib/helpers'
import type { FluxSnapshot, Plan, PlanStep, WorkItem } from '../lib/types'

type ChangeKind = 'added' | 'removed' | 'updated' | 'retained'
interface ChangeRecord { id: string; kind: ChangeKind; title: string; before?: PlanStep; after?: PlanStep }

function compare(before: Plan | undefined, after: Plan | undefined): ChangeRecord[] {
  if (!before || !after) return []
  const left = new Map(before.steps.map(step => [step.id, step]))
  const right = new Map(after.steps.map(step => [step.id, step]))
  const ids = [...new Set([...left.keys(), ...right.keys()])]
  return ids.map(id => {
    const oldStep = left.get(id), newStep = right.get(id)
    if (!oldStep) return { id, kind: 'added' as const, title: newStep!.title, after: newStep }
    if (!newStep) return { id, kind: 'removed' as const, title: oldStep.title, before: oldStep }
    const changed = oldStep.title !== newStep.title || oldStep.status !== newStep.status
    return { id, kind: changed ? 'updated' as const : 'retained' as const, title: newStep.title, before: oldStep, after: newStep }
  })
}

const glyph = { added: Plus, removed: Minus, updated: ArrowRight, retained: Equal }

function DiffRow({ record, side, onSelect }: { record: ChangeRecord; side: 'before' | 'after'; onSelect: (item: WorkItem) => void }) {
  const step = side === 'before' ? record.before : record.after
  if (!step) return <span aria-hidden="true" />
  const Icon = glyph[record.kind]
  return <button className={`diff-row diff-${record.kind}`} onClick={() => onSelect({ ...step, kind: 'step', status: step.status, owner: 'Codex', sourceIds: step.sourceIds ?? [], provenance: step.provenance ?? 'agent_report' })}>
    <Icon size={15} aria-hidden="true" /><span><strong>{step.title}</strong><small>{labelFor(step.status)}{step.evidenceScope === 'checkpoint' ? ' · Checkpoint evidence' : ''}</small></span>
  </button>
}

export function ChangesView({ snapshot, checkpointSelection, onCheckpoint, onBaselinePlan, onSelect }: {
  snapshot: FluxSnapshot
  checkpointSelection: CheckpointSelection
  onCheckpoint: (id: string | null) => void
  onBaselinePlan: (id: string) => void
  onSelect: (item: WorkItem) => void
}) {
  const plans = checkpointCatalog(snapshot)
  const { checkpoint: after, missing } = resolveCheckpoint(checkpointSelection, plans)
  const { candidates, before, unavailable } = resolveBaseline(checkpointSelection, plans, after)
  const records = useMemo(() => compare(before, after), [before, after])
  const counts = { added: records.filter(record => record.kind === 'added').length, removed: records.filter(record => record.kind === 'removed').length, updated: records.filter(record => record.kind === 'updated').length, retained: records.filter(record => record.kind === 'retained').length }

  return <div className="detail-view">
    <header className="detail-heading"><div><p className="eyebrow">Saved plans with the same recorded scope</p><div className="help-heading"><h2>Changes</h2><HelpHint topic="plan-comparison" /></div><p>Only matching work scopes or shared stable step IDs are compared.</p></div></header>
    <CheckpointPicker plans={plans} selection={checkpointSelection} onSelect={onCheckpoint} label="After checkpoint" />
    {missing ? null : plans.length < 2 ? <p className="empty-state">Two saved checkpoints are needed for comparison.</p> : !candidates.length ? <div className="scope-warning"><h3>No earlier comparable checkpoint</h3><p>No earlier saved checkpoint matches the selected work scope or stable step IDs. Flux keeps unrelated comparisons separate.</p></div> : <>
      <div className="change-selectors"><div><span className="field-label">Before</span><UiSelect ariaLabel="Earlier checkpoint" value={checkpointSelection.baselineId ? checkpointOption(checkpointSelection.baselineId) : 'latest'} onValueChange={value => onBaselinePlan(checkpointOptionId(value) ?? '')} options={[{ value: 'latest', label: 'Latest comparable earlier checkpoint' }, ...(unavailable ? [{ value: checkpointOption(checkpointSelection.baselineId), label: 'Earlier checkpoint unavailable or incompatible', disabled: true }] : []), ...candidates.map(plan => ({ value: checkpointOption(plan.id), label: plan.title }))]} /></div></div>
      {unavailable && <p className="scope-warning" role="status">The selected earlier checkpoint is unavailable or belongs to a different work scope. Choose a compatible checkpoint before comparing.</p>}
      {before && after && <><div className="diff-totals"><Badge variant="success"><Plus size={12} />{counts.added} added</Badge><Badge variant="neutral"><Minus size={12} />{counts.removed} removed</Badge><Badge variant="neutral"><Equal size={12} />{counts.retained} retained</Badge><Badge variant="warning"><ArrowRight size={12} />{counts.updated} updated</Badge></div>
      <div className="diff-columns">{(['before', 'after'] as const).map(side => { const plan = side === 'before' ? before : after; return <section key={side} className="diff-column"><header><span className="eyebrow">{side === 'before' ? 'Earlier' : 'Later'}</span><h3>{plan?.title}</h3><small>{formatDate(plan?.at)}</small></header>{records.filter(record => record[side]).map(record => <DiffRow key={record.id} record={record} side={side} onSelect={onSelect} />)}</section> })}</div>
      <p className="evidence-note">“Removed” means absent from the later saved list. It does not mean canceled. A checkpoint status does not establish verified completion.</p></>}
    </>}
  </div>
}
