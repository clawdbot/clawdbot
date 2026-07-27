// Copilot plugin module implements event bridge behavior.
import type { MessageOptions, SessionEvent, SessionEventType } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import {
  buildAssistantMessage,
  hasOwnKeys,
  projectSdkUserMetadata,
  projectToolResultDetails,
  resolveAssistantUsage,
  resolveEventTimestamp,
  sanitizeToolDetailText,
  type AssistantMessage,
  type AssistantUsageSnapshot,
} from "./event-bridge-transcript.js";
import { normalizeCopilotUsage } from "./usage-bridge.js";

export type { AssistantMessage, AssistantUsageSnapshot } from "./event-bridge-transcript.js";

export interface OnAssistantDeltaPayload {
  delta: string;
  sessionId?: string;
  text: string;
  usage?: AssistantUsageSnapshot;
}

export interface SessionLike {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  id?: string;
  off?: (eventType: string, handler: (...args: unknown[]) => void) => void;
  on: {
    <K extends SessionEventType>(
      eventType: K,
      handler: (event: Extract<SessionEvent, { type: K }>) => void,
    ): (() => void) | void;
    (eventType: string, handler: (event: SessionEvent) => void): (() => void) | void;
  };
  rpc?: {
    history?: {
      cancelBackgroundCompaction?: () => Promise<unknown>;
    };
  };
  sendAndWait(options: MessageOptions, timeout?: number): Promise<SessionEvent | undefined>;
  sessionId?: string;
}

interface EventBridgeOptions {
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  onAgentEvent?: (event: {
    stream: "item" | "plan";
    data: Record<string, unknown>;
  }) => void | Promise<void>;
  onNativeSubagentEvent?: (
    event: Extract<
      SessionEvent,
      { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
    >,
  ) => void;
  onCompactionComplete?: (payload: {
    messagesRemoved?: number;
    success: boolean;
  }) => void | Promise<void>;
  onCompactionStart?: () => void | Promise<void>;
  onContextCompacted?: () => void;
  getSdkSessionId: () => string | undefined;
  isAborted: () => boolean;
  transcriptProjection?: {
    journal: AttemptTranscriptJournal;
    modelRef: { api?: string; id: string; provider: string };
    now: () => number;
  };
}

interface EventBridgeSnapshot {
  readonly assistantTexts: readonly string[];
  readonly completedCount: number;
  readonly lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  readonly startedCount: number;
  readonly streamError: Error | undefined;
  readonly toolMetas: ReadonlyArray<AgentHarnessAttemptResult["toolMetas"][number]>;
  readonly usage: AssistantUsageSnapshot | undefined;
}

interface BuildAssistantMessageArgs {
  modelRef: { api?: string; id: string; provider: string };
  now: () => number;
}

interface EventBridgeController {
  recordSendResult(result: SessionEvent | undefined): boolean;
  awaitCompactionChain(): Promise<void>;
  awaitCompactionCompletion(): Promise<void>;
  awaitSessionIdle(): Promise<void>;
  settleCompactionWait(): void;
  awaitDeltaChain(): Promise<void>;
  awaitAgentEventChain(): Promise<void>;
  hasObservedCompaction(): boolean;
  hasObservedSessionIdle(): boolean;
  isCompacting(): boolean;
  snapshot(): EventBridgeSnapshot;
  buildAssistantMessage(args: BuildAssistantMessageArgs): AssistantMessage | undefined;
  finalizeAssistantTexts(): string[];
  detach(): void;
}

type MessageAccumulator = { messageId: string; text: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };

export function attachEventBridge(
  session: SessionLike,
  options: EventBridgeOptions,
): EventBridgeController {
  const messageOrder: string[] = [];
  const messagesById = new Map<string, MessageAccumulator>();
  const reasoningOrder: string[] = [];
  const reasoningById = new Map<string, string>();
  let lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  let lastAssistantReasoningText: string | undefined;
  let usage: AssistantUsageSnapshot | undefined;
  const usageByApiCallId = new Map<string, AssistantUsageSnapshot>();
  const handledAssistantEventIds = new Set<string>();
  let streamError: Error | undefined;
  const toolMetas: AgentHarnessAttemptResult["toolMetas"] = [];
  const toolMetaIndexByCallId = new Map<string, number>();
  let startedCount = 0;
  let completedCount = 0;
  let activeCompactionCount = 0;
  let observedCompaction = false;
  let deltaQueue = Promise.resolve();
  let deltaChain = Promise.resolve();
  let agentEventChain = Promise.resolve();
  let compactionChain = Promise.resolve();
  let compactionIdle = Promise.resolve();
  let resolveCompactionIdle: (() => void) | undefined;
  let observedSessionIdle = false;
  let resolveSessionIdle: (() => void) | undefined;
  const sessionIdle = new Promise<void>((resolve) => {
    resolveSessionIdle = resolve;
  });
  let firstDeltaError: unknown;
  let detached = false;
  const unsubscribeFns: Array<() => void> = [];

  registerListener(session, unsubscribeFns, "user.message", (event) => {
    const projection = options.transcriptProjection;
    if (!projection || !isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    const source = readString(event.data.source);
    const transformedContent = readString(event.data.transformedContent);
    const openClawMeta = projectSdkUserMetadata(event.data.attachments, source);
    const idempotencyKey = `copilot-sdk:${options.getSdkSessionId() ?? "unknown"}:${event.id}`;
    // `source` is open-ended provenance, not a visibility enum. Hide the one
    // documented injected source; unknown sources stay visible without guessing.
    const hidden = event.data.isAutopilotContinuation === true || source === "skill-pdf";
    projection.journal.recordSdkUser({
      eventId: event.id,
      autopilotContinuation: event.data.isAutopilotContinuation === true,
      replayIncomplete: Boolean(
        event.data.attachments?.length ||
        (transformedContent !== undefined && transformedContent !== event.data.content),
      ),
      message: {
        role: "user",
        content: event.data.content,
        timestamp: resolveEventTimestamp(event.timestamp, projection.now),
        idempotencyKey,
        ...(hidden ? { display: false } : {}),
        ...(openClawMeta ? { __openclaw: openClawMeta } : {}),
      } as Extract<AgentMessage, { role: "user" }>,
    });
  });

  registerListener(session, unsubscribeFns, "assistant.message_delta", (event) => {
    if (!isRootSessionEvent(event)) {
      return;
    }
    const messageId = readString(event.data.messageId) ?? "assistant-message";
    const delta = event.data.deltaContent;
    if (!delta) {
      return;
    }
    const entry = ensureMessageAccumulator(messagesById, messageOrder, messageId);
    entry.text += delta;
    const onAssistantDelta = options.onAssistantDelta;
    if (!onAssistantDelta) {
      return;
    }
    const payload: OnAssistantDeltaPayload = {
      delta,
      sessionId: options.getSdkSessionId(),
      text: entry.text,
      usage,
    };
    deltaQueue = deltaQueue
      .then(
        () => onAssistantDelta(payload),
        () => onAssistantDelta(payload),
      )
      .catch((error: unknown) => {
        firstDeltaError ??= error;
      });
    deltaChain = deltaQueue.then(() => {
      if (firstDeltaError !== undefined) {
        throw toLintErrorObject(firstDeltaError, "Non-Error thrown");
      }
    });
    void deltaChain.catch(() => undefined);
  });

  registerListener(session, unsubscribeFns, "assistant.reasoning_delta", (event) => {
    if (!isRootSessionEvent(event)) {
      return;
    }
    const reasoningId = readString(event.data.reasoningId) ?? "assistant-reasoning";
    const delta = event.data.deltaContent;
    if (!delta) {
      return;
    }
    if (!reasoningById.has(reasoningId)) {
      reasoningById.set(reasoningId, "");
      reasoningOrder.push(reasoningId);
    }
    reasoningById.set(reasoningId, `${reasoningById.get(reasoningId) ?? ""}${delta}`);
  });

  registerListener(session, unsubscribeFns, "assistant.message", (event) => {
    if (!isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    handleAssistantMessage(event);
  });

  registerListener(session, unsubscribeFns, "assistant.usage", (event) => {
    if (!isRootSessionEvent(event)) {
      return;
    }
    usage = normalizeCopilotUsage(event.data);
    const apiCallId = readString(event.data.apiCallId);
    if (apiCallId && usage) {
      usageByApiCallId.set(apiCallId, usage);
    }
  });

  registerListener(session, unsubscribeFns, "tool.execution_start", (event) => {
    if (isRootSessionEvent(event)) {
      startedCount += 1;
    }
    toolMetaIndexByCallId.set(event.data.toolCallId, toolMetas.length);
    toolMetas.push({ toolName: event.data.toolName });
  });

  registerListener(session, unsubscribeFns, "tool.execution_complete", (event) => {
    if (isRootSessionEvent(event)) {
      completedCount += 1;
    }
    const toolMetaIndex = toolMetaIndexByCallId.get(event.data.toolCallId);
    const toolName = toolMetaIndex === undefined ? undefined : toolMetas[toolMetaIndex]?.toolName;
    const meta = event.data.success
      ? (event.data.result?.detailedContent ?? event.data.result?.content)
      : event.data.error?.message;
    if (toolName && toolMetaIndex !== undefined) {
      toolMetas[toolMetaIndex] = {
        ...(meta ? { meta } : {}),
        toolName,
        ...(event.data.success ? {} : { isError: true }),
      };
    }
    const projection = options.transcriptProjection;
    if (
      projection &&
      isRootSessionEvent(event) &&
      event.ephemeral !== true &&
      event.data.isUserRequested !== true
    ) {
      const resultText = event.data.success
        ? (event.data.result?.content ?? "")
        : (event.data.error?.message ?? "Tool execution failed");
      const details = projectToolResultDetails(event.data);
      const replayIncomplete = Boolean(
        event.data.result?.binaryResultsForLlm?.length || event.data.result?.citableSources?.length,
      );
      projection.journal.recordToolResult({
        eventId: event.id,
        replayIncomplete,
        message: {
          role: "toolResult",
          toolCallId: event.data.toolCallId,
          toolName: toolName ?? event.data.toolDescription?.name ?? "unknown",
          content: [{ type: "text", text: sanitizeToolDetailText(resultText) }],
          ...(hasOwnKeys(details) ? { details } : {}),
          isError: !event.data.success,
          timestamp: resolveEventTimestamp(event.timestamp, projection.now),
        },
      });
    }
  });

  registerListener(session, unsubscribeFns, "session.plan_changed", (event) => {
    enqueueAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "copilot-sdk",
        operation: event.data.operation,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      },
    });
  });

  registerListener(session, unsubscribeFns, "exit_plan_mode.requested", (event) => {
    const steps = splitPlanText(event.data.planContent).map((step) => ({
      step,
      status: "pending" as const,
    }));
    enqueueAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "copilot-sdk",
        ...(event.data.summary ? { explanation: event.data.summary } : {}),
        ...(steps.length > 0 ? { steps } : {}),
        ...(event.data.actions.length > 0 ? { actions: event.data.actions } : {}),
        ...(event.data.requestId ? { requestId: event.data.requestId } : {}),
        ...(event.data.recommendedAction
          ? { recommendedAction: event.data.recommendedAction }
          : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
      },
    });
  });

  registerListener(session, unsubscribeFns, "exit_plan_mode.completed", (event) => {
    enqueueAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan decision",
        source: "copilot-sdk",
        requestId: event.data.requestId,
        ...(event.data.approved !== undefined ? { approved: event.data.approved } : {}),
        ...(event.data.autoApproveEdits !== undefined
          ? { autoApproveEdits: event.data.autoApproveEdits }
          : {}),
        ...(event.data.feedback ? { feedback: event.data.feedback } : {}),
        ...(event.data.selectedAction ? { selectedAction: event.data.selectedAction } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
      },
    });
  });

  registerListener(session, unsubscribeFns, "subagent.started", (event) => {
    forwardNativeSubagentEvent(event);
  });

  registerListener(session, unsubscribeFns, "subagent.completed", (event) => {
    forwardNativeSubagentEvent(event);
  });

  registerListener(session, unsubscribeFns, "subagent.failed", (event) => {
    forwardNativeSubagentEvent(event);
  });

  registerListener(session, unsubscribeFns, "session.compaction_start", (event) => {
    if (!isRootCompactionEvent(event)) {
      return;
    }
    observedCompaction = true;
    if (activeCompactionCount === 0) {
      compactionIdle = new Promise<void>((resolve) => {
        resolveCompactionIdle = resolve;
      });
    }
    activeCompactionCount += 1;
    enqueueCompactionCallback(options.onCompactionStart);
  });

  registerListener(session, unsubscribeFns, "session.compaction_complete", (event) => {
    if (event.data.success) {
      try {
        // The SDK shares one tool-handler map and omits agent identity from
        // tool invocations, so any compacted context invalidates the frame.
        options.onContextCompacted?.();
      } catch {
        // Context invalidation must not break generic compaction tracking.
      }
    }
    if (!isRootCompactionEvent(event)) {
      return;
    }
    activeCompactionCount = Math.max(0, activeCompactionCount - 1);
    enqueueCompactionCallback(() =>
      options.onCompactionComplete?.({
        ...(event.data.messagesRemoved !== undefined
          ? { messagesRemoved: event.data.messagesRemoved }
          : {}),
        success: event.data.success,
      }),
    );
    if (activeCompactionCount === 0) {
      resolveCompactionIdle?.();
      resolveCompactionIdle = undefined;
    }
  });

  registerListener(session, unsubscribeFns, "session.idle", (event) => {
    if (!isRootCompactionEvent(event)) {
      return;
    }
    observedSessionIdle = true;
    resolveSessionIdle?.();
    resolveSessionIdle = undefined;
  });

  registerListener(session, unsubscribeFns, "session.error", (event) => {
    if (!options.isAborted()) {
      streamError = createPromptError(
        event.data.errorCode ?? event.data.errorType,
        event.data.message,
      );
    }
  });

  registerListener(session, unsubscribeFns, "abort", (event) => {
    if (!options.isAborted()) {
      streamError = createPromptError(
        "session_aborted",
        `[copilot-attempt] session aborted: ${event.data.reason}`,
      );
    }
  });

  return {
    recordSendResult(result) {
      if (
        !isAssistantMessageEvent(result) ||
        !isRootSessionEvent(result) ||
        result.ephemeral === true
      ) {
        return false;
      }
      handleAssistantMessage(result);
      return true;
    },
    awaitCompactionChain() {
      return compactionChain;
    },
    async awaitCompactionCompletion() {
      await awaitStableCompaction();
    },
    awaitSessionIdle() {
      return observedSessionIdle ? Promise.resolve() : sessionIdle;
    },
    settleCompactionWait() {
      activeCompactionCount = 0;
      resolveCompactionIdle?.();
      resolveCompactionIdle = undefined;
    },
    awaitDeltaChain() {
      return deltaChain;
    },
    awaitAgentEventChain() {
      return agentEventChain;
    },
    hasObservedCompaction() {
      return observedCompaction;
    },
    hasObservedSessionIdle() {
      return observedSessionIdle;
    },
    isCompacting() {
      return activeCompactionCount > 0;
    },
    snapshot() {
      return {
        assistantTexts: finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent),
        completedCount,
        lastAssistantEvent,
        startedCount,
        streamError,
        toolMetas: toolMetas.map((toolMeta) => Object.assign({}, toolMeta)),
        usage: usage ? { ...usage } : undefined,
      };
    },
    buildAssistantMessage(args) {
      return buildAssistantMessage({
        event: lastAssistantEvent,
        modelRef: args.modelRef,
        now: args.now,
        reasoningText: lastAssistantReasoningText,
        usage: resolveAssistantUsage(lastAssistantEvent, usage, usageByApiCallId),
        assistantTexts: finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent),
      });
    },
    finalizeAssistantTexts() {
      return finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent);
    },
    detach() {
      if (detached) {
        return;
      }
      detached = true;
      for (const unsubscribe of [...unsubscribeFns].toReversed()) {
        try {
          unsubscribe();
        } catch {
          // best-effort cleanup only
        }
      }
      unsubscribeFns.length = 0;
    },
  };

  function handleAssistantMessage(
    event: Extract<SessionEvent, { type: "assistant.message" }>,
  ): void {
    if (!isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    lastAssistantEvent = event;
    if (handledAssistantEventIds.has(event.id)) {
      return;
    }
    handledAssistantEventIds.add(event.id);
    const entry = ensureMessageAccumulator(messagesById, messageOrder, event.data.messageId);
    if (typeof event.data.content === "string" && event.data.content.length >= entry.text.length) {
      entry.text = event.data.content;
    }
    lastAssistantReasoningText =
      event.data.reasoningText ?? (joinReasoning(reasoningOrder, reasoningById) || undefined);
    reasoningOrder.length = 0;
    reasoningById.clear();
    const projection = options.transcriptProjection;
    if (!projection) {
      return;
    }
    const message = buildAssistantMessage({
      event,
      modelRef: projection.modelRef,
      now: () => resolveEventTimestamp(event.timestamp, projection.now),
      reasoningText: lastAssistantReasoningText,
      // Maintainer decision: optional assistant.usage must never delay canonical content.
      // Later usage stays attempt metadata; this row uses outputTokens/zero defaults.
      usage: resolveAssistantUsage(event, undefined, usageByApiCallId),
      assistantTexts: [messagesById.get(event.data.messageId)?.text ?? ""],
    });
    if (!message) {
      return;
    }
    projection.journal.recordAssistant({
      eventId: event.id,
      message,
      toolCallIds: (event.data.toolRequests ?? []).map((request) => request.toolCallId),
    });
  }

  function enqueueCompactionCallback(callback: (() => void | Promise<void>) | undefined): void {
    if (!callback) {
      return;
    }
    const queued = compactionChain.then(callback, callback);
    compactionChain = queued.catch(() => undefined);
  }

  function enqueueAgentEvent(event: {
    stream: "item" | "plan";
    data: Record<string, unknown>;
  }): void {
    const callback = options.onAgentEvent;
    if (!callback) {
      return;
    }
    const invoke = () => callback(event);
    agentEventChain = agentEventChain.then(invoke, invoke).catch(() => undefined);
  }

  function forwardNativeSubagentEvent(
    event: Extract<
      SessionEvent,
      { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
    >,
  ): void {
    try {
      options.onNativeSubagentEvent?.(event);
    } catch {
      // Native task mirroring must not corrupt the Copilot turn.
    }
  }

  async function awaitStableCompaction(): Promise<void> {
    const idle = activeCompactionCount > 0 ? compactionIdle : undefined;
    if (idle) {
      await idle;
    }
    const callbacks = compactionChain;
    await callbacks;
    // Compaction events can arrive while an earlier hook callback settles.
    // Recheck both queues before teardown so the root observer stays attached.
    if (activeCompactionCount > 0 || compactionChain !== callbacks) {
      await awaitStableCompaction();
    }
  }
}

function createPromptError(code: string, message: string, cause?: unknown): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function ensureMessageAccumulator(
  messagesById: Map<string, MessageAccumulator>,
  messageOrder: string[],
  messageId: string,
): MessageAccumulator {
  let entry = messagesById.get(messageId);
  if (!entry) {
    entry = { messageId, text: "" };
    messagesById.set(messageId, entry);
    messageOrder.push(messageId);
  }
  return entry;
}

function finalizeAssistantTexts(
  messageOrder: string[],
  messagesById: Map<string, MessageAccumulator>,
  event?: Extract<SessionEvent, { type: "assistant.message" }>,
): string[] {
  const texts = messageOrder
    .map((messageId) => messagesById.get(messageId)?.text ?? "")
    .filter((text) => text.length > 0);
  if (texts.length > 0) {
    return texts;
  }
  if (event?.data.content) {
    return [event.data.content];
  }
  return [];
}

function isAssistantMessageEvent(
  event: SessionEvent | undefined,
): event is Extract<SessionEvent, { type: "assistant.message" }> {
  return event?.type === "assistant.message";
}

function isRootSessionEvent(event: { agentId?: string }): boolean {
  return event.agentId === undefined;
}

function isRootCompactionEvent(event: { agentId?: string }): boolean {
  // SDK session events include subagent compaction; only root compaction
  // affects the pooled root session's cleanup and reuse lifecycle.
  return isRootSessionEvent(event);
}

function joinReasoning(order: string[], reasoningById: Map<string, string>): string {
  return order.map((reasoningId) => reasoningById.get(reasoningId) ?? "").join("");
}

function splitPlanText(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function registerListener<K extends SessionEventType>(
  session: SessionLike,
  unsubscribeFns: Array<() => void>,
  eventType: K,
  handler: (event: Extract<SessionEvent, { type: K }>) => void,
): void {
  const maybeUnsubscribe = session.on(eventType, handler);
  if (typeof maybeUnsubscribe === "function") {
    unsubscribeFns.push(maybeUnsubscribe);
    return;
  }
  unsubscribeFns.push(() => {
    session.off?.(eventType, handler as (...args: unknown[]) => void);
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
