import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { createEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { createThinkingTagStreamState } from "./embedded-agent-utils.js";
import { collectAgentInternalEventMedia } from "./internal-events.js";

export function createEmbeddedAgentSubscribeState(
  params: SubscribeEmbeddedAgentSessionParams,
): EmbeddedAgentSubscribeState {
  const reasoningMode = params.reasoningMode ?? "off";
  const canShowReasoning = params.thinkingLevel !== "off";
  const initialPendingToolMedia = collectAgentInternalEventMedia(params.internalEvents);
  return {
    assistantTexts: [],
    toolMetas: [],
    acceptedSessionSpawns: [],
    toolMetaById: new Map(),
    toolSummaryById: new Set(),
    liveEditDiffStateById: new Map(),
    itemActiveIds: new Set(),
    itemStartedCount: 0,
    itemCompletedCount: 0,
    assistantTurnCount: 0,
    lastToolError: undefined,
    blockReplyBreak: params.blockReplyBreak ?? "text_end",
    reasoningMode,
    includeReasoning: reasoningMode === "on" && canShowReasoning,
    shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
    streamReasoning:
      (params.streamReasoningInNonStreamModes === true
        ? reasoningMode !== "on"
        : reasoningMode === "stream") &&
      canShowReasoning &&
      typeof params.onReasoningStream === "function",
    deltaBuffer: "",
    thinkingTagStream: createThinkingTagStreamState(),
    deltaBufferIsCommentary: false,
    hasFlushedPartialText: false,
    blockBuffer: "",
    // Track if a streamed chunk opened a <think> block (stateful across chunks).
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    lastStreamedAssistant: undefined,
    lastStreamedAssistantCleaned: undefined,
    emittedAssistantUpdate: false,
    lastStreamedReasoning: undefined,
    lastBlockReplyText: undefined,
    lastDeliveredBlockReplyText: undefined,
    deferBlockReplyDelivery: typeof params.onBeforeTerminalDelivery === "function",
    deferredBlockReplies: [],
    deferredAssistantEvents: [],
    toolExecutionSinceLastBlockReply: false,
    reasoningStreamOpen: false,
    assistantMessageIndex: 0,
    lastAssistantStreamContentIndex: undefined,
    lastAssistantStreamItemId: undefined,
    lastAssistantTextMessageIndex: -1,
    lastAssistantTextNormalized: undefined,
    lastAssistantTextTrimmed: undefined,
    assistantTextBaseline: 0,
    suppressBlockChunks: false, // Avoid late chunk inserts after final text merge.
    lastReasoningSent: undefined,
    pendingAssistantUsage: undefined,
    assistantUsageCommitted: false,
    compactionInFlight: false,
    lastCompactionTokensAfter: undefined,
    pendingCompactionRetry: 0,
    compactionRetryResolve: undefined,
    compactionRetryReject: undefined,
    compactionRetryPromise: null,
    unsubscribed: false,
    replayState: createEmbeddedRunReplayState(params.initialReplayState),
    livenessState: "working",
    hadDeterministicSideEffect: false,
    pendingEventChain: null,
    messagingToolSentTexts: [],
    messagingToolSentTextsNormalized: [],
    currentSourceMessagingToolSentTextsNormalized: [],
    currentSourceMessagingToolHeldPartial: undefined,
    messagingToolSentTargets: [],
    heartbeatToolResponse: undefined,
    messagingToolSentMediaUrls: [],
    messagingToolSourceReplyPayloads: [],
    messageToolOnlySourceReplyDelivered: false,
    pendingMessagingTexts: new Map(),
    pendingMessagingTargets: new Map(),
    successfulCronAdds: 0,
    pendingMessagingMediaUrls: new Map(),
    pendingToolMediaUrls: initialPendingToolMedia.mediaUrls,
    pendingToolMediaAttachments: initialPendingToolMedia.attachments,
    pendingToolMediaTrustByUrl: initialPendingToolMedia.trustByUrl,
    pendingToolAudioAsVoice: false,
    hasToolMediaBlockReply: false,
    visibleBlockReplyCount: 0,
    pendingAssistantReplyDirectives: undefined,
    deterministicApprovalPromptPending: false,
    deterministicApprovalPromptSent: false,
  };
}
