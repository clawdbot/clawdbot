import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  isOutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("queued delivery dispatch evidence", () => {
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

  const attemptSend = async (params: {
    sendMatrix: ReturnType<typeof vi.fn>;
    onPlatformSendDispatch?: () => Promise<void>;
    onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => void;
  }) =>
    deliverOutboundPayloads({
      cfg: {} as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }],
      deps: { matrix: params.sendMatrix },
      queuePolicy: "required",
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onPayloadDeliveryOutcome: params.onPayloadDeliveryOutcome,
    }).catch((caught: unknown) => caught);

  it("retains retryable custody when an adapter fails before dispatch", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn();
    const onPayloadDeliveryOutcome = vi.fn();
    const failure = await attemptSend({
      sendMatrix,
      onPlatformSendDispatch: async () => {
        throw new Error("dispatch preparation failed");
      },
      onPayloadDeliveryOutcome,
    });

    expect(failure).toMatchObject({ message: "dispatch preparation failed" });
    expect(isOutboundDeliveryError(failure) && failure.recoveryOwnedRetry).not.toBe(true);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "send_attempt_started",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", sentBeforeError: false }),
    );
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("reports an ambiguous payload when an adapter fails after dispatch", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));
    const onPayloadDeliveryOutcome = vi.fn();
    const failure = await attemptSend({ sendMatrix, onPayloadDeliveryOutcome });

    expect(failure).toMatchObject({ message: "first payload send failed", sentBeforeError: true });
    expect(isOutboundDeliveryError(failure) && failure.recoveryOwnedRetry).not.toBe(true);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", sentBeforeError: true }),
    );
  });

  it("preserves dispatch evidence for an all-failed best-effort batch", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("provider result was lost"));
    const onPayloadDeliveryOutcome = vi.fn();

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        bestEffort: true,
        queuePolicy: "best_effort",
        onPayloadDeliveryOutcome,
      }),
    ).resolves.toEqual([]);

    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", sentBeforeError: true }),
    );
  });

  it("preserves an earlier receipt when a later payload is proven not sent", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const notDispatched = new PlatformMessageNotDispatchedError("second payload never dispatched", {
      cause: new Error("connect ECONNREFUSED"),
    });
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "first-message" })
      .mockRejectedValueOnce(notDispatched);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("second payload never dispatched");

    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
  });
});
