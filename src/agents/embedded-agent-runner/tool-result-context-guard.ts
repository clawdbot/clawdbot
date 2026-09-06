/**
 * Installs context guards for oversized tool-result histories.
 */
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { estimateTokens, type AgentMessage } from "../runtime/index.js";
import { resolveToolResultContextMaxChars } from "../tool-result-limits.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { log } from "./logger.js";
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./run/midturn-precheck.js";
import {
  shouldPreemptivelyCompactBeforePrompt,
  type CompactionReplayPressureContext,
} from "./run/preemptive-compaction.js";
import {
  TOOL_IMAGE_CHARS,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";
import { truncateToolResultMessage, truncateToolResultText } from "./tool-result-truncation.js";

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
  getReplay?: () => CompactionReplayPressureContext;
  enabled?: boolean;
  contextTokenBudget: number;
  reserveTokens: () => number;
  toolResultMaxChars?: number;
  getSystemPrompt?: () => string | undefined;
  getPrePromptMessageCount?: () => number;
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
  const value = Reflect.get(message, TRANSCRIPT_PROMPT_TEXT_KEY);
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
  const messageRest = { ...message };
  Reflect.deleteProperty(messageRest, TRANSCRIPT_PROMPT_TEXT_KEY);
  let restoredMessage: AgentMessage = message;
  if (typeof content === "string") {
    restoredMessage = Object.assign(messageRest, { content: transcriptText });
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
      restoredMessage = Object.assign(messageRest, { content: nextContent });
    }
  }
  cache.set(message, restoredMessage);
  return restoredMessage;
}

function stripTranscriptPromptMarker(message: AgentMessage): AgentMessage {
  if (getTranscriptPromptText(message) === undefined) {
    return message;
  }
  const messageRest = { ...message };
  Reflect.deleteProperty(messageRest, TRANSCRIPT_PROMPT_TEXT_KEY);
  return messageRest;
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

function replaceToolResultContent(
  msg: AgentMessage,
  replacement: string | unknown[],
): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const rest = { ...msg };
  Reflect.deleteProperty(rest, "details");
  return {
    ...rest,
    content:
      typeof replacement === "string" && !(typeof content === "string" || content === undefined)
        ? [{ type: "text", text: replacement }]
        : replacement,
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
  const content = (msg as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const isImage = (block: unknown) =>
      Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image";
    const isText = (block: unknown): block is { type: "text"; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string";
    const imageCount = content.filter(isImage).length;
    const omissionNotice = (retainedImages: number) => {
      const omittedImages = imageCount - retainedImages;
      return (
        `[${omittedImages} image${omittedImages === 1 ? "" : "s"} omitted from context` +
        `${retainedImages === 0 ? "; no images fit the context limit" : ""}; rerun with fewer images]`
      );
    };
    const projectContent = (retainedContent: unknown[], noticeText?: string) => {
      const notice = noticeText ? [{ type: "text", text: noticeText }] : [];
      const reservedChars = estimateMessageCharsCached(
        replaceToolResultContent(msg, [
          ...retainedContent.filter((block) => !isText(block)),
          ...notice,
        ]),
        cache,
      );
      const bounded = truncateToolResultMessage(
        replaceToolResultContent(msg, retainedContent),
        Math.max(0, maxChars - reservedChars),
        { minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE },
      );
      return replaceToolResultContent(msg, [
        // SAFETY: Array input is preserved or mapped to another array by truncateToolResultMessage.
        ...(bounded as { content: unknown[] }).content,
        ...notice,
      ]);
    };

    // Image cost alone rules out larger prefixes. The allocator still reserves
    // other non-text content and preserves diagnostic tails and short text blocks.
    const maxRetainedImages = Math.min(imageCount, Math.floor(maxChars / TOOL_IMAGE_CHARS));
    for (let retainedImages = maxRetainedImages; retainedImages >= 0; retainedImages -= 1) {
      let seenImages = 0;
      const retainedContent = content.filter(
        (block) => !isImage(block) || ++seenImages <= retainedImages,
      );
      const projected = projectContent(
        retainedContent,
        retainedImages < imageCount ? omissionNotice(retainedImages) : undefined,
      );
      const projectedContent = (projected as { content: unknown[] }).content;
      if (
        retainedContent.some((block, index) => {
          const projectedBlock = projectedContent[index];
          return isText(block) && block.text && (!isText(projectedBlock) || !projectedBlock.text);
        })
      ) {
        continue;
      }
      if (estimateMessageCharsCached(projected, cache) <= maxChars) {
        return projected;
      }
    }
    // Dropping unfit non-text content must not flatten away surviving semantic
    // blocks. Reserve a visible notice even when only omission markers can fit.
    const omittedChars = estimateMessageCharsCached(
      replaceToolResultContent(
        msg,
        content.filter((block) => !isText(block)),
      ),
      cache,
    );
    return projectContent(
      content.filter(isText),
      imageCount > 0
        ? omissionNotice(0)
        : formatContextLimitTruncationNotice(Math.max(1, estimateBudgetToRawChars(omittedChars))),
    );
  }

  const truncatedText = truncateToolResultText(getToolResultText(msg), maxChars, {
    minKeepChars: 0,
    minimumRawWeight: TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  });
  return replaceToolResultContent(msg, truncatedText);
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
 * Reassemble each tool-loop iteration for engines that own compaction.
 * Admitted turns advance through their accepted-turn owner; standalone
 * attempts retain their eager lifecycle and finalization checkpoint.
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
  deferredTurn?: { prompt: string; readonly availableTools: Set<string> };
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
    signal?.throwIfAborted();
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    signal?.throwIfAborted();
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const transcriptMessages = params.deferredTurn
      ? sourceMessages
      : projectTranscriptPromptMessages(sourceMessages, transcriptProjectionCache);
    const providerMessages = stripTranscriptPromptMarkers(sourceMessages);
    const sourceHistoryChanged =
      lastSeenLength != null &&
      lastSourceMessages != null &&
      (transcriptMessages.length < lastSeenLength ||
        (transcriptMessages.length === lastSeenLength &&
          transcriptMessages.some((message, index) => message !== lastSourceMessages?.[index])));
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

    if (transcriptMessages.length <= prePromptMessageCount) {
      lastSeenLength = prePromptMessageCount;
      lastSourceMessages = transcriptMessages;
      return lastAssembledView ?? providerMessages;
    }
    try {
      if (!params.deferredTurn) {
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
              signal?.throwIfAborted();
            }
          }
        }
        signal?.throwIfAborted();
        params.onAfterTurnCheckpoint?.(transcriptMessages.length);
      }
      lastSeenLength = transcriptMessages.length;
      lastSourceMessages = transcriptMessages;
      // An admitted turn is not in the engine's store yet. Assemble accepted
      // history separately, then retain the host-owned user/tool exchange.
      const historyLength = params.deferredTurn
        ? (params.getPrePromptMessageCount?.() ?? 0)
        : providerMessages.length;
      const pendingMessages = providerMessages.slice(historyLength);
      const pendingTokens = pendingMessages.reduce(
        (sum, message) => sum + estimateTokens(message),
        0,
      );
      const assembled = await contextEngine.assemble({
        sessionId,
        sessionKey,
        messages: providerMessages.slice(0, historyLength),
        ...params.deferredTurn,
        tokenBudget:
          tokenBudget === undefined ? undefined : Math.max(1, tokenBudget - pendingTokens),
        model: modelId,
        runtimeSettings: params.runtimeSettings,
      });
      signal?.throwIfAborted();
      if (assembled && Array.isArray(assembled.messages)) {
        const modelMessages = pendingMessages.length
          ? [...assembled.messages, ...pendingMessages]
          : assembled.messages;
        lastAssembledView = params.repairAssembledMessages?.(modelMessages) ?? modelMessages;
        return lastAssembledView;
      }
      lastAssembledView = null;
    } catch {
      signal?.throwIfAborted();
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
  const maxSingleToolResultChars = resolveToolResultContextMaxChars(params.contextWindowTokens);

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
        // Use the same post-truncation view the runtime will send to the next model call.
        // Recovery re-applies truncation to the persisted session manager, so
        // this precheck is only a routing signal, not the source of truth.
        const precheck = shouldPreemptivelyCompactBeforePrompt({
          replay: params.midTurnPrecheck.getReplay?.(),
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
    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
