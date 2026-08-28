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
import {
  loadPendingDeliveries,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

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

  it.each([
    { chunked: true, bestEffort: false },
    { chunked: true, bestEffort: true },
    { chunked: false, bestEffort: false },
    { chunked: false, bestEffort: true },
  ])(
    "keeps earlier identity loss when a later send is rejected ($chunked/$bestEffort)",
    async ({ chunked, bestEffort }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                ...matrixOutboundForQueueTest,
                ...(chunked
                  ? { chunker: (text: string) => text.split(" "), textChunkLimit: 6 }
                  : {}),
              },
            }),
          },
        ]),
      );
      const sendMatrix = vi
        .fn()
        .mockResolvedValueOnce({ messageId: "" })
        .mockRejectedValueOnce(
          new PlatformMessageNotDispatchedError("later unit rejected", { cause: undefined }),
        );
      const outcomes: OutboundPayloadDeliveryOutcome[] = [];
      try {
        await deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: chunked ? [{ text: "first second" }] : [{ text: "first" }, { text: "second" }],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          bestEffort,
          onPayloadDeliveryOutcome: (outcome) => outcomes.push(outcome),
        }).catch((error: unknown) => {
          expect(error).toMatchObject({ message: "later unit rejected" });
        });
        expect(sendMatrix.mock.calls.map((call) => call[1])).toEqual(["first", "second"]);
        expect(await loadPendingDeliveries(tmpDir)).toEqual([
          expect.objectContaining({ recoveryState: "unknown_after_send" }),
        ]);
        if (chunked) {
          expect(outcomes).toEqual([
            expect.objectContaining({ status: "failed", sentBeforeError: true }),
          ]);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
