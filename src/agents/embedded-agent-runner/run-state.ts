/**
 * Shared process-local state for active and abandoned embedded-agent runs.
 */
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../auto-reply/get-reply-options.types.js";
import {
  getActiveReplyRunCount,
  listActiveReplyRunSessionKeys,
  listActiveReplyRunSessionIds,
  resolveActiveReplyRunSessionId,
  type ReplyBackendQueueMessageOptions,
} from "../../auto-reply/reply/reply-run-registry.js";
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
  queueMessage: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isStopped?: () => boolean;
  isAbortable?: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
};

export type EmbeddedAgentQueueMessageOptions = ReplyBackendQueueMessageOptions;

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
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
  retainedAbortabilityRunIds: new Set<string>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
}));

export const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedAgentQueueHandle>());
export const ACTIVE_EMBEDDED_RUNS_BY_RUN_ID =
  embeddedRunState.activeRunsByRunId ??
  (embeddedRunState.activeRunsByRunId = new Map<string, EmbeddedAgentQueueHandle>());
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
export const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());

/** Counts active embedded runs while including auto-reply registry runs for shared sessions. */
export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

/** Lists active embedded-run session keys from both embedded and auto-reply registries. */
export function listActiveEmbeddedRunSessionKeys(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(),
      ...listActiveReplyRunSessionKeys(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Lists active embedded-run session ids from all embedded-run lookup maps. */
export function listActiveEmbeddedRunSessionIds(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUNS.keys(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.values(),
      ...listActiveReplyRunSessionIds(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Resolves the current session id for an active run after resets or compaction. */
export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return (
    resolveActiveReplyRunSessionId(normalizedSessionKey) ??
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
  );
}
