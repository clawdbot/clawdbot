// Copilot plugin module implements event bridge behavior.
import type { MessageOptions, SessionEvent, SessionEventType } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
  type AttemptTranscriptJournalProjection,
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
    journal: AttemptTranscriptJournalProjection;
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
  flushTranscriptProjection(): void;
  hasObservedCompaction(): boolean;
  hasObservedSessionIdle(): boolean;
  isCompacting(): boolean;
  snapshot(): EventBridgeSnapshot;
  buildAssistantMessage(args: BuildAssistantMessageArgs): AssistantMessage | undefined;
  finalizeAssistantTexts(): string[];
  detach(): void;
}

type MessageAccumulator = { messageId: string; text: string };
type AssistantProjectionChunk = {
  assistantTexts: string[];
  event: Extract<SessionEvent, { type: "assistant.message" }>;
  reasoningText?: string;
  transcriptAssistantTexts: string[];
  transcriptReasoningText?: string;
};
type AssistantProjectionGroup = {
  apiCallId?: string;
  chunks: AssistantProjectionChunk[];
};
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };

export function attachEventBridge(
  session: SessionLike,
  options: EventBridgeOptions,
): EventBridgeController {
  const messageOrder: string[] = [];
  const messagesById = new Map<string, MessageAccumulator>();
  const reasoningOrder: string[] = [];
  const reasoningById = new Map<string, string>();
  const durableReasoningOrder: string[] = [];
  const durableReasoningById = new Map<string, string>();
  let lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  let lastAssistantReasoningText: string | undefined;
  let usage: AssistantUsageSnapshot | undefined;
  const usageByApiCallId = new Map<string, AssistantUsageSnapshot>();
  const handledAssistantEventIds = new Set<string>();
  const projectedAssistantMessageIdsWithoutApiCall = new Set<string>();
  let pendingAssistantProjection: AssistantProjectionGroup | undefined;
  let lastAssistantProjection: AssistantProjectionGroup | undefined;
  let streamError: Error | undefined;
  const toolMetas: AgentHarnessAttemptResult["toolMetas"] = [];
  const toolMetaIndexByCallId = new Map<string, number>();
  const projectedToolNamesByCallId = new Map<string, string>();
  const userRequestedToolCallIds = new Set<string>();
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
  let unconsumedDurableReasoning = false;
  const unsubscribeFns: Array<() => void> = [];

  registerListener(session, unsubscribeFns, "user.message", (event) => {
    if (!isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    flushPendingAssistantProjection();
    const projection = options.transcriptProjection;
    if (!projection) {
      return;
    }
    const source = readString(event.data.source);
    const transformedContent =
      typeof event.data.transformedContent === "string" ? event.data.transformedContent : undefined;
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
        (event.data.agentMode !== undefined && event.data.agentMode !== "interactive") ||
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

  registerListener(session, unsubscribeFns, "system.message", (event) => {
    if (!isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    // System/developer prompts affect native history but AgentMessage has no
    // lossless canonical role for them, so keep native replay fail-closed.
    options.transcriptProjection?.journal.markReplayIncomplete();
  });

  registerListener(session, unsubscribeFns, "skill.invoked", (event) => {
    if (isRootSessionEvent(event) && event.ephemeral !== true) {
      options.transcriptProjection?.journal.markReplayIncomplete();
    }
  });

  registerListener(session, unsubscribeFns, "system.notification", (event) => {
    if (isRootSessionEvent(event) && event.ephemeral !== true) {
      options.transcriptProjection?.journal.markReplayIncomplete();
    }
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

  registerListener(session, unsubscribeFns, "assistant.reasoning", (event) => {
    if (!isRootSessionEvent(event) || event.ephemeral === true) {
      return;
    }
    if (!reasoningById.has(event.data.reasoningId)) {
      reasoningOrder.push(event.data.reasoningId);
    }
    reasoningById.set(event.data.reasoningId, event.data.content);
    if (!durableReasoningById.has(event.data.reasoningId)) {
      durableReasoningOrder.push(event.data.reasoningId);
    }
    durableReasoningById.set(event.data.reasoningId, event.data.content);
    unconsumedDurableReasoning = true;
  });

  registerListener(session, unsubscribeFns, "assistant.turn_start", (event) => {
    if (isRootSessionEvent(event)) {
      markUnconsumedReasoningIncomplete();
    }
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
    if (apiCallId) {
      flushPendingAssistantProjection(apiCallId);
    }
  });

  registerListener(session, unsubscribeFns, "tool.user_requested", (event) => {
    if (isRootSessionEvent(event) && event.ephemeral !== true) {
      userRequestedToolCallIds.add(event.data.toolCallId);
      options.transcriptProjection?.journal.markReplayIncomplete();
    }
  });

  registerListener(session, unsubscribeFns, "tool.execution_start", (event) => {
    flushPendingAssistantProjectionForToolCall(event.data.toolCallId);
    if (isRootSessionEvent(event)) {
      startedCount += 1;
    }
    toolMetaIndexByCallId.set(event.data.toolCallId, toolMetas.length);
    toolMetas.push({ toolName: event.data.toolName });
  });

  registerListener(session, unsubscribeFns, "tool.execution_complete", (event) => {
    flushPendingAssistantProjectionForToolCall(event.data.toolCallId);
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
    const isDurableRootCompletion = isRootSessionEvent(event) && event.ephemeral !== true;
    const wasTrackedUserRequest = userRequestedToolCallIds.has(event.data.toolCallId);
    const isUserRequested = event.data.isUserRequested === true || wasTrackedUserRequest;
    const projectedToolName = projectedToolNamesByCallId.get(event.data.toolCallId);
    if (isDurableRootCompletion) {
      userRequestedToolCallIds.delete(event.data.toolCallId);
      projectedToolNamesByCallId.delete(event.data.toolCallId);
    }
    if (projection && isDurableRootCompletion && isUserRequested) {
      projection.journal.markReplayIncomplete();
    }
    if (projection && isDurableRootCompletion && !isUserRequested) {
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
          toolName: toolName ?? event.data.toolDescription?.name ?? projectedToolName ?? "unknown",
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
    markUnconsumedReasoningIncomplete();
    flushPendingAssistantProjection();
    observedSessionIdle = true;
    resolveSessionIdle?.();
    resolveSessionIdle = undefined;
  });

  registerListener(session, unsubscribeFns, "session.error", (event) => {
    markUnconsumedReasoningIncomplete();
    if (!options.isAborted()) {
      streamError = createPromptError(
        event.data.errorCode ?? event.data.errorType,
        event.data.message,
      );
    }
  });

  registerListener(session, unsubscribeFns, "abort", (event) => {
    markUnconsumedReasoningIncomplete();
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
      flushPendingAssistantProjection();
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
    flushTranscriptProjection() {
      markUnconsumedReasoningIncomplete();
      flushPendingAssistantProjection();
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
      const group = pendingAssistantProjection ?? lastAssistantProjection;
      return group
        ? buildAssistantProjectionGroup(
            group,
            args.modelRef,
            () => args.now(),
            usageByApiCallId,
            usage,
            false,
          ).message
        : buildAssistantMessage({
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
    for (const request of event.data.toolRequests ?? []) {
      projectedToolNamesByCallId.set(request.toolCallId, request.name);
    }
    const entry = ensureMessageAccumulator(messagesById, messageOrder, event.data.messageId);
    if (typeof event.data.content === "string" && event.data.content.length >= entry.text.length) {
      entry.text = event.data.content;
    }
    lastAssistantReasoningText =
      event.data.reasoningText ?? (joinReasoning(reasoningOrder, reasoningById) || undefined);
    const transcriptReasoningText =
      event.data.reasoningText ??
      (joinReasoning(durableReasoningOrder, durableReasoningById) || undefined);
    reasoningOrder.length = 0;
    reasoningById.clear();
    durableReasoningOrder.length = 0;
    durableReasoningById.clear();
    unconsumedDurableReasoning = false;
    const chunk: AssistantProjectionChunk = {
      event,
      assistantTexts: [messagesById.get(event.data.messageId)?.text ?? ""],
      ...(lastAssistantReasoningText ? { reasoningText: lastAssistantReasoningText } : {}),
      transcriptAssistantTexts: [event.data.content ?? ""],
      ...(transcriptReasoningText ? { transcriptReasoningText } : {}),
    };
    const apiCallId = readString(event.data.apiCallId);
    if (!apiCallId) {
      if (projectedAssistantMessageIdsWithoutApiCall.has(event.data.messageId)) {
        options.transcriptProjection?.journal.markReplayIncomplete();
        lastAssistantProjection = { chunks: [chunk] };
        return;
      }
      projectedAssistantMessageIdsWithoutApiCall.add(event.data.messageId);
      flushPendingAssistantProjection();
      const group = { chunks: [chunk] } satisfies AssistantProjectionGroup;
      lastAssistantProjection = group;
      recordAssistantProjection(group);
      return;
    }
    if (pendingAssistantProjection?.apiCallId !== apiCallId) {
      flushPendingAssistantProjection();
      pendingAssistantProjection = { apiCallId, chunks: [] };
    }
    const priorChunkIndex = pendingAssistantProjection.chunks.findIndex(
      (candidate) => candidate.event.data.messageId === event.data.messageId,
    );
    if (priorChunkIndex === -1) {
      pendingAssistantProjection.chunks.push(chunk);
    } else {
      pendingAssistantProjection.chunks[priorChunkIndex] = chunk;
    }
  }

  function flushPendingAssistantProjection(apiCallId?: string): void {
    const group = pendingAssistantProjection;
    if (!group || (apiCallId !== undefined && group.apiCallId !== apiCallId)) {
      return;
    }
    pendingAssistantProjection = undefined;
    lastAssistantProjection = group;
    recordAssistantProjection(group);
  }

  function markUnconsumedReasoningIncomplete(): void {
    if (unconsumedDurableReasoning) {
      options.transcriptProjection?.journal.markReplayIncomplete();
    }
    reasoningOrder.length = 0;
    reasoningById.clear();
    durableReasoningOrder.length = 0;
    durableReasoningById.clear();
    unconsumedDurableReasoning = false;
  }

  function flushPendingAssistantProjectionForToolCall(toolCallId: string): void {
    const group = pendingAssistantProjection;
    if (
      group?.chunks.some((chunk) =>
        chunk.event.data.toolRequests?.some((request) => request.toolCallId === toolCallId),
      )
    ) {
      flushPendingAssistantProjection();
    }
  }

  function recordAssistantProjection(group: AssistantProjectionGroup): void {
    const projection = options.transcriptProjection;
    if (!projection) {
      return;
    }
    const { message, replayIncomplete, toolCallIds } = buildAssistantProjectionGroup(
      group,
      projection.modelRef,
      (event) => resolveEventTimestamp(event.timestamp, projection.now),
      usageByApiCallId,
      // Optional assistant.usage must never delay canonical content. Later
      // unkeyed usage stays attempt metadata; this row uses per-call data only.
      undefined,
      true,
    );
    const eventId = group.chunks[0]?.event.id;
    if (!eventId) {
      return;
    }
    if (!message) {
      if (replayIncomplete) {
        projection.journal.markReplayIncomplete();
      }
      projection.journal.recordAssistantProjectionGap();
      return;
    }
    projection.journal.recordAssistant({
      eventId,
      message,
      replayIncomplete,
      toolCallIds,
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

function buildAssistantProjectionGroup(
  group: AssistantProjectionGroup,
  modelRef: { api?: string; id: string; provider: string },
  resolveTimestamp: (event: Extract<SessionEvent, { type: "assistant.message" }>) => number,
  usageByApiCallId: Map<string, AssistantUsageSnapshot>,
  latestUsage: AssistantUsageSnapshot | undefined,
  forTranscript: boolean,
): {
  message: AssistantMessage | undefined;
  replayIncomplete: boolean;
  toolCallIds: string[];
} {
  const messages = group.chunks.flatMap((chunk) => {
    const message = buildAssistantMessage({
      event: chunk.event,
      modelRef,
      now: () => resolveTimestamp(chunk.event),
      reasoningText: forTranscript ? chunk.transcriptReasoningText : chunk.reasoningText,
      // Usage is keyed to the complete API call, so every chunk resolves to the
      // same snapshot and the merged message keeps the terminal copy.
      usage: resolveAssistantUsage(chunk.event, latestUsage, usageByApiCallId),
      assistantTexts: forTranscript ? chunk.transcriptAssistantTexts : chunk.assistantTexts,
    });
    return message ? [message] : [];
  });
  const replayIncomplete = group.chunks.some(({ event }) =>
    hasUnprojectedAssistantReplayState(event),
  );
  const last = messages.at(-1);
  if (!last) {
    return { message: undefined, replayIncomplete, toolCallIds: [] };
  }
  const narrative: AssistantMessage["content"] = [];
  let terminalThinking:
    | Extract<AssistantMessage["content"][number], { type: "thinking" }>
    | undefined;
  const toolCallOrder: string[] = [];
  const toolCallsById = new Map<
    string,
    Extract<AssistantMessage["content"][number], { type: "toolCall" }>
  >();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "toolCall") {
        if (!toolCallsById.has(part.id)) {
          toolCallOrder.push(part.id);
        }
        toolCallsById.set(part.id, part);
        continue;
      }
      if (part.type === "thinking") {
        // Reasoning is an accumulated snapshot, not a per-message delta. Keep
        // only the terminal snapshot when one API call emits phased chunks.
        terminalThinking = part;
        continue;
      }
      const previous = narrative.at(-1);
      if (part.type === "text" && previous?.type === "text") {
        narrative[narrative.length - 1] = { ...previous, text: previous.text + part.text };
      } else {
        narrative.push(part);
      }
    }
  }
  const toolCalls = toolCallOrder.flatMap((id) => {
    const toolCall = toolCallsById.get(id);
    return toolCall ? [toolCall] : [];
  });
  const content = [...(terminalThinking ? [terminalThinking] : []), ...narrative, ...toolCalls];
  const toolCallIds = [...toolCallOrder];
  return {
    message: {
      ...last,
      content,
      stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
    },
    replayIncomplete,
    toolCallIds,
  };
}

function hasUnprojectedAssistantReplayState(
  event: Extract<SessionEvent, { type: "assistant.message" }>,
): boolean {
  // The SDK contract marks these as provider/session-bound state or custom
  // call shape. AgentMessage cannot represent them, so native replay must stay.
  return (
    event.data.citations !== undefined ||
    event.data.serverTools !== undefined ||
    event.data.reasoningWireField !== undefined ||
    event.data.reasoningOpaque !== undefined ||
    event.data.encryptedContent !== undefined ||
    event.data.toolRequests?.some((request) => request.type === "custom") === true
  );
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
