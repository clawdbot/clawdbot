import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { boundedCronCompletionRetention } from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

describe("queued payload send-unit identity accounting", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it.each(["text", "formatted text", "media", "formatted media", "media text fallback"])(
    "keeps custody when a %s payload loses its second send identity",
    async (kind) => {
      const accepted: string[] = [];
      const send = async (text: string, dispatch?: () => Promise<void>) => {
        await dispatch?.();
        accepted.push(text);
        return { channel: "matrix" as const, messageId: accepted.length === 1 ? "confirmed" : "" };
      };
      const outbound: ChannelOutboundAdapter = {
        deliveryMode: "direct",
        textChunkLimit: 6,
        chunker: (text) => text.split(" "),
        sendText: ({ text, onPlatformSendDispatch }) => send(text, onPlatformSendDispatch),
        ...(kind === "formatted text"
          ? {
              sendFormattedText: async ({ text, onPlatformSendDispatch }) => {
                const results = [];
                for (const chunk of text.split(" ")) {
                  results.push(await send(chunk, onPlatformSendDispatch));
                }
                return results;
              },
            }
          : {}),
        ...(kind === "media" || kind === "formatted media"
          ? {
              sendMedia: ({ mediaUrl, onPlatformSendDispatch }) =>
                send(mediaUrl!, onPlatformSendDispatch),
            }
          : {}),
        ...(kind === "formatted media"
          ? {
              sendFormattedMedia: ({ mediaUrl, onPlatformSendDispatch }) =>
                send(mediaUrl!, onPlatformSendDispatch),
            }
          : {}),
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({ id: "matrix", outbound }),
          },
        ]),
      );
      const mediaUrls = ["https://example.com/first.png", "https://example.com/second.png"];
      const deliveryIntentId = "cron-direct-delivery:v1:mixed-unit-identity";
      const onDeliveredPayload = vi.fn();
      const onMessageSentEvent = vi.fn();
      const params = {
        cfg: {},
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "first second", ...(kind.includes("media") ? { mediaUrls } : {}) }],
        durability: "required" as const,
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
        onDeliveredPayload,
        onMessageSentEvent,
      };

      const result = await sendDurableMessageBatchCore(params);

      expect(accepted).toEqual(
        kind === "media" || kind === "formatted media" ? mediaUrls : ["first", "second"],
      );
      expect(result).toMatchObject({
        status: "partial_failed",
        results: [{ messageId: "confirmed" }],
        payloadOutcomes: [
          { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
        ],
      });
      expect(onDeliveredPayload).not.toHaveBeenCalled();
      expect(onMessageSentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
        0,
      );
      expect((await loadPendingDeliveries(fixtures.tmpDir()))[0]).toMatchObject({
        id: deliveryIntentId,
        recoveryState: "unknown_after_send",
      });
      expect(
        getDeliveryQueueEntryStatus(
          OUTBOUND_DELIVERY_QUEUE_NAME,
          deliveryIntentId,
          fixtures.tmpDir(),
        ),
      ).toBe("pending");

      await sendDurableMessageBatchCore(params);
      expect(accepted).toHaveLength(2);
    },
  );
});
