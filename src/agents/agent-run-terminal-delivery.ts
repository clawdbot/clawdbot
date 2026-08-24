export type AgentRunTerminalDeliverySnapshot = {
  status: "sent" | "suppressed" | "partial_failed" | "failed";
  resultCount: number;
};

/** Rejects malformed lifecycle/RPC input and projects only the bounded delivery fact. */
export function normalizeAgentRunTerminalDeliverySnapshot(
  value: unknown,
): AgentRunTerminalDeliverySnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const delivery = value as { status?: unknown; resultCount?: unknown };
  if (
    typeof delivery.resultCount !== "number" ||
    !Number.isSafeInteger(delivery.resultCount) ||
    delivery.resultCount < 0
  ) {
    return undefined;
  }
  switch (delivery.status) {
    case "sent":
    case "suppressed":
    case "partial_failed":
    case "failed":
      return { status: delivery.status, resultCount: delivery.resultCount };
    default:
      return undefined;
  }
}
