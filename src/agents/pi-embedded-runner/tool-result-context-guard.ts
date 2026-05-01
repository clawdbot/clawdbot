import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  formatContextLimitTruncationNotice,
} from "./context-truncation-notice.js";
import { log } from "./logger.js";
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./run/midturn-precheck.js";
import { shouldPreemptivelyCompactBeforePrompt } from "./run/preemptive-compaction.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Context overflow: estimated context size exceeds safe threshold during tool loop.";
const TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO = 4 / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;

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
  onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
};

export { CONTEXT_LIMIT_TRUNCATION_NOTICE, formatContextLimitTruncationNotice };

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return formatContextLimitTruncationNotice(text.length);
  }

  let bodyBudget = maxChars;
  for (let i = 0; i < 4; i += 1) {
    const estimatedSuffix = formatContextLimitTruncationNotice(
      Math.max(1, text.length - bodyBudget),
    );
    bodyBudget = Math.max(0, maxChars - estimatedSuffix.length);
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", cutPoint);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  const omittedChars = text.length - cutPoint;
  return text.slice(0, cutPoint) + formatContextLimitTruncationNotice(omittedChars);
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

function estimateBudgetToTextBudget(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars / TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO));
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
      estimateBudgetToTextBudget(Math.max(estimatedChars - maxChars, 1)),
    );
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(omittedChars));
  }

  const textBudget = estimateBudgetToTextBudget(maxChars);
  if (textBudget <= 0) {
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(rawText.length));
  }

  if (rawText.length <= textBudget) {
    return replaceToolResultText(msg, rawText);
  }

  const truncatedText = truncateTextToBudget(rawText, textBudget);
  return replaceToolResultText(msg, truncatedText);
}

function cloneMessagesForGuard(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(
    (msg) => ({ ...(msg as unknown as Record<string, unknown>) }) as unknown as AgentMessage,
  );
}

function toolResultsNeedTruncation(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): boolean {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    if (estimateMessageCharsCached(message, estimateCache) > maxSingleToolResultChars) {
      return true;
    }
  }
  return false;
}

function exceedsPreemptiveOverflowThreshold(params: {
  messages: AgentMessage[];
  maxContextChars: number;
}): boolean {
  const estimateCache = createMessageCharEstimateCache();
  return estimateContextChars(params.messages, estimateCache) > params.maxContextChars;
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultLimitInPlace(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): void {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }
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
  sessionFile: string;
  tokenBudget?: number;
  modelId: string;
  getPrePromptMessageCount?: () => number;
  getRuntimeContext?: (params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }) => ContextEngineRuntimeContext | undefined;
}): () => void {
  const { contextEngine, sessionId, sessionKey, sessionFile, tokenBudget, modelId } = params;
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;
  let lastAssembledView: AgentMessage[] | null = null;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;

    // Seed the loop fence from the attempt's pre-prompt message count when available.
    // This keeps the first real post-tool-call iteration eligible for compaction even
    // if the hook's first observed call happens after tool results were appended.
    const prePromptMessageCount = Math.max(
      0,
      Math.min(
        sourceMessages.length,
        lastSeenLength ?? params.getPrePromptMessageCount?.() ?? sourceMessages.length,
      ),
    );
    lastSeenLength = prePromptMessageCount;

    const hasNewMessages = sourceMessages.length > prePromptMessageCount;
    if (!hasNewMessages) {
      return lastAssembledView ?? sourceMessages;
    }
    try {
      if (typeof contextEngine.afterTurn === "function") {
        await contextEngine.afterTurn({
          sessionId,
          sessionKey,
          sessionFile,
          messages: sourceMessages,
          prePromptMessageCount,
          tokenBudget,
          runtimeContext: params.getRuntimeContext?.({
            messages: sourceMessages,
            prePromptMessageCount,
          }),
        });
      } else {
        const newMessages = sourceMessages.slice(prePromptMessageCount);
        if (newMessages.length > 0) {
          if (typeof contextEngine.ingestBatch === "function") {
            await contextEngine.ingestBatch({
              sessionId,
              sessionKey,
              messages: newMessages,
            });
          } else {
            for (const message of newMessages) {
              await contextEngine.ingest({
                sessionId,
                sessionKey,
                message,
              });
            }
          }
        }
      }
      lastSeenLength = sourceMessages.length;
      const assembled = await contextEngine.assemble({
        sessionId,
        sessionKey,
        messages: sourceMessages,
        tokenBudget,
        model: modelId,
      });
      if (assembled && Array.isArray(assembled.messages) && assembled.messages !== sourceMessages) {
        lastAssembledView = assembled.messages;
        return assembled.messages;
      }
      lastAssembledView = null;
    } catch {
      // Best-effort: any engine failure falls through to the raw source
      // messages so the tool loop still makes forward progress.
    }

    return sourceMessages;
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
  const maxContextChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const contextMessages = toolResultsNeedTruncation({
      messages: sourceMessages,
      maxSingleToolResultChars,
    })
      ? cloneMessagesForGuard(sourceMessages)
      : sourceMessages;
    if (contextMessages !== sourceMessages) {
      enforceToolResultLimitInPlace({
        messages: contextMessages,
        maxSingleToolResultChars,
      });
    }
    if (params.midTurnPrecheck?.enabled) {
      const prePromptMessageCount = Math.max(
        0,
        Math.min(
          contextMessages.length,
          lastSeenLength ??
            params.midTurnPrecheck.getPrePromptMessageCount?.() ??
            contextMessages.length,
        ),
      );
      lastSeenLength = prePromptMessageCount;
      if (
        hasNewToolResultAfterFence({
          messages: contextMessages,
          prePromptMessageCount,
        })
      ) {
        // Use the same post-truncation view Pi will send to the next model call.
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
        const request = toMidTurnPrecheckRequest(precheck);
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
    if (
      exceedsPreemptiveOverflowThreshold({
        messages: contextMessages,
        maxContextChars,
      })
    ) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
