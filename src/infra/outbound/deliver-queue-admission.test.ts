import { beforeEach, describe, expect, it, vi } from "vitest";
import { stageAndEnqueueOutboundDelivery } from "./deliver-queue-admission.js";
import type { StableDeliveryIntentFence } from "./delivery-intent-fence.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const mocks = vi.hoisted(() => ({
  cancelDeliveryQueueMediaStage: vi.fn(),
  enqueueDelivery: vi.fn(),
  enqueueDeliveryOnce: vi.fn(),
  enqueuePreparedDeliveryOnce: vi.fn(),
  loadPendingDelivery: vi.fn(),
  releaseSpoolArtifacts: vi.fn(),
  stageQueuePayloadMedia: vi.fn(),
}));

vi.mock("./delivery-queue-media-spool.js", () => ({
  releaseSpoolArtifacts: mocks.releaseSpoolArtifacts,
  stageQueuePayloadMedia: mocks.stageQueuePayloadMedia,
}));
vi.mock("./delivery-queue-media-staging.js", () => ({
  cancelDeliveryQueueMediaStage: mocks.cancelDeliveryQueueMediaStage,
}));
vi.mock("./delivery-queue-storage.js", () => ({
  loadPendingDelivery: mocks.loadPendingDelivery,
}));
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
  enqueueDeliveryOnce: mocks.enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce: mocks.enqueuePreparedDeliveryOnce,
}));

function intentFence(id: string): StableDeliveryIntentFence {
  return {
    id,
    enqueuedAt: 1,
    retryCount: 0,
    attemptCount: 0,
  };
}

describe("stageAndEnqueueOutboundDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPendingDelivery.mockResolvedValue(null);
  });

  it("publishes the prepared batch from the stable intent fence after media staging", async () => {
    let finishStaging: (() => void) | undefined;
    mocks.stageQueuePayloadMedia.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishStaging = () =>
            resolve({
              status: "staged",
              payloads: [{ text: "prepared" }],
              artifacts: [],
            });
        }),
    );
    mocks.enqueuePreparedDeliveryOnce.mockResolvedValueOnce({
      id: "stable-1",
      created: true,
    });
    const fence = intentFence("stable-1");
    const payloads = [{ text: "prepared" }];

    const pending = stageAndEnqueueOutboundDelivery(
      {
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads,
        queuePolicy: "required",
        deliveryIntentId: "stable-1",
      },
      createUnmodifiedPreparedOutboundBatch(payloads),
      { intentFence: fence },
    );

    await vi.waitFor(() => expect(mocks.stageQueuePayloadMedia).toHaveBeenCalledOnce());
    finishStaging?.();

    await expect(pending).resolves.toEqual({ id: "stable-1", created: true });
    expect(mocks.enqueuePreparedDeliveryOnce).toHaveBeenCalledWith(
      expect.any(Object),
      "stable-1",
      fence,
      undefined,
      undefined,
    );
  });
});
