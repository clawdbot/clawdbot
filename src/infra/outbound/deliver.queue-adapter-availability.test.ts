import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDeps } from "../../cli/deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { isProvenDeliveryNotSentError } from "../delivery-recovery.shared.js";
import { OutboundDeliveryError, PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  boundedCronCompletionRetention,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type RuntimeSender = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

describe("queued lazy outbound adapter availability", () => {
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

  it("retries adapter lookup failures without preserving false send evidence", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const emptyRegistry = createEmptyPluginRegistry();
    const outerRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test-outer",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
      },
    ]);
    const restoredRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "test-restored",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "matrix", messageId: "matrix-recovered" }),
          },
        }),
      },
    ]);
    setActivePluginRegistry(outerRegistry);
    const defaultDeps = createDefaultDeps() as Record<string, RuntimeSender>;
    const lazyRuntimeSender = expectDefined(defaultDeps.matrix, "matrix runtime sender");
    let scopedRuntimeRegistry: PluginRegistry = emptyRegistry;
    const deps = {
      matrix: (...args: Parameters<RuntimeSender>) =>
        withPluginRuntimeRegistryScope(scopedRuntimeRegistry, async () => {
          setActivePluginRegistry(emptyRegistry);
          return await lazyRuntimeSender(...args);
        }),
    };
    const deliveryIntentId = "cron-direct-delivery:v1:lazy-adapter-recovery";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "recover after adapter registration" }],
      deps,
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      maxRetries: 2,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "matrix outbound adapter is unavailable.",
    );
    const initialEntry = expectDefined(
      (await loadPendingDeliveries(tmpDir))[0],
      "initial queued delivery",
    );
    expect(initialEntry).toMatchObject({
      id: deliveryIntentId,
      retryCount: 1,
    });
    expect(initialEntry.recoveryState).toBeUndefined();
    expect(initialEntry.platformSendStartedAt).toBeUndefined();

    setQueuedEntryState(tmpDir, deliveryIntentId, {
      retryCount: initialEntry.retryCount,
      lastAttemptAt: 1,
      lastError: initialEntry.lastError,
    });
    scopedRuntimeRegistry = restoredRegistry;
    setActivePluginRegistry(outerRegistry);
    const recoveryDeliver = vi.fn<DeliverFn>(async (deliveryParams) =>
      deliverOutboundPayloads({ ...deliveryParams, deps }),
    );

    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver: recoveryDeliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(recoveryDeliver).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it("retains recovery custody when no outbound adapter can be resolved", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    setActivePluginRegistry(createEmptyPluginRegistry());
    const id = await enqueueDelivery(
      {
        channel: "missing-adapter-test",
        to: "recipient",
        payloads: [{ text: "retry after adapter resolution" }],
      },
      tmpDir,
    );
    let deliveryError: unknown;
    const recoveryDeliver = vi.fn<DeliverFn>(async (params) => {
      try {
        return await deliverOutboundPayloads(params);
      } catch (error) {
        deliveryError = error;
        throw error;
      }
    });

    const result = await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver: recoveryDeliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(result).toMatchObject({ failed: 1, recovered: 0, skippedMaxRetries: 0 });
    expect(recoveryDeliver).toHaveBeenCalledOnce();
    expect(deliveryError).toBeInstanceOf(OutboundDeliveryError);
    expect(deliveryError).toMatchObject({
      queueCustody: "held",
      cause: expect.any(PlatformMessageNotDispatchedError),
      sentBeforeError: false,
    });
    expect(isProvenDeliveryNotSentError(deliveryError)).toBe(true);
    const pendingEntry = expectDefined(
      (await loadPendingDeliveries(tmpDir))[0],
      "retained adapter-miss delivery",
    );
    expect(pendingEntry).toMatchObject({ id, retryCount: 1 });
    expect(pendingEntry.recoveryState).toBeUndefined();
    expect(pendingEntry.platformSendAttemptId).toBeUndefined();
    expect(pendingEntry.platformSendStartedAt).toBeUndefined();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir)).toBe("pending");
  });

  it("does not replay a provider call that already crossed the ambiguous send boundary", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test-ambiguous",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
    const sendMatrix = vi.fn().mockRejectedValue(new Error("provider result was lost"));
    const deliveryIntentId = "cron-direct-delivery:v1:ambiguous-adapter-result";

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "ambiguous send" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).rejects.toThrow("provider result was lost");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
    });

    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver: recoveryDeliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalledOnce();
  });
});
