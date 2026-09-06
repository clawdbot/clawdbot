import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type {
  ChannelMessageSendAttemptContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  boundedCronCompletionRetention,
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import {
  loadDeliveryQueueMediaRetentionSnapshot,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import {
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

function installHeldAdapter() {
  const prepared = createDeferred();
  const releasePreparation = createDeferred();
  const providerEntered = createDeferred();
  const releaseProvider = createDeferred();
  const releaseResource = vi.fn();
  const resource = { release: releaseResource };
  let failProvider = false;
  const send = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
    await ctx.onPlatformSendDispatch?.();
    providerEntered.resolve();
    await releaseProvider.promise;
    if (failProvider) {
      throw new Error("provider disconnected after dispatch");
    }
    return {
      messageId: "accepted-message",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId: "accepted-message" }],
        kind: "text",
      }),
    };
  });
  const afterSendFailure = vi.fn(({ attemptToken }: { attemptToken?: unknown }) => {
    if (attemptToken === resource) {
      releaseResource();
    }
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
            durableFinal: { capabilities: { text: true, media: true } },
            send: {
              lifecycle: {
                beforeSendAttempt: async (ctx: ChannelMessageSendAttemptContext) => {
                  prepared.resolve();
                  await releasePreparation.promise;
                  if (ctx.kind === "media") {
                    expect(fs.readFileSync(ctx.mediaUrl, "utf8")).toBe("retained attachment");
                  }
                  return resource;
                },
                afterSendFailure,
              },
              text: send,
              media: send,
            },
          },
        },
      },
    ]),
  );
  return {
    prepared: prepared.promise,
    releasePreparation: releasePreparation.resolve,
    providerEntered: providerEntered.promise,
    releaseProvider: releaseProvider.resolve,
    failProvider: () => {
      failProvider = true;
    },
    send,
    afterSendFailure,
    releaseResource,
  };
}

describe("queued cancellation during adapter preparation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["fresh", "restored media"] as const)(
    "retires %s custody before preparation settles and releases its late token once",
    async (mode) => {
      vi.useFakeTimers();
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const adapter = installHeldAdapter();
      const controller = new AbortController();
      const audit: string[] = [];
      const unsubscribe = onTrustedMessageAuditEvent((event) => audit.push(event.outcome));
      const queueIdReady = createDeferred<string>();
      const stableId = "cron-direct-delivery:v1:cancelled-preparation";
      let artifact: string | undefined;
      if (mode === "restored media") {
        const spoolDir = resolveDeliveryQueueMediaDir(stateDir);
        fs.mkdirSync(spoolDir, { recursive: true });
        artifact = path.join(spoolDir, `${randomUUID()}.txt`);
        fs.writeFileSync(artifact, "retained attachment");
        await enqueueDeliveryOnce(
          {
            channel: "matrix",
            to: "!room:example",
            payloads: [{ text: "question", mediaUrl: artifact }],
            completionRetention: boundedCronCompletionRetention,
          },
          stableId,
          stateDir,
        );
      }
      const delivery = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "question" }],
        queuePolicy: "required",
        abortSignal: controller.signal,
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
        ...(mode === "restored media"
          ? {
              deliveryIntentId: stableId,
              reusePendingDeliveryIntent: true,
              completionRetention: boundedCronCompletionRetention,
            }
          : {}),
      });
      const outcome = delivery.then(
        () => "sent",
        (error: unknown) => error,
      );
      try {
        const queueId = await queueIdReady.promise;
        await adapter.prepared;
        controller.abort(new Error("question ended"));

        expect(await loadPendingDeliveries(stateDir)).toEqual([]);
        expect(adapter.afterSendFailure).not.toHaveBeenCalled();
        expect(audit).toEqual(["queued", "failed"]);
        const recoveredSend = vi.fn(async () => []);
        await drainMatrixReconnect({ stateDir, deliver: recoveredSend });
        expect(recoveredSend).not.toHaveBeenCalled();
        if (artifact) {
          expect(fs.existsSync(artifact)).toBe(true);
          expect(
            loadDeliveryQueueMediaRetentionSnapshot({ expireBeforeMs: 0, stateDir })
              .stagedArtifacts,
          ).toEqual([artifact]);
          expect(
            getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir),
          ).toBeUndefined();
        }

        // The removed row must not turn its old producer heartbeat into claim loss.
        await vi.advanceTimersByTimeAsync(65_000);
        adapter.releasePreparation();
        expect(await outcome).toMatchObject({
          message: expect.stringContaining("Operation aborted"),
          queueCustody: "released",
        });
        expect(adapter.send).not.toHaveBeenCalled();
        expect(adapter.afterSendFailure).toHaveBeenCalledOnce();
        expect(adapter.releaseResource).toHaveBeenCalledOnce();
        expect(audit).toEqual(["queued", "failed"]);
        if (artifact) {
          expect(fs.existsSync(artifact)).toBe(false);
          expect(
            loadDeliveryQueueMediaRetentionSnapshot({ expireBeforeMs: 0, stateDir })
              .stagedArtifacts,
          ).toEqual([]);
        }
      } finally {
        controller.abort();
        adapter.releasePreparation();
        adapter.releaseProvider();
        await outcome;
        unsubscribe();
      }
    },
  );

  it("does not retire a replacement producer while old preparation is held", async () => {
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const adapter = installHeldAdapter();
    const controller = new AbortController();
    const queueIdReady = createDeferred<string>();
    const delivery = deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "question" }],
      queuePolicy: "required",
      abortSignal: controller.signal,
      onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
    });
    const outcome = delivery.catch((error: unknown) => error);
    try {
      const queueId = await queueIdReady.promise;
      await adapter.prepared;
      const replacementClaim = randomUUID();
      setQueuedEntryState(stateDir, queueId, {
        retryCount: 0,
        producerClaimId: replacementClaim,
        availableAt: Date.now() + 60_000,
      });
      controller.abort(new Error("old question ended"));
      expect(readQueuedEntry(stateDir, queueId).producerClaimId).toBe(replacementClaim);
      adapter.releasePreparation();
      expect(await outcome).toMatchObject({ queueCustody: "held" });
      expect(readQueuedEntry(stateDir, queueId).producerClaimId).toBe(replacementClaim);
      expect(adapter.send).not.toHaveBeenCalled();
      expect(adapter.releaseResource).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      adapter.releasePreparation();
      adapter.releaseProvider();
      await outcome;
    }
  });

  it.each(["send_attempt_started", "unknown_after_send"] as const)(
    "does not retire the same claim after durable state advances to %s",
    async (state) => {
      const { retireUnsentDelivery } = await import("./delivery-queue-ack.js");
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const initialProducerClaim = createInitialDeliveryProducerClaim();
      const id = await enqueueDelivery({
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "possibly delivered question" }],
        initialProducerClaim,
      });
      const producerClaimId = initialProducerClaim.producerClaimId;
      await markDeliveryPlatformSendAttemptStarted(id, stateDir, undefined, producerClaimId);
      if (state === "unknown_after_send") {
        await markDeliveryPlatformOutcomeUnknown(id, stateDir, producerClaimId);
      }

      expect(retireUnsentDelivery({ id, producerClaimId, stateDir })).toBeUndefined();
      expect(readQueuedEntry(stateDir, id).recoveryState).toBe(state);
    },
  );

  it("keeps failed retirement visible and settles custody once preparation finishes", async () => {
    const queueAck = await import("./delivery-queue-ack.js");
    vi.spyOn(queueAck, "retireUnsentDelivery").mockImplementationOnce(() => {
      throw new Error("state database write failed");
    });
    const stateDir = fixtures.tmpDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const adapter = installHeldAdapter();
    const controller = new AbortController();
    const audit: string[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => audit.push(event.outcome));
    const delivery = deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "question" }],
      queuePolicy: "required",
      abortSignal: controller.signal,
    });
    const outcome = delivery.catch((error: unknown) => error);
    try {
      await adapter.prepared;
      controller.abort(new Error("question ended"));
      expect(await loadPendingDeliveries(stateDir)).toHaveLength(1);
      expect(audit).toEqual(["queued"]);
      adapter.releasePreparation();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("Operation aborted"),
        queueCustody: "released",
      });
      expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      expect(adapter.releaseResource).toHaveBeenCalledOnce();
      expect(adapter.send).not.toHaveBeenCalled();
      expect(audit).toEqual(["queued", "failed"]);
    } finally {
      controller.abort();
      adapter.releasePreparation();
      adapter.releaseProvider();
      await outcome;
      unsubscribe();
    }
  });

  it.each(["sent", "ambiguous"] as const)(
    "preserves %s delivery after adapter dispatch has started",
    async (result) => {
      vi.useFakeTimers();
      const stateDir = fixtures.tmpDir();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const adapter = installHeldAdapter();
      const controller = new AbortController();
      const queueIdReady = createDeferred<string>();
      const delivery = deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "question" }],
        queuePolicy: "required",
        abortSignal: controller.signal,
        onDeliveryIntent: ({ id }) => queueIdReady.resolve(id),
      });
      const outcome = delivery.then(
        (results) => ({ results }),
        (error: unknown) => ({ error }),
      );
      try {
        const queueId = await queueIdReady.promise;
        await adapter.prepared;
        adapter.releasePreparation();
        await adapter.providerEntered;
        controller.abort(new Error("question ended after dispatch"));
        expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("send_attempt_started");
        await vi.advanceTimersByTimeAsync(65_000);
        if (result === "ambiguous") {
          adapter.failProvider();
        }
        adapter.releaseProvider();
        const settled = await outcome;
        expect(adapter.send).toHaveBeenCalledOnce();
        if (result === "sent") {
          expect(settled).toMatchObject({ results: [{ messageId: "accepted-message" }] });
          expect(await loadPendingDeliveries(stateDir)).toEqual([]);
        } else {
          expect(settled).toMatchObject({ error: { queueCustody: "held" } });
          expect(readQueuedEntry(stateDir, queueId).recoveryState).toBe("unknown_after_send");
        }
      } finally {
        controller.abort();
        adapter.releasePreparation();
        adapter.releaseProvider();
        await outcome;
      }
    },
  );
});
