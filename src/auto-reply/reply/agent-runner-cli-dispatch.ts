// Builds CLI runtime dispatch inputs for agent runner executions.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runCliAgent } from "../../agents/cli-runner.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { clearCliSession } from "../../agents/cli-session.js";
import { extractToolResultText } from "../../agents/embedded-agent-subscribe.tools.js";
import { inferToolMetaFromArgs } from "../../agents/embedded-agent-utils.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoProgressText,
  resolveFastModeForElapsed,
  type FastModeAutoProgressState,
} from "../../agents/fast-mode.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import { emitAgentEvent, withAgentRunLifecycleGeneration } from "../../infra/agent-events.js";
import { FAST_MODE_AUTO_PROGRESS_KIND, type ReplyPayload } from "../reply-payload.js";
import { formatToolAggregate } from "../tool-meta.js";
import type { GetReplyOptions } from "../types.js";
import {
  type AgentEventDeliveryStartOrder,
  createAgentEventBridge,
  createAgentEventDeliveryStartOrder,
} from "./agent-event-bridge.js";
import { resolveAgentLifecycleTerminalMetadata } from "./agent-lifecycle-terminal.js";

type AgentEventBridge = {
  unsubscribe: () => void;
  drain: () => Promise<void>;
};

async function stopAgentEventBridges(bridges: readonly AgentEventBridge[]): Promise<void> {
  for (const bridge of bridges) {
    bridge.unsubscribe();
  }
  for (const bridge of bridges) {
    await bridge.drain();
  }
}

function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    startOrder: params.startOrder,
    read: (evt) => {
      if (evt.stream !== "assistant") {
        return undefined;
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return text;
    },
  });
}

type ReasoningTextPayload = {
  text: string;
  isReasoningSnapshot?: boolean;
};

type ReasoningProgressPayload = {
  progressTokens: number;
};

export function createCliReasoningStreamBridge(
  onReasoningStream: GetReplyOptions["onReasoningStream"] | undefined,
): ((payload: ReasoningTextPayload) => Promise<void>) | undefined {
  if (!onReasoningStream) {
    return undefined;
  }
  return async ({ text, isReasoningSnapshot }) => {
    await onReasoningStream({
      text,
      ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}),
      requiresReasoningProgressOptIn: true,
    });
  };
}

function createReasoningTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: ReasoningTextPayload) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    startOrder: params.startOrder,
    read: (evt) => {
      if (evt.stream !== "thinking") {
        return undefined;
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return {
        text,
        ...(evt.data.isReasoningSnapshot === true ? { isReasoningSnapshot: true } : {}),
      };
    },
  });
}

function createReasoningProgressBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: ReasoningProgressPayload) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  let lastProgressTokens: number | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    startOrder: params.startOrder,
    read: (evt) => {
      if (evt.stream !== "thinking") {
        return undefined;
      }
      const progressTokens = evt.data.progressTokens;
      if (
        typeof progressTokens !== "number" ||
        !Number.isFinite(progressTokens) ||
        progressTokens <= 0 ||
        progressTokens === lastProgressTokens
      ) {
        return undefined;
      }
      lastProgressTokens = progressTokens;
      return { progressTokens };
    },
  });
}

type CommentaryTextPayload = {
  text: string;
  itemId?: string;
};

function readCommentaryTextPayload(evt: AgentEventPayload): CommentaryTextPayload | undefined {
  if (evt.stream !== "item" || evt.data.kind !== "preamble") {
    return undefined;
  }
  const text = typeof evt.data.progressText === "string" ? evt.data.progressText.trim() : "";
  if (!text) {
    return undefined;
  }
  return {
    text,
    ...(typeof evt.data.itemId === "string" ? { itemId: evt.data.itemId } : {}),
  };
}

type CliToolEventPayload = {
  name: string | undefined;
  phase: "start" | "update" | "result";
  args: Record<string, unknown> | undefined;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
};

export function keepCliSessionBindingOnlyWhenReused(params: {
  result: EmbeddedAgentRunResult;
  existingSessionId?: string;
  onDroppedReplacement?: () => void;
}): EmbeddedAgentRunResult {
  const existingSessionId = normalizeOptionalString(params.existingSessionId);
  const agentMeta = params.result.meta.agentMeta;
  const returnedSessionId = normalizeOptionalString(agentMeta?.cliSessionBinding?.sessionId);
  const shouldClearStoredSession = agentMeta?.clearCliSessionBinding === true;
  if (
    agentMeta === undefined ||
    (!shouldClearStoredSession && existingSessionId === undefined) ||
    returnedSessionId === existingSessionId
  ) {
    return params.result;
  }
  if (returnedSessionId || shouldClearStoredSession) {
    params.onDroppedReplacement?.();
  }
  return {
    ...params.result,
    meta: {
      ...params.result.meta,
      agentMeta: {
        ...agentMeta,
        sessionId: "",
        cliSessionBinding: undefined,
        clearCliSessionBinding: undefined,
      },
    },
  };
}

export async function clearDroppedCliSessionBinding(params: {
  provider: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  activeSessionEntry?: SessionEntry;
}): Promise<void> {
  const updatedAt = Date.now();
  const clearEntry = (entry: SessionEntry | undefined) => {
    if (!entry) {
      return;
    }
    clearCliSession(entry, params.provider);
    entry.updatedAt = updatedAt;
  };
  clearEntry(params.activeSessionEntry);
  clearEntry(params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!params.storePath || !params.sessionKey) {
    return;
  }
  await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (entry) => {
      clearEntry(entry);
      return entry;
    },
  );
}

function createToolEventBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: CliToolEventPayload) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    startOrder: params.startOrder,
    read: (evt) => {
      if (evt.stream !== "tool") {
        return undefined;
      }
      const phaseValue = evt.data.phase;
      if (phaseValue !== "start" && phaseValue !== "update" && phaseValue !== "result") {
        return undefined;
      }
      const phase: CliToolEventPayload["phase"] =
        phaseValue === "start" ? "start" : phaseValue === "update" ? "update" : "result";
      return {
        name: typeof evt.data.name === "string" ? evt.data.name : undefined,
        phase,
        args: isRecord(evt.data.args) ? evt.data.args : undefined,
        toolCallId: typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined,
        ...(phase === "result"
          ? {
              isError: evt.data.isError === true,
              result: evt.data.result,
            }
          : {}),
      };
    },
  });
}

/**
 * Tracks CLI tool start/result events and renders the same durable tool
 * summaries the embedded runner emits: a formatToolAggregate line per result
 * (args-derived meta captured at start), plus the output block under full
 * verbose. Keeps CLI runs at tool-summary parity with embedded runs.
 */
export function createCliToolSummaryTracker(params: {
  detailMode?: "explain" | "raw";
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  deliver: (payload: { text: string; isError?: boolean }) => Promise<void> | void;
}) {
  const metaByCallId = new Map<string, string | undefined>();
  return {
    noteToolEvent: async (payload: CliToolEventPayload): Promise<void> => {
      if (payload.phase === "start") {
        if (payload.toolCallId && payload.name) {
          metaByCallId.set(
            payload.toolCallId,
            inferToolMetaFromArgs(payload.name, payload.args, {
              detailMode: params.detailMode ?? "explain",
            }),
          );
        }
        return;
      }
      if (payload.phase !== "result") {
        return;
      }
      const meta = payload.toolCallId ? metaByCallId.get(payload.toolCallId) : undefined;
      if (payload.toolCallId) {
        metaByCallId.delete(payload.toolCallId);
      }
      if (!params.shouldEmitToolResult()) {
        return;
      }
      const aggregate = formatToolAggregate(payload.name, meta ? [meta] : undefined, {
        markdown: true,
      });
      let text = aggregate;
      if (params.shouldEmitToolOutput()) {
        const output = extractToolResultText(payload.result)?.trim();
        if (output) {
          text = `${aggregate}\n\`\`\`txt\n${output}\n\`\`\``;
        }
      }
      if (!text.trim()) {
        return;
      }
      await params.deliver({ text, ...(payload.isError === true ? { isError: true } : {}) });
    },
  };
}

function createCommentaryEventBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: CommentaryTextPayload) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    startOrder: params.startOrder,
    read: readCommentaryTextPayload,
  });
}

function createPlanUpdateBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: GetReplyOptions["onPlanUpdate"];
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  const deliver = params.deliver;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    // GetReplyOptions callbacks may return void; the bridge awaits promises.
    deliver: deliver
      ? async (payload: Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0]) => {
          await deliver(payload);
        }
      : undefined,
    startOrder: params.startOrder,
    read: (evt) => {
      if (evt.stream !== "plan") {
        return undefined;
      }
      return {
        phase: normalizeOptionalString(evt.data.phase),
        title: normalizeOptionalString(evt.data.title),
        explanation: normalizeOptionalString(evt.data.explanation),
        steps: normalizeAgentPlanSteps(evt.data.steps),
        source: normalizeOptionalString(evt.data.source),
      };
    },
  });
}

function createToolBoundaryBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: () => Promise<void>;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: (evt) => {
      if (evt.stream !== "tool") {
        return undefined;
      }
      const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
      return ["completed", "end", "error", "result"].includes(phase) ? true : undefined;
    },
  });
}

type RunCliAgentWithLifecycleParams = {
  runId: string;
  lifecycleGeneration?: string;
  provider: string;
  runParams: RunCliAgentParams;
  startedAt?: number;
  emitLifecycleStart?: boolean;
  emitLifecycleTerminal?: boolean;
  onAgentRunStart?: () => void;
  suppressAssistantBridge?: boolean;
  /**
   * Stamped before every delivered CLI progress event (assistant, reasoning,
   * tool, commentary, fast-mode). Callers wire this to the reply operation's
   * activity evidence; per-callback stamps at call sites drift and a missed
   * stamp lets stale-takeover reclaim a healthy run.
   */
  onActivity?: () => void;
  preserveProgressCallbackStartOrder?: boolean;
  onAssistantText?: (text: string) => Promise<void>;
  onReasoningText?: (payload: ReasoningTextPayload) => Promise<void>;
  onReasoningProgress?: (payload: ReasoningProgressPayload) => Promise<void>;
  onToolEvent?: (payload: CliToolEventPayload) => Promise<void>;
  onCommentaryText?: (payload: CommentaryTextPayload) => Promise<void>;
  onPlanUpdate?: GetReplyOptions["onPlanUpdate"];
  onFastModeAutoProgress?: (payload: ReplyPayload) => Promise<void>;
  onErrorBeforeLifecycle?: (err: unknown) => Promise<void>;
  transformResult?: (result: EmbeddedAgentRunResult) => EmbeddedAgentRunResult;
};

export function runCliAgentWithLifecycle(
  params: RunCliAgentWithLifecycleParams,
): Promise<EmbeddedAgentRunResult> {
  if (!params.lifecycleGeneration) {
    return runCliAgentWithLifecycleInternal(params);
  }
  return withAgentRunLifecycleGeneration(params.lifecycleGeneration, () =>
    runCliAgentWithLifecycleInternal(params),
  );
}

async function runCliAgentWithLifecycleInternal(
  params: RunCliAgentWithLifecycleParams,
): Promise<EmbeddedAgentRunResult> {
  const startedAt = params.startedAt ?? Date.now();
  const fastModeStartedAtMs = params.runParams.fastModeStartedAtMs ?? startedAt;
  const fastModeAutoOnSeconds =
    params.runParams.fastModeAutoOnSeconds ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
  const fastModeAutoProgressState: FastModeAutoProgressState = params.runParams
    .fastModeAutoProgressState ?? {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }) => {
    const summary = formatFastModeAutoProgressText(payload);
    emitAgentEvent({
      runId: params.runId,
      stream: "item",
      data: {
        kind: "status",
        title: "Fast",
        phase: "update",
        summary,
      },
      ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
    });
    try {
      await params.onFastModeAutoProgress?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch {
      // Progress hints are best-effort; a channel failure must not fail the agent turn.
    }
  };
  const maybeAnnounceFastModeAutoOff = async () => {
    if (params.runParams.fastMode !== "auto" || fastModeAutoProgressState.offAnnounced) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeStartedAtMs,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  const maybeEmitFastModeAutoReset = async () => {
    if (
      params.runParams.fastMode !== "auto" ||
      !fastModeAutoProgressState.offAnnounced ||
      fastModeAutoProgressState.resetAnnounced
    ) {
      return;
    }
    fastModeAutoProgressState.resetAnnounced = true;
    await emitFastModeAutoProgress({
      enabled: true,
      elapsedSeconds: 0,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
  };
  const emitLifecycleStart = params.emitLifecycleStart ?? true;
  const emitLifecycleTerminal = params.emitLifecycleTerminal ?? true;
  params.onAgentRunStart?.();
  if (emitLifecycleStart) {
    emitAgentEvent({
      runId: params.runId,
      ...(params.runParams.agentId ? { agentId: params.runParams.agentId } : {}),
      ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
      ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
      ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
      stream: "lifecycle",
      data: {
        phase: "start",
        startedAt,
      },
    });
  }
  // One delivery-independent activity seam for every CLI agent event.
  // Suppressed (silentExpected) runs still emit real events and must keep
  // stamping, or a healthy silent stream looks stale to the takeover window.
  const activityBridge = params.onActivity
    ? createAgentEventBridge<Record<string, never>>({
        runId: params.runId,
        read: () => ({}),
        deliver: async () => {
          params.onActivity?.();
        },
      })
    : undefined;
  const progressStartOrder = params.preserveProgressCallbackStartOrder
    ? createAgentEventDeliveryStartOrder()
    : undefined;
  const assistantBridge = createAssistantTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onAssistantText,
    startOrder: progressStartOrder,
  });
  let finalReasoningText: string | undefined;
  const reasoningBridge = createReasoningTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    startOrder: progressStartOrder,
    deliver: async (payload: ReasoningTextPayload) => {
      finalReasoningText = normalizeOptionalString(payload.text);
      await params.onReasoningText?.(payload);
    },
  });
  const reasoningProgressBridge = createReasoningProgressBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onReasoningProgress,
    startOrder: progressStartOrder,
  });
  const toolBridge = createToolEventBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onToolEvent,
    startOrder: progressStartOrder,
  });
  const commentaryBridge = createCommentaryEventBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onCommentaryText,
    startOrder: progressStartOrder,
  });
  const planBridge = createPlanUpdateBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onPlanUpdate,
    startOrder: progressStartOrder,
  });
  const toolBoundaryBridge = createToolBoundaryBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: maybeAnnounceFastModeAutoOff,
  });
  const bridges = [
    activityBridge,
    assistantBridge,
    reasoningBridge,
    reasoningProgressBridge,
    toolBridge,
    commentaryBridge,
    planBridge,
    toolBoundaryBridge,
  ].filter((bridge): bridge is AgentEventBridge => bridge !== undefined);
  let lifecycleTerminalEmitted = false;
  try {
    const rawResult = await runCliAgent({
      ...params.runParams,
      emitCommentaryText: params.runParams.emitCommentaryText ?? Boolean(params.onCommentaryText),
    });
    const restartAbortReason = params.runParams.abortSignal?.reason;
    if (isAgentRunRestartAbortReason(restartAbortReason)) {
      throw restartAbortReason;
    }
    const result = params.transformResult?.(rawResult) ?? rawResult;
    await stopAgentEventBridges(bridges);

    const cliText = normalizeOptionalString(result.payloads?.[0]?.text);
    const durableReasoningText = normalizeOptionalString(finalReasoningText);
    const resultWithReasoning = durableReasoningText
      ? {
          ...result,
          payloads: [{ text: durableReasoningText, isReasoning: true }, ...(result.payloads ?? [])],
        }
      : result;
    if (cliText) {
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: cliText },
      });
    }

    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.agentId ? { agentId: params.runParams.agentId } : {}),
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          ...resolveAgentLifecycleTerminalMetadata(result.meta),
          ...resolveAgentRunAbortLifecycleFields(params.runParams.abortSignal),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    return resultWithReasoning;
  } catch (err) {
    await stopAgentEventBridges(bridges);
    await params.onErrorBeforeLifecycle?.(err);
    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.agentId ? { agentId: params.runParams.agentId } : {}),
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: String(err),
          ...resolveAgentRunErrorLifecycleFields(err, params.runParams.abortSignal),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    throw err;
  } finally {
    for (const bridge of bridges) {
      bridge.unsubscribe();
    }
    if (params.runParams.isFinalFallbackAttempt !== false) {
      await maybeEmitFastModeAutoReset();
    }
    if (emitLifecycleTerminal && !lifecycleTerminalEmitted) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.agentId ? { agentId: params.runParams.agentId } : {}),
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: "CLI run completed without lifecycle terminal event",
          ...resolveAgentRunAbortLifecycleFields(params.runParams.abortSignal),
        },
      });
    }
  }
}
