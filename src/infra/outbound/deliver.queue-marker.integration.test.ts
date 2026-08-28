import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus, updateDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { deliverOutboundPayloads } from "./deliver.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import * as queueStorage from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery ownership after intermediate marker failure", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let clock = Date.parse("2026-08-02T10:00:00.000Z");
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    { recovery: false, outcome: "identified" },
    { recovery: true, outcome: "identified" },
    { recovery: false, outcome: "identityless" },
    { recovery: true, outcome: "identityless" },
    { recovery: false, outcome: "rejected" },
    { recovery: true, outcome: "rejected" },
  ])(
    "keeps the lease until $outcome settlement (recovery=$recovery)",
    async ({ recovery, outcome }) => {
      vi.useFakeTimers();
      vi.setSystemTime((clock += 60_000));
      const secondEntered = createDeferred();
      const releaseSecond = createDeferred();
      const accepted: string[] = [];
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async ({ text, onPlatformSendDispatch }) => {
                  await onPlatformSendDispatch?.();
                  if (text === "second") {
                    secondEntered.resolve();
                    await releaseSecond.promise;
                    if (outcome === "rejected") {
                      throw new PlatformMessageNotDispatchedError("second send rejected", {
                        cause: undefined,
                      });
                    }
                  }
                  accepted.push(text);
                  return {
                    channel: "matrix",
                    messageId: text === "second" && outcome === "identityless" ? "" : text,
                  };
                },
              },
            }),
          },
        ]),
      );
      vi.spyOn(queueStorage, "markDeliveryPlatformOutcomeUnknown").mockRejectedValueOnce(
        new Error("marker unavailable"),
      );
      const id = "marker-failure-batch";
      const params = {
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        queuePolicy: "required" as const,
        bestEffort: true,
      };
      if (recovery) {
        await queueStorage.enqueueDeliveryOnce(
          { ...params, requiresProducerClaim: true },
          id,
          fixtures.tmpDir(),
        );
      }
      const sending = recovery
        ? drainMatrixReconnect({ stateDir: fixtures.tmpDir(), deliver: deliverOutboundPayloads })
        : deliverOutboundPayloads({ ...params, deliveryIntentId: id });
      // Install rejection handling before advancing the heartbeat.
      const settled = sending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          secondEntered.promise,
          settled.then(() => {
            throw new Error("batch settled before its second send");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(10_001);
        expect(readQueuedEntry(fixtures.tmpDir(), id).availableAt).toBeGreaterThan(Date.now());
        expect(readQueuedEntry(fixtures.tmpDir(), id).retryCount).toBe(0);
        releaseSecond.resolve();
        const result = await settled;
        if (outcome === "identified") {
          expect(result).not.toHaveProperty("error");
          expect(
            getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, fixtures.tmpDir()),
          ).toBeUndefined();
          expect(accepted).toEqual(["first", "second"]);
        } else {
          expect(readQueuedEntry(fixtures.tmpDir(), id)).toMatchObject({
            recoveryState: "unknown_after_send",
            retryCount: 1,
          });
          expect(accepted).toEqual(outcome === "identityless" ? ["first", "second"] : ["first"]);
        }
      } finally {
        releaseSecond.resolve();
        await settled;
      }
    },
  );

  it("rechecks claim ownership before another send after a marker failure", async () => {
    const accepted: string[] = [];
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text, onPlatformSendDispatch }) => {
                await onPlatformSendDispatch?.();
                accepted.push(text);
                return { channel: "matrix", messageId: text };
              },
            },
          }),
        },
      ]),
    );
    vi.spyOn(queueStorage, "markDeliveryPlatformOutcomeUnknown").mockImplementationOnce(
      async (id) => {
        updateDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, fixtures.tmpDir(), (entry) => ({
          ...entry,
          platformSendAttemptId: "replacement-owner",
        }));
        throw new Error("marker lost its owner");
      },
    );
    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        queuePolicy: "required",
        deliveryIntentId: "replaced-marker-owner",
      }),
    ).rejects.toMatchObject({ sentBeforeError: true });
    expect(accepted).toEqual(["first"]);
    expect(readQueuedEntry(fixtures.tmpDir(), "replaced-marker-owner")).toMatchObject({
      platformSendAttemptId: "replacement-owner",
      retryCount: 0,
    });
  });

  it("completes a receipt-only aggregate after several physical sends", async () => {
    const ids = ["first", "second"];
    const onDeliveredPayload = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ onDeliveryResult, onPlatformSendDispatch }) => {
                for (const messageId of ids) {
                  await onPlatformSendDispatch?.();
                  await onDeliveryResult?.({ channel: "matrix", messageId });
                }
                return {
                  channel: "matrix",
                  messageId: "",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: ids.map((messageId) => ({ messageId })),
                  }),
                };
              },
            },
          }),
        },
      ]),
    );
    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "two physical sends" }],
      queuePolicy: "required",
      deliveryIntentId: "aggregate-success",
      onDeliveredPayload,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.receipt?.platformMessageIds).toEqual(ids);
    expect(onDeliveredPayload).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_QUEUE_NAME,
        "aggregate-success",
        fixtures.tmpDir(),
      ),
    ).toBeUndefined();
  });
});
