import { beforeEach, describe, expect, it, vi } from "vitest";
import { stageAndEnqueueOutboundDelivery } from "./deliver-queue-admission.js";
import type { StableDeliveryPreparation } from "./delivery-queue-preparation.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

const mocks = vi.hoisted(() => ({
  cancelDeliveryQueueMediaRetention: vi.fn(),
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
  cancelDeliveryQueueMediaRetention: mocks.cancelDeliveryQueueMediaRetention,
}));
vi.mock("./delivery-queue-storage.js", () => ({
  enqueueDelivery: mocks.enqueueDelivery,
  enqueueDeliveryOnce: mocks.enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce: mocks.enqueuePreparedDeliveryOnce,
  loadPendingDelivery: mocks.loadPendingDelivery,
}));

function preparation(id: string, preparationLeaseExpiresAt: number): StableDeliveryPreparation {
  return {
    id,
    enqueuedAt: 1,
    retryCount: 0,
    attemptCount: 0,
    preparationState: "prepared",
    preparationOwnerId: "owner-1",
    preparationLeaseExpiresAt,
  };
}

describe("stageAndEnqueueOutboundDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPendingDelivery.mockResolvedValue(null);
  });

  it("reads the stable preparation after asynchronous media staging", async () => {
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
    let current = preparation("stable-1", 100);
    const getStablePreparation = vi.fn(() => current);
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
      { getStablePreparation },
    );

    await vi.waitFor(() => expect(mocks.stageQueuePayloadMedia).toHaveBeenCalledOnce());
    expect(getStablePreparation).not.toHaveBeenCalled();
    current = preparation("stable-1", 200);
    finishStaging?.();

    await expect(pending).resolves.toEqual({ id: "stable-1", created: true });
    expect(getStablePreparation).toHaveBeenCalledOnce();
    expect(mocks.enqueuePreparedDeliveryOnce).toHaveBeenCalledWith(
      expect.any(Object),
      "stable-1",
      current,
      undefined,
      undefined,
    );
  });
});
