/** Builds final reply payloads after sanitization, media normalization, and dedupe. */
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { stripLegacyBracketToolCallBlocks } from "../../shared/text/assistant-visible-text.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  appendReplyMediaFailureWarning,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyContentKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import {
  applyReplyThreading,
  isRenderablePayload,
  resolveReplyThreadingPayloads,
} from "./reply-payloads-base.js";
import { createReplyDeliveryContext } from "./reply-threading.js";

const replyPayloadsDedupeRuntimeLoader = createLazyImportLoader(
  () => import("./reply-payloads-dedupe.runtime.js"),
);

function loadReplyPayloadsDedupeRuntime() {
  return replyPayloadsDedupeRuntimeLoader.load();
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  suppressMediaFailureWarning?: boolean;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) {
    return params.payload;
  }

  try {
    const normalized = await params.normalizeMediaPaths(params.payload);
    return copyReplyPayloadMetadata(params.payload, normalized);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    // Preserve the text reply and drop unusable media so channels can still send the answer.
    return copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      text: params.suppressMediaFailureWarning
        ? params.payload.text
        : appendReplyMediaFailureWarning(params.payload.text),
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
  }
}

async function normalizeSentMediaUrlsForDedupe(params: {
  sentMediaUrls: readonly string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  if (params.sentMediaUrls.length === 0 || !params.normalizeMediaPaths) {
    return [...params.sentMediaUrls];
  }

  const normalizedUrls: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalizedUrls.push(trimmed);
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalized).mediaUrls;
      for (const mediaUrl of normalizedMediaUrls) {
        const candidate = mediaUrl.trim();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        normalizedUrls.push(candidate);
      }
    } catch (err) {
      logVerbose(`messaging tool sent-media normalization failed: ${String(err)}`);
    }
  }

  return normalizedUrls;
}

function shouldKeepPayloadDuringSilentTurn(payload: ReplyPayload): boolean {
  if (payload.isError) {
    return true;
  }
  return payload.audioAsVoice === true && resolveSendableOutboundReplyParts(payload).hasMedia;
}

function sanitizeFinalReplyText(
  payload: ReplyPayload,
  text: string | undefined,
): string | undefined {
  if (!text) {
    return text;
  }
  return sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
}

function sanitizeHeartbeatPayload(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text) {
    return payload;
  }
  const withoutLegacyBlocks = stripLegacyBracketToolCallBlocks(text);
  const cleaned = sanitizeFinalReplyText(payload, withoutLegacyBlocks);
  if (cleaned === text) {
    return payload;
  }
  if (withoutLegacyBlocks !== text) {
    logVerbose("Stripped legacy tool-call block from heartbeat reply");
  }
  return copyPayloadWithSanitizedText(payload, cleaned);
}

function copyPayloadWithSanitizedText(
  payload: ReplyPayload,
  text: string | undefined,
): ReplyPayload {
  const sanitizedText = sanitizeFinalReplyText(payload, text);
  const next = copyReplyPayloadMetadata(payload, {
    ...payload,
    text: sanitizedText,
  });
  const mirror = getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror;
  if (!mirror?.text) {
    return next;
  }
  setReplyPayloadMetadata(next, {
    sourceReplyTranscriptMirror: {
      ...mirror,
      text: sanitizeFinalReplyText(payload, mirror.text) || undefined,
    },
  });
  return next;
}

/** Builds final outbound payloads from agent output and message-tool delivery evidence. */
export async function buildReplyPayloads(params: {
  config?: OpenClawConfig;
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  silentExpected?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  /** Payloads successfully sent directly during tool flush. */
  directlySentBlockPayloads?: ReplyPayload[];
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  originatingChannel?: OriginatingChannelType;
  originatingChatType?: string | null;
  originatingTo?: string;
  originatingThreadId?: string | number;
  accountId?: string;
  extractMarkdownImages?: boolean;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<{ replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean }> {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  const sanitizedPayloads: ReplyPayload[] = [];
  if (params.isHeartbeat) {
    for (const payload of params.payloads) {
      sanitizedPayloads.push(sanitizeHeartbeatPayload(payload));
    }
  } else {
    for (const payload of params.payloads) {
      let text = payload.text;

      if (payload.isError && text && isBunFetchSocketError(text)) {
        text = formatBunFetchSocketError(text);
      }

      if (!text || !text.includes("HEARTBEAT_OK")) {
        sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, text));
        continue;
      }
      const stripped = stripHeartbeatToken(text, { mode: "message" });
      if (stripped.didStrip && !didLogHeartbeatStrip) {
        didLogHeartbeatStrip = true;
        logVerbose("Stripped stray HEARTBEAT_OK token from reply");
      }
      const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
      if (stripped.shouldSkip && !hasMedia) {
        continue;
      }
      sanitizedPayloads.push(copyPayloadWithSanitizedText(payload, stripped.text));
    }
  }

  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: params.originatingChannel,
    provider: params.messageProvider,
  });
  const accountId = resolveOriginAccountId({
    originatingAccountId: params.accountId,
  });
  const replyDelivery = createReplyDeliveryContext(params.replyToMode, params.originatingChatType);
  const replyDeliverySource = messageProvider
    ? {
        channel: messageProvider,
        ...(accountId ? { accountId } : {}),
      }
    : undefined;
  const resolveThreading = params.applyReplyToMode
    ? resolveReplyThreadingPayloads
    : applyReplyThreading;
  const replyTaggedPayloadCandidates = await Promise.all(
    resolveThreading({
      payloads: sanitizedPayloads,
      replyToMode: params.replyToMode,
      replyToChannel: params.replyToChannel,
      currentMessageId: params.currentMessageId,
      replyThreading: params.replyThreading,
    }).map(async (payload) => {
      const parsed = normalizeReplyPayloadDirectives({
        payload,
        currentMessageId: params.currentMessageId,
        silentToken: SILENT_REPLY_TOKEN,
        parseMode: "always",
        extractMarkdownImages: params.extractMarkdownImages,
      });
      const mediaNormalizedPayload = await normalizeReplyPayloadMedia({
        payload: parsed.payload,
        normalizeMediaPaths: params.normalizeMediaPaths,
        suppressMediaFailureWarning: parsed.isSilent,
      });
      if (parsed.isSilent) {
        mediaNormalizedPayload.text = undefined;
      }
      return setReplyPayloadMetadata(mediaNormalizedPayload, {
        replyDelivery,
        ...(replyDeliverySource ? { replyDeliverySource } : {}),
      });
    }),
  );
  const replyTaggedPayloads: ReplyPayload[] = [];
  for (const payload of replyTaggedPayloadCandidates) {
    if (isRenderablePayload(payload)) {
      replyTaggedPayloads.push(payload);
    }
  }
  const silentFilteredPayloads: ReplyPayload[] = [];
  if (params.silentExpected) {
    for (const payload of replyTaggedPayloads) {
      if (shouldKeepPayloadDuringSilentTurn(payload)) {
        silentFilteredPayloads.push(payload);
      }
    }
  } else {
    silentFilteredPayloads.push(...replyTaggedPayloads);
  }
  const threadedPayloads = params.applyReplyToMode
    ? silentFilteredPayloads.map(params.applyReplyToMode)
    : silentFilteredPayloads;

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const shouldCheckMessagingToolDedupe =
    messagingToolSentTexts.length > 0 ||
    (params.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    messagingToolSentTargets.length > 0;
  const sentMediaUrlFallback = params.messagingToolSentMediaUrls ?? [];
  let dedupedPayloads = threadedPayloads;
  if (shouldCheckMessagingToolDedupe) {
    const dedupeRuntime = await loadReplyPayloadsDedupeRuntime();
    const originatingTo = resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    });
    dedupedPayloads = [];
    for (const payload of threadedPayloads) {
      const payloadMetadata = getReplyPayloadMetadata(payload);
      // Source mirrors exist because an internal sink send must reach the UI and
      // transcript; that send is not outbound evidence for dropping the mirror.
      if (payloadMetadata?.sourceReplyTranscriptMirror) {
        dedupedPayloads.push(payload);
        continue;
      }
      const decision = dedupeRuntime.resolveMessagingToolPayloadDedupe({
        config: params.config,
        messageProvider,
        messagingToolSentTargets,
        originatingTo,
        originatingThreadId: params.originatingThreadId,
        replyToId: payload.replyToId,
        replyToIsExplicit: Boolean(
          payloadMetadata?.replyToIdExplicit || payload.replyToTag || payload.replyToCurrent,
        ),
        replyDelivery: payloadMetadata?.replyDelivery,
        accountId,
      });
      if (!decision.shouldDedupePayloads) {
        dedupedPayloads.push(payload);
        continue;
      }
      const sentMediaUrls =
        decision.matchingRoute && !decision.useGlobalSentMediaUrlEvidenceFallback
          ? decision.routeSentMediaUrls
          : sentMediaUrlFallback;
      const sentTexts =
        decision.matchingRoute && !decision.useGlobalSentTextEvidenceFallback
          ? decision.routeSentTexts
          : messagingToolSentTexts;
      const normalizedSentMediaUrls = await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls,
        normalizeMediaPaths: params.normalizeMediaPaths,
      });
      const mediaFiltered = dedupeRuntime.filterMessagingToolMediaDuplicates({
        payloads: [payload],
        sentMediaUrls: normalizedSentMediaUrls,
      });
      const textFiltered = dedupeRuntime.filterMessagingToolDuplicates({
        payloads: mediaFiltered,
        sentTexts,
      });
      dedupedPayloads.push(...textFiltered);
    }
  }
  const directlySentTextFragmentsByAssistantMessage = new Map<number | undefined, string[]>();
  for (const sentPayload of params.directlySentBlockPayloads ?? []) {
    const sentText = sentPayload.text ?? resolveSendableOutboundReplyParts(sentPayload).trimmedText;
    if (!sentText) {
      continue;
    }
    const assistantMessageIndex = getReplyPayloadMetadata(sentPayload)?.assistantMessageIndex;
    const fragments = directlySentTextFragmentsByAssistantMessage.get(assistantMessageIndex);
    if (fragments) {
      fragments.push(sentText);
    } else {
      directlySentTextFragmentsByAssistantMessage.set(assistantMessageIndex, [sentText]);
    }
  }
  const isDirectlySentBlockPayload = (payload: ReplyPayload) =>
    Boolean(params.directlySentBlockKeys?.has(createBlockReplyContentKey(payload)));
  const hasDirectlySentText = (payload: ReplyPayload): boolean => {
    if (isDirectlySentBlockPayload(payload)) {
      return true;
    }
    const text = resolveSendableOutboundReplyParts(payload).trimmedText;
    if (!text || !params.directlySentBlockPayloads?.length) {
      return false;
    }
    const normalizedText = text.trim();
    const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
    const applicableFragments =
      directlySentTextFragmentsByAssistantMessage.get(assistantMessageIndex);
    return applicableFragments ? applicableFragments.join("").trim() === normalizedText : false;
  };
  const preserveUnsentMediaAfterBlockSend = (payload: ReplyPayload): ReplyPayload | null => {
    if (payload.isError || payload.isFallbackNotice) {
      return payload;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    if (!reply.hasMedia) {
      // Aggregate coverage suppresses plain text split across streamed blocks; rich content needs
      // exact evidence. Partial coverage cannot safely reconstruct a formatted remainder, so
      // preserve the complete final rather than silently truncate it.
      const hasRichContent = hasOutboundReplyContent(
        { ...payload, text: undefined, mediaUrl: undefined, mediaUrls: undefined },
        { trimText: true },
      );
      const wasSent = hasRichContent
        ? params.blockReplyPipeline?.hasSentExactPayload?.(payload)
        : params.blockReplyPipeline?.hasSentPayload(payload);
      if (wasSent) {
        return null;
      }
      return payload;
    }
    if (!reply.trimmedText) {
      return payload;
    }
    const textOnlyPayload = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: undefined,
    });
    const textWasSent = params.blockReplyPipeline?.hasSentPayload(textOnlyPayload)
      ? true
      : hasDirectlySentText(textOnlyPayload);
    if (!textWasSent) {
      return payload;
    }
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: undefined,
      audioAsVoice: payload.audioAsVoice || undefined,
    });
  };
  const preserveDirectlyUnsentPayload = (payload: ReplyPayload): ReplyPayload | null => {
    const reply = resolveSendableOutboundReplyParts(payload);
    if (!reply.hasMedia || !reply.trimmedText) {
      return payload;
    }
    return preserveUnsentMediaAfterBlockSend(payload);
  };
  const contentSuppressedPayloads = shouldDropFinalPayloads
    ? (() => {
        const preserved: ReplyPayload[] = [];
        for (const payload of dedupedPayloads) {
          const next = preserveUnsentMediaAfterBlockSend(payload);
          if (next) {
            preserved.push(next);
          }
        }
        return preserved;
      })()
    : params.blockStreamingEnabled
      ? (() => {
          const unsent: ReplyPayload[] = [];
          for (const payload of dedupedPayloads) {
            if (
              !params.blockReplyPipeline?.hasSentPayload(payload) &&
              !isDirectlySentBlockPayload(payload)
            ) {
              const next = preserveDirectlyUnsentPayload(payload);
              if (next) {
                unsent.push(next);
              }
            }
          }
          return unsent;
        })()
      : params.directlySentBlockKeys?.size
        ? (() => {
            const unsent: ReplyPayload[] = [];
            for (const payload of dedupedPayloads) {
              if (params.directlySentBlockKeys.has(createBlockReplyContentKey(payload))) {
                continue;
              }
              const next = preserveDirectlyUnsentPayload(payload);
              if (next) {
                unsent.push(next);
              }
            }
            return unsent;
          })()
        : dedupedPayloads;
  const blockSentMediaUrls = await normalizeSentMediaUrlsForDedupe({
    sentMediaUrls: [
      ...(params.blockStreamingEnabled
        ? (params.blockReplyPipeline?.getSentMediaUrls() ?? [])
        : []),
      ...(params.directlySentBlockPayloads ?? []).flatMap(
        (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
      ),
    ],
    normalizeMediaPaths: params.normalizeMediaPaths,
  });
  const filteredPayloads =
    blockSentMediaUrls.length > 0
      ? (await loadReplyPayloadsDedupeRuntime()).filterMessagingToolMediaDuplicates({
          payloads: contentSuppressedPayloads,
          sentMediaUrls: blockSentMediaUrls,
        })
      : contentSuppressedPayloads;
  const replyPayloads: ReplyPayload[] = [];
  for (const payload of filteredPayloads) {
    if (isRenderablePayload(payload)) {
      replyPayloads.push(payload);
    }
  }

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
