import { Dialog } from '@base-ui/react/dialog'
import { lazy, Suspense } from 'react'
import { CheckCircle2, ChevronDown, Info, X } from 'lucide-react'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { formatDate, getEvidenceLabel, labelFor, sourceRecords, statusVariant } from '../lib/helpers'
import { markdownText } from '../../../src/markdown.mjs'
import type { FluxSnapshot, WorkItem } from '../lib/types'

const ReadableMessage = lazy(() => import('./ReadableMessage'))
const ContentReference = lazy(() => import('./ReadableMessage').then(module => ({ default: module.ContentReference })))

export function Inspector({ snapshot, item, open, onOpenChange, onReviewGroup }: {
  snapshot: FluxSnapshot
  item: WorkItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onReviewGroup: () => void
}) {
  if (!item) return null
  const original = snapshot.events.find(source => source.id === item.id)
  const isMessage = Boolean(original && ['message.assistant', 'message.user', 'assistant_message', 'user_message'].includes(original.kind))
  const sourceId = original?.id || item.id
  const sources = sourceRecords(snapshot, item.sourceIds).filter(source => source.id !== original?.id)
  const body = original?.text || (original?.kind === 'verification' && typeof original.data?.details === 'string' ? original.data.details : item.purpose) || 'Purpose has not been recorded.'
  const reviewed = item.review
  const state = reviewed?.outcome === 'accepted' ? 'Accepted by you' : reviewed?.outcome === 'changes_requested' ? 'Changes requested' : labelFor(item.status)
  const actor = original?.actor || item.actor || item.owner
  const recorded = original?.at || item.at
  const heading = isMessage ? original?.provenance === 'user' ? 'Your message' : 'Codex message' : 'Work details'
  const messageProps = { sourceId, csrfToken: snapshot.csrfToken }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="inspector-backdrop" />
      <Dialog.Viewport className="inspector-viewport">
        <Dialog.Popup className="inspector-panel">
          <header className="inspector-header">
            <div><Dialog.Title className="inspector-kicker">{heading}</Dialog.Title><Badge variant="neutral">{getEvidenceLabel(original?.provenance || item.provenance)}</Badge></div>
            <Dialog.Close render={<Button aria-label="Close details" variant="ghost" size="icon" />}><X size={18} /></Dialog.Close>
          </header>
          <div className="inspector-body">
            {!isMessage && <h2 className="inspector-title">{markdownText(item.title)}</h2>}
            {(actor || recorded) && <p className="message-recorded">{[actor, recorded ? formatDate(recorded) : ''].filter(Boolean).join(' · ')}</p>}
            <Suspense fallback={<p className="empty-inline">Loading message…</p>}>
              <ReadableMessage key={sourceId} {...messageProps} text={body} />
              <details className="inspector-record-details"><summary><Info size={14} />Record details<ChevronDown size={14} /></summary>
                <dl className="inspector-meta">
                  <div><dt>{original ? 'Record type' : 'Status'}</dt><dd><Badge variant={statusVariant(reviewed?.outcome || item.status)}>{state}</Badge></dd></div>
                  <div><dt>Owner</dt><dd>{actor || 'Not recorded'}</dd></div>
                  {item.returnCondition && <div><dt>Return condition</dt><dd><ReadableMessage {...messageProps} text={item.returnCondition} controls={false} /></dd></div>}
                  {reviewed && <div><dt>Your note</dt><dd><ReadableMessage {...messageProps} text={reviewed.note || 'No note recorded.'} controls={false} /></dd></div>}
                  {original?.source?.ref && <div><dt>Original record location</dt><dd><ContentReference {...messageProps} href={original.source.ref} /></dd></div>}
                </dl>
              </details>
              {item.status === 'ready_for_review' || item.status === 'ready-for-review' ? <div className="inspector-review"><p>This change is part of the grouped Flux update.</p><Button variant="secondary" className="w-full" onClick={onReviewGroup}>Review the whole update</Button></div> : null}
              {sources.length > 0 && <section className="inspector-sources">
                <h3>Evidence <span>{sources.length}</span></h3>
                {sources.map(source => <details key={source.id} className="evidence-card"><summary><span>{markdownText(source.summary || source.kind)}</span><ChevronDown size={14} /></summary>
                  <div className="evidence-meta">{getEvidenceLabel(source.provenance)} · {source.actor || 'Source'} · {formatDate(source.at)}</div>
                  <ReadableMessage sourceId={source.id} csrfToken={snapshot.csrfToken} text={source.text || (typeof source.data?.details === 'string' ? source.data.details : source.summary) || source.kind} />
                  {source.source?.ref && <div className="evidence-ref"><ContentReference sourceId={source.id} csrfToken={snapshot.csrfToken} href={source.source.ref} /></div>}
                </details>)}
              </section>}
            </Suspense>
            {reviewed?.outcome === 'accepted' && <p className="review-accepted"><CheckCircle2 size={15} /> Acceptance is recorded in Flux. It does not certify independent test evidence.</p>}
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
}
