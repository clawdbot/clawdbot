import { expect } from "vitest";
import { createReplyDispatchSettledCounts } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchReceipt,
  ReplyDispatchSettledCounts,
} from "../../auto-reply/reply/reply-dispatcher.types.js";

export function createReplyDispatchReceipt(
  outcomes: Partial<Record<ReplyDispatchKind, Partial<ReplyDispatchSettledCounts>>>,
): ReplyDispatchReceipt {
  const counts = (kind: ReplyDispatchKind): ReplyDispatchSettledCounts => ({
    ...createReplyDispatchSettledCounts(),
    ...outcomes[kind],
  });
  const receipt = { tool: counts("tool"), block: counts("block"), final: counts("final") };
  const anyVisibleDelivered = Object.values(receipt).some(
    (entry) => entry.delivered > 0 || entry.failedAfterSend > 0,
  );
  return { counts: receipt, anyVisibleDelivered };
}

export function expectNonVisibleFinalReceipt(result: unknown) {
  expect(result).toMatchObject({
    settledReceipt: {
      anyVisibleDelivered: false,
      counts: { final: { deliveredNotVisible: 1 } },
    },
  });
}
