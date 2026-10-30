export type Provenance = 'user' | 'observed' | 'agent_report' | 'inferred' | string

export interface WorkItem {
  id: string
  title: string
  status: string
  kind?: string
  owner?: string
  sessionId?: string
  parentId?: string
  returnCondition?: string
  purpose?: string
  sourceIds?: string[]
  provenance?: Provenance
  at?: string
  review?: { outcome: 'accepted' | 'changes_requested'; note: string; at: string }
  requiresUserDecision?: boolean
  actor?: string
  evidence?: { kind: string; sourceIds: string[] }
}

export interface PlanStep {
  id: string
  title: string
  status: string
  sourceIds?: string[]
  provenance?: Provenance
  evidenceScope?: string
}

export interface Plan {
  projectId?: string
  id: string
  title: string
  scopeId?: string
  sessionId?: string
  at?: string
  kind?: string
  sourceIds?: string[]
  steps: PlanStep[]
}

export interface Decision {
  id: string
  title: string
  status: string
  rationale?: string
  rationaleProvenance?: Provenance
  sourceIds?: string[]
  at?: string
}

export interface SourceRecord {
  projectId?: string
  id: string
  kind: string
  summary?: string
  text?: string
  actor?: string
  at?: string
  sessionId?: string
  provenance?: Provenance
  source?: { type?: string; ref?: string }
  data?: Record<string, unknown>
}

export interface OverviewCard {
  text: string | null
  status: string
  provenance?: Provenance
  at?: string | null
  sourceIds: string[]
}

export interface OverviewFocus {
  status: string
  title: string | null
  workStatus: string | null
  updatedAt: string | null
  intentSourceId?: string | null
  sourceIds: string[]
  next: { text: string | null; status: string }
  why: string | null
}

export interface ProjectOverview {
  goal: OverviewCard
  direction: OverviewCard
  focus: OverviewFocus
  now: OverviewCard
  why: OverviewCard
  next: OverviewCard
  unknowns: string[]
  openWork: { active: WorkItem[]; parked: WorkItem[]; proposals: Decision[]; unknown: WorkItem[] }
  workItems: WorkItem[]
  events: Array<SourceRecord & { category: string }>
  history: { plans: Plan[]; decisions: Decision[]; closedItems: WorkItem[] }
}

export interface IncomingQuestion {
  id: string
  projectId?: string
  sessionId: string
  text: string
  status: 'pending' | 'replied' | 'resolved' | 'cancelled' | 'superseded'
  origin: 'codex_tool' | 'recorded' | 'work_item'
  askedAt?: string
  updatedAt?: string
  sourceIds: string[]
  resolutionSourceIds?: string[]
  sourceItemId?: string
  options?: string[]
  answer?: string
  /** Rationale recorded with a reply or closure, not why Codex asked. */
  reason?: string
  resolutionNote?: string
  provenance?: Provenance
  resolutionProvenance?: Provenance
}

export interface AnswerSubmission {
  id: string
  projectId: string
  sessionId: string
  status: 'prepared' | 'sending' | 'queued' | 'delivery_unconfirmed' | 'received'
  answers: Array<{ questionId: string; questionText: string; questionFingerprint: string; answer: string }>
  prompt: string
  payloadHash: string
  contextRevision: string
  at?: string
  updatedAt?: string
  error?: string
  receiptSourceId?: string
  outcomes?: Array<{ questionId: string; status: 'reply_recorded' | 'already_replied' | 'conflict' }>
}

export interface Proposal {
  id: string
  kind: 'decision' | 'item'
  title: string
  rationale?: string | null
  status: string
  sourceIds: string[]
  proposedBy: string | null
  proposedAt: string | null
  proposalSourceId: string | null
  disposition: 'suggested' | 'planned' | 'later' | 'dismissed'
  choiceSourceId?: string | null
  plannedItemId?: string | null
  implementation: {
    status: 'unknown' | 'not_started' | 'partial' | 'in_progress' | 'complete' | 'research_only'
    completedText: string | null
    remainingText: string | null
    provenance: Provenance
    sourceIds: string[]
  }
}

export interface FluxSnapshot {
  proposals?: Proposal[]
  proposalActions?: { available: boolean }
  answerTransport?: { mode: 'chat_message'; available: boolean; nativeWidgetSync: false }
  answerSubmissions?: AnswerSubmission[]
  answerHolds?: Array<{ questionId: string; submissionId: string; status: AnswerSubmission['status'] }>
  incomingQuestions?: { pending: IncomingQuestion[]; history: IncomingQuestion[] }
  contextSuggestions?: { diagnostic: Array<{ id: string; reason: string }>; feedback: Array<{ id: string; reason: string }> }
  project: {
    id: string
    title: string
    goal: string
    description?: string
    sessionId: string
    sessions: Array<{ id: string; title: string }>
    items: WorkItem[]
    plans: Plan[]
    decisions: Decision[]
    constraints?: string[]
  }
  events: SourceRecord[]
  requests: DiagnosticRequest[]
  reviewGroups?: GroupReview[]
  reviewFeedback?: ReviewFeedbackDraft[]
  revision: number
  contextRevision: string
  csrfToken: string
  coverage: { summary?: string; status?: string; lastImportedAt?: string; adapter?: string }
  runtime?: { modelVersion: number; restartRequired: boolean }
  overview: ProjectOverview
}

export interface DiagnosticRequest {
  sourceEventId?: string
  projectId?: string
  sessionId?: string
  contextManifest?: ContextManifest
  id: string
  question: string
  status: string
  at?: string
  updatedAt?: string
  result?: string
  error?: string
  recordIds?: string[]
  selectedItemId?: string | null
  baselinePlanId?: string | null
  baselineRevision?: number
  contextRevision?: string
  prompt?: string
  resultSourceId?: string
}

export interface GroupReview {
  id: string
  itemIds: string[]
  outcome: 'accepted' | 'changes_requested'
  note: string
  at: string
  actor?: string
  feedback?: ReviewFeedbackDraft
}

export type ReviewOutcome = 'accepted' | 'changes_requested'

export interface DiagnosticDraft {
  projectId?: string
  sessionId?: string
  contextManifest?: ContextManifest
  id: string
  question: string
  status: string
  prompt: string
  recordIds: string[]
  includedRecordIds?: string[]
  omittedRecordCount?: number
  baselineRevision?: number
  contextRevision?: string
  selectedItemId?: string | null
  baselinePlanId?: string | null
  result?: string
  error?: string
}

export interface ReviewFeedbackDraft {
  requestVersion?: number
  intent?: 'request_changes'
  affectedItemIds?: string[]
  projectId?: string
  sessionId?: string
  recordIds?: string[]
  contextManifest?: ContextManifest
  id: string
  groupId: string
  itemIds: string[]
  note: string
  question: string
  prompt: string
  status: string
  contextRevision: string
  error?: string
}

export interface ContextManifest {
  roleCoverage?: Array<{ role: string; label: string; selectedCount: number; includedCount: number; omittedCount: number; shortenedCount: number }>
  essentialCoverage?: { currentPlan: 'included' | 'not_selected' | 'budget_omitted' | 'not_available' }
  version: string
  mode: 'audit' | 'change'
  selectedCount: number
  includedCount: number
  omittedRecordIds: string[]
  shortenedRecordIds: string[]
  latestDirectionShortened: boolean
  goalShortened: boolean
  targetDetailsShortened: boolean
  focusRelation: 'aligned' | 'earlier_direction' | 'unanchored' | 'not_recorded'
  unlinkedConstraintCount: number
  characterCount: number
  characterLimit: number
  sources: Array<{ id: string; ref: string; shortened: boolean }>
}
