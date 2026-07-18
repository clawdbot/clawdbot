// Gateway chat/agent abort tracking.
// Registers active run abort controllers and projects in-flight chat state.
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";
import {
  createChatAbortMarker,
  type ChatAbortMarker,
  type ChatRunPlanSnapshot,
} from "./server-chat-state.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  lifecycleGeneration?: string;
  agentId?: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
  /** Latest argument-free validation diagnostic for operator-initiated aborts. */
  toolErrorSummary?: string;
  /**
   * False for backend/internal agent runs that may share a session key but must
   * not be projected into operator chat surfaces.
   */
  controlUiVisible?: boolean;
  /**
   * Controls only the sessions.list active-run projection. Terminal lifecycle
   * clears this before chat.send settles, while the entry stays as the retry
   * idempotency guard until normal cleanup removes it.
   */
  projectSessionActive?: boolean;
  /** True after the terminal session-store update has completed. */
  projectSessionTerminalPersisted?: boolean;
  /** A terminal lifecycle event was observed and is awaiting persistence. */
  projectSessionTerminalPending?: boolean;
  /** Store timestamp expected from the observed terminal lifecycle event. */
  projectSessionTerminalObservedAt?: number;
  /** In-flight terminal session-store update used by restart shutdown. */
  projectSessionTerminalPersistence?: Promise<void>;
  /** Caller completion requested cleanup before terminal lifecycle persistence settled. */
  registrationCleanupRequested?: boolean;
  /** False after the owning reply run commits a terminal outcome. */
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  /** Runs once when this registration is actually removed. */
  onRemoved?: () => void;
  /**
   * Which RPC owns this registration. Absent (undefined) is treated as
   * `"chat-send"` so pre-existing callers that constructed entries without
   * a kind keep their behavior. Consumers that need "chat.send specifically
   * is active" must check `kind !== "agent"`, not just `.has(runId)`.
   */
  kind?: "chat-send" | "agent";
  /** Side questions stay independent from main-turn TUI session stops. */
  turnKind?: "main" | "btw";
};

export type RestartRecoveryCandidate = {
  runId: string;
  lifecycleGeneration: string;
  sessionKey: string;
  sessionId: string;
  observedAt?: number;
};

type RegisteredChatAbortController = {
  controller: AbortController;
  registered: boolean;
  entry?: ChatAbortControllerEntry;
  cleanup: (opts?: { force?: boolean }) => void;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

function createChatAbortSignalReason(stopReason: string | undefined): Error | undefined {
  if (stopReason === "restart") {
    return createAgentRunRestartAbortError();
  }
  if (stopReason !== "timeout") {
    return undefined;
  }
  const reason = new Error("chat run timed out");
  reason.name = "TimeoutError";
  return reason;
}

export function resolveChatRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
  minMs?: number;
  maxMs?: number;
}): number {
  const {
    now,
    timeoutMs,
    graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS,
    minMs = 2 * 60_000,
    maxMs = 24 * 60 * 60_000,
  } = params;
  const safeNow = asDateTimestampMs(now);
  if (safeNow === undefined) {
    return 0;
  }
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const targetDurationMs = boundedTimeoutMs + graceMs;
  const target = resolveExpiresAtMsFromDurationMs(targetDurationMs, { nowMs: safeNow });
  const min = resolveExpiresAtMsFromDurationMs(minMs, { nowMs: safeNow });
  const max = resolveExpiresAtMsFromDurationMs(maxMs, { nowMs: safeNow });
  if (target === undefined || min === undefined || max === undefined) {
    return 0;
  }
  return Math.min(max, Math.max(min, target));
}

export function resolveAgentRunExpiresAtMs(params: {
  now: number;
  timeoutMs: number;
  graceMs?: number;
}): number {
  const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
  return resolveChatRunExpiresAtMs({
    now: params.now,
    timeoutMs: params.timeoutMs,
    graceMs,
    minMs: graceMs,
    maxMs: Math.max(0, params.timeoutMs) + graceMs,
  });
}

export function registerChatAbortController(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  runId: string;
  sessionId: string;
  sessionKey?: string | null;
  agentId?: string;
  timeoutMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  controlUiVisible?: boolean;
  isAbortable?: (entry: ChatAbortControllerEntry) => boolean;
  onRemoved?: () => void;
  kind?: ChatAbortControllerEntry["kind"];
  turnKind?: ChatAbortControllerEntry["turnKind"];
  lifecycleGeneration?: string;
  now?: number;
  expiresAtMs?: number;
}): RegisteredChatAbortController {
  const controller = new AbortController();
  const cleanup = (opts?: { force?: boolean }) => {
    const entry = params.chatAbortControllers.get(params.runId);
    if (entry?.controller === controller) {
      if (opts?.force === true) {
        removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
        return;
      }
      entry.registrationCleanupRequested = true;
      // Terminal event handling owns final removal once the event has been
      // observed. Runs that never emitted a terminal event still clean up here.
      if (entry.projectSessionTerminalPending === true) {
        return;
      }
      const persistence = entry.projectSessionTerminalPersistence;
      if (persistence) {
        void persistence
          .then(() => {
            if (params.chatAbortControllers.get(params.runId)?.controller === controller) {
              removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
            }
          })
          .catch(() => {
            if (params.chatAbortControllers.get(params.runId)?.controller === controller) {
              removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
            }
          });
        return;
      }
      removeChatAbortControllerEntry(params.chatAbortControllers, params.runId, entry);
    }
  };

  if (!params.sessionKey || params.chatAbortControllers.has(params.runId)) {
    // Duplicate run ids keep their fresh controller for caller cancellation, but
    // do not replace the registered entry that owns active-run projection.
    return { controller, registered: false, cleanup };
  }

  const rawNow = params.now ?? Date.now();
  const now = resolveDateTimestampMs(rawNow, 0);
  const explicitExpiresAtMs =
    params.expiresAtMs === undefined ? undefined : (asDateTimestampMs(params.expiresAtMs) ?? 0);
  const entry: ChatAbortControllerEntry = {
    controller,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    lifecycleGeneration: params.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
    agentId: normalizeActiveAgentId(params.agentId),
    startedAtMs: now,
    expiresAtMs:
      explicitExpiresAtMs ??
      resolveChatRunExpiresAtMs({ now: rawNow, timeoutMs: params.timeoutMs }),
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    providerId: normalizeProviderIdForActiveRun(params.providerId),
    authProviderId: normalizeProviderIdForActiveRun(params.authProviderId),
    controlUiVisible: params.controlUiVisible,
    isAbortable: params.isAbortable,
    onRemoved: params.onRemoved,
    projectSessionActive: true,
    kind: params.kind,
    turnKind: params.turnKind,
  };
  params.chatAbortControllers.set(params.runId, entry);
  return { controller, registered: true, entry, cleanup };
}

function normalizeProviderIdForActiveRun(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeActiveAgentId(agentId: string | undefined): string | undefined {
  const trimmed = agentId?.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Snapshot the live assistant text of any in-flight run for a session+agent. Used
 * by chat.history so a run that kept streaming while the client was switched away
 * — whose deltas the gateway delivered to a delivery key this client is no longer
 * subscribed to — is restored on switch-back.
 *
 * Matches a run the same way sessions.list's active-run projection does: an abort
 * entry can hold the requested key while chat run state holds the canonical store
 * key, so accept a match on EITHER `requestedSessionKey` or `canonicalSessionKey`,
 * scoping the shared "global" session by agent. Only runs still projected active
 * (`projectSessionActive !== false`, matching sessions.list; the terminal lifecycle
 * flips it to false), not aborted, and visible chat-send runs are returned, so a
 * finalized run — already in persisted history — is not duplicated and hidden
 * agent runs cannot be adopted by chat clients that will not receive their final
 * events.
 */
export function resolveInFlightRunSnapshot(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatRunPlanSnapshots?: Map<string, ChatRunPlanSnapshot>;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): { runId: string; text: string; plan?: ChatRunPlanSnapshot } | undefined {
  const matchesKey = (entry: ChatAbortControllerEntry, key: string): boolean => {
    if (entry.sessionKey !== key) {
      return false;
    }
    if (key !== "global") {
      return true;
    }
    const requestedAgentId =
      normalizeActiveAgentId(params.agentId) ?? normalizeActiveAgentId(params.defaultAgentId);
    if (!requestedAgentId) {
      return false;
    }
    const runAgentId =
      normalizeActiveAgentId(entry.agentId) ?? normalizeActiveAgentId(params.defaultAgentId);
    return runAgentId === requestedAgentId;
  };
  // Some callers/tests run without populated run state; guard like
  // collectTrackedActiveSessionRuns so a missing map is a no-op, not a throw.
  if (!(params.chatAbortControllers instanceof Map)) {
    return undefined;
  }
  // Pick the newest matching run rather than the first iterated. If a fast
  // restart/retry/stale-controller race leaves two active entries for the same
  // (sessionKey, agentId), Map insertion order is not a meaningful selector;
  // the latest `startedAtMs` is the run a switching-back client wants, and the
  // runId tie-break keeps the choice deterministic when timestamps collide.
  let best: { runId: string; startedAtMs: number } | undefined;
  for (const [runId, entry] of params.chatAbortControllers) {
    // Active unless explicitly projected inactive — mirrors sessions.list's
    // collectTrackedActiveSessionRuns (`projectSessionActive !== false`), so a run
    // that indicator shows active is never silently dropped here.
    if (
      entry.projectSessionActive === false ||
      entry.controlUiVisible === false ||
      entry.controller.signal.aborted ||
      entry.kind === "agent"
    ) {
      continue;
    }
    if (
      !matchesKey(entry, params.requestedSessionKey) &&
      !matchesKey(entry, params.canonicalSessionKey)
    ) {
      continue;
    }
    const newer = best === undefined || entry.startedAtMs > best.startedAtMs;
    const tie = best !== undefined && entry.startedAtMs === best.startedAtMs && runId > best.runId;
    if (newer || tie) {
      best = { runId, startedAtMs: entry.startedAtMs };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  // Adopt the run even when no assistant text is buffered yet. Some runtimes
  // (e.g. Codex) do not stream incremental assistant text — the result exists
  // only at completion — so there is nothing to show mid-run, but the client
  // should still adopt the run and show a `streaming` status (not idle) and
  // render the result cleanly when it lands.
  const bufferedText = params.chatRunBuffers?.get(best.runId) ?? "";
  const projected = projectLiveAssistantBufferedText(bufferedText, {
    suppressLeadFragments: true,
  });
  const plan = params.chatRunPlanSnapshots?.get(best.runId);
  return {
    runId: best.runId,
    text: projected.suppress ? "" : projected.text,
    ...(plan ? { plan } : {}),
  };
}

export function boundInFlightRunSnapshotForChatHistory(params: {
  snapshot: { runId: string; text: string; plan?: ChatRunPlanSnapshot } | undefined;
  messages: unknown[];
  maxBytes: number;
}): { runId: string; text: string; plan?: ChatRunPlanSnapshot } | undefined {
  if (!params.snapshot) {
    return undefined;
  }
  const messagesBytes = jsonUtf8Bytes(params.messages);
  const snapshotBytes = jsonUtf8Bytes(params.snapshot);
  if (messagesBytes + snapshotBytes <= params.maxBytes) {
    return params.snapshot;
  }
  // Recovery priority is run adoption, then plan replay, then opportunistic text.
  const withoutText = {
    runId: params.snapshot.runId,
    text: "",
    ...(params.snapshot.plan ? { plan: params.snapshot.plan } : {}),
  };
  if (params.snapshot.plan && messagesBytes + jsonUtf8Bytes(withoutText) <= params.maxBytes) {
    return withoutText;
  }
  // An oversized plan must not also cost the deliverable buffered text. Clients
  // treat an ABSENT plan as legacy-gateway unknown and preserve retained state,
  // so a budget-dropped plan is sent as an explicit empty snapshot (authoritative
  // clear) — accepted tradeoff: the checklist blanks until the next live plan
  // event instead of showing a possibly obsolete retained plan indefinitely.
  const droppedPlan = params.snapshot.plan ? { plan: { steps: [] } } : {};
  const withoutPlan = {
    runId: params.snapshot.runId,
    text: params.snapshot.text,
    ...droppedPlan,
  };
  if (params.snapshot.text && messagesBytes + jsonUtf8Bytes(withoutPlan) <= params.maxBytes) {
    return withoutPlan;
  }
  return { runId: params.snapshot.runId, text: "", ...droppedPlan };
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatAbortedRuns: Map<string, ChatAbortMarker>;
  clearChatRunState: (runId: string) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  getRuntimeConfig?: () => OpenClawConfig;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: { dropIfSlow?: boolean; sessionKeys?: readonly string[] },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

type TrackedChatRunAbortOps = {
  chatAbortControllers: ChatAbortOps["chatAbortControllers"];
  chatRunBuffers: ChatAbortOps["chatRunBuffers"];
  chatRunState: {
    abortedRuns: ChatAbortOps["chatAbortedRuns"];
    clearRun: ChatAbortOps["clearChatRunState"];
  };
  removeChatRun: ChatAbortOps["removeChatRun"];
  agentRunSeq: ChatAbortOps["agentRunSeq"];
  broadcast: ChatAbortOps["broadcast"];
  nodeSendToSession: ChatAbortOps["nodeSendToSession"];
};

export function abortTrackedChatRunById(
  ops: TrackedChatRunAbortOps,
  params: Parameters<typeof abortChatRunById>[1],
) {
  return abortChatRunById(
    {
      chatAbortControllers: ops.chatAbortControllers,
      chatRunBuffers: ops.chatRunBuffers,
      chatAbortedRuns: ops.chatRunState.abortedRuns,
      clearChatRunState: ops.chatRunState.clearRun,
      removeChatRun: ops.removeChatRun,
      agentRunSeq: ops.agentRunSeq,
      broadcast: ops.broadcast,
      nodeSendToSession: ops.nodeSendToSession,
    },
    params,
  );
}

function resolveChatAbortDeliverySessionKeys(
  ops: ChatAbortOps,
  sessionKey: string,
  agentId: string | undefined,
): string[] {
  if (sessionKey !== "global") {
    return [sessionKey];
  }
  const scopedAgentId = normalizeActiveAgentId(agentId);
  if (!scopedAgentId) {
    return [sessionKey];
  }
  const keys = [`agent:${scopedAgentId}:global`];
  const cfg = ops.getRuntimeConfig?.();
  const defaultAgentId = cfg ? resolveDefaultAgentId(cfg) : undefined;
  if (defaultAgentId && scopedAgentId === defaultAgentId) {
    keys.push(sessionKey);
  }
  return keys;
}

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    agentId?: string;
    stopReason?: string;
    partialText?: string;
    errorMessage?: string;
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
  const errorMessage = readToolValidationErrorSummary(params.errorMessage);
  const defaultGlobalAgentId =
    sessionKey === "global" ? normalizeActiveAgentId(resolveDefaultGlobalAgentId(ops)) : undefined;
  const payloadAgentId =
    sessionKey === "global"
      ? (normalizeActiveAgentId(params.agentId) ?? defaultGlobalAgentId)
      : normalizeActiveAgentId(params.agentId);
  const payload = {
    runId,
    sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
    state: "aborted" as const,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    message: partialText
      ? {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
        }
      : undefined,
  };
  const deliverySessionKeys = resolveChatAbortDeliverySessionKeys(ops, sessionKey, payloadAgentId);
  ops.broadcast("chat", payload, { sessionKeys: deliverySessionKeys });
  for (const deliverySessionKey of deliverySessionKeys) {
    ops.nodeSendToSession(deliverySessionKey, "chat", payload);
  }
}

function resolveDefaultGlobalAgentId(ops: ChatAbortOps): string | undefined {
  const cfg = ops.getRuntimeConfig?.();
  return cfg ? resolveDefaultAgentId(cfg) : undefined;
}

export function isChatAbortControllerEntryAbortable(entry: ChatAbortControllerEntry): boolean {
  if (entry.controller.signal.aborted) {
    return false;
  }
  try {
    return entry.isAbortable?.(entry) !== false;
  } catch {
    return false;
  }
}

export function removeChatAbortControllerEntry(
  entries: Map<string, ChatAbortControllerEntry>,
  runId: string,
  expectedEntry?: ChatAbortControllerEntry,
): boolean {
  const entry = entries.get(runId);
  if (!entry || (expectedEntry && entry !== expectedEntry)) {
    return false;
  }
  entries.delete(runId);
  try {
    entry.onRemoved?.();
  } catch {
    // Removal owns state cleanup even if a caller-provided release hook fails.
  }
  return true;
}

export function abortChatRunById(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
  },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) {
    return { aborted: false };
  }
  if (active.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (!isChatAbortControllerEntryAbortable(active)) {
    return { aborted: false };
  }

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, createChatAbortMarker());
  if (stopReason) {
    active.abortStopReason = stopReason;
  }
  active.projectSessionActive = false;
  // Reserve terminal ownership before abort listeners run; synchronous caller
  // cleanup must not erase the entry before Gateway observes the event below.
  active.projectSessionTerminalPending = true;
  active.projectSessionTerminalObservedAt = undefined;
  active.registrationCleanupRequested = true;
  active.controller.abort(createChatAbortSignalReason(stopReason));
  ops.clearChatRunState(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  if (active.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      runId,
      sessionKey,
      agentId: active.agentId,
      stopReason,
      partialText,
      errorMessage: active.toolErrorSummary,
    });
  }
  emitAgentEvent({
    runId,
    ...(active.lifecycleGeneration ? { lifecycleGeneration: active.lifecycleGeneration } : {}),
    sessionKey,
    agentId: active.agentId,
    stream: "lifecycle",
    data: {
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason,
      ...(active.toolErrorSummary ? { toolErrorSummary: active.toolErrorSummary } : {}),
      startedAt: active.startedAtMs,
      endedAt: Date.now(),
    },
  });
  // Gateway listeners synchronously stamp the terminal observation. Keep the
  // entry as suspension-visible ownership until its persistence write settles.
  if (
    ops.chatAbortControllers.get(runId) === active &&
    active.projectSessionTerminalObservedAt === undefined &&
    !active.projectSessionTerminalPersistence
  ) {
    removeChatAbortControllerEntry(ops.chatAbortControllers, runId, active);
  }
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}

export function updateChatRunProvider(
  chatAbortControllers: Map<string, ChatAbortControllerEntry>,
  params: {
    runId: string;
    providerId?: string;
    authProviderId?: string;
  },
): boolean {
  const entry = chatAbortControllers.get(params.runId);
  if (!entry) {
    return false;
  }
  entry.providerId = normalizeProviderIdForActiveRun(params.providerId);
  entry.authProviderId = normalizeProviderIdForActiveRun(params.authProviderId);
  return true;
}

export function abortChatRunsForProvider(
  ops: ChatAbortOps,
  params: {
    providerId: string;
    stopReason?: string;
  },
): { runIds: string[] } {
  const providerId = normalizeProviderIdForActiveRun(params.providerId);
  if (!providerId) {
    return { runIds: [] };
  }
  const matches = [...ops.chatAbortControllers.entries()].filter(
    ([, entry]) =>
      normalizeProviderIdForActiveRun(entry.authProviderId) === providerId ||
      normalizeProviderIdForActiveRun(entry.providerId) === providerId,
  );
  const runIds: string[] = [];
  for (const [runId, entry] of matches) {
    const result = abortChatRunById(ops, {
      runId,
      sessionKey: entry.sessionKey,
      stopReason: params.stopReason,
    });
    if (result.aborted) {
      runIds.push(runId);
    }
  }
  return { runIds };
}
