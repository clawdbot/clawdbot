import { copyReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { EmbeddedPiRunResult } from "../types.js";

type EmbeddedRunPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number];

export function mergeAttemptToolMediaPayloads(params: {
  payloads?: EmbeddedRunPayload[];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
}): EmbeddedRunPayload[] | undefined {
  const mediaUrls = Array.from(
    new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []),
  );
  if (mediaUrls.length === 0 && !params.toolAudioAsVoice) {
    return params.payloads;
  }

  const payloads = params.payloads?.length ? [...params.payloads] : [];
  const payloadIndex = payloads.findIndex((payload) => !payload.isReasoning);
  if (payloadIndex >= 0) {
    const payload = payloads[payloadIndex];
    const mergedMediaUrls = Array.from(new Set([...(payload.mediaUrls ?? []), ...mediaUrls]));
    payloads[payloadIndex] = copyReplyPayloadMetadata(payload, {
      ...payload,
      mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
      mediaUrl: payload.mediaUrl ?? mergedMediaUrls[0],
      audioAsVoice: payload.audioAsVoice || params.toolAudioAsVoice || undefined,
    });
    return payloads;
  }

  return [
    ...payloads,
    {
      mediaUrls: mediaUrls.length ? mediaUrls : undefined,
      mediaUrl: mediaUrls[0],
      audioAsVoice: params.toolAudioAsVoice || undefined,
    },
  ];
}
