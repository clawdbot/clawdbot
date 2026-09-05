import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  boundedCronCompletionRetention,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { claimDeliveryPlatformSendAttempt, enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

async function startBlockedFreshDelivery(params: { tmpDir: string }) {
  process.env.OPENCLAW_STATE_DIR = params.tmpDir;
  const preparationEntered = createDeferred();
  const releasePreparation = createDeferred();
  const queueIdReady = createDeferred<string>();
  const messageId = "fresh-live-message";
  const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    return {
      messageId,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId }],
        kind: "text",
      }),
    };
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
          message: {
            id: "matrix",
            durableFinal: { capabilities: { text: true } },
            send: {
              lifecycle: {
                beforeSendAttempt: async () => {
                  preparationEntered.resolve();
                  await releasePreparation.promise;
                },
              },
              text: sendText,
            },
          },
        },
      },
    ]),
  );
  const delivery = deliverOutboundPayloads({
    cfg: {} as OpenClawConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "fresh live content" }],
    queuePolicy: "best_effort",
    onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
  });
  const queueId = await queueIdReady.promise;
  await preparationEntered.promise;
  return { delivery, messageId, queueId, releasePreparation: releasePreparation.resolve, sendText };
}

async function startBlockedStableDelivery(params: {
  tmpDir: string;
  deliveryIntentId: string;
  requiresProducerClaim: boolean;
}) {
  process.env.OPENCLAW_STATE_DIR = params.tmpDir;
  const preparationEntered = createDeferred();
  const releasePreparation = createDeferred();
  const messageId = `${params.deliveryIntentId}-message`;
  const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    return {
      messageId,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId }],
        kind: "text",
      }),
    };
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
          message: {
            id: "matrix",
            durableFinal: { capabilities: { text: true } },
            send: {
              lifecycle: {
                beforeSendAttempt: async () => {
                  preparationEntered.resolve();
                  await releasePreparation.promise;
                },
              },
              text: sendText,
            },
          },
        },
      },
    ]),
  );
  await enqueueDeliveryOnce(
    {
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "queue-owned stable content" }],
      queuePolicy: "required",
      completionRetention: boundedCronCompletionRetention,
      ...(params.requiresProducerClaim ? { requiresProducerClaim: true } : {}),
    },
    params.deliveryIntentId,
    params.tmpDir,
  );
  const delivery = deliverOutboundPayloads({
    cfg: {} as OpenClawConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "regenerated content must not replace queue custody" }],
    queuePolicy: "required",
    deliveryIntentId: params.deliveryIntentId,
    completionRetention: boundedCronCompletionRetention,
    reusePendingDeliveryIntent: true,
  });
  await preparationEntered.promise;
  return { delivery, messageId, releasePreparation: releasePreparation.resolve, sendText };
}

async function startBlockedRenderedStableDelivery(params: {
  tmpDir: string;
  deliveryIntentId: string;
}) {
  process.env.OPENCLAW_STATE_DIR = params.tmpDir;
  const renderEntered = createDeferred();
  const releaseRender = createDeferred();
  const messageId = `${params.deliveryIntentId}-message`;
  const renderPresentation = vi.fn(async ({ payload }) => {
    renderEntered.resolve();
    await releaseRender.promise;
    return payload;
  });
  const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    return {
      messageId,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId }],
        kind: "text",
      }),
    };
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              ...matrixOutboundForQueueTest,
              presentationCapabilities: { supported: true },
              renderPresentation,
            },
          }),
          message: {
            id: "matrix",
            durableFinal: { capabilities: { text: true } },
            send: { text: sendText },
          },
        },
      },
    ]),
  );
  await enqueueDeliveryOnce(
    {
      channel: "matrix",
      to: "!room:example",
      payloads: [
        {
          text: "queue-owned stable content",
          presentation: { blocks: [{ type: "text", text: "rendered stable content" }] },
        },
      ],
      queuePolicy: "required",
      completionRetention: boundedCronCompletionRetention,
      requiresProducerClaim: true,
    },
    params.deliveryIntentId,
    params.tmpDir,
  );
  const delivery = deliverOutboundPayloads({
    cfg: {} as OpenClawConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "regenerated content must not replace queue custody" }],
    queuePolicy: "required",
    deliveryIntentId: params.deliveryIntentId,
    completionRetention: boundedCronCompletionRetention,
    reusePendingDeliveryIntent: true,
  });
  await renderEntered.promise;
  return { delivery, releaseRender: releaseRender.resolve, renderPresentation, sendText };
}

async function startBlockedProviderStableDelivery(params: {
  tmpDir: string;
  deliveryIntentId: string;
}) {
  process.env.OPENCLAW_STATE_DIR = params.tmpDir;
  const providerEntered = createDeferred();
  const releaseProvider = createDeferred();
  const messageId = `${params.deliveryIntentId}-message`;
  const onDeliveryResult = vi.fn();
  const sendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    providerEntered.resolve();
    await releaseProvider.promise;
    return {
      messageId,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId }],
        kind: "text",
      }),
    };
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
          message: {
            id: "matrix",
            durableFinal: { capabilities: { text: true } },
            send: { text: sendText },
          },
        },
      },
    ]),
  );
  await enqueueDeliveryOnce(
    {
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "queue-owned stable content" }],
      queuePolicy: "required",
      completionRetention: boundedCronCompletionRetention,
      requiresProducerClaim: true,
    },
    params.deliveryIntentId,
    params.tmpDir,
  );
  const delivery = deliverOutboundPayloads({
    cfg: {} as OpenClawConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "regenerated content must not replace queue custody" }],
    queuePolicy: "required",
    deliveryIntentId: params.deliveryIntentId,
    completionRetention: boundedCronCompletionRetention,
    reusePendingDeliveryIntent: true,
    onDeliveryResult,
  });
  await providerEntered.promise;
  return { delivery, onDeliveryResult, releaseProvider: releaseProvider.resolve, sendText };
}

describe("delivery producer lease integration", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.for([0, 38_000])(
    "retains fresh delivery ownership before provider I/O after a %ims scheduling stall",
    async (stallMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-02T23:00:00.000Z"));
      const tmpDir = fixtures.tmpDir();
      let blocked: Awaited<ReturnType<typeof startBlockedFreshDelivery>> | undefined;
      try {
        blocked = await startBlockedFreshDelivery({ tmpDir });
        // Advancing wall time without timers models a blocked Gateway: no
        // heartbeat can run before the delayed provider boundary resumes.
        vi.setSystemTime(Date.now() + stallMs);
        const entry = readQueuedEntry(tmpDir, blocked.queueId);

        expect(entry).toMatchObject({
          recoveryState: "producer_claimed",
          requiresProducerClaim: true,
          producerClaimId: expect.any(String),
          availableAt: expect.any(Number),
        });
        expect(entry.availableAt as number).toBeGreaterThan(Date.now());
        expect(await claimDeliveryPlatformSendAttempt(blocked.queueId, tmpDir)).toBeUndefined();

        blocked.releasePreparation();
        await expect(blocked.delivery).resolves.toMatchObject([{ messageId: blocked.messageId }]);
        expect(blocked.sendText).toHaveBeenCalledOnce();
        expect(
          getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, blocked.queueId, tmpDir),
        ).toBeUndefined();
      } finally {
        blocked?.releasePreparation();
        await blocked?.delivery.catch(() => undefined);
      }
    },
  );

  it("upgrades and renews a legacy reused intent through long channel preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:renew-long-channel-preparation";
    let blocked: Awaited<ReturnType<typeof startBlockedStableDelivery>> | undefined;
    try {
      blocked = await startBlockedStableDelivery({
        tmpDir,
        deliveryIntentId,
        requiresProducerClaim: false,
      });
      await vi.advanceTimersByTimeAsync(65_000);

      expect(await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir)).toBeUndefined();
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        requiresProducerClaim: true,
        availableAt: expect.any(Number),
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId).availableAt as number).toBeGreaterThan(
        Date.now(),
      );

      blocked.releasePreparation();
      await expect(blocked.delivery).resolves.toMatchObject([{ messageId: blocked.messageId }]);
      expect(blocked.sendText).toHaveBeenCalledOnce();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("completed");
    } finally {
      blocked?.releasePreparation();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("stops before provider I/O when the exact owner is replaced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:lose-owner-before-provider";
    let blocked: Awaited<ReturnType<typeof startBlockedStableDelivery>> | undefined;
    try {
      blocked = await startBlockedStableDelivery({
        tmpDir,
        deliveryIntentId,
        requiresProducerClaim: true,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId).toEqual(expect.any(String));
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        producerClaimId: "replacement-owner",
      });
      await vi.advanceTimersByTimeAsync(20_001);

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.releasePreparation();
      await rejected;

      expect(blocked.sendText).not.toHaveBeenCalled();
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId: "replacement-owner",
        retryCount: 0,
      });
    } finally {
      blocked?.releasePreparation();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("retains retryable custody when the owner expires before provider I/O", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:expire-owner-before-provider";
    let blocked: Awaited<ReturnType<typeof startBlockedStableDelivery>> | undefined;
    try {
      blocked = await startBlockedStableDelivery({
        tmpDir,
        deliveryIntentId,
        requiresProducerClaim: true,
      });
      const producerClaimId = readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId;
      expect(producerClaimId).toEqual(expect.any(String));
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        availableAt: Date.now() - 1,
      });
      await vi.advanceTimersByTimeAsync(20_001);

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.releasePreparation();
      await rejected;

      expect(blocked.sendText).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId,
        retryCount: 0,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).not.toHaveProperty("lastError");
      const replacementClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
      expect(replacementClaimId).toEqual(expect.any(String));
      expect(replacementClaimId).not.toBe(producerClaimId);
    } finally {
      blocked?.releasePreparation();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("preserves lease loss through presentation preparation before provider I/O", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:expire-owner-during-presentation";
    let blocked: Awaited<ReturnType<typeof startBlockedRenderedStableDelivery>> | undefined;
    try {
      blocked = await startBlockedRenderedStableDelivery({ tmpDir, deliveryIntentId });
      const producerClaimId = readQueuedEntry(tmpDir, deliveryIntentId).producerClaimId;
      expect(producerClaimId).toEqual(expect.any(String));
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        availableAt: Date.now() - 1,
      });
      await vi.advanceTimersByTimeAsync(20_001);

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.releaseRender();
      await rejected;

      expect(blocked.renderPresentation).toHaveBeenCalledOnce();
      expect(blocked.sendText).not.toHaveBeenCalled();
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId,
        retryCount: 0,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).not.toHaveProperty("lastError");
      const replacementClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
      expect(replacementClaimId).toEqual(expect.any(String));
      expect(replacementClaimId).not.toBe(producerClaimId);
    } finally {
      blocked?.releaseRender();
      await blocked?.delivery.catch(() => undefined);
    }
  });

  it("does not settle a queue row when the lease expires after provider dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    const tmpDir = fixtures.tmpDir();
    const deliveryIntentId = "cron-direct-delivery:v1:expire-owner-after-dispatch";
    const auditEvents: Array<{ outcome: string }> = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    let blocked: Awaited<ReturnType<typeof startBlockedProviderStableDelivery>> | undefined;
    try {
      blocked = await startBlockedProviderStableDelivery({ tmpDir, deliveryIntentId });
      const dispatched = readQueuedEntry(tmpDir, deliveryIntentId);
      const platformSendAttemptId = dispatched.platformSendAttemptId;
      expect(dispatched).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: expect.any(String),
        retryCount: 0,
      });
      setQueuedEntryState(tmpDir, deliveryIntentId, {
        retryCount: 0,
        recoveryState: "send_attempt_started",
        platformSendStartedAt: dispatched.platformSendStartedAt as number,
        availableAt: Date.now() - 1,
      });
      await vi.advanceTimersByTimeAsync(20_001);

      const rejected = expect(blocked.delivery).rejects.toThrow(
        `Delivery platform claim was lost: ${deliveryIntentId}`,
      );
      blocked.releaseProvider();
      await rejected;

      expect(blocked.sendText).toHaveBeenCalledOnce();
      expect(blocked.onDeliveryResult).not.toHaveBeenCalled();
      expect(auditEvents.map((event) => event.outcome)).toEqual(["queued", "platform_started"]);
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, deliveryIntentId, tmpDir),
      ).toBe("pending");
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId,
        retryCount: 0,
      });
      expect(readQueuedEntry(tmpDir, deliveryIntentId)).not.toHaveProperty("lastError");
    } finally {
      unsubscribe();
      blocked?.releaseProvider();
      await blocked?.delivery.catch(() => undefined);
    }
  });
});
