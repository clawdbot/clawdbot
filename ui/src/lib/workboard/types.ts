import type { GatewaySessionRow } from "../../api/types.ts";

export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export const WORKBOARD_EVENT_KINDS = [
  "created",
  "edited",
  "moved",
  "linked",
  "specified",
  "decomposed",
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "proof_added",
  "artifact_added",
  "attachment_added",
  "diagnostic",
  "notification",
  "dispatch",
  "orchestration",
  "protocol_violation",
  "archived",
  "unarchived",
  "stale",
] as const;
export const WORKBOARD_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked",
  "stopped",
] as const;
export const WORKBOARD_LINK_TYPES = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "relates_to",
] as const;
export const WORKBOARD_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const WORKBOARD_TEMPLATE_IDS = ["bugfix", "docs", "release", "pr_review", "plugin"] as const;
export const WORKBOARD_DIAGNOSTIC_SEVERITIES = ["warning", "error", "critical"] as const;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = (typeof WORKBOARD_EXECUTION_ENGINES)[number];
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];
export type WorkboardEventKind = (typeof WORKBOARD_EVENT_KINDS)[number];
export type WorkboardAttemptStatus = (typeof WORKBOARD_ATTEMPT_STATUSES)[number];
export type WorkboardLinkType = (typeof WORKBOARD_LINK_TYPES)[number];
export type WorkboardProofStatus = (typeof WORKBOARD_PROOF_STATUSES)[number];
export type WorkboardTemplateId = (typeof WORKBOARD_TEMPLATE_IDS)[number];
export type WorkboardDiagnosticSeverity = (typeof WORKBOARD_DIAGNOSTIC_SEVERITIES)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardEvent = {
  id: string;
  kind: WorkboardEventKind;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardRunAttempt = {
  id: string;
  status: WorkboardAttemptStatus;
  startedAt: number;
  endedAt?: number;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

export type WorkboardLink = {
  id: string;
  type: WorkboardLinkType;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: WorkboardProofStatus;
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardStaleState = {
  detectedAt: number;
  lastSessionUpdatedAt?: number;
  reason: string;
};

type WorkboardClaim = {
  ownerId: string;
  token?: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: "info" | "warning" | "error";
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkerProtocol = {
  state: "idle" | "running" | "completed" | "blocked" | "violated";
  updatedAt: number;
  detail?: string;
};

export type WorkboardDiagnostic = {
  kind: string;
  severity: WorkboardDiagnosticSeverity;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
};

export type WorkboardNotification = {
  id: string;
  kind: string;
  createdAt: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  path?: string;
  branch?: string;
};

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  scheduledAt?: number;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  events?: WorkboardEvent[];
  metadata?: WorkboardMetadata;
};

type WorkboardLifecycleState =
  | "unlinked"
  | "missing"
  | "idle"
  | "running"
  | "stale"
  | "succeeded"
  | "failed";

export type WorkboardLifecycle = {
  session: GatewaySessionRow | null;
  state: WorkboardLifecycleState;
  targetStatus?: WorkboardStatus;
  sourceUpdatedAt?: number;
};

export type WorkboardTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type WorkboardTaskSummary = {
  id: string;
  taskId: string;
  status: WorkboardTaskStatus;
  title?: string;
  agentId?: string;
  sessionKey?: string;
  childSessionKey?: string;
  ownerKey?: string;
  runId?: string;
  sourceId?: string;
  updatedAt?: number | string;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
};

type WorkboardDependencyParent = {
  id: string;
  title: string;
  status?: WorkboardStatus;
  done: boolean;
  missing: boolean;
};

export type WorkboardDependencyState = {
  parents: WorkboardDependencyParent[];
  blockedParents: WorkboardDependencyParent[];
};

export type WorkboardDispatchSummary = {
  started: number;
  failures: number;
  promoted: number;
  blocked: number;
  reclaimed: number;
  orchestrated: number;
};

export type WorkboardAutoRefreshIntervalMs = 0 | 5000 | 15000 | 30000 | 60000;

export type WorkboardRefreshSource = "initial" | "manual" | "poll";

export type WorkboardViewPresetId =
  | "all"
  | "default_agent"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "stale"
  | "missing_proof"
  | "recently_done";

export type WorkboardHealthSummary = {
  running: number;
  blocked: number;
  stale: number;
  readyUnassigned: number;
  missingProof: number;
  failedAttempts: number;
};

export type WorkboardHealthKey = keyof WorkboardHealthSummary;

export type WorkboardUiState = {
  loading: boolean;
  loaded: boolean;
  loadAttempted: boolean;
  mutationReadiness: "ready" | "canonical_reload_required" | "stale_edit_draft";
  error: string | null;
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
  tasksByCardId: Map<string, WorkboardTaskSummary>;
  missingTaskIds: Set<string>;
  lastDispatchSummary: WorkboardDispatchSummary | null;
  dispatching: boolean;
  query: string;
  priorityFilter: "all" | WorkboardPriority;
  agentFilter: string;
  viewPreset: WorkboardViewPresetId;
  activeHealthHighlight: WorkboardHealthKey | null;
  showArchived: boolean;
  layout: "comfortable" | "compact";
  hideEmptyColumns: boolean;
  autoRefreshIntervalMs: WorkboardAutoRefreshIntervalMs;
  lastRefreshAt: number | null;
  lastRefreshStartedAt: number | null;
  lastRefreshError: string | null;
  lastRefreshSource: WorkboardRefreshSource | null;
  pollRefreshInProgress: boolean;
  lifecycleTasksPrepared: boolean;
  lifecycleTasksPreparedAt: number | null;
  lifecycleTaskRefreshFailed: boolean;
  lifecycleTaskRefreshRetryAt: number | null;
  lifecycleTaskRefreshContinueAt: number | null;
  lifecycleTaskRefreshError: string | null;
  lifecycleConfirmedTaskIds: Set<string>;
  lifecycleTaskConfirmationStartedAt: number | null;
  draftOpen: boolean;
  draftSaving: boolean;
  editingCardId: string | null;
  draftTitle: string;
  draftNotes: string;
  draftStatus: WorkboardStatus;
  draftPriority: WorkboardPriority;
  draftLabels: string;
  draftAgentId: string;
  draftSessionKey: string;
  draftTemplateId: WorkboardTemplateId | "";
  draftCommentBody: string;
  detailCardId: string | null;
  detailCommentBody: string;
  busyCardIds: Set<string>;
  draggedCardId: string | null;
  syncingCardIds: Set<string>;
  capturingSessionKeys: Set<string>;
};

export type WorkboardTaskLinkState = Pick<
  WorkboardUiState,
  "cards" | "tasksByCardId" | "missingTaskIds"
>;
