import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import {
  normalizeUniqueStringEntries,
  uniqueStrings,
} from "../../../shared/string-normalization.js";
import type { EmbeddedPiRunResult } from "../types.js";

type EmbeddedRunPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number];

export function mergeAttemptToolMediaPayloads(params: {
  payloads?: EmbeddedRunPayload[];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  toolTrustedLocalMedia?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): EmbeddedRunPayload[] | undefined {
  const mediaUrls = normalizeUniqueStringEntries(params.toolMediaUrls);
  if (mediaUrls.length === 0 && !params.toolAudioAsVoice && !params.toolTrustedLocalMedia) {
    return params.payloads;
  }

  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning);
  if (payloadIndex >= 0) {
    const payload = payloads[payloadIndex];
    if (
      params.sourceReplyDeliveryMode === "message_tool_only" &&
      getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror
    ) {
      return payloads;
    }
    const mergedMediaUrls = uniqueStrings([...(payload.mediaUrls ?? []), ...mediaUrls]);
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
      trustedLocalMedia: payload.trustedLocalMedia || params.toolTrustedLocalMedia || undefined,
    });
    return payloads;
  }

  return [
    ...payloads,
    {
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      mediaUrl: mediaUrls[0],
      audioAsVoice: params.toolAudioAsVoice || undefined,
      trustedLocalMedia: params.toolTrustedLocalMedia || undefined,
    },
  ];
}
