/**
 * Merges media payloads discovered from attempt tool results.
 */
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  type ReplyMediaAttachment,
} from "../../../auto-reply/reply-payload.js";
import type { EmbeddedAgentRunResult } from "../types.js";

/** Channel payload shape produced by embedded runs after auto-reply normalization. */
type EmbeddedRunPayload = NonNullable<EmbeddedAgentRunResult["payloads"]>[number];

/**
 * Merges media emitted by tools into the channel payloads produced by the
 * assistant turn. The first non-reasoning reply owns the media so text and
 * attachments stay together; metadata is preserved for delivery bookkeeping.
 */
export function mergeAttemptToolMediaPayloads(params: {
  payloads?: EmbeddedRunPayload[];
  toolMediaUrls?: string[];
  toolMediaAttachments?: ReplyMediaAttachment[];
  hostOwnedToolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): EmbeddedRunPayload[] | undefined {
  // Trim and dedupe tool media before merging with assistant-owned payload media.
  const toolAttachmentByUrl = new Map<string, ReplyMediaAttachment>();
  const mediaUrls: string[] = [];
  const seenMediaUrls = new Set<string>();
  for (const [index, rawUrl] of (params.toolMediaUrls ?? []).entries()) {
    const url = rawUrl.trim();
    if (!url) {
      continue;
    }
    const sourceAttachment = params.toolMediaAttachments?.[index];
    if (sourceAttachment) {
      const existingAttachment = toolAttachmentByUrl.get(url);
      toolAttachmentByUrl.set(url, {
        ...existingAttachment,
        ...sourceAttachment,
        ...(params.toolTrustedLocalMedia ? { trustedLocalMedia: true } : {}),
      });
    }
    if (!seenMediaUrls.has(url)) {
      seenMediaUrls.add(url);
      mediaUrls.push(url);
    }
  }
  const mediaUrlSet = new Set(mediaUrls);
  const hostOwnedMediaUrls = Array.from(
    new Set(
      params.hostOwnedToolMediaUrls
        ?.map((url) => url.trim())
        .filter((url) => url.length > 0 && mediaUrlSet.has(url)) ?? [],
    ),
  );
  if (mediaUrls.length === 0 && !params.toolAudioAsVoice && !params.toolTrustedLocalMedia) {
    return params.payloads;
  }

  const buildAlignedAttachments = (
    urls: readonly string[],
    fallbackAttachments?: readonly (ReplyMediaAttachment | undefined)[],
  ): ReplyMediaAttachment[] | undefined => {
    const attachments = urls.map((url, index) => {
      const fallback = fallbackAttachments?.[index];
      const toolAttachment = toolAttachmentByUrl.get(url.trim());
      if (!fallback) {
        return toolAttachment ? { ...toolAttachment } : {};
      }
      return {
        ...toolAttachment,
        ...fallback,
        ...(toolAttachment?.trustedLocalMedia ? { trustedLocalMedia: true } : {}),
      };
    });
    return attachments.some((attachment) => Object.keys(attachment).length > 0)
      ? attachments
      : undefined;
  };
  const buildMediaPayload = (urls: string[], includeAudio: boolean): EmbeddedRunPayload => {
    const attachments = buildAlignedAttachments(urls);
    return {
      mediaUrls: urls.length ? urls : undefined,
      mediaUrl: urls[0],
      ...(attachments ? { attachments } : {}),
      audioAsVoice: (includeAudio && params.toolAudioAsVoice) || undefined,
      trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
    };
  };
  const shouldSplitHostOwnedMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && hostOwnedMediaUrls.length > 0;
  const hostOwnedMediaUrlSet = new Set(hostOwnedMediaUrls);
  const mergeableMediaUrls = shouldSplitHostOwnedMedia
    ? mediaUrls.filter((url) => !hostOwnedMediaUrlSet.has(url))
    : mediaUrls;
  const appendHostOwnedMedia = (nextPayloads: EmbeddedRunPayload[]): EmbeddedRunPayload[] => {
    if (!shouldSplitHostOwnedMedia) {
      return nextPayloads;
    }
    // Harness-owned artifacts remain separate from assistant text and generic
    // tool media so only their explicit provenance bypasses source suppression.
    return [
      ...nextPayloads,
      markReplyPayloadForSourceSuppressionDelivery(buildMediaPayload(hostOwnedMediaUrls, false)),
    ];
  };

  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning);
  if (payloadIndex >= 0) {
    const payload = payloads.at(payloadIndex);
    if (!payload) {
      return payloads;
    }
    if (
      params.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror
    ) {
      // Message-tool-only source replies are transcript mirrors of a send that
      // already happened elsewhere; attaching generated media here would create
      // a duplicate channel delivery.
      return appendHostOwnedMedia(payloads);
    }
    if (mergeableMediaUrls.length === 0 && shouldSplitHostOwnedMedia) {
      return appendHostOwnedMedia(payloads);
    }
    const mergedMediaUrls = Array.from(
      new Set([...(payload.mediaUrls ?? []), ...mergeableMediaUrls]),
    );
    const payloadAttachmentByUrl = new Map(
      (payload.mediaUrls ?? []).map((url, index) => [url.trim(), payload.attachments?.[index]]),
    );
    const fallbackAttachments = mergedMediaUrls.map((url) =>
      payloadAttachmentByUrl.get(url.trim()),
    );
    const mergedAttachments = buildAlignedAttachments(mergedMediaUrls, fallbackAttachments);
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      ...(mergedAttachments ? { attachments: mergedAttachments } : {}),
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    return appendHostOwnedMedia(payloads);
  }

  if (shouldSplitHostOwnedMedia) {
    const genericMediaPayload =
      mergeableMediaUrls.length > 0 ? [buildMediaPayload(mergeableMediaUrls, true)] : [];
    return appendHostOwnedMedia([...payloads, ...genericMediaPayload]);
  }

  const mediaPayload = buildMediaPayload(mergeableMediaUrls, true);

  // Reasoning-only turns still need a concrete media payload so channel delivery sees the attachment.
  return [...payloads, mediaPayload];
}
