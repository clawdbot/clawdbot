import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { BufferedAgentEvent } from "./server-chat-state.js";

const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 60_000;

export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  ownerConnId?: string;
  ownerDeviceId?: string;
  providerId?: string;
  authProviderId?: string;
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

function resolveChatRunExpiresAtMs(params: {
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
  const boundedTimeoutMs = Math.max(0, timeoutMs);
  const target = now + boundedTimeoutMs + graceMs;
  const min = now + minMs;
  const max = now + maxMs;
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

  const now = params.now ?? Date.now();
  const entry: ChatAbortControllerEntry = {
    controller,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    startedAtMs: now,
    expiresAtMs:
      params.expiresAtMs ?? resolveChatRunExpiresAtMs({ now, timeoutMs: params.timeoutMs }),
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    providerId: normalizeProviderIdForActiveRun(params.providerId),
    authProviderId: normalizeProviderIdForActiveRun(params.authProviderId),
    kind: params.kind,
  };
  params.chatAbortControllers.set(params.runId, entry);
  return { controller, registered: true, entry, cleanup };
}

function normalizeProviderIdForActiveRun(providerId: string | undefined): string | undefined {
  const trimmed = providerId?.trim().toLowerCase();
  return trimmed || undefined;
}

export type ChatAbortOps = {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatDeltaLastBroadcastLen: Map<string, number>;
  chatDeltaLastBroadcastText: Map<string, string>;
  agentDeltaSentAt: Map<string, number>;
  bufferedAgentEvents: Map<string, BufferedAgentEvent>;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
};

function broadcastChatAborted(
  ops: ChatAbortOps,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    partialText?: string;
  },
) {
  const { runId, sessionKey, stopReason, partialText } = params;
  const payload = {
    runId,
    sessionKey,
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
  ops.nodeSendToSession(sessionKey, "chat", payload);
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
  active.controller.abort();
  ops.chatAbortControllers.delete(runId);
  ops.chatRunBuffers.delete(runId);
  ops.chatDeltaSentAt.delete(runId);
  ops.chatDeltaLastBroadcastLen.delete(runId);
  ops.chatDeltaLastBroadcastText.delete(runId);
  ops.agentDeltaSentAt.delete(runId);
  ops.agentDeltaSentAt.delete(`${runId}:assistant`);
  ops.agentDeltaSentAt.delete(`${runId}:thinking`);
  ops.bufferedAgentEvents.delete(runId);
  ops.bufferedAgentEvents.delete(`${runId}:assistant`);
  ops.bufferedAgentEvents.delete(`${runId}:thinking`);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
  emitAgentEvent({
    runId,
    sessionKey,
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
