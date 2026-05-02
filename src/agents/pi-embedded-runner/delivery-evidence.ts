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
  didSendViaMessagingTool?: unknown;
  messagingToolSentTexts?: unknown;
  messagingToolSentMediaUrls?: unknown;
  messagingToolSentTargets?: unknown;
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

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null {
  if (!response || typeof response !== "object" || !("result" in response)) {
    return null;
  }
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object") {
    return null;
  }
  return result as AgentDeliveryEvidence;
}

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

export function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    result.didSendViaMessagingTool === true || hasCommittedMessagingToolDeliveryEvidence(result)
  );
}

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

export function hasOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasMessagingToolDeliveryEvidence(result) ||
    hasPositiveNumber(result.successfulCronAdds) ||
    hasPositiveNumber(result.meta?.toolSummary?.calls)
  );
}
