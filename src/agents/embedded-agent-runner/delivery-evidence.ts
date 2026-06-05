/**
 * Extracts visible delivery evidence from embedded-agent run results.
 */
import { hasAcceptedSessionSpawn } from "../accepted-session-spawn.js";

/**
 * Helpers for deciding whether an embedded run produced user-visible or outbound effects.
 *
 * Fallback and retry code uses these checks to avoid rerunning a model after messages, media,
 * cron entries, or spawned sessions have already been delivered.
 */
type AgentPayloadLike = {
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  presentation?: unknown;
  interactive?: unknown;
  channelData?: unknown;
  isError?: unknown;
  isReasoning?: unknown;
};

export type AgentDeliveryEvidence = {
  payloads?: unknown;
  deliveryStatus?: {
    status?: unknown;
    errorMessage?: unknown;
  };
  didSendViaMessagingTool?: unknown;
  messagingToolSentTexts?: unknown;
  messagingToolSentMediaUrls?: unknown;
  messagingToolSentTargets?: unknown;
  acceptedSessionSpawns?: unknown;
  successfulCronAdds?: unknown;
  meta?: {
    toolSummary?: {
      calls?: unknown;
    };
  };
};

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasNonEmptyString);
}

function collectStringValues(value: unknown, output: Set<string>) {
  if (typeof value === "string" && value.trim()) {
    output.add(value.trim());
    return;
  }
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      output.add(entry.trim());
    }
  }
}

function collectMediaUrlsFromRecord(record: Record<string, unknown>, output: Set<string>) {
  collectStringValues(record.mediaUrl, output);
  collectStringValues(record.mediaUrls, output);
  collectStringValues(record.path, output);
  collectStringValues(record.url, output);
  collectStringValues(record.filePath, output);
  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (attachment && typeof attachment === "object" && !Array.isArray(attachment)) {
        collectMediaUrlsFromRecord(attachment as Record<string, unknown>, output);
      }
    }
  }
}

/** Collects media URLs from agent payloads and committed messaging-tool delivery metadata. */
export function collectDeliveredMediaUrls(result: AgentDeliveryEvidence): string[] {
  const urls = new Set<string>();
  if (Array.isArray(result.payloads)) {
    for (const payload of result.payloads) {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        collectMediaUrlsFromRecord(payload as Record<string, unknown>, urls);
      }
    }
  }
  for (const url of collectMessagingToolDeliveredMediaUrls(result)) {
    urls.add(url);
  }
  return Array.from(urls);
}

/** Collects media URLs recorded by messaging-tool sends and their target attachments. */
export function collectMessagingToolDeliveredMediaUrls(
  result: Pick<AgentDeliveryEvidence, "messagingToolSentMediaUrls" | "messagingToolSentTargets">,
): string[] {
  const urls = new Set<string>();
  collectStringValues(result.messagingToolSentMediaUrls, urls);
  if (Array.isArray(result.messagingToolSentTargets)) {
    for (const target of result.messagingToolSentTargets) {
      if (target && typeof target === "object" && !Array.isArray(target)) {
        collectMediaUrlsFromRecord(target as Record<string, unknown>, urls);
      }
    }
  }
  return Array.from(urls);
}

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Extracts a gateway result payload when the response carries delivery evidence fields. */
export function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const candidate = hasAgentDeliveryEvidenceShape(response)
    ? response
    : (response as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object" || !hasAgentDeliveryEvidenceShape(candidate)) {
    return null;
  }
  return candidate as AgentDeliveryEvidence;
}

function hasAgentDeliveryEvidenceShape(value: object): boolean {
  return (
    "payloads" in value ||
    "deliveryStatus" in value ||
    "didSendViaMessagingTool" in value ||
    "messagingToolSentTexts" in value ||
    "messagingToolSentMediaUrls" in value ||
    "messagingToolSentTargets" in value ||
    "acceptedSessionSpawns" in value ||
    "successfulCronAdds" in value ||
    "meta" in value
  );
}

/** Returns whether payload metadata contains visible text, media, presentation, or channel data. */
export function hasVisibleAgentPayload(
  result: Pick<AgentDeliveryEvidence, "payloads">,
  options: { includeErrorPayloads?: boolean; includeReasoningPayloads?: boolean } = {},
): boolean {
  const payloads = result.payloads;
  if (!Array.isArray(payloads)) {
    return false;
  }
  return payloads.some((payload) => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const record = payload as AgentPayloadLike;
    if (options.includeErrorPayloads === false && record.isError === true) {
      return false;
    }
    if (options.includeReasoningPayloads === false && record.isReasoning === true) {
      return false;
    }
    return Boolean(
      hasNonEmptyString(record.text) ||
      hasNonEmptyString(record.mediaUrl) ||
      hasNonEmptyStringArray(record.mediaUrls) ||
      record.presentation ||
      record.interactive ||
      record.channelData,
    );
  });
}

/** Returns whether the messaging tool attempted or committed an outbound delivery. */
export function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    result.didSendViaMessagingTool === true || hasCommittedMessagingToolDeliveryEvidence(result)
  );
}

/** Returns whether messaging-tool metadata proves committed text, media, or target delivery. */
export function hasCommittedMessagingToolDeliveryEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets"
  >,
): boolean {
  return (
    hasNonEmptyStringArray(result.messagingToolSentTexts) ||
    hasNonEmptyStringArray(result.messagingToolSentMediaUrls) ||
    hasNonEmptyArray(result.messagingToolSentTargets)
  );
}

/** Returns whether any outbound side effect makes a retry unsafe. */
export function hasOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasMessagingToolDeliveryEvidence(result) ||
    (Array.isArray(result.acceptedSessionSpawns) &&
      hasAcceptedSessionSpawn(result.acceptedSessionSpawns)) ||
    hasPositiveNumber(result.successfulCronAdds) ||
    hasPositiveNumber(result.meta?.toolSummary?.calls)
  );
}

/** Formats an agent-command delivery failure message from delivery status metadata. */
export function getAgentCommandDeliveryFailure(result: AgentDeliveryEvidence): string | undefined {
  const status = result.deliveryStatus?.status;
  if (status !== "failed" && status !== "partial_failed") {
    return undefined;
  }
  const message = result.deliveryStatus?.errorMessage;
  if (hasNonEmptyString(message)) {
    return message;
  }
  return status === "partial_failed" ? "agent delivery partially failed" : "agent delivery failed";
}
