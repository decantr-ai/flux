import { ArrowUpRight, MessageSquareText } from 'lucide-react'
import { HelpHint } from './ui/HelpHint'
import type { OverviewCard } from '../lib/types'

export function NewRequestBanner({ request, at, busyQuestion }: { request: OverviewCard; at?: string | null; busyQuestion?: boolean }) {
  if (!request.text) return null
  return <section key={request.sourceIds[0]} className="new-request" aria-labelledby="new-request-title">
    <div className="new-request-mark"><img src="/images/flux-progress-beacon.png" alt="" /></div>
    <div className="new-request-copy">
      <div className="new-request-heading"><MessageSquareText size={15} aria-hidden="true" /><span id="new-request-title">Your latest request</span><HelpHint topic="latest-request" />{busyQuestion && <span className="request-state">Question waiting for Codex</span>}</div>
      <p>The saved focus hasn’t been updated to reflect this yet.</p>
      <details className="new-request-details">
        <summary><span className="request-excerpt">{request.text}</span><span className="request-expand">Read request <ArrowUpRight size={13} /></span></summary>
        <div className="request-full">{request.text}<span>{at ? `Received ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))}` : 'Received · time not recorded'}</span></div>
      </details>
    </div>
    <span className="new-request-rail" aria-hidden="true" />
  </section>
}
