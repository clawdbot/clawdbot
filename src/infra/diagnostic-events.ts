import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatDiagnosticTraceparent,
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};

export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};

export type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};

export type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};

export type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
  type: "message.queued";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  source: string;
  queueDepth?: number;
};

export type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

export type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";

type DiagnosticMessageDeliveryBaseEvent = DiagnosticBaseEvent & {
  channel: string;
  sessionKey?: string;
  deliveryKind: DiagnosticMessageDeliveryKind;
};

export type DiagnosticMessageDeliveryStartedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.started";
};

export type DiagnosticMessageDeliveryCompletedEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.completed";
  durationMs: number;
  resultCount: number;
};

export type DiagnosticMessageDeliveryErrorEvent = DiagnosticMessageDeliveryBaseEvent & {
  type: "message.delivery.error";
  durationMs: number;
  errorCategory: string;
};

export type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
  type: "session.state";
  sessionKey?: string;
  sessionId?: string;
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};

export type DiagnosticSessionActiveWorkKind = "embedded_run" | "model_call" | "tool_call";

export type DiagnosticSessionAttentionClassification =
  | "long_running"
  | "blocked_tool_call"
  | "stalled_agent_run"
  | "stale_session_state";

type DiagnosticSessionAttentionBaseEvent = DiagnosticBaseEvent & {
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
  reason?: string;
  classification: DiagnosticSessionAttentionClassification;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
};

export type DiagnosticSessionLongRunningEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.long_running";
  classification: "long_running";
};

export type DiagnosticSessionStalledEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stalled";
  classification: "blocked_tool_call" | "stalled_agent_run";
};

export type DiagnosticSessionStuckEvent = DiagnosticSessionAttentionBaseEvent & {
  type: "session.stuck";
  classification: "stale_session_state";
};

export type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};

export type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};

export type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
  type: "run.attempt";
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
};

export type DiagnosticRunProgressEvent = DiagnosticBaseEvent & {
  type: "run.progress";
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  reason: string;
};

export type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
};

export type DiagnosticLivenessWarningReason = "event_loop_delay" | "event_loop_utilization" | "cpu";

export type DiagnosticLivenessWarningEvent = DiagnosticBaseEvent & {
  type: "diagnostic.liveness.warning";
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
  active: number;
  waiting: number;
  queued: number;
};

export type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector:
    | "generic_repeat"
    | "unknown_tool_repeat"
    | "known_poll_no_progress"
    | "global_circuit_breaker"
    | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
};

export type DiagnosticToolParamsSummary =
  | { kind: "object" }
  | { kind: "array"; length: number }
  | { kind: "string"; length: number }
  | { kind: "number" | "boolean" | "null" | "undefined" | "other" };

type DiagnosticToolExecutionBaseEvent = DiagnosticBaseEvent & {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  toolCallId?: string;
  paramsSummary?: DiagnosticToolParamsSummary;
};

export type DiagnosticToolExecutionStartedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.started";
};

export type DiagnosticToolExecutionCompletedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.completed";
  durationMs: number;
};

export type DiagnosticToolExecutionErrorEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.error";
  durationMs: number;
  errorCategory: string;
  errorCode?: string;
};

export type DiagnosticToolExecutionBlockedEvent = DiagnosticToolExecutionBaseEvent & {
  type: "tool.execution.blocked";
  deniedReason: string;
  reason: string;
};

export type DiagnosticExecProcessCompletedEvent = DiagnosticBaseEvent & {
  type: "exec.process.completed";
  sessionKey?: string;
  target: "host" | "sandbox";
  mode: "child" | "pty";
  outcome: "completed" | "failed";
  durationMs: number;
  commandLength: number;
  exitCode?: number;
  exitSignal?: string;
  timedOut?: boolean;
  failureKind?:
    | "shell-command-not-found"
    | "shell-not-executable"
    | "overall-timeout"
    | "no-output-timeout"
    | "signal"
    | "aborted"
    | "runtime-error";
};

type DiagnosticRunBaseEvent = DiagnosticBaseEvent & {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
};

export type DiagnosticRunStartedEvent = DiagnosticRunBaseEvent & {
  type: "run.started";
};

export type DiagnosticRunCompletedEvent = DiagnosticRunBaseEvent & {
  type: "run.completed";
  durationMs: number;
  outcome: "completed" | "aborted" | "error";
  errorCategory?: string;
};

export type DiagnosticHarnessRunPhase = "prepare" | "start" | "send" | "resolve" | "cleanup";
export type DiagnosticHarnessRunOutcome = "completed" | "aborted" | "timed_out" | "error";

type DiagnosticHarnessRunBaseEvent = DiagnosticBaseEvent & {
  type: "harness.run.started" | "harness.run.completed" | "harness.run.error";
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  trigger?: string;
  channel?: string;
  harnessId: string;
  pluginId?: string;
};

export type DiagnosticHarnessRunStartedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.started";
};

export type DiagnosticHarnessRunCompletedEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.completed";
  durationMs: number;
  outcome: DiagnosticHarnessRunOutcome;
  resultClassification?: "empty" | "reasoning-only" | "planning-only";
  yieldDetected?: boolean;
  itemLifecycle?: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
};

export type DiagnosticHarnessRunErrorEvent = DiagnosticHarnessRunBaseEvent & {
  type: "harness.run.error";
  durationMs: number;
  phase: DiagnosticHarnessRunPhase;
  errorCategory: string;
  cleanupFailed?: boolean;
};

type DiagnosticModelCallBaseEvent = DiagnosticBaseEvent & {
  type: "model.call.started" | "model.call.completed" | "model.call.error";
  runId: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  api?: string;
  transport?: string;
  upstreamRequestIdHash?: string;
};

export type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.started";
};

export type DiagnosticModelCallCompletedEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.completed";
  durationMs: number;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
};

export type DiagnosticModelCallErrorEvent = DiagnosticModelCallBaseEvent & {
  type: "model.call.error";
  durationMs: number;
  errorCategory: string;
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
  memory?: DiagnosticMemoryUsage;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
};

export type DiagnosticContextAssembledEvent = DiagnosticBaseEvent & {
  type: "context.assembled";
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  model: string;
  channel?: string;
  trigger?: string;
  messageCount: number;
  historyTextChars: number;
  historyImageBlocks: number;
  maxMessageTextChars: number;
  systemPromptChars: number;
  promptChars: number;
  promptImages: number;
  contextTokenBudget?: number;
  reserveTokens?: number;
};

export type DiagnosticMemoryUsage = {
  rssBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

export type DiagnosticMemorySampleEvent = DiagnosticBaseEvent & {
  type: "diagnostic.memory.sample";
  memory: DiagnosticMemoryUsage;
  uptimeMs?: number;
};

export type DiagnosticMemoryPressureEvent = DiagnosticBaseEvent & {
  type: "diagnostic.memory.pressure";
  level: "warning" | "critical";
  reason: "rss_threshold" | "heap_threshold" | "rss_growth";
  memory: DiagnosticMemoryUsage;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
};

export type DiagnosticPayloadLargeEvent = DiagnosticBaseEvent & {
  type: "payload.large";
  surface: string;
  action: "rejected" | "truncated" | "chunked";
  bytes?: number;
  limitBytes?: number;
  count?: number;
  channel?: string;
  pluginId?: string;
  reason?: string;
};

export type DiagnosticLogRecordEvent = DiagnosticBaseEvent & {
  type: "log.record";
  level: string;
  message: string;
  loggerName?: string;
  loggerParents?: string[];
  attributes?: Record<string, string | number | boolean>;
  code?: {
    line?: number;
    functionName?: string;
  };
};

export type DiagnosticTelemetryExporterEvent = DiagnosticBaseEvent & {
  type: "telemetry.exporter";
  exporter: string;
  signal: "traces" | "metrics" | "logs";
  status: "started" | "failure" | "dropped";
  reason?:
    | "configured"
    | "emit_failed"
    | "handler_failed"
    | "queue_full"
    | "shutdown_failed"
    | "start_failed"
    | "unsupported_protocol";
  errorCategory?: string;
};

export type DiagnosticEventPayload =
  | DiagnosticUsageEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticMessageDeliveryStartedEvent
  | DiagnosticMessageDeliveryCompletedEvent
  | DiagnosticMessageDeliveryErrorEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionLongRunningEvent
  | DiagnosticSessionStalledEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticRunProgressEvent
  | DiagnosticHeartbeatEvent
  | DiagnosticLivenessWarningEvent
  | DiagnosticToolLoopEvent
  | DiagnosticToolExecutionStartedEvent
  | DiagnosticToolExecutionCompletedEvent
  | DiagnosticToolExecutionErrorEvent
  | DiagnosticToolExecutionBlockedEvent
  | DiagnosticExecProcessCompletedEvent
  | DiagnosticRunStartedEvent
  | DiagnosticRunCompletedEvent
  | DiagnosticHarnessRunStartedEvent
  | DiagnosticHarnessRunCompletedEvent
  | DiagnosticHarnessRunErrorEvent
  | DiagnosticModelCallStartedEvent
  | DiagnosticModelCallCompletedEvent
  | DiagnosticModelCallErrorEvent
  | DiagnosticContextAssembledEvent
  | DiagnosticMemorySampleEvent
  | DiagnosticMemoryPressureEvent
  | DiagnosticPayloadLargeEvent
  | DiagnosticLogRecordEvent
  | DiagnosticTelemetryExporterEvent;

export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, "seq" | "ts">
    : never
  : never;

export type DiagnosticEventMetadata = Readonly<{
  trusted: boolean;
}>;

type DiagnosticEventListener = (
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
) => void;

type QueuedDiagnosticEvent = {
  event: DiagnosticEventPayload;
  metadata: DiagnosticEventMetadata;
};

type DiagnosticEventsGlobalState = {
  marker: symbol;
  enabled: boolean;
  seq: number;
  listeners: Set<DiagnosticEventListener>;
  dispatchDepth: number;
  asyncQueue: QueuedDiagnosticEvent[];
  asyncDrainScheduled: boolean;
};

const MAX_ASYNC_DIAGNOSTIC_EVENTS = 10_000;
const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");
const dispatchedTrustedDiagnosticMetadata = new WeakSet<object>();
const ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set<DiagnosticEventPayload["type"]>([
  "tool.execution.started",
  "tool.execution.completed",
  "tool.execution.error",
  "exec.process.completed",
  "message.delivery.started",
  "message.delivery.completed",
  "message.delivery.error",
  "model.call.started",
  "model.call.completed",
  "model.call.error",
  "run.progress",
  "harness.run.started",
  "harness.run.completed",
  "harness.run.error",
  "context.assembled",
  "log.record",
]);

function createDiagnosticEventsState(): DiagnosticEventsGlobalState {
  return {
    marker: DIAGNOSTIC_EVENTS_STATE_KEY,
    enabled: true,
    seq: 0,
    listeners: new Set<DiagnosticEventListener>(),
    dispatchDepth: 0,
    asyncQueue: [],
    asyncDrainScheduled: false,
  };
}

function isDiagnosticEventsState(value: unknown): value is DiagnosticEventsGlobalState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<DiagnosticEventsGlobalState>;
  return (
    candidate.marker === DIAGNOSTIC_EVENTS_STATE_KEY &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.seq === "number" &&
    candidate.listeners instanceof Set &&
    typeof candidate.dispatchDepth === "number" &&
    Array.isArray(candidate.asyncQueue) &&
    typeof candidate.asyncDrainScheduled === "boolean"
  );
}

function getDiagnosticEventsState(): DiagnosticEventsGlobalState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[DIAGNOSTIC_EVENTS_STATE_KEY];
  if (isDiagnosticEventsState(existing)) {
    return existing;
  }
  const state = createDiagnosticEventsState();
  Object.defineProperty(globalThis, DIAGNOSTIC_EVENTS_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

export function isDiagnosticsEnabled(config?: OpenClawConfig): boolean {
  return config?.diagnostics?.enabled !== false;
}

export function setDiagnosticsEnabledForProcess(enabled: boolean): void {
  getDiagnosticEventsState().enabled = enabled;
}

export function areDiagnosticsEnabledForProcess(): boolean {
  return getDiagnosticEventsState().enabled;
}

function dispatchDiagnosticEvent(
  state: DiagnosticEventsGlobalState,
  enriched: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): void {
  if (state.dispatchDepth > 100) {
    console.error(
      `[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${enriched.type}`,
    );
    return;
  }

  state.dispatchDepth += 1;
  try {
    for (const listener of state.listeners) {
      try {
        listener(
          cloneDiagnosticEventForListener(enriched),
          createDiagnosticMetadataForListener(metadata),
        );
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? (err.stack ?? err.message)
            : typeof err === "string"
              ? err
              : String(err);
        console.error(
          `[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`,
        );
        // Ignore listener failures.
      }
    }
  } finally {
    state.dispatchDepth -= 1;
  }
}

function createDiagnosticMetadataForListener(
  metadata: DiagnosticEventMetadata,
): DiagnosticEventMetadata {
  const listenerMetadata = Object.freeze({ ...metadata });
  if (listenerMetadata.trusted) {
    dispatchedTrustedDiagnosticMetadata.add(listenerMetadata);
  }
  return listenerMetadata;
}

function cloneDiagnosticEventForListener(event: DiagnosticEventPayload): DiagnosticEventPayload {
  return deepFreezeDiagnosticValue(structuredClone(event)) as DiagnosticEventPayload;
}

function deepFreezeDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeDiagnosticValue(item, seen);
    }
    return Object.freeze(value);
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeDiagnosticValue(nested, seen);
  }
  return Object.freeze(value);
}

function scheduleAsyncDiagnosticDrain(state: DiagnosticEventsGlobalState): void {
  if (state.asyncDrainScheduled) {
    return;
  }
  state.asyncDrainScheduled = true;
  setImmediate(() => {
    state.asyncDrainScheduled = false;
    const batch = state.asyncQueue.splice(0);
    for (const entry of batch) {
      dispatchDiagnosticEvent(state, entry.event, entry.metadata);
    }
    if (state.asyncQueue.length > 0) {
      scheduleAsyncDiagnosticDrain(state);
    }
  });
}

function enrichDiagnosticEvent(
  state: DiagnosticEventsGlobalState,
  event: DiagnosticEventInput,
): DiagnosticEventPayload {
  const enriched = {} as DiagnosticEventPayload & Record<string, unknown>;
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    enriched[key] = value;
  }
  enriched.trace ??= getActiveDiagnosticTraceContext();
  state.seq += 1;
  enriched.seq = state.seq;
  enriched.ts = Date.now();
  return enriched;
}

function emitDiagnosticEventWithTrust(event: DiagnosticEventInput, trusted: boolean) {
  const state = getDiagnosticEventsState();
  if (!state.enabled) {
    return;
  }

  const enriched = enrichDiagnosticEvent(state, event);
  const metadata: DiagnosticEventMetadata = { trusted };

  if (ASYNC_DIAGNOSTIC_EVENT_TYPES.has(enriched.type)) {
    if (state.asyncQueue.length >= MAX_ASYNC_DIAGNOSTIC_EVENTS) {
      return;
    }
    state.asyncQueue.push({ event: enriched, metadata });
    scheduleAsyncDiagnosticDrain(state);
    return;
  }

  dispatchDiagnosticEvent(state, enriched, metadata);
}

export function emitDiagnosticEvent(event: DiagnosticEventInput) {
  emitDiagnosticEventWithTrust(event, false);
}

export function emitTrustedDiagnosticEvent(event: DiagnosticEventInput) {
  emitDiagnosticEventWithTrust(event, true);
}

export function onInternalDiagnosticEvent(listener: DiagnosticEventListener): () => void {
  const state = getDiagnosticEventsState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  return onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted || event.type === "log.record") {
      return;
    }
    listener(event);
  });
}

export function formatDiagnosticTraceparentForPropagation(
  event: { trace?: DiagnosticTraceContext },
  metadata: DiagnosticEventMetadata,
): string | undefined {
  if (!metadata.trusted || !dispatchedTrustedDiagnosticMetadata.has(metadata)) {
    return undefined;
  }
  return formatDiagnosticTraceparent(event.trace);
}

export function resetDiagnosticEventsForTest(): void {
  const state = getDiagnosticEventsState();
  state.enabled = true;
  state.seq = 0;
  state.listeners.clear();
  state.dispatchDepth = 0;
  state.asyncQueue = [];
  state.asyncDrainScheduled = false;
}
