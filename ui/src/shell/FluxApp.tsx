import { HelpHint } from '../components/ui/HelpHint'
import { CircleHelp, Clock3, Files, FolderKanban, GitCompareArrows, House, ListChecks, MessageSquareText, RefreshCw } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FilterPanel } from '../components/FilterPopover'
import { QuestionDialog } from '../components/QuestionDialog'
import { ReviewUpdateDialog } from '../components/ReviewUpdateDialog'
import { ThemeMenu } from '../components/ThemeMenu'
import { Button } from '../components/ui/Button'
import { getSnapshot } from '../lib/api'
import { chooseCheckpoint, followLatest, scopedCheckpointSelection, snapshotIsFresh } from '../lib/checkpoint-selection'
import { TABS, collectReviewGroups, reviewGroupId, type TabId } from '../lib/helpers'
import type { FluxSnapshot, SourceRecord, WorkItem } from '../lib/types'
import { ChangesView } from '../views/Changes'
import { ContextView } from '../views/Context'
import { DecisionsView } from '../views/Decisions'
import { Overview } from '../views/Overview'
import { PlanView } from '../views/Plan'
import { UiTabs } from '../components/ui/Tabs'
import { QuestionRequests } from '../components/QuestionRequests'
import { useQuestionDrafts } from '../lib/use-question-drafts'
import { draftFromRequest, questionStorageKey, requestInQuestionScope, hasQuestionReceipt } from '../lib/question-drafts'
import type { DiagnosticRequest } from '../lib/types'
import type { ReviewFeedbackDraft } from '../lib/types'
import { useReviewDrafts } from '../lib/use-review-drafts'
import { reviewFromRequest, reviewInScope } from '../lib/review-drafts'
import { ReviewRequests } from '../components/ReviewRequests'
const Inspector = lazy(() => import('../components/Inspector').then(module => ({ default: module.Inspector })))
const TimelineView = lazy(() => import('../views/Timeline').then(module => ({ default: module.TimelineView })))

type InspectorRecord = WorkItem | (SourceRecord & { title: string; status: string; purpose: string; sourceIds: string[] })

const tabValue = (value: string | null): value is TabId => TABS.some(tab => tab.id === value)

function sourceAsWork(source: SourceRecord): InspectorRecord {
  return { ...source, title: source.summary || source.kind, status: source.kind, purpose: source.text || source.summary || 'No public text recorded.', sourceIds: [source.id] }
}

export function FluxApp() {
  const [snapshot, setSnapshot] = useState<FluxSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [streamState, setStreamState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const [tab, setTab] = useState<TabId>(() => {
    try { const value = localStorage.getItem('flux:flux'); return tabValue(value) ? value : 'overview' } catch { return 'overview' }
  })
  const [session, setSession] = useState('')
  const [actor, setActor] = useState('')
  const [inspector, setInspector] = useState<InspectorRecord | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [timelineMode, setTimelineMode] = useState('meaningful')
  const [timelineKind, setTimelineKind] = useState('')
  const [timelineSearch, setTimelineSearch] = useState('')
  const [contextMode, setContextMode] = useState('relevant')
  const [contextSearch, setContextSearch] = useState('')
  const [included, setIncluded] = useState<string[]>([])
  const [timelineCount, setTimelineCount] = useState(80)
  const [contextCount, setContextCount] = useState(60)
  const [checkpointState, setCheckpointState] = useState(() => followLatest({ projectId: '', sessionId: '' }))
  const [planMode, setPlanMode] = useState<'list' | 'map'>('list')
  const questionScope = { projectId: snapshot?.project.id ?? '', sessionId: snapshot?.project.sessionId ?? '' }
  const checkpointSelection = scopedCheckpointSelection(checkpointState, questionScope)
  const selectCheckpoint = (id: string | null) => setCheckpointState(value => chooseCheckpoint(value, questionScope, id))
  const selectBaseline = (id: string) => setCheckpointState(value => ({ ...scopedCheckpointSelection(value, questionScope), baselineId: id }))
  const questionScopeKey = questionStorageKey(questionScope)
  const questions = useQuestionDrafts(questionScope)
  const reviews = useReviewDrafts(questionScope)
  useEffect(() => { setQuestionOpen(false); setReviewOpen(false); setCheckpointState(value => scopedCheckpointSelection(value, questionScope)) }, [questionScopeKey])

  useEffect(() => {
    if (!snapshot) return
    try {
      const saved = localStorage.getItem(`flux:${snapshot.project.id}`)
      if (tabValue(saved)) setTab(saved)
    } catch { /* a saved tab is optional */ }
  }, [snapshot?.project.id])

  const refreshSequence = useRef(0)
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const latest = await getSnapshot()
      if (sequence !== refreshSequence.current) return
      setSnapshot(current => snapshotIsFresh(current, latest) ? latest : current)
      setLoadError('')
    } catch (cause) {
      if (sequence !== refreshSequence.current) return
      setLoadError(cause instanceof Error ? cause.message : 'Flux could not load this chat.')
    }
  }, [])

  useEffect(() => {
    let alive = true
    const stream = new EventSource('/api/events')
    const load = () => { if (alive) void refresh() }
    stream.onopen = () => { if (alive) { setStreamState('connected'); load() } }
    stream.onerror = () => { if (alive) setStreamState('reconnecting') }
    stream.addEventListener('update', load)
    void refresh()
    return () => { alive = false; stream.close() }
  }, [refresh])

  useEffect(() => {
    try { localStorage.setItem(`flux:${snapshot?.project.id ?? 'flux'}`, tab) } catch { /* preferences are optional */ }
  }, [snapshot?.project.id, tab])

  const events = useMemo(() => {
    if (!snapshot) return []
    const ids = new Set(snapshot.overview.events.map(event => event.id))
    return snapshot.events.filter(event => {
      if (timelineMode === 'meaningful' && !timelineKind && !ids.has(event.id)) return false
      if (timelineKind && event.kind !== timelineKind) return false
      if (session && event.sessionId && event.sessionId !== session) return false
      if (actor && event.actor !== actor) return false
      if (timelineSearch && !`${event.summary ?? ''} ${event.text ?? ''} ${event.kind}`.toLowerCase().includes(timelineSearch.toLowerCase())) return false
      return true
    }).sort((a, b) => Date.parse(b.at || '') - Date.parse(a.at || ''))
  }, [actor, session, snapshot, timelineKind, timelineMode, timelineSearch])

  const ask = (question: string, recordIds?: string[]) => {
    if (!snapshot) return
    const sources = [...new Set(recordIds ?? defaultQuestionSources(snapshot))]
    questions.dispatch({ type: 'add', draft: { id: crypto.randomUUID(), question, recordIds: sources, availableRecordIds: sources, mode: 'edit' } })
    setQuestionOpen(true)
  }
  const openRequest = (request: DiagnosticRequest, edit = false) => {
    if (!edit) {
      const existing = questions.collection.drafts.find(draft => draft.mode === 'view' && draft.requestId === request.id)
      if (existing) { questions.dispatch({ type: 'activate', id: existing.id }); setQuestionOpen(true); return }
    }
    const next = draftFromRequest(request, crypto.randomUUID(), edit)
    const original = questions.collection.drafts.find(draft => draft.requestId === request.id)
    if (edit && original) {
      next.availableRecordIds = [...new Set([...original.availableRecordIds, ...next.availableRecordIds])]
      next.priorDeliveryError = hasQuestionReceipt(request) ? undefined : request.error || original.deliveryError
    }
    questions.dispatch({ type: 'add', draft: next })
    setQuestionOpen(true)
  }
  const activeQuestion = questions.collection.drafts.find(draft => draft.id === questions.collection.activeId)
  const enrolled = snapshot?.project.sessions.some(value => value.id === questionScope.sessionId)
  const scopedRequests = enrolled ? snapshot?.requests.filter(request => requestInQuestionScope(request, questionScope, snapshot.events)) ?? [] : []
  const scopedFeedback = enrolled ? snapshot?.reviewFeedback?.filter(feedback => reviewInScope(feedback, questionScope, snapshot.events)) ?? [] : []
  const startReview = () => {
    if (!snapshot) return
    const items = collectReviewGroups(snapshot).flatMap(group => group.items)
    const sources = [...new Set([...(snapshot.contextSuggestions?.feedback.map(source => source.id) ?? []), ...items.flatMap(item => item.sourceIds ?? [])])].filter(id => snapshot.events.some(event => event.id === id))
    reviews.dispatch({ type: 'add', draft: { id: crypto.randomUUID(), mode: 'compose', note: '', groupId: reviewGroupId(items), itemIds: items.map(item => item.id).sort(), affectedItemIds: [], recordIds: sources, availableRecordIds: sources } })
    setReviewOpen(true)
  }
  const openFeedback = (feedback: ReviewFeedbackDraft, edit = false) => {
    const original = reviews.collection.drafts.find(draft => draft.mode === 'view' && draft.requestId === feedback.id)
    if (!edit && original) { reviews.dispatch({ type: 'activate', id: original.id }); setReviewOpen(true); return }
    const next = reviewFromRequest(feedback, crypto.randomUUID(), edit)
    if (edit && original) {
      next.availableRecordIds = [...new Set([...original.availableRecordIds, ...next.availableRecordIds])]
      next.priorDeliveryError = hasQuestionReceipt(feedback) ? undefined : feedback.error || original.deliveryError
    }
    reviews.dispatch({ type: 'add', draft: next }); setReviewOpen(true)
  }
  const activeReview = reviews.collection.drafts.find(draft => draft.id === reviews.collection.activeId)
  const questionHistory = <><QuestionRequests drafts={questions.collection.drafts} requests={scopedRequests} storageNotice={questions.storageNotice}
    onResume={id => { questions.dispatch({ type: 'activate', id }); setQuestionOpen(true) }} onRequest={request => openRequest(request)} onEditRequest={request => openRequest(request, true)} onNew={() => ask('')} />
    <ReviewRequests drafts={reviews.collection.drafts} requests={scopedFeedback} storageNotice={reviews.storageNotice}
      onResume={id => { reviews.dispatch({ type: 'activate', id }); setReviewOpen(true) }} onRequest={feedback => openFeedback(feedback)} onEdit={feedback => openFeedback(feedback,true)} onNew={startReview} /></>

  const commonProps = snapshot ? { snapshot, session, actor, refresh, onSelect: (item: WorkItem) => setInspector(item) } : null
  const panels = snapshot ? {
    overview: <Overview snapshot={snapshot} onReview={startReview} onAsk={ask} onSelect={setInspector} questionHistory={questionHistory} refresh={refresh} />,
    plan: <PlanView {...commonProps!} mode={planMode} onMode={setPlanMode} checkpointSelection={checkpointSelection} onCheckpoint={selectCheckpoint} onSelect={setInspector} />,
    timeline: <Suspense fallback={<p className="app-content">Loading timeline…</p>}><TimelineView snapshot={snapshot} events={events} mode={timelineMode} onMode={value => { setTimelineMode(value); setTimelineKind('') }} kind={timelineKind} onKind={setTimelineKind} search={timelineSearch} onSearch={value => { setTimelineSearch(value); setTimelineCount(80) }} count={timelineCount} onMore={() => setTimelineCount(value => value + 80)} onSelect={event => setInspector(sourceAsWork(event))} /></Suspense>,
    changes: <ChangesView snapshot={snapshot} checkpointSelection={checkpointSelection} onCheckpoint={selectCheckpoint} onBaselinePlan={selectBaseline} onSelect={setInspector} />,
    decisions: <DecisionsView snapshot={snapshot} onSelect={setInspector} refresh={refresh} />,
    context: <ContextView snapshot={snapshot} mode={contextMode} onMode={value => { setContextMode(value); setContextCount(60) }} query={contextSearch} onQuery={value => { setContextSearch(value); setContextCount(60) }} included={included} onIncluded={setIncluded} count={contextCount} onMore={() => setContextCount(value => value + 60)} onAsk={ask} onSelect={event => setInspector(sourceAsWork(event))} />,
  } : null

  const title = snapshot?.project.title || 'Flux'
  const connection = streamState === 'connected' ? snapshot?.coverage.status === 'unavailable' ? 'Chat capture unavailable' : 'Reading Codex chat' : streamState === 'connecting' ? 'Connecting to Flux' : 'Reconnecting to Flux'
  const pendingQuestionCount = snapshot?.incomingQuestions?.pending.length ?? 0

  return <div className="flux-app">
    <a className="skip-link" href="#main-content">Skip to work</a>
    <header className="topbar">
      <a className="brand" href="/" aria-label="Flux by Decantr home"><img src="/images/flux-progress-beacon.png" width="40" height="40" alt="" /><span><strong>Flux</strong><small>by Decantr</small></span></a>
      {title !== 'Flux' && title !== 'Decantr Flux' && <><span className="top-separator" aria-hidden="true" /><span className="project-title">{title}</span></>}
      <div className="topbar-end">
        <div className={`connection-state ${streamState}`} role="status" aria-live="polite"><span aria-hidden="true" /><span className="connection-full">{connection}</span><span className="connection-compact">Codex</span></div>
        <ThemeMenu />
        {snapshot && <FilterPanel snapshot={snapshot} session={session} actor={actor} onSession={setSession} onActor={setActor} onClear={() => { setSession(''); setActor('') }} />}
        <Button variant="quiet" size="small" className="refresh-action" aria-label="Refresh" onClick={() => void refresh()}><RefreshCw size={15} /><span>Refresh</span></Button>
      </div>
    </header>
    {snapshot && <>
      <header className="goal-header"><p>Goal</p><h1>{snapshot.project.goal || title}</h1>{snapshot.project.description && <span>{snapshot.project.description}</span>}</header>
      <main id="main-content" className="main-content">
        <UiTabs value={tab} onValueChange={value => { if (tabValue(value)) setTab(value) }} tabs={TABS.map(item => ({ ...item, icon: iconFor(item.icon) }))} panels={panels!} />
      </main>
      <footer className="app-footer"><span className="help-inline"><span>{snapshot.coverage.summary || 'Public messages and recorded updates are captured locally.'}</span><HelpHint topic="capture-status" /></span><span>{snapshot.coverage.lastImportedAt ? `Chat captured ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(snapshot.coverage.lastImportedAt))}` : 'Chat capture time unknown'}</span></footer>
      {snapshot.runtime?.restartRequired && <div className="runtime-notice" role="alert">Flux was updated. Restart the local service to use the latest controls.</div>}
      <span className="sr-only">{pendingQuestionCount === 0 ? 'No recorded questions are waiting.' : `${pendingQuestionCount} recorded question${pendingQuestionCount === 1 ? ' is' : 's are'} waiting for your answer.`}</span>
      {activeReview && <ReviewUpdateDialog key={`${questionScopeKey}:${activeReview.id}`} snapshot={snapshot} open={reviewOpen} onOpenChange={setReviewOpen} local={activeReview}
        onEdit={patch => reviews.dispatch({ type: 'edit', id: activeReview.id, patch })}
        onPrepared={(requestId,submittedSignature) => reviews.dispatch({ type: 'prepared', id: activeReview.id, requestId, submittedSignature })}
        onDeliveryError={error => reviews.dispatch({ type: 'delivery-error', id: activeReview.id, error })}
        onRevise={feedback => openFeedback(feedback,true)} onViewRequest={feedback=>openFeedback(feedback)} onNew={startReview} storageNotice={reviews.storageNotice}
        onReviewed={refresh} onAsk={(question, sources) => { setReviewOpen(false); ask(question, sources) }} />}
      {activeQuestion && <QuestionDialog key={`${questionScopeKey}:${activeQuestion.id}`} snapshot={snapshot} open={questionOpen} onOpenChange={setQuestionOpen} local={activeQuestion}
        onEdit={patch => questions.dispatch({ type: 'edit', id: activeQuestion.id, ...patch })}
        onPrepared={(requestId, submittedQuestion, submittedRecordIds) => questions.dispatch({ type: 'prepared', id: activeQuestion.id, requestId, submittedQuestion, submittedRecordIds })}
        onRevise={request => openRequest(request, true)}
        onViewRequest={request=>openRequest(request)}
        onDeliveryError={error => questions.dispatch({ type: 'delivery-error', id: activeQuestion.id, error })}
        storageNotice={questions.storageNotice} refresh={refresh} />}
      {inspector && <Suspense fallback={null}><Inspector snapshot={snapshot} item={inspector} open={Boolean(inspector)} onOpenChange={open => { if (!open) setInspector(null) }} onReviewGroup={() => { setInspector(null); startReview() }} /></Suspense>}
    </>}
    {!snapshot && <main className="app-loading" role={loadError ? 'alert' : 'status'}>{loadError ? <><CircleHelp size={18} /><span>{loadError}</span><Button onClick={() => void refresh()}>Try again</Button></> : <><FolderKanban size={18} /><span>Loading your work</span></>}</main>}
    <div aria-live="polite" aria-atomic="true" className="sr-only" id="live-announcements" />
  </div>
}

function defaultQuestionSources(snapshot: FluxSnapshot) {
  if (snapshot.contextSuggestions) return snapshot.contextSuggestions.diagnostic.map(source => source.id)
  return [...new Set([
    ...snapshot.overview.focus.sourceIds,
    ...snapshot.overview.direction.sourceIds,
    ...(snapshot.project.plans.at(-1)?.sourceIds ?? []),
  ])].filter(id => snapshot.events.some(event => event.id === id)).slice(0, 8)
}

function iconFor(name: string): ReactNode {
  const icons: Record<string, ReactNode> = {
    house: <House size={16} aria-hidden="true" />,
    'list-checks': <ListChecks size={16} aria-hidden="true" />,
    'clock-3': <Clock3 size={16} aria-hidden="true" />,
    'git-compare-arrows': <GitCompareArrows size={16} aria-hidden="true" />,
    'messages-square': <MessageSquareText size={16} aria-hidden="true" />,
    files: <Files size={16} aria-hidden="true" />,
  }
  return icons[name] ?? <FolderKanban size={16} aria-hidden="true" />
}
