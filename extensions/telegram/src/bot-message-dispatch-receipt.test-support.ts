type LegacyTelegramTestDispatchResult = {
  queuedFinal?: boolean;
  counts?: Partial<Record<"tool" | "block" | "final", number>>;
  settledReceipt?: unknown;
} & Record<string, unknown>;

export function withTelegramTestSettledReceipt(result: unknown): LegacyTelegramTestDispatchResult {
  const dispatchResult = result as LegacyTelegramTestDispatchResult;
  if (dispatchResult.settledReceipt) {
    return dispatchResult;
  }
  const delivered = (kind: "tool" | "block" | "final") => ({
    delivered:
      dispatchResult.counts?.[kind] ?? (kind === "final" && dispatchResult.queuedFinal ? 1 : 0),
    deliveredNotVisible: 0,
    cancelled: 0,
    failedBeforeSend: 0,
    failedAfterSend: 0,
  });
  const counts = {
    tool: delivered("tool"),
    block: delivered("block"),
    final: delivered("final"),
  };
  return {
    ...dispatchResult,
    settledReceipt: {
      counts,
      anyVisibleDelivered: Object.values(counts).some((entry) => entry.delivered > 0),
    },
  };
}
