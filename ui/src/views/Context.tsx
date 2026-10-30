import { HelpHint } from '../components/ui/HelpHint'
import { ArrowUpRight, Search } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Field'
import { UiSelect } from '../components/ui/Select'
import { formatDate, labelFor } from '../lib/helpers'
import type { FluxSnapshot, SourceRecord } from '../lib/types'

export function ContextView({ snapshot, mode, onMode, query, onQuery, included, onIncluded, count, onMore, onAsk, onSelect }: {
  snapshot: FluxSnapshot
  mode: string
  onMode: (value: string) => void
  query: string
  onQuery: (value: string) => void
  included: string[]
  onIncluded: (ids: string[]) => void
  count: number
  onMore: () => void
  onAsk: (question: string, ids: string[]) => void
  onSelect: (record: SourceRecord) => void
}) {
  const relevant = new Set(snapshot.overview.events.map(event => event.id))
  const selected = new Set(included)
  const records = snapshot.events.filter(event => {
    if (mode === 'relevant' && !relevant.has(event.id) && !selected.has(event.id)) return false
    if (sessionMismatch(event, snapshot)) return false
    return !query || `${event.summary ?? ''} ${event.text ?? ''} ${event.id}`.toLowerCase().includes(query.toLowerCase())
  }).sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || Date.parse(b.at ?? '') - Date.parse(a.at ?? ''))
  const shown = records.slice(0, count)
  function toggle(id: string, checked: boolean) { onIncluded(checked ? [...new Set([...included, id])] : included.filter(value => value !== id)) }

  return <div className="detail-view context-view">
    <header className="detail-heading"><div><p className="eyebrow">Choose evidence for a Codex question</p><div className="help-heading"><h2>Context</h2><HelpHint topic="source-selection" /></div><p>Checked records are candidates for the bounded prompt and may be omitted or excerpted. Inspect the preview before sending; your latest direction and project goal are included separately.</p></div></header>
    <section className="direction-card"><div><span className="eyebrow">Latest user direction</span><Badge variant="success">Always included</Badge></div><p>{snapshot.overview.direction.text || 'No current user direction is recorded.'}</p></section>
    <div className="context-controls"><label><span className="field-label">Records</span><UiSelect ariaLabel="Context record scope" value={mode} onValueChange={onMode} options={[{ value: 'relevant', label: 'Work, decisions and evidence' }, { value: 'all', label: 'All captured records' }]} /></label><label className="context-search"><span className="sr-only">Search context records</span><Search size={16} /><Input type="search" placeholder="Find a source" value={query} onChange={event => onQuery(event.target.value)} /></label><Badge variant="rose">{included.length} selected</Badge></div>
    <div className="context-actions"><Button variant="quiet" size="small" onClick={() => onIncluded([])} disabled={!included.length}>Clear selection</Button><Button variant="quiet" size="small" onClick={() => onIncluded(defaultSources(snapshot))}>Use suggested sources</Button><Button variant="primary" onClick={() => onAsk('Where are we with the current plan?', included)}><ArrowUpRight size={15} />Ask with selected sources</Button></div>
    <p className="empty-inline">Use suggested sources replaces your current selection.</p>
    {shown.length ? shown.map(event => <SourceRow key={event.id} event={event} checked={selected.has(event.id)} onToggle={checked => toggle(event.id, checked)} onSelect={() => onSelect(event)} />) : <p className="empty-state">No source records match.</p>}
    {records.length > shown.length && <Button variant="secondary" className="mt-5" onClick={onMore}>Show more records</Button>}
    <p className="evidence-note">Tools and limited metadata may be captured. Hidden model reasoning is never included.</p>
  </div>
}

function SourceRow({ event, checked, onToggle, onSelect }: { event: SourceRecord; checked: boolean; onToggle: (value: boolean) => void; onSelect: () => void }) {
  return <article className="source-row">
    <input type="checkbox" checked={checked} onChange={event => onToggle(event.target.checked)} aria-label={`Include ${event.summary || event.kind}`} />
    <div className="source-row-body"><button className="source-row-title" onClick={onSelect}>{event.summary || labelFor(event.kind)}</button><small>{labelFor(event.provenance)} · {event.actor || 'Not recorded'} · {formatDate(event.at)}</small>{event.text && <p>{event.text.slice(0, 280)}{event.text.length > 280 ? '…' : ''}</p>}<button className="text-link" onClick={onSelect}>Inspect source <ArrowUpRight size={13} /></button></div>
  </article>
}

function sessionMismatch(event: SourceRecord, snapshot: FluxSnapshot) {
  return Boolean(event.sessionId && snapshot.project.sessionId && event.sessionId !== snapshot.project.sessionId)
}

function defaultSources(snapshot: FluxSnapshot) {
  if (snapshot.contextSuggestions) return snapshot.contextSuggestions.diagnostic.map(source => source.id)
  return [...new Set([...snapshot.overview.focus.sourceIds, ...snapshot.overview.direction.sourceIds, ...(snapshot.project.plans.at(-1)?.sourceIds ?? [])])]
    .filter(id => snapshot.events.some(event => event.id === id)).slice(0, 8)
}
