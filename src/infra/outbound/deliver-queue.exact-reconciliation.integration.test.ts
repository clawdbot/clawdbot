import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type {
  ChannelMessageSendMediaContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("exact Matrix delivery queue reconciliation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["required", "best_effort"] as const)(
    "settles one exact Matrix %s send without restart replay",
    async (queuePolicy) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const deliveryIntentId = `cron-direct-delivery:v1:exact-${queuePolicy}-completion`;
      const messageId = `exact-${queuePolicy}-message`;
      const reconcileUnknownSend = vi.fn();
      const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
        expect(ctx.deliveryQueueId).toBe(deliveryIntentId);
        await ctx.onPlatformSendDispatch?.();
        return {
          messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "matrix", messageId }],
            kind: "text",
          }),
        };
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
              message: {
                id: "matrix",
                durableFinal: {
                  capabilities: { text: true, reconcileUnknownSend: true },
                  reconcileUnknownSendKinds: { text: true },
                  reconcileUnknownSend,
                },
                send: { text: sendText },
              },
            },
          },
        ]),
      );
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "send exactly once with durable platform identity" }],
        queuePolicy,
        ...(queuePolicy === "best_effort" ? { bestEffort: true } : {}),
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
        requireUnknownSendReconciliation: true,
      };

      await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([{ messageId }]);
      expect(sendText).toHaveBeenCalledOnce();
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");

      const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
      await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
      expect(recoveryDeliver).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { reconciliation: "automatic", legacyAttachment: "matching" },
    { reconciliation: "automatic", legacyAttachment: "distinct" },
    { reconciliation: "explicit", legacyAttachment: "matching" },
    { reconciliation: "explicit", legacyAttachment: "distinct" },
  ] as const)(
    "delivers one attachment with $reconciliation reconciliation and a $legacyAttachment legacy URL",
    async ({ reconciliation, legacyAttachment }) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const mediaUrl = "https://example.invalid/image.png";
      const legacyMediaUrl =
        legacyAttachment === "distinct" ? "https://example.invalid/obsolete.png" : mediaUrl;
      const sendMedia = vi.fn(async (ctx: ChannelMessageSendMediaContext) => {
        await ctx.onPlatformSendDispatch?.();
        return {
          messageId: "media-1",
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "matrix", messageId: "media-1" }],
            kind: "media",
          }),
        };
      });

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
              message: {
                id: "matrix",
                durableFinal: {
                  ...(reconciliation === "automatic"
                    ? { automaticUnknownSendReconciliation: true }
                    : {}),
                  capabilities: { text: true, media: true, reconcileUnknownSend: true },
                  reconcileUnknownSendKinds: { media: true },
                  reconcileUnknownSend: async () => ({ status: "not_sent" as const }),
                },
                send: { text: vi.fn(), media: sendMedia },
              },
            },
          },
        ]),
      );

      await expect(
        deliverOutboundPayloads({
          cfg: {} as OpenClawConfig,
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "caption", mediaUrl: legacyMediaUrl, mediaUrls: [mediaUrl] }],
          queuePolicy: "required",
          ...(reconciliation === "explicit" ? { requireUnknownSendReconciliation: true } : {}),
        }),
      ).resolves.toMatchObject([{ messageId: "media-1" }]);

      expect(sendMedia).toHaveBeenCalledOnce();
      expect(sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediaUrl, deliveryPartIndex: 0, deliveryPartCount: 1 }),
      );
    },
  );
});
