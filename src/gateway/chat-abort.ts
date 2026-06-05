// Gateway chat/agent abort tracking.
// Registers active run abort controllers and projects in-flight chat state.
import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
  abortStopReason?: string;
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
  /**
   * Which RPC owns this registration. Absent (undefined) is treated as
   * `"chat-send"` so pre-existing callers that constructed entries without
   * a kind keep their behavior. Consumers that need "chat.send specifically
   * is active" must check `kind !== "agent"`, not just `.has(runId)`.
   */
  kind?: "chat-send" | "agent";
};

type RegisteredChatAbortController = {
  controller: AbortController;
  registered: boolean;
  entry?: ChatAbortControllerEntry;
  cleanup: () => void;
};

export function isChatStopCommandText(text: string): boolean {
  return isAbortRequestText(text);
}

function createChatAbortSignalReason(stopReason: string | undefined): Error | undefined {
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
  kind?: ChatAbortControllerEntry["kind"];
  now?: number;
  expiresAtMs?: number;
}): RegisteredChatAbortController {
  const controller = new AbortController();
  const cleanup = () => {
    const entry = params.chatAbortControllers.get(params.runId);
    if (entry?.controller === controller) {
      params.chatAbortControllers.delete(params.runId);
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
    projectSessionActive: true,
    kind: params.kind,
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
  requestedSessionKey: string;
  canonicalSessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
}): { runId: string; text: string } | undefined {
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
  return { runId: best.runId, text: projected.suppress ? "" : projected.text };
}

export function boundInFlightRunSnapshotForChatHistory(params: {
  snapshot: { runId: string; text: string } | undefined;
  messages: unknown[];
  maxBytes: number;
}): { runId: string; text: string } | undefined {
  if (!params.snapshot?.text) {
    return params.snapshot;
  }
  const messagesBytes = jsonUtf8Bytes(params.messages);
  const snapshotBytes = jsonUtf8Bytes(params.snapshot);
  if (messagesBytes + snapshotBytes <= params.maxBytes) {
    return params.snapshot;
  }
  // The run id is the recovery contract; buffered partial text is opportunistic.
  // If it would break the history payload budget, keep adoption and wait for the
  // next live delta/final instead of sending an oversized chat.history response.
  return { runId: params.snapshot.runId, text: "" };
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatAbortedRuns: Map<string, number>;
  clearChatRunState: (runId: string) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  getRuntimeConfig?: () => OpenClawConfig;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

export type TrackedChatRunAbortOps = {
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
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
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
    message: partialText
      ? {
          role: "assistant",
          content: [{ type: "text", text: partialText }],
          timestamp: Date.now(),
        }
      : undefined,
  };
  ops.broadcast("chat", payload);
  for (const deliverySessionKey of resolveChatAbortDeliverySessionKeys(
    ops,
    sessionKey,
    payloadAgentId,
  )) {
    ops.nodeSendToSession(deliverySessionKey, "chat", payload);
  }
}

function resolveDefaultGlobalAgentId(ops: ChatAbortOps): string | undefined {
  const cfg = ops.getRuntimeConfig?.();
  return cfg ? resolveDefaultAgentId(cfg) : undefined;
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

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, Date.now());
  if (stopReason) {
    active.abortStopReason = stopReason;
  }
  active.controller.abort(createChatAbortSignalReason(stopReason));
  ops.chatAbortControllers.delete(runId);
  ops.clearChatRunState(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  if (active.controlUiVisible !== false) {
    broadcastChatAborted(ops, {
      runId,
      sessionKey,
      agentId: active.agentId,
      stopReason,
      partialText,
    });
  }
  emitAgentEvent({
    runId,
    sessionKey,
    agentId: active.agentId,
    stream: "lifecycle",
    data: {
      phase: "end",
      status: "cancelled",
      aborted: true,
      stopReason,
      startedAt: active.startedAtMs,
      endedAt: Date.now(),
    },
  });
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
