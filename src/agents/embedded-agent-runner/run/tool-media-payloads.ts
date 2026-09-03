/**
 * Merges media payloads discovered from attempt tool results.
 */
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../../../auto-reply/reply-payload.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
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
  hostOwnedToolMediaUrls?: string[];
  toolAutoDeliveryMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): EmbeddedRunPayload[] | undefined {
  // Trim and dedupe tool media before merging with assistant-owned payload media.
  let mediaUrls = Array.from(
    new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning);
  const visiblePayload = payloads.at(payloadIndex);
  const isSourceReplyTranscriptMirror =
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    visiblePayload &&
    getReplyPayloadMetadata(visiblePayload)?.sourceReplyTranscriptMirror;
  if (visiblePayload?.text && mediaUrls.length > 0 && !isSourceReplyTranscriptMirror) {
    const selected = splitMediaFromOutput(visiblePayload.text, {
      extractAudioDirectives: false,
      extractMediaDirectives: false,
      markdownImageAllowlist: mediaUrls,
    });
    if (selected.mediaUrls?.length) {
      const selectedMediaUrls = new Set(selected.mediaUrls);
      mediaUrls = mediaUrls.filter((url) => selectedMediaUrls.has(url));
      payloads[payloadIndex] = copyReplyPayloadMetadata(visiblePayload, {
        ...visiblePayload,
        text: selected.text,
      });
    }
  }
  const mediaUrlSet = new Set(mediaUrls);
  const autoDeliveryMediaUrls = Array.from(
    new Set(params.toolAutoDeliveryMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  const hostOwnedMediaUrls = Array.from(
    new Set(
      params.hostOwnedToolMediaUrls
        ?.map((url) => url.trim())
        .filter((url) => url.length > 0 && mediaUrlSet.has(url)) ?? [],
    ),
  );
  if (
    mediaUrls.length === 0 &&
    autoDeliveryMediaUrls.length === 0 &&
    !params.toolAudioAsVoice &&
    !params.toolTrustedLocalMedia
  ) {
    return params.payloads;
  }

  const buildMediaPayload = (urls: string[], includeAudio: boolean): EmbeddedRunPayload => ({
    mediaUrls: urls.length ? urls : undefined,
    mediaUrl: urls[0],
    audioAsVoice: (includeAudio && params.toolAudioAsVoice) || undefined,
    trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
  });
  const shouldSplitHostOwnedMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && hostOwnedMediaUrls.length > 0;
  const hostOwnedMediaUrlSet = new Set(hostOwnedMediaUrls);
  const autoDeliveryOnlyMediaUrls = autoDeliveryMediaUrls.filter(
    (url) => !hostOwnedMediaUrlSet.has(url),
  );
  const shouldSplitAutoDeliveryMedia =
    params.sourceReplyDeliveryMode === "message_tool_only" && autoDeliveryOnlyMediaUrls.length > 0;
  const autoDeliveryMediaUrlSet = new Set(autoDeliveryMediaUrls);
  const mergeableMediaUrls =
    shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia
      ? mediaUrls.filter(
          (url) => !hostOwnedMediaUrlSet.has(url) && !autoDeliveryMediaUrlSet.has(url),
        )
      : mediaUrls;
  const appendOwnedMedia = (nextPayloads: EmbeddedRunPayload[]): EmbeddedRunPayload[] => {
    const withHostOwnedMedia = !shouldSplitHostOwnedMedia
      ? nextPayloads
      : [
          ...nextPayloads,
          markReplyPayloadForSourceSuppressionDelivery(
            buildMediaPayload(hostOwnedMediaUrls, false),
          ),
        ];
    if (!shouldSplitAutoDeliveryMedia) {
      return withHostOwnedMedia;
    }
    // Contract-owned media remains separate from private assistant text and
    // generic tool media so only its explicit provenance bypasses suppression.
    return [
      ...withHostOwnedMedia,
      markReplyPayloadForSourceSuppressionDelivery({
        ...buildMediaPayload(autoDeliveryOnlyMediaUrls, true),
        trustedLocalMedia: true,
      }),
    ];
  };

  if (payloadIndex >= 0) {
    const payload = payloads.at(payloadIndex);
    if (!payload) {
      return payloads;
    }
    if (isSourceReplyTranscriptMirror) {
      // Message-tool-only source replies are transcript mirrors of a send that
      // already happened elsewhere; attaching generated media here would create
      // a duplicate channel delivery.
      return appendOwnedMedia(payloads);
    }
    if (
      mergeableMediaUrls.length === 0 &&
      (shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia)
    ) {
      return appendOwnedMedia(payloads);
    }
    const mergedMediaUrls = Array.from(
      new Set([...(payload.mediaUrls ?? []), ...mergeableMediaUrls]),
    );
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    return appendOwnedMedia(payloads);
  }

  if (shouldSplitHostOwnedMedia || shouldSplitAutoDeliveryMedia) {
    const genericMediaPayload =
      mergeableMediaUrls.length > 0 ? [buildMediaPayload(mergeableMediaUrls, true)] : [];
    return appendOwnedMedia([...payloads, ...genericMediaPayload]);
  }

  const mediaPayload = buildMediaPayload(mergeableMediaUrls, true);

  // Reasoning-only turns still need a concrete media payload so channel delivery sees the attachment.
  return appendOwnedMedia([...payloads, mediaPayload]);
}
