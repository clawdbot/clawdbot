// Exercise the shared Gateway mock wiring with real reply dispatchers.
import "./test-helpers.mocks.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { dispatchInboundMessageMock } from "./test-helpers.runtime-state.js";

const { dispatchInboundMessageWithProjectedDispatcher } = await import("../auto-reply/dispatch.js");

describe("Gateway projected-dispatch mock ownership", () => {
  afterEach(() => {
    dispatchInboundMessageMock.mockReset();
  });

  it.each(["fulfill", "reject"] as const)(
    "releases a no-reply reservation when mocked dispatches %s",
    async (outcome) => {
      const pendingBefore = getTotalPendingReplies();
      const result = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      const error = new Error("mocked dispatch failed");
      const deliver = vi.fn(async () => {});
      dispatchInboundMessageMock.mockImplementationOnce(async () => {
        if (outcome === "reject") {
          throw error;
        }
        return result;
      });

      const dispatch = dispatchInboundMessageWithProjectedDispatcher({
        ctx: { Body: "hello", Surface: "webchat" },
        cfg: {},
        dispatcherOptions: { deliver },
      });
      if (outcome === "reject") {
        await expect(dispatch).rejects.toBe(error);
      } else {
        await expect(dispatch).resolves.toBe(result);
      }
      expect(deliver).not.toHaveBeenCalled();
      expect(getTotalPendingReplies()).toBe(pendingBefore);
    },
  );

  it.each(["fulfill", "reject"] as const)(
    "drains queued delivery before mocked dispatches %s",
    async (outcome) => {
      const pendingBefore = getTotalPendingReplies();
      const deliveryStarted = createDeferred();
      const releaseDelivery = createDeferred();
      const deliverySettled = createDeferred();
      const result = { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      const error = new Error("mocked dispatch failed after enqueue");
      dispatchInboundMessageMock.mockImplementationOnce(async (params: unknown) => {
        const { dispatcher } = params as Parameters<typeof dispatchInboundMessage>[0];
        dispatcher.sendFinalReply({ text: "queued reply" });
        if (outcome === "reject") {
          throw error;
        }
        return result;
      });
      const dispatch = dispatchInboundMessageWithProjectedDispatcher({
        ctx: { Body: "hello", Surface: "webchat" },
        cfg: {},
        dispatcherOptions: {
          deliver: async () => {
            deliveryStarted.resolve();
            await releaseDelivery.promise;
          },
          onDeliverySettled: () => deliverySettled.resolve(),
        },
      });
      let dispatchSettled = false;
      const completion = Promise.allSettled([dispatch]).then((results) => {
        dispatchSettled = true;
        return results;
      });
      try {
        await deliveryStarted.promise;
        // Give a prematurely returned dispatch promise a turn to settle while delivery is held.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(dispatchSettled).toBe(false);
        expect(getTotalPendingReplies()).toBeGreaterThan(pendingBefore);
      } finally {
        releaseDelivery.resolve();
        await completion;
        await deliverySettled.promise;
      }
      expect(await completion).toEqual([
        outcome === "reject"
          ? { status: "rejected", reason: error }
          : { status: "fulfilled", value: result },
      ]);
      expect(getTotalPendingReplies()).toBe(pendingBefore);
    },
  );
});
