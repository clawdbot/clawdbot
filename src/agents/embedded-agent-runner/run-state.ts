import type { SessionPermissionMode } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
/**
 * Shared process-local state for active and abandoned embedded-agent runs.
 */
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyBackendQueueMessageResult,
  ReplyBackendMessageInjection,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { DiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/**
 * Shared process state for embedded-agent runs, queues, and snapshots.
 *
 * The maps are global-singleton backed so reloads and lazy imports inside the same gateway process
 * do not split active-run bookkeeping.
 */
export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  runId?: string;
  /** Exact process-local diagnostic lifecycle shared with this handle's model wrapper. */
  readonly diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  /** Synchronously closes diagnostic authority before this handle is evicted. */
  readonly closeDiagnostics?: () => void;
  /** Core run start time used by live recovery projections. */
  startedAtMs?: number;
  /** Exact authority of the concrete provider/model attempt behind this handle. */
  toolAuthorityFingerprint?: string;
  /** Shared outer-run owner survives an intentional native-turn replacement. */
  permissionChangeOwner?: object;
  /** Fences prior tools, revokes their approvals, then acknowledges installed permissions. */
  applyPermissionMode?: (
    mode: SessionPermissionMode | null,
    revokeApprovals: () => void,
  ) => Promise<boolean>;
  /** Atomically consumes one plain-text answer for this run's pending user-input request. */
  claimPendingUserInputAnswer?: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<boolean>;
  /** Cancels this run's pending user-input request before an image is queued as a later turn. */
  cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean>;
  /** Exact heartbeat owner retained after its reply-operation registration clears. */
  readonly preemptByVisibleTurn?: () => boolean;
  queueMessage: (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => Promise<void | EmbeddedAgentQueueMessageResult>;
  messageInjection?: ReplyBackendMessageInjection;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  /** True after this handle has accepted an abort, even while cleanup retains it. */
  isAborted?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  /** True only when queueMessage preserves images supplied in its options. */
  supportsQueueMessageImages?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
};

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type EmbeddedAgentQueueMessageResult = ReplyBackendQueueMessageResult;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

export type EmbeddedRunRegistration = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  delegatedAuthority?: AgentRunDelegatedAuthority;
  humanInputWaits?: Set<() => boolean>;
  onHumanInputResolved?: () => void;
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  handle?: EmbeddedAgentQueueHandle;
  timer?: NodeJS.Timeout;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  abandonedAtMs: number;
  reason: "timeout";
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunsByRunId: new Map<string, EmbeddedAgentQueueHandle>(),
  activeRunRegistrations: new WeakMap<EmbeddedAgentQueueHandle, EmbeddedRunRegistration>(),
  activeRunLifecycleGenerations: new WeakMap<EmbeddedAgentQueueHandle, string>(),
  retainedAbortabilityRunIds: new Set<string>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  // The exact handle owns forced cleanup so a stale session id cannot release a replacement turn.
  forcedTerminalSettlements: new WeakMap<EmbeddedAgentQueueHandle, () => Promise<void>>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));

export const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedAgentQueueHandle>());
export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID =
  embeddedRunState.activeRunsByRunId ??
  (embeddedRunState.activeRunsByRunId = new Map<string, EmbeddedAgentQueueHandle>());
export const ACTIVE_EMBEDDED_RUN_REGISTRATIONS =
  embeddedRunState.activeRunRegistrations ??
  (embeddedRunState.activeRunRegistrations = new WeakMap<
    EmbeddedAgentQueueHandle,
    EmbeddedRunRegistration
  >());

/** Only an accepted question's exact admitted owner may suppress stale-work recovery. */
export function registerActiveEmbeddedRunHumanInputWait(
  authority: AgentRunDelegatedAuthority,
  isPending: () => boolean,
): ((resolved: boolean) => void) | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(authority.operationalRunInstance.runId);
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  if (
    !handle ||
    !registration ||
    ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) !== handle ||
    !validateAgentRunDelegatedAuthority(authority) ||
    registration.delegatedAuthority !==
      getActiveAgentRunDelegatedAuthority(authority.operationalRunInstance)
  ) {
    return undefined;
  }
  const waits = (registration.humanInputWaits ??= new Set());
  waits.add(isPending);
  return (resolved) => {
    if (
      waits.delete(isPending) &&
      resolved &&
      ACTIVE_EMBEDDED_RUNS.get(registration.sessionId) === handle &&
      validateAgentRunDelegatedAuthority(authority) &&
      !handle.isAborted?.()
    ) {
      registration.onHumanInputResolved?.();
    }
  };
}

/** Re-read at the recovery action, including after queued/lazy recovery dispatch. */
export function resolveActiveEmbeddedRunRecoveryBlocker(
  sessionId: string,
  expectedHandle?: object,
): "human_input_wait" | "stale_session_state" | undefined {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (expectedHandle && handle !== expectedHandle) {
    return "stale_session_state";
  }
  const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
  const authority = registration?.delegatedAuthority;
  if (!handle || !authority || !registration.humanInputWaits) {
    return undefined;
  }
  for (const isPending of registration.humanInputWaits) {
    // Question validation can synchronously close authority or replace the run.
    const pending = isPending() && !handle.isAborted?.();
    if (
      ACTIVE_EMBEDDED_RUNS.get(sessionId) !== handle ||
      !registration.humanInputWaits.has(isPending)
    ) {
      return "stale_session_state";
    }
    if (pending && validateAgentRunDelegatedAuthority(authority)) {
      return "human_input_wait";
    }
  }
  return undefined;
}
const ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS =
  embeddedRunState.activeRunLifecycleGenerations ??
  (embeddedRunState.activeRunLifecycleGenerations = new WeakMap<
    EmbeddedAgentQueueHandle,
    string
  >());
export const RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS =
  embeddedRunState.retainedAbortabilityRunIds ??
  (embeddedRunState.retainedAbortabilityRunIds = new Set<string>());
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.sessionIdsByFile ??
  (embeddedRunState.sessionIdsByFile = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID =
  embeddedRunState.abandonedRunsBySessionId ??
  (embeddedRunState.abandonedRunsBySessionId = new Map<string, AbandonedEmbeddedRun>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.abandonedRunSessionIdsByKey ??
  (embeddedRunState.abandonedRunSessionIdsByKey = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.abandonedRunSessionIdsByFile ??
  (embeddedRunState.abandonedRunSessionIdsByFile = new Map<string, string>());
export const EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS =
  embeddedRunState.forcedTerminalSettlements ??
  (embeddedRunState.forcedTerminalSettlements = new WeakMap<
    EmbeddedAgentQueueHandle,
    () => Promise<void>
  >());
export const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());

function evictPriorLifecycleEmbeddedRuns(): void {
  const staleHandles = new Set<EmbeddedAgentQueueHandle>();
  for (const [sessionId, handle] of ACTIVE_EMBEDDED_RUNS) {
    const lifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)?.humanInputWaits?.clear();
    staleHandles.add(handle);
    if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
      ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    }
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
  }
  for (const [runId, handle] of ACTIVE_EMBEDDED_RUNS_BY_RUN_ID) {
    const lifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
    if (lifecycleGeneration && isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
      continue;
    }
    handle.closeDiagnostics?.();
    staleHandles.add(handle);
    // This index only gates the separately owned chat abort controller; absence
    // is abortable. Keeping it would let stale ownership influence new work.
    if (ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(runId) === handle) {
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.delete(runId);
      RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.delete(runId);
    }
  }
  for (const [sessionKey, sessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(sessionKey);
    }
  }
  for (const [sessionFile, sessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.delete(sessionFile);
    }
  }
  for (const [sessionId, waiters] of EMBEDDED_RUN_WAITERS) {
    if (ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      continue;
    }
    EMBEDDED_RUN_WAITERS.delete(sessionId);
    for (const waiter of waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(true);
    }
  }
  const abortErrors: unknown[] = [];
  // Remove stale ownership first so synchronous abort callbacks may register a
  // replacement without the cleanup above erasing that current-generation run.
  for (const handle of staleHandles) {
    try {
      handle.abort("restart");
    } catch (error) {
      abortErrors.push(error);
    }
  }
  if (abortErrors.length > 0) {
    throw new AggregateError(abortErrors, "Failed to abort stale embedded agent runs");
  }
}

registerAgentEventLifecycleRotationHandler("embedded-agent-runs", evictPriorLifecycleEmbeddedRuns);

export function setActiveEmbeddedRunLifecycleGeneration(
  handle: EmbeddedAgentQueueHandle,
  lifecycleGeneration: string,
): string {
  // A delayed re-registration must not transfer an old driver into the new
  // Gateway lifecycle and suppress orphan recovery again.
  const existingLifecycleGeneration = ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.get(handle);
  if (existingLifecycleGeneration !== undefined) {
    return existingLifecycleGeneration;
  }
  ACTIVE_EMBEDDED_RUN_LIFECYCLE_GENERATIONS.set(handle, lifecycleGeneration);
  return lifecycleGeneration;
}
