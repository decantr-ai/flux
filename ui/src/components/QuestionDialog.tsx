import { HelpHint } from './ui/HelpHint'
import { Dialog } from '@base-ui/react/dialog'
import { Check, Clipboard, Send, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { prepareQuestion, sendQuestion } from '../lib/api'
import { formatDate, getEvidenceLabel } from '../lib/helpers'
import type { DiagnosticDraft, DiagnosticRequest, FluxSnapshot } from '../lib/types'
import type { QuestionDraft } from '../lib/question-drafts'
import { canSendQuestion, currentQuestionRequest, earlierDeliveryNotice, questionDeliveryUnconfirmed, requestInQuestionScope, sourceChoicesForDraft } from '../lib/question-drafts'
import { Badge } from './ui/Badge'
import { ContextCoverage } from './ContextCoverage'
import { Button } from './ui/Button'
import { FieldLabel, Textarea } from './ui/Field'
import ReadableMessage from './ReadableMessage'

export function QuestionDialog({ snapshot, open, onOpenChange, local, onEdit, onPrepared, onRevise, onViewRequest, onDeliveryError, storageNotice, refresh }: {
  snapshot: FluxSnapshot
  open: boolean
  onOpenChange: (value: boolean) => void
  local: QuestionDraft
  onEdit: (patch: { question?: string; recordIds?: string[] }) => void
  onPrepared: (requestId: string, submittedQuestion: string, submittedRecordIds: string[]) => void
  onRevise: (request: DiagnosticRequest) => void
  onViewRequest: (request: DiagnosticRequest) => void
  onDeliveryError: (error: string) => void
  storageNotice: string
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  // Server records own request status. Passive refresh never writes authored text.
  const scope = { projectId: snapshot.project.id, sessionId: snapshot.project.sessionId }
  const request = snapshot.project.sessions.some(session => session.id === scope.sessionId) ? currentQuestionRequest(local, snapshot.requests, scope, snapshot.events) : undefined
  const predecessor = snapshot.project.sessions.some(session => session.id === scope.sessionId) ? snapshot.requests.find(value => value.id === local.basedOnRequestId && requestInQuestionScope(value,scope,snapshot.events)) : undefined
  const earlier = earlierDeliveryNotice(local.priorDeliveryError,predecessor)
  const waiting = request && ['queued','acknowledged'].includes(request.status)
  const completed = request?.status === 'completed'
  const verifiedScope = request?.projectId === snapshot.project.id && request?.sessionId === snapshot.project.sessionId
  const stale = request?.status === 'prepared' && request.contextRevision !== snapshot.contextRevision
  const sourceIds = request?.recordIds ?? local.recordIds
  const sources = new Map(snapshot.events.map(event => [event.id, event]))
  const deliveryError = request?.error || local.deliveryError
  const failed = questionDeliveryUnconfirmed(request, deliveryError)
  const ready = canSendQuestion(request, scope, snapshot.contextRevision, deliveryError)

  async function prepare() {
    if (busy || !local.question.trim() || local.mode !== 'edit') return
    setBusy(true); setError('')
    const submittedQuestion = local.question, submittedRecordIds = [...local.recordIds]
    try {
      const prepared = await prepareQuestion(snapshot, submittedQuestion, submittedRecordIds, local.baselinePlanId ?? undefined, local.selectedItemId ?? undefined)
      await refresh(); onPrepared(prepared.id, submittedQuestion, submittedRecordIds)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The question could not be prepared.')
      if (cause instanceof Error && 'status' in cause && cause.status === 409) await refresh()
    } finally { setBusy(false) }
  }

  async function send() {
    if (!request || busy || !ready) return
    setBusy(true); setError('')
    try {
      const sent = await sendQuestion(snapshot, request as DiagnosticDraft)
      if (sent.status === 'failed') onDeliveryError(sent.error || 'Codex delivery failed.')
      await refresh()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The question could not be sent.'
      onDeliveryError(message); await refresh()
    } finally { setBusy(false) }
  }

  async function copyPrompt() {
    if (!request?.prompt) return
    try { await navigator.clipboard.writeText(request.prompt); setCopied(true); setTimeout(() => setCopied(false), 1400) }
    catch { setError('Clipboard access is unavailable. The full prompt remains visible below.') }
  }

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Viewport className="dialog-viewport"><Dialog.Popup className="question-dialog">
      <header className="dialog-head"><div><p className="eyebrow">Ask Codex · read-only</p><Dialog.Title className="question-title">{local.mode === 'edit' ? 'Write your question' : completed ? 'Recorded answer' : 'Review your question'}</Dialog.Title></div><Dialog.Close render={<Button aria-label="Close question" variant="ghost" size="icon" />}><X size={18} /></Dialog.Close></header>
      <Dialog.Description className="question-description">Your question does not authorize changes to work. Drafts and excluded sources are kept separately from immutable server previews.</Dialog.Description>
      {storageNotice && <p className="storage-notice" role="status">{storageNotice}</p>}
      {local.mode === 'edit' ? <div className="question-form">
        {local.basedOnRequestId && <p className="question-description">This is a new draft. The earlier request stays in your question history; review a new preview before sending.</p>}
        {local.previewNotice && <p className="storage-notice" role="status">{local.previewNotice}</p>}
        {earlier.kind==='receipt' && predecessor ? <div className="question-callout"><Check size={16}/><span><strong>The earlier request is now {earlier.status}.</strong><p>Your edits are preserved. Review the earlier status or answer before deciding whether another message is needed.</p><Button size="small" variant="secondary" disabled={busy} onClick={()=>onViewRequest(predecessor)}>View earlier {predecessor.status==='completed'?'answer':'status'}</Button></span></div> : earlier.kind==='uncertain' && <div className="question-callout warning" role="alert"><TriangleAlert size={16} /><span><strong>Earlier delivery not confirmed.</strong><p>{earlier.error}</p><p>The native client may have received the earlier request. Check before preparing another attempt.</p></span></div>}
        <FieldLabel htmlFor="question-text">Your question</FieldLabel>
        <Textarea id="question-text" value={local.question} maxLength={1000} disabled={busy} onChange={event => onEdit({ question: event.target.value })} autoFocus />
        <details className="question-evidence" open><summary>Suggested context <Badge variant="neutral">{local.recordIds.length} selected</Badge></summary><div className="help-inline"><span className="empty-inline">Choose optional sources for the preview.</span><HelpHint topic="source-selection" /></div>
          <div className="question-evidence-list">{sourceChoicesForDraft(local.availableRecordIds, local.recordIds, snapshot.events).map(({ id, record }) => {
            return <label key={id}><input type="checkbox" disabled={busy} checked={local.recordIds.includes(id)} onChange={event => onEdit({ recordIds: event.target.checked ? [...new Set([...local.recordIds, id])] : local.recordIds.filter(value => value !== id) })} /><span><strong>{record?.summary || record?.kind || `Source unavailable: ${id}`}</strong><small>{getEvidenceLabel(record?.provenance)} · {formatDate(record?.at)}</small></span></label>
          })}</div>
          {!local.availableRecordIds.length && <p className="empty-inline">No optional sources selected. Your latest direction and goal are still included.</p>}
        </details>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><HelpHint topic="preview-send" /><Button variant="primary" onClick={() => void prepare()} disabled={busy || !local.question.trim()}>{busy ? 'Preparing…' : 'Review prompt and sources'}</Button></div>
      </div> : !request ? <div className="question-preview"><p role="alert" className="form-error">This server request is unavailable in the current project and chat. The authored draft is preserved.</p><Button onClick={() => onRevise({ id: local.requestId || '', question: local.question, recordIds: local.recordIds, selectedItemId: local.selectedItemId, baselinePlanId: local.baselinePlanId, status: 'unknown' })}>Edit as a new draft</Button></div> : <div className="question-preview">
        <ContextCoverage manifest={request.contextManifest} />
        {completed ? <div className="question-callout success"><Check size={16} /><span>Codex’s answer is recorded. This receipt does not establish that project work is complete.</span></div>
          : failed ? <div className="question-callout warning" role="alert"><TriangleAlert size={16} /><span><strong>Delivery not confirmed.</strong><p>{deliveryError || 'The delivery attempt failed.'}</p><p>The native client may have received the message. Check its status before preparing another attempt; Flux will not automatically resend.</p></span></div>
          : waiting ? <div className="question-callout"><Send size={16} /><span>{request.status === 'acknowledged' ? 'Receipt acknowledged.' : 'Accepted by the Codex queue; receipt is not yet verified.'} Waiting for a recorded answer. Work completion is not established.</span></div>
          : stale || !verifiedScope ? <div className="question-callout warning"><TriangleAlert size={16} /><span>{stale ? 'The current direction or work changed.' : 'This earlier preview has no verified project and chat scope.'} Create a new draft and review a fresh preview.</span></div>
          : <div className="question-callout"><TriangleAlert size={16} /><span>Review only. Sending does not authorize recommendations in the answer.</span></div>}
        <div className="preview-question"><span className="eyebrow">Question · {request.status}</span><p>{request.question}</p></div>
        <details className="question-evidence"><summary>Reviewed optional sources <Badge>{sourceIds.length}</Badge></summary><ul>{sourceIds.map(id => <li key={id}>{sources.get(id)?.summary || id}</li>)}</ul></details>
        {completed && request.result && <ReadableMessage text={request.result} sourceId={request.resultSourceId || request.id} csrfToken={snapshot.csrfToken} />}
        <details className="exact-context"><summary>Exact reviewed prompt</summary><pre>{request.prompt || 'The saved prompt is unavailable.'}</pre></details>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><HelpHint topic="preview-send" /><Button variant="secondary" onClick={() => void copyPrompt()} disabled={!request.prompt}>{copied ? <Check size={16} /> : <Clipboard size={16} />}{copied ? 'Copied' : 'Copy prompt'}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => onRevise(request)}>{failed ? 'Prepare another attempt' : completed || waiting ? 'Ask a new question from this' : stale || !verifiedScope ? 'Edit and prepare again' : 'Edit question'}</Button>
          {ready && <Button variant="primary" onClick={() => void send()} disabled={busy}>{busy ? 'Sending…' : 'Send to Codex'}<Send size={15} /></Button>}
        </div>
      </div>}
    </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
  </Dialog.Root>
}
