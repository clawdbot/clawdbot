// Normalizes direct cron payloads before TTS, custody, transport, or mirroring.
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplyOutcome } from "../../auto-reply/reply/normalize-reply.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  resolveDirectCronFallbackSourceIndex,
  resolveDirectCronSummaryFallbackText,
  shouldAttachDirectCronFallbackText,
} from "./delivery-dispatch-awareness.js";
import { normalizeSilentReplyText } from "./delivery-dispatch-policy.js";

type CronChannelTransform = {
  apply: (payload: ReplyPayload) => ReplyPayload | null;
};

function normalizeDirectPayload(payload: ReplyPayload): ReplyPayload {
  const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
  return normalized
    ? copyReplyPayloadMetadata(payload, {
        ...payload,
        text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
      })
    : payload;
}

export function normalizeDirectCronDeliveryPayloads(params: {
  deliveryPayloads: ReplyPayload[];
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
  channelTransform?: CronChannelTransform;
}): NormalizeReplyOutcome<ReplyPayload[]> {
  const fallback = normalizeSilentReplyText(resolveDirectCronSummaryFallbackText(params));
  const fallbackText = fallback.strippedTrailingSilentToken ? undefined : fallback.text;
  const candidates = params.deliveryPayloads
    .map(normalizeDirectPayload)
    .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
  if (candidates.length === 0 && fallbackText) {
    candidates.push({ text: fallbackText });
  }
  let fallbackSourceIndex = resolveDirectCronFallbackSourceIndex(candidates, fallbackText);
  if (
    fallbackText &&
    fallbackSourceIndex === undefined &&
    candidates.some(shouldAttachDirectCronFallbackText)
  ) {
    candidates.unshift({ text: fallbackText });
    fallbackSourceIndex = 0;
  }
  const prepared = candidates.map((payload) =>
    shouldAttachDirectCronFallbackText(payload) && fallbackText && fallbackSourceIndex !== undefined
      ? copyReplyPayloadMetadata(
          payload,
          Object.assign({}, payload, {
            fallbackText: { text: fallbackText, replacesPayloadIndex: fallbackSourceIndex },
          }),
        )
      : payload,
  );
  const accepted: Array<{ payload: ReplyPayload; sourceIndex: number }> = [];
  let fallbackSourceSuppressed = false;
  let channelSuppressed = false;
  for (const [index, candidate] of prepared.entries()) {
    const transformed = params.channelTransform
      ? params.channelTransform.apply(candidate)
      : candidate;
    if (transformed === null) {
      channelSuppressed = true;
      fallbackSourceSuppressed ||= index === fallbackSourceIndex;
    } else {
      accepted.push({ payload: transformed, sourceIndex: index });
    }
  }
  if (accepted.length === 0) {
    return { kind: "suppress", reason: channelSuppressed ? "channel_transform" : "empty" };
  }

  const acceptedFallbackIndex = accepted.findIndex(
    ({ sourceIndex }) => sourceIndex === fallbackSourceIndex,
  );
  const payloads = accepted.map(({ payload }) => {
    const fallbackMeta = payload.fallbackText;
    if (!fallbackMeta || fallbackMeta.replacesPayloadIndex !== fallbackSourceIndex) {
      return payload;
    }
    return copyReplyPayloadMetadata(
      payload,
      Object.assign({}, payload, {
        fallbackText:
          fallbackSourceSuppressed || acceptedFallbackIndex < 0
            ? undefined
            : { ...fallbackMeta, replacesPayloadIndex: acceptedFallbackIndex },
      }),
    );
  });

  return { kind: "deliver", payload: payloads };
}

/**
 * Appends the Control UI run-inspection link to the last visible payload.
 * Callers invoke this only after silent-reply suppression so a link cannot turn
 * a silent or empty run into a visible announcement; the payload is replaced
 * rather than mutated because payload objects can be aliased by the caller.
 */
export function appendCronRunInspectionLink(
  payloads: ReplyPayload[],
  inspectionUrl: string | undefined,
): ReplyPayload[] {
  const index = payloads.findLastIndex((payload) => payload.text?.trim());
  if (!inspectionUrl || index < 0) {
    return payloads;
  }
  const payload = payloads[index]!;
  const linked = copyReplyPayloadMetadata(payload, {
    ...payload,
    text: `${payload.text}\nInspect: ${inspectionUrl}`,
  });
  return payloads.map((entry, at) => (at === index ? linked : entry));
}
