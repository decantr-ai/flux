import { ArrowUpRight, Check, ChevronDown, Copy, MessageSquareText, Send } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { HelpHint } from './ui/HelpHint'
import { FieldLabel, Textarea } from './ui/Field'
import { answerFingerprint, answerStorageKey, copyAnswers, discardAnswer, draftFingerprint, editAnswer, partitionAnswers, readyAnswer } from '../lib/answer-drafts'
import type { AnswerDraft } from '../lib/answer-drafts'
import { AnswerSubmissionDialog } from './AnswerSubmissionDialog'
import { FluxApiError, prepareAnswers, sendAnswers } from '../lib/api'
import { answerHolds, answerSubmissionInScope, answerSubmissionLabel, answerTransportAvailable, mergeAnswerSubmissions, sameAnswerOwner, sameSubmissionAnswers, submissionAnswers } from '../lib/answer-submissions'
import { useAnswerDrafts } from '../lib/use-answer-drafts'
import { formatDate, getEvidenceLabel } from '../lib/helpers'
import type { AnswerSubmission, FluxSnapshot, IncomingQuestion, SourceRecord, WorkItem } from '../lib/types'

const statusLabels: Record<IncomingQuestion['status'], string> = {
  pending: 'Waiting for you',
  replied: 'Reply recorded',
  resolved: 'Closed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
}

function QuestionCard({ question, snapshot, onSelect, draft, ready, onEdit, onCopy, onSend, sendReady, hold }: { question: IncomingQuestion; snapshot: FluxSnapshot; onSelect: (item: WorkItem) => void; draft?: AnswerDraft; ready: boolean; onEdit: (question: IncomingQuestion, value: string) => void; onCopy: (draft: AnswerDraft) => void; onSend: (draft: AnswerDraft) => void; sendReady?: boolean; hold?: { submissionId: string; status: AnswerSubmission['status'] } }) {
  const answerId = useId()
  const sourcesFor = (ids: string[] = []) => ids.map(id => snapshot.events.find(event => event.id === id))
    .filter((event): event is SourceRecord => Boolean(event && (!event.sessionId || event.sessionId === question.sessionId) && (!event.projectId || event.projectId === snapshot.project.id)))
  const sources = sourcesFor(question.sourceIds)
  const resolutionSources = sourcesFor(question.resolutionSourceIds)
  const primary = sources.find(source => source.text) ?? sources[0]
  const resolution = resolutionSources.find(source => source.text) ?? resolutionSources[0]
  function inspect(source: SourceRecord, related: SourceRecord[], fallback: string) {
    onSelect({ ...source, title: source.summary || question.text, status: source.kind, purpose: source.text || fallback, sourceIds: related.map(record => record.id) })
  }
  return <article className="incoming-question-card" data-question-status={question.status}>
    <div className="incoming-question-heading"><h4 id={`${answerId}-question`}>{question.text}</h4><Badge variant="neutral">{hold ? { sending: 'Sending', queued: 'Queued', delivery_unconfirmed: 'Delivery unconfirmed', prepared: 'Prepared', received: 'Reply recorded from chat' }[hold.status] : statusLabels[question.status]}</Badge></div>
    {question.status !== 'pending' && <p className="incoming-question-recorded">{question.origin === 'work_item' ? 'Recorded work status' : question.status === 'replied' ? 'Reply evidence' : 'Recorded closure'} · {getEvidenceLabel(question.resolutionProvenance || question.provenance)}</p>}
    {question.status !== 'pending' && question.reason && <p className="incoming-question-reason"><strong>{question.status === 'replied' ? 'Recorded reply note' : 'Closure reason'}</strong> {question.reason}</p>}
    {!!question.options?.length && <div className="incoming-question-options"><span className="field-label">{question.status === 'pending' ? 'Choose an option or write your own' : 'Recorded options'}</span>{question.status === 'pending' ? <div className="answer-options">{question.options.map((option, index) => <Button key={index} className="answer-choice" variant="ghost" disabled={!ready} aria-pressed={draft?.answer === option} onClick={() => onEdit(question, option)}><span className="answer-choice-indicator" aria-hidden="true">{draft?.answer === option && <Check size={12} />}</span><span>{option}</span></Button>)}</div> : <ul>{question.options.map((option, index) => <li key={index}>{option}</li>)}</ul>}</div>}
    {question.status === 'pending' && <div className="answer-draft"><FieldLabel htmlFor={answerId}>Your answer</FieldLabel><Textarea id={answerId} aria-describedby={`${answerId}-question`} value={draft?.answer ?? ''} disabled={!ready} onChange={event => onEdit(question, event.target.value)} placeholder="Write an answer…" /></div>}
    {hold && <p className="incoming-question-recorded">This question has an answer message awaiting delivery. Check Answer messages below; your edits remain drafts.</p>}
    {question.answer && <div className="incoming-question-answer"><span className="field-label">Recorded reply</span><p>{question.answer}</p></div>}
    {question.resolutionNote && <div className="incoming-question-answer"><span className="field-label">{question.status === 'replied' ? 'Recorded reply note' : 'Recorded closure note'}</span><p>{question.resolutionNote}</p></div>}
    <div className="incoming-question-footer">
      {question.askedAt && <span className="incoming-question-time">Asked {formatDate(question.askedAt)}</span>}
      <div className="incoming-question-sources">
        {question.status === 'pending' && <Button variant="ghost" size="small" disabled={!sendReady || !draft} onClick={() => draft && onSend(draft)}><Send size={14} aria-hidden="true" />Send answer</Button>}
        {question.status === 'pending' && <Button variant="ghost" size="small" disabled={!draft || !readyAnswer(draft)} onClick={() => draft && onCopy(draft)}><Copy size={14} aria-hidden="true" />Copy answer</Button>}
        {primary ? <Button variant="ghost" size="small" onClick={() => inspect(primary, sources, question.text)}>View source<ArrowUpRight size={14} aria-hidden="true" /></Button> : <span className="empty-inline">Original source is unavailable in this capture.</span>}
        {resolution && <Button variant="ghost" size="small" onClick={() => inspect(resolution, resolutionSources, question.answer || question.resolutionNote || question.text)}>{question.status === 'replied' ? 'View reply source' : 'View closure source'}<ArrowUpRight size={14} aria-hidden="true" /></Button>}
        {!resolution && (question.answer || question.resolutionNote) && <span className="empty-inline">Reply or closure source is unavailable in this capture.</span>}
      </div>
    </div>
  </article>
}

export function IncomingQuestions({ snapshot, onSelect, refresh }: { snapshot: FluxSnapshot; onSelect: (item: WorkItem) => void; refresh?: () => Promise<void> }) {
  const headingId = useId()
  const { pending = [], history = [] } = snapshot.incomingQuestions ?? {}
  const scope = { projectId: snapshot.project.id, sessionId: snapshot.project.sessionId }
  const { collection, ready, edit, discard, storageNotice } = useAnswerDrafts(scope)
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null)
  const latest = useRef({ key: answerStorageKey(scope), epoch: 0, collection, pending })
  const activeKey = answerStorageKey(scope)
  const epoch = latest.current.epoch + (latest.current.key === activeKey ? 0 : 1)
  latest.current = { key: activeKey, epoch, collection, pending }
  const copySequence = useRef(0)
  const { ready: readyDrafts, recovery } = partitionAnswers(collection, pending)
  const [localSubmissions, setLocalSubmissions] = useState<AnswerSubmission[]>([])
  const [activeSubmission, setActiveSubmission] = useState<{ key: string; epoch: number; id: string } | null>(null)
  const [sendError, setSendError] = useState<{ key: string; id: string; message: string } | null>(null)
  type Operation = { key: string; epoch: number; kind: 'prepare' | 'send'; id?: string }
  const operation = useRef<Operation | null>(null)
  const [busy, setBusy] = useState<Operation | null>(null)
  const submissions = mergeAnswerSubmissions(snapshot, localSubmissions)
  const held = answerHolds(snapshot, submissions)
  const eligible = readyDrafts.filter(draft => !held.has(draft.questionId))
  const available = answerTransportAvailable(snapshot)
  const currentBusy = busy?.key === activeKey && busy.epoch === epoch
  const active = activeSubmission?.key === activeKey && activeSubmission.epoch === epoch ? submissions.find(value => value.id === activeSubmission.id) : undefined
  const own = (owner: { key: string; epoch: number }) => sameAnswerOwner(owner, latest.current)
  function remember(submission: AnswerSubmission) { setLocalSubmissions(values => [...values.filter(value => value.id !== submission.id), submission]) }
  function viewSubmission(submission: AnswerSubmission) { setSendError(null); setActiveSubmission({ key: activeKey, epoch, id: submission.id }) }
  async function reviewAnswers(drafts: AnswerDraft[]) {
    if (!ready || !available || !drafts.length || operation.current?.key === activeKey) return
    if (drafts.some(draft => !eligible.some(value => draftFingerprint(value) === draftFingerprint(draft) && value.answer === draft.answer))) return
    const existing = submissions.find(value => value.status === 'prepared' && value.contextRevision === snapshot.contextRevision && sameSubmissionAnswers(value, drafts) && !(sendError?.key === activeKey && sendError.id === value.id))
    if (existing) { viewSubmission(existing); return }
    const owner: Operation = { key: activeKey, epoch, kind: 'prepare' }
    operation.current = owner; setBusy(owner); setNotice(null)
    const answers = submissionAnswers(drafts)
    try {
      const prepared = await prepareAnswers(snapshot, answers)
      if (!own(owner)) return
      if (!answerSubmissionInScope(prepared, scope) || JSON.stringify(prepared.answers.map(({ questionId, answer }) => ({ questionId, answer }))) !== JSON.stringify(answers)) throw new Error('The prepared answer scope did not match. Your drafts are preserved.')
      remember(prepared); viewSubmission(prepared)
    } catch (cause) { if (own(owner)) setNotice({ key: activeKey, message: cause instanceof Error ? cause.message : 'The answers could not be prepared. Your drafts are preserved.' }) }
    finally { if (operation.current === owner) { operation.current = null; setBusy(null) }; await refresh?.().catch(() => {}) }
  }
  async function sendReviewed() {
    if (!active || active.status !== 'prepared' || !available || operation.current?.key === activeKey || active.contextRevision !== snapshot.contextRevision || active.answers.some(answer => held.has(answer.questionId))) return
    const frozen = structuredClone(active)
    const owner: Operation = { key: activeKey, epoch, kind: 'send', id: frozen.id }
    operation.current = owner; setBusy(owner); setSendError(null)
    remember({ ...frozen, status: 'sending' })
    try {
      const result = await sendAnswers(snapshot, frozen)
      if (!own(owner)) return
      if (!answerSubmissionInScope(result, scope) || result.id !== frozen.id || result.payloadHash !== frozen.payloadHash) throw new Error('The returned answer receipt did not match this preview. Check the Codex chat.')
      remember(result)
    } catch (cause) {
      if (!own(owner)) return
      const message = cause instanceof Error ? cause.message : 'Delivery was not confirmed. Check the original Codex chat before another attempt.'
      remember(cause instanceof FluxApiError && cause.status >= 400 && cause.status < 500 ? frozen : { ...frozen, status: 'delivery_unconfirmed', error: message })
      setSendError({ key: activeKey, id: frozen.id, message })
    } finally { if (operation.current === owner) { operation.current = null; setBusy(null) }; await refresh?.().catch(() => {}) }
  }
  function inspectReceipt(submission: AnswerSubmission) {
    const source = snapshot.events.find(event => event.id === submission.receiptSourceId && (!event.sessionId || event.sessionId === scope.sessionId) && (!event.projectId || event.projectId === scope.projectId))
    if (!source) return
    setActiveSubmission(null)
    onSelect({ ...source, title: source.summary || 'Captured answer message', status: source.kind, purpose: source.text || 'The captured message body is unavailable.', sourceIds: [source.id] })
  }
  function editDraft(question: IncomingQuestion, value: string) {
    latest.current.collection = editAnswer(latest.current.collection, question, value)
    setNotice(null); edit(question, value)
  }
  function discardDraft(draft: AnswerDraft) {
    const fingerprint = draftFingerprint(draft)
    latest.current.collection = discardAnswer(latest.current.collection, fingerprint)
    setNotice(null); discard(fingerprint)
  }
  async function copy(drafts: AnswerDraft[], requirePending: boolean, batch = false) {
    const key = answerStorageKey(scope), epoch = latest.current.epoch, sequence = ++copySequence.current
    const captured = drafts.map(draft => ({ ...draft, options: [...draft.options] }))
    const current = () => {
      if (latest.current.key !== key || latest.current.epoch !== epoch) return 'scope_changed' as const
      const selected = latest.current.collection.drafts
      const unchanged = captured.every(draft => selected.some(value => draftFingerprint(value) === draftFingerprint(draft) && value.answer === draft.answer))
      const stillPending = !requirePending || captured.every(draft => latest.current.pending.some(question => answerFingerprint(question) === draftFingerprint(draft)))
      const batchUnchanged = !batch || partitionAnswers(latest.current.collection, latest.current.pending).ready.length === captured.length
      return unchanged && stillPending && batchUnchanged ? 'same' as const : 'changed' as const
    }
    if (!navigator.clipboard?.writeText) { if (current() !== 'scope_changed') setNotice({ key, message: 'Could not copy. Select and copy the draft manually, then paste it in Codex.' }); return }
    const result = await copyAnswers(navigator.clipboard, captured, current)
    if (result === 'scope_changed' || sequence !== copySequence.current) return
    setNotice({ key, message: result === 'copied' ? 'Copied; paste in Codex.' : result === 'changed' ? 'Earlier drafts were copied; your newer edits are preserved.' : 'Could not copy. Select and copy the draft manually, then paste it in Codex.' })
  }
  return <section className="incoming-questions" aria-labelledby={headingId}>
    <header className="section-heading"><div><p className="eyebrow">From Codex</p><div className="help-heading"><MessageSquareText size={17} aria-hidden="true" /><h3 id={headingId}>Questions for you</h3><Badge variant={pending.length ? 'warning' : 'neutral'} aria-label={`${pending.length} waiting`}>{pending.length}</Badge><HelpHint topic="incoming-questions" /></div></div></header>
    {pending.length > 0 && <div className="answer-copy-bar"><div className="answer-copy-summary"><strong>{eligible.length} answer{eligible.length === 1 ? '' : 's'} ready to send{held.size > 0 ? ` · ${held.size} awaiting delivery` : ''}</strong><span>{available ? 'Review your exact answers, then send them as a message in this Codex chat.' : 'Restart the Flux service and refresh to enable answer sending. Copy remains available.'}</span></div><div className="answer-toolbar-actions"><Button variant="primary" className="answer-copy-primary" disabled={!ready || !available || !eligible.length || currentBusy} onClick={() => void reviewAnswers(eligible)}><Send size={16} aria-hidden="true" />{currentBusy && busy?.kind === 'prepare' ? 'Preparing…' : `Review and send ${eligible.length} answer${eligible.length === 1 ? '' : 's'}`}</Button><Button variant="ghost" size="small" disabled={!ready || !readyDrafts.length} onClick={() => void copy(readyDrafts, true, true)}><Copy size={14} aria-hidden="true" />Copy answers</Button></div></div>}
    {storageNotice && <p className="storage-notice" role="status">{storageNotice}</p>}
    {notice?.key === answerStorageKey(scope) && <p className="answer-copy-notice" role="status">{notice.message}</p>}
    {pending.length ? <ul className="incoming-question-list" aria-label="Questions waiting for you">{pending.map(question => <li key={question.id}><QuestionCard question={question} snapshot={snapshot} onSelect={onSelect} draft={collection.drafts.find(draft => draftFingerprint(draft) === answerFingerprint(question))} ready={ready} onEdit={editDraft} onCopy={draft => void copy([draft], true)} onSend={draft => void reviewAnswers([draft])} sendReady={ready && available && !currentBusy && !held.has(question.id) && eligible.some(draft => draft.questionId === question.id)} hold={held.get(question.id)} /></li>)}</ul> : <p className="empty-inline">No recorded questions are waiting.</p>}
    {submissions.length > 0 && <details className="incoming-question-history answer-submission-history"><summary><span>Answer messages</span><Badge>{submissions.length}</Badge><ChevronDown size={15} aria-hidden="true" /></summary><p className="incoming-question-history-note">Queue acceptance and captured replies are separate. Native question controls may remain open.</p><ul className="answer-message-list">{submissions.slice().reverse().map(submission => <li key={submission.id}><div><strong>{submission.answers.length} answer{submission.answers.length === 1 ? '' : 's'}</strong><Badge variant={submission.status === 'delivery_unconfirmed' ? 'warning' : 'neutral'}>{answerSubmissionLabel(submission)}</Badge>{submission.status === 'received' && <span className="incoming-question-recorded">Captured public user message</span>}{submission.error && <p className="form-error">{submission.error}</p>}</div><Button variant="quiet" size="small" disabled={currentBusy} onClick={() => viewSubmission(submission)}>{submission.status === 'prepared' ? 'Review prepared answers' : 'View message status'}</Button></li>)}</ul></details>}
    {recovery.length > 0 && <details className="incoming-question-history" open><summary><span>Saved drafts needing attention</span><Badge>{recovery.length}</Badge><ChevronDown size={15} aria-hidden="true" /></summary><p className="incoming-question-history-note">These questions changed, closed, or are no longer available. Their drafts are saved here for recovery and are not included in the current batch.</p><ul className="incoming-question-list">{recovery.map(draft => <li key={draftFingerprint(draft)}><article className="incoming-question-card"><h4>{draft.questionText}</h4><p className="answer-recovery-text">{draft.answer}</p><div className="answer-draft-actions"><Button variant="secondary" size="small" onClick={() => void copy([draft], false)}>Copy saved draft</Button><Button variant="quiet" size="small" onClick={() => discardDraft(draft)}>Discard saved draft</Button></div></article></li>)}</ul></details>}
    {history.length > 0 && <details className="incoming-question-history"><summary><span>Question history</span><Badge>{history.length}</Badge><ChevronDown size={15} aria-hidden="true" /></summary><p className="incoming-question-history-note">A recorded reply does not mean the decision is closed.</p><ul className="incoming-question-list" aria-label="Earlier questions for you">{history.map(question => <li key={question.id}><QuestionCard question={question} snapshot={snapshot} onSelect={onSelect} ready={ready} onEdit={editDraft} onCopy={draft => void copy([draft], false)} onSend={() => {}} /></li>)}</ul></details>}
    {active && <AnswerSubmissionDialog submission={active} destination={snapshot.project.sessions.find(session => session.id === scope.sessionId)?.title || scope.sessionId} open onOpenChange={open => { if (!open) setActiveSubmission(null) }} onSend={() => void sendReviewed()} onSource={active.receiptSourceId && snapshot.events.some(event => event.id === active.receiptSourceId) ? () => inspectReceipt(active) : undefined} busy={currentBusy && busy?.kind === 'send'} error={sendError?.key === activeKey && sendError.id === active.id && ['prepared', 'delivery_unconfirmed'].includes(active.status) ? sendError.message : ''} stale={active.contextRevision !== snapshot.contextRevision} available={available} blocked={active.answers.some(answer => held.has(answer.questionId))} draftsChanged={active.answers.some(answer => collection.drafts.some(draft => draft.questionId === answer.questionId && draft.questionText === answer.questionText && draft.answer !== answer.answer))} />}
  </section>
}
