// Gateway chat runtime projects agent events into chat/session subscriber
// streams, lifecycle persistence, heartbeat visibility, and live UI updates.
import { performance } from "node:perf_hooks";
import type {
  ChatEvent,
  ChatRunStartupPhase,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { isActiveEmbeddedRunId } from "../agents/embedded-agent-runner/runs.js";
import { isTimeoutError, resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import { resolveToolSearchCodeDisplayTarget } from "../agents/tool-display-common.js";
import { readToolValidationErrorSummary } from "../agents/tool-error-summary.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { normalizeAgentPlanSteps } from "../channels/streaming.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  type AgentEventPayload,
  type AgentEventRuntimePayload,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { getAgentRunContext, getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { logError } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseCronRunScopeSuffix,
} from "../sessions/session-key-utils.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import {
  projectLiveAssistantBufferedText,
  resolveAssistantLiveChatInput,
  resolveMergedAssistantText,
  shouldSuppressAssistantEventForLiveChat,
} from "./live-chat-projector.js";
import type { GatewayBroadcastFn, GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { isChatAbortMarkerCurrent } from "./server-chat-state.js";
import type {
  BufferedAgentEvent,
  ChatRunEntry,
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import {
  isRestartRecoveryLifecycleEvent,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";
import {
  loadGatewaySessionEntryReadOnly,
  loadGatewaySessionLifecycleSnapshot,
} from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

export {
  createChatAbortMarker,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
export type {
  ChatAbortMarker,
  ChatRunEntry,
  ChatRunRegistry,
  ChatRunRegistration,
  ChatRunState,
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
  ToolEventRecipientRegistry,
} from "./server-chat-state.js";

const CHAT_STATE_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "error",
  cancellation: "aborted",
  failure: "error",
} as const;
const RESTART_RECOVERY_LIFECYCLE_PHASES = new Set(["start", "end", "error"]);

function readChatRunStartupPhase(value: unknown): ChatRunStartupPhase | undefined {
  switch (value) {
    case "preparing_workspace":
    case "naming_worktree":
    case "creating_worktree":
    case "running_setup":
    case "provisioning_environment":
    case "preparing_context":
    case "starting_model":
      return value;
    default:
      return undefined;
  }
}

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

function shouldMirrorAssistantEventToHiddenSessionMessages(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const record = data as { text?: unknown; delta?: unknown };
  const hasText = typeof record.text === "string" && record.text.length > 0;
  const hasDelta = typeof record.delta === "string" && record.delta.length > 0;
  if (!hasText && !hasDelta) {
    return false;
  }
  return resolveAssistantEventPhase(data) === "commentary";
}

function shouldMirrorAgentEventToHiddenSessionMessages(evt: AgentEventPayload): boolean {
  return evt.stream === "thinking" || evt.stream === "approval" || evt.stream === "lifecycle";
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
    maxAckChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
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
const LIVE_TEXT_PACING_MS = 75;

export type ChatEventBroadcast = GatewayBroadcastFn;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

// Derived from ChatErrorEventSchema.errorKind (gateway-protocol); keep set in sync.
type ChatErrorKind = NonNullable<Extract<ChatEvent, { state: "error" }>["errorKind"]>;

const CHAT_ERROR_KINDS = new Set<ChatErrorKind>([
  "refusal",
  "timeout",
  "rate_limit",
  "context_length",
  "unknown",
]);

const CHAT_ERROR_KIND_BY_FAILOVER_REASON = {
  auth: undefined,
  auth_permanent: undefined,
  format: undefined,
  rate_limit: "rate_limit",
  overloaded: "rate_limit",
  billing: undefined,
  server_error: undefined,
  timeout: undefined,
  tls_certificate: undefined,
  context_overflow: "context_length",
  model_not_found: undefined,
  session_expired: undefined,
  empty_response: undefined,
  no_error_details: undefined,
  unclassified: undefined,
  unknown: undefined,
} satisfies Record<FailoverReason, ChatErrorKind | undefined>;

function readChatErrorKind(value: unknown): ChatErrorKind | undefined {
  return typeof value === "string" && CHAT_ERROR_KINDS.has(value as ChatErrorKind)
    ? (value as ChatErrorKind)
    : undefined;
}

// Refusal first (stop-reason fact, not FailoverReason); then canonical failover map.
export function resolveChatErrorKindFromError(error: unknown): ChatErrorKind | undefined {
  if (error === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(error).toLowerCase();
  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  const reason = resolveFailoverReasonFromError(error);
  if (reason) {
    const errorKind = CHAT_ERROR_KIND_BY_FAILOVER_REASON[reason];
    if (errorKind) {
      return errorKind;
    }
  }
  // FailoverReason "timeout" is the retryable-transient bucket and deliberately
  // swallows generic 5xx; only genuinely timeout-shaped errors get the badge.
  return isTimeoutError(error) ? "timeout" : undefined;
}

function excludeConnIds(
  connIds: ReadonlySet<string>,
  excludedConnIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (!excludedConnIds || excludedConnIds.size === 0 || connIds.size === 0) {
    return connIds;
  }
  const filtered = new Set<string>();
  for (const connId of connIds) {
    if (!excludedConnIds.has(connId)) {
      filtered.add(connId);
    }
  }
  return filtered;
}

type BroadcastDelta = { deltaText: string; replace?: true };

function resolveBroadcastDelta(params: {
  text: string;
  previousBroadcastText: string | undefined;
}): BroadcastDelta | undefined {
  const previous = params.previousBroadcastText;
  if (previous === undefined) {
    return params.text ? { deltaText: params.text } : undefined;
  }
  if (!params.text.startsWith(previous)) {
    return { deltaText: params.text, replace: true };
  }
  const deltaText = params.text.slice(previous.length);
  return deltaText ? { deltaText } : undefined;
}

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string, options?: { agentId?: string }) => string | undefined;
  clearAgentRunContext: (
    runId: string,
    lifecycleGeneration?: string,
    contextClaimId?: string,
  ) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  loadGatewaySessionLifecycleSnapshotForEvent?: typeof loadGatewaySessionLifecycleSnapshot;
  persistGatewaySessionLifecycleEventForEvent?: typeof persistGatewaySessionLifecycleEvent;
  lifecycleErrorRetryGraceMs?: number;
  isChatSendRunActive?: (runId: string) => boolean;
  clearTrackedActiveRun?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
  }) => void;
  settleTrackedTerminal?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
    persisted?: boolean;
  }) => void;
  trackTrackedRunTerminalPersistence?: (params: {
    runId: string;
    clientRunId: string;
    sessionKey: string;
    sessionId?: string;
    observedAt: number;
    persistence: Promise<void>;
  }) => void;
  resolveActiveLifecycleGenerationForRun?: (runId: string) => string | undefined;
  updateRunToolErrorSummary?: (params: {
    runId: string;
    clientRunId: string;
    summary: string | undefined;
  }) => void;
  resolveSessionActiveRunState?: (params: {
    requestedKey: string;
    canonicalKey: string;
    sessionId?: string;
    agentId?: string;
  }) => { active: boolean; runIds?: string[] };
};

type AgentEventHandler = ((event: AgentEventPayload) => void) & {
  dispose: () => void;
};

const AGENT_TEXT_THROTTLE_STREAMS = ["assistant", "thinking"] as const;

type AgentTextThrottleStream = (typeof AGENT_TEXT_THROTTLE_STREAMS)[number];
type LiveTextStream = "chat" | "agent";
type PendingLiveTextFlush = { timer: NodeJS.Timeout; flush: () => void };
type InternalChatRunRecord = ReturnType<ChatRunState["getOrCreate"]> & {
  pendingTextFlushes?: Partial<Record<LiveTextStream, PendingLiveTextFlush>>;
};

function internalChatRunRecord(
  record: ReturnType<ChatRunState["getOrCreate"]>,
): InternalChatRunRecord {
  return record;
}

function cancelPendingLiveTextFlush(run: InternalChatRunRecord, stream: LiveTextStream): void {
  const pending = run.pendingTextFlushes?.[stream];
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  delete run.pendingTextFlushes?.[stream];
  if (run.pendingTextFlushes && Object.keys(run.pendingTextFlushes).length === 0) {
    delete run.pendingTextFlushes;
  }
}

function scheduleLiveTextFlush(
  run: InternalChatRunRecord,
  stream: LiveTextStream,
  delayMs: number,
  flush: () => void,
): void {
  const pendingFlushes = (run.pendingTextFlushes ??= {});
  const existing = pendingFlushes[stream];
  if (existing) {
    existing.flush = flush;
    return;
  }
  const timer = setSafeTimeout(() => {
    const pending = run.pendingTextFlushes?.[stream];
    if (!pending || pending.timer !== timer) {
      return;
    }
    cancelPendingLiveTextFlush(run, stream);
    pending.flush();
  }, delayMs);
  timer.unref?.();
  pendingFlushes[stream] = { timer, flush };
}

function roundedChatSendTimingMs(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

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
  sessionMessageSubscribers,
  loadGatewaySessionLifecycleSnapshotForEvent = loadGatewaySessionLifecycleSnapshot,
  persistGatewaySessionLifecycleEventForEvent = persistGatewaySessionLifecycleEvent,
  lifecycleErrorRetryGraceMs = AGENT_LIFECYCLE_ERROR_RETRY_GRACE_MS,
  isChatSendRunActive = () => false,
  clearTrackedActiveRun,
  settleTrackedTerminal,
  trackTrackedRunTerminalPersistence,
  resolveActiveLifecycleGenerationForRun = () => undefined,
  updateRunToolErrorSummary,
  resolveSessionActiveRunState,
}: AgentEventHandlerOptions): AgentEventHandler {
  const shouldProcessOwnedEvent = (evt: AgentEventRuntimePayload): boolean => {
    const claimId = evt.contextClaimId;
    if (!claimId) {
      return true;
    }
    const lifecycleGeneration = evt.lifecycleGeneration;
    if (!lifecycleGeneration || lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      return false;
    }
    // A missing claim means detach or supersession revoked this terminal event.
    return getAgentRunContextOwnerStatus(evt.runId, claimId, lifecycleGeneration) === "active";
  };
  const clearRunContextForEvent = (evt: AgentEventRuntimePayload): void => {
    if (evt.contextClaimId) {
      clearAgentRunContext(evt.runId, evt.lifecycleGeneration, evt.contextClaimId);
      return;
    }
    clearAgentRunContext(evt.runId);
  };
  const resolveEventSession = (evt: AgentEventRuntimePayload) => {
    const chatLink = evt.contextClaimId ? undefined : chatRunState.registry.peek(evt.runId);
    const sessionAgentId = chatLink?.agentId ?? evt.agentId;
    const eventSessionKey =
      evt.deliverySessionKey ??
      (typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined);
    const sessionKey =
      chatLink?.sessionKey ??
      eventSessionKey ??
      getAgentRunContext(evt.runId)?.sessionKey ??
      resolveSessionKeyForRun(evt.runId, sessionAgentId ? { agentId: sessionAgentId } : undefined);
    return { chatLink, sessionAgentId, eventSessionKey, sessionKey };
  };

  type TerminalLifecycleOptions = {
    skipChatErrorFinal?: boolean;
    suppressRestartRecoveryProjection?: boolean;
    restartRecoveryState?: { suppress: boolean };
  };
  type PendingTerminalLifecycleError = {
    timer: NodeJS.Timeout;
    event: AgentEventRuntimePayload;
    opts?: TerminalLifecycleOptions;
  };

  const pendingTerminalLifecycleErrors = new Map<string, PendingTerminalLifecycleError>();

  const cancelPendingChatDeltaFlush = (clientRunId: string) => {
    const record = chatRunState.runs.get(clientRunId);
    if (record) {
      cancelPendingLiveTextFlush(internalChatRunRecord(record), "chat");
    }
  };

  const clearPendingTerminalLifecycleError = (runId: string, lifecycleGeneration?: string) => {
    const pending = pendingTerminalLifecycleErrors.get(runId);
    if (!pending) {
      return;
    }
    if (
      lifecycleGeneration &&
      pending.event.lifecycleGeneration &&
      lifecycleGeneration !== pending.event.lifecycleGeneration
    ) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminalLifecycleErrors.delete(runId);
  };

  const resolveRestartRecoveryLifecycleState = (
    sessionKey: string,
    agentId: string | undefined,
    event: AgentEventPayload,
  ): { suppress: boolean } => {
    try {
      const { entry } = loadGatewaySessionEntryReadOnly(sessionKey, {
        ...(agentId ? { agentId } : {}),
        clone: false,
      });
      return { suppress: isRestartRecoveryLifecycleEvent({ entry, event }) };
    } catch {
      return { suppress: false };
    }
  };

  // Native, ACP, and spawn-owned dashboard sessions can carry spawnedBy.
  // Short-circuit everyone else so high-volume chat streams do not touch the
  // session store. Results are cached per sessionKey because
  // spawnedBy is immutable once set and resolveSpawnedBy sits on the hot event
  // path (delta, flush, final, agent, seq-gap).
  const spawnedByCache = new Map<string, string | null>();
  const resolveSpawnedBy = (sessionKey: string): string | null => {
    if (spawnedByCache.has(sessionKey)) {
      return spawnedByCache.get(sessionKey)!;
    }
    // Non-lineage keys return null without polluting the cache; only eligible
    // child-session results (positive or null) are worth memoising.
    const isDashboardSession =
      parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:") === true;
    if (!isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey) && !isDashboardSession) {
      return null;
    }
    let result: string | null = null;
    try {
      result = loadGatewaySessionLifecycleSnapshotForEvent(sessionKey).row?.spawnedBy ?? null;
    } catch {
      // result stays null
    }
    spawnedByCache.set(sessionKey, result);
    return result;
  };

  const buildSessionEventSnapshot = (
    sessionKey: string,
    evt?: AgentEventPayload,
    agentId?: string,
    includeActiveRunState = false,
    lifecycleProjection = false,
  ) => {
    const snapshotOptions = agentId ? { agentId } : undefined;
    const lifecycleSnapshot = loadGatewaySessionLifecycleSnapshotForEvent(
      sessionKey,
      snapshotOptions,
    );
    const { lifecycleRunId, row } = lifecycleSnapshot;
    const activeRunState = includeActiveRunState
      ? resolveSessionActiveRunState?.({
          requestedKey: sessionKey,
          canonicalKey: row?.key ?? sessionKey,
          ...(row?.sessionId ? { sessionId: row.sessionId } : {}),
          ...(agentId ? { agentId } : {}),
        })
      : undefined;
    return buildGatewaySessionSnapshot({
      sessionRow: row,
      agentId,
      includeSession: true,
      lifecycle: lifecycleProjection,
      event: evt,
      lifecycleRunId,
      activeRunState,
    });
  };

  const resolveSessionDeliveryKeys = (sessionKey: string, agentId?: string) => {
    if (sessionKey.trim().toLowerCase() !== "global") {
      return [sessionKey];
    }
    const compatibilityOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(
      getRuntimeConfig(),
      sessionKey,
    );
    const deliveryAgentId = agentId ?? compatibilityOwnerAgentId;
    return deliveryAgentId
      ? resolveSessionSubscriptionKeys(sessionKey, deliveryAgentId, compatibilityOwnerAgentId)
      : [];
  };
  const sendNodeSessionPayloadForAgent = (
    sessionKey: string,
    event: string,
    payload: unknown,
    agentId?: string,
  ) => {
    for (const deliverySessionKey of resolveSessionDeliveryKeys(sessionKey, agentId)) {
      nodeSendToSession(deliverySessionKey, event, payload);
    }
  };

  const emitFirstAssistantChatSendTiming = (chatLink: ChatRunEntry | undefined) => {
    const timing = chatLink?.chatSendTiming;
    if (!timing || timing.firstAssistantEventSent) {
      return;
    }
    timing.firstAssistantEventSent = true;
    const nowMs = performance.now();
    broadcastToConnIds(
      "chat.send_timing",
      {
        phase: "first-assistant-event",
        runId: chatLink.clientRunId,
        sessionKey: chatLink.sessionKey,
        ...(chatLink.agentId ? { agentId: chatLink.agentId } : {}),
        ackToPhaseMs: roundedChatSendTimingMs(nowMs - timing.ackedAtMs),
        receivedToPhaseMs: roundedChatSendTimingMs(nowMs - timing.receivedAtMs),
        ...(timing.dispatchStartedAtMs !== undefined
          ? {
              dispatchStartedToPhaseMs: roundedChatSendTimingMs(nowMs - timing.dispatchStartedAtMs),
            }
          : {}),
      },
      new Set([timing.connId]),
      { dropIfSlow: true },
    );
  };

  const finalizeLifecycleEvent = (
    evt: AgentEventRuntimePayload,
    opts?: TerminalLifecycleOptions,
  ) => {
    if (!shouldProcessOwnedEvent(evt)) {
      return;
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (lifecyclePhase !== "end" && lifecyclePhase !== "error") {
      return;
    }

    const currentRunContext = getAgentRunContext(evt.runId);
    const activeLifecycleGeneration = resolveActiveLifecycleGenerationForRun(evt.runId);
    const currentLifecycleGeneration =
      activeLifecycleGeneration ?? currentRunContext?.lifecycleGeneration;

    const { chatLink, sessionAgentId, eventSessionKey, sessionKey } = resolveEventSession(evt);
    const isControlUiVisible =
      evt.controlUiVisible ?? currentRunContext?.isControlUiVisible ?? true;
    const projectSessionLifecycle =
      evt.projectSessionLifecycle ?? currentRunContext?.projectSessionLifecycle ?? true;
    const projectSessionMessages =
      evt.projectSessionMessages ?? currentRunContext?.projectSessionMessages ?? true;
    const restartRecoverySessionKey = eventSessionKey ?? sessionKey;
    const restartRecoveryAgentId = evt.agentId ?? sessionAgentId;
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const isAborted =
      isChatAbortMarkerCurrent(chatRunState.runs.get(clientRunId)?.abortMarker, chatLink) ||
      isChatAbortMarkerCurrent(chatRunState.runs.get(evt.runId)?.abortMarker, chatLink);
    const lifecycleAborted = evt.data?.aborted === true;
    const replyDispatchOwnsCompletion = evt.data?.completionSource === "reply-dispatch";
    const deliverySessionKeys = sessionKey
      ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
      : [];
    const restartRecoveryState =
      opts?.restartRecoveryState ??
      (restartRecoverySessionKey
        ? resolveRestartRecoveryLifecycleState(
            restartRecoverySessionKey,
            restartRecoveryAgentId,
            evt,
          )
        : undefined);
    const suppressRestartRecoveryProjection =
      opts?.suppressRestartRecoveryProjection === true ||
      Boolean(
        evt.lifecycleGeneration &&
        activeLifecycleGeneration &&
        evt.lifecycleGeneration !== activeLifecycleGeneration,
      ) ||
      restartRecoveryState?.suppress === true;
    const isSupersededRestartRecoveryEvent =
      suppressRestartRecoveryProjection &&
      Boolean(
        evt.lifecycleGeneration &&
        currentLifecycleGeneration &&
        evt.lifecycleGeneration !== currentLifecycleGeneration,
      );
    if (isSupersededRestartRecoveryEvent) {
      return;
    }
    let terminalPersistence: Promise<void> | undefined;

    if (
      !replyDispatchOwnsCompletion &&
      !suppressRestartRecoveryProjection &&
      sessionKey &&
      (isControlUiVisible ||
        (projectSessionMessages &&
          deliverySessionKeys.some(
            (deliverySessionKey) => sessionMessageSubscribers.get(deliverySessionKey).size > 0,
          )))
    ) {
      if (!isAborted) {
        // peek() (chatLink) and this shift() run in one synchronous frame, so
        // the shifted head is exactly the peeked entry.
        const finished = chatLink ? chatRunState.registry.shift(evt.runId) : undefined;
        const terminalSessionKey = finished?.sessionKey ?? sessionKey;
        const terminalRunId = finished?.clientRunId ?? eventRunId;
        const terminalAgentId = finished?.agentId ?? sessionAgentId;
        const terminalOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase: lifecyclePhase,
          data: evt.data,
          endedAt: evt.data?.endedAt ?? evt.ts,
        });
        const yieldedWaiting = isAgentLifecycleYieldedWaiting({
          phase: lifecyclePhase,
          yielded: evt.data?.yielded,
          livenessState: evt.data?.livenessState,
          stopReason: terminalOutcome.stopReason,
          aborted: lifecycleAborted,
          status: evt.data?.status,
          timeoutPhase: evt.data?.timeoutPhase,
          error: evt.data?.error,
        });
        const terminalClassification = classifyAgentRunTerminalOutcome(terminalOutcome);
        const terminalState = CHAT_STATE_BY_TERMINAL_CLASSIFICATION[terminalClassification];
        if (!(opts?.skipChatErrorFinal && terminalState === "error")) {
          emitChatTerminal(
            terminalSessionKey,
            terminalRunId,
            evt.runId,
            evt.seq,
            terminalState,
            terminalOutcome.error ?? evt.data?.error,
            terminalOutcome.stopReason,
            // Timeout is a recorded classification, not event metadata: the
            // lifecycle producer emits no errorKind, so without this the UI
            // shows a generic "failed" while sessions.list says "timeout".
            terminalClassification === "timeout"
              ? "timeout"
              : (readChatErrorKind(evt.data?.errorKind) ??
                  resolveChatErrorKindFromError(evt.data?.error)),
            {
              agentId: terminalAgentId,
              controlUiVisible: isControlUiVisible,
              firstAssistantTimingEntry: finished,
              abortErrorMessage: readToolValidationErrorSummary(evt.data?.toolErrorSummary),
              yielded: yieldedWaiting ? true : undefined,
            },
          );
        }
      } else if (chatLink) {
        chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
      }
    }

    toolEventRecipients.markFinal(evt.runId);
    // Payload dispatch owns its chat terminal and registration until delivery
    // settles; lifecycle observers still receive the runtime's terminal below.
    if (!replyDispatchOwnsCompletion) {
      chatRunState.clearRun(clientRunId);
      if (suppressRestartRecoveryProjection && chatLink) {
        chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
      }
      if (!evt.contextClaimId) {
        clearRunContextForEvent(evt);
      }
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }

    if (sessionKey) {
      clearTrackedActiveRun?.({ runId: evt.runId, clientRunId, sessionKey });
      if (!suppressRestartRecoveryProjection && projectSessionLifecycle) {
        const persistence = persistGatewaySessionLifecycleEventForEvent({
          sessionKey,
          agentId: sessionAgentId,
          event: {
            ...evt,
            ...(evt.contextClaimId ? { contextClaimId: evt.contextClaimId } : {}),
            ...(eventRunId !== evt.runId ? { clientRunId: eventRunId } : {}),
            ...(evt.lifecycleGeneration ? { lifecycleGeneration: evt.lifecycleGeneration } : {}),
            ...(evt.mainSessionRestartRecovery === true
              ? { mainSessionRestartRecovery: true as const }
              : {}),
          },
        });
        terminalPersistence = persistence;
        trackTrackedRunTerminalPersistence?.({
          runId: evt.runId,
          clientRunId,
          sessionKey,
          sessionId: evt.sessionId,
          observedAt: evt.ts,
          persistence,
        });
        const broadcastSessionChange = (snapshotEvent?: AgentEventPayload) => {
          if (parseCronRunScopeSuffix(sessionKey).runId) {
            return;
          }
          const sessionEventConnIds = sessionEventSubscribers.getAll();
          if (!hasSessionChangeReceivers(sessionEventConnIds)) {
            return;
          }
          broadcastToConnIds(
            "sessions.changed",
            {
              sessionKey,
              ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
              phase: lifecyclePhase,
              runId: evt.runId,
              ...(eventRunId !== evt.runId ? { clientRunId: eventRunId } : {}),
              ts: evt.ts,
              ...buildSessionEventSnapshot(sessionKey, snapshotEvent, sessionAgentId, true, true),
            },
            sessionEventConnIds,
            { dropIfSlow: true },
          );
        };
        // Terminal writes serialize with restart markers. Reload only after the
        // write so subscribers see the canonical post-race session state.
        void persistence
          .then(() => {
            settleTrackedTerminal?.({
              runId: evt.runId,
              clientRunId,
              sessionKey,
            });
            broadcastSessionChange();
          })
          .catch((err: unknown) => {
            logError(
              `gateway: terminal session persistence failed session=${formatForLog(sessionKey)} run=${formatForLog(evt.runId)} error=${formatForLog(err)}`,
            );
            // Persistence recovery remains tracked by the controller entry, but
            // subscribers still need a terminal projection instead of hanging.
            settleTrackedTerminal?.({
              runId: evt.runId,
              clientRunId,
              sessionKey,
              persisted: false,
            });
            broadcastSessionChange(evt);
          });
      } else {
        settleTrackedTerminal?.({
          runId: evt.runId,
          clientRunId,
          sessionKey,
          persisted: false,
        });
      }
    }
    if (!replyDispatchOwnsCompletion && evt.contextClaimId) {
      // The queued write's commit guard requires this exact claim to stay active.
      // Abort or replacement can still revoke it before the write settles.
      if (terminalPersistence) {
        const clearOwnedRunContext = () => clearRunContextForEvent(evt);
        void terminalPersistence.then(clearOwnedRunContext, clearOwnedRunContext);
      } else {
        clearRunContextForEvent(evt);
      }
    }
  };

  const scheduleTerminalLifecycleError = (
    evt: AgentEventRuntimePayload,
    opts?: TerminalLifecycleOptions,
  ) => {
    clearPendingTerminalLifecycleError(evt.runId);
    const timer = setSafeTimeout(() => {
      const pending = pendingTerminalLifecycleErrors.get(evt.runId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingTerminalLifecycleErrors.delete(evt.runId);
      finalizeLifecycleEvent(pending.event, pending.opts);
    }, lifecycleErrorRetryGraceMs);
    timer.unref?.();
    pendingTerminalLifecycleErrors.set(evt.runId, { timer, event: evt, opts });
  };

  const broadcastChatDelta = (
    sessionKey: string,
    agentId: string | undefined,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
    opts?: { controlUiVisible?: boolean; firstAssistantTimingEntry?: ChatRunEntry },
  ) => {
    cancelPendingChatDeltaFlush(clientRunId);
    const run = chatRunState.getOrCreate(clientRunId);
    const broadcastDelta = resolveBroadcastDelta({
      text,
      previousBroadcastText: run.deltaLastBroadcastText,
    });
    if (!broadcastDelta) {
      return;
    }
    const now = Date.now();
    run.deltaSentAt = now;
    run.deltaLastBroadcastText = text;
    const spawnedBy = resolveSpawnedBy(sessionKey);
    const payload = {
      runId: clientRunId,
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "delta" as const,
      deltaText: broadcastDelta.deltaText,
      ...(broadcastDelta.replace ? { replace: true as const } : {}),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    emitFirstAssistantChatSendTiming(
      opts?.firstAssistantTimingEntry ?? chatRunState.registry.peek(sourceRunId),
    );
    sendChatPayload(sessionKey, payload, {
      agentId,
      controlUiVisible: opts?.controlUiVisible ?? true,
      dropIfSlow: true,
    });
  };

  const scheduleChatDeltaFlush = (
    sessionKey: string,
    agentId: string | undefined,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    delayMs: number,
    controlUiVisible: boolean | undefined,
  ) => {
    const run = internalChatRunRecord(chatRunState.getOrCreate(clientRunId));
    const flush = () => {
      const projected = chatRunState.resolveBuffer(clientRunId);
      if (projected.suppress || shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
        return;
      }
      broadcastChatDelta(sessionKey, agentId, clientRunId, sourceRunId, seq, projected.text, {
        controlUiVisible,
      });
    };
    scheduleLiveTextFlush(run, "chat", delayMs, flush);
  };

  const emitChatDelta = (
    sessionKey: string,
    agentId: string | undefined,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    input: NonNullable<ReturnType<typeof resolveAssistantLiveChatInput>>,
    opts?: { controlUiVisible?: boolean },
  ) => {
    const run = chatRunState.getOrCreate(clientRunId);
    if (input.managedMediaUrls?.length) {
      const managedMediaUrls = (run.managedMediaUrls ??= new Set<string>());
      for (const url of input.managedMediaUrls) {
        managedMediaUrls.add(url);
      }
      delete run.bufferProjection;
    }
    const previousRawText = run.rawBuffer ?? "";
    if (!input.itemId) {
      delete run.assistantScope;
    } else if (run.assistantScope?.itemId !== input.itemId) {
      run.assistantScope = { itemId: input.itemId, prefix: previousRawText };
    }
    const mergedRawText = resolveMergedAssistantText({
      previousText: previousRawText,
      nextText: input.text,
      nextDelta: input.delta,
      scope: run.assistantScope,
    });
    if (!mergedRawText && !previousRawText) {
      return;
    }
    const now = Date.now();
    run.rawBuffer = mergedRawText;
    run.bufferUpdatedAt = now;
    if (!mergedRawText) {
      broadcastChatDelta(sessionKey, agentId, clientRunId, sourceRunId, seq, "", opts);
      return;
    }
    const waitedMs = now - (run.deltaSentAt ?? 0);
    if (waitedMs < LIVE_TEXT_PACING_MS) {
      scheduleChatDeltaFlush(
        sessionKey,
        agentId,
        clientRunId,
        sourceRunId,
        seq,
        LIVE_TEXT_PACING_MS - waitedMs,
        opts?.controlUiVisible,
      );
      return;
    }
    const projected = chatRunState.resolveBuffer(clientRunId);
    const mergedText = projected.text;
    if (projected.suppress || shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }
    broadcastChatDelta(sessionKey, agentId, clientRunId, sourceRunId, seq, mergedText, opts);
  };

  const resolveBufferedChatTextState = (
    clientRunId: string,
    sourceRunId: string,
    options?: { final?: boolean; suppressLeadFragments?: boolean },
  ) => {
    const bufferedText = chatRunState
      .resolveBuffer(clientRunId, { final: options?.final })
      .text.trim();
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
    agentId: string | undefined,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    opts?: { controlUiVisible?: boolean; firstAssistantTimingEntry?: ChatRunEntry },
    resolved?: { text: string; shouldSuppressSilent: boolean },
  ) => {
    cancelPendingChatDeltaFlush(clientRunId);
    const streamed = resolved
      ? projectLiveAssistantBufferedText(resolved.text, { suppressLeadFragments: true })
      : undefined;
    const { text, shouldSuppressSilent } = streamed
      ? {
          text: streamed.text.trim(),
          shouldSuppressSilent: resolved?.shouldSuppressSilent || streamed.suppress,
        }
      : resolveBufferedChatTextState(clientRunId, sourceRunId, {
          suppressLeadFragments: true,
        });
    const shouldSuppressHeartbeatStreaming = shouldHideHeartbeatChatOutput(
      clientRunId,
      sourceRunId,
    );
    if (!text || shouldSuppressSilent || shouldSuppressHeartbeatStreaming) {
      return;
    }

    broadcastChatDelta(sessionKey, agentId, clientRunId, sourceRunId, seq, text, opts);
  };

  const sendChatPayload = (
    sessionKey: string,
    payload: unknown,
    opts?: { agentId?: string; controlUiVisible?: boolean; dropIfSlow?: boolean },
  ) => {
    const deliverySessionKeys = resolveSessionDeliveryKeys(sessionKey, opts?.agentId);
    if (opts?.controlUiVisible ?? true) {
      broadcast("chat", payload, {
        dropIfSlow: opts?.dropIfSlow,
        sessionKeys: deliverySessionKeys,
      });
      sendNodeSessionPayloadForAgent(sessionKey, "chat", payload, opts?.agentId);
      return;
    }
    const recipients = new Set(
      deliverySessionKeys.flatMap((deliveryKey) => [...sessionMessageSubscribers.get(deliveryKey)]),
    );
    if (recipients.size > 0) {
      broadcastToConnIds("chat", payload, recipients, {
        dropIfSlow: opts?.dropIfSlow,
        sessionKeys: deliverySessionKeys,
      });
    }
  };

  const emitChatTerminal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error" | "aborted",
    error?: unknown,
    stopReason?: string,
    errorKind?: ChatErrorKind,
    opts?: {
      agentId?: string;
      controlUiVisible?: boolean;
      firstAssistantTimingEntry?: ChatRunEntry;
      abortErrorMessage?: string;
      yielded?: true;
    },
  ) => {
    const { text, shouldSuppressSilent } = resolveBufferedChatTextState(clientRunId, sourceRunId, {
      final: true,
      suppressLeadFragments: false,
    });
    // Flush any paced delta so streaming clients receive the complete text
    // before the final event.
    // Only flush if the buffered text differs from the last broadcast to avoid duplicates.
    flushBufferedChatDeltaIfNeeded(sessionKey, opts?.agentId, clientRunId, sourceRunId, seq, opts, {
      text,
      shouldSuppressSilent,
    });
    chatRunState.clearRun(clientRunId);
    const spawnedBy = resolveSpawnedBy(sessionKey);
    if (jobState !== "error") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(spawnedBy && { spawnedBy }),
        seq,
        state: jobState === "done" ? ("final" as const) : ("aborted" as const),
        ...(jobState === "aborted" && opts?.abortErrorMessage
          ? { errorMessage: opts.abortErrorMessage }
          : {}),
        ...(stopReason && { stopReason }),
        ...(jobState === "done" && opts?.yielded ? { yielded: true as const } : {}),
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      sendChatPayload(sessionKey, payload, opts);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      ...(spawnedBy && { spawnedBy }),
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
      ...(errorKind && { errorKind }),
      ...(stopReason && { stopReason }),
    };
    sendChatPayload(sessionKey, payload, opts);
  };

  const sendAgentPayload = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
    opts?: { agentId?: string; controlUiVisible?: boolean; dropIfSlow?: boolean },
  ) => {
    if (opts?.controlUiVisible ?? true) {
      broadcast("agent", payload, {
        sessionKeys: sessionKey ? resolveSessionDeliveryKeys(sessionKey, opts?.agentId) : undefined,
      });
      if (sessionKey) {
        sendNodeSessionPayloadForAgent(sessionKey, "agent", payload, opts?.agentId);
      }
      return;
    }
    if (!sessionKey) {
      return;
    }
    const deliverySessionKeys = resolveSessionDeliveryKeys(sessionKey, opts?.agentId);
    const recipients = new Set(
      deliverySessionKeys.flatMap((deliveryKey) => [...sessionMessageSubscribers.get(deliveryKey)]),
    );
    if (recipients.size > 0) {
      broadcastToConnIds("agent", payload, recipients, {
        dropIfSlow: opts?.dropIfSlow,
        sessionKeys: deliverySessionKeys,
      });
    }
  };

  const sendNodeAgentPayload = (
    sessionKey: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
    agentId?: string,
  ) => {
    if (sessionKey) {
      sendNodeSessionPayloadForAgent(sessionKey, "agent", payload, agentId);
    }
  };

  const flushBufferedAgentDeltaIfNeeded = (clientRunId: string) => {
    const run = chatRunState.runs.get(clientRunId);
    if (run) {
      cancelPendingLiveTextFlush(internalChatRunRecord(run), "agent");
    }
    const bufferedEntries = AGENT_TEXT_THROTTLE_STREAMS.flatMap((currentStream) => {
      const state = run?.agentText?.[currentStream];
      const buffered = state?.bufferedEvent;
      if (!buffered) {
        return [];
      }
      return [{ stream: currentStream, buffered }];
    });
    bufferedEntries.sort((a, b) => a.buffered.payload.seq - b.buffered.payload.seq);
    for (const { stream: currentStream, buffered } of bufferedEntries) {
      sendAgentPayload(buffered.sessionKey, buffered.payload, { agentId: buffered.agentId });
      const state = run?.agentText?.[currentStream];
      if (state) {
        delete state.bufferedEvent;
        state.lastSentAt = Date.now();
      }
    }
  };

  const resolveAgentTextThrottleStream = (
    evt: AgentEventPayload,
  ): AgentTextThrottleStream | null =>
    evt.stream === "assistant" ? "assistant" : evt.stream === "thinking" ? "thinking" : null;

  const shouldCoalesceAgentTextEvent = (evt: AgentEventPayload) =>
    resolveAgentTextThrottleStream(evt) !== null &&
    typeof evt.data?.text === "string" &&
    typeof evt.data.delta === "string" &&
    evt.data.delta.length > 0 &&
    !(Array.isArray(evt.data.mediaUrls) && evt.data.mediaUrls.length > 0) &&
    typeof evt.data.mediaUrl !== "string" &&
    evt.data.replace !== true &&
    (evt.stream !== "assistant" || !shouldSuppressAssistantEventForLiveChat(evt.data));

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
    agentId: string | undefined,
    payload: AgentEventPayload & { spawnedBy?: string },
  ) => {
    const stream = resolveAgentTextThrottleStream(payload);
    if (!stream) {
      sendAgentPayload(sessionKey, payload, { agentId });
      return;
    }
    const now = Date.now();
    const run = chatRunState.getOrCreate(clientRunId);
    const agentText = (run.agentText ??= {});
    const state = (agentText[stream] ??= {});
    const last = state.lastSentAt;
    if (last !== undefined && now - last < LIVE_TEXT_PACING_MS) {
      const nextBuffered: BufferedAgentEvent = sessionKey
        ? { sessionKey, agentId, payload }
        : { agentId, payload };
      state.bufferedEvent = state.bufferedEvent
        ? mergeBufferedAgentPayload(state.bufferedEvent, nextBuffered)
        : nextBuffered;
      scheduleLiveTextFlush(
        internalChatRunRecord(run),
        "agent",
        LIVE_TEXT_PACING_MS - (now - last),
        () => flushBufferedAgentDeltaIfNeeded(clientRunId),
      );
      return;
    }
    flushBufferedAgentDeltaIfNeeded(clientRunId);
    sendAgentPayload(sessionKey, payload, { agentId });
    state.lastSentAt = now;
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (!sessionKey) {
      return runVerbose ?? "off";
    }
    try {
      const { cfg, entry } = loadGatewaySessionEntryReadOnly(sessionKey);
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

  const handleEvent = (event: AgentEventPayload) => {
    const evt = event as AgentEventRuntimePayload;
    if (!shouldProcessOwnedEvent(evt)) {
      return;
    }
    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    const { chatLink, sessionAgentId, eventSessionKey, sessionKey } = resolveEventSession(evt);
    const runContext = getAgentRunContext(evt.runId);
    const activeLifecycleGeneration = resolveActiveLifecycleGenerationForRun(evt.runId);
    const isControlUiVisible = evt.controlUiVisible ?? runContext?.isControlUiVisible ?? true;
    const projectSessionLifecycle =
      evt.projectSessionLifecycle ?? runContext?.projectSessionLifecycle ?? true;
    const projectSessionMessages =
      evt.projectSessionMessages ?? runContext?.projectSessionMessages ?? true;
    const isHeartbeat = runContext?.isHeartbeat;
    const restartRecoverySessionKey = RESTART_RECOVERY_LIFECYCLE_PHASES.has(lifecyclePhase ?? "")
      ? (eventSessionKey ?? sessionKey)
      : undefined;
    const restartRecoveryAgentId = evt.agentId ?? sessionAgentId;
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      isChatAbortMarkerCurrent(chatRunState.runs.get(clientRunId)?.abortMarker, chatLink) ||
      isChatAbortMarkerCurrent(chatRunState.runs.get(evt.runId)?.abortMarker, chatLink);
    const recordsEmbeddedProgress = !chatLink && isActiveEmbeddedRunId(evt.runId);
    const recordsInFlightProgress =
      (Boolean(chatLink) && isControlUiVisible) || recordsEmbeddedProgress;

    const restartRecoveryState = restartRecoverySessionKey
      ? resolveRestartRecoveryLifecycleState(restartRecoverySessionKey, restartRecoveryAgentId, evt)
      : undefined;
    const suppressRestartRecoveryLifecycle =
      lifecyclePhase !== null &&
      (Boolean(
        evt.lifecycleGeneration &&
        activeLifecycleGeneration &&
        evt.lifecycleGeneration !== activeLifecycleGeneration,
      ) ||
        restartRecoveryState?.suppress === true);
    if (suppressRestartRecoveryLifecycle) {
      clearPendingTerminalLifecycleError(evt.runId, evt.lifecycleGeneration);
      if (lifecyclePhase === "end" || lifecyclePhase === "error") {
        finalizeLifecycleEvent(evt, {
          suppressRestartRecoveryProjection: true,
          restartRecoveryState,
        });
      }
      return;
    }
    if (lifecyclePhase !== null && lifecyclePhase !== "error") {
      clearPendingTerminalLifecycleError(evt.runId);
    }

    // Include sessionKey so Control UI can filter tool streams per session.
    const spawnedBy = sessionKey ? resolveSpawnedBy(sessionKey) : null;
    const agentPayload = sessionKey
      ? {
          ...eventForClients,
          sessionKey,
          ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
          ...(spawnedBy && { spawnedBy }),
          ...(isHeartbeat !== undefined && { isHeartbeat }),
        }
      : {
          ...eventForClients,
          ...(isHeartbeat !== undefined && { isHeartbeat }),
        };
    const hasSessionMessageSubscribers =
      projectSessionMessages && sessionKey
        ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId).some(
            (deliverySessionKey) => sessionMessageSubscribers.get(deliverySessionKey).size > 0,
          )
        : false;
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
      broadcast(
        "agent",
        {
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
        },
        {
          sessionKeys: sessionKey
            ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
            : undefined,
        },
      );
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (evt.stream === "assistant") {
      updateRunToolErrorSummary?.({ runId: evt.runId, clientRunId, summary: undefined });
    }
    if (evt.stream === "plan" && evt.data?.phase === "update") {
      const steps = normalizeAgentPlanSteps(evt.data.steps) ?? [];
      const explanation =
        typeof evt.data.explanation === "string" ? evt.data.explanation.trim() : "";
      chatRunState.getOrCreate(clientRunId).planSnapshot = {
        steps,
        ...(explanation ? { explanation } : {}),
      };
    }
    if (
      recordsInFlightProgress &&
      !isAborted &&
      ((isToolEvent && !suppressHeartbeatToolEvents) ||
        isItemEvent ||
        evt.stream === "run_status" ||
        evt.stream === "notice" ||
        typeof evt.data?.reviewId === "string" ||
        evt.data?.phase === "started" ||
        evt.data?.phase === "completed" ||
        evt.data?.phase === "warning")
    ) {
      // Persist the client-facing identity after run/session remapping. Route
      // changes discard transient UI rows, so history replay must use the same
      // payload identity as live delivery or tool results cannot reconcile.
      chatRunState.recordProgressEvent(
        clientRunId,
        agentPayload,
        recordsEmbeddedProgress ? "summary" : "full",
      );
    }
    if (evt.stream === "run_status") {
      const phase = readChatRunStartupPhase(evt.data?.phase);
      if (phase && chatLink && isControlUiVisible && sessionKey && !isAborted) {
        const payload = {
          runId: clientRunId,
          sessionKey,
          ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
          ...(spawnedBy && { spawnedBy }),
          seq: evt.seq,
          state: "status" as const,
          phase,
        } satisfies ChatEvent;
        sendChatPayload(sessionKey, payload, {
          agentId: sessionAgentId,
          controlUiVisible: true,
          dropIfSlow: true,
        });
      }
    }
    if (isToolEvent) {
      const toolPhase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (toolPhase === "start") {
        updateRunToolErrorSummary?.({ runId: evt.runId, clientRunId, summary: undefined });
      } else if (toolPhase === "result") {
        updateRunToolErrorSummary?.({
          runId: evt.runId,
          clientRunId,
          summary: readToolValidationErrorSummary(evt.data?.toolErrorSummary),
        });
      }
      // Flush pending assistant text before tool-start events so clients can
      // render complete pre-tool text above tool cards (not truncated by delta throttle).
      if (
        toolPhase === "start" &&
        (isControlUiVisible || hasSessionMessageSubscribers) &&
        sessionKey &&
        !isAborted &&
        !suppressHeartbeatToolEvents
      ) {
        flushBufferedChatDeltaIfNeeded(
          sessionKey,
          sessionAgentId,
          clientRunId,
          evt.runId,
          evt.seq,
          {
            controlUiVisible: isControlUiVisible,
          },
        );
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.). Carry the
      // delivery key so scoped clients must also own the session subscription.
      const runToolRecipients = toolEventRecipients.get(evt.runId);
      if (
        isControlUiVisible &&
        !suppressHeartbeatToolEvents &&
        runToolRecipients &&
        runToolRecipients.size > 0
      ) {
        broadcastToConnIds(
          "agent",
          sessionKey
            ? {
                ...agentPayload,
                ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
              }
            : agentPayload,
          runToolRecipients,
          {
            sessionKeys: sessionKey
              ? resolveSessionDeliveryKeys(sessionKey, sessionAgentId)
              : undefined,
          },
        );
      }
      if (
        !isControlUiVisible &&
        sessionKey &&
        hasSessionMessageSubscribers &&
        !suppressHeartbeatToolEvents
      ) {
        sendAgentPayload(
          sessionKey,
          { ...agentPayload, ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId) },
          { agentId: sessionAgentId, controlUiVisible: false, dropIfSlow: true },
        );
      }
      // Session subscribers power operator UIs that attach to an existing
      // in-flight session after the run has already started. Those clients do
      // not know the runId in advance, so they cannot register as run-scoped
      // tool recipients. Mirror tool lifecycle onto a session-scoped event so
      // they can render live pending tool cards without polling history.
      if (isControlUiVisible && sessionKey && !suppressHeartbeatToolEvents) {
        const sessionSubscribers = excludeConnIds(
          sessionEventSubscribers.getAll(),
          runToolRecipients,
        );
        if (sessionSubscribers.size > 0) {
          broadcastToConnIds(
            "session.tool",
            {
              ...agentPayload,
              ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
            },
            sessionSubscribers,
            { dropIfSlow: true },
          );
        }
      }
    } else {
      const itemPhase = isItemEvent && typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (
        itemPhase === "start" &&
        (isControlUiVisible || hasSessionMessageSubscribers) &&
        !isAborted
      ) {
        if (sessionKey) {
          flushBufferedChatDeltaIfNeeded(
            sessionKey,
            sessionAgentId,
            clientRunId,
            evt.runId,
            evt.seq,
            {
              controlUiVisible: isControlUiVisible,
            },
          );
        }
        flushBufferedAgentDeltaIfNeeded(clientRunId);
      }
      if (isControlUiVisible) {
        if (shouldCoalesceAgentEvent) {
          sendOrBufferAgentTextEvent(clientRunId, sessionKey, sessionAgentId, agentPayload);
        } else {
          flushBufferedAgentDeltaIfNeeded(clientRunId);
          sendAgentPayload(sessionKey, agentPayload, {
            agentId: sessionAgentId,
            controlUiVisible: isControlUiVisible,
          });
          const textThrottleStream = resolveAgentTextThrottleStream(evt);
          if (
            textThrottleStream &&
            (typeof evt.data.delta === "string" || evt.data.replace === true)
          ) {
            const agentText = (chatRunState.getOrCreate(clientRunId).agentText ??= {});
            (agentText[textThrottleStream] ??= {}).lastSentAt = Date.now();
          }
        }
      } else if (
        sessionKey &&
        hasSessionMessageSubscribers &&
        (shouldMirrorAgentEventToHiddenSessionMessages(evt) ||
          (!isAborted &&
            evt.stream === "assistant" &&
            shouldMirrorAssistantEventToHiddenSessionMessages(evt.data)))
      ) {
        sendAgentPayload(
          sessionKey,
          { ...agentPayload, ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId) },
          { agentId: sessionAgentId, controlUiVisible: false, dropIfSlow: true },
        );
      }
      if (!isControlUiVisible && isItemEvent && sessionKey && hasSessionMessageSubscribers) {
        sendAgentPayload(
          sessionKey,
          { ...agentPayload, ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId) },
          { agentId: sessionAgentId, controlUiVisible: false, dropIfSlow: true },
        );
      }
    }

    if ((isControlUiVisible || hasSessionMessageSubscribers) && sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (
        isControlUiVisible &&
        isToolEvent &&
        !suppressHeartbeatToolEvents &&
        toolVerbose !== "off"
      ) {
        sendNodeAgentPayload(
          sessionKey,
          projectToolSearchCodeEventForChannelPayload({
            ...channelToolPayload,
            ...buildSessionEventSnapshot(sessionKey, undefined, sessionAgentId),
          }),
          sessionAgentId,
        );
      }
      const assistantLiveChatInput =
        evt.stream === "assistant" ? resolveAssistantLiveChatInput(evt.data) : undefined;
      const suppressAssistant = shouldSuppressAssistantEventForLiveChat(evt.data);
      if (
        !isAborted &&
        assistantLiveChatInput &&
        (!suppressAssistant || assistantLiveChatInput.itemId)
      ) {
        emitChatDelta(
          sessionKey,
          sessionAgentId,
          clientRunId,
          evt.runId,
          evt.seq,
          suppressAssistant
            ? { ...assistantLiveChatInput, text: "", delta: "" }
            : assistantLiveChatInput,
          {
            controlUiVisible: isControlUiVisible,
          },
        );
      }
    }

    if (lifecyclePhase === "error") {
      const skipChatErrorFinal = isChatSendRunActive(evt.runId) && !chatLink;
      const isFallbackExhaustedFailure = evt.data?.fallbackExhaustedFailure === true;
      // Per-attempt provider errors keep the retry grace so fallback can reuse
      // the runId. Once the runner marks fallback as exhausted, clear chat state
      // immediately so webchat sessions do not stay in progress until the timer.
      if (isAborted || isFallbackExhaustedFailure || lifecycleErrorRetryGraceMs <= 0) {
        // finalizeLifecycleEvent clears the buffer itself, after emitChatTerminal
        // has flushed the throttled tail and resolved the terminal message.
        finalizeLifecycleEvent(evt, { skipChatErrorFinal, restartRecoveryState });
      } else {
        if (evt.data.completionSource !== "reply-dispatch") {
          // Runtime retries isolate failed text; reply-dispatch retains its
          // post-hook payloads and abort state until its own completion settles.
          if (sessionKey) {
            flushBufferedChatDeltaIfNeeded(
              sessionKey,
              sessionAgentId,
              clientRunId,
              evt.runId,
              evt.seq,
              {
                controlUiVisible: isControlUiVisible,
              },
            );
          }
          chatRunState.clearRun(clientRunId);
        }
        scheduleTerminalLifecycleError(evt, { skipChatErrorFinal, restartRecoveryState });
      }
      return;
    }

    if (lifecyclePhase === "end") {
      finalizeLifecycleEvent(evt, { restartRecoveryState });
      return;
    }

    if (projectSessionLifecycle && sessionKey && lifecyclePhase === "start") {
      void persistGatewaySessionLifecycleEventForEvent({
        sessionKey,
        agentId: sessionAgentId,
        event: {
          ...evt,
          ...(eventRunId !== evt.runId ? { clientRunId: eventRunId } : {}),
        },
      }).catch((err: unknown) => {
        // Surface the swallowed start-phase persistence failure: a silent write
        // failure drops the run's start marker from restart-recovery accounting
        // with no operator trace, matching the terminal-phase log below.
        logError(
          `gateway: start session persistence failed session=${formatForLog(sessionKey)} run=${formatForLog(evt.runId)} error=${formatForLog(err)}`,
        );
      });
      const sessionEventConnIds = sessionEventSubscribers.getAll();
      if (hasSessionChangeReceivers(sessionEventConnIds)) {
        broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
            phase: lifecyclePhase,
            runId: evt.runId,
            ...(eventRunId !== evt.runId ? { clientRunId: eventRunId } : {}),
            ts: evt.ts,
            ...buildSessionEventSnapshot(sessionKey, evt, sessionAgentId, true, true),
          },
          sessionEventConnIds,
          { dropIfSlow: true },
        );
      }
    }
  };

  return Object.assign(handleEvent, {
    dispose: () => {
      // Deferred provider errors belong to this gateway subscription. Letting
      // them outlive shutdown can project stale terminal state into a successor.
      for (const pending of pendingTerminalLifecycleErrors.values()) {
        clearTimeout(pending.timer);
      }
      pendingTerminalLifecycleErrors.clear();
    },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
