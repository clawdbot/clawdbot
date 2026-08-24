import { describe, expect, it } from "vitest";
import { buildUnknownSendContext } from "./delivery-queue-reconciliation.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

function entry(payload: { text: string; isStatusNotice?: boolean }) {
  const preparedBatch = createUnmodifiedPreparedOutboundBatch([payload]);
  preparedBatch.runId = "run-exact";
  preparedBatch.replyKind = "final";
  return {
    id: "queue-1",
    channel: "arxi",
    to: "owner",
    enqueuedAt: 1,
    retryCount: 1,
    preparedBatch,
  };
}

describe("unknown-send source correlation", () => {
  it("retains a useful final run across durable recovery", () => {
    const payload = { text: "useful answer" };
    expect(
      buildUnknownSendContext({ entry: entry(payload), payloads: [payload], cfg: {} }),
    ).toMatchObject({ sourceRunId: "run-exact" });
  });

  it("does not classify a status notice as a useful result", () => {
    const payload = { text: "working", isStatusNotice: true };
    expect(
      buildUnknownSendContext({ entry: entry(payload), payloads: [payload], cfg: {} }),
    ).not.toHaveProperty("sourceRunId");
  });
});
