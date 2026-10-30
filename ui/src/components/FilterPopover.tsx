import { HelpHint } from './ui/HelpHint'
import { Filter, RotateCcw } from 'lucide-react'
import { FilterPopover as Popover } from './ui/Popover'
import { Button } from './ui/Button'
import { UiSelect } from './ui/Select'
import type { FluxSnapshot } from '../lib/types'

export function FilterPanel({ snapshot, session, actor, onSession, onActor, onClear }: {
  snapshot: FluxSnapshot
  session: string
  actor: string
  onSession: (value: string) => void
  onActor: (value: string) => void
  onClear: () => void
}) {
  const actors = [...new Set([...snapshot.events.map(event => event.actor), ...snapshot.project.items.map(item => item.owner)])]
    .filter((value): value is string => Boolean(value) && !/^(user|system|tool)$/i.test(value!)).sort().slice(0, 12)
  return <Popover trigger={<><Filter size={16} /><span>Filters</span></>}>
    <div className="filter-heading"><div><p className="eyebrow">Narrow Plan and Timeline</p><div className="help-heading"><h2>Filters</h2><HelpHint topic="filters" /></div></div><Button variant="ghost" size="small" onClick={onClear}><RotateCcw size={14} />Clear</Button></div>
    <div className="filter-fields">
      <UiSelect label="Chat" value={session} onValueChange={onSession} options={[
        ...(snapshot.project.sessions.length > 1 ? [{ value: '', label: 'All enrolled chats' }] : []),
        ...snapshot.project.sessions.map(value => ({ value: value.id, label: value.title })),
      ]} ariaLabel="Filter by chat" />
      <UiSelect label="Participant" value={actor} onValueChange={onActor} options={[{ value: '', label: 'All participants' }, ...actors.map(value => ({ value, label: value }))]} ariaLabel="Filter by participant" />
    </div>
    <p className="filter-hint">Chat and participant filters apply to Plan and Timeline. They do not change saved work.</p>
  </Popover>
}
