import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { collectEntrySpoolPaths, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  claimDeliveryPlatformSendAttempt,
  loadPendingDeliveries,
  reserveDeliveryAttempt,
  enqueueDeliveryOnce,
} from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

function createPartialSendFailure() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1" })
    .mockRejectedValueOnce(new Error("second payload send failed"));
}

async function deliverPartialMatrixBatch(sendMatrix: ReturnType<typeof vi.fn>, tmpDir: string) {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await expect(
    deliverOutboundPayloads({
      cfg: {} as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    }),
  ).rejects.toThrow("second payload send failed");
}

describe("deliverOutboundPayloads queue integration: mid-batch failure with send evidence", () => {
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

  it("never lets restart recovery send a stable intent claimed by a live producer", async () => {
    const deliveryIntentId = "cron-direct-delivery:v1:recovery-live-producer";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "live producer owns this send" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
        maxRetries: 1,
      },
      deliveryIntentId,
      tmpDir,
    );
    const producerClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
    expect(producerClaimId).toEqual(expect.any(String));
    if (!producerClaimId) {
      throw new Error("test invariant: active producer must own its bounded delivery");
    }
    await reserveDeliveryAttempt(deliveryIntentId, 1, tmpDir, producerClaimId);

    const deliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "producer_claimed",
      producerClaimId,
      attemptCount: 1,
    });
  });

  it("never lets startup or reconnect impersonate a permanent live producer", async () => {
    const deliveryIntentId = "permanent-matrix-active-producer";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "the original permanent producer owns this send" }],
        queuePolicy: "required",
        completionRetention: "permanent",
        requiresProducerClaim: true,
        maxRetries: 1,
      },
      deliveryIntentId,
      tmpDir,
    );
    const producerClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
    if (!producerClaimId) {
      throw new Error("test invariant: permanent live producer must claim the stable row");
    }
    await reserveDeliveryAttempt(deliveryIntentId, 1, tmpDir, producerClaimId);
    const deliver = vi.fn<DeliverFn>(async () => []);

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    await recoverPendingDeliveries({
      cfg: {} as OpenClawConfig,
      deliver,
      log: createRecoveryLog(),
      stateDir: tmpDir,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "producer_claimed",
      producerClaimId,
      attemptCount: 1,
    });
  });

  it("claims pristine reusable permanent Matrix intents before recovery provider I/O", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "permanent-matrix-pristine-fenced-recovery";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "send the pristine permanent intent exactly once" }],
        queuePolicy: "required",
        completionRetention: "permanent",
        requiresProducerClaim: true,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi.fn().mockResolvedValue({
      messageId: "pristine-permanent-matrix-message",
    });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryQueueId: deliveryIntentId,
        deliveryProducerClaimId: expect.any(String),
      }),
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it("retains permanent receipts when stable delivery is intentionally suppressed", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn();
    const liveIntentId = "permanent-matrix-suppressed-live";

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: liveIntentId,
        completionRetention: "permanent",
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toEqual([]);
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, liveIntentId, tmpDir)).toBe(
      "completed",
    );

    const recoveryIntentId = "permanent-matrix-suppressed-recovery";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "" }],
        queuePolicy: "required",
        completionRetention: "permanent",
      },
      recoveryIntentId,
      tmpDir,
    );
    await drainMatrixReconnect({ deliver: vi.fn<DeliverFn>(async () => []), stateDir: tmpDir });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, recoveryIntentId, tmpDir),
    ).toBe("completed");
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("fences recovered stable intents at the real Matrix provider boundary", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:fenced-matrix-recovery";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "recover exactly once" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "fenced-recovered-message" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryQueueId: deliveryIntentId,
        deliveryProducerClaimId: expect.any(String),
      }),
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it.each([
    [
      "bounded",
      "cron-direct-delivery:v1:recovered-matrix-no-identity",
      boundedCronCompletionRetention,
      false,
    ],
    ["permanent", "permanent-recovered-matrix-no-identity", "permanent" as const, true],
  ])(
    "never completes %s recovered Matrix sends without a platform identity",
    async (_retention, deliveryIntentId, completionRetention, requiresProducerClaim) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      await enqueueDeliveryOnce(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "recovery must not assume a platform send succeeded" }],
          queuePolicy: "required",
          completionRetention,
          ...(requiresProducerClaim ? { requiresProducerClaim: true } : {}),
        },
        deliveryIntentId,
        tmpDir,
      );
      const sendMatrix = vi.fn().mockResolvedValue({});
      const deliver = vi.fn<DeliverFn>(async (params) =>
        deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
      );

      await drainMatrixReconnect({ deliver, stateDir: tmpDir });

      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
        id: deliveryIntentId,
        recoveryState: "unknown_after_send",
        retryCount: 1,
      });

      await drainMatrixReconnect({ deliver, stateDir: tmpDir });
      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).not.toBe("completed");
    },
  );

  it("never completes recovered Matrix batches when any platform send lacks an identity", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:recovered-matrix-partial-no-identity";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "confirmed recipient message" }, { text: "ambiguous message" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "confirmed-recovered-message" })
      .mockResolvedValueOnce({});
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({ ...params, deps: { matrix: sendMatrix } }),
    );

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).not.toBe("completed");
  });

  it("replays the immutable queue-owned payload instead of regenerated producer input", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:immutable-queue-custody";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "original queue-owned content" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "immutable-recovered-message" });

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "regenerated replay must never reach the recipient" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toMatchObject([{ messageId: "immutable-recovered-message" }]);

    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(sendMatrix.mock.calls[0]?.[1]).toBe("original queue-owned content");
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it("reuses durable Matrix media after regenerated producer files disappear", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:immutable-staged-matrix-media";
    const originalSource = path.join(tmpDir, "original-stable-media.ogg");
    const originalBytes = "original durable Matrix attachment";
    await fs.writeFile(originalSource, originalBytes);
    const staged = await stageQueuePayloadMedia({
      payloads: [{ text: "original queue-owned caption", mediaUrl: originalSource }],
      mediaAccess: { localRoots: [tmpDir] },
      maxBytes: 1024 * 1024,
      stateDir: tmpDir,
    });
    if (staged.status !== "staged") {
      throw new Error("test invariant: original producer media must be durably staged");
    }
    const spoolPath = staged.artifacts[0];
    if (!spoolPath) {
      throw new Error("test invariant: original media must have a queue-owned spool artifact");
    }
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: staged.payloads,
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
      },
      deliveryIntentId,
      tmpDir,
      staged.mediaStageId,
    );
    const pending = (await loadPendingDeliveries(tmpDir))[0];
    expect(
      collectEntrySpoolPaths(
        pending
          ? acceptedPreparedOutboundEntries(pending.preparedBatch).map((entry) => entry.payload)
          : [],
        tmpDir,
      ),
    ).toEqual([spoolPath]);
    await fs.rm(originalSource);

    let deliveredBytes: string | undefined;
    const sendMatrix = vi.fn(
      async (_to: string, _text: string, options?: Record<string, unknown>) => {
        if (typeof options?.mediaUrl !== "string") {
          throw new Error("test invariant: Matrix must receive the original staged attachment");
        }
        deliveredBytes = await fs.readFile(options.mediaUrl, "utf8");
        return { messageId: "immutable-staged-matrix-message" };
      },
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [
          {
            text: "regenerated caption must never replace queue custody",
            mediaUrl: path.join(tmpDir, "missing-regenerated-producer-media.ogg"),
          },
        ],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      }),
    ).resolves.toMatchObject([{ messageId: "immutable-staged-matrix-message" }]);

    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledWith(
      "!room:example",
      "original queue-owned caption",
      expect.objectContaining({ mediaUrl: spoolPath }),
    );
    expect(deliveredBytes).toBe(originalBytes);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    await expect(fs.stat(spoolPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a completed stable delivery receipt across producer replays", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "stable-message" });
    const deliveryIntentId = "cron-direct-delivery:v1:stable-completion";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "send once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "stable-message" },
    ]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("retains a completed stable receipt after fully successful best-effort delivery", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "stable-best-effort-message" });
    const deliveryIntentId = "cron-direct-delivery:v1:best-effort-stable-completion";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "best-effort send once" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
      queuePolicy: "best_effort" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "stable-best-effort-message" },
    ]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("holds one live claim while concurrent producers reuse a stable pending intent", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    let resolveSend!: (value: { messageId: string }) => void;
    let notifySendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      notifySendStarted = resolve;
    });
    const sendMatrix = vi.fn(
      () =>
        new Promise<{ messageId: string }>((resolve) => {
          resolveSend = resolve;
          notifySendStarted();
        }),
    );
    const deliveryIntentId = "cron-direct-delivery:v1:concurrent-stable-completion";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "send exactly once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    const first = deliverOutboundPayloads(params);
    await sendStarted;
    const recoveryDeliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver: recoveryDeliver, stateDir: tmpDir });
    expect(recoveryDeliver).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalledOnce();
    const concurrentReplay = deliverOutboundPayloads(params);
    expect(sendMatrix).toHaveBeenCalledOnce();
    resolveSend({ messageId: "concurrent-stable-message" });
    await expect(first).resolves.toMatchObject([{ messageId: "concurrent-stable-message" }]);
    await expect(concurrentReplay).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
  });

  it("never acknowledges or replays a partially sent best-effort stable intent", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "best-effort-first-message" })
      .mockRejectedValueOnce(new Error("best-effort second payload failed"));
    const onError = vi.fn();
    const deliveryIntentId = "cron-direct-delivery:v1:best-effort-partial-send";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "sent first" }, { text: "failed second" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
      queuePolicy: "best_effort" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
      onError,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "best-effort-first-message" },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
    });
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("never acknowledges a platform send that returns no message identity", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockResolvedValue({});
    const deliveryIntentId = "cron-direct-delivery:v1:no-platform-identity";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "provider returned no message identity" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
    });
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("never completes live Matrix batches when any platform send lacks an identity", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "confirmed-live-message" })
      .mockResolvedValueOnce({});
    const deliveryIntentId = "cron-direct-delivery:v1:live-matrix-partial-no-identity";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "confirmed recipient message" }, { text: "ambiguous message" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "platform send returned no delivery identity for part of the delivery batch",
    );
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("pending");

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).not.toBe("completed");
  });

  it.each(["abort", "permanent rejection"] as const)(
    "never creates a successful stable receipt after platform %s",
    async (failureKind) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const cause =
        failureKind === "abort"
          ? Object.assign(new Error("stable delivery aborted"), { name: "AbortError" })
          : new PlatformMessageNotDispatchedError("stable payload permanently rejected", {
              cause: new Error("invalid payload"),
              retryable: false,
            });
      const sendMatrix = vi.fn().mockRejectedValue(cause);
      const deliveryIntentId = `cron-direct-delivery:v1:${failureKind.replaceAll(" ", "-")}-no-receipt`;

      await expect(
        deliverOutboundPayloads({
          cfg: {} as OpenClawConfig,
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "never falsely report this recipient delivery" }],
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          deliveryIntentId,
          completionRetention: boundedCronCompletionRetention,
          reusePendingDeliveryIntent: true,
        }),
      ).rejects.toThrow(cause.message);

      expect(sendMatrix).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).not.toBe("completed");
    },
  );

  it("preserves queue custody when a provider timeout looks like an abort", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const timeout = new DOMException("Matrix request timed out", "AbortError");
    const sendMatrix = vi.fn().mockRejectedValue(timeout);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "preserve this delivery until reconciliation" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow(timeout.message);

    expect(sendMatrix).toHaveBeenCalledOnce();
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
  });

  it("removes an unsent queue intent when the caller cancels after publication", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const controller = new AbortController();
    const sendMatrix = vi.fn();

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "cancel before provider dispatch" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        abortSignal: controller.signal,
        onDeliveryIntent: () =>
          controller.abort(new DOMException("Operator cancelled delivery", "AbortError")),
      }),
    ).rejects.toThrow("Operation aborted");

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it.each(["abort", "permanent rejection"] as const)(
    "preserves an already-sent Matrix payload when a later payload ends in %s",
    async (failureKind) => {
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const cause =
        failureKind === "abort"
          ? Object.assign(new Error("later stable delivery aborted"), { name: "AbortError" })
          : new PlatformMessageNotDispatchedError("later stable payload permanently rejected", {
              cause: new Error("invalid second payload"),
              retryable: false,
            });
      const sendMatrix = vi
        .fn()
        .mockResolvedValueOnce({ messageId: "already-visible-stable-message" })
        .mockRejectedValueOnce(cause);
      const deliveryIntentId = `cron-direct-delivery:v1:partial-${failureKind.replaceAll(" ", "-")}-no-replay`;
      const params = {
        cfg: {} as OpenClawConfig,
        channel: "matrix" as const,
        to: "!room:example",
        payloads: [{ text: "already visible" }, { text: "later terminal failure" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required" as const,
        deliveryIntentId,
        completionRetention: boundedCronCompletionRetention,
        reusePendingDeliveryIntent: true,
      };

      await expect(deliverOutboundPayloads(params)).rejects.toThrow(cause.message);
      expect(sendMatrix).toHaveBeenCalledTimes(2);
      expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
        id: deliveryIntentId,
        recoveryState: "unknown_after_send",
        retryCount: 1,
      });
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");

      await expect(deliverOutboundPayloads(params)).rejects.toThrow(
        `Stable delivery intent is already queued: ${deliveryIntentId}`,
      );
      expect(sendMatrix).toHaveBeenCalledTimes(2);
    },
  );

  it("retries a stable delivery intent only after a proven pre-dispatch failure", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "provider disconnected before dispatch",
      { cause: new Error("connect ECONNREFUSED") },
    );
    const sendMatrix = vi
      .fn()
      .mockRejectedValueOnce(notDispatchedError)
      .mockResolvedValueOnce({ messageId: "recovered-stable-message" });
    const deliveryIntentId = "cron-direct-delivery:v1:safe-retry";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "safe retry" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      "provider disconnected before dispatch",
    );
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      retryCount: 1,
    });
    expect((await loadPendingDeliveries(tmpDir))[0]?.recoveryState).toBeUndefined();
    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "recovered-stable-message" },
    ]);
    expect(
      getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
    ).toBe("completed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("never replays a stable intent after an ambiguous platform send", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValue(new Error("provider result was lost"));
    const deliveryIntentId = "cron-direct-delivery:v1:unknown-platform-outcome";
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "ambiguous send" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId,
      completionRetention: boundedCronCompletionRetention,
      reusePendingDeliveryIntent: true,
    };

    await expect(deliverOutboundPayloads(params)).rejects.toThrow("provider result was lost");
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "send_attempt_started",
    });
    await expect(deliverOutboundPayloads(params)).rejects.toThrow(
      `Stable delivery intent is already queued: ${deliveryIntentId}`,
    );
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("advances queued entry to unknown_after_send before a later payload fails", async () => {
    let sendCount = 0;
    let stateBeforeSecondSend: string | undefined;
    const sendMatrix = vi.fn(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return { messageId: "m1" };
      }
      stateBeforeSecondSend = (await loadPendingDeliveries(tmpDir))[0]?.recoveryState;
      throw new Error("second payload send failed");
    });

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);

    expect(stateBeforeSecondSend).toBe("unknown_after_send");
    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.recoveryState).toBe("unknown_after_send");
    expect(entry.retryCount).toBe(1);
    expect(entry.lastError).toContain("second payload send failed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("drain reports every payload unknown when an interrupted mixed batch cannot be reconciled", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);
    expect(auditEvents).toHaveLength(4);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");
    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(auditEvents).toHaveLength(6);
    expect(auditEvents.slice(-2).map((event) => event.sourceId)).toEqual([
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:0`,
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:1`,
    ]);
    expect(auditEvents.slice(-2).map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.slice(-2).map((event) => event.resultCount)).toEqual([0, 0]);
  });

  it("does not retain a pre-send suppression across an ambiguous crash boundary", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "NO_REPLY" }, { text: "visible" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ambiguous provider failure");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBe("send_attempt_started");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(auditEvents.map((event) => event.outcome)).toEqual([
      "queued",
      "queued",
      "platform_started",
      "unknown",
      "unknown",
    ]);
    expect(auditEvents.slice(-2).map((event) => event.resultCount)).toEqual([0, 0]);
  });

  it("retains retryable send-attempt state when an adapter fails before returning a result", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    const entries = await import("./delivery-queue-storage.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.retryCount).toBe(1);
    expect(entry.recoveryState).toBe("send_attempt_started");
    expect(entry.lastError).toContain("first payload send failed");
  });

  it("replays an entry after a proven pre-connect failure clears send evidence", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(connectError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ECONNREFUSED");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]).toMatchObject({
      retryCount: 1,
      lastError: expect.stringContaining("ECONNREFUSED"),
    });
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

    const recoverySendMatrix = vi
      .fn()
      .mockRejectedValueOnce(connectError)
      .mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    const afterRepeatedFailure = await loadPendingDeliveries(tmpDir);
    expect(afterRepeatedFailure).toHaveLength(1);
    expect(afterRepeatedFailure[0]?.retryCount).toBe(2);
    expect(afterRepeatedFailure[0]?.recoveryState).toBeUndefined();
    expect(afterRepeatedFailure[0]?.platformSendStartedAt).toBeUndefined();

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(recoverySendMatrix).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("replays an entry after the provider proves no platform message was dispatched", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "upload timed out before completion dispatch",
      { cause: new Error("request timed out") },
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(notDispatchedError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("upload timed out before completion dispatch");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

    const recoverySendMatrix = vi.fn().mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(recoverySendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });
});
