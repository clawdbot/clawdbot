import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

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

  it("suppresses a second stable caller after the exact pending final was delivered", async () => {
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
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "matrix-message-1" });
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "deliver once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId: deliveryId,
      deliveryCompletion: completion,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "matrix-message-1" },
    ]);
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery?.deliveries).toEqual([
      { id: deliveryId, state: "delivered" },
    ]);

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it("keeps an uncertainty notice owed when a live send returns no delivery identity", async () => {
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
    const sendMatrix = vi.fn().mockResolvedValue({});

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "delivery identity may have been lost" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: deliveryId,
        deliveryCompletion: completion,
      }),
    ).resolves.toEqual([]);

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
  });
});
