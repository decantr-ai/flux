import { HelpHint } from './ui/HelpHint'
import { FileSearch } from 'lucide-react'
import type { ContextManifest } from '../lib/types'
import { Badge } from './ui/Badge'

export function ContextCoverage({ manifest }: { manifest?: ContextManifest }) {
  if (!manifest) return null
  const omitted = manifest.omittedRecordIds.length
  const shortened = manifest.shortenedRecordIds.length
  const currentPlan = manifest.essentialCoverage?.currentPlan
  return <div className="context-coverage">
    <div className="context-coverage-heading help-heading"><FileSearch size={15} aria-hidden="true" /><strong>Context for Codex</strong><HelpHint topic="context-coverage" /><Badge variant={manifest.mode === 'audit' ? 'neutral' : 'rose'}>{manifest.mode === 'audit' ? 'Read-only check' : 'Change request'}</Badge></div>
    {currentPlan && currentPlan !== 'included' && <p className="context-essential-warning" role="status"><strong>Current plan {currentPlan === 'budget_omitted' ? 'left out to fit the message' : currentPlan === 'not_selected' ? 'not selected' : 'not available'}.</strong> {currentPlan === 'budget_omitted' ? 'This preview does not include the saved plan. Narrow the request or choose fewer optional sources before relying on a plan assessment.' : currentPlan === 'not_selected' ? 'The current plan was not among the selected context sources. Select it and prepare a new preview if the question depends on it.' : 'No eligible current plan source was available for this message. A plan assessment has limited backing.'}</p>}
    {manifest.roleCoverage && <ul className="context-role-coverage" aria-label="Context coverage by role">{manifest.roleCoverage.map(role => <li key={role.role}><strong>{role.label}</strong><span>{role.includedCount} of {role.selectedCount} selected sources included{role.omittedCount ? ` · ${role.omittedCount} left out` : ''}{role.shortenedCount ? ` · ${role.shortenedCount} excerpted` : ''}</span></li>)}</ul>}
    <p>{manifest.includedCount} of {manifest.selectedCount} optional sources included. Your exact request and project direction are included separately.</p>
    {(omitted > 0 || shortened > 0 || manifest.targetDetailsShortened) && <p className="context-coverage-warning">{omitted > 0 && <>{omitted} sources omitted. </>}{shortened > 0 && <>{shortened} sources shortened. </>}{manifest.targetDetailsShortened && <>Some work details are shortened. </>}Codex is told what is missing.</p>}
    {manifest.latestDirectionShortened || manifest.goalShortened ? <p className="context-coverage-warning">The project direction is excerpted. Narrow the question if a missing detail could affect the answer.</p> : null}
    <details><summary>Inspect coverage</summary>
      <p>{manifest.focusRelation === 'aligned' ? 'The saved focus refers to your latest direction.' : manifest.focusRelation === 'earlier_direction' ? 'The saved focus predates your latest direction. Codex must reconcile the difference.' : 'A current focus is not established by an anchored record.'}</p>
      {manifest.unlinkedConstraintCount > 0 && <p>{manifest.unlinkedConstraintCount} project constraints lack source links and are excluded from this packet.</p>}
      <ul>{manifest.sources.map(source => <li key={source.id}><span>{source.ref}{source.shortened ? ' · excerpt' : ''}</span><code>{source.id}</code></li>)}</ul>
      {omitted > 0 && <p>Omitted source IDs: {manifest.omittedRecordIds.join(', ')}</p>}
    </details>
  </div>
}
