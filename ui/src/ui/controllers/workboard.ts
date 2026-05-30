import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow } from "../types.ts";

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
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "proof_added",
  "artifact_added",
  "diagnostic",
  "notification",
  "dispatch",
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

export const WORKBOARD_ENGINE_MODELS = {
  codex: "openai/gpt-5.5",
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

export type WorkboardClaim = {
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
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
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

export type WorkboardLifecycleState =
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
};

export type WorkboardUiState = {
  loading: boolean;
  loaded: boolean;
  loadAttempted: boolean;
  error: string | null;
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
  query: string;
  priorityFilter: "all" | WorkboardPriority;
  draftOpen: boolean;
  editingCardId: string | null;
  draftTitle: string;
  draftNotes: string;
  draftStatus: WorkboardStatus;
  draftPriority: WorkboardPriority;
  draftLabels: string;
  draftAgentId: string;
  draftSessionKey: string;
  draftTemplateId: WorkboardTemplateId | "";
  busyCardId: string | null;
  draggedCardId: string | null;
  syncingCardIds: Set<string>;
  capturingSessionKeys: Set<string>;
  gameOpen: boolean;
  gamePlayerIndex: number;
  gameMoves: number;
  gameWins: number;
  gameMessage: string;
};

type WorkboardHost = object;

const workboardStates = new WeakMap<WorkboardHost, WorkboardUiState>();
const workboardLoadPromises = new WeakMap<WorkboardHost, Promise<void>>();
const SESSION_CAPTURE_HISTORY_LIMIT = 40;
const SESSION_CAPTURE_HISTORY_MAX_CHARS = 6000;
const SESSION_CAPTURE_TEXT_MAX_CHARS = 700;
const WORKBOARD_CAPTURE_TITLE_MAX_CHARS = 180;
const WORKBOARD_SESSION_LABEL_MAX_CHARS = 512;
const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;

function createDefaultState(): WorkboardUiState {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    error: null,
    cards: [],
    statuses: WORKBOARD_STATUSES,
    query: "",
    priorityFilter: "all",
    draftOpen: false,
    editingCardId: null,
    draftTitle: "",
    draftNotes: "",
    draftStatus: "todo",
    draftPriority: "normal",
    draftLabels: "",
    draftAgentId: "",
    draftSessionKey: "",
    draftTemplateId: "",
    busyCardId: null,
    draggedCardId: null,
    syncingCardIds: new Set(),
    capturingSessionKeys: new Set(),
    gameOpen: false,
    gamePlayerIndex: 0,
    gameMoves: 0,
    gameWins: 0,
    gameMessage: "workboard.gameStart",
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
  const metadata: WorkboardMetadata = {
    ...(attempts.length ? { attempts } : {}),
    ...(comments.length ? { comments } : {}),
    ...(links.length ? { links } : {}),
    ...(proof.length ? { proof } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(automation ? { automation } : {}),
    ...(claim?.ownerId && claim.claimedAt ? { claim } : {}),
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(notifications.length ? { notifications } : {}),
    ...(WORKBOARD_TEMPLATE_IDS.includes(value.templateId as WorkboardTemplateId)
      ? { templateId: value.templateId as WorkboardTemplateId }
      : {}),
    ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
    ...(stale ? { stale } : {}),
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

export async function loadWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || (!params.force && (state.loaded || state.loadAttempted))) {
    return;
  }
  const client = params.client;
  const existingLoad = workboardLoadPromises.get(params.host);
  if (existingLoad) {
    await existingLoad;
    return;
  }
  state.loadAttempted = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  const loadPromise = (async () => {
    try {
      const payload = await client.request("workboard.cards.list", {});
      const normalized = normalizeCardsPayload(payload);
      state.cards = normalized.cards;
      state.statuses = normalized.statuses;
      state.loaded = true;
    } catch (error) {
      state.error = formatError(error);
    } finally {
      state.loading = false;
      workboardLoadPromises.delete(params.host);
      params.requestUpdate?.();
    }
  })();
  workboardLoadPromises.set(params.host, loadPromise);
  await loadPromise;
}

function replaceCard(state: WorkboardUiState, card: WorkboardCard) {
  const next = state.cards.filter((existing) => existing.id !== card.id);
  next.push(card);
  state.cards = next.toSorted((left, right) => left.position - right.position);
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
): WorkboardLifecycle {
  const session = findWorkboardSession(card, sessions);
  if (!workboardCardSessionKey(card)) {
    return { session: null, state: "unlinked" };
  }
  if (!session) {
    return { session: null, state: "missing" };
  }
  if (staleSessionState(session)) {
    return { session, state: "stale", targetStatus: "running" };
  }
  if (session.hasActiveRun === true || session.status === "running") {
    return { session, state: "running", targetStatus: "running" };
  }
  if (session.abortedLastRun || isFailedSessionStatus(session.status)) {
    return { session, state: "failed", targetStatus: "blocked" };
  }
  if (session.status === "done") {
    return { session, state: "succeeded", targetStatus: "review" };
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
  return `${compact.slice(0, SESSION_CAPTURE_TEXT_MAX_CHARS - 3).trimEnd()}...`;
}

function clampSessionCaptureTitle(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= WORKBOARD_CAPTURE_TITLE_MAX_CHARS) {
    return compact;
  }
  return `${compact.slice(0, WORKBOARD_CAPTURE_TITLE_MAX_CHARS - 3).trimEnd()}...`;
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
  if (!params.client || params.session.kind === "global") {
    return null;
  }
  if (state.capturingSessionKeys.has(params.session.key)) {
    return state.cards.find((card) => workboardCardSessionKey(card) === params.session.key) ?? null;
  }
  state.error = null;
  state.capturingSessionKeys.add(params.session.key);
  params.requestUpdate?.();
  try {
    if (!state.loaded) {
      await loadWorkboard({
        host: params.host,
        client: params.client,
        requestUpdate: params.requestUpdate,
        force: true,
      });
    }
    if (!state.loaded) {
      return null;
    }
    const existing = state.cards.find(
      (card) => workboardCardSessionKey(card) === params.session.key,
    );
    if (existing) {
      if (existing.metadata?.archivedAt) {
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
    state.capturingSessionKeys.delete(params.session.key);
    params.requestUpdate?.();
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
  if (!params.client || !state.loaded || params.canWrite === false) {
    return;
  }
  const syncKeys = getLifecycleSyncKeys(params.host);
  for (const card of state.cards) {
    const lifecycle = getWorkboardLifecycle(card, params.sessions);
    const executionStatus = executionStatusForLifecycle(lifecycle);
    const patch: Record<string, unknown> = {};
    if (shouldSyncCardStatus(card, lifecycle.targetStatus)) {
      patch.status = lifecycle.targetStatus;
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
        patch.metadata = {
          stale: {
            ...stale,
            detectedAt: existingStale?.detectedAt ?? stale.detectedAt,
          },
        };
      }
    } else if (existingStale) {
      patch.metadata = {
        stale: null,
      };
    }
    if (Object.keys(patch).length === 0) {
      continue;
    }
    const key = lifecycleSyncKey(card, lifecycle);
    if (syncKeys.get(card.id) === key || state.syncingCardIds.has(card.id)) {
      continue;
    }
    state.syncingCardIds.add(card.id);
    params.requestUpdate?.();
    try {
      const payload = await params.client.request("workboard.cards.update", {
        id: card.id,
        patch,
      });
      replaceCard(state, normalizeCardPayload(payload));
      syncKeys.set(card.id, key);
    } catch (error) {
      state.error = formatError(error);
      syncKeys.set(card.id, key);
    } finally {
      state.syncingCardIds.delete(card.id);
      params.requestUpdate?.();
    }
  }
}

export async function createWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client || !state.draftTitle.trim()) {
    return;
  }
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
  if (!params.client || !state.draftTitle.trim()) {
    return;
  }
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.update", {
      id: state.editingCardId,
      patch: draftPayload(state),
    });
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.loading = false;
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
  if (!params.client) {
    return;
  }
  state.busyCardId = params.cardId;
  state.error = null;
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
    state.busyCardId = null;
    state.draggedCardId = null;
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
  if (!params.client) {
    return;
  }
  state.busyCardId = params.cardId;
  state.error = null;
  params.requestUpdate?.();
  try {
    await params.client.request("workboard.cards.delete", { id: params.cardId });
    state.cards = removeCardAndReferences(state.cards, params.cardId);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardId = null;
    params.requestUpdate?.();
  }
}

export async function archiveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!params.client) {
    return;
  }
  state.busyCardId = params.cardId;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.archive", {
      id: params.cardId,
      archived: true,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardId = null;
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
  return `${title.slice(0, titleMax - 3).trimEnd()}...${suffixText}`;
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

export async function startWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  requestUpdate?: () => void;
}): Promise<string | null> {
  const state = getWorkboardState(params.host);
  if (!params.client) {
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
  state.busyCardId = params.card.id;
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
    const created = await params.client.request("sessions.create", {
      ...(card.agentId ? { agentId: card.agentId } : {}),
      label: buildCardSessionLabel(card),
      ...(engine ? { model: WORKBOARD_ENGINE_MODELS[engine] } : {}),
      ...(mode === "autonomous" ? { message: buildCardPrompt(card) } : {}),
    });
    const sessionKey =
      isRecord(created) && typeof created.key === "string" && created.key.trim()
        ? created.key.trim()
        : null;
    const runId =
      isRecord(created) && typeof created.runId === "string" && created.runId.trim()
        ? created.runId.trim()
        : undefined;
    createdSessionKey = sessionKey;
    createdRunId = runId;
    const initialRunFailed =
      mode === "autonomous" && isRecord(created) && created.runStarted === false;
    if (initialRunFailed) {
      const payload = await params.client.request("workboard.cards.update", {
        id: params.card.id,
        patch: {
          status: "blocked",
          ...(sessionKey ? { sessionKey } : {}),
          ...(engine
            ? {
                execution: buildWorkboardExecution({
                  card,
                  engine,
                  mode,
                  sessionKey,
                  status: "blocked",
                }),
              }
            : { execution: null }),
        },
      });
      replaceCard(state, normalizeCardPayload(payload));
      const errorText =
        isRecord(created) && "runError" in created ? formatError(created.runError) : "";
      state.error =
        errorText && errorText !== "Unknown workboard error."
          ? `Agent run did not start: ${errorText}`
          : "Agent run did not start.";
      return sessionKey;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      patch: {
        status: nextCardStatus,
        ...(shouldClearManualSchedule ? { scheduledAt: null } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
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
    state.busyCardId = null;
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
  if (!params.client || !sessionKey) {
    return;
  }
  state.busyCardId = params.card.id;
  state.error = null;
  params.requestUpdate?.();
  try {
    const aborted = await abortWorkboardSessionRun({
      client: params.client,
      sessionKey,
      runId: workboardCardRunId(params.card),
    });
    if (!aborted) {
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
    state.busyCardId = null;
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
