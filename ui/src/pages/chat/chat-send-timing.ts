import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { visibleSessionMatches, type SessionScopeHost } from "../../lib/sessions/index.ts";
import type { ChatEventPayload } from "./chat-history.ts";
import { readChatQueueForScope } from "./chat-queue.ts";
import type { ChatSendAck, ChatSendTimingEntry } from "./chat-send-contract.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiAfterPaint,
} from "./performance.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type ChatSendTimingPhase =
  | "pending-visible"
  | "pending-painted"
  | "request-start"
  | "ack"
  | "server-dispatch-started"
  | "server-model-selected"
  | "server-agent-run-started"
  | "server-first-assistant-event"
  | "server-dispatch-completed"
  | "server-post-dispatch-completed"
  | "first-assistant-visible"
  | "terminal-before-delta"
  | "queued-busy"
  | "waiting-model"
  | "waiting-reconnect"
  | "failed";

type ChatSendTimingHost = SessionScopeHost & {
  sessionKey: string;
  chatStream: string | null;
  chatQueue: ChatQueueItem[];
  chatQueueByScope?: Record<string, ChatQueueItem[]>;
  chatSendTimingsByRun?: Map<string, ChatSendTimingEntry>;
  eventLogBuffer?: unknown[];
  renderLifecycle?: RenderLifecycle;
};

type ChatSendServerTimingPhase =
  | "dispatch-started"
  | "model-selected"
  | "agent-run-started"
  | "first-assistant-event"
  | "dispatch-completed"
  | "post-dispatch-completed";

const CHAT_SEND_SERVER_TIMING_PHASES = new Set<ChatSendServerTimingPhase>([
  "dispatch-started",
  "model-selected",
  "agent-run-started",
  "first-assistant-event",
  "dispatch-completed",
  "post-dispatch-completed",
]);
const CHAT_SEND_SLOW_FIRST_ASSISTANT_MS = 1_500;

export function recordChatSendTiming(
  host: ChatSendTimingHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  phase: ChatSendTimingPhase,
  startedAtMs = item.sendSubmittedAtMs,
  extra: Record<string, unknown> = {},
) {
  if (startedAtMs == null) {
    return;
  }
  recordControlUiPerformanceEvent(
    host as Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.send",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      runId: item.sendRunId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 40 },
  );
}

function readChatSendServerTimingPhase(value: unknown): ChatSendServerTimingPhase | null {
  return typeof value === "string" &&
    (CHAT_SEND_SERVER_TIMING_PHASES as ReadonlySet<string>).has(value)
    ? (value as ChatSendServerTimingPhase)
    : null;
}

function readChatSendTimingNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function recordChatSendServerTiming(host: ChatSendTimingHost, payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const record = payload as Record<string, unknown>;
  const phase = readChatSendServerTimingPhase(record.phase);
  const runId = typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : "";
  if (!phase || !runId) {
    return;
  }
  const entry = host.chatSendTimingsByRun?.get(runId);
  const nowMs = controlUiNowMs();
  const serverAckToPhaseMs = readChatSendTimingNumber(record.ackToPhaseMs);
  const serverReceivedToPhaseMs = readChatSendTimingNumber(record.receivedToPhaseMs);
  const serverDispatchStartedToPhaseMs = readChatSendTimingNumber(record.dispatchStartedToPhaseMs);
  const serverPostDispatchMs = readChatSendTimingNumber(record.postDispatchMs);
  const durationMs =
    entry?.submittedAtMs !== undefined
      ? roundedControlUiDurationMs(nowMs - entry.submittedAtMs)
      : serverAckToPhaseMs;
  if (durationMs === undefined) {
    return;
  }
  const slow = phase === "first-assistant-event" && durationMs >= CHAT_SEND_SLOW_FIRST_ASSISTANT_MS;
  recordControlUiPerformanceEvent(
    host as Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.send",
    {
      phase: `server-${phase}`,
      durationMs,
      runId,
      sessionKey:
        entry?.sessionKey ??
        (typeof record.sessionKey === "string" && record.sessionKey.trim()
          ? record.sessionKey.trim()
          : undefined),
      agentId:
        entry?.agentId ??
        (typeof record.agentId === "string" && record.agentId.trim()
          ? record.agentId.trim()
          : undefined),
      sendAttempts: entry?.sendAttempts ?? 0,
      sendState: entry?.sendState,
      ackStatus: entry?.ackStatus,
      serverPhase: phase,
      ...(serverAckToPhaseMs !== undefined ? { serverAckToPhaseMs } : {}),
      ...(serverReceivedToPhaseMs !== undefined ? { serverReceivedToPhaseMs } : {}),
      ...(serverDispatchStartedToPhaseMs !== undefined ? { serverDispatchStartedToPhaseMs } : {}),
      ...(serverPostDispatchMs !== undefined ? { serverPostDispatchMs } : {}),
      ...(typeof record.provider === "string" && record.provider.trim()
        ? { provider: record.provider.trim() }
        : {}),
      ...(typeof record.model === "string" && record.model.trim()
        ? { model: record.model.trim() }
        : {}),
      ...(typeof record.agentRunId === "string" && record.agentRunId.trim()
        ? { agentRunId: record.agentRunId.trim() }
        : {}),
      ...(slow ? { slow: true } : {}),
    },
    { console: slow, warn: slow, maxBufferedEventsForType: 40 },
  );
}

function ensureChatSendTimingEntries(host: ChatSendTimingHost): Map<string, ChatSendTimingEntry> {
  if (host.chatSendTimingsByRun) {
    return host.chatSendTimingsByRun;
  }
  const entries = new Map<string, ChatSendTimingEntry>();
  host.chatSendTimingsByRun = entries;
  return entries;
}

export function registerChatSendTiming(
  host: ChatSendTimingHost,
  item: Pick<
    ChatQueueItem,
    "sendRunId" | "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  runId: string,
  requestStartedAtMs: number,
) {
  ensureChatSendTimingEntries(host).set(runId, {
    runId,
    sessionKey: item.sessionKey,
    agentId: item.agentId,
    sendAttempts: item.sendAttempts ?? 0,
    sendState: item.sendState,
    submittedAtMs: item.sendSubmittedAtMs ?? requestStartedAtMs,
    requestStartedAtMs,
  });
}

export function updateChatSendAckTiming(
  host: ChatSendTimingHost,
  requestedRunId: string,
  ack: ChatSendAck,
  item: Pick<
    ChatQueueItem,
    "sessionKey" | "agentId" | "sendAttempts" | "sendState" | "sendSubmittedAtMs"
  >,
  requestStartedAtMs: number,
) {
  const entries = ensureChatSendTimingEntries(host);
  const existing = entries.get(requestedRunId);
  const submittedAtMs = existing?.submittedAtMs ?? item.sendSubmittedAtMs ?? requestStartedAtMs;
  const next: ChatSendTimingEntry = {
    ...(existing ?? {
      runId: ack.runId,
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      sendAttempts: item.sendAttempts ?? 0,
      sendState: item.sendState,
      submittedAtMs,
      requestStartedAtMs,
    }),
    runId: ack.runId,
    sessionKey: existing?.sessionKey ?? item.sessionKey,
    agentId: existing?.agentId ?? item.agentId,
    ackAtMs: controlUiNowMs(),
    ackStatus: ack.status,
  };
  if (ack.runId !== requestedRunId) {
    entries.delete(requestedRunId);
  }
  entries.set(ack.runId, next);
}

export function chatSendAckServerTimingEventFields(ack: ChatSendAck): Record<string, number> {
  const timing = ack.serverTiming;
  return {
    ...(typeof timing?.receivedToAckMs === "number"
      ? { serverReceivedToAckMs: timing.receivedToAckMs }
      : {}),
    ...(typeof timing?.loadSessionMs === "number"
      ? { serverLoadSessionMs: timing.loadSessionMs }
      : {}),
    ...(typeof timing?.prepareAttachmentsMs === "number"
      ? { serverPrepareAttachmentsMs: timing.prepareAttachmentsMs }
      : {}),
  };
}

function chatEventHasVisibleTerminalPayload(payload: ChatEventPayload): boolean {
  if (payload.state === "error" && payload.errorMessage?.trim()) {
    return true;
  }
  return Boolean(payload.message && typeof payload.message === "object");
}

function resolveFirstAssistantTimingPhase(
  host: ChatSendTimingHost,
  payload: ChatEventPayload,
  entry: ChatSendTimingEntry,
): Extract<ChatSendTimingPhase, "first-assistant-visible" | "terminal-before-delta"> | null {
  if (entry.firstAssistantVisibleRecorded) {
    return null;
  }
  if (payload.state === "delta") {
    return typeof host.chatStream === "string" && host.chatStream.trim()
      ? "first-assistant-visible"
      : null;
  }
  if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
    return chatEventHasVisibleTerminalPayload(payload) ? "terminal-before-delta" : null;
  }
  return null;
}

export function recordFirstAssistantChatTiming(
  host: ChatSendTimingHost,
  payload: ChatEventPayload | undefined,
  handledState: ChatEventPayload["state"] | null,
) {
  if (!payload || !handledState || typeof payload.runId !== "string") {
    return;
  }
  const runId = payload.runId.trim();
  const entry = runId ? host.chatSendTimingsByRun?.get(runId) : undefined;
  if (!entry) {
    return;
  }
  const phase = resolveFirstAssistantTimingPhase(host, payload, entry);
  if (!phase) {
    if (payload.state === "final" || payload.state === "aborted" || payload.state === "error") {
      host.chatSendTimingsByRun?.delete(runId);
    }
    return;
  }

  const eventAtMs = controlUiNowMs();
  entry.firstAssistantVisibleRecorded = true;
  scheduleControlUiAfterPaint(host, () => {
    const paintedAtMs = controlUiNowMs();
    const durationMs = roundedControlUiDurationMs(paintedAtMs - entry.submittedAtMs);
    const slow = durationMs >= CHAT_SEND_SLOW_FIRST_ASSISTANT_MS;
    recordControlUiPerformanceEvent(
      host as Parameters<typeof recordControlUiPerformanceEvent>[0],
      "control-ui.chat.send",
      {
        phase,
        durationMs,
        runId,
        sessionKey: entry.sessionKey ?? payload.sessionKey,
        agentId: entry.agentId ?? payload.agentId,
        sendAttempts: entry.sendAttempts,
        sendState: entry.sendState,
        ackStatus: entry.ackStatus,
        eventState: payload.state,
        firstAssistantPaintMs: roundedControlUiDurationMs(paintedAtMs - eventAtMs),
        ...(entry.requestStartedAtMs != null
          ? {
              requestToFirstAssistantEventMs: roundedControlUiDurationMs(
                eventAtMs - entry.requestStartedAtMs,
              ),
            }
          : {}),
        ...(entry.ackAtMs != null
          ? {
              ackToFirstAssistantEventMs: roundedControlUiDurationMs(eventAtMs - entry.ackAtMs),
            }
          : {}),
        ...(slow ? { slow: true } : {}),
      },
      { console: slow, warn: slow, maxBufferedEventsForType: 40 },
    );
    if (phase === "terminal-before-delta") {
      host.chatSendTimingsByRun?.delete(runId);
    }
  });
}

function shouldRecordPendingSendPaint(item: ChatQueueItem): boolean {
  return (
    typeof item.sendSubmittedAtMs === "number" &&
    (item.sendState === "waiting-model" ||
      item.sendState === "waiting-idle" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect")
  );
}

export function schedulePendingSendPaintTiming(
  host: ChatSendTimingHost,
  item: ChatQueueItem,
  startedAtMs = item.sendSubmittedAtMs,
) {
  const sessionKey = item.sessionKey ?? host.sessionKey;
  const sendRunId = item.sendRunId;
  if (!sendRunId || startedAtMs == null) {
    return;
  }
  scheduleControlUiAfterPaint(host as Parameters<typeof scheduleControlUiAfterPaint>[0], () => {
    if (!visibleSessionMatches(host, sessionKey, item.agentId)) {
      return;
    }
    const queued = readChatQueueForScope(host, sessionKey, item.agentId).find(
      (entry) => entry.id === item.id && entry.sendRunId === sendRunId,
    );
    if (!queued || !shouldRecordPendingSendPaint(queued)) {
      return;
    }
    recordChatSendTiming(host, queued, "pending-painted", startedAtMs);
  });
}
