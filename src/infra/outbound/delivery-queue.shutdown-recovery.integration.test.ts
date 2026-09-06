import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("outbound recovery shutdown", () => {
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

  it("restores a reserved row when shutdown wins before provider dispatch", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const intentIds = ["lifecycle-fence-a", "lifecycle-fence-b"];
    for (const id of intentIds) {
      await enqueueDeliveryOnce(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: id }],
          queuePolicy: "required",
          completionRetention: boundedCronCompletionRetention,
          maxRetries: 2,
        },
        id,
        tmpDir,
      );
    }
    const secondBefore = (await loadPendingDeliveries(tmpDir)).find(
      (entry) => entry.id === intentIds[1],
    );
    let secondPrepared!: () => void;
    const secondPreparedPromise = new Promise<void>((resolve) => {
      secondPrepared = resolve;
    });
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "sent-before-stop" });
    const deliver = vi.fn<DeliverFn>(async (params) => {
      if (deliver.mock.calls.length === 2) {
        secondPrepared();
        await secondBlocked;
      }
      return deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } });
    });
    let shouldContinue = true;

    const drain = drainMatrixReconnect({
      deliver,
      stateDir: tmpDir,
      shouldContinue: () => shouldContinue,
    });
    await secondPreparedPromise;

    shouldContinue = false;
    releaseSecond();
    await drain;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      (await loadPendingDeliveries(tmpDir)).find((entry) => entry.id === intentIds[1]),
    ).toEqual(secondBefore);
  });
});
