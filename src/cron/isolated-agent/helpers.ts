import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../../auto-reply/heartbeat.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import { shouldSkipHeartbeatOnlyDelivery } from "../heartbeat-policy.js";

type DeliveryPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrl" | "mediaUrls" | "interactive" | "channelData" | "isError"
>;

export type CronPayloadOutcome = {
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayload?: DeliveryPayload;
  deliveryPayloads: DeliveryPayload[];
  deliveryPayloadHasStructuredContent: boolean;
  hasFatalErrorPayload: boolean;
  embeddedRunError?: string;
};

export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

export function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

export function pickLastNonEmptyTextFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

function isDeliverablePayload(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  const hasInteractive = (payload.interactive?.blocks?.length ?? 0) > 0;
  const hasChannelData = Object.keys(payload.channelData ?? {}).length > 0;
  return hasOutboundReplyContent(payload, { trimText: true }) || hasInteractive || hasChannelData;
}

function payloadHasStructuredDeliveryContent(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return (
    payload.mediaUrl !== undefined ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    (payload.interactive?.blocks?.length ?? 0) > 0 ||
    Object.keys(payload.channelData ?? {}).length > 0
  );
}

export function pickLastDeliverablePayload(payloads: DeliveryPayload[]) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    if (isDeliverablePayload(payloads[i])) {
      return payloads[i];
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (isDeliverablePayload(payloads[i])) {
      return payloads[i];
    }
  }
  return undefined;
}

export function pickDeliverablePayloads(payloads: DeliveryPayload[]): DeliveryPayload[] {
  const successfulDeliverablePayloads = payloads.filter(
    (payload) => payload != null && payload.isError !== true && isDeliverablePayload(payload),
  );
  if (successfulDeliverablePayloads.length > 0) {
    return successfulDeliverablePayloads;
  }
  const lastDeliverablePayload = pickLastDeliverablePayload(payloads);
  return lastDeliverablePayload ? [lastDeliverablePayload] : [];
}

/**
 * Check if delivery should be skipped because the agent signaled no user-visible update.
 * Returns true when any payload is a heartbeat ack token and no payload contains media.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  return shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars);
}

export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}

export function resolveCronPayloadOutcome(params: {
  payloads: DeliveryPayload[];
  runLevelError?: unknown;
  finalAssistantVisibleText?: string;
  preferFinalAssistantVisibleText?: boolean;
}): CronPayloadOutcome {
  const firstText = params.payloads[0]?.text ?? "";
  const fallbackSummary =
    pickSummaryFromPayloads(params.payloads) ?? pickSummaryFromOutput(firstText);
  const fallbackOutputText = pickLastNonEmptyTextFromPayloads(params.payloads);
  const deliveryPayload = pickLastDeliverablePayload(params.payloads);
  const selectedDeliveryPayloads = pickDeliverablePayloads(params.payloads);
  const deliveryPayloadHasStructuredContent = payloadHasStructuredDeliveryContent(deliveryPayload);
  const hasErrorPayload = params.payloads.some((payload) => payload?.isError === true);
  const lastErrorPayloadIndex = params.payloads.findLastIndex(
    (payload) => payload?.isError === true,
  );
  const hasSuccessfulPayloadAfterLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex >= 0 &&
    params.payloads
      .slice(lastErrorPayloadIndex + 1)
      .some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
  const hasFatalErrorPayload = hasErrorPayload && !hasSuccessfulPayloadAfterLastError;
  const normalizedFinalAssistantVisibleText = normalizeOptionalString(
    params.finalAssistantVisibleText,
  );
  const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) =>
    payloadHasStructuredDeliveryContent(payload),
  );
  // Keep structured/media announce payloads intact. Only collapse purely textual
  // cron announce output to the final assistant-visible answer.
  const shouldUseFinalAssistantVisibleText =
    params.preferFinalAssistantVisibleText === true &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasFatalErrorPayload &&
    !hasStructuredDeliveryPayloads;
  const summary = shouldUseFinalAssistantVisibleText
    ? (pickSummaryFromOutput(normalizedFinalAssistantVisibleText) ?? fallbackSummary)
    : fallbackSummary;
  const outputText = shouldUseFinalAssistantVisibleText
    ? normalizedFinalAssistantVisibleText
    : fallbackOutputText;
  const synthesizedText = normalizeOptionalString(outputText) ?? normalizeOptionalString(summary);
  const resolvedDeliveryPayloads = shouldUseFinalAssistantVisibleText
    ? [{ text: normalizedFinalAssistantVisibleText }]
    : selectedDeliveryPayloads.length > 0
      ? selectedDeliveryPayloads
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];
  const lastErrorPayloadText = [...params.payloads]
    .toReversed()
    .find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))
    ?.text?.trim();
  return {
    summary,
    outputText,
    synthesizedText,
    deliveryPayload,
    deliveryPayloads: resolvedDeliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError: hasFatalErrorPayload
      ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
      : undefined,
  };
}
