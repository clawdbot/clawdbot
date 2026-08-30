import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { InlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import {
  buildCodeSpanIndex,
  createInlineCodeState,
} from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { findFinalTagMatches } from "../shared/text/final-tags.js";
import { hasOrphanReasoningCloseBoundary } from "../shared/text/reasoning-tags.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-agent-helpers.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import {
  createThinkingTagStreamState,
  stripDowngradedToolCallText,
  THINKING_TAG_SCAN_RE,
} from "./embedded-agent-utils.js";

const STREAM_STRIPPED_BLOCK_TAG_NAMES = [
  "final",
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;

function isPotentialTrailingBlockTagFragment(fragment: string): boolean {
  if (!fragment.startsWith("<") || fragment.includes(">")) {
    return false;
  }
  const body = fragment.toLowerCase().slice(1).trimStart().replace(/^\//, "").trimStart();
  if (!body) {
    return true;
  }
  const namePart = body.split(/[\s/>]/, 1)[0] ?? "";
  if (!namePart) {
    return true;
  }
  return STREAM_STRIPPED_BLOCK_TAG_NAMES.some((name) => {
    return name.startsWith(namePart) || namePart === name;
  });
}

function splitTrailingBlockTagFragment(
  text: string,
  isInsideCodeSpan: (index: number) => boolean,
): { text: string; pendingTagFragment?: string } {
  const fragmentStart = text.lastIndexOf("<");
  if (fragmentStart === -1 || isInsideCodeSpan(fragmentStart)) {
    return { text };
  }
  const fragment = text.slice(fragmentStart);
  if (!isPotentialTrailingBlockTagFragment(fragment)) {
    return { text };
  }
  return {
    text: text.slice(0, fragmentStart),
    pendingTagFragment: fragment,
  };
}

function splitTrailingFenceFragment(
  text: string,
  startsAtLineStart: boolean,
): { text: string; pendingFenceFragment?: string } {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);
  if ((!startsAtLineStart && lineStart === 0) || !/^(?: {0,3})(?:`+|~+)$/.test(line)) {
    return { text };
  }
  return {
    text: text.slice(0, lineStart),
    pendingFenceFragment: line,
  };
}

type StreamRenderingParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
  blockChunker: EmbeddedAgentSubscribeContext["blockChunker"];
  emitBlockReply: EmbeddedAgentSubscribeContext["emitBlockReply"];
  pendingBlockReplyTasks: Set<Promise<void>>;
  pushAssistantText: (text: string) => void;
  shouldSkipAssistantText: (text: string) => boolean;
};

export function createStreamRendering({
  params,
  state,
  log,
  blockChunker,
  emitBlockReply,
  pendingBlockReplyTasks,
  pushAssistantText,
  shouldSkipAssistantText,
}: StreamRenderingParams) {
  const messagingToolSentTextsNormalized = state.messagingToolSentTextsNormalized;
  const messagingToolSourceReplyPayloads = state.messagingToolSourceReplyPayloads;
  const replyDirectiveAccumulator = createStreamingDirectiveAccumulator();
  const partialReplyDirectiveAccumulator = createStreamingDirectiveAccumulator();

  const stripBlockTags = (
    text: string,
    stateLocal: {
      thinking: boolean;
      final: boolean;
      inlineCode?: InlineCodeState;
      fence?: FenceScanState;
      reasoningInlineCode?: InlineCodeState;
      reasoningFence?: FenceScanState;
      reasoningPendingFenceFragment?: string;
      finalInlineCode?: InlineCodeState;
      finalFence?: FenceScanState;
      pendingFenceFragment?: string;
      pendingTagFragment?: string;
    },
    options?: { final?: boolean; completeMarkdownChunk?: boolean },
  ): string => {
    const input = `${stateLocal.pendingFenceFragment ?? ""}${stateLocal.pendingTagFragment ?? ""}${text}`;
    stateLocal.pendingFenceFragment = undefined;
    stateLocal.pendingTagFragment = undefined;
    if (!input) {
      return text;
    }

    const { text: fenceInput, pendingFenceFragment } = options?.final
      ? { text: input, pendingFenceFragment: undefined }
      : options?.completeMarkdownChunk
        ? { text: input, pendingFenceFragment: undefined }
        : splitTrailingFenceFragment(input, stateLocal.fence?.atLineStart ?? true);
    stateLocal.pendingFenceFragment = pendingFenceFragment;
    if (!fenceInput) {
      return "";
    }

    const inlineStateStart = stateLocal.inlineCode ?? createInlineCodeState();
    const fenceStateStart = stateLocal.fence;
    const initialCodeSpans = buildCodeSpanIndex(fenceInput, inlineStateStart, fenceStateStart);
    const { text: scanText, pendingTagFragment } = options?.final
      ? { text: fenceInput, pendingTagFragment: undefined }
      : splitTrailingBlockTagFragment(fenceInput, initialCodeSpans.isInside);
    stateLocal.pendingTagFragment = pendingTagFragment;
    if (!scanText) {
      return "";
    }
    const codeSpans =
      scanText === fenceInput
        ? initialCodeSpans
        : buildCodeSpanIndex(scanText, inlineStateStart, fenceStateStart);

    let processed = "";
    THINKING_TAG_SCAN_RE.lastIndex = 0;
    let lastIndex = 0;
    let lastCodeIndex = 0;
    let inThinking = stateLocal.thinking;
    // Hidden reasoning has its own code state: malformed hidden fences must not
    // mark later visible text as code, but literal close tags there stay hidden.
    let hiddenInlineState: InlineCodeState = stateLocal.reasoningInlineCode
      ? { ...stateLocal.reasoningInlineCode }
      : createInlineCodeState();
    let hiddenFenceState: FenceScanState | undefined = stateLocal.reasoningFence?.open
      ? {
          atLineStart: stateLocal.reasoningFence.atLineStart,
          open: { ...stateLocal.reasoningFence.open },
        }
      : stateLocal.reasoningFence
        ? { atLineStart: stateLocal.reasoningFence.atLineStart }
        : undefined;
    let hiddenPendingFenceFragment = stateLocal.reasoningPendingFenceFragment;
    stateLocal.reasoningPendingFenceFragment = undefined;
    const advanceHiddenCodeState = (segment: string) => {
      const hiddenInput = `${hiddenPendingFenceFragment ?? ""}${segment}`;
      hiddenPendingFenceFragment = undefined;
      if (!hiddenInput) {
        return;
      }
      const { text: hiddenFenceInput, pendingFenceFragment: pendingFenceFragmentLocal } =
        options?.final
          ? { text: hiddenInput, pendingFenceFragment: undefined }
          : options?.completeMarkdownChunk
            ? { text: hiddenInput, pendingFenceFragment: undefined }
            : splitTrailingFenceFragment(hiddenInput, hiddenFenceState?.atLineStart ?? true);
      hiddenPendingFenceFragment = pendingFenceFragmentLocal;
      if (!hiddenFenceInput) {
        return;
      }
      const next = buildCodeSpanIndex(hiddenFenceInput, hiddenInlineState, hiddenFenceState);
      hiddenInlineState = next.inlineState;
      hiddenFenceState = next.fenceState;
    };
    for (const match of scanText.matchAll(THINKING_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      const isClose = match[1] === "/";
      if (inThinking) {
        advanceHiddenCodeState(scanText.slice(lastCodeIndex, idx));
      }
      const isInsideHiddenCode =
        inThinking && (hiddenInlineState.open || Boolean(hiddenFenceState?.open));
      lastCodeIndex = idx + match[0].length;
      if ((!inThinking && codeSpans.isInside(idx)) || isInsideHiddenCode) {
        if (inThinking) {
          advanceHiddenCodeState(match[0]);
        }
        continue;
      }
      if (!inThinking) {
        if (isClose) {
          const afterIndex = idx + match[0].length;
          const before = scanText.slice(lastIndex, idx);
          const after = scanText.slice(afterIndex);
          if (hasOrphanReasoningCloseBoundary({ before, after })) {
            processed = "";
          } else {
            processed += before;
          }
          lastIndex = afterIndex;
          continue;
        }
        processed += scanText.slice(lastIndex, idx);
        hiddenInlineState = createInlineCodeState();
        hiddenFenceState = undefined;
        hiddenPendingFenceFragment = undefined;
      }
      inThinking = !isClose;
      if (!inThinking) {
        hiddenInlineState = createInlineCodeState();
        hiddenFenceState = undefined;
        hiddenPendingFenceFragment = undefined;
      }
      lastIndex = idx + match[0].length;
    }
    if (inThinking) {
      advanceHiddenCodeState(scanText.slice(lastCodeIndex));
    }
    if (!inThinking) {
      processed += scanText.slice(lastIndex);
    }
    stateLocal.thinking = inThinking;
    stateLocal.reasoningInlineCode = inThinking ? hiddenInlineState : undefined;
    stateLocal.reasoningFence = inThinking ? hiddenFenceState : undefined;
    stateLocal.reasoningPendingFenceFragment = inThinking ? hiddenPendingFenceFragment : undefined;

    // If enforcement is disabled, we still strip the tags themselves to prevent
    // hallucinations (e.g. Minimax copying the style) from leaking, but we
    // do not enforce buffering/extraction logic.
    const finalCodeSpans =
      processed === scanText
        ? codeSpans
        : buildCodeSpanIndex(processed, inlineStateStart, fenceStateStart);
    if (!params.enforceFinalTag) {
      stateLocal.inlineCode = finalCodeSpans.inlineState;
      stateLocal.fence = finalCodeSpans.fenceState;
      return stripFinalTagsOutsideCodeSpans(processed, finalCodeSpans.isInside);
    }

    // If enforcement is enabled, only return text that appeared inside a <final> block.
    let result = "";
    let lastFinalIndex = 0;
    let inFinal = stateLocal.final;
    let everInFinal = stateLocal.final;

    for (const match of findFinalTagMatches(processed)) {
      const idx = match.index;
      if (finalCodeSpans.isInside(idx)) {
        continue;
      }
      const isClose = match.isClose;
      const isSelfClosing = match.isSelfClosing;

      if (isSelfClosing) {
        if (inFinal) {
          result += processed.slice(lastFinalIndex, idx);
          inFinal = false;
        } else {
          inFinal = true;
          everInFinal = true;
        }
        lastFinalIndex = idx + match.text.length;
      } else if (!inFinal && !isClose) {
        // Found <final> start tag.
        inFinal = true;
        everInFinal = true;
        lastFinalIndex = idx + match.text.length;
      } else if (inFinal && isClose) {
        // Found </final> end tag.
        result += processed.slice(lastFinalIndex, idx);
        inFinal = false;
        lastFinalIndex = idx + match.text.length;
      }
    }

    if (inFinal) {
      result += processed.slice(lastFinalIndex);
    }
    stateLocal.final = inFinal;

    // Strict Mode: If enforcing final tags, we MUST NOT return content unless
    // we have seen a <final> tag. Otherwise, we leak "thinking out loud" text
    // (e.g. "**Locating Manulife**...") that the model emitted without <think> tags.
    if (!everInFinal) {
      stateLocal.inlineCode = createInlineCodeState();
      stateLocal.fence = finalCodeSpans.fenceState;
      stateLocal.finalInlineCode = undefined;
      stateLocal.finalFence = undefined;
      return "";
    }

    // Hardened Cleanup: Remove any remaining <final> tags that might have been
    // missed (e.g. nested tags or hallucinations) to prevent leakage.
    const finalResultInlineStateStart = stateLocal.finalInlineCode ?? createInlineCodeState();
    const finalResultFenceStateStart = stateLocal.finalFence;
    const resultCodeSpans = buildCodeSpanIndex(
      result,
      finalResultInlineStateStart,
      finalResultFenceStateStart,
    );
    stateLocal.inlineCode = finalCodeSpans.inlineState;
    stateLocal.fence = finalCodeSpans.fenceState;
    stateLocal.finalInlineCode = inFinal ? resultCodeSpans.inlineState : undefined;
    stateLocal.finalFence = inFinal ? resultCodeSpans.fenceState : undefined;
    return stripFinalTagsOutsideCodeSpans(result, resultCodeSpans.isInside);
  };

  const stripFinalTagsOutsideCodeSpans = (text: string, isInside: (index: number) => boolean) => {
    let output = "";
    let lastIndex = 0;
    for (const match of findFinalTagMatches(text)) {
      const idx = match.index;
      if (isInside(idx)) {
        continue;
      }
      output += text.slice(lastIndex, idx);
      lastIndex = idx + match.text.length;
    }
    output += text.slice(lastIndex);
    return output;
  };
  const hasMessageToolOnlySourceDelivery = () =>
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    (state.messageToolOnlySourceReplyDelivered ||
      params.hasDeliveredMessageToolOnlySourceReply?.() === true ||
      messagingToolSourceReplyPayloads.length > 0);

  const emitBlockChunk = (
    text: string,
    options?: { assistantMessageIndex?: number; final?: boolean; completeMarkdownChunk?: boolean },
  ) => {
    if (state.suppressBlockChunks || params.silentExpected) {
      return;
    }
    // Strip <think> and <final> blocks across chunk boundaries to avoid leaking reasoning.
    // Also strip downgraded tool call text ([Tool Call: ...], [Historical context: ...], etc.).
    const blockReplyText = stripDowngradedToolCallText(
      stripBlockTags(text, state.blockState, {
        final: options?.final === true,
        completeMarkdownChunk: options?.completeMarkdownChunk === true,
      }),
    ).trimEnd();
    if (!blockReplyText) {
      return;
    }
    if (blockReplyText === state.lastBlockReplyText) {
      return;
    }
    const markBlockReplyTextHandled = () => {
      state.lastBlockReplyText = blockReplyText;
      state.lastDeliveredBlockReplyText = blockReplyText;
      state.toolExecutionSinceLastBlockReply = false;
    };
    if (hasMessageToolOnlySourceDelivery()) {
      markBlockReplyTextHandled();
      return;
    }
    let chunk = blockReplyText;
    let slicedPrefixReplay = false;
    const lastDeliveredBlockReplyText = state.lastDeliveredBlockReplyText;
    const blockReplySuffix = lastDeliveredBlockReplyText
      ? blockReplyText.slice(lastDeliveredBlockReplyText.length)
      : "";
    const prefixReplayCandidate = Boolean(
      state.blockReplyBreak === "text_end" &&
      state.toolExecutionSinceLastBlockReply &&
      lastDeliveredBlockReplyText &&
      lastDeliveredBlockReplyText.trimEnd().endsWith(":") &&
      blockReplyText.length > lastDeliveredBlockReplyText.length &&
      blockReplyText.startsWith(lastDeliveredBlockReplyText),
    );
    if (prefixReplayCandidate && !/^\s/.test(blockReplySuffix)) {
      chunk = blockReplySuffix;
      slicedPrefixReplay = true;
    }
    if (!chunk) {
      return;
    }

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    const normalizedReplaySuffix = prefixReplayCandidate
      ? normalizeTextForComparison(blockReplySuffix.trimStart())
      : "";
    const isMessagingDuplicate =
      isMessagingToolDuplicateNormalized(normalizedChunk, messagingToolSentTextsNormalized) ||
      (prefixReplayCandidate &&
        isMessagingToolDuplicateNormalized(
          normalizedReplaySuffix,
          messagingToolSentTextsNormalized,
        ));
    if (isMessagingDuplicate) {
      log.debug(
        `Skipping block reply - already sent via messaging tool: ${truncateUtf16Safe(chunk, 50)}...`,
      );
      if (prefixReplayCandidate) {
        markBlockReplyTextHandled();
      }
      return;
    }

    if (shouldSkipAssistantText(chunk)) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }

    if (!params.onBlockReply) {
      pushAssistantText(chunk);
      markBlockReplyTextHandled();
      return;
    }
    const splitResult = replyDirectiveAccumulator.consume(chunk);
    if (!splitResult) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      if (slicedPrefixReplay) {
        markBlockReplyTextHandled();
      }
      return;
    }
    pushAssistantText(chunk);
    emitBlockReply(
      {
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      },
      {
        assistantMessageIndex: options?.assistantMessageIndex ?? state.assistantMessageIndex,
        consumePendingToolMedia:
          options?.final === true || Boolean(mediaUrls?.length || audioAsVoice),
      },
    );
    markBlockReplyTextHandled();
  };

  const consumeReplyDirectives = (text: string, options?: { final?: boolean }) =>
    replyDirectiveAccumulator.consume(text, options);
  const consumePartialReplyDirectives = (text: string, options?: { final?: boolean }) =>
    partialReplyDirectiveAccumulator.consume(text, options);

  const flushBlockReplyBuffer = (options?: {
    assistantMessageIndex?: number;
    final?: boolean;
  }): void | Promise<void> => {
    if (!params.onBlockReply) {
      return;
    }
    if (blockChunker?.hasBuffered()) {
      if (options?.final) {
        let pendingChunk: string | undefined;
        blockChunker.drain({
          force: true,
          emit: (text) => {
            if (pendingChunk !== undefined) {
              emitBlockChunk(pendingChunk, {
                assistantMessageIndex: options.assistantMessageIndex,
                completeMarkdownChunk: true,
              });
            }
            pendingChunk = text;
          },
        });
        if (pendingChunk !== undefined) {
          emitBlockChunk(pendingChunk, {
            assistantMessageIndex: options.assistantMessageIndex,
            completeMarkdownChunk: true,
            final: true,
          });
        }
      } else {
        blockChunker.drain({ force: true, emit: (text) => emitBlockChunk(text, options) });
      }
      blockChunker.reset();
    } else if (state.blockBuffer.length > 0) {
      emitBlockChunk(state.blockBuffer, options);
      state.blockBuffer = "";
    }
    if (options?.final) {
      emitBlockChunk("", options);
    }
    if (pendingBlockReplyTasks.size === 0) {
      return;
    }
    return (async () => {
      while (pendingBlockReplyTasks.size > 0) {
        await Promise.allSettled(pendingBlockReplyTasks);
      }
    })();
  };

  const emitReasoningStream = (text: string) => {
    if (params.silentExpected) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === state.lastStreamedReasoning) {
      return;
    }
    // Compute delta: new text since the last emitted reasoning.
    // Guard against non-prefix changes (e.g. trim altering earlier content).
    const prior = state.lastStreamedReasoning ?? "";
    const delta = trimmed.startsWith(prior) ? trimmed.slice(prior.length) : trimmed;
    state.lastStreamedReasoning = trimmed;

    // Emit-always: the thinking stream always reaches the bus and session
    // archive. /reasoning (streamReasoning) gates only the rendering hook
    // below; display surfaces (TUI showThinking, webchat isReasoning drops)
    // gate presentation on their side.
    emitAgentEvent({
      runId: params.runId,
      stream: "thinking",
      data: {
        text: trimmed,
        delta,
      },
    });

    // Message-tool-only delivery makes later reasoning private: once the
    // user-facing reply has gone out via the message tool, the channel shows
    // only what was explicitly sent, so trailing reasoning must stay out of the
    // render hook — uniformly, whether the thinking block rode in on a tool call
    // or arrived on its own. It still reaches the bus/archive above.
    if (state.streamReasoning && !hasMessageToolOnlySourceDelivery() && params.onReasoningStream) {
      runBestEffortCallback({
        label: "reasoning stream",
        log,
        callback: () =>
          params.onReasoningStream?.({
            text: trimmed,
            ...(state.reasoningMode === "stream" ? {} : { requiresReasoningProgressOptIn: true }),
          }),
      });
    }
  };

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    state.deltaBuffer = "";
    state.thinkingTagStream = createThinkingTagStreamState();
    state.deltaBufferIsCommentary = false;
    state.hasFlushedPartialText = false;
    state.blockBuffer = "";
    blockChunker?.reset();
    replyDirectiveAccumulator.reset();
    partialReplyDirectiveAccumulator.reset();
    state.blockState.thinking = false;
    state.blockState.final = false;
    state.blockState.inlineCode = createInlineCodeState();
    state.blockState.fence = undefined;
    state.blockState.reasoningInlineCode = undefined;
    state.blockState.reasoningFence = undefined;
    state.blockState.reasoningPendingFenceFragment = undefined;
    state.blockState.finalInlineCode = undefined;
    state.blockState.finalFence = undefined;
    state.blockState.pendingFenceFragment = undefined;
    state.blockState.pendingTagFragment = undefined;
    state.partialBlockState.thinking = false;
    state.partialBlockState.final = false;
    state.partialBlockState.inlineCode = createInlineCodeState();
    state.partialBlockState.fence = undefined;
    state.partialBlockState.reasoningInlineCode = undefined;
    state.partialBlockState.reasoningFence = undefined;
    state.partialBlockState.reasoningPendingFenceFragment = undefined;
    state.partialBlockState.finalInlineCode = undefined;
    state.partialBlockState.finalFence = undefined;
    state.partialBlockState.pendingFenceFragment = undefined;
    state.partialBlockState.pendingTagFragment = undefined;
    state.lastStreamedAssistant = undefined;
    state.lastStreamedAssistantCleaned = undefined;
    state.currentSourceMessagingToolHeldPartial = undefined;
    state.emittedAssistantUpdate = false;
    state.lastBlockReplyText = undefined;
    state.lastStreamedReasoning = undefined;
    state.lastReasoningSent = undefined;
    state.reasoningStreamOpen = false;
    state.suppressBlockChunks = false;
    state.pendingAssistantUsage = undefined;
    state.assistantUsageCommitted = false;
    state.assistantMessageIndex += 1;
    state.lastAssistantStreamContentIndex = undefined;
    state.lastAssistantStreamItemId = undefined;
    state.lastAssistantTextMessageIndex = -1;
    state.lastAssistantTextNormalized = undefined;
    state.lastAssistantTextTrimmed = undefined;
    state.assistantTextBaseline = nextAssistantTextBaseline;
    state.pendingAssistantReplyDirectives = undefined;
  };

  return {
    consumePartialReplyDirectives,
    consumeReplyDirectives,
    emitBlockChunk,
    emitReasoningStream,
    flushBlockReplyBuffer,
    resetAssistantMessageState,
    stripBlockTags,
  };
}
