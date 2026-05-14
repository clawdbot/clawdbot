import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../../auto-reply/heartbeat.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import { shouldSkipHeartbeatOnlyDelivery } from "../heartbeat-policy.js";

type DeliveryPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData" | "isError"
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
  pendingPresentationWarningError?: string;
};

type CronDenialSignal = {
  token: string;
  field: string;
};

type CronFailureSignal = {
  kind?: string;
  source?: string;
  toolName?: string;
  code?: string;
  message?: string;
  fatalForCron?: boolean;
};

type NormalizedCronFailureSignal = CronFailureSignal & {
  message: string;
  fatalForCron: true;
};

const CRON_DENIAL_EXACT_TOKENS = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;
const CRON_DENIAL_CASE_INSENSITIVE_TOKENS = [
  "approval cannot safely bind",
  "runtime denied",
  "could not run",
  "did not run",
  "was denied",
] as const;

export function detectCronDenialToken(text: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return undefined;
  }
  for (const token of CRON_DENIAL_EXACT_TOKENS) {
    if (normalized.includes(token)) {
      return token;
    }
  }
  const lowerText = normalized.toLowerCase();
  for (const token of CRON_DENIAL_CASE_INSENSITIVE_TOKENS) {
    if (lowerText.includes(token)) {
      return token;
    }
  }
  return undefined;
}

function resolveCronDenialSignal(
  fields: Array<{ field: string; text?: string | undefined }>,
): CronDenialSignal | undefined {
  const seen = new Set<string>();
  for (const { field, text } of fields) {
    if (seen.has(field)) {
      continue;
    }
    seen.add(field);
    const token = detectCronDenialToken(text);
    if (token) {
      return { token, field };
    }
  }
  return undefined;
}

function formatCronDenialSignal(signal: CronDenialSignal): string {
  return `cron classifier: denial token "${signal.token}" detected in ${signal.field}`;
}

function normalizeCronFailureSignal(
  signal: CronFailureSignal | undefined,
): NormalizedCronFailureSignal | undefined {
  const message = normalizeOptionalString(signal?.message);
  if (signal?.fatalForCron !== true || !message) {
    return undefined;
  }
  return { ...signal, message, fatalForCron: true };
}

function formatCronFailureSignal(signal: NormalizedCronFailureSignal): string {
  const kind = normalizeOptionalString(signal.kind) ?? "run";
  const code = normalizeOptionalString(signal.code);
  const source = normalizeOptionalString(signal.toolName) ?? normalizeOptionalString(signal.source);
  return `cron classifier: ${kind} failure${source ? ` from ${source}` : ""}${
    code ? ` (${code})` : ""
  }: ${signal.message}`;
}

function formatCronRunLevelError(error: unknown): string | undefined {
  const direct = normalizeOptionalString(error);
  if (direct) {
    return `cron isolated run failed: ${direct}`;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { message?: unknown; kind?: unknown };
  const message = normalizeOptionalString(record.message);
  if (message) {
    return `cron isolated run failed: ${message}`;
  }
  const kind = normalizeOptionalString(record.kind);
  if (kind) {
    return `cron isolated run failed: ${kind}`;
  }
  return "cron isolated run failed";
}

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
  return hasOutboundReplyContent(payload, { trimText: true });
}

function payloadHasStructuredDeliveryContent(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return (
    payload.mediaUrl !== undefined ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    (payload.presentation?.blocks?.length ?? 0) > 0 ||
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

function isCronMessagePresentationWarning(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text)?.toLowerCase();
  return (
    normalized === "⚠️ ✉️ message failed" ||
    normalized?.startsWith("⚠️ ✉️ message failed:") === true
  );
}

export function resolveCronPayloadOutcome(params: {
  payloads: DeliveryPayload[];
  runLevelError?: unknown;
  failureSignal?: CronFailureSignal | undefined;
  finalAssistantVisibleText?: string | undefined;
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
  const lastErrorPayloadText = [...params.payloads]
    .toReversed()
    .find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))
    ?.text?.trim();
  const normalizedFinalAssistantVisibleText = normalizeOptionalString(
    params.finalAssistantVisibleText,
  );
  const hasSuccessfulPayloadAfterLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex >= 0 &&
    params.payloads
      .slice(lastErrorPayloadIndex + 1)
      .some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
  const hasSuccessfulPayloadBeforeLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex > 0 &&
    params.payloads
      .slice(0, lastErrorPayloadIndex)
      .some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim()));
  const hasPendingPresentationWarning =
    !params.runLevelError &&
    params.failureSignal?.fatalForCron !== true &&
    lastErrorPayloadIndex >= 0 &&
    isCronMessagePresentationWarning(lastErrorPayloadText) &&
    (normalizedFinalAssistantVisibleText !== undefined || hasSuccessfulPayloadBeforeLastError);
  const hasFatalStructuredErrorPayload =
    hasErrorPayload && !hasSuccessfulPayloadAfterLastError && !hasPendingPresentationWarning;
  const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) =>
    payloadHasStructuredDeliveryContent(payload),
  );
  // Keep structured/media announce payloads intact. Only collapse purely textual
  // cron announce output to the final assistant-visible answer.
  const shouldUseFinalAssistantVisibleText =
    params.preferFinalAssistantVisibleText === true &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasFatalStructuredErrorPayload &&
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
  const denialSignal = resolveCronDenialSignal([
    { field: "summary", text: summary },
    { field: "outputText", text: outputText },
    { field: "synthesizedText", text: synthesizedText },
    { field: "fallbackSummary", text: fallbackSummary },
    { field: "fallbackOutputText", text: fallbackOutputText },
    ...params.payloads.map((payload, index) => ({
      field: `payloads[${index}].text`,
      text: payload?.text,
    })),
  ]);
  const failureSignal = normalizeCronFailureSignal(params.failureSignal);
  const runLevelError = formatCronRunLevelError(params.runLevelError);
  const hasFatalErrorPayload =
    hasFatalStructuredErrorPayload ||
    failureSignal !== undefined ||
    denialSignal !== undefined ||
    runLevelError !== undefined;
  const structuredErrorText = hasFatalStructuredErrorPayload
    ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
    : undefined;
  const shouldUseRunLevelErrorPayload =
    runLevelError !== undefined &&
    structuredErrorText === undefined &&
    failureSignal === undefined &&
    denialSignal === undefined;
  const fatalDeliveryText =
    structuredErrorText ??
    failureSignal?.message ??
    (shouldUseRunLevelErrorPayload ? runLevelError : undefined);
  const fatalDeliveryPayload = fatalDeliveryText
    ? ({ text: fatalDeliveryText, isError: true } satisfies DeliveryPayload)
    : undefined;
  return {
    summary: fatalDeliveryText ? (pickSummaryFromOutput(fatalDeliveryText) ?? summary) : summary,
    outputText: fatalDeliveryText ?? outputText,
    synthesizedText: fatalDeliveryText ?? synthesizedText,
    deliveryPayload: fatalDeliveryPayload ?? deliveryPayload,
    deliveryPayloads: fatalDeliveryPayload ? [fatalDeliveryPayload] : resolvedDeliveryPayloads,
    deliveryPayloadHasStructuredContent: fatalDeliveryPayload
      ? false
      : deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError: structuredErrorText
      ? structuredErrorText
      : failureSignal
        ? formatCronFailureSignal(failureSignal)
        : denialSignal
          ? formatCronDenialSignal(denialSignal)
          : runLevelError,
    pendingPresentationWarningError: hasPendingPresentationWarning
      ? lastErrorPayloadText
      : undefined,
  };
}
