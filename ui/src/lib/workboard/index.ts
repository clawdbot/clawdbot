import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { requestSessionCreate } from "../sessions/index.ts";
// Control UI controller manages workboard gateway state.

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
const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
const WORKBOARD_EXECUTION_STATUSES = ["idle", "running", "review", "blocked", "done"] as const;
const WORKBOARD_EVENT_KINDS = [
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

const WORKBOARD_ENGINE_MODELS = {
  codex: "openai/gpt-5.6-sol",
  claude: "anthropic/claude-sonnet-4-6",
} as const;

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

type WorkboardTaskStatus =
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

type WorkboardDispatchSummary = {
  started: number;
  failures: number;
  promoted: number;
  blocked: number;
  reclaimed: number;
  orchestrated: number;
};

export type WorkboardAutoRefreshIntervalMs = 0 | 5000 | 15000 | 30000 | 60000;

type WorkboardRefreshSource = "initial" | "manual" | "poll";

type WorkboardViewPresetId =
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

type WorkboardHost = object;

type WorkboardLoadToken = {
  queuedAfterGeneration?: number;
};

const workboardStates = new WeakMap<WorkboardHost, WorkboardUiState>();
const workboardLoadPromises = new WeakMap<WorkboardHost, Promise<boolean>>();
const workboardLoadTokens = new WeakMap<WorkboardHost, WorkboardLoadToken>();
const workboardLoadErrors = new WeakMap<WorkboardHost, string>();
const workboardLifecycleTaskRefreshPromises = new WeakMap<WorkboardHost, Promise<number | null>>();
const workboardLifecycleWritePromises = new WeakMap<WorkboardHost, Set<Promise<unknown>>>();
const workboardLoadGenerations = new WeakMap<WorkboardHost, number>();
const workboardLifecycleReconciliationEpochs = new WeakMap<WorkboardHost, number>();
const workboardPollingGenerations = new WeakMap<WorkboardHost, number>();
const workboardTaskPollOffsets = new WeakMap<WorkboardHost, number>();
const workboardTaskDiscoveryOffsets = new WeakMap<WorkboardHost, number>();
const workboardDefaultTaskDiscoveryCursors = new WeakMap<WorkboardHost, string>();
const workboardPollingTimers = new WeakMap<WorkboardHost, ReturnType<typeof setTimeout>>();
const workboardLifecycleTaskPreparedTimers = new WeakMap<
  WorkboardHost,
  ReturnType<typeof setTimeout>
>();
const workboardLifecycleTaskRetryTimers = new WeakMap<
  WorkboardHost,
  ReturnType<typeof setTimeout>
>();
const workboardLifecycleTaskContinuationTimers = new WeakMap<
  WorkboardHost,
  ReturnType<typeof setTimeout>
>();
const workboardPollingEntries = new WeakMap<
  WorkboardHost,
  {
    client: GatewayBrowserClient | null;
    enabled: boolean;
    intervalMs: WorkboardAutoRefreshIntervalMs;
    requestUpdate?: () => void;
  }
>();
const WORKBOARD_RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_CAPTURE_HISTORY_LIMIT = 40;
const SESSION_CAPTURE_HISTORY_MAX_CHARS = 6000;
const SESSION_CAPTURE_TEXT_MAX_CHARS = 700;
const WORKBOARD_CAPTURE_TITLE_MAX_CHARS = 180;
const WORKBOARD_SESSION_LABEL_MAX_CHARS = 512;
const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;
const WORKBOARD_TASKS_LIST_LIMIT = 500;
const WORKBOARD_TASK_POLL_BATCH_SIZE = 32;
const WORKBOARD_TASK_DISCOVERY_BATCH_SIZE = 4;
const WORKBOARD_TASK_LOOKUP_RETRY_DELAYS_MS = [100, 250, 500] as const;
const WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_WINDOW_MS = 5000;
const WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_TIMEOUT_ERROR =
  "Task confirmation exceeded its freshness window.";
const WORKBOARD_LIFECYCLE_TASK_RETRY_MS = 5000;
const WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS = 100;

function nextWorkboardLoadGeneration(host: WorkboardHost): number {
  const generation = (workboardLoadGenerations.get(host) ?? 0) + 1;
  workboardLoadGenerations.set(host, generation);
  return generation;
}

function isCurrentWorkboardLoadGeneration(host: WorkboardHost, generation: number): boolean {
  return workboardLoadGenerations.get(host) === generation;
}

function nextWorkboardPollingGeneration(host: WorkboardHost): number {
  const generation = (workboardPollingGenerations.get(host) ?? 0) + 1;
  workboardPollingGenerations.set(host, generation);
  return generation;
}

function currentWorkboardPollingGeneration(host: WorkboardHost): number {
  return workboardPollingGenerations.get(host) ?? 0;
}

function isCurrentWorkboardPollingGeneration(host: WorkboardHost, generation: number): boolean {
  return currentWorkboardPollingGeneration(host) === generation;
}

function nextWorkboardLifecycleReconciliationEpoch(host: WorkboardHost): number {
  const epoch = (workboardLifecycleReconciliationEpochs.get(host) ?? 0) + 1;
  workboardLifecycleReconciliationEpochs.set(host, epoch);
  return epoch;
}

function currentWorkboardLifecycleReconciliationEpoch(host: WorkboardHost): number {
  return workboardLifecycleReconciliationEpochs.get(host) ?? 0;
}

function isCurrentWorkboardLifecycleReconciliationEpoch(
  host: WorkboardHost,
  epoch: number,
): boolean {
  return currentWorkboardLifecycleReconciliationEpoch(host) === epoch;
}

function invalidateWorkboardLoads(host: WorkboardHost) {
  const state = workboardStates.get(host);
  if (state) {
    setWorkboardLifecycleTasksPrepared(state, false, { host });
    resetWorkboardLifecycleTaskConfirmations(state, { host });
    if (workboardLoadPromises.has(host)) {
      if (!state.draftSaving) {
        state.loading = false;
      }
      if (!state.loaded) {
        state.loadAttempted = false;
      }
    }
  }
  nextWorkboardLoadGeneration(host);
  workboardLoadPromises.delete(host);
  workboardLoadTokens.delete(host);
  nextWorkboardLifecycleReconciliationEpoch(host);
}

function clearWorkboardLifecycleTaskPreparedTimer(host: WorkboardHost) {
  const timer = workboardLifecycleTaskPreparedTimers.get(host);
  if (timer) {
    clearTimeout(timer);
    workboardLifecycleTaskPreparedTimers.delete(host);
  }
}

function clearWorkboardLifecycleTaskRetryTimer(host: WorkboardHost) {
  const timer = workboardLifecycleTaskRetryTimers.get(host);
  if (timer) {
    clearTimeout(timer);
    workboardLifecycleTaskRetryTimers.delete(host);
  }
}

function clearWorkboardLifecycleTaskContinuationTimer(host: WorkboardHost) {
  const timer = workboardLifecycleTaskContinuationTimers.get(host);
  if (timer) {
    clearTimeout(timer);
    workboardLifecycleTaskContinuationTimers.delete(host);
  }
}

function trackWorkboardLifecycleWrite(host: WorkboardHost, write: Promise<unknown>) {
  const writes = workboardLifecycleWritePromises.get(host) ?? new Set<Promise<unknown>>();
  writes.add(write);
  workboardLifecycleWritePromises.set(host, writes);
}

function releaseWorkboardLifecycleWrite(host: WorkboardHost, write: Promise<unknown>) {
  const writes = workboardLifecycleWritePromises.get(host);
  writes?.delete(write);
  if (writes?.size === 0) {
    workboardLifecycleWritePromises.delete(host);
  }
}

async function waitForWorkboardLifecycleWrites(host: WorkboardHost) {
  while (true) {
    const writes = workboardLifecycleWritePromises.get(host);
    if (!writes?.size) {
      return;
    }
    await Promise.allSettled(writes);
  }
}

function resetWorkboardLifecycleTaskConfirmations(
  state: WorkboardUiState,
  options: { host?: WorkboardHost } = {},
) {
  state.lifecycleConfirmedTaskIds = new Set();
  state.lifecycleTaskConfirmationStartedAt = null;
  setWorkboardLifecycleTaskRefreshContinuation(state, false, options);
}

export function stopWorkboardLifecycleRefresh(host: WorkboardHost) {
  clearWorkboardLifecycleTaskPreparedTimer(host);
  clearWorkboardLifecycleTaskRetryTimer(host);
  clearWorkboardLifecycleTaskContinuationTimer(host);
  workboardLifecycleTaskRefreshPromises.delete(host);
  const state = workboardStates.get(host);
  if (state) {
    setWorkboardLifecycleTasksPrepared(state, false);
    setWorkboardLifecycleTaskRefreshFailed(state, false);
    state.lifecycleTaskRefreshError = null;
    resetWorkboardLifecycleTaskConfirmations(state, { host });
    // In-flight lifecycle writes clear themselves in finally. Keep them visible
    // so reconnect loads wait for their backend mutations before becoming writable.
    // Detach stale loads so reconnecting can start fresh without letting the
    // old request clear a concurrent draft-save loading state.
    if (!state.draftSaving) {
      state.loading = false;
    }
    // Keep cached cards visible across disconnects, but require a canonical
    // reload before accepting writes against data that may now be stale.
    state.mutationReadiness = "canonical_reload_required";
    state.loaded = false;
    state.loadAttempted = false;
  }
  nextWorkboardLoadGeneration(host);
  workboardLoadPromises.delete(host);
  workboardLoadTokens.delete(host);
  nextWorkboardLifecycleReconciliationEpoch(host);
}

function setWorkboardLifecycleTasksPrepared(
  state: WorkboardUiState,
  prepared: boolean,
  options: {
    host?: WorkboardHost;
    preparedAt?: number;
    requestUpdate?: () => void;
  } = {},
) {
  const preparedAt = options.preparedAt ?? Date.now();
  state.lifecycleTasksPrepared = prepared;
  state.lifecycleTasksPreparedAt = prepared ? preparedAt : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskPreparedTimer(host);
  if (
    !prepared ||
    !options.requestUpdate ||
    state.autoRefreshIntervalMs === 0 ||
    !shouldRefreshWorkboardTasksForLifecycle(state)
  ) {
    return;
  }
  const nextTimer = setTimeout(
    () => {
      workboardLifecycleTaskPreparedTimers.delete(host);
      options.requestUpdate?.();
    },
    Math.max(0, preparedAt + state.autoRefreshIntervalMs - Date.now()),
  );
  workboardLifecycleTaskPreparedTimers.set(host, nextTimer);
}

function workboardLifecycleTasksPreparedAt(state: WorkboardUiState, now = Date.now()) {
  if (!state.lifecycleTasksPrepared || state.lifecycleTasksPreparedAt === null) {
    return null;
  }
  if (
    state.autoRefreshIntervalMs > 0 &&
    now - state.lifecycleTasksPreparedAt >= state.autoRefreshIntervalMs
  ) {
    return null;
  }
  return state.lifecycleTasksPreparedAt;
}

function setWorkboardLifecycleTaskRefreshFailed(
  state: WorkboardUiState,
  failed: boolean,
  options: {
    host?: WorkboardHost;
    requestUpdate?: () => void;
    retryDelayMs?: number;
  } = {},
) {
  const retryDelayMs = options.retryDelayMs ?? WORKBOARD_LIFECYCLE_TASK_RETRY_MS;
  state.lifecycleTaskRefreshFailed = failed;
  state.lifecycleTaskRefreshRetryAt = failed ? Date.now() + retryDelayMs : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskRetryTimer(host);
  if (!failed || !options.requestUpdate || state.autoRefreshIntervalMs === 0) {
    return;
  }
  const nextTimer = setTimeout(() => {
    workboardLifecycleTaskRetryTimers.delete(host);
    options.requestUpdate?.();
  }, retryDelayMs);
  workboardLifecycleTaskRetryTimers.set(host, nextTimer);
}

function setWorkboardLifecycleTaskRefreshContinuation(
  state: WorkboardUiState,
  pending: boolean,
  options: {
    host?: WorkboardHost;
    requestUpdate?: () => void;
  } = {},
) {
  state.lifecycleTaskRefreshContinueAt = pending
    ? Date.now() + WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS
    : null;
  const host = options.host;
  if (!host) {
    return;
  }
  clearWorkboardLifecycleTaskContinuationTimer(host);
  if (!pending || !options.requestUpdate) {
    return;
  }
  // Continue bounded exact-confirmation even when routine polling is off.
  // Keep this separate so render polling cannot cancel the freshness-bounded sequence.
  const nextTimer = setTimeout(() => {
    workboardLifecycleTaskContinuationTimers.delete(host);
    options.requestUpdate?.();
  }, WORKBOARD_LIFECYCLE_TASK_CONTINUE_MS);
  workboardLifecycleTaskContinuationTimers.set(host, nextTimer);
}

function workboardLifecycleTaskRefreshRetryPending(state: WorkboardUiState, now = Date.now()) {
  return (
    state.lifecycleTaskRefreshFailed &&
    state.lifecycleTaskRefreshRetryAt !== null &&
    now < state.lifecycleTaskRefreshRetryAt
  );
}

function workboardLifecycleTaskRefreshContinuationWaiting(
  state: WorkboardUiState,
  now = Date.now(),
) {
  return (
    state.lifecycleTaskRefreshContinueAt !== null && now < state.lifecycleTaskRefreshContinueAt
  );
}

function createDefaultState(): WorkboardUiState {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    mutationReadiness: "ready",
    error: null,
    cards: [],
    statuses: WORKBOARD_STATUSES,
    tasksByCardId: new Map(),
    missingTaskIds: new Set(),
    lastDispatchSummary: null,
    dispatching: false,
    query: "",
    priorityFilter: "all",
    agentFilter: "all",
    viewPreset: "all",
    activeHealthHighlight: null,
    showArchived: false,
    layout: "compact",
    hideEmptyColumns: false,
    autoRefreshIntervalMs: 0,
    lastRefreshAt: null,
    lastRefreshStartedAt: null,
    lastRefreshError: null,
    lastRefreshSource: null,
    pollRefreshInProgress: false,
    lifecycleTasksPrepared: false,
    lifecycleTasksPreparedAt: null,
    lifecycleTaskRefreshFailed: false,
    lifecycleTaskRefreshRetryAt: null,
    lifecycleTaskRefreshContinueAt: null,
    lifecycleTaskRefreshError: null,
    lifecycleConfirmedTaskIds: new Set(),
    lifecycleTaskConfirmationStartedAt: null,
    draftOpen: false,
    draftSaving: false,
    editingCardId: null,
    draftTitle: "",
    draftNotes: "",
    draftStatus: "todo",
    draftPriority: "normal",
    draftLabels: "",
    draftAgentId: "",
    draftSessionKey: "",
    draftTemplateId: "",
    draftCommentBody: "",
    detailCardId: null,
    detailCommentBody: "",
    busyCardIds: new Set(),
    draggedCardId: null,
    syncingCardIds: new Set(),
    capturingSessionKeys: new Set(),
  };
}

export function getWorkboardState(host: WorkboardHost): WorkboardUiState {
  let state = workboardStates.get(host);
  if (!state) {
    state = createDefaultState();
    workboardStates.set(host, state);
  }
  return state;
}

export function workboardMutationsReady(state: WorkboardUiState): boolean {
  return state.mutationReadiness === "ready";
}

export function workboardHasActiveWrites(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftSaving ||
    state.busyCardIds.size ||
    state.syncingCardIds.size ||
    state.capturingSessionKeys.size,
  );
}

function workboardHasActiveLoad(host: WorkboardHost): boolean {
  return workboardLoadPromises.has(host);
}

function workboardLifecycleSyncBlocked(host: WorkboardHost, state: WorkboardUiState): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    state.draggedCardId ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    workboardHasActiveLoad(host),
  );
}

function hasWorkboardProofEvidence(card: WorkboardCard): boolean {
  return Boolean(
    card.metadata?.proof?.length ||
    card.metadata?.artifacts?.length ||
    card.metadata?.attachments?.length,
  );
}

function taskFailedTerminal(task: WorkboardTaskSummary | undefined): boolean {
  return task?.status === "failed" || task?.status === "cancelled" || task?.status === "timed_out";
}

function taskFailureRepresentedByCard(
  card: WorkboardCard,
  task: WorkboardTaskSummary | undefined,
): boolean {
  if (!task || !taskFailedTerminal(task)) {
    return false;
  }
  const taskSessionKeys = [task.sessionKey, task.childSessionKey, task.ownerKey];
  return Boolean(
    card.metadata?.attempts?.some((attempt) => {
      if (
        attempt.status !== "failed" &&
        attempt.status !== "blocked" &&
        attempt.status !== "stopped"
      ) {
        return false;
      }
      if (task.runId && attempt.runId) {
        return attempt.runId === task.runId;
      }
      return Boolean(
        attempt.sessionKey &&
        taskSessionKeys.some((sessionKey) =>
          taskSessionKeyMatchesCardSession(sessionKey, attempt.sessionKey ?? ""),
        ),
      );
    }),
  );
}

function countCardFailedAttempts(card: WorkboardCard): number {
  if (card.metadata?.failureCount !== undefined) {
    return card.metadata.failureCount;
  }
  return (
    card.metadata?.attempts?.filter(
      (attempt) =>
        attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "stopped",
    ).length ?? 0
  );
}

function cardRecentlyDone(card: WorkboardCard): boolean {
  if (card.status !== "done") {
    return false;
  }
  const doneAt = card.completedAt ?? card.updatedAt;
  return Date.now() - doneAt <= WORKBOARD_RECENT_DONE_WINDOW_MS;
}

export function summarizeWorkboardHealth(params: {
  cards: readonly WorkboardCard[];
  tasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>;
  sessions: readonly GatewaySessionRow[];
}): WorkboardHealthSummary {
  const summary: WorkboardHealthSummary = {
    running: 0,
    blocked: 0,
    stale: 0,
    readyUnassigned: 0,
    missingProof: 0,
    failedAttempts: 0,
  };
  for (const card of params.cards) {
    const task = params.tasksByCardId.get(card.id);
    if (workboardCardMatchesHealthKey(card, "running", params.sessions, task)) {
      summary.running += 1;
    }
    if (workboardCardMatchesHealthKey(card, "blocked", params.sessions, task)) {
      summary.blocked += 1;
    }
    if (workboardCardMatchesHealthKey(card, "stale", params.sessions, task)) {
      summary.stale += 1;
    }
    if (workboardCardMatchesHealthKey(card, "readyUnassigned", params.sessions, task)) {
      summary.readyUnassigned += 1;
    }
    if (workboardCardMatchesHealthKey(card, "missingProof", params.sessions, task)) {
      summary.missingProof += 1;
    }
    summary.failedAttempts += countCardFailedAttempts(card);
    if (taskFailedTerminal(task) && !taskFailureRepresentedByCard(card, task)) {
      summary.failedAttempts += 1;
    }
  }
  return summary;
}

export function workboardCardMatchesHealthKey(
  card: WorkboardCard,
  key: WorkboardHealthKey,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
): boolean {
  const lifecycle = getWorkboardLifecycle(card, sessions, task);
  switch (key) {
    case "running":
      return card.status === "running" || lifecycle.state === "running";
    case "blocked":
      return card.status === "blocked";
    case "stale":
      return Boolean(card.metadata?.stale || lifecycle.state === "stale");
    case "readyUnassigned":
      return card.status === "ready" && !card.agentId?.trim() && !card.metadata?.claim;
    case "missingProof":
      return card.status === "done" && !hasWorkboardProofEvidence(card);
    case "failedAttempts":
      return countCardFailedAttempts(card) > 0 || taskFailedTerminal(task);
  }
  return false;
}

export function filterWorkboardCardsForPreset(params: {
  cards: readonly WorkboardCard[];
  preset: WorkboardViewPresetId;
  tasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>;
  sessions: readonly GatewaySessionRow[];
  defaultAgentId?: string | null;
}): WorkboardCard[] {
  const defaultAgentId = params.defaultAgentId?.trim();
  return params.cards.filter((card) => {
    const task = params.tasksByCardId.get(card.id);
    const lifecycle = getWorkboardLifecycle(card, params.sessions, task);
    switch (params.preset) {
      case "all":
        return true;
      case "default_agent":
        return defaultAgentId
          ? card.agentId === defaultAgentId || !card.agentId?.trim()
          : !card.agentId;
      case "ready":
        return card.status === "ready";
      case "running":
        return card.status === "running" || lifecycle.state === "running";
      case "blocked":
        return card.status === "blocked";
      case "review":
        return card.status === "review";
      case "stale":
        return Boolean(card.metadata?.stale) || lifecycle.state === "stale";
      case "missing_proof":
        return card.status === "done" && !hasWorkboardProofEvidence(card);
      case "recently_done":
        return cardRecentlyDone(card);
    }
    return false;
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return "Unknown workboard error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const engine = WORKBOARD_EXECUTION_ENGINES.includes(value.engine as WorkboardExecutionEngine)
    ? (value.engine as WorkboardExecutionEngine)
    : null;
  const mode = WORKBOARD_EXECUTION_MODES.includes(value.mode as WorkboardExecutionMode)
    ? (value.mode as WorkboardExecutionMode)
    : null;
  const status = WORKBOARD_EXECUTION_STATUSES.includes(value.status as WorkboardExecutionStatus)
    ? (value.status as WorkboardExecutionStatus)
    : "idle";
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : "";
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : 0;
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : startedAt;
  if (!id || !engine || !mode || !model || !startedAt) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    engine,
    mode,
    status,
    model,
    startedAt,
    updatedAt,
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

function normalizeEvent(value: unknown): WorkboardEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : "";
  const kind = WORKBOARD_EVENT_KINDS.includes(value.kind as WorkboardEventKind)
    ? (value.kind as WorkboardEventKind)
    : null;
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  if (!id || !kind || !at) {
    return null;
  }
  const fromStatus = WORKBOARD_STATUSES.includes(value.fromStatus as WorkboardStatus)
    ? (value.fromStatus as WorkboardStatus)
    : undefined;
  const toStatus = WORKBOARD_STATUSES.includes(value.toStatus as WorkboardStatus)
    ? (value.toStatus as WorkboardStatus)
    : undefined;
  return {
    id,
    kind,
    at,
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

function normalizeEvents(value: unknown): WorkboardEvent[] {
  return Array.isArray(value)
    ? value.map(normalizeEvent).filter((event): event is WorkboardEvent => event !== null)
    : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function normalizeWorkerProtocolState(
  value: unknown,
): WorkboardWorkerProtocol["state"] | undefined {
  return value === "idle" ||
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "violated"
    ? value
    : undefined;
}

function normalizeAutomation(value: unknown): WorkboardAutomation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const workspace = isRecord(value.workspace)
    ? {
        kind:
          value.workspace.kind === "scratch" ||
          value.workspace.kind === "dir" ||
          value.workspace.kind === "worktree"
            ? value.workspace.kind
            : undefined,
        ...(typeof value.workspace.path === "string" ? { path: value.workspace.path } : {}),
        ...(typeof value.workspace.branch === "string" ? { branch: value.workspace.branch } : {}),
      }
    : undefined;
  const automation: WorkboardAutomation = {
    ...(typeof value.tenant === "string" ? { tenant: value.tenant } : {}),
    ...(typeof value.boardId === "string" ? { boardId: value.boardId } : {}),
    ...(typeof value.createdByCardId === "string"
      ? { createdByCardId: value.createdByCardId }
      : {}),
    ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(normalizeStringArray(value.skills).length
      ? { skills: normalizeStringArray(value.skills) }
      : {}),
    ...(workspace?.kind ? { workspace: workspace as WorkboardWorkspace } : {}),
    ...(typeof value.maxRuntimeSeconds === "number"
      ? { maxRuntimeSeconds: value.maxRuntimeSeconds }
      : {}),
    ...(typeof value.maxRetries === "number" ? { maxRetries: value.maxRetries } : {}),
    ...(typeof value.scheduledAt === "number" ? { scheduledAt: value.scheduledAt } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(normalizeStringArray(value.createdCardIds).length
      ? { createdCardIds: normalizeStringArray(value.createdCardIds) }
      : {}),
    ...(typeof value.dispatchCount === "number" ? { dispatchCount: value.dispatchCount } : {}),
    ...(typeof value.lastDispatchAt === "number" ? { lastDispatchAt: value.lastDispatchAt } : {}),
  };
  return Object.keys(automation).length ? automation : undefined;
}

function normalizeMetadata(value: unknown): WorkboardMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.flatMap((entry): WorkboardRunAttempt[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.startedAt !== "number"
        ) {
          return [];
        }
        const status = WORKBOARD_ATTEMPT_STATUSES.includes(entry.status as WorkboardAttemptStatus)
          ? (entry.status as WorkboardAttemptStatus)
          : "running";
        return [
          {
            id: entry.id,
            status,
            startedAt: entry.startedAt,
            ...(typeof entry.endedAt === "number" ? { endedAt: entry.endedAt } : {}),
            ...(WORKBOARD_EXECUTION_ENGINES.includes(entry.engine as WorkboardExecutionEngine)
              ? { engine: entry.engine as WorkboardExecutionEngine }
              : {}),
            ...(WORKBOARD_EXECUTION_MODES.includes(entry.mode as WorkboardExecutionMode)
              ? { mode: entry.mode as WorkboardExecutionMode }
              : {}),
            ...(typeof entry.model === "string" ? { model: entry.model } : {}),
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
            ...(typeof entry.error === "string" ? { error: entry.error } : {}),
          },
        ];
      })
    : [];
  const comments = Array.isArray(value.comments)
    ? value.comments.flatMap((entry): WorkboardComment[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.body !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            body: entry.body,
            createdAt: entry.createdAt,
            ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
          },
        ];
      })
    : [];
  const links = Array.isArray(value.links)
    ? value.links.flatMap((entry): WorkboardLink[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            type: WORKBOARD_LINK_TYPES.includes(entry.type as WorkboardLinkType)
              ? (entry.type as WorkboardLinkType)
              : "relates_to",
            createdAt: entry.createdAt,
            ...(typeof entry.targetCardId === "string" ? { targetCardId: entry.targetCardId } : {}),
            ...(typeof entry.title === "string" ? { title: entry.title } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          },
        ];
      })
    : [];
  const proof = Array.isArray(value.proof)
    ? value.proof.flatMap((entry): WorkboardProof[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            status: WORKBOARD_PROOF_STATUSES.includes(entry.status as WorkboardProofStatus)
              ? (entry.status as WorkboardProofStatus)
              : "unknown",
            createdAt: entry.createdAt,
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.command === "string" ? { command: entry.command } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          },
        ];
      })
    : [];
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((entry): WorkboardArtifact[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            createdAt: entry.createdAt,
            ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            ...(typeof entry.url === "string" ? { url: entry.url } : {}),
            ...(typeof entry.path === "string" ? { path: entry.path } : {}),
            ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
          },
        ];
      })
    : [];
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.flatMap((entry): WorkboardAttachment[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.cardId !== "string" ||
          typeof entry.fileName !== "string" ||
          typeof entry.byteSize !== "number" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            cardId: entry.cardId,
            fileName: entry.fileName,
            byteSize: entry.byteSize,
            createdAt: entry.createdAt,
            ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          },
        ];
      })
    : [];
  const workerLogs = Array.isArray(value.workerLogs)
    ? value.workerLogs.flatMap((entry): WorkboardWorkerLog[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.message !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            level:
              entry.level === "warning" || entry.level === "error" || entry.level === "info"
                ? entry.level
                : "info",
            message: entry.message,
            createdAt: entry.createdAt,
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          },
        ];
      })
    : [];
  const workerProtocolRecord = isRecord(value.workerProtocol) ? value.workerProtocol : null;
  const workerProtocolState = normalizeWorkerProtocolState(workerProtocolRecord?.state);
  const workerProtocol = workerProtocolState
    ? {
        state: workerProtocolState,
        updatedAt:
          typeof workerProtocolRecord?.updatedAt === "number"
            ? workerProtocolRecord.updatedAt
            : Date.now(),
        ...(typeof workerProtocolRecord?.detail === "string"
          ? { detail: workerProtocolRecord.detail }
          : {}),
      }
    : undefined;
  const claim = isRecord(value.claim)
    ? {
        ownerId: typeof value.claim.ownerId === "string" ? value.claim.ownerId : "",
        ...(typeof value.claim.token === "string" ? { token: value.claim.token } : {}),
        claimedAt: typeof value.claim.claimedAt === "number" ? value.claim.claimedAt : 0,
        lastHeartbeatAt:
          typeof value.claim.lastHeartbeatAt === "number" ? value.claim.lastHeartbeatAt : 0,
        ...(typeof value.claim.expiresAt === "number" ? { expiresAt: value.claim.expiresAt } : {}),
      }
    : undefined;
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.flatMap((entry): WorkboardDiagnostic[] => {
        if (!isRecord(entry) || typeof entry.kind !== "string" || typeof entry.title !== "string") {
          return [];
        }
        return [
          {
            kind: entry.kind,
            severity: WORKBOARD_DIAGNOSTIC_SEVERITIES.includes(
              entry.severity as WorkboardDiagnosticSeverity,
            )
              ? (entry.severity as WorkboardDiagnosticSeverity)
              : "warning",
            title: entry.title,
            detail: typeof entry.detail === "string" ? entry.detail : entry.title,
            firstSeenAt: typeof entry.firstSeenAt === "number" ? entry.firstSeenAt : Date.now(),
            lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : Date.now(),
            count: typeof entry.count === "number" ? entry.count : 1,
          },
        ];
      })
    : [];
  const notifications = Array.isArray(value.notifications)
    ? value.notifications.flatMap((entry): WorkboardNotification[] => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.kind !== "string" ||
          typeof entry.message !== "string" ||
          typeof entry.createdAt !== "number"
        ) {
          return [];
        }
        return [
          {
            id: entry.id,
            kind: entry.kind,
            message: entry.message,
            createdAt: entry.createdAt,
            ...(typeof entry.sessionKey === "string" ? { sessionKey: entry.sessionKey } : {}),
            ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
          },
        ];
      })
    : [];
  const stale = isRecord(value.stale)
    ? {
        detectedAt:
          typeof value.stale.detectedAt === "number" ? value.stale.detectedAt : Date.now(),
        ...(typeof value.stale.lastSessionUpdatedAt === "number"
          ? { lastSessionUpdatedAt: value.stale.lastSessionUpdatedAt }
          : {}),
        reason:
          typeof value.stale.reason === "string"
            ? value.stale.reason
            : "Session has not reported recent activity.",
      }
    : undefined;
  const automation = normalizeAutomation(value.automation);
  const lifecycleStatusSourceUpdatedAt =
    typeof value.lifecycleStatusSourceUpdatedAt === "number" &&
    Number.isFinite(value.lifecycleStatusSourceUpdatedAt)
      ? Math.max(0, Math.trunc(value.lifecycleStatusSourceUpdatedAt))
      : undefined;
  const metadata: WorkboardMetadata = {
    ...(attempts.length ? { attempts } : {}),
    ...(comments.length ? { comments } : {}),
    ...(links.length ? { links } : {}),
    ...(proof.length ? { proof } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(workerLogs.length ? { workerLogs } : {}),
    ...(workerProtocol ? { workerProtocol } : {}),
    ...(automation ? { automation } : {}),
    ...(claim?.ownerId && claim.claimedAt ? { claim } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(notifications.length ? { notifications } : {}),
    ...(WORKBOARD_TEMPLATE_IDS.includes(value.templateId as WorkboardTemplateId)
      ? { templateId: value.templateId as WorkboardTemplateId }
      : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
    ...(stale ? { stale } : {}),
    ...(lifecycleStatusSourceUpdatedAt !== undefined ? { lifecycleStatusSourceUpdatedAt } : {}),
    ...(typeof value.failureCount === "number" ? { failureCount: value.failureCount } : {}),
  };
  return Object.keys(metadata).length ? metadata : undefined;
}

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  const execution = normalizeExecution(value.execution);
  const events = normalizeEvents(value.events);
  const metadata = normalizeMetadata(value.metadata);
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(execution ? { execution } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(events.length ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
} {
  if (!isRecord(payload)) {
    return { cards: [], statuses: WORKBOARD_STATUSES };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  return { cards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES };
}

function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}

function normalizeTaskStatus(value: unknown): WorkboardTaskStatus | null {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "timed_out":
      return value;
    default:
      return null;
  }
}

function normalizeTaskSummary(value: unknown): WorkboardTaskSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  const taskId = typeof value.taskId === "string" && value.taskId.trim() ? value.taskId.trim() : id;
  const status = normalizeTaskStatus(value.status);
  if (!id || !taskId || !status) {
    return null;
  }
  return {
    id,
    taskId,
    status,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.childSessionKey === "string"
      ? { childSessionKey: value.childSessionKey }
      : {}),
    ...(typeof value.ownerKey === "string" ? { ownerKey: value.ownerKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sourceId === "string" ? { sourceId: value.sourceId } : {}),
    ...(typeof value.updatedAt === "number" || typeof value.updatedAt === "string"
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(typeof value.progressSummary === "string"
      ? { progressSummary: value.progressSummary }
      : {}),
    ...(typeof value.terminalSummary === "string"
      ? { terminalSummary: value.terminalSummary }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function normalizeTasksPage(payload: unknown): {
  tasks: WorkboardTaskSummary[];
  nextCursor: string | null;
} {
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    return { tasks: [], nextCursor: null };
  }
  return {
    tasks: payload.tasks
      .map(normalizeTaskSummary)
      .filter((task): task is WorkboardTaskSummary => task !== null),
    nextCursor:
      typeof payload.nextCursor === "string" && payload.nextCursor.trim()
        ? payload.nextCursor.trim()
        : null,
  };
}

async function listWorkboardTasks(client: GatewayBrowserClient): Promise<WorkboardTaskSummary[]> {
  const tasks: WorkboardTaskSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const payload = await client.request("tasks.list", {
      limit: WORKBOARD_TASKS_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const page = normalizeTasksPage(payload);
    tasks.push(...page.tasks);
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      return tasks;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function taskUpdatedAtValue(task: WorkboardTaskSummary): number {
  if (typeof task.updatedAt === "number") {
    return task.updatedAt;
  }
  if (typeof task.updatedAt === "string") {
    const parsed = Date.parse(task.updatedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function taskLifecycleSourceUpdatedAt(task: WorkboardTaskSummary): number | undefined {
  const updatedAt = taskUpdatedAtValue(task);
  return updatedAt > 0 ? updatedAt : undefined;
}

function sessionUpdatedAtValue(session: GatewaySessionRow): number | undefined {
  return typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
    ? session.updatedAt
    : undefined;
}

function taskSessionKeyMatchesCardSession(
  taskSessionKey: string | undefined,
  cardSessionKey: string,
): boolean {
  if (!taskSessionKey) {
    return false;
  }
  if (taskSessionKey === cardSessionKey) {
    return true;
  }
  return (
    cardSessionKey.startsWith("subagent:workboard-") &&
    taskSessionKey.endsWith(`:${cardSessionKey}`)
  );
}

function taskMatchesCard(task: WorkboardTaskSummary, card: WorkboardCard): boolean {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId && (task.taskId === cardTaskId || task.id === cardTaskId)) {
    return true;
  }
  const cardSessionKey = workboardCardSessionKey(card);
  const taskSessionMatches = cardSessionKey
    ? [task.sessionKey, task.childSessionKey, task.ownerKey].some((taskSessionKey) =>
        taskSessionKeyMatchesCardSession(taskSessionKey, cardSessionKey),
      )
    : false;
  const cardRunId = workboardCardRunId(card);
  if (cardRunId && task.runId === cardRunId) {
    return cardSessionKey ? taskSessionMatches : true;
  }
  return taskSessionMatches;
}

function taskMatchesCanonicalCardLink(task: WorkboardTaskSummary, card: WorkboardCard): boolean {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId) {
    // Exact persisted task IDs stay authoritative when card run metadata is stale
    // or an otherwise matching task summary omits its optional run ID.
    return task.taskId === cardTaskId || task.id === cardTaskId;
  }
  const cardRunId = workboardCardRunId(card);
  if (cardRunId && task.runId !== cardRunId) {
    return false;
  }
  return taskMatchesCard(task, card);
}

function taskMatchesTrackedCardLink(
  task: WorkboardTaskSummary,
  card: WorkboardCard,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  const cardTaskId = normalizeString(card.taskId);
  return cardTaskId && missingTaskIds.has(cardTaskId)
    ? taskMatchesCard(task, card)
    : taskMatchesCanonicalCardLink(task, card);
}

function selectRotatingBatch<T>(
  host: WorkboardHost,
  items: readonly T[],
  limit: number,
  offsets: WeakMap<WorkboardHost, number>,
): T[] {
  if (items.length <= limit) {
    offsets.set(host, 0);
    return [...items];
  }
  const offset = (offsets.get(host) ?? 0) % items.length;
  const batch = Array.from(
    { length: limit },
    (_, index) => items[(offset + index) % items.length],
  ).filter((item): item is T => item !== undefined);
  offsets.set(host, (offset + batch.length) % items.length);
  return batch;
}

function selectWorkboardTaskPollIds(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>,
  missingTaskIds: ReadonlySet<string>,
): string[] {
  // Prepared summaries cover links between polls; rotate a hard-bounded batch
  // so active, terminal, and unresolved task IDs are eventually revalidated.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const previousMatches = previousTask
      ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds)
      : false;
    let taskId: string | undefined;
    if (previousMatches && previousTask) {
      taskId = previousTask.taskId;
    } else if (!previousMatches) {
      taskId = normalizeString(card.taskId) ?? undefined;
    }
    if (taskId && missingTaskIds.has(taskId)) {
      continue;
    }
    if (taskId && !seen.has(taskId)) {
      seen.add(taskId);
      ids.push(taskId);
    }
  }
  return selectRotatingBatch(host, ids, WORKBOARD_TASK_POLL_BATCH_SIZE, workboardTaskPollOffsets);
}

type WorkboardTaskDiscoveryQuery = {
  sessionKey?: string;
  cursor?: string;
};

function selectWorkboardTaskDiscoveryQueries(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>,
  missingTaskIds: ReadonlySet<string>,
): WorkboardTaskDiscoveryQuery[] {
  const queries: WorkboardTaskDiscoveryQuery[] = [];
  const seenSessionKeys = new Set<string>();
  let hasUnfilteredQuery = false;
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const cardTaskId = normalizeString(card.taskId);
    const hasCanonicalTask =
      Boolean(cardTaskId && !missingTaskIds.has(cardTaskId)) ||
      (previousTask ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds) : false);
    const sessionKey = workboardCardSessionKey(card);
    if (card.status !== "running" || hasCanonicalTask || !sessionKey) {
      continue;
    }
    // The gateway filter is exact-match only. Default-agent Workboard sessions
    // omit the canonical agent prefix, so rotate through bounded unfiltered pages.
    if (sessionKey.startsWith("subagent:workboard-")) {
      if (!hasUnfilteredQuery) {
        hasUnfilteredQuery = true;
        const cursor = workboardDefaultTaskDiscoveryCursors.get(host);
        queries.push(cursor ? { cursor } : {});
      }
    } else if (!seenSessionKeys.has(sessionKey)) {
      seenSessionKeys.add(sessionKey);
      queries.push({ sessionKey });
    }
  }
  return selectRotatingBatch(
    host,
    queries,
    WORKBOARD_TASK_DISCOVERY_BATCH_SIZE,
    workboardTaskDiscoveryOffsets,
  );
}

function isMissingTaskLookupError(error: unknown, taskId: string): boolean {
  // tasks.get currently has no structured not-found detail code.
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === `task not found: ${taskId}`
  );
}

async function getWorkboardTaskPollBatch(
  client: GatewayBrowserClient,
  taskIds: readonly string[],
  discoveryQueries: readonly WorkboardTaskDiscoveryQuery[],
): Promise<{
  tasks: WorkboardTaskSummary[];
  missingTaskIds: Set<string>;
  nextUnfilteredCursor?: string | null;
  error: string | null;
}> {
  const results = await Promise.allSettled([
    ...taskIds.map(async (taskId) => {
      try {
        const payload = await client.request("tasks.get", { taskId });
        const task = isRecord(payload) ? normalizeTaskSummary(payload.task) : null;
        return { tasks: task ? [task] : [] };
      } catch (error) {
        if (isMissingTaskLookupError(error, taskId)) {
          return { tasks: [], missingTaskId: taskId };
        }
        throw error;
      }
    }),
    ...discoveryQueries.map(async (query) => {
      const payload = await client.request("tasks.list", {
        ...query,
        limit: WORKBOARD_TASKS_LIST_LIMIT,
      });
      const page = normalizeTasksPage(payload);
      return {
        tasks: page.tasks,
        ...(query.sessionKey ? {} : { nextUnfilteredCursor: page.nextCursor ?? null }),
      };
    }),
  ]);
  const tasks: WorkboardTaskSummary[] = [];
  const missingTaskIds = new Set<string>();
  let nextUnfilteredCursor: string | null | undefined;
  let error: string | null = null;
  for (const result of results) {
    if (result.status === "fulfilled") {
      tasks.push(...result.value.tasks);
      if ("missingTaskId" in result.value && result.value.missingTaskId) {
        missingTaskIds.add(result.value.missingTaskId);
      }
      if ("nextUnfilteredCursor" in result.value) {
        nextUnfilteredCursor = result.value.nextUnfilteredCursor;
      }
    } else {
      error ??= formatError(result.reason);
    }
  }
  return { tasks, missingTaskIds, nextUnfilteredCursor, error };
}

type WorkboardTaskIndex = {
  byId: Map<string, WorkboardTaskSummary[]>;
  byRunId: Map<string, WorkboardTaskSummary[]>;
  bySessionKey: Map<string, WorkboardTaskSummary[]>;
};

function addTaskIndexEntry(
  index: Map<string, WorkboardTaskSummary[]>,
  key: string | undefined,
  task: WorkboardTaskSummary,
) {
  if (!key) {
    return;
  }
  const tasks = index.get(key) ?? [];
  tasks.push(task);
  index.set(key, tasks);
}

function buildWorkboardTaskIndex(tasks: readonly WorkboardTaskSummary[]): WorkboardTaskIndex {
  const index: WorkboardTaskIndex = {
    byId: new Map(),
    byRunId: new Map(),
    bySessionKey: new Map(),
  };
  for (const task of tasks) {
    addTaskIndexEntry(index.byId, task.id, task);
    addTaskIndexEntry(index.byId, task.taskId, task);
    addTaskIndexEntry(index.byRunId, task.runId, task);
    for (const sessionKey of [task.sessionKey, task.childSessionKey, task.ownerKey]) {
      addTaskIndexEntry(index.bySessionKey, sessionKey, task);
      const nestedWorkboardSessionIndex = sessionKey?.lastIndexOf(":subagent:workboard-") ?? -1;
      if (nestedWorkboardSessionIndex >= 0) {
        addTaskIndexEntry(
          index.bySessionKey,
          sessionKey?.slice(nestedWorkboardSessionIndex + 1),
          task,
        );
      }
    }
  }
  return index;
}

function findLatestTaskForCard(
  index: WorkboardTaskIndex,
  card: WorkboardCard,
  missingTaskIds?: ReadonlySet<string>,
): WorkboardTaskSummary | null {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId) {
    let latestExact: WorkboardTaskSummary | null = null;
    for (const task of index.byId.get(cardTaskId) ?? []) {
      if (
        taskMatchesCanonicalCardLink(task, card) &&
        (!latestExact || taskUpdatedAtValue(task) > taskUpdatedAtValue(latestExact))
      ) {
        latestExact = task;
      }
    }
    if (latestExact || !missingTaskIds?.has(cardTaskId)) {
      return latestExact;
    }
  }
  const candidates = new Set<WorkboardTaskSummary>();
  const addCandidates = (tasks: readonly WorkboardTaskSummary[] | undefined) => {
    for (const task of tasks ?? []) {
      candidates.add(task);
    }
  };
  addCandidates(index.byRunId.get(workboardCardRunId(card) ?? ""));
  addCandidates(index.bySessionKey.get(workboardCardSessionKey(card) ?? ""));
  let latest: WorkboardTaskSummary | null = null;
  for (const task of candidates) {
    if (
      taskMatchesCard(task, card) &&
      (!latest || taskUpdatedAtValue(task) > taskUpdatedAtValue(latest))
    ) {
      latest = task;
    }
  }
  return latest;
}

function selectWorkboardMissingTaskConfirmationIds(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  tasks: readonly WorkboardTaskSummary[],
  missingTaskIds: ReadonlySet<string>,
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary> = new Map(),
  confirmedTaskIds: ReadonlySet<string> = new Set(),
  limit = WORKBOARD_TASK_POLL_BATCH_SIZE,
): string[] {
  const taskIndex = buildWorkboardTaskIndex(tasks);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const previousMatches = previousTask
      ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds)
      : false;
    const taskId =
      previousMatches && previousTask ? previousTask.taskId : normalizeString(card.taskId);
    if (
      !taskId ||
      seen.has(taskId) ||
      missingTaskIds.has(taskId) ||
      confirmedTaskIds.has(taskId) ||
      findLatestTaskForCard(taskIndex, card, missingTaskIds)
    ) {
      continue;
    }
    seen.add(taskId);
    ids.push(taskId);
  }
  return Number.isFinite(limit)
    ? selectRotatingBatch(host, ids, limit, workboardTaskPollOffsets)
    : ids;
}

type WorkboardTaskLinkState = Pick<WorkboardUiState, "cards" | "tasksByCardId" | "missingTaskIds">;

function applyTaskSummariesToState(
  state: WorkboardTaskLinkState,
  tasks: readonly WorkboardTaskSummary[],
  options: {
    missingTaskIds?: ReadonlySet<string>;
  } = {},
) {
  const tasksByCardId = new Map<string, WorkboardTaskSummary>();
  const taskIndex = buildWorkboardTaskIndex(tasks);
  // Keep historical card links read-only while remembering exact ledger misses.
  // Confirmed misses stop blocking starts without writes from passive refresh paths.
  const missingTaskIds = new Set([...state.missingTaskIds, ...(options.missingTaskIds ?? [])]);
  const cards = state.cards.map((card) => {
    const cardTaskId = normalizeString(card.taskId);
    const task = findLatestTaskForCard(taskIndex, card, missingTaskIds);
    if (!task) {
      return card;
    }
    tasksByCardId.set(card.id, task);
    const replacesMissingTask =
      Boolean(cardTaskId && missingTaskIds.has(cardTaskId)) &&
      task.taskId !== cardTaskId &&
      task.id !== cardTaskId;
    if (cardTaskId && !replacesMissingTask) {
      missingTaskIds.delete(cardTaskId);
    }
    missingTaskIds.delete(task.taskId);
    if (card.taskId === task.taskId || replacesMissingTask) {
      return card;
    }
    return { ...card, taskId: task.taskId };
  });
  const linkedTaskIds = new Set(
    cards
      .map((card) => normalizeString(card.taskId))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );
  state.cards = cards;
  state.tasksByCardId = tasksByCardId;
  state.missingTaskIds = new Set([...missingTaskIds].filter((taskId) => linkedTaskIds.has(taskId)));
}

function workboardLifecycleRequiresTaskRefresh(state: WorkboardTaskLinkState): boolean {
  return (
    state.tasksByCardId.size > 0 ||
    state.cards.some((card) => {
      const taskId = normalizeString(card.taskId);
      return Boolean(taskId && !state.missingTaskIds.has(taskId));
    })
  );
}

function shouldRefreshWorkboardTasksForLifecycle(state: WorkboardTaskLinkState): boolean {
  return (
    workboardLifecycleRequiresTaskRefresh(state) ||
    state.cards.some((card) => card.status === "running" && Boolean(workboardCardSessionKey(card)))
  );
}

function workboardTaskLinksReadyForLifecycle(
  state: WorkboardTaskLinkState,
  options: { requireRunningTaskDiscovery?: boolean } = {},
): boolean {
  return state.cards.every((card) => {
    const taskId = normalizeString(card.taskId);
    if (taskId) {
      return state.missingTaskIds.has(taskId) || state.tasksByCardId.has(card.id);
    }
    return (
      !options.requireRunningTaskDiscovery ||
      card.status !== "running" ||
      !workboardCardSessionKey(card) ||
      state.tasksByCardId.has(card.id)
    );
  });
}

function normalizeDispatchSummary(value: unknown): WorkboardDispatchSummary {
  const countArray = (key: string) =>
    isRecord(value) && Array.isArray(value[key]) ? value[key].length : 0;
  return {
    started: countArray("started"),
    failures: countArray("startFailures"),
    promoted: countArray("promoted"),
    blocked: countArray("blocked"),
    reclaimed: countArray("reclaimed"),
    orchestrated: countArray("orchestrated"),
  };
}

type LoadWorkboardParams = {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
  refreshDiagnostics?: boolean;
  taskRefresh?: "all" | "linked";
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  return await loadWorkboardInternal(params);
}

async function loadWorkboardInternal(
  params: LoadWorkboardParams,
  queuedAfterGeneration?: number,
): Promise<boolean> {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    (!params.force && (state.loaded || state.loadAttempted))
  ) {
    return false;
  }
  const client = params.client;
  const existingLoad = workboardLoadPromises.get(params.host);
  if (existingLoad) {
    const existingGeneration = workboardLoadGenerations.get(params.host);
    const result = await existingLoad;
    const existingLoadIsCurrent =
      existingGeneration !== undefined &&
      isCurrentWorkboardLoadGeneration(params.host, existingGeneration);
    const currentLoadToken = workboardLoadTokens.get(params.host);
    // Only follow a replacement created by this load's forced-waiter queue.
    // Fresh loads after teardown or writes must not revive stale callers.
    const queuedLoadReplacedExisting =
      existingGeneration !== undefined &&
      currentLoadToken?.queuedAfterGeneration === existingGeneration &&
      workboardLoadPromises.has(params.host);
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return params.force &&
      (existingLoadIsCurrent || queuedLoadReplacedExisting) &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboardInternal(params, existingGeneration)
      : result;
  }
  const generation = nextWorkboardLoadGeneration(params.host);
  const loadToken: WorkboardLoadToken = { queuedAfterGeneration };
  workboardLoadTokens.set(params.host, loadToken);
  const lastRefreshErrorBeforeLoad = state.lastRefreshError;
  state.loadAttempted = true;
  state.loading = true;
  if (!params.preserveError) {
    workboardLoadErrors.delete(params.host);
    state.error = null;
  }
  if (params.taskRefresh !== "linked" || !state.lifecycleTaskRefreshFailed) {
    state.lastRefreshError = null;
  }
  params.requestUpdate?.();
  const loadPromise = (async () => {
    try {
      if (params.refreshDiagnostics) {
        try {
          await client.request("workboard.cards.diagnostics.refresh", {});
        } catch (error) {
          if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
            state.lastRefreshError = formatError(error);
          }
        }
      }
      const payload = await client.request("workboard.cards.list", {});
      const normalized = normalizeCardsPayload(payload);
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      const previousTasksByCardId = state.tasksByCardId;
      const taskLinkState: WorkboardTaskLinkState = {
        cards: normalized.cards,
        tasksByCardId: new Map(),
        missingTaskIds: new Set(state.missingTaskIds),
      };
      let lifecycleTaskRefreshFailed = state.lifecycleTaskRefreshFailed;
      let preserveLifecycleTaskRefreshFailure = false;
      let nextTaskRefreshError: string | null = null;
      let nextUnfilteredCursor: string | null | undefined;
      if (taskLinkState.cards.length > 0) {
        const preparedTaskSummaries = taskLinkState.cards.flatMap((card) => {
          const task = previousTasksByCardId.get(card.id);
          return task && taskMatchesTrackedCardLink(task, card, taskLinkState.missingTaskIds)
            ? [task]
            : [];
        });
        try {
          const pollResult =
            params.taskRefresh === "linked"
              ? await getWorkboardTaskPollBatch(
                  client,
                  selectWorkboardTaskPollIds(
                    params.host,
                    taskLinkState.cards,
                    previousTasksByCardId,
                    taskLinkState.missingTaskIds,
                  ),
                  selectWorkboardTaskDiscoveryQueries(
                    params.host,
                    taskLinkState.cards,
                    previousTasksByCardId,
                    taskLinkState.missingTaskIds,
                  ),
                )
              : null;
          let taskSummaries: WorkboardTaskSummary[];
          let missingTaskIds: ReadonlySet<string>;
          let taskRefreshError: string | null;
          if (pollResult) {
            taskSummaries = [
              ...pollResult.tasks,
              ...preparedTaskSummaries.filter(
                (task) => !pollResult.missingTaskIds.has(task.taskId),
              ),
            ];
            missingTaskIds = pollResult.missingTaskIds;
            taskRefreshError = pollResult.error;
          } else {
            const listedTaskSummaries = await listWorkboardTasks(client);
            const confirmationResult = await getWorkboardTaskPollBatch(
              client,
              selectWorkboardMissingTaskConfirmationIds(
                params.host,
                taskLinkState.cards,
                listedTaskSummaries,
                taskLinkState.missingTaskIds,
                previousTasksByCardId,
              ),
              [],
            );
            const previousTasksToPreserve = confirmationResult.error
              ? preparedTaskSummaries.filter(
                  (task) => !confirmationResult.missingTaskIds.has(task.taskId),
                )
              : [];
            taskSummaries = [
              ...listedTaskSummaries,
              ...confirmationResult.tasks,
              ...previousTasksToPreserve,
            ];
            missingTaskIds = confirmationResult.missingTaskIds;
            taskRefreshError = confirmationResult.error;
          }
          nextUnfilteredCursor = pollResult?.nextUnfilteredCursor;
          applyTaskSummariesToState(taskLinkState, taskSummaries, { missingTaskIds });
          preserveLifecycleTaskRefreshFailure =
            params.taskRefresh === "linked" &&
            state.lifecycleTaskRefreshFailed &&
            !taskRefreshError &&
            shouldRefreshWorkboardTasksForLifecycle(taskLinkState);
          lifecycleTaskRefreshFailed =
            Boolean(taskRefreshError) || preserveLifecycleTaskRefreshFailure;
          if (taskRefreshError) {
            nextTaskRefreshError = taskRefreshError;
          }
        } catch (error) {
          applyTaskSummariesToState(taskLinkState, preparedTaskSummaries);
          // Render-driven lifecycle sync runs after every update. Defer a
          // failed task refresh until a later authoritative refresh.
          lifecycleTaskRefreshFailed = true;
          nextTaskRefreshError = formatError(error);
        }
      } else {
        lifecycleTaskRefreshFailed = false;
      }
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      if (params.taskRefresh === "linked" && shouldDeferWorkboardPoll(state)) {
        return false;
      }
      if (nextUnfilteredCursor !== undefined) {
        if (nextUnfilteredCursor) {
          workboardDefaultTaskDiscoveryCursors.set(params.host, nextUnfilteredCursor);
        } else {
          workboardDefaultTaskDiscoveryCursors.delete(params.host);
        }
      }
      state.cards = taskLinkState.cards;
      state.statuses = normalized.statuses;
      state.tasksByCardId = taskLinkState.tasksByCardId;
      state.missingTaskIds = taskLinkState.missingTaskIds;
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      const recoveredFromLifecycleTaskRefresh =
        state.lifecycleTaskRefreshFailed && !lifecycleTaskRefreshFailed;
      if (!preserveLifecycleTaskRefreshFailure) {
        setWorkboardLifecycleTaskRefreshFailed(state, lifecycleTaskRefreshFailed, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
      }
      if (!lifecycleTaskRefreshFailed) {
        state.lifecycleTaskRefreshError = null;
        if (
          recoveredFromLifecycleTaskRefresh &&
          state.lastRefreshError === lastRefreshErrorBeforeLoad
        ) {
          state.lastRefreshError = null;
        }
      }
      if (nextTaskRefreshError) {
        state.lifecycleTaskRefreshError = nextTaskRefreshError;
        state.lastRefreshError = nextTaskRefreshError;
      }
      setWorkboardLifecycleTasksPrepared(
        state,
        !lifecycleTaskRefreshFailed &&
          workboardTaskLinksReadyForLifecycle(taskLinkState, {
            requireRunningTaskDiscovery: params.taskRefresh === "linked",
          }),
        { host: params.host, requestUpdate: params.requestUpdate },
      );
      const recoveredLoadError = workboardLoadErrors.get(params.host);
      if (recoveredLoadError !== undefined && state.error === recoveredLoadError) {
        state.error = null;
      }
      workboardLoadErrors.delete(params.host);
      // Preserve stale edit text for recovery, but never re-enable its full-card
      // save payload after canonical state may have changed.
      state.mutationReadiness = state.editingCardId ? "stale_edit_draft" : "ready";
      state.loaded = true;
      return true;
    } catch (error) {
      if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
        const formattedError = formatError(error);
        if (params.preserveError) {
          state.lastRefreshError = formattedError;
        } else {
          workboardLoadErrors.set(params.host, formattedError);
          state.error = formattedError;
        }
      }
      return false;
    } finally {
      const isCurrentGeneration = isCurrentWorkboardLoadGeneration(params.host, generation);
      const ownsLoad = workboardLoadTokens.get(params.host) === loadToken;
      if (!isCurrentGeneration && !state.loaded) {
        state.loadAttempted = false;
      }
      if (isCurrentGeneration || (ownsLoad && !state.draftSaving)) {
        state.loading = false;
      }
      if (ownsLoad) {
        workboardLoadPromises.delete(params.host);
        workboardLoadTokens.delete(params.host);
      }
      params.requestUpdate?.();
    }
  })();
  workboardLoadPromises.set(params.host, loadPromise);
  return await loadPromise;
}

export async function refreshWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  source: WorkboardRefreshSource;
  refreshDiagnostics?: boolean;
  pollGeneration?: number;
}) {
  const state = getWorkboardState(params.host);
  const pollGeneration =
    params.source === "poll"
      ? (params.pollGeneration ?? currentWorkboardPollingGeneration(params.host))
      : null;
  if (
    pollGeneration !== null &&
    !isCurrentWorkboardPollingGeneration(params.host, pollGeneration)
  ) {
    return;
  }
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return;
  }
  const startedAt = Date.now();
  state.lastRefreshStartedAt = startedAt;
  state.lastRefreshSource = params.source;
  if (params.source !== "poll" || !state.lifecycleTaskRefreshFailed) {
    state.lastRefreshError = null;
  }
  if (params.source === "poll") {
    state.pollRefreshInProgress = true;
  }
  params.requestUpdate?.();
  if (!params.client) {
    state.lastRefreshError = "Gateway client unavailable";
    if (
      pollGeneration !== null &&
      isCurrentWorkboardPollingGeneration(params.host, pollGeneration)
    ) {
      state.pollRefreshInProgress = false;
    }
    params.requestUpdate?.();
    return;
  }
  try {
    const refreshed = await loadWorkboard({
      host: params.host,
      client: params.client,
      requestUpdate: params.requestUpdate,
      force: true,
      refreshDiagnostics: params.refreshDiagnostics,
      taskRefresh: params.source === "poll" ? "linked" : "all",
      preserveError: params.source === "poll",
    });
    state.lastRefreshSource = params.source;
    if (params.source !== "poll" && state.error) {
      state.lastRefreshError = state.error;
    } else if (refreshed) {
      state.lastRefreshAt = Date.now();
    }
  } finally {
    if (
      pollGeneration !== null &&
      isCurrentWorkboardPollingGeneration(params.host, pollGeneration)
    ) {
      state.pollRefreshInProgress = false;
    }
    params.requestUpdate?.();
  }
}

function workboardDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function shouldDeferWorkboardPoll(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    workboardHasActiveWrites(state) ||
    state.draggedCardId ||
    state.dispatching ||
    state.detailCommentBody.trim() ||
    state.draftCommentBody.trim(),
  );
}

function clearWorkboardPolling(host: WorkboardHost) {
  const timer = workboardPollingTimers.get(host);
  if (timer) {
    clearTimeout(timer);
    workboardPollingTimers.delete(host);
  }
}

function scheduleWorkboardPoll(host: WorkboardHost) {
  clearWorkboardPolling(host);
  const entry = workboardPollingEntries.get(host);
  if (!entry?.enabled || !entry.client || entry.intervalMs <= 0) {
    return;
  }
  const pollingGeneration = currentWorkboardPollingGeneration(host);
  const timer = setTimeout(() => {
    workboardPollingTimers.delete(host);
    if (!isCurrentWorkboardPollingGeneration(host, pollingGeneration)) {
      return;
    }
    const current = workboardPollingEntries.get(host);
    const state = getWorkboardState(host);
    if (!current?.enabled || !current.client || current.intervalMs <= 0) {
      return;
    }
    const run = async () => {
      if (!workboardDocumentHidden() && !shouldDeferWorkboardPoll(state)) {
        await refreshWorkboard({
          host,
          client: current.client,
          requestUpdate: current.requestUpdate,
          source: "poll",
          pollGeneration: pollingGeneration,
        });
      }
    };
    void run().finally(() => {
      if (isCurrentWorkboardPollingGeneration(host, pollingGeneration)) {
        scheduleWorkboardPoll(host);
      }
    });
  }, entry.intervalMs);
  workboardPollingTimers.set(host, timer);
}

export function configureWorkboardPolling(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  enabled: boolean;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const intervalMs = state.autoRefreshIntervalMs;
  const previous = workboardPollingEntries.get(params.host);
  const enabled = params.enabled && intervalMs > 0;
  workboardPollingEntries.set(params.host, {
    client: params.client,
    enabled,
    intervalMs,
    requestUpdate: params.requestUpdate,
  });
  if (!enabled) {
    clearWorkboardPolling(params.host);
    clearWorkboardLifecycleTaskPreparedTimer(params.host);
    clearWorkboardLifecycleTaskRetryTimer(params.host);
    return;
  }
  const configChanged =
    !previous ||
    previous.enabled !== enabled ||
    previous.intervalMs !== intervalMs ||
    previous.client !== params.client;
  if (!state.pollRefreshInProgress && (configChanged || !workboardPollingTimers.get(params.host))) {
    scheduleWorkboardPoll(params.host);
  }
}

export function stopWorkboardPolling(host: WorkboardHost) {
  nextWorkboardPollingGeneration(host);
  clearWorkboardPolling(host);
  workboardPollingEntries.delete(host);
  const state = workboardStates.get(host);
  if (!state?.pollRefreshInProgress) {
    return;
  }
  state.pollRefreshInProgress = false;
  state.loading = false;
  if (!state.loaded) {
    state.loadAttempted = false;
  }
  nextWorkboardLoadGeneration(host);
  workboardLoadPromises.delete(host);
  workboardLoadTokens.delete(host);
}

function replaceCard(state: WorkboardUiState, card: WorkboardCard) {
  const next = state.cards.filter((existing) => existing.id !== card.id);
  next.push(card);
  state.cards = next.toSorted((left, right) => left.position - right.position);
}

function parentDependencyIds(card: WorkboardCard): string[] {
  const ids: string[] = [];
  for (const link of card.metadata?.links ?? []) {
    const id = link.type === "parent" ? link.targetCardId?.trim() : "";
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function getWorkboardDependencyState(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
): WorkboardDependencyState {
  const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
  const parents = parentDependencyIds(card).map((id) => {
    const parent = cardsById.get(id);
    return {
      id,
      title: parent?.title ?? id,
      status: parent?.status,
      done: parent?.status === "done",
      missing: !parent,
    };
  });
  return {
    parents,
    blockedParents: parents.filter((parent) => !parent.done),
  };
}

function removeCardAndReferences(cards: readonly WorkboardCard[], cardId: string): WorkboardCard[] {
  const nextCards: WorkboardCard[] = [];
  for (const card of cards) {
    if (card.id === cardId) {
      continue;
    }
    const links = card.metadata?.links;
    if (!links?.some((link) => link.targetCardId === cardId)) {
      nextCards.push(card);
      continue;
    }
    const nextLinks = links.filter((link) => link.targetCardId !== cardId);
    const metadata: WorkboardMetadata = { ...card.metadata, links: nextLinks };
    if (nextLinks.length === 0) {
      delete metadata.links;
    }
    nextCards.push(
      Object.keys(metadata).length ? { ...card, metadata } : { ...card, metadata: undefined },
    );
  }
  return nextCards;
}

function resetDraftState(state: WorkboardUiState) {
  const resolveStaleEdit = state.loaded && state.mutationReadiness === "stale_edit_draft";
  state.draftOpen = false;
  state.editingCardId = null;
  state.draftTitle = "";
  state.draftNotes = "";
  state.draftStatus = "todo";
  state.draftPriority = "normal";
  state.draftLabels = "";
  state.draftAgentId = "";
  state.draftSessionKey = "";
  state.draftTemplateId = "";
  state.draftCommentBody = "";
  if (resolveStaleEdit) {
    state.mutationReadiness = "ready";
  }
}

function normalizeDraftLabels(value: string): string[] {
  const labels: string[] = [];
  for (const label of value.split(",")) {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed)) {
      labels.push(trimmed);
    }
    if (labels.length >= 12) {
      break;
    }
  }
  return labels;
}

function draftPayload(state: WorkboardUiState) {
  return {
    title: state.draftTitle,
    notes: state.draftNotes,
    status: state.draftStatus,
    priority: state.draftPriority,
    labels: normalizeDraftLabels(state.draftLabels),
    agentId: state.draftAgentId,
    sessionKey: state.draftSessionKey,
    ...(state.draftTemplateId ? { templateId: state.draftTemplateId } : {}),
  };
}

function isFailedSessionStatus(status: GatewaySessionRow["status"]): boolean {
  return status === "failed" || status === "killed" || status === "timeout";
}

function staleSessionState(session: GatewaySessionRow): WorkboardStaleState | undefined {
  if (session.status !== "running") {
    return undefined;
  }
  if (session.hasActiveRun !== false) {
    return undefined;
  }
  if (
    typeof session.updatedAt !== "number" ||
    Date.now() - session.updatedAt < WORKBOARD_STALE_SESSION_MS
  ) {
    return undefined;
  }
  return {
    detectedAt: Date.now(),
    lastSessionUpdatedAt: session.updatedAt,
    reason: "Linked session has not reported recent activity.",
  };
}

function workboardCardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

function workboardCardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}

export function getWorkboardLifecycle(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions);
  if (task) {
    switch (task.status) {
      case "queued":
      case "running":
        if (
          session &&
          (session.abortedLastRun ||
            session.status === "done" ||
            isFailedSessionStatus(session.status))
        ) {
          break;
        }
        return {
          session,
          state: "running",
          targetStatus: "running",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
      case "completed":
        return {
          session,
          state: "succeeded",
          targetStatus: "review",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
      case "failed":
      case "cancelled":
      case "timed_out":
        return {
          session,
          state: "failed",
          targetStatus: "blocked",
          sourceUpdatedAt: taskLifecycleSourceUpdatedAt(task),
        };
    }
  }
  if (!workboardCardSessionKey(card)) {
    return { session: null, state: "unlinked" };
  }
  if (!session) {
    return { session: null, state: "missing" };
  }
  if (staleSessionState(session)) {
    return {
      session,
      state: "stale",
      targetStatus: "running",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return {
      session,
      state: "running",
      targetStatus: "running",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return {
      session,
      state: "failed",
      targetStatus: "blocked",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  if (session.status === "done") {
    return {
      session,
      state: "succeeded",
      targetStatus: "review",
      sourceUpdatedAt: sessionUpdatedAtValue(session),
    };
  }
  return { session, state: "idle" };
}

function shouldSyncCardStatus(card: WorkboardCard, targetStatus: WorkboardStatus | undefined) {
  if (!targetStatus || card.status === targetStatus) {
    return false;
  }
  if (targetStatus === "running") {
    return card.status === "backlog" || card.status === "todo" || card.status === "ready";
  }
  if (targetStatus === "blocked" || targetStatus === "review") {
    return card.status === "running" || card.status === "todo" || card.status === "ready";
  }
  return false;
}

const pendingStatusTransitions = new WeakMap<WorkboardHost, Set<string>>();

function pendingStatusTransitionMap(host: WorkboardHost) {
  let transitions = pendingStatusTransitions.get(host);
  if (!transitions) {
    transitions = new Set();
    pendingStatusTransitions.set(host, transitions);
  }
  return transitions;
}

function recordPendingStatusTransition(
  host: WorkboardHost,
  card: WorkboardCard | undefined,
  status: WorkboardStatus,
): boolean {
  if (!card || card.status === status) {
    return false;
  }
  pendingStatusTransitionMap(host).add(card.id);
  return true;
}

function clearPendingStatusTransition(host: WorkboardHost, cardId: string, recorded: boolean) {
  if (!recorded) {
    return;
  }
  const transitions = pendingStatusTransitions.get(host);
  transitions?.delete(cardId);
}

function hasPendingStatusTransition(host: WorkboardHost, cardId: string): boolean {
  return pendingStatusTransitions.get(host)?.has(cardId) ?? false;
}

function shouldSkipStaleLifecycleStatus(
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
): boolean {
  if (lifecycle.sourceUpdatedAt === undefined) {
    return false;
  }
  const lifecycleStatusSourceUpdatedAt = card.metadata?.lifecycleStatusSourceUpdatedAt;
  if (lifecycleStatusSourceUpdatedAt !== undefined) {
    return lifecycle.sourceUpdatedAt < lifecycleStatusSourceUpdatedAt;
  }
  const statusTransitionAt = latestStatusTransitionAt(card);
  return statusTransitionAt !== undefined && lifecycle.sourceUpdatedAt < statusTransitionAt;
}

function shouldSkipLifecycleStatusWrite(
  host: WorkboardHost,
  card: WorkboardCard,
  lifecycle: WorkboardLifecycle,
): boolean {
  return (
    hasPendingStatusTransition(host, card.id) || shouldSkipStaleLifecycleStatus(card, lifecycle)
  );
}

function latestStatusTransitionAt(card: WorkboardCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if (
      (event?.kind === "moved" || event?.kind === "created") &&
      ((event.kind === "created" && card.status !== "todo") ||
        (event.kind === "moved" && event.fromStatus !== event.toStatus)) &&
      event.toStatus === card.status &&
      typeof event.at === "number" &&
      Number.isFinite(event.at)
    ) {
      return event.at;
    }
  }
  return undefined;
}

function executionStatusForLifecycle(
  lifecycle: WorkboardLifecycle,
): WorkboardExecutionStatus | undefined {
  switch (lifecycle.state) {
    case "running":
    case "stale":
      return "running";
    case "succeeded":
      return "review";
    case "failed":
      return "blocked";
    case "missing":
      return undefined;
    case "idle":
      return "idle";
    case "unlinked":
      return undefined;
  }
  return undefined;
}

function shouldSyncExecutionStatus(
  card: WorkboardCard,
  targetStatus: WorkboardExecutionStatus | undefined,
) {
  return Boolean(card.execution && targetStatus && card.execution.status !== targetStatus);
}

function lifecycleSyncKey(card: WorkboardCard, lifecycle: WorkboardLifecycle): string {
  const session = lifecycle.session;
  return [
    card.id,
    card.status,
    card.updatedAt,
    lifecycle.targetStatus ?? "",
    lifecycle.state,
    session?.status ?? "",
    session?.hasActiveRun === true ? "active" : "idle",
    session?.updatedAt ?? "",
    lifecycle.sourceUpdatedAt ?? "",
    card.execution?.status ?? "",
    card.execution?.updatedAt ?? "",
  ].join(":");
}

const lifecycleSyncKeys = new WeakMap<WorkboardHost, Map<string, string>>();

function getLifecycleSyncKeys(host: WorkboardHost): Map<string, string> {
  let keys = lifecycleSyncKeys.get(host);
  if (!keys) {
    keys = new Map();
    lifecycleSyncKeys.set(host, keys);
  }
  return keys;
}

function mergePatchMetadata(patch: Record<string, unknown>, metadata: Record<string, unknown>) {
  patch.metadata = {
    ...(isRecord(patch.metadata) ? patch.metadata : {}),
    ...metadata,
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractChatHistoryText(
  messages: unknown[],
  role: "assistant" | "user",
  direction: "first" | "last",
): string | null {
  const ordered = direction === "first" ? messages : messages.toReversed();
  for (const message of ordered) {
    if (!isRecord(message) || message.role !== role) {
      continue;
    }
    const text = textFromContent(message.content).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function clampSessionCaptureText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= SESSION_CAPTURE_TEXT_MAX_CHARS) {
    return compact;
  }
  return `${truncateUtf16Safe(compact, SESSION_CAPTURE_TEXT_MAX_CHARS - 3).trimEnd()}...`;
}

function clampSessionCaptureTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= WORKBOARD_CAPTURE_TITLE_MAX_CHARS) {
    return compact;
  }
  return `${truncateUtf16Safe(compact, WORKBOARD_CAPTURE_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

function sessionTitle(session: GatewaySessionRow, recentUserText: string | null): string {
  const title =
    normalizeString(session.label) ??
    normalizeString(session.displayName) ??
    recentUserText ??
    session.key;
  return clampSessionCaptureTitle(title);
}

function sessionCaptureStatus(session: GatewaySessionRow): WorkboardStatus {
  if (session.hasActiveRun === true || session.status === "running") {
    return "running";
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return "blocked";
  }
  if (session.status === "done") {
    return "review";
  }
  return "todo";
}

async function loadSessionCaptureHistory(params: {
  client: GatewayBrowserClient;
  sessionKey: string;
}): Promise<unknown[]> {
  try {
    const payload = await params.client.request("chat.history", {
      sessionKey: params.sessionKey,
      limit: SESSION_CAPTURE_HISTORY_LIMIT,
      maxChars: SESSION_CAPTURE_HISTORY_MAX_CHARS,
    });
    return isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  } catch {
    return [];
  }
}

function buildSessionCaptureNotes(params: {
  session: GatewaySessionRow;
  recentUserText: string | null;
  lastAssistantText: string | null;
}): string {
  const lines = [`Session: ${params.session.key}`];
  if (params.recentUserText) {
    lines.push("", `Recent user prompt: ${clampSessionCaptureText(params.recentUserText)}`);
  }
  if (params.lastAssistantText) {
    lines.push("", `Latest assistant note: ${clampSessionCaptureText(params.lastAssistantText)}`);
  }
  return lines.join("\n");
}

export async function captureSessionToWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  session: GatewaySessionRow;
  requestUpdate?: () => void;
}): Promise<WorkboardCard | null> {
  const state = getWorkboardState(params.host);
  if (!params.client || params.session.kind === "global" || state.dispatching) {
    return null;
  }
  if (state.capturingSessionKeys.has(params.session.key)) {
    return state.cards.find((card) => workboardCardSessionKey(card) === params.session.key) ?? null;
  }
  state.error = null;
  let captureStarted = false;
  try {
    if (!state.loaded) {
      await waitForWorkboardLifecycleWrites(params.host);
      await loadWorkboard({
        host: params.host,
        client: params.client,
        requestUpdate: params.requestUpdate,
        force: true,
      });
    }
    if (!state.loaded || state.dispatching) {
      return null;
    }
    if (state.capturingSessionKeys.has(params.session.key)) {
      return (
        state.cards.find((card) => workboardCardSessionKey(card) === params.session.key) ?? null
      );
    }
    state.capturingSessionKeys.add(params.session.key);
    captureStarted = true;
    params.requestUpdate?.();
    const existing = state.cards.find(
      (card) => workboardCardSessionKey(card) === params.session.key,
    );
    if (existing) {
      if (existing.metadata?.archivedAt) {
        invalidateWorkboardLoads(params.host);
        const payload = await params.client.request("workboard.cards.archive", {
          id: existing.id,
          archived: false,
        });
        const restored = normalizeCardPayload(payload);
        replaceCard(state, restored);
        return restored;
      }
      return existing;
    }
    const messages = await loadSessionCaptureHistory({
      client: params.client,
      sessionKey: params.session.key,
    });
    const recentUserText = extractChatHistoryText(messages, "user", "last");
    const lastAssistantText = extractChatHistoryText(messages, "assistant", "last");
    invalidateWorkboardLoads(params.host);
    const payload = await params.client.request("workboard.cards.create", {
      title: sessionTitle(params.session, recentUserText),
      notes: buildSessionCaptureNotes({
        session: params.session,
        recentUserText,
        lastAssistantText,
      }),
      status: sessionCaptureStatus(params.session),
      priority: "normal",
      agentId: "",
      sessionKey: params.session.key,
    });
    const card = normalizeCardPayload(payload);
    replaceCard(state, card);
    return card;
  } catch (error) {
    state.error = formatError(error);
    return null;
  } finally {
    if (captureStarted) {
      state.capturingSessionKeys.delete(params.session.key);
      params.requestUpdate?.();
    }
  }
}

async function refreshWorkboardLifecycleTasks(
  params: {
    host: WorkboardHost;
    client: GatewayBrowserClient;
    requestUpdate?: () => void;
  },
  state: WorkboardUiState,
): Promise<number | null> {
  const existingRefresh = workboardLifecycleTaskRefreshPromises.get(params.host);
  if (existingRefresh) {
    return await existingRefresh;
  }
  const refresh = (async () => {
    const generation = nextWorkboardLoadGeneration(params.host);
    try {
      const previousTasksByCardId = state.tasksByCardId;
      const confirmationNow = Date.now();
      const confirmationExpired =
        state.lifecycleTaskConfirmationStartedAt !== null &&
        confirmationNow - state.lifecycleTaskConfirmationStartedAt >=
          WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_WINDOW_MS;
      if (state.lifecycleTaskRefreshContinueAt !== null && confirmationExpired) {
        resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
        setWorkboardLifecycleTaskRefreshFailed(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        state.lifecycleTaskRefreshError = WORKBOARD_LIFECYCLE_TASK_CONFIRMATION_TIMEOUT_ERROR;
        params.requestUpdate?.();
        return null;
      }
      if (state.lifecycleTaskConfirmationStartedAt === null || confirmationExpired) {
        resetWorkboardLifecycleTaskConfirmations(state);
        state.lifecycleTaskConfirmationStartedAt = confirmationNow;
      }
      const previouslyConfirmedTasks = [...previousTasksByCardId.values()].filter((task) =>
        state.lifecycleConfirmedTaskIds.has(task.taskId),
      );
      const taskLinkState: WorkboardTaskLinkState = {
        cards: state.cards,
        tasksByCardId: new Map(),
        missingTaskIds: new Set(state.missingTaskIds),
      };
      const taskSummaries = await listWorkboardTasks(params.client);
      const confirmationResult = await getWorkboardTaskPollBatch(
        params.client,
        selectWorkboardMissingTaskConfirmationIds(
          params.host,
          taskLinkState.cards,
          taskSummaries,
          taskLinkState.missingTaskIds,
          previousTasksByCardId,
          state.lifecycleConfirmedTaskIds,
        ),
        [],
      );
      const previousTasksToPreserve = confirmationResult.error
        ? taskLinkState.cards.flatMap((card) => {
            const task = previousTasksByCardId.get(card.id);
            return task &&
              !confirmationResult.missingTaskIds.has(task.taskId) &&
              taskMatchesTrackedCardLink(task, card, taskLinkState.missingTaskIds)
              ? [task]
              : [];
          })
        : [];
      applyTaskSummariesToState(
        taskLinkState,
        [
          ...taskSummaries,
          ...previouslyConfirmedTasks,
          ...confirmationResult.tasks,
          ...previousTasksToPreserve,
        ],
        { missingTaskIds: confirmationResult.missingTaskIds },
      );
      if (
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        workboardLifecycleSyncBlocked(params.host, state)
      ) {
        return null;
      }
      state.cards = taskLinkState.cards;
      state.tasksByCardId = taskLinkState.tasksByCardId;
      state.missingTaskIds = taskLinkState.missingTaskIds;
      for (const task of confirmationResult.tasks) {
        state.lifecycleConfirmedTaskIds.add(task.taskId);
      }
      for (const taskId of confirmationResult.missingTaskIds) {
        state.lifecycleConfirmedTaskIds.add(taskId);
      }
      if (confirmationResult.error) {
        resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
        setWorkboardLifecycleTaskRefreshFailed(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        state.lifecycleTaskRefreshError = confirmationResult.error;
        params.requestUpdate?.();
        return null;
      }
      if (!workboardTaskLinksReadyForLifecycle(taskLinkState)) {
        setWorkboardLifecycleTaskRefreshContinuation(state, true, {
          host: params.host,
          requestUpdate: params.requestUpdate,
        });
        return null;
      }
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      const recoveredTaskRefreshError = state.lifecycleTaskRefreshError;
      setWorkboardLifecycleTaskRefreshFailed(state, false, { host: params.host });
      state.lifecycleTaskRefreshError = null;
      if (
        recoveredTaskRefreshError !== null &&
        state.lastRefreshError === recoveredTaskRefreshError
      ) {
        state.lastRefreshError = null;
      }
      params.requestUpdate?.();
      return Date.now();
    } catch (error) {
      if (
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        workboardLifecycleSyncBlocked(params.host, state)
      ) {
        return null;
      }
      resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
      setWorkboardLifecycleTaskRefreshFailed(state, true, {
        host: params.host,
        requestUpdate: params.requestUpdate,
      });
      state.lifecycleTaskRefreshError = formatError(error);
      params.requestUpdate?.();
      return null;
    }
  })();
  workboardLifecycleTaskRefreshPromises.set(params.host, refresh);
  try {
    return await refresh;
  } finally {
    if (workboardLifecycleTaskRefreshPromises.get(params.host) === refresh) {
      workboardLifecycleTaskRefreshPromises.delete(params.host);
    }
  }
}

export async function syncWorkboardLifecycle(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  sessions: readonly GatewaySessionRow[];
  canWrite?: boolean;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const taskRefreshRetryPending = workboardLifecycleTaskRefreshRetryPending(state);
  const taskRefreshContinuationWaiting = workboardLifecycleTaskRefreshContinuationWaiting(state);
  if (
    !params.client ||
    !state.loaded ||
    ((taskRefreshRetryPending || taskRefreshContinuationWaiting) &&
      workboardLifecycleRequiresTaskRefresh(state)) ||
    workboardLifecycleSyncBlocked(params.host, state)
  ) {
    return;
  }
  const reconciliationEpoch = currentWorkboardLifecycleReconciliationEpoch(params.host);
  let tasksPreparedAt = workboardLifecycleTasksPreparedAt(state);
  const tasksPrepared = tasksPreparedAt !== null;
  setWorkboardLifecycleTasksPrepared(state, false, { host: params.host });
  if (
    !tasksPrepared &&
    !taskRefreshRetryPending &&
    !taskRefreshContinuationWaiting &&
    shouldRefreshWorkboardTasksForLifecycle(state)
  ) {
    tasksPreparedAt = await refreshWorkboardLifecycleTasks(
      {
        host: params.host,
        client: params.client,
        requestUpdate: params.requestUpdate,
      },
      state,
    );
    if (tasksPreparedAt === null && workboardLifecycleRequiresTaskRefresh(state)) {
      // A null result without a recorded failure means the shared refresh was
      // invalidated. Ask only the current, unblocked reconciliation to retry.
      if (
        !state.lifecycleTaskRefreshFailed &&
        isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) &&
        !workboardLifecycleSyncBlocked(params.host, state)
      ) {
        params.requestUpdate?.();
      }
      return;
    }
  }
  if (
    !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
    workboardLifecycleSyncBlocked(params.host, state)
  ) {
    return;
  }
  // Read-only operators still need task-refresh recovery. Gate only the
  // lifecycle card writeback after the shared task snapshot is current.
  if (params.canWrite === false) {
    setWorkboardLifecycleTasksPrepared(state, true, {
      host: params.host,
      preparedAt: tasksPreparedAt ?? Date.now(),
      requestUpdate: params.requestUpdate,
    });
    return;
  }
  const syncKeys = getLifecycleSyncKeys(params.host);
  let lifecycleWriteStarted = false;
  for (const card of state.cards) {
    if (
      !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
      workboardLifecycleSyncBlocked(params.host, state)
    ) {
      return;
    }
    const lifecycle = getWorkboardLifecycle(
      card,
      params.sessions,
      state.tasksByCardId.get(card.id),
    );
    const executionStatus = executionStatusForLifecycle(lifecycle);
    const patch: Record<string, unknown> = {};
    if (
      lifecycle.sourceUpdatedAt !== undefined &&
      !shouldSkipLifecycleStatusWrite(params.host, card, lifecycle) &&
      shouldSyncCardStatus(card, lifecycle.targetStatus)
    ) {
      patch.status = lifecycle.targetStatus;
      mergePatchMetadata(patch, {
        lifecycleStatusSourceUpdatedAt: lifecycle.sourceUpdatedAt,
      });
    }
    if (shouldSyncExecutionStatus(card, executionStatus)) {
      patch.execution = {
        ...card.execution,
        status: executionStatus,
        updatedAt: Date.now(),
      };
    }
    const stale = lifecycle.session ? staleSessionState(lifecycle.session) : undefined;
    const existingStale = card.metadata?.stale;
    if (stale) {
      const staleChanged =
        !existingStale ||
        existingStale.lastSessionUpdatedAt !== stale.lastSessionUpdatedAt ||
        existingStale.reason !== stale.reason;
      if (staleChanged) {
        mergePatchMetadata(patch, {
          stale: {
            ...stale,
            detectedAt: existingStale?.detectedAt ?? stale.detectedAt,
          },
        });
      }
    } else if (existingStale) {
      mergePatchMetadata(patch, {
        stale: null,
      });
    }
    if (Object.keys(patch).length === 0) {
      continue;
    }
    const key = lifecycleSyncKey(card, lifecycle);
    if (syncKeys.get(card.id) === key || state.syncingCardIds.has(card.id)) {
      continue;
    }
    const generation = nextWorkboardLoadGeneration(params.host);
    lifecycleWriteStarted = true;
    state.syncingCardIds.add(card.id);
    params.requestUpdate?.();
    let write: Promise<unknown> | null = null;
    try {
      write = params.client.request("workboard.cards.update", {
        id: card.id,
        patch,
      });
      trackWorkboardLifecycleWrite(params.host, write);
      const payload = await write;
      const currentCard = state.cards.find((candidate) => candidate.id === card.id);
      const responseCard = normalizeCardPayload(payload);
      // Lifecycle responses are full-card replacements. Any newer load or write
      // invalidates this generation so its response cannot replace fresher state.
      if (
        !currentCard ||
        !isCurrentWorkboardLoadGeneration(params.host, generation) ||
        !isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch) ||
        hasPendingStatusTransition(params.host, currentCard.id) ||
        (currentCard.status !== card.status && responseCard.status !== currentCard.status) ||
        (shouldSkipStaleLifecycleStatus(currentCard, lifecycle) &&
          responseCard.status !== currentCard.status)
      ) {
        continue;
      }
      replaceCard(state, responseCard);
      syncKeys.set(card.id, key);
    } catch (error) {
      if (isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)) {
        state.error = formatError(error);
        syncKeys.set(card.id, key);
      }
    } finally {
      if (write) {
        releaseWorkboardLifecycleWrite(params.host, write);
      }
      state.syncingCardIds.delete(card.id);
      if (
        isCurrentWorkboardLoadGeneration(params.host, generation) &&
        isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)
      ) {
        setWorkboardLifecycleTasksPrepared(state, true, {
          host: params.host,
          preparedAt: tasksPreparedAt ?? Date.now(),
          requestUpdate: params.requestUpdate,
        });
      }
      params.requestUpdate?.();
    }
  }
  if (
    !lifecycleWriteStarted &&
    isCurrentWorkboardLifecycleReconciliationEpoch(params.host, reconciliationEpoch)
  ) {
    setWorkboardLifecycleTasksPrepared(state, true, {
      host: params.host,
      preparedAt: tasksPreparedAt ?? Date.now(),
      requestUpdate: params.requestUpdate,
    });
  }
}

export async function createWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.create", draftPayload(state));
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function saveWorkboardCardDraft(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!state.editingCardId) {
    await createWorkboardCard(params);
    return;
  }
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving ||
    state.busyCardIds.has(state.editingCardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  const cardId = state.editingCardId;
  const pendingStatusRecorded = recordPendingStatusTransition(
    params.host,
    state.cards.find((card) => card.id === cardId),
    state.draftStatus,
  );
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.update", {
      id: cardId,
      patch: draftPayload(state),
    });
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    clearPendingStatusTransition(params.host, cardId, pendingStatusRecorded);
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function addWorkboardCardComment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId?: string;
  body?: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const cardId = params.cardId ?? state.editingCardId;
  const body = (params.body ?? state.draftCommentBody).trim();
  if (
    !cardId ||
    !params.client ||
    !workboardMutationsReady(state) ||
    !body ||
    state.dispatching ||
    state.draftSaving ||
    state.busyCardIds.has(cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.comment", {
      id: cardId,
      body,
    });
    replaceCard(state, normalizeCardPayload(payload));
    if (params.body === undefined) {
      state.draftCommentBody = "";
    } else if (state.detailCardId === cardId) {
      state.detailCommentBody = "";
    }
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(cardId);
    params.requestUpdate?.();
  }
}

export async function moveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  status: WorkboardStatus;
  position: number;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  const pendingStatusRecorded = recordPendingStatusTransition(
    params.host,
    state.cards.find((card) => card.id === params.cardId),
    params.status,
  );
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.move", {
      id: params.cardId,
      status: params.status,
      position: params.position,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    clearPendingStatusTransition(params.host, params.cardId, pendingStatusRecorded);
    state.busyCardIds.delete(params.cardId);
    if (state.draggedCardId === params.cardId) {
      state.draggedCardId = null;
    }
    params.requestUpdate?.();
  }
}

export async function deleteWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    await params.client.request("workboard.cards.delete", { id: params.cardId });
    state.cards = removeCardAndReferences(state.cards, params.cardId);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function archiveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  archived?: boolean;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.archive", {
      id: params.cardId,
      archived: params.archived ?? true,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function dispatchWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    workboardHasActiveWrites(state)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.dispatching = true;
  state.error = null;
  state.lastDispatchSummary = null;
  params.requestUpdate?.();
  try {
    const dispatchResult = await params.client.request("workboard.cards.dispatch", {});
    const payload = await params.client.request("workboard.cards.list", {});
    const normalized = normalizeCardsPayload(payload);
    state.cards = normalized.cards;
    state.statuses = normalized.statuses;
    state.lastDispatchSummary = normalizeDispatchSummary(dispatchResult);
    state.tasksByCardId = new Map();
    resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
    try {
      applyTaskSummariesToState(state, await listWorkboardTasks(params.client));
      setWorkboardLifecycleTaskRefreshFailed(state, false, { host: params.host });
      state.lifecycleTaskRefreshError = null;
      state.lastRefreshError = null;
    } catch (error) {
      setWorkboardLifecycleTaskRefreshFailed(state, true, {
        host: params.host,
        requestUpdate: params.requestUpdate,
      });
      state.lastRefreshError = formatError(error);
    }
    // A teardown may have invalidated this in-flight dispatch. Keep its cached
    // result reload-required so reconnect cannot treat an old completion as canonical.
    state.loaded = workboardMutationsReady(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.dispatching = false;
    params.requestUpdate?.();
  }
}

function buildCardPrompt(card: WorkboardCard): string {
  const lines = [`Work on this OpenClaw Workboard card: ${card.title}`];
  if (card.notes?.trim()) {
    lines.push("", card.notes.trim());
  }
  if (card.labels.length > 0) {
    lines.push("", `Labels: ${card.labels.join(", ")}`);
  }
  const parents = card.metadata?.links
    ?.filter((link) => link.type === "parent" && link.targetCardId)
    .map((link) => link.targetCardId);
  if (parents?.length) {
    lines.push("", `Parents: ${parents.join(", ")}`);
  }
  if (card.metadata?.automation?.skills?.length) {
    lines.push("", `Suggested skills: ${card.metadata.automation.skills.join(", ")}`);
  }
  if (card.metadata?.automation?.workspace) {
    const workspace = card.metadata.automation.workspace;
    lines.push("", `Workspace: ${workspace.kind}${workspace.path ? ` ${workspace.path}` : ""}`);
  }
  lines.push("", "When done, summarize what changed and what remains.");
  return lines.join("\n");
}

function buildCardSessionLabel(card: WorkboardCard): string {
  const suffix = card.id.trim().slice(0, 8) || "card";
  const title = card.title.trim() || "Workboard card";
  const suffixText = ` (${suffix})`;
  if (title.length + suffixText.length <= WORKBOARD_SESSION_LABEL_MAX_CHARS) {
    return `${title}${suffixText}`;
  }
  const titleMax = WORKBOARD_SESSION_LABEL_MAX_CHARS - suffixText.length;
  return `${truncateUtf16Safe(title, titleMax - 3).trimEnd()}...${suffixText}`;
}

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function buildCardTaskSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(card.metadata?.automation?.boardId, "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  const sessionKey = card.agentId
    ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}`
    : suffix;
  const existing = workboardCardSessionKey(card)?.trim();
  return existing === sessionKey ? existing : sessionKey;
}

function buildCardRunIdempotencyKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(card.metadata?.automation?.boardId, "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  return `workboard:${boardId}:${cardId}:${card.updatedAt}`;
}

function isScheduledForLater(card: WorkboardCard, now = Date.now()): boolean {
  const scheduledAt = card.metadata?.automation?.scheduledAt;
  if (typeof scheduledAt === "number") {
    return scheduledAt > now;
  }
  return card.status === "scheduled";
}

function buildWorkboardExecution(params: {
  card: WorkboardCard;
  engine: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  sessionKey?: string | null;
  runId?: string;
  status: WorkboardExecutionStatus;
}): WorkboardExecution {
  const now = Date.now();
  return {
    id: params.card.execution?.id ?? `${params.card.id}:${params.engine}`,
    kind: "agent-session",
    engine: params.engine,
    mode: params.mode,
    status: params.status,
    model: WORKBOARD_ENGINE_MODELS[params.engine],
    startedAt: now,
    updatedAt: now,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

async function findTaskForStartedRun(params: {
  client: GatewayBrowserClient;
  card: WorkboardCard;
  sessionKey: string;
  runId?: string;
}): Promise<WorkboardTaskSummary | null> {
  const probeCard = {
    ...params.card,
    taskId: undefined,
    sessionKey: params.sessionKey,
    ...(params.runId ? { runId: params.runId } : {}),
  };
  for (const delayMs of [0, ...WORKBOARD_TASK_LOOKUP_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    let task: WorkboardTaskSummary | null = null;
    try {
      task =
        (await listWorkboardTasks(params.client))
          .filter((candidate) => taskMatchesCard(candidate, probeCard))
          .toSorted((left, right) => taskUpdatedAtValue(right) - taskUpdatedAtValue(left))[0] ??
        null;
    } catch {
      // Task registration/linkage is best effort after the run already started.
    }
    if (task) {
      return task;
    }
  }
  return null;
}

async function abortWorkboardSessionRun(params: {
  client: GatewayBrowserClient;
  sessionKey: string;
  runId?: string;
}): Promise<boolean> {
  let abortResult = await params.client.request("chat.abort", {
    sessionKey: params.sessionKey,
    ...(params.runId ? { runId: params.runId } : {}),
  });
  let aborted =
    isRecord(abortResult) &&
    (abortResult.aborted === true ||
      (Array.isArray(abortResult.runIds) && abortResult.runIds.length > 0));
  if (!aborted && params.runId) {
    abortResult = await params.client.request("chat.abort", {
      sessionKey: params.sessionKey,
    });
    aborted =
      isRecord(abortResult) &&
      (abortResult.aborted === true ||
        (Array.isArray(abortResult.runIds) && abortResult.runIds.length > 0));
  }
  return aborted;
}

function taskIsActive(task: WorkboardTaskSummary | undefined): task is WorkboardTaskSummary {
  return task?.status === "queued" || task?.status === "running";
}

async function cancelWorkboardTaskRun(params: {
  client: GatewayBrowserClient;
  taskId: string;
}): Promise<{ cancelled: boolean; missing: boolean; task: WorkboardTaskSummary | null }> {
  const result = await params.client.request("tasks.cancel", {
    taskId: params.taskId,
    reason: "Stopped from Workboard.",
  });
  return {
    cancelled: isRecord(result) && result.cancelled === true,
    missing: isRecord(result) && result.found === false,
    task: isRecord(result) ? normalizeTaskSummary(result.task) : null,
  };
}

export async function startWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  requestUpdate?: () => void;
}): Promise<string | null> {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id)
  ) {
    return null;
  }
  const engine = params.engine;
  const mode = params.mode ?? "autonomous";
  state.error = null;
  if (mode === "autonomous" && isScheduledForLater(params.card)) {
    state.error = "Scheduled cards cannot start before their scheduled time.";
    params.requestUpdate?.();
    return null;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  params.requestUpdate?.();
  let preflightCard: WorkboardCard | null = null;
  let createdSessionKey: string | null = null;
  let createdRunId: string | undefined;
  try {
    const shouldClearManualSchedule =
      mode === "manual" && params.card.metadata?.automation?.scheduledAt !== undefined;
    const shouldUnscheduleManual = mode === "manual" && params.card.status === "scheduled";
    const nextCardStatus =
      mode === "autonomous" ? "running" : shouldUnscheduleManual ? "todo" : params.card.status;
    const nextExecutionStatus = mode === "autonomous" ? "running" : "idle";
    let card = params.card;
    if (mode === "autonomous") {
      const preflightPayload = await params.client.request("workboard.cards.update", {
        id: params.card.id,
        patch: { status: nextCardStatus },
      });
      preflightCard = normalizeCardPayload(preflightPayload);
      if (preflightCard) {
        replaceCard(state, preflightCard);
        card = preflightCard;
      }
    }
    const created =
      mode === "autonomous"
        ? await params.client.request("agent", {
            sessionKey: buildCardTaskSessionKey(card),
            ...(card.agentId ? { agentId: card.agentId } : {}),
            label: buildCardSessionLabel(card),
            ...(engine ? { model: WORKBOARD_ENGINE_MODELS[engine] } : {}),
            message: buildCardPrompt(card),
            deliver: false,
            bootstrapContextMode: "lightweight",
            idempotencyKey: buildCardRunIdempotencyKey(card),
          })
        : {
            key: await requestSessionCreate(params.client, {
              ...(card.agentId ? { agentId: card.agentId } : {}),
              label: buildCardSessionLabel(card),
              ...(engine ? { model: WORKBOARD_ENGINE_MODELS[engine] } : {}),
            }),
          };
    const sessionKey =
      isRecord(created) && typeof created.sessionKey === "string" && created.sessionKey.trim()
        ? created.sessionKey.trim()
        : isRecord(created) && typeof created.key === "string" && created.key.trim()
          ? created.key.trim()
          : mode === "autonomous"
            ? buildCardTaskSessionKey(card)
            : null;
    const runId =
      isRecord(created) && typeof created.runId === "string" && created.runId.trim()
        ? created.runId.trim()
        : undefined;
    if (mode === "autonomous" && !runId) {
      throw new Error("Gateway agent method returned an invalid runId.");
    }
    createdSessionKey = sessionKey;
    createdRunId = runId;
    const task =
      mode === "autonomous" && sessionKey
        ? await findTaskForStartedRun({
            client: params.client,
            card,
            sessionKey,
            runId,
          })
        : null;
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: {
        status: nextCardStatus,
        ...(shouldClearManualSchedule ? { scheduledAt: null } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        runId: runId ?? null,
        taskId: task?.taskId ?? null,
        ...(engine
          ? {
              execution: buildWorkboardExecution({
                card,
                engine,
                mode,
                sessionKey,
                runId,
                status: nextExecutionStatus,
              }),
            }
          : { execution: null }),
      },
    });
    replaceCard(state, normalizeCardPayload(payload));
    if (task) {
      state.tasksByCardId.set(params.card.id, task);
    } else {
      state.tasksByCardId.delete(params.card.id);
    }
    return sessionKey;
  } catch (error) {
    if (mode === "autonomous" && createdSessionKey) {
      try {
        await abortWorkboardSessionRun({
          client: params.client,
          sessionKey: createdSessionKey,
          runId: createdRunId,
        });
      } catch {
        // Preserve the card-start failure; the user-facing repair is the rollback below.
      }
    }
    if (preflightCard) {
      try {
        const rollbackPayload = await params.client.request("workboard.cards.update", {
          id: params.card.id,
          patch: {
            status: params.card.status,
            startedAt: params.card.startedAt ?? null,
            completedAt: params.card.completedAt ?? null,
            ...(params.card.execution !== undefined ? { execution: params.card.execution } : {}),
          },
        });
        replaceCard(state, normalizeCardPayload(rollbackPayload) ?? params.card);
      } catch {
        replaceCard(state, params.card);
      }
    }
    state.error = formatError(error);
    return null;
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}

export async function stopWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const sessionKey = workboardCardSessionKey(params.card);
  const task = state.tasksByCardId.get(params.card.id);
  const cardTaskId = normalizeString(params.card.taskId);
  const taskId = cardTaskId && !state.missingTaskIds.has(cardTaskId) ? cardTaskId : task?.taskId;
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id) ||
    (!sessionKey && !taskId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  state.error = null;
  params.requestUpdate?.();
  try {
    let taskStopped = false;
    if (taskId && (!task || taskIsActive(task))) {
      try {
        const cancelled = await cancelWorkboardTaskRun({
          client: params.client,
          taskId,
        });
        if (cancelled.missing) {
          state.missingTaskIds.add(taskId);
          if (task?.taskId === taskId || task?.id === taskId) {
            state.tasksByCardId.delete(params.card.id);
          }
          taskStopped = !sessionKey;
        } else if (cancelled.cancelled) {
          taskStopped = true;
          state.tasksByCardId.set(
            params.card.id,
            cancelled.task ?? {
              ...(task ?? { id: taskId, taskId }),
              status: "cancelled",
              updatedAt: Date.now(),
            },
          );
        }
      } catch (error) {
        if (!isMissingTaskLookupError(error, taskId)) {
          throw error;
        }
        state.missingTaskIds.add(taskId);
        if (task?.taskId === taskId || task?.id === taskId) {
          state.tasksByCardId.delete(params.card.id);
        }
        taskStopped = !sessionKey;
      }
    }
    let sessionAborted = false;
    if (sessionKey) {
      try {
        sessionAborted = await abortWorkboardSessionRun({
          client: params.client,
          sessionKey,
          runId: workboardCardRunId(params.card),
        });
      } catch (error) {
        if (!taskStopped) {
          throw error;
        }
      }
    }
    if (!taskStopped && !sessionAborted) {
      return;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: {
        status: "blocked",
        ...(params.card.execution
          ? {
              execution: {
                ...params.card.execution,
                status: "blocked",
                updatedAt: Date.now(),
              },
            }
          : {}),
      },
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}

export function findWorkboardSession(
  card: WorkboardCard,
  sessions: readonly GatewaySessionRow[],
): GatewaySessionRow | null {
  const sessionKey = workboardCardSessionKey(card);
  if (!sessionKey) {
    return null;
  }
  return sessions.find((session) => session.key === sessionKey) ?? null;
}
