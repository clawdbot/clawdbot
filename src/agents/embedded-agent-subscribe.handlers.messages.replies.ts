/**
 * Owns pending assistant reply directives and tool-media handoff.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";

export function hasReplyDirectiveMetadata(
  parsed: ReplyDirectiveParseResult | null | undefined,
): boolean {
  return Boolean(
    parsed &&
    ((parsed.mediaUrls?.length ?? 0) > 0 ||
      parsed.audioAsVoice ||
      parsed.replyToId ||
      parsed.replyToTag ||
      parsed.replyToCurrent ||
      parsed.mediaTokenSkippedInFence ||
      (parsed.fencedSkippedMediaDirectives?.length ?? 0) > 0),
  );
}

function hasReplyDirectiveMetadataResult(
  parsed: ReplyDirectiveParseResult | null | undefined,
): parsed is ReplyDirectiveParseResult {
  return hasReplyDirectiveMetadata(parsed);
}

export function mergeReplyDirectiveResults(
  first: ReplyDirectiveParseResult | null | undefined,
  second: ReplyDirectiveParseResult | null | undefined,
): ReplyDirectiveParseResult | null {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  const mediaUrls = uniqueStrings([...(first.mediaUrls ?? []), ...(second.mediaUrls ?? [])]);
  const fencedSkippedMediaDirectives = uniqueStrings([
    ...(first.fencedSkippedMediaDirectives ?? []),
    ...(second.fencedSkippedMediaDirectives ?? []),
  ]);
  return {
    text: `${first.text ?? ""}${second.text ?? ""}`,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    replyToId: second.replyToId ?? first.replyToId,
    replyToCurrent: first.replyToCurrent || second.replyToCurrent,
    replyToTag: first.replyToTag || second.replyToTag,
    audioAsVoice: first.audioAsVoice || second.audioAsVoice || undefined,
    isSilent: first.isSilent || second.isSilent,
    mediaTokenSkippedInFence:
      first.mediaTokenSkippedInFence || second.mediaTokenSkippedInFence || false,
    fencedSkippedMediaDirectives,
  };
}

function clearPendingToolMedia(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
) {
  state.pendingToolMediaUrls = [];
  state.pendingToolMediaAttachments = [];
  state.pendingToolMediaTrustByUrl.clear();
  state.pendingToolAudioAsVoice = false;
}

function hasReplyMedia(payload: BlockReplyPayload): boolean {
  return (payload.mediaUrls ?? []).some((url) => url.trim().length > 0);
}

function readAlignedPendingToolMedia(
  state: Pick<
    EmbeddedAgentSubscribeState,
    "pendingToolMediaUrls" | "pendingToolMediaAttachments" | "pendingToolMediaTrustByUrl"
  >,
) {
  const seen = new Set<string>();
  const mediaUrls: string[] = [];
  const attachments: NonNullable<BlockReplyPayload["attachments"]> = [];
  for (const [index, url] of state.pendingToolMediaUrls.entries()) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    mediaUrls.push(url);
    const { trustedLocalMedia: _untrustedInput, ...attachment } =
      state.pendingToolMediaAttachments?.[index] ?? {};
    attachments.push({
      ...attachment,
      ...(state.pendingToolMediaTrustByUrl.get(url) === true ? { trustedLocalMedia: true } : {}),
    });
  }
  return {
    mediaUrls,
    attachments: attachments.some((entry) => Object.keys(entry).length > 0)
      ? attachments
      : undefined,
  };
}

/** Moves queued tool media into a non-reasoning assistant reply payload. */
export function consumePendingToolMediaIntoReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning) {
    return payload;
  }
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return payload;
  }
  if (hasReplyMedia(payload)) {
    // Pending tool media is a fallback delivery queue; explicit final media is
    // the assistant's user-visible selection, while tool output remains in the transcript.
    const alignedPendingMedia = readAlignedPendingToolMedia(state);
    const metadataByUrl = new Map(
      alignedPendingMedia.mediaUrls.map((url, index) => [
        url,
        alignedPendingMedia.attachments?.[index] ?? {},
      ]),
    );
    const selectedAttachments = (payload.mediaUrls ?? []).map(
      (url) => metadataByUrl.get(url.trim()) ?? {},
    );
    const allSelectedMediaIsPending =
      (payload.mediaUrls?.length ?? 0) > 0 &&
      (payload.mediaUrls ?? []).every((url) => metadataByUrl.has(url.trim()));
    const payloadWithMetadata =
      payload.attachments?.length ||
      selectedAttachments.every((entry) => Object.keys(entry).length === 0)
        ? payload
        : { ...payload, attachments: selectedAttachments };
    const selectedPayload =
      allSelectedMediaIsPending &&
      (payload.mediaUrls ?? []).every(
        (url) => state.pendingToolMediaTrustByUrl.get(url.trim()) === true,
      )
        ? { ...payloadWithMetadata, trustedLocalMedia: true }
        : payloadWithMetadata;
    clearPendingToolMedia(state);
    return selectedPayload;
  }
  const pendingMedia = readAlignedPendingToolMedia(state);
  const allPendingMediaTrusted =
    pendingMedia.mediaUrls.length > 0 &&
    pendingMedia.mediaUrls.every((url) => state.pendingToolMediaTrustByUrl.get(url) === true);
  const mergedPayload: BlockReplyPayload = {
    ...payload,
    mediaUrls: pendingMedia.mediaUrls.length ? pendingMedia.mediaUrls : undefined,
    attachments: pendingMedia.attachments,
    audioAsVoice: payload.audioAsVoice || state.pendingToolAudioAsVoice || undefined,
    ...(payload.trustedLocalMedia || allPendingMediaTrusted ? { trustedLocalMedia: true } : {}),
  };
  clearPendingToolMedia(state);
  return mergedPayload;
}

/** Consumes queued tool media as a standalone reply payload. */
export function consumePendingToolMediaReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
): BlockReplyPayload | null {
  const payload = readPendingToolMediaReply(state);
  if (!payload) {
    return null;
  }
  clearPendingToolMedia(state);
  return payload;
}

/** Reads queued tool media without clearing it. */
export function readPendingToolMediaReply(
  state: Pick<
    EmbeddedAgentSubscribeState,
    | "pendingToolMediaUrls"
    | "pendingToolMediaAttachments"
    | "pendingToolMediaTrustByUrl"
    | "pendingToolAudioAsVoice"
  >,
): BlockReplyPayload | null {
  if (state.pendingToolMediaUrls.length === 0 && !state.pendingToolAudioAsVoice) {
    return null;
  }
  const pendingMedia = readAlignedPendingToolMedia(state);
  const allPendingMediaTrusted =
    pendingMedia.mediaUrls.length > 0 &&
    pendingMedia.mediaUrls.every((url) => state.pendingToolMediaTrustByUrl.get(url) === true);
  return {
    mediaUrls: pendingMedia.mediaUrls.length ? pendingMedia.mediaUrls : undefined,
    attachments: pendingMedia.attachments,
    audioAsVoice: state.pendingToolAudioAsVoice || undefined,
    ...(allPendingMediaTrusted ? { trustedLocalMedia: true } : {}),
  };
}

export function recordPendingAssistantReplyDirectives(
  state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
  parsed: ReplyDirectiveParseResult | null | undefined,
) {
  if (!hasReplyDirectiveMetadataResult(parsed)) {
    return;
  }
  const current = state.pendingAssistantReplyDirectives;
  const mediaUrls = Array.from(
    new Set([...(current?.mediaUrls ?? []), ...(parsed.mediaUrls ?? [])]),
  );
  const fencedSkippedMediaDirectives = uniqueStrings([
    ...(current?.fencedSkippedMediaDirectives ?? []),
    ...(parsed.fencedSkippedMediaDirectives ?? []),
  ]);
  state.pendingAssistantReplyDirectives = {
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    audioAsVoice: current?.audioAsVoice || parsed?.audioAsVoice || undefined,
    replyToId: parsed?.replyToId ?? current?.replyToId,
    replyToTag: current?.replyToTag || parsed.replyToTag || undefined,
    replyToCurrent: current?.replyToCurrent || parsed.replyToCurrent || undefined,
    mediaTokenSkippedInFence:
      current?.mediaTokenSkippedInFence || parsed.mediaTokenSkippedInFence || undefined,
    fencedSkippedMediaDirectives: fencedSkippedMediaDirectives.length
      ? fencedSkippedMediaDirectives
      : undefined,
  };
}

/** Merges pending reply directives into one reply payload and clears them. */
export function consumePendingAssistantReplyDirectivesIntoReply(
  state: Pick<EmbeddedAgentSubscribeState, "pendingAssistantReplyDirectives">,
  payload: BlockReplyPayload,
): BlockReplyPayload {
  if (payload.isReasoning || !state.pendingAssistantReplyDirectives) {
    return payload;
  }
  const pending = state.pendingAssistantReplyDirectives;
  const mediaUrls = Array.from(
    new Set([...(payload.mediaUrls ?? []), ...(pending.mediaUrls ?? [])]),
  );
  const fencedSkippedMediaDirectives = uniqueStrings([
    ...(payload.fencedSkippedMediaDirectives ?? []),
    ...(pending.fencedSkippedMediaDirectives ?? []),
  ]);
  state.pendingAssistantReplyDirectives = undefined;
  return {
    ...payload,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    audioAsVoice: payload.audioAsVoice || pending.audioAsVoice || undefined,
    replyToId: payload.replyToId ?? pending.replyToId,
    replyToTag: Boolean(payload.replyToTag || pending.replyToTag) || undefined,
    replyToCurrent: Boolean(payload.replyToCurrent || pending.replyToCurrent) || undefined,
    mediaTokenSkippedInFence:
      payload.mediaTokenSkippedInFence || pending.mediaTokenSkippedInFence || undefined,
    fencedSkippedMediaDirectives: fencedSkippedMediaDirectives.length
      ? fencedSkippedMediaDirectives
      : undefined,
  };
}

/** True when a reply payload has text, media, or voice content worth sending. */
export function hasAssistantVisibleReply(params: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
}): boolean {
  return resolveSendableOutboundReplyParts(params).hasContent || Boolean(params.audioAsVoice);
}

/** Builds normalized stream payload data for assistant visible output. */
