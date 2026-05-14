import { resolveToolSearchCodeDisplayTarget } from "../agents/tool-display-common.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/io.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { detectErrorKind, type ErrorKind } from "../infra/errors.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import {
  normalizeLiveAssistantEventText,
  projectLiveAssistantBufferedText,
  resolveMergedAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "./live-chat-projector.js";
import type {
  BufferedAgentEvent,
  ChatRunState,
  SessionEventSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { loadGatewaySessionRow } from "./server-chat.load-gateway-session-row.runtime.js";
import { persistGatewaySessionLifecycleEvent } from "./server-chat.persist-session-lifecycle.runtime.js";
import { deriveGatewaySessionLifecycleSnapshot } from "./session-lifecycle-state.js";
import { loadSessionEntry } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

export {
  createChatRunRegistry,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
  createToolEventRecipientRegistry,
} from "./server-chat-state.js";
export type {
  ChatRunEntry,
  ChatRunRegistry,
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";

function projectToolSearchCodeEventForChannelPayload<T extends { data?: unknown }>(payload: T): T {
  const data = payload.data;
  if (!data || typeof data !== "object") {
    return payload;
  }
  const record = data as Record<string, unknown>;
  if (record.name !== "tool_search_code") {
    return payload;
  }
  const target = resolveToolSearchCodeDisplayTarget(record.args);
  if (!target) {
    return payload;
  }
  const projectedName = target.displayToolName ?? target.toolName;
  if (!projectedName || projectedName === "tool_search_code") {
    return payload;
  }

  // Channel/node subscribers render from event data, not the richer display
  // helper used by Control UI. Project obvious bridge calls so verbose
  // surfaces name the concrete tool while keeping the bridge identity available.
  const projectedData: Record<string, unknown> = { ...record, name: projectedName };
  if (target.displayArgs) {
    projectedData.args = target.displayArgs;
  } else if (target.detail) {
    projectedData.args = { detail: target.detail };
  }
  if (target.bridgeVerb) {
    projectedData.bridgeToolName = "tool_search_code";
    projectedData.bridgeTargetToolName = target.toolName;
    projectedData.bridgeVerb = target.bridgeVerb;
  }
  return { ...payload, data: projectedData };
}

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = getRuntimeConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = getRuntimeConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function shouldSuppressHeartbeatToolEvents(runId: string, sourceRunId?: string): boolean {
  return Boolean(resolveHeartbeatContext(runId, sourceRunId)?.isHeartbeat);
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

/**
 * Keep this aligned with the agent.wait lifecycle-error grace so chat surfaces
 * do not finalize a run before fallback or retry reuses the same runId.
 */
const AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

const CHAT_ERROR_KINDS = new Set<ErrorKind>([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "unknown",
]);

function readChatErrorKind(value: unknown): ErrorKind | undefined {
  return typeof value === "string" && CHAT_ERROR_KINDS.has(value as ErrorKind)
    ? (value as ErrorKind)
    : undefined;
}

type BroadcastDelta = { deltaText: string; replace?: true };

function resolveBroadcastDelta(params: {
  text: string;
  previousBroadcastText: string | undefined;
}): BroadcastDelta | undefined {
  if (!params.text) {
    return undefined;
  }
  const previous = params.previousBroadcastText;
  if (previous === undefined) {
    return { deltaText: params.text };
  }
  if (!params.text.startsWith(previous)) {
    return { deltaText: params.text, replace: true };
  }
  const deltaText = params.text.slice(previous.length);
  return deltaText ? { deltaText } : undefined;
}

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  loadGatewaySessionRowForSnapshot?: typeof loadGatewaySessionRow;
  lifecycleErrorRetryGraceMs?: number;
  isChatSendRunActive?: (runId: string) => boolean;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  sessionEventSubscribers,
  loadGatewaySessionRowForSnapshot = loadGatewaySessionRow,
  lifecycleErrorRetryGraceMs = AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS,
  isChatSendRunActive = () => false,
}: AgentEventHandlerOptions) {
  const pendingTerminalLifecycleErrors = new Map<string, NodeJS.Timeout>();

  type AgentTextThrottleStream = "assistant" | "thinking";

  const agentTextThrottleKey = (clientRunId: string, stream: AgentTextThrottleStream) =>
    `${clientRunId}:${stream}`;

  const agentTextThrottleKeys = (clientRunId: string) => [
    clientRunId,
    agentTextThrottleKey(clientRunId, "assistant"),
    agentTextThrottleKey(clientRunId, "thinking"),
  ];

  const clearAgentTextThrottleState = (clientRunId: string) => {
    for (const key of agentTextThrottleKeys(clientRunId)) {
      chatRunState.agentDeltaSentAt.delete(key);
      chatRunState.bufferedAgentEvents.delete(key);
    }
  };

  const clearBufferedChatState = (clientRunId: string) => {
    chatRunState.rawBuffers.delete(clientRunId);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    chatRunState.deltaLastBroadcastLen.delete(clientRunId);
    chatRunState.deltaLastBroadcastText.delete(clientRunId);
    clearAgentTextThrottleState(clientRunId);
  };

  const clearPendingTerminalLifecycleError = (runId: string) => {
    const pending = pendingTerminalLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    clearTimeout(pending);
    pendingTerminalLifecycleErrors.delete(runId);
  };

  // Only subagent/acp keys can carry spawnedBy (mirrors supportsSpawnLineage in
  // sessions-patch.ts). Short-circuit everyone else so high-volume chat streams
  // do not touch the session store. Results are cached per sessionKey because
  // spawnedBy is immutable once set and resolveSpawnedBy sits on the hot event
  // path (delta, flush, final, agent, seq-gap).
  const spawnedByCache = new Map<string, string | null>();
  const resolveSpawnedBy = (sessionKey: string): string | null => {
    if (spawnedByCache.has(sessionKey)) {
      return spawnedByCache.get(sessionKey)!;
    }
    // Non-lineage keys return null without polluting the cache; only
    // subagent/ACP results (positive or null) are worth memoising.
    if (!isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey)) {
      return null;
    }
    let result: string | null = null;
    try {
      result = loadGatewaySessionRow(sessionKey)?.spawnedBy ?? null;
    } catch {
      // result stays null
    }
    spawnedByCache.set(sessionKey, result);
    return result;
  };

  const buildSessionEventSnapshot = (sessionKey: string, evt?: AgentEventPayload) => {
    const row = loadGatewaySessionRowForSnapshot(sessionKey);
    const lifecyclePatch = evt
      ? deriveGatewaySessionLifecycleSnapshot({
          session: row
            ? {
                updatedAt: row.updatedAt ?? undefined,
                status: row.status,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
                runtimeMs: row.runtimeMs,
                abortedLastRun: row.abortedLastRun,
              }
            : undefined,
          event: evt,
        })
      : {};
    const session = row ? { ...row, ...lifecyclePatch } : undefined;
    const snapshotSource = session ?? lifecyclePatch;
    return {
      ...(session ? { session } : {}),
      updatedAt: snapshotSource.updatedAt,
      sessionId: row?.sessionId,
      kind: row?.kind,
      channel: row?.channel,
      subject: row?.subject,
      groupChannel: row?.groupChannel,
      space: row?.space,
      chatType: row?.chatType,
      origin: row?.origin,
      spawnedBy: row?.spawnedBy,
      spawnedWorkspaceDir: row?.spawnedWorkspaceDir,
      forkedFromParent: row?.forkedFromParent,
      spawnDepth: row?.spawnDepth,
      subagentRole: row?.subagentRole,
      subagentControlScope: row?.subagentControlScope,
      label: row?.label,
      displayName: row?.displayName,
      deliveryContext: row?.deliveryContext,
      parentSessionKey: row?.parentSessionKey,
      childSessions: row?.childSessions,
      thinkingLevel: row?.thinkingLevel,
      fastMode: row?.fastMode,
      verboseLevel: row?.verboseLevel,
      traceLevel: row?.traceLevel,
      reasoningLevel: row?.reasoningLevel,
      elevatedLevel: row?.elevatedLevel,
      sendPolicy: row?.sendPolicy,
      systemSent: row?.systemSent,
      inputTokens: row?.inputTokens,
      outputTokens: row?.outputTokens,
      lastChannel: row?.lastChannel,
      lastTo: row?.lastTo,
      lastAccountId: row?.lastAccountId,
      lastThreadId: row?.lastThreadId,
      totalTokens: row?.totalTokens,
      totalTokensFresh: row?.totalTokensFresh,
      contextTokens: row?.contextTokens,
      estimatedCostUsd: row?.estimatedCostUsd,
      responseUsage: row?.responseUsage,
      modelProvider: row?.modelProvider,
      model: row?.model,
      status: snapshotSource.status,
      startedAt: snapshotSource.startedAt,
      endedAt: snapshotSource.endedAt,
      runtimeMs: snapshotSource.runtimeMs,
      abortedLastRun: snapshotSource.abortedLastRun,
    };
  };

  const finalizeLifecycleEvent = (
    evt: AgentEventPayload,
    opts?: { skipChatErrorFinal?: boolean },
  ) => {
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (lifecyclePhase !== "end" && lifecyclePhase !== "error") {
      return;
    }

    clearPendingTerminalLifecycleError(evt.runId);

    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);

    if (isControlUiVisible && sessionKey) {
      if (!isAborted) {
        const evtStopReason =
          typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
        const evtErrorKind =
          readChatErrorKind(evt.data?.errorKind) ?? detectErrorKind(evt.data?.error);
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) {
            emitChatFinal(
              finished.sessionKey,
              finished.clientRunId,
              evt.runId,
              evt.seq,
              lifecyclePhase === "error" ? "error" : "done",
              evt.data?.error,
              evtStopReason,
              evtErrorKind,
            );
          }
        } else if (!(opts?.skipChatErrorFinal && lifecyclePhase === "error")) {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
            evtStopReason,
            evtErrorKind,
          );
        }
      } else {
        clearBufferedChatState(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    toolEventRecipients.markFinal(evt.runId);
    clearBufferedChatState(clientRunId);
    clearAgentRunContext(evt.runId);
    agentRunSeq.delete(evt.runId);
    agentRunSeq.delete(clientRunId);

    if (sessionKey) {
      void persistGatewaySessionLifecycleEvent({ sessionKey, event: evt }).catch(() => undefined);
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (sessionEventConnIds.size > 0) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            phase: lifecyclePhase,
            runId: evt.runId,
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };

  const scheduleTerminalLifecycleError = (
    evt: AgentEventPayload,
    opts?: { skipChatErrorFinal?: boolean },
  ) => {
    clearPendingTerminalLifecycleError(evt.runId);
    const timer = setSafeTimeout(() => {
      pendingTerminalLifecycleErrors.delete(evt.runId);
      finalizeLifecycleEvent(evt, opts);
    }, lifecycleErrorRetryGraceMs);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(evt.runId, timer);
  };

  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
    delta?: unknown,
  ) => {
    const cleaned = normalizeLiveAssistantEventText({ text, delta });
    const previousRawText = chatRunState.rawBuffers.get(clientRunId) ?? "";
    const mergedRawText = resolveMergedAssistantText({
      previousText: previousRawText,
      nextText: cleaned.text,
      nextDelta: cleaned.delta,
    });
    if (!mergedRawText) {
      return;
    }
    chatRunState.rawBuffers.set(clientRunId, mergedRawText);
    const projected = projectLiveAssistantBufferedText(mergedRawText);
    const mergedText = projected.text;
    chatRunState.buffers.set(clientRunId, mergedText);
    if (projected.suppress) {
      return;
    }
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    const broadcastDelta = resolveBroadcastDelta({
      text: mergedText,
      previousBroadcastText: chatRunState.deltaLastBroadcastText.get(clientRunId),
    });
    if (!broadcastDelta) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    chatRunState.deltaLastBroadcastLen.set(clientRunId, mergedText.length);
    chatRunState.deltaLastBroadcastText.set(clientRunId, mergedText);
    const spawnedBy = resolveSpawnedBy(sessionKey);
    const payload = {
      runId: clientRunId,
      sessionKey,
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "delta" as const,
      deltaText: broadcastDelta.deltaText,
      ...(broadcastDelta.replace ? { replace: true as const } : {}),
      message: {
        role: "assistant",
        content: [{ type: "text", text: mergedText }],
        timestamp: now,
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveBufferedChatTextState = (
    clientRunId: string,
    sourceRunId: string,
    options?: { suppressLeadFragments?: boolean },
  ) => {
    const bufferedText = normalizeLiveAssistantEventText({
      text: chatRunState.buffers.get(clientRunId) ?? "",
    }).text.trim();
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const projected = projectLiveAssistantBufferedText(normalizedHeartbeatText.text.trim(), {
      suppressLeadFragments: options?.suppressLeadFragments,
    });
    return {
      text: projected.text.trim(),
      shouldSuppressSilent: normalizedHeartbeatText.suppress || projected.suppress,
    };
  };

  const flushBufferedChatDeltaIfNeeded = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, {
      suppressLeadFragments: true,
    });
    const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(
      clientRunId,
      sourceRunId,
    );
    if (!text || shouldSuppressSilent || shouldSuppressHeartbeatStreaming) {
      return;
    }

    const now = Date.now();
    const delta = resolveBroadcastDelta({
      text,
      previousBroadcastText: chatRunState.deltaLastBroadcastText.get(clientRunId),
    });
    if (!delta) {
      return;
    }
    const spawnedBy = resolveSpawnedBy(sessionKey);
    const flushPayload = {
      runId: clientRunId,
      sessionKey,
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "delta" as const,
      deltaText: delta.deltaText,
      ...(delta.replace ? { replace: true as const } : {}),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    broadcast("chat", flushPayload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", flushPayload);
    chatRunState.deltaLastBroadcastLen.set(clientRunId, text.length);
    chatRunState.deltaLastBroadcastText.set(clientRunId, text);
    chatRunState.deltaSentAt.set(clientRunId, now);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
    stopReason?: string,
    errorKind?: ErrorKind,
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, {
      suppressLeadFragments: false,
    });
    // Flush any throttled delta so streaming clients receive the complete text
    // before the final event. The 150 ms throttle in emitChatDelta may have
    // suppressed the most recent chunk, leaving the client with stale text.
    // Only flush if the buffered text differs from the last broadcast to avoid duplicates.
    flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, sourceRunId, seq);
    chatRunState.deltaLastBroadcastLen.delete(clientRunId);
    chatRunState.deltaLastBroadcastText.delete(clientRunId);
    chatRunState.rawBuffers.delete(clientRunId);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    clearAgentTextThrottleState(clientRunId);
    const spawnedBy = resolveSpawnedBy(sessionKey);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        ...(spawnedBy && { spawnedBy }),
        seq,
        state: "final" as const,
        ...(stopReason && { stopReason }),
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
      ...(errorKind && { errorKind }),
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const sendAgentPayload = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
  ) => {
    broadcast("agent", payload);
    if (sessionKey) {
      nodeSendToSession(sessionKey, "agent", payload);
    }
  };

  const flushBufferedAgentDeltaIfNeeded = (
    clientRunId: string,
    stream?: AgentTextThrottleStream,
  ) => {
    const keys = stream
      ? [agentTextThrottleKey(clientRunId, stream)]
      : agentTextThrottleKeys(clientRunId);
    const bufferedEntries = keys.flatMap((key) => {
      const buffered = chatRunState.bufferedAgentEvents.get(key);
      if (!buffered) {
        return [];
      }
      return [{ key, buffered }];
    });
    bufferedEntries.sort((a, b) => a.buffered.payload.seq - b.buffered.payload.seq);
    for (const { key, buffered } of bufferedEntries) {
      sendAgentPayload(buffered.sessionKey, buffered.payload);
      chatRunState.bufferedAgentEvents.delete(key);
      chatRunState.agentDeltaSentAt.set(key, Date.now());
    }
    return bufferedEntries.length > 0;
  };

  const resolveAgentTextThrottleStream = (
    evt: AgentEventPayload,
  ): AgentTextThrottleStream | null => {
    if (evt.stream === "assistant") {
      return "assistant";
    }
    if (evt.stream === "thinking") {
      return "thinking";
    }
    return null;
  };

  const isAgentTextThrottleEvent = (evt: AgentEventPayload) =>
    resolveAgentTextThrottleStream(evt) !== null && typeof evt.data?.text === "string";

  const shouldCoalesceAgentTextEvent = (evt: AgentEventPayload) =>
    isAgentTextThrottleEvent(evt) &&
    typeof evt.data.delta === "string" &&
    evt.data.delta.length > 0 &&
    !(Array.isArray(evt.data.mediaUrls) && evt.data.mediaUrls.length > 0) &&
    typeof evt.data.mediaUrl !== "string" &&
    evt.data.replace !== true &&
    (evt.stream !== "assistant" || !shouldSuppressAssistantEventForLiveChat(evt.data));

  const shouldAdvanceAgentTextThrottle = (evt: AgentEventPayload) =>
    isAgentTextThrottleEvent(evt) &&
    (typeof evt.data.delta === "string" || evt.data.replace === true);

  const buildBufferedAgentEvent = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
  ): BufferedAgentEvent => (sessionKey ? { sessionKey, payload } : { payload });

  const mergeBufferedAgentPayload = (
    previous: BufferedAgentEvent,
    next: BufferedAgentEvent,
  ): BufferedAgentEvent => {
    if (previous.payload.stream !== next.payload.stream) {
      return next;
    }
    const previousDelta = previous.payload.data.delta;
    const nextDelta = next.payload.data.delta;
    if (typeof previousDelta !== "string" || typeof nextDelta !== "string") {
      return next;
    }
    return {
      ...next,
      payload: {
        ...next.payload,
        data: {
          ...next.payload.data,
          delta: `${previousDelta}${nextDelta}`,
        },
      },
    };
  };

  const sendOrBufferAgentTextEvent = (
    clientRunId: string,
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
  ) => {
    const stream = resolveAgentTextThrottleStream(payload);
    if (!stream) {
      sendAgentPayload(sessionKey, payload);
      return;
    }
    const now = Date.now();
    const key = agentTextThrottleKey(clientRunId, stream);
    const last = chatRunState.agentDeltaSentAt.get(key);
    if (last !== undefined && now - last < 150) {
      const nextBuffered = buildBufferedAgentEvent(sessionKey, payload);
      const buffered = chatRunState.bufferedAgentEvents.get(key);
      chatRunState.bufferedAgentEvents.set(
        key,
        buffered ? mergeBufferedAgentPayload(buffered, nextBuffered) : nextBuffered,
      );
      return;
    }
    flushBufferedAgentDeltaIfNeeded(clientRunId);
    sendAgentPayload(sessionKey, payload);
    chatRunState.agentDeltaSentAt.set(key, now);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (!sessionKey) {
      return runVerbose ?? "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      const sessionUpdatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : undefined;
      const sessionChangedAfterRunStarted =
        sessionUpdatedAt !== undefined &&
        runContext?.registeredAt !== undefined &&
        sessionUpdatedAt >= runContext.registeredAt;
      if (sessionVerbose && (!runVerbose || sessionChangedAfterRunStarted)) {
        return sessionVerbose;
      }
      if (runVerbose) {
        return runVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return runVerbose ?? "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (evt.stream !== "lifecycle" || lifecyclePhase !== "error") {
      clearPendingTerminalLifecycleError(evt.runId);
    }

    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const runContext = getAgentRunContext(evt.runId);
    const isControlUiVisible = runContext?.isControlUiVisible ?? true;
    const isHeartbeat = runContext?.isHeartbeat;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const spawnedBy = sessionKey ? resolveSpawnedBy(sessionKey) : null;
    const agentPayload = sessionKey
      ? {
          ...eventForClients,
          sessionKey,
          ...(spawnedBy && { spawnedBy }),
          ...(isHeartbeat !== undefined && { isHeartbeat }),
        }
      : {
          ...eventForClients,
          ...(isHeartbeat !== undefined && { isHeartbeat }),
        };
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const isItemEvent = evt.stream === "item";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    const suppressHeartbeatToolEvents =
      isToolEvent && shouldSuppressHeartbeatToolEvents(clientRunId, evt.runId);
    const shouldCoalesceAgentEvent = shouldCoalesceAgentTextEvent(evt);
    // Channel/node subscribers respect verbose; authenticated Control UI
    // recipients need tool result payloads to render live tool cards.
    const channelToolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return { ...agentPayload, data };
          })()
        : agentPayload;
    if (last > 0 && evt.seq !== last + 1 && isControlUiVisible) {
      flushBufferedAgentDeltaIfNeeded(clientRunId);
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        ...(spawnedBy && { spawnedBy }),
        ...(isHeartbeat !== undefined && { isHeartbeat }),
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      const toolPhase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      // Flush pending assistant text before tool-start events so clients can
      // render complete pre-tool text above tool cards (not truncated by delta throttle).
      if (
        toolPhase === "start" &&
        isControlUiVisible &&
        sessionKey &&
        !isAborted &&
        !suppressHeartbeatToolEvents
      ) {
        flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (isControlUiVisible && !suppressHeartbeatToolEvents && recipients && recipients.size > 0) {
        broadcastToConnIds(
          "agent",
          sessionKey ? { ...agentPayload, ...buildSessionEventSnapshot(sessionKey) } : agentPayload,
          recipients,
        );
      }
      // Session subscribers power operator UIs that attach to an existing
      // in-flight session after the run has already started. Those clients do
      // not know the runId in advance, so they cannot register as run-scoped
      // tool recipients. Mirror tool lifecycle onto a session-scoped event so
      // they can render live pending tool cards without polling history.
      if (isControlUiVisible && sessionKey && !suppressHeartbeatToolEvents) {
        const sessionSubscribers = sessionEventSubscribers.getAll();
        if (sessionSubscribers.size > 0) {
          broadcastToConnIds(
            "session.tool",
            { ...agentPayload, ...buildSessionEventSnapshot(sessionKey) },
            sessionSubscribers,
            { dropIfSlow: true },
          );
        }
      }
    } else {
      const itemPhase = isItemEvent && typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (itemPhase === "start" && isControlUiVisible && !isAborted) {
        if (sessionKey) {
          flushBufferedChatDeltaIfNeeded(sessionKey, clientRunId, evt.runId, evt.seq);
        }
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      if (isControlUiVisible) {
        if (shouldCoalesceAgentEvent) {
          sendOrBufferAgentTextEvent(clientRunId, sessionKey, agentPayload);
        } else {
          flushBufferedAgentDeltaIfNeeded(clientRunId);
          sendAgentPayload(sessionKey, agentPayload);
          const textThrottleStream = resolveAgentTextThrottleStream(evt);
          if (textThrottleStream && shouldAdvanceAgentTextThrottle(evt)) {
            chatRunState.agentDeltaSentAt.set(
              agentTextThrottleKey(clientRunId, textThrottleStream),
              Date.now(),
            );
          }
        }
      }
    }

    if (isControlUiVisible && sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (isToolEvent && !suppressHeartbeatToolEvents && toolVerbose !== "off") {
        nodeSendToSession(
          sessionKey,
          "agent",
          projectToolSearchCodeEventForChannelPayload({
            ...channelToolPayload,
            ...buildSessionEventSnapshot(sessionKey),
          }),
        );
      }
      if (
        !isAborted &&
        evt.stream === "assistant" &&
        typeof evt.data?.text === "string" &&
        !shouldSuppressAssistantEventForLiveChat(evt.data)
      ) {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text, evt.data.delta);
      }
    }

    if (lifecyclePhase === "error") {
      clearBufferedChatState(clientRunId);
      const skipChatErrorFinal = isChatSendRunActive(evt.runId) && !chatLink;
      if (isAborted || lifecycleErrorRetryGraceMs <= 0) {
        finalizeLifecycleEvent(evt, { skipChatErrorFinal });
      } else {
        scheduleTerminalLifecycleError(evt, { skipChatErrorFinal });
      }
      return;
    }

    if (lifecyclePhase === "end") {
      finalizeLifecycleEvent(evt);
      return;
    }

    if (sessionKey && lifecyclePhase === "start") {
      void persistGatewaySessionLifecycleEvent({ sessionKey, event: evt }).catch(() => undefined);
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (sessionEventConnIds.size > 0) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            phase: lifecyclePhase,
            runId: evt.runId,
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };
}
