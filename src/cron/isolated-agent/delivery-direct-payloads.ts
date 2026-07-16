import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  resolveDirectCronFallbackSourceIndex,
  resolveDirectCronSummaryFallbackText,
  shouldAttachDirectCronFallbackText,
} from "./delivery-dispatch-awareness.js";
import { normalizeSilentReplyText } from "./delivery-dispatch-policy.js";

export function buildNormalizedDirectCronPayloads(params: {
  deliveryPayloads: ReplyPayload[];
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
}): ReplyPayload[] {
  const summaryFallbackText = resolveDirectCronSummaryFallbackText(params);
  const normalizedSummaryFallback = summaryFallbackText
    ? normalizeSilentReplyText(summaryFallbackText)
    : undefined;
  const normalizedSummaryFallbackText =
    normalizedSummaryFallback?.strippedTrailingSilentToken === true
      ? undefined
      : normalizedSummaryFallback?.text;
  const normalizedDeliveryPayloads = params.deliveryPayloads
    .map((payload) => {
      const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
      return normalized
        ? {
            ...payload,
            text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
          }
        : payload;
    })
    .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
  const existingFallbackSourceIndex = resolveDirectCronFallbackSourceIndex(
    normalizedDeliveryPayloads,
    normalizedSummaryFallbackText,
  );
  const needsFallbackSource =
    Boolean(normalizedSummaryFallbackText) &&
    normalizedDeliveryPayloads.some(shouldAttachDirectCronFallbackText) &&
    existingFallbackSourceIndex === undefined;
  const fallbackSourceIndex = needsFallbackSource ? 0 : existingFallbackSourceIndex;
  const directPayloads = needsFallbackSource
    ? [{ text: normalizedSummaryFallbackText }, ...normalizedDeliveryPayloads]
    : normalizedDeliveryPayloads;
  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of directPayloads) {
    normalizedPayloads.push(
      shouldAttachDirectCronFallbackText(payload) && normalizedSummaryFallbackText
        ? {
            ...payload,
            fallbackText: {
              text: normalizedSummaryFallbackText,
              ...(fallbackSourceIndex !== undefined
                ? { replacesPayloadIndex: fallbackSourceIndex }
                : {}),
            },
          }
        : payload,
    );
  }
  return normalizedPayloads.length === 0 && normalizedSummaryFallbackText
    ? [{ text: normalizedSummaryFallbackText }]
    : normalizedPayloads;
}
