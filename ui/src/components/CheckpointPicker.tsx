import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { UiSelect } from './ui/Select'
import { checkpointOption, checkpointOptionId, resolveCheckpoint } from '../lib/checkpoint-selection'
import type { CheckpointSelection } from '../lib/checkpoint-selection'
import { formatDate } from '../lib/helpers'
import type { Plan } from '../lib/types'

export function CheckpointPicker({ plans, selection, onSelect, label = 'Saved checkpoint' }: { plans: Plan[]; selection: CheckpointSelection; onSelect: (id: string | null) => void; label?: string }) {
  const { latest, missing, newerAvailable } = resolveCheckpoint(selection, plans)
  return <div className="checkpoint-control" data-checkpoint-mode={selection.mode}>
    <div className="checkpoint-picker"><span className="field-label">{label}</span><UiSelect ariaLabel={label} value={selection.mode === 'follow_latest' ? 'latest' : checkpointOption(selection.pinnedId)} onValueChange={value => onSelect(checkpointOptionId(value))} options={[
      { value: 'latest', label: latest ? `Follow latest · ${latest.title}` : 'Follow latest · none recorded' },
      ...(missing ? [{ value: checkpointOption(selection.pinnedId), label: 'Pinned checkpoint unavailable', disabled: true }] : []),
      ...plans.slice().reverse().map(plan => ({ value: checkpointOption(plan.id), label: `${plan.title} · ${formatDate(plan.at)}` })),
    ]} /></div>
    <div className="checkpoint-selection-status">{selection.mode === 'follow_latest' ? <Badge>Following latest</Badge> : <><Badge variant="warning">Viewing history</Badge>{newerAvailable && <span>Newer checkpoint available</span>}<Button size="small" variant="quiet" onClick={() => onSelect(null)}>Return to latest</Button></>}</div>
    {missing && <p className="scope-warning" role="status">The pinned checkpoint is unavailable in this project and chat. Return to latest or choose another saved checkpoint.</p>}
  </div>
}
