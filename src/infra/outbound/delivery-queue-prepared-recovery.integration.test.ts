import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import type { DeliverFn } from "./delivery-queue.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;
let deliverOutboundPayloadsInternal: typeof import("./deliver.js").deliverOutboundPayloadsInternal;

describe("prepared outbound recovery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads, deliverOutboundPayloadsInternal } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  function installMatrixHook(params: {
    pluginId: string;
    handler: PluginHookHandlerMap["message_sending"];
  }) {
    const registry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    addTestHook({
      registry,
      pluginId: params.pluginId,
      hookName: "message_sending",
      handler: params.handler,
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
  }

  it("recovers the prepared rewrite without rerunning its modifying hook", async () => {
    const hook = vi.fn(async () => ({ content: "rewritten once" }));
    installMatrixHook({ pluginId: "rewrite-policy", handler: hook });
    const initialSend = vi.fn(async () => {
      throw new PlatformMessageNotDispatchedError("provider unavailable", {
        cause: new Error("provider unavailable"),
      });
    });
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "original" }],
        deps: { matrix: initialSend },
        queuePolicy: "required",
        deliveryIntentId: "stable-rewritten-recovery",
      }),
    ).rejects.toThrow("provider unavailable");
    const [pending] = await loadPendingDeliveries(tmpDir);
    expect(
      pending &&
        acceptedPreparedOutboundEntries(pending.preparedBatch).map((entry) => entry.payload),
    ).toEqual([{ text: "rewritten once" }]);

    const recoveredSend = vi.fn(async () => ({ messageId: "recovered-rewrite" }));
    const recover: DeliverFn = async (params) =>
      await deliverOutboundPayloadsInternal({
        ...params,
        deps: { matrix: recoveredSend },
      });
    await drainMatrixReconnect({ deliver: recover, stateDir: tmpDir });

    expect(hook).toHaveBeenCalledOnce();
    expect(initialSend).toHaveBeenCalledWith("!room:example", "rewritten once", expect.any(Object));
    expect(recoveredSend).toHaveBeenCalledWith(
      "!room:example",
      "rewritten once",
      expect.any(Object),
    );
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("retains stable cancellation without rerunning its modifying hook", async () => {
    const hook = vi.fn(async () => ({ cancel: true, cancelReason: "policy" }));
    installMatrixHook({ pluginId: "cancel-policy", handler: hook });
    const send = vi.fn();
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "blocked" }],
      deps: { matrix: send },
      queuePolicy: "required" as const,
      deliveryIntentId: "stable-cancelled-recovery",
    };

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "Stable delivery intent is already queued: stable-cancelled-recovery",
    );

    expect(hook).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(
      getDeliveryQueueEntryStatus(
        OUTBOUND_DELIVERY_INTENT_FENCE_QUEUE_NAME,
        params.deliveryIntentId,
        tmpDir,
      ),
    ).toBe("completed");
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });
});
