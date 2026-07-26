import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardPriority,
  WorkboardStatus,
  WorkboardTemplateId,
} from "@openclaw/workboard-contract";
import type { GatewaySessionRow } from "../../api/types.ts";

export * from "@openclaw/workboard-contract";
export type { WorkboardBoardSummary } from "@openclaw/workboard-contract";

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

export type WorkboardRefreshSource = "initial" | "manual" | "live";

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
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
  tasksByCardId: Map<string, WorkboardTaskSummary>;
  missingTaskIds: Set<string>;
  lastDispatchSummary: WorkboardDispatchSummary | null;
  dispatching: boolean;
  query: string;
  priorityFilter: "all" | WorkboardPriority;
  agentFilter: string;
  boardFilter: string;
  viewPreset: WorkboardViewPresetId;
  activeHealthHighlight: WorkboardHealthKey | null;
  showArchived: boolean;
  layout: "comfortable" | "compact";
  hideEmptyColumns: boolean;
  lastRefreshAt: number | null;
  lastRefreshStartedAt: number | null;
  lastRefreshError: string | null;
  lastRefreshSource: WorkboardRefreshSource | null;
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
