import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

const blockReplyCompletionRetention = {
  idPrefix: "block-reply:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

describe("deliverOutboundPayloads queue integration: block intent recovery", () => {
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

  it("recovers one pending block intent once and dedupes completed producer replays", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "block-reply:v1:codex-app-server:thread-1:turn-1:restart-dedupe";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "durable background update" }],
        queuePolicy: "required",
        completionRetention: blockReplyCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "recovered-block-message" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });
    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "regenerated duplicate" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: blockReplyCompletionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toEqual([]);

    expect(deliver).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });
});
