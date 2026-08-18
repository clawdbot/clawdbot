import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { createEmbeddedRunReplayState } from "./embedded-agent-runner/replay-state.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { createThinkingTagStreamState } from "./embedded-agent-utils.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import { hasGeneratedMediaCompletionEvent } from "./internal-event-contract.js";
import type { AgentInternalEvent } from "./internal-events.js";

function collectPendingMediaFromInternalEvents(
  events: SubscribeEmbeddedAgentSessionParams["internalEvents"],
): {
  mediaUrls: string[];
  attachments: NonNullable<AgentInternalEvent["attachments"]>;
  trustByUrl: Map<string, boolean>;
} {
  if (!events?.length) {
    return { mediaUrls: [], attachments: [], trustByUrl: new Map() };
  }
  const pending: string[] = [];
  const attachments: NonNullable<AgentInternalEvent["attachments"]> = [];
  const indexByUrl = new Map<string, number>();
  const trustedByUrl = new Map<string, boolean>();
  for (const event of events) {
    const generatedMediaEvent = hasGeneratedMediaCompletionEvent([event]);
    const attachmentByUrl = new Map(
      (event.attachments ?? []).flatMap((attachment) => {
        const reference = normalizeOptionalString(
          attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath,
        );
        return reference ? [[reference, attachment] as const] : [];
      }),
    );
    const mediaUrls = [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ];
    for (const mediaUrl of mediaUrls) {
      const normalized = normalizeOptionalString(mediaUrl) ?? "";
      if (!normalized) {
        continue;
      }
      const metadata = attachmentByUrl.get(normalized);
      const existingIndex = indexByUrl.get(normalized);
      if (existingIndex !== undefined) {
        trustedByUrl.set(normalized, trustedByUrl.get(normalized) === true || generatedMediaEvent);
        if (metadata && Object.keys(attachments[existingIndex] ?? {}).length === 0) {
          attachments[existingIndex] = metadata;
        }
        continue;
      }
      indexByUrl.set(normalized, pending.length);
      trustedByUrl.set(normalized, generatedMediaEvent);
      pending.push(normalized);
      attachments.push(metadata ?? {});
    }
  }
  return { mediaUrls: pending, attachments, trustByUrl: trustedByUrl };
}

export function createEmbeddedAgentSubscribeState(
  params: SubscribeEmbeddedAgentSessionParams,
): EmbeddedAgentSubscribeState {
  const reasoningMode = params.reasoningMode ?? "off";
  const canShowReasoning = params.thinkingLevel !== "off";
  const initialPendingToolMedia = collectPendingMediaFromInternalEvents(params.internalEvents);
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
    lastToolRecovery: undefined,
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
    blockBuffer: "",
    // Track if a streamed chunk opened a <think> block (stateful across chunks).
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    lastStreamedAssistant: undefined,
    lastStreamedAssistantCleaned: undefined,
    lastStreamedCommentary: undefined,
    commentaryStreamedWithDelta: false,
    assistantDisplayPhasePending: false,
    emittedAssistantUpdate: false,
    lastStreamedReasoning: undefined,
    lastBlockReplyText: undefined,
    lastDeliveredBlockReplyText: undefined,
    deliveredBlockReplyTexts: [],
    attemptedBlockReplyTexts: [],
    deferredBlockReplyTexts: [],
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
    deferredAssistantReplyDirectives: undefined,
    lastDeliveredAssistantReplyDirectives: undefined,
    deterministicApprovalPromptPending: false,
    deterministicApprovalPromptSent: false,
  };
}
