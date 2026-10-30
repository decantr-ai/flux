import { HelpHint } from '../components/ui/HelpHint'
import { ArrowUpRight, Clock3, Search } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { FieldLabel, Input } from '../components/ui/Field'
import { UiSelect } from '../components/ui/Select'
import { markdownText } from '../../../src/markdown.mjs'
import { formatDate, labelFor } from '../lib/helpers'
import type { SourceRecord } from '../lib/types'

export function TimelineView({ snapshot, events, mode, onMode, kind, onKind, search, onSearch, count, onMore, onSelect }: {
  snapshot: { events: SourceRecord[]; project: { sessions: Array<{ id: string; title: string }> } }
  events: SourceRecord[]
  mode: string
  onMode: (value: string) => void
  kind: string
  onKind: (value: string) => void
  search: string
  onSearch: (value: string) => void
  count: number
  onMore: () => void
  onSelect: (event: SourceRecord) => void
}) {
  const kinds = [...new Set(snapshot.events.map(event => event.kind).filter(Boolean))].sort()
  const shown = events.slice(0, count)
  const recordsByDay = new Map<string, SourceRecord[]>()
  for (const event of shown) {
    const day = formatDate(event.at, { hour: undefined, minute: undefined })
    recordsByDay.set(day, [...(recordsByDay.get(day) ?? []), event])
  }
  return <div className="detail-view">
    <header className="detail-heading"><div><p className="eyebrow">Public messages and recorded work</p><div className="help-heading"><h2>Timeline</h2><HelpHint topic="timeline" /></div><p>Meaningful changes first. Full captured activity stays one switch away.</p></div><Badge variant="neutral">{events.length.toLocaleString()} records</Badge></header>
    <div className="filter-toolbar">
      <div><FieldLabel htmlFor="timeline-mode">Show</FieldLabel><UiSelect ariaLabel="Show timeline records" value={mode} onValueChange={onMode} options={[{ value: 'meaningful', label: 'Meaningful changes' }, { value: 'all', label: 'All captured records' }]} /></div>
      <label className="search-field"><span className="sr-only">Search activity</span><Search size={16} /><Input type="search" value={search} onChange={event => onSearch(event.target.value)} placeholder="Search activity, decisions, and updates" /></label>
      <div><FieldLabel htmlFor="event-kind">Activity type</FieldLabel><UiSelect ariaLabel="Activity type" value={kind} onValueChange={onKind} options={[{ value: '', label: mode === 'meaningful' ? 'Meaningful activity types' : 'All activity types' }, ...kinds.map(value => ({ value, label: labelFor(value) }))]} /></div>
    </div>
    {recordsByDay.size === 0 ? <p className="empty-state">No activity matches these filters.</p> : [...recordsByDay.entries()].map(([day, dayRecords]) => <section className="timeline-day" key={day}>
      <h3 className="timeline-day-heading">{day}</h3>
      {dayRecords.map(event => {
        const message = ['message.assistant', 'message.user'].includes(event.kind)
        const titleText = markdownText((message ? event.text || event.summary : event.summary) || labelFor(event.kind)) || labelFor(event.kind)
        const title = titleText.length > 220 ? titleText.slice(0, 217).replace(/\s+\S*$/, '') + '…' : titleText
        const preview = !message && event.text && event.text !== event.summary ? markdownText(event.text).slice(0, 220) : ''
        return <button key={event.id} className="timeline-event" onClick={() => onSelect(event)}>
        <span className="timeline-when"><Clock3 size={14} />{formatDate(event.at, { month: undefined, day: undefined })}<small>{event.actor || 'Not recorded'}</small></span>
        <span className="timeline-event-copy"><strong>{title}</strong>{preview && <small>{preview}</small>}<span className="timeline-badges"><Badge variant="neutral">{labelFor(event.kind)}</Badge><Badge variant={event.provenance === 'user' ? 'rose' : event.provenance === 'observed' ? 'success' : 'neutral'}>{labelFor(event.provenance)}</Badge>{event.sessionId && snapshot.project.sessions.length > 1 && <Badge variant="neutral">{snapshot.project.sessions.find(value => value.id === event.sessionId)?.title || event.sessionId}</Badge>}</span></span>
        <ArrowUpRight className="timeline-inspect" size={15} />
      </button>})}
    </section>)}
    {events.length > shown.length && <Button variant="secondary" className="mt-5" onClick={onMore}>Show more activity</Button>}
  </div>
}
