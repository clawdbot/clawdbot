import {
  abortActiveReplyRuns,
  abortReplyRunBySessionId,
  getActiveReplyRunCount,
  isReplyRunActiveForSessionId,
  isReplyRunStreamingForSessionId,
  listActiveReplyRunSessionIds,
  queueReplyRunMessage,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export type EmbeddedPiQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: () => void;
};

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

export type EmbeddedRunModelSwitchRequest = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

/**
 * Use global singleton state so busy/streaming checks stay consistent even
 * when the bundler emits multiple copies of this module into separate chunks.
 */
const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedPiQueueHandle>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
  modelSwitchRequests: new Map<string, EmbeddedRunModelSwitchRequest>(),
}));
const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedPiQueueHandle>());
const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());
const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS =
  embeddedRunState.modelSwitchRequests ??
  (embeddedRunState.modelSwitchRequests = new Map<string, EmbeddedRunModelSwitchRequest>());

function setActiveRunSessionKey(sessionKey: string | undefined, sessionId: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(normalizedSessionKey, sessionId);
}

function clearActiveRunSessionKeys(sessionId: string, sessionKey?: string): void {
  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionKey) {
    if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
    }
    return;
  }
  for (const [key, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) {
    if (activeSessionId === sessionId) {
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(key);
    }
  }
}

export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    const queuedReplyRunMessage = queueReplyRunMessage(sessionId, text);
    if (queuedReplyRunMessage) {
      logMessageQueued({ sessionId, source: "pi-embedded-runner" });
      return true;
    }
    diag.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  if (!handle.isStreaming()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
    return false;
  }
  if (handle.isCompacting()) {
    diag.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
    return false;
  }
  logMessageQueued({ sessionId, source: "pi-embedded-runner" });
  void handle.queueMessage(text);
  return true;
}

/**
 * Abort embedded PI runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export function abortEmbeddedPiRun(sessionId: string): boolean;
export function abortEmbeddedPiRun(
  sessionId: undefined,
  opts: { mode: "all" | "compacting" },
): boolean;
export function abortEmbeddedPiRun(
  sessionId?: string,
  opts?: { mode?: "all" | "compacting" },
): boolean {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
    if (!handle) {
      if (abortReplyRunBySessionId(sessionId)) {
        return true;
      }
      diag.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
      return false;
    }
    diag.debug(`aborting run: sessionId=${sessionId}`);
    try {
      handle.abort();
    } catch (err) {
      diag.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
      return false;
    }
    return true;
  }

  const mode = opts?.mode;
  if (mode === "compacting") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      if (!handle.isCompacting()) {
        continue;
      }
      diag.debug(`aborting compacting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return abortActiveReplyRuns({ mode }) || aborted;
  }

  if (mode === "all") {
    let aborted = false;
    for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
      diag.debug(`aborting run: sessionId=${id}`);
      try {
        handle.abort();
        aborted = true;
      } catch (err) {
        diag.warn(`abort failed: sessionId=${id} err=${String(err)}`);
      }
    }
    return abortActiveReplyRuns({ mode }) || aborted;
  }

  return false;
}

export function isEmbeddedPiRunActive(sessionId: string): boolean {
  const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId);
  if (active) {
    diag.debug(`run active check: sessionId=${sessionId} active=true`);
  }
  return active;
}

export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  if (!handle) {
    return isReplyRunStreamingForSessionId(sessionId);
  }
  return handle.isStreaming();
}

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

export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

export function getActiveEmbeddedRunSnapshot(
  sessionId: string,
): ActiveEmbeddedRunSnapshot | undefined {
  return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}

export function requestEmbeddedRunModelSwitch(
  sessionId: string,
  request: EmbeddedRunModelSwitchRequest,
): boolean {
  const normalizedSessionId = sessionId.trim();
  const provider = request.provider.trim();
  const model = request.model.trim();
  if (!normalizedSessionId || !provider || !model) {
    return false;
  }
  EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.set(normalizedSessionId, {
    provider,
    model,
    authProfileId: normalizeOptionalString(request.authProfileId),
    authProfileIdSource: normalizeOptionalString(request.authProfileId)
      ? request.authProfileIdSource
      : undefined,
  });
  diag.debug(
    `model switch requested: sessionId=${normalizedSessionId} provider=${provider} model=${model}`,
  );
  return true;
}

export function consumeEmbeddedRunModelSwitch(
  sessionId: string,
): EmbeddedRunModelSwitchRequest | undefined {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return undefined;
  }
  const request = EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.get(normalizedSessionId);
  if (request) {
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(normalizedSessionId);
  }
  return request;
}

/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight runs can release session write locks before
 * the next lifecycle starts. If no timeout is passed, waits indefinitely.
 */
export async function waitForActiveEmbeddedRuns(
  timeoutMs?: number,
  opts?: { pollMs?: number },
): Promise<{ drained: boolean }> {
  const pollMsRaw = opts?.pollMs ?? 250;
  const pollMs = Math.max(10, Math.floor(pollMsRaw));
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    return { drained: getActiveEmbeddedRunCount() === 0 };
  }
  const maxWaitMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(pollMs, Math.floor(timeoutMs))
      : undefined;

  const startedAt = Date.now();
  while (true) {
    if (getActiveEmbeddedRunCount() === 0) {
      return { drained: true };
    }
    const elapsedMs = Date.now() - startedAt;
    if (maxWaitMs !== undefined && elapsedMs >= maxWaitMs) {
      diag.warn(
        `wait for active embedded runs timed out: activeRuns=${getActiveEmbeddedRunCount()} timeoutMs=${maxWaitMs}`,
      );
      return { drained: false };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId) {
    return Promise.resolve(true);
  }
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  }
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: EmbeddedRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            EMBEDDED_RUN_WAITERS.delete(sessionId);
          }
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyEmbeddedRunEnded(sessionId: string) {
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  EMBEDDED_RUN_WAITERS.delete(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
  ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
  setActiveRunSessionKey(sessionKey, sessionId);
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
  }
}

export function updateActiveEmbeddedRunSnapshot(
  sessionId: string,
  snapshot: ActiveEmbeddedRunSnapshot,
) {
  if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
    return;
  }
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}

export function clearActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedPiQueueHandle,
  sessionKey?: string,
) {
  if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
    ACTIVE_EMBEDDED_RUNS.delete(sessionId);
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(sessionId);
    clearActiveRunSessionKeys(sessionId, sessionKey);
    logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
    }
    notifyEmbeddedRunEnded(sessionId);
  } else {
    diag.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}

export const __testing = {
  resetActiveEmbeddedRuns() {
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.clear();
  },
};
