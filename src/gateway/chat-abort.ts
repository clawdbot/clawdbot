import {
  asDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent } from "../infra/agent-events.js";

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
  broadcastChatAborted(ops, {
    runId,
    sessionKey,
    agentId: active.agentId,
    stopReason,
    partialText,
  });
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
