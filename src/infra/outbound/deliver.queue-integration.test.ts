import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import {
  claimDeliveryPlatformSendAttempt,
  drainPendingDeliveries,
  enqueueDeliveryOnce,
  type DeliverFn,
} from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

const boundedCronCompletionRetention = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(
  deps: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]["deps"],
): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    ),
};

async function drainMatrixReconnect(opts: { deliver: DeliverFn; stateDir: string }): Promise<void> {
  await drainPendingDeliveries({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
  });
}

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
    releasePinnedPluginChannelRegistry();
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
      },
      deliveryIntentId,
      tmpDir,
    );
    const producerClaimId = await claimDeliveryPlatformSendAttempt(deliveryIntentId, tmpDir);
    expect(producerClaimId).toEqual(expect.any(String));

    const deliver = vi.fn<DeliverFn>(async () => []);
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir))[0]).toMatchObject({
      id: deliveryIntentId,
      recoveryState: "producer_claimed",
      producerClaimId,
    });
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

  it("never completes recovered Matrix sends that return no platform identity", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const deliveryIntentId = "cron-direct-delivery:v1:recovered-matrix-no-identity";
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "recovery must not assume a platform send succeeded" }],
        queuePolicy: "required",
        completionRetention: boundedCronCompletionRetention,
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
    });

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    expect(sendMatrix).toHaveBeenCalledOnce();
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

  it("advances queued entry to unknown_after_send when a later payload fails after an earlier one succeeded", async () => {
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
    expect(auditEvents).toEqual([]);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.sourceId)).toEqual([
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:0`,
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:1`,
    ]);
    expect(auditEvents.map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([0, 0]);
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
    expect(auditEvents.map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([0, 0]);
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
