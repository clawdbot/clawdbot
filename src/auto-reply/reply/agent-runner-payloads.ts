import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers/sanitize-user-facing-text.js";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { stripLegacyBracketToolCallBlocks } from "../../shared/text/assistant-visible-text.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
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
import { applyReplyThreading, isRenderablePayload } from "./reply-payloads-base.js";

const replyPayloadsDedupeRuntimeLoader = createLazyImportLoader(
  () => import("./reply-payloads-dedupe.runtime.js"),
);

function loadReplyPayloadsDedupeRuntime() {
  return replyPayloadsDedupeRuntimeLoader.load();
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) {
    return params.payload;
  }

  try {
    const normalized = await params.normalizeMediaPaths(params.payload);
    return copyReplyPayloadMetadata(params.payload, normalized);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    return copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
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

export async function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  silentExpected?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  previewStreamedText?: string;
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
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

  const replyTaggedPayloadCandidates = await Promise.all(
    applyReplyThreading({
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
      });
      if (parsed.isSilent && !resolveSendableOutboundReplyParts(mediaNormalizedPayload).hasMedia) {
        mediaNormalizedPayload.text = undefined;
      }
      return mediaNormalizedPayload;
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
  const dedupeRuntime = shouldCheckMessagingToolDedupe
    ? await loadReplyPayloadsDedupeRuntime()
    : null;
  const messagingToolPayloadDedupe = dedupeRuntime?.resolveMessagingToolPayloadDedupe({
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.originatingChannel,
      provider: params.messageProvider,
    }),
    messagingToolSentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.accountId,
    }),
  }) ?? {
    shouldDedupePayloads: shouldCheckMessagingToolDedupe && messagingToolSentTargets.length === 0,
    matchingRoute: false,
    routeSentTexts: [],
    routeSentMediaUrls: [],
    useGlobalSentTextEvidenceFallback: false,
    useGlobalSentMediaUrlEvidenceFallback: false,
  };
  const dedupeMessagingToolPayloads = messagingToolPayloadDedupe.shouldDedupePayloads;
  const sentMediaUrlFallback = params.messagingToolSentMediaUrls ?? [];
  const shouldUseGlobalSentMediaUrlEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentMediaUrls.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentMediaUrlEvidenceFallback;
  const shouldUseGlobalSentTextEvidence =
    messagingToolPayloadDedupe.matchingRoute &&
    messagingToolPayloadDedupe.routeSentTexts.length === 0 &&
    messagingToolPayloadDedupe.useGlobalSentTextEvidenceFallback;
  const sentMediaUrlsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentMediaUrlEvidence
      ? sentMediaUrlFallback
      : messagingToolPayloadDedupe.routeSentMediaUrls
    : sentMediaUrlFallback;
  const sentTextsForDedupe = messagingToolPayloadDedupe.matchingRoute
    ? shouldUseGlobalSentTextEvidence
      ? messagingToolSentTexts
      : messagingToolPayloadDedupe.routeSentTexts
    : messagingToolSentTexts;
  const messagingToolSentMediaUrls = dedupeMessagingToolPayloads
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: sentMediaUrlsForDedupe,
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : sentMediaUrlsForDedupe;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? (
        dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
      ).filterMessagingToolMediaDuplicates({
        payloads: silentFilteredPayloads,
        sentMediaUrls: messagingToolSentMediaUrls,
      })
    : silentFilteredPayloads;
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? (dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())).filterMessagingToolDuplicates({
        payloads: mediaFilteredPayloads,
        sentTexts: sentTextsForDedupe,
      })
    : mediaFilteredPayloads;
  const isDirectlySentBlockPayload = (payload: ReplyPayload) =>
    Boolean(params.directlySentBlockKeys?.has(createBlockReplyContentKey(payload)));
  const normalizePreviewDedupeText = (value: string | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const buildPreviewDedupeTextSet = (value: string | undefined): Set<string> => {
    const dedupeText = new Set<string>();
    const normalizedWhole = normalizePreviewDedupeText(value);
    if (normalizedWhole) {
      dedupeText.add(normalizedWhole);
    }
    for (const block of (value ?? "").split(/\n{2,}/u)) {
      const normalizedBlock = normalizePreviewDedupeText(block);
      if (normalizedBlock) {
        dedupeText.add(normalizedBlock);
      }
    }
    return dedupeText;
  };
  const previewStreamedText = buildPreviewDedupeTextSet(params.previewStreamedText);
  const isPreviewStreamedTextPayload = (payload: ReplyPayload): boolean => {
    if (previewStreamedText.size === 0 || payload.isError) {
      return false;
    }
    const text = normalizePreviewDedupeText(payload.text);
    return Boolean(text && previewStreamedText.has(text));
  };
  const preserveUnsentMediaAfterPreviewStream = (payload: ReplyPayload): ReplyPayload | null => {
    if (!isPreviewStreamedTextPayload(payload)) {
      return payload;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    if (!reply.hasMedia) {
      return null;
    }
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: undefined,
      audioAsVoice: payload.audioAsVoice || undefined,
    });
  };
  const suppressPreviewStreamedPayloads = (payloads: ReplyPayload[]): ReplyPayload[] => {
    const unsent: ReplyPayload[] = [];
    for (const payload of payloads) {
      const next = preserveUnsentMediaAfterPreviewStream(payload);
      if (next) {
        unsent.push(next);
      }
    }
    return unsent;
  };
  const preserveUnsentMediaAfterBlockStream = (payload: ReplyPayload): ReplyPayload | null => {
    if (payload.isError || payload.isFallbackNotice) {
      return payload;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    if (!reply.hasMedia) {
      return null;
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
    if (!params.blockReplyPipeline?.hasSentPayload(textOnlyPayload)) {
      return payload;
    }
    return copyReplyPayloadMetadata(payload, {
      ...payload,
      text: undefined,
      audioAsVoice: payload.audioAsVoice || undefined,
    });
  };
  const contentSuppressedPayloads = shouldDropFinalPayloads
    ? (() => {
        const preserved: ReplyPayload[] = [];
        for (const payload of dedupedPayloads) {
          const next = preserveUnsentMediaAfterBlockStream(payload);
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
              unsent.push(payload);
            }
          }
          return unsent;
        })()
      : params.directlySentBlockKeys?.size
        ? (() => {
            const unsent: ReplyPayload[] = [];
            for (const payload of dedupedPayloads) {
              if (!params.directlySentBlockKeys.has(createBlockReplyContentKey(payload))) {
                unsent.push(payload);
              }
            }
            return unsent;
          })()
        : previewStreamedText.size > 0
          ? suppressPreviewStreamedPayloads(dedupedPayloads)
          : dedupedPayloads;
  const blockSentMediaUrls = params.blockStreamingEnabled
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: params.blockReplyPipeline?.getSentMediaUrls() ?? [],
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : [];
  const filteredPayloads =
    blockSentMediaUrls.length > 0
      ? (
          dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
        ).filterMessagingToolMediaDuplicates({
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
