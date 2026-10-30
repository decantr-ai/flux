import { Send } from 'lucide-react'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { HelpHint } from './ui/HelpHint'
import { UiDialog } from './ui/UiDialog'
import { answerSubmissionLabel } from '../lib/answer-submissions'
import type { AnswerSubmission } from '../lib/types'

export function AnswerSubmissionDialog({ submission, destination, open, onOpenChange, onSend, onSource, busy, error, stale, available, blocked, draftsChanged }: {
  submission: AnswerSubmission; destination: string; open: boolean; onOpenChange: (open: boolean) => void
  onSend: () => void; onSource?: () => void; busy: boolean; error: string; stale: boolean; available: boolean; blocked: boolean; draftsChanged: boolean
}) {
  const count = submission.answers.length
  const prepared = submission.status === 'prepared'
  return <UiDialog open={open} onOpenChange={onOpenChange} title={prepared ? `Review ${count} answer${count === 1 ? '' : 's'}` : 'Answer message status'} description="Sends your answers as a message in this chat. Native question controls may remain open." width="max-w-3xl">
    <div className="answer-review-destination"><span className="field-label">Destination</span><strong>{destination}</strong><Badge>{answerSubmissionLabel(submission)}</Badge></div>
    {submission.status === 'queued' && <p className="storage-notice" role="status">Accepted by the message queue. A captured reply is not yet established; work completion is separate.</p>}
    {submission.status === 'sending' && <p className="storage-notice" role="status">Sending this reviewed message. Another send is held while delivery is pending.</p>}
    {submission.status === 'delivery_unconfirmed' && <p className="form-error" role="alert">Delivery is unconfirmed. {submission.error} Check the original Codex chat before another attempt; Flux does not resend automatically.</p>}
    {submission.status === 'received' && <p className="storage-notice" role="status">The exact answer message was captured as a public user message in this chat. {submission.outcomes?.some(outcome => outcome.status === 'conflict') ? 'Some questions changed or already had different replies; those records were preserved.' : 'Replies were recorded from the captured message.'} This does not establish decision closure or native control acknowledgment.</p>}
    {prepared && draftsChanged && <p className="storage-notice">This preview keeps the earlier answers shown below. Your newer edits remain in drafts.</p>}
    {prepared && stale && <p className="form-error" role="alert">The questions or current context changed. Your drafts are preserved; close this preview and review the current eligible answers again.</p>}
    {!available && prepared && <p className="storage-notice" role="status">Answer sending requires the updated Flux service. Restart it, then refresh; copying your drafts remains available.</p>}
    {blocked && prepared && <p className="form-error" role="alert">One of these questions has an answer message awaiting delivery. Check its status before another attempt.</p>}
    <ol className="answer-review-list">{submission.answers.map(answer => <li key={answer.questionId}><h3>{answer.questionText}</h3><span className="field-label">Your exact answer</span><p>{answer.answer}</p></li>)}</ol>
    <details className="exact-context"><summary>Exact reviewed message</summary><pre>{submission.prompt}</pre></details>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions answer-review-actions"><HelpHint topic="answer-send" />{onSource && <Button variant="quiet" onClick={onSource}>View captured message</Button>}<Button variant="secondary" onClick={() => onOpenChange(false)}>{prepared ? 'Back to drafts' : 'Close'}</Button>{prepared && <Button variant="primary" disabled={busy || !!error || stale || !available || blocked} onClick={onSend}><Send size={15} aria-hidden="true" />{busy ? 'Sending…' : `Send ${count} answer${count === 1 ? '' : 's'} to Codex`}</Button>}</div>
  </UiDialog>
}
