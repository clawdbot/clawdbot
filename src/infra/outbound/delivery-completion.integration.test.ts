import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  loadPendingDeliveries,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("pending-final durable delivery completion", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each([1, 2])(
    "settles %s identified payloads before suppressing a second stable caller",
    async (payloadCount) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const sessionKey = "agent:main:matrix:direct:123";
      const storePath = path.join(tmpDir, "sessions.json");
      const deliveryId = "pending-final-delivery-1";
      const completion = {
        kind: "pending-final" as const,
        deliveryId,
        intentId: "pending-final-intent-1",
        sessionId: "session-1",
        sessionKey,
        storePath,
      };
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "session-1",
          status: "running",
          updatedAt: Date.now(),
          pendingFinalDelivery: {
            kind: "replayable",
            text: "deliver once",
            createdAt: Date.now(),
            intentId: completion.intentId,
            deliveries: [{ id: deliveryId, state: "prepared" }],
          },
        },
      );
      const payloads = Array.from({ length: payloadCount }, (_, index) => ({
        text: `deliver ${index}`,
      }));
      const sendMatrix = vi.fn(async (_to: string, text: string) => ({
        messageId: `matrix-${text}`,
      }));
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads,
        deps: { matrix: sendMatrix },
        queuePolicy: "required" as const,
        deliveryIntentId: deliveryId,
        deliveryCompletion: completion,
      };

      await expect(deliverOutboundPayloads(params)).resolves.toMatchObject(
        payloads.map(({ text }) => ({ messageId: `matrix-${text}` })),
      );
      expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery?.deliveries).toEqual(
        [{ id: deliveryId, state: "delivered" }],
      );

      await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
      expect(sendMatrix).toHaveBeenCalledTimes(payloadCount);
      expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
    },
  );

  it.each([false, true])(
    "keeps an uncertainty notice owed after identity loss (confirmed prefix=%s)",
    async (confirmedPrefix) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const sessionKey = "agent:main:matrix:direct:unknown-live";
      const storePath = path.join(tmpDir, "sessions.json");
      const deliveryId = "pending-final-unknown-live";
      const completion = {
        kind: "pending-final" as const,
        deliveryId,
        intentId: "pending-final-intent-unknown-live",
        sessionId: "session-unknown-live",
        sessionKey,
        storePath,
      };
      const context = { channel: "matrix", to: "!room:example" };
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: completion.sessionId,
          status: "running",
          updatedAt: Date.now(),
          pendingFinalDelivery: {
            kind: "replayable",
            text: "delivery identity may have been lost",
            context,
            createdAt: Date.now(),
            intentId: completion.intentId,
            deliveries: [{ id: deliveryId, state: "prepared" }],
          },
        },
      );
      const sendMatrix = vi.fn().mockResolvedValue({ messageId: "" });
      if (confirmedPrefix) {
        sendMatrix.mockResolvedValueOnce({ messageId: "confirmed-prefix" });
      }
      const auditEvents: TrustedMessageAuditEvent[] = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));

      try {
        const sending = deliverOutboundPayloads({
          cfg: {} as OpenClawConfig,
          channel: "matrix",
          to: "!room:example",
          payloads: [
            ...(confirmedPrefix ? [{ text: "confirmed prefix" }] : []),
            { text: "delivery identity may have been lost" },
          ],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          deliveryIntentId: deliveryId,
          deliveryCompletion: completion,
        });
        if (confirmedPrefix) {
          await expect(sending).rejects.toThrow(
            "platform send returned no delivery identity for part of the delivery batch",
          );
        } else {
          await expect(sending).resolves.toEqual([]);
        }
      } finally {
        unsubscribe();
      }

      expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
        id: deliveryId,
        recoveryState: "unknown_after_send",
      });
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        pendingFinalDelivery: {
          deliveries: [{ id: deliveryId, state: "unknown" }],
        },
        pendingDeliveryNotice: {
          intentId: completion.intentId,
          state: "owed",
          context,
        },
      });
      expect(auditEvents.map((event) => event.outcome)).toEqual(
        confirmedPrefix
          ? ["queued", "queued", "platform_started", "platform_started"]
          : ["queued", "platform_started"],
      );
      expect(auditEvents).not.toContainEqual(
        expect.objectContaining({ action: "message.outbound.finished" }),
      );
    },
  );
});
