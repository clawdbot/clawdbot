import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { parseInlineDirectives, sanitizeReplyDirectiveId } from "../../utils/directive-tags.js";
import { sanitizeAssistantDisplayText } from "./chat-assistant-content.js";

type DeliveredReply = {
  payload: ReplyPayload;
  kind: "block" | "final";
};

function parseReplyInlineDirectives(payload: ReplyPayload) {
  return typeof payload.text === "string" && payload.text.includes("[[")
    ? parseInlineDirectives(payload.text)
    : undefined;
}

function replyMediaUrls(payload: ReplyPayload): string[] {
  return resolveSendableOutboundReplyParts(payload).mediaUrls;
}

function replyMediaDedupeKeys(payload: ReplyPayload): string[] {
  return replyMediaUrls(payload).map((mediaUrl) => normalizeMediaReferenceForComparison(mediaUrl));
}

function canonicalizeReplyMedia(payload: ReplyPayload): ReplyPayload {
  const mediaUrls = replyMediaUrls(payload);
  return {
    ...payload,
    mediaUrl: undefined,
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

function mergeDefinedReplySemantics(target: ReplyPayload, source: ReplyPayload): ReplyPayload {
  const sourceInlineDirectives = parseReplyInlineDirectives(source);
  const sourceReplyToId =
    sanitizeReplyDirectiveId(source.replyToId) ??
    sanitizeReplyDirectiveId(sourceInlineDirectives?.replyToExplicitId);
  return {
    ...target,
    ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
      ? { trustedLocalMedia: true }
      : {}),
    ...(source.sensitiveMedia === true || target.sensitiveMedia === true
      ? { sensitiveMedia: true }
      : {}),
    ...(source.presentation !== undefined ? { presentation: source.presentation } : {}),
    ...(source.delivery !== undefined ? { delivery: source.delivery } : {}),
    ...(source.interactive !== undefined ? { interactive: source.interactive } : {}),
    ...(sourceReplyToId !== undefined ? { replyToId: sourceReplyToId } : {}),
    ...(source.replyToTag === true || target.replyToTag === true ? { replyToTag: true } : {}),
    ...(source.replyToCurrent === true ||
    sourceInlineDirectives?.replyToCurrent === true ||
    target.replyToCurrent === true
      ? { replyToCurrent: true }
      : {}),
    ...(source.audioAsVoice === true ||
    sourceInlineDirectives?.audioAsVoice === true ||
    target.audioAsVoice === true
      ? { audioAsVoice: true }
      : {}),
    ...(source.spokenText !== undefined ? { spokenText: source.spokenText } : {}),
    ...(source.ttsSupplement !== undefined ? { ttsSupplement: source.ttsSupplement } : {}),
    ...(source.isError === true || target.isError === true ? { isError: true } : {}),
    ...(source.channelData !== undefined ? { channelData: source.channelData } : {}),
  };
}

function mergeMediaReplySemantics(target: ReplyPayload, source: ReplyPayload): ReplyPayload {
  const sourceInlineDirectives = parseReplyInlineDirectives(source);
  return {
    ...target,
    ...(source.trustedLocalMedia === true || target.trustedLocalMedia === true
      ? { trustedLocalMedia: true }
      : {}),
    ...(source.sensitiveMedia === true || target.sensitiveMedia === true
      ? { sensitiveMedia: true }
      : {}),
    ...(source.audioAsVoice === true ||
    sourceInlineDirectives?.audioAsVoice === true ||
    target.audioAsVoice === true
      ? { audioAsVoice: true }
      : {}),
  };
}

function hasMergeableReplySemantics(payload: ReplyPayload): boolean {
  const inlineDirectives = parseReplyInlineDirectives(payload);
  return Boolean(
    payload.trustedLocalMedia !== undefined ||
    payload.sensitiveMedia !== undefined ||
    payload.presentation ||
    payload.delivery ||
    payload.interactive ||
    payload.replyToId ||
    payload.replyToTag !== undefined ||
    payload.replyToCurrent !== undefined ||
    payload.audioAsVoice !== undefined ||
    inlineDirectives?.hasReplyTag ||
    inlineDirectives?.hasAudioTag ||
    payload.spokenText ||
    payload.ttsSupplement ||
    payload.isError !== undefined ||
    payload.channelData,
  );
}

function hasUnmergedReplySemantics(payload: ReplyPayload): boolean {
  return Boolean(
    payload.isReasoning ||
    payload.isReasoningSnapshot ||
    payload.isCompactionNotice ||
    payload.isFallbackNotice ||
    payload.isStatusNotice ||
    payload.btw,
  );
}

function hasReplySemantics(payload: ReplyPayload): boolean {
  return hasMergeableReplySemantics(payload) || hasUnmergedReplySemantics(payload);
}

function mediaSetsMatch(leftMediaUrls: readonly string[], rightMediaUrls: readonly string[]) {
  if (leftMediaUrls.length !== rightMediaUrls.length) {
    return false;
  }
  return leftMediaUrls.every((mediaUrl, index) => mediaUrl === rightMediaUrls[index]);
}

function replyDisplayText(payload: ReplyPayload): string {
  return sanitizeAssistantDisplayText(payload.text) ?? "";
}

/** Fold command block replies into the final payload list without duplicating text or media. */
export function selectChatSendFinalReplyPayloads(params: {
  deliveredReplies: readonly DeliveredReply[];
  foldCommandBlocks: boolean;
  suppressReplies: boolean;
}): ReplyPayload[] {
  const { deliveredReplies, foldCommandBlocks, suppressReplies } = params;
  const finalPayloadEntries = deliveredReplies.filter((entry) => entry.kind === "final");
  const commandBlockPayloadEntries = foldCommandBlocks
    ? deliveredReplies.filter((entry) => entry.kind === "block")
    : [];
  const commandBlockPayloadEntriesForDelivery = commandBlockPayloadEntries.map((entry) => ({
    kind: entry.kind,
    payload: canonicalizeReplyMedia(entry.payload),
  }));
  const sensitiveMediaDedupeKeys = new Set(
    finalPayloadEntries.flatMap((entry) =>
      entry.payload.sensitiveMedia === true
        ? replyMediaDedupeKeys(entry.payload).filter(Boolean)
        : [],
    ),
  );
  if (sensitiveMediaDedupeKeys.size > 0) {
    for (const entry of commandBlockPayloadEntriesForDelivery) {
      if (replyMediaDedupeKeys(entry.payload).some((key) => sensitiveMediaDedupeKeys.has(key))) {
        entry.payload = { ...entry.payload, sensitiveMedia: true };
      }
    }
  }
  const finalPayloadEntriesForDelivery = foldCommandBlocks
    ? finalPayloadEntries.flatMap((entry) => {
        const finalMediaUrls = replyMediaUrls(entry.payload);
        const finalMediaKeys = replyMediaDedupeKeys(entry.payload);
        const finalDisplayText = replyDisplayText(entry.payload);
        const matchingMediaBlockEntry =
          finalMediaUrls.length > 0
            ? commandBlockPayloadEntriesForDelivery.find((candidate) =>
                mediaSetsMatch(replyMediaDedupeKeys(candidate.payload), finalMediaKeys),
              )
            : undefined;
        const matchingTextBlockEntry = finalDisplayText
          ? commandBlockPayloadEntriesForDelivery.find(
              (candidate) => replyDisplayText(candidate.payload) === finalDisplayText,
            )
          : undefined;
        const matchingMediaAndTextBlockEntry =
          finalMediaUrls.length > 0 && finalDisplayText
            ? commandBlockPayloadEntriesForDelivery.find(
                (candidate) =>
                  replyDisplayText(candidate.payload) === finalDisplayText &&
                  mediaSetsMatch(replyMediaDedupeKeys(candidate.payload), finalMediaKeys),
              )
            : undefined;
        const duplicateBlockEntry =
          finalMediaUrls.length > 0
            ? finalDisplayText
              ? matchingMediaAndTextBlockEntry
              : matchingMediaBlockEntry
            : finalMediaUrls.length === 0
              ? matchingTextBlockEntry
              : undefined;
        if (duplicateBlockEntry) {
          duplicateBlockEntry.payload = mergeDefinedReplySemantics(
            duplicateBlockEntry.payload,
            entry.payload,
          );
        } else if (matchingMediaBlockEntry) {
          matchingMediaBlockEntry.payload = mergeMediaReplySemantics(
            matchingMediaBlockEntry.payload,
            entry.payload,
          );
        }
        const remainingFinalMediaUrls = matchingMediaBlockEntry ? [] : finalMediaUrls;
        if (
          remainingFinalMediaUrls.length === 0 &&
          ((duplicateBlockEntry && !hasUnmergedReplySemantics(entry.payload)) ||
            (!duplicateBlockEntry && !finalDisplayText && !hasReplySemantics(entry.payload)))
        ) {
          return [];
        }
        return [
          {
            ...entry,
            payload: {
              ...entry.payload,
              mediaUrl: undefined,
              mediaUrls: remainingFinalMediaUrls.length > 0 ? remainingFinalMediaUrls : undefined,
            },
          },
        ];
      })
    : finalPayloadEntries;
  if (suppressReplies) {
    return [];
  }
  return [...commandBlockPayloadEntriesForDelivery, ...finalPayloadEntriesForDelivery].map(
    (entry) => entry.payload,
  );
}
