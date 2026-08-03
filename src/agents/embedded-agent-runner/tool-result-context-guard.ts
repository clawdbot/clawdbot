/**
 * Installs context guards for oversized tool-result histories.
 */
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { log } from "./logger.js";
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./run/midturn-precheck.js";
import {
  resolveOverflowToolResultAggregateBudget,
  shouldPreemptivelyCompactBeforePrompt,
} from "./run/preemptive-compaction.js";
import type { ToolResultPromptProjectionState } from "./session-prompt-state.js";
import {
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";
import {
  truncateOversizedToolResultsInMessages,
  truncateToolResultText,
} from "./tool-result-truncation.js";

const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const TRANSCRIPT_PROMPT_TEXT_KEY = "__openclawTranscriptPromptText";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

type MidTurnPrecheckOptions = {
  enabled?: boolean;
  contextTokenBudget: number;
  reserveTokens: () => number;
  toolResultMaxChars?: number;
  getSystemPrompt?: () => string | undefined;
  getPrePromptMessageCount?: () => number;
  projectionState?: ToolResultPromptProjectionState;
  onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
};

export function markTranscriptPromptText(message: AgentMessage, text: string): void {
  Object.defineProperty(message, TRANSCRIPT_PROMPT_TEXT_KEY, {
    configurable: true,
    enumerable: true,
    value: text,
  });
}

function getTranscriptPromptText(message: AgentMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>)[TRANSCRIPT_PROMPT_TEXT_KEY];
  return typeof value === "string" ? value : undefined;
}

function restoreTranscriptPromptText(
  message: AgentMessage,
  cache: WeakMap<AgentMessage, AgentMessage>,
): AgentMessage {
  const transcriptText = getTranscriptPromptText(message);
  if (transcriptText === undefined || message.role !== "user") {
    return message;
  }
  const cached = cache.get(message);
  if (cached) {
    return cached;
  }
  const content = (message as { content?: unknown }).content;
  const { [TRANSCRIPT_PROMPT_TEXT_KEY]: _transcriptPromptText, ...messageRest } =
    message as unknown as Record<string, unknown>;
  let restoredMessage: AgentMessage = message;
  if (typeof content === "string") {
    restoredMessage = { ...messageRest, content: transcriptText } as unknown as AgentMessage;
  } else if (Array.isArray(content)) {
    let restored = false;
    const nextContent = content.map((block) => {
      if (restored || !block || typeof block !== "object") {
        return block;
      }
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
        return block;
      }
      restored = true;
      return Object.assign({}, block, { text: transcriptText });
    });
    if (restored) {
      restoredMessage = { ...messageRest, content: nextContent } as unknown as AgentMessage;
    }
  }
  cache.set(message, restoredMessage);
  return restoredMessage;
}

function stripTranscriptPromptMarker(message: AgentMessage): AgentMessage {
  if (getTranscriptPromptText(message) === undefined) {
    return message;
  }
  const { [TRANSCRIPT_PROMPT_TEXT_KEY]: _transcriptPromptText, ...messageRest } =
    message as unknown as Record<string, unknown>;
  return messageRest as unknown as AgentMessage;
}

function projectTranscriptPromptMessages(
  messages: AgentMessage[],
  cache: WeakMap<AgentMessage, AgentMessage>,
): AgentMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    const next = restoreTranscriptPromptText(message, cache);
    changed ||= next !== message;
    return next;
  });
  return changed ? projected : messages;
}

function stripTranscriptPromptMarkers(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const stripped = messages.map((message) => {
    const next = stripTranscriptPromptMarker(message);
    changed ||= next !== message;
    return next;
  });
  return changed ? stripped : messages;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function estimateBudgetToRawChars(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE));
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    const omittedChars = Math.max(
      1,
      estimateBudgetToRawChars(Math.max(estimatedChars - maxChars, 1)),
    );
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(omittedChars));
  }

  if (maxChars <= 0) {
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(rawText.length));
  }

  const truncatedText = truncateToolResultText(rawText, maxChars, {
    minKeepChars: 0,
    minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
    preserveImportantTail: false,
  });
  return replaceToolResultText(msg, truncatedText);
}

function enforceToolResultLimit(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): AgentMessage[] {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  let changed = false;
  const guarded = messages.map((message) => {
    const next = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    changed ||= next !== message;
    return next;
  });
  return changed ? guarded : messages;
}

function hasNewToolResultAfterFence(params: {
  messages: AgentMessage[];
  prePromptMessageCount: number;
}): boolean {
  for (const message of params.messages.slice(params.prePromptMessageCount)) {
    if (isToolResultMessage(message)) {
      return true;
    }
  }
  return false;
}

function estimateAggregateToolResultChars(messages: AgentMessage[]): number {
  const estimateCache = createMessageCharEstimateCache();
  let total = 0;
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      total += estimateMessageCharsCached(message, estimateCache);
    }
  }
  return total;
}

function toMidTurnPrecheckRequest(
  result: ReturnType<typeof shouldPreemptivelyCompactBeforePrompt>,
): MidTurnPrecheckRequest | null {
  if (result.route === "fits") {
    return null;
  }
  return {
    route: result.route,
    estimatedPromptTokens: result.estimatedPromptTokens,
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    toolResultAggregateBudgetChars: result.toolResultAggregateBudgetChars,
    effectiveReserveTokens: result.effectiveReserveTokens,
  };
}

/**
 * Per-iteration `afterTurn` + `assemble` wrapper for sessions where
 * the context engine owns compaction. Lets the engine compact inside
 * a long tool loop instead of only at end of attempt.
 */
export function installContextEngineLoopHook(params: {
  agent: GuardableAgent;
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  tokenBudget?: number;
  modelId: string;
  repairAssembledMessages?: (messages: AgentMessage[]) => AgentMessage[];
  getPrePromptMessageCount?: () => number;
  onAfterTurnCheckpoint?: (messageCount: number) => void;
  getRuntimeContext?: (params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }) => ContextEngineRuntimeContext | undefined;
  runtimeSettings?: ContextEngineRuntimeSettings;
  /** True when this turn belongs to a heartbeat run. */
  isHeartbeat?: boolean;
}): () => void {
  const { contextEngine, sessionId, sessionKey, sessionFile, tokenBudget, modelId } = params;
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;
  let lastAssembledView: AgentMessage[] | null = null;
  let lastSourceMessages: AgentMessage[] | null = null;
  const transcriptProjectionCache = new WeakMap<AgentMessage, AgentMessage>();

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const transcriptMessages = projectTranscriptPromptMessages(
      sourceMessages,
      transcriptProjectionCache,
    );
    const providerMessages = stripTranscriptPromptMarkers(sourceMessages);
    const checkedPrefixLength =
      lastSeenLength == null ? 0 : Math.min(lastSeenLength, transcriptMessages.length);
    const sourceHistoryChanged =
      lastSeenLength != null &&
      lastSourceMessages != null &&
      (transcriptMessages.length < lastSeenLength ||
        (transcriptMessages.length === lastSeenLength &&
          transcriptMessages
            .slice(0, checkedPrefixLength)
            .some((message, index) => message !== lastSourceMessages?.[index])));
    if (sourceHistoryChanged) {
      lastSeenLength = null;
      lastAssembledView = null;
    }

    // Seed the loop fence from the attempt's pre-prompt message count when available.
    // This keeps the first real post-tool-call iteration eligible for compaction even
    // if the hook's first observed call happens after tool results were appended.
    const prePromptMessageCount = Math.max(
      0,
      Math.min(
        transcriptMessages.length,
        lastSeenLength ?? params.getPrePromptMessageCount?.() ?? transcriptMessages.length,
      ),
    );

    const hasNewMessages = transcriptMessages.length > prePromptMessageCount;
    if (!hasNewMessages) {
      lastSeenLength = prePromptMessageCount;
      lastSourceMessages = transcriptMessages;
      return lastAssembledView ?? providerMessages;
    }
    try {
      if (typeof contextEngine.afterTurn === "function") {
        await contextEngine.afterTurn({
          sessionId,
          sessionKey,
          sessionTarget: params.sessionTarget,
          sessionFile,
          messages: transcriptMessages,
          prePromptMessageCount,
          tokenBudget,
          runtimeContext: params.getRuntimeContext?.({
            messages: transcriptMessages,
            prePromptMessageCount,
          }),
          runtimeSettings: params.runtimeSettings,
          isHeartbeat: params.isHeartbeat,
        });
      } else {
        const newMessages = transcriptMessages.slice(prePromptMessageCount);
        if (newMessages.length > 0) {
          if (typeof contextEngine.ingestBatch === "function") {
            await contextEngine.ingestBatch({
              sessionId,
              sessionKey,
              messages: newMessages,
              isHeartbeat: params.isHeartbeat,
            });
          } else {
            for (const message of newMessages) {
              await contextEngine.ingest({
                sessionId,
                sessionKey,
                message,
                isHeartbeat: params.isHeartbeat,
              });
            }
          }
        }
      }
      lastSeenLength = transcriptMessages.length;
      params.onAfterTurnCheckpoint?.(lastSeenLength);
      lastSourceMessages = transcriptMessages;
      const assembled = await contextEngine.assemble({
        sessionId,
        sessionKey,
        messages: providerMessages,
        tokenBudget,
        model: modelId,
        runtimeSettings: params.runtimeSettings,
      });
      if (assembled && Array.isArray(assembled.messages)) {
        const repairedMessages =
          params.repairAssembledMessages?.(assembled.messages) ?? assembled.messages;
        if (repairedMessages !== providerMessages || assembled.messages !== providerMessages) {
          lastAssembledView = repairedMessages;
          return repairedMessages;
        }
      }
      lastAssembledView = null;
    } catch {
      // Best-effort: any engine failure falls through to the raw source
      // messages so the tool loop still makes forward progress.
      lastSeenLength = prePromptMessageCount;
      lastAssembledView = null;
      lastSourceMessages = transcriptMessages;
    }

    return providerMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
  midTurnPrecheck?: MidTurnPrecheckOptions;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in session runtime, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const contextMessages = enforceToolResultLimit({
      messages: sourceMessages,
      maxSingleToolResultChars,
    });
    if (params.midTurnPrecheck?.enabled) {
      const configuredPrePromptMessageCount =
        lastSeenLength ?? params.midTurnPrecheck.getPrePromptMessageCount?.();
      const prePromptMessageCount = Math.max(
        0,
        Math.min(contextMessages.length, configuredPrePromptMessageCount ?? contextMessages.length),
      );
      const rawPrePromptMessageCount = Math.max(
        0,
        Math.min(messages.length, configuredPrePromptMessageCount ?? messages.length),
      );
      lastSeenLength = prePromptMessageCount;
      if (
        hasNewToolResultAfterFence({
          messages: contextMessages,
          prePromptMessageCount,
        }) ||
        hasNewToolResultAfterFence({
          messages,
          prePromptMessageCount: rawPrePromptMessageCount,
        })
      ) {
        // Use the same post-truncation view the runtime will send to the next model call.
        // Recovery re-applies truncation to the persisted session manager, so
        // this precheck is only a routing signal, not the source of truth.
        const precheck = shouldPreemptivelyCompactBeforePrompt({
          messages: contextMessages,
          systemPrompt: params.midTurnPrecheck.getSystemPrompt?.(),
          // During a tool loop, the active user prompt is already part of messages.
          prompt: "",
          contextTokenBudget: params.midTurnPrecheck.contextTokenBudget,
          reserveTokens: params.midTurnPrecheck.reserveTokens(),
          toolResultMaxChars: params.midTurnPrecheck.toolResultMaxChars,
        });
        let request = toMidTurnPrecheckRequest(precheck);
        // A compaction-owning context engine may return an assembled view whose
        // tool results are summarized or represented as ordinary messages. If
        // that view still overflows, retain the engine's first chance to compact
        // but derive a truncate-only recovery budget from the raw transcript.
        // The budget can then be applied to a provider-only projection, so this
        // remains compatible with both owner-compaction engines and the built-in
        // context path without discarding recallable history.
        if (
          request &&
          sourceMessages !== messages &&
          hasNewToolResultAfterFence({
            messages,
            prePromptMessageCount: rawPrePromptMessageCount,
          })
        ) {
          const rawMessages = enforceToolResultLimit({
            messages,
            maxSingleToolResultChars,
          });
          const rawPrecheck = shouldPreemptivelyCompactBeforePrompt({
            messages: rawMessages,
            systemPrompt: params.midTurnPrecheck.getSystemPrompt?.(),
            prompt: "",
            contextTokenBudget: params.midTurnPrecheck.contextTokenBudget,
            reserveTokens: params.midTurnPrecheck.reserveTokens(),
            toolResultMaxChars: params.midTurnPrecheck.toolResultMaxChars,
          });
          const rawRequest = toMidTurnPrecheckRequest(rawPrecheck);
          const rawToolResultChars = estimateAggregateToolResultChars(rawMessages);
          const rawOverflowBudget = resolveOverflowToolResultAggregateBudget({
            overflowTokens: request.overflowTokens,
            totalToolResultChars: rawToolResultChars,
          });
          const rawAggregateBudgetChars = Math.min(
            rawRequest?.toolResultAggregateBudgetChars ?? Number.POSITIVE_INFINITY,
            rawOverflowBudget.aggregateBudgetChars,
          );
          if (rawToolResultChars > rawAggregateBudgetChars) {
            const aggregateBudgetChars = Math.min(
              request.toolResultAggregateBudgetChars ?? Number.POSITIVE_INFINITY,
              rawAggregateBudgetChars,
            );
            request = {
              ...request,
              route:
                request.route === "compact_only"
                  ? rawToolResultChars - aggregateBudgetChars >=
                    rawOverflowBudget.requiredReductionChars
                    ? "truncate_tool_results_only"
                    : "compact_then_truncate"
                  : request.route,
              toolResultReducibleChars: Math.max(
                request.toolResultReducibleChars,
                rawToolResultChars - aggregateBudgetChars,
              ),
              toolResultAggregateBudgetChars: aggregateBudgetChars,
            };
            log.info(
              `[context-overflow-midturn-precheck] context-engine assembled view still overflowed; ` +
                `using raw tool-result recovery route=${request.route} ` +
                `aggregateBudgetChars=${aggregateBudgetChars}`,
            );
          }
        }
        if (
          request?.toolResultAggregateBudgetChars !== undefined &&
          (request.route === "truncate_tool_results_only" ||
            request.route === "compact_then_truncate")
        ) {
          // Apply the recovery budget directly to the provider-boundary view. This is
          // essential for compaction-owning engines: they may have already ingested the
          // full tool payload into their private store, so truncating the transcript and
          // retrying would simply make assemble() return the same oversized payload again.
          // The projection preserves the full transcript/engine history for later recall.
          const projected = truncateOversizedToolResultsInMessages(
            contextMessages,
            contextWindowTokens,
            params.midTurnPrecheck.toolResultMaxChars,
            request.toolResultAggregateBudgetChars,
            params.midTurnPrecheck.projectionState,
            false,
          );
          if (projected.messages !== contextMessages) {
            const projectedPrecheck = shouldPreemptivelyCompactBeforePrompt({
              messages: projected.messages,
              systemPrompt: params.midTurnPrecheck.getSystemPrompt?.(),
              prompt: "",
              contextTokenBudget: params.midTurnPrecheck.contextTokenBudget,
              reserveTokens: params.midTurnPrecheck.reserveTokens(),
              toolResultMaxChars: params.midTurnPrecheck.toolResultMaxChars,
            });
            if (projectedPrecheck.route === "fits") {
              log.info(
                `[context-overflow-midturn-precheck] recovered in memory with provider-boundary ` +
                  `tool-result projection truncatedCount=${projected.truncatedCount} ` +
                  `aggregateBudgetChars=${projected.aggregateBudgetChars}`,
              );
              lastSeenLength = contextMessages.length;
              return projected.messages;
            }
          }
        }
        log.debug(
          `[context-overflow-midturn-precheck] tool-result-guard check route=${precheck.route} ` +
            `messages=${contextMessages.length} prePromptMessageCount=${prePromptMessageCount} ` +
            `estimatedPromptTokens=${precheck.estimatedPromptTokens} ` +
            `promptBudgetBeforeReserve=${precheck.promptBudgetBeforeReserve} ` +
            `overflowTokens=${precheck.overflowTokens}`,
        );
        if (request) {
          params.midTurnPrecheck.onMidTurnPrecheck?.(request);
          throw new MidTurnPrecheckSignal(request);
        }
      }
      lastSeenLength = contextMessages.length;
    }
    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
