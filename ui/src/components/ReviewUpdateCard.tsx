import { HelpHint } from './ui/HelpHint'
import { ArrowUpRight, Layers3 } from 'lucide-react'
import { collectReviewGroups } from '../lib/helpers'
import type { FluxSnapshot } from '../lib/types'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'

export function ReviewUpdateCard({ snapshot, onReview }: { snapshot: FluxSnapshot; onReview: () => void }) {
  const groups = collectReviewGroups(snapshot)
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const sent = groups.some(group => group.feedback?.status === 'queued')
  if (!total) return null
  return <section className="review-update-card" aria-labelledby="review-update-heading">
    <div className="review-update-mark" aria-hidden="true"><Layers3 size={18} /></div>
    <div className="review-update-copy">
      <div className="review-update-heading help-heading"><h2 id="review-update-heading">Ready for review</h2><Badge variant="rose">{total}</Badge><HelpHint topic="review-update" /></div>
      <p>{sent ? `${total} changes have feedback queued for Codex.` : `${total} changes in ${groups.length} groups. Review them together when you’re ready.`}</p>
    </div>
    <Button variant="secondary" onClick={onReview}><span>Review update</span><ArrowUpRight size={15} aria-hidden="true" /></Button>
  </section>
}
