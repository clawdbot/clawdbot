import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "../delivery-queue-sqlite.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { migrateLegacyPendingOutboundDeliveries } from "./delivery-queue-migration.js";
import {
  enqueueDelivery,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
  type LegacyQueuedDeliveryPreparation,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import { recoverPendingDeliveries } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

const hookMocks = vi.hoisted(() => ({
  hasHooks: vi.fn((name?: string) => name === "message_sending" || name === "message_sent"),
  runMessageSending: vi.fn(async (event: { content: string }) => ({
    content: `${event.content}-prepared`,
  })),
  runMessageSent: vi.fn(async () => undefined),
}));
const channelMocks = vi.hoisted(() => ({
  resolveOutboundChannelMessageAdapter: vi.fn(),
}));
const completionMocks = vi.hoisted(() => ({
  failDurableDelivery: vi.fn(),
}));
const namespaceMocks = vi.hoisted(() => ({
  replacePendingDeliveryQueueEntry: vi.fn(),
  throwOnReplaceCall: 0,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks,
}));
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: channelMocks.resolveOutboundChannelMessageAdapter,
}));
vi.mock("./delivery-completion.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./delivery-completion.js")>();
  return { ...original, failDurableDelivery: completionMocks.failDurableDelivery };
});
vi.mock("../delivery-queue-sqlite-namespace.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../delivery-queue-sqlite-namespace.js")>();
  namespaceMocks.replacePendingDeliveryQueueEntry.mockImplementation((params) => {
    if (
      namespaceMocks.throwOnReplaceCall > 0 &&
      namespaceMocks.replacePendingDeliveryQueueEntry.mock.calls.length ===
        namespaceMocks.throwOnReplaceCall
    ) {
      throw new Error("transient lease renewal failure");
    }
    return original.replacePendingDeliveryQueueEntry(params);
  });
  return {
    ...original,
    replacePendingDeliveryQueueEntry: namespaceMocks.replacePendingDeliveryQueueEntry,
  };
});

const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text, deps }) => {
    const send = deps?.matrix as
      | ((to: string, text: string) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("missing Matrix sender");
    }
    return { channel: "matrix", ...(await send(to, text)) };
  },
};

function legacyEntry(id: string, text: string) {
  return {
    id,
    enqueuedAt: 100,
    retryCount: 0,
    attemptCount: 0,
    channel: "matrix" as const,
    to: "!room:example",
    queuePolicy: "required" as const,
    payloads: [{ text }],
  };
}

function readQueueEntryJson(queueName: string, id: string, stateDir: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return (
    db
      .prepare("SELECT entry_json FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(queueName, id) as { entry_json?: string } | undefined
  )?.entry_json;
}

describe("outbound prepared queue migration", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    hookMocks.hasHooks.mockClear();
    hookMocks.runMessageSending.mockClear();
    hookMocks.runMessageSending.mockImplementation(async (event: { content: string }) => ({
      content: `${event.content}-prepared`,
    }));
    hookMocks.runMessageSent.mockClear();
    channelMocks.resolveOutboundChannelMessageAdapter.mockReset();
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue(undefined);
    completionMocks.failDurableDelivery.mockClear();
    namespaceMocks.replacePendingDeliveryQueueEntry.mockClear();
    namespaceMocks.throwOnReplaceCall = 0;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutbound }),
        },
      ]),
    );
  });

  it("prepares a legacy row once, fences rollback, and never reruns modifiers", async () => {
    const id = "stable-legacy-delivery";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: { ...legacyEntry(id, "secret"), completionRetention: "permanent" },
      stateDir: tmpDir(),
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 1, skipped: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledTimes(1);
    expect(getDeliveryQueueEntryStatus(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe(
      "completed",
    );
    expect(readQueueEntryJson(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).not.toContain(
      "secret",
    );
    const queued = loadDeliveryQueueEntry(
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      tmpDir(),
    ) as QueuedDelivery;
    expect(
      acceptedPreparedOutboundEntries(queued.preparedBatch).map((entry) => entry.payload),
    ).toEqual([{ text: "secret-prepared" }]);
    expect(queued).not.toHaveProperty("legacyPreparationOwnerId");
    expect(queued).not.toHaveProperty("legacyPreparationLeaseExpiresAt");

    const sendMatrix = vi.fn(async () => ({ messageId: "mx-1" }));
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver: async (params) =>
        await deliverOutboundPayloadsInternal({
          ...params,
          deps: { matrix: sendMatrix },
        }),
    });
    expect(hookMocks.runMessageSending).toHaveBeenCalledTimes(1);
    expect(sendMatrix).toHaveBeenCalledWith("!room:example", "secret-prepared");
    expect(hookMocks.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "secret-prepared",
        messageId: "mx-1",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe(
      "completed",
    );
  });

  it("claims a legacy row before invoking modifiers", async () => {
    const id = "claimed-legacy-delivery";
    const source = legacyEntry(id, "first");
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: source,
      stateDir: tmpDir(),
    });
    let releaseHook: ((value: { content: string }) => void) | undefined;
    hookMocks.runMessageSending.mockImplementationOnce(
      async () =>
        await new Promise<{ content: string }>((resolve) => {
          releaseHook = resolve;
        }),
    );
    const migration = migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
    });
    await vi.waitFor(() => expect(hookMocks.runMessageSending).toHaveBeenCalledOnce());
    const overlappingMigration = migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
    });
    let overlappingSettled = false;
    void overlappingMigration.then(
      () => {
        overlappingSettled = true;
      },
      () => {
        overlappingSettled = true;
      },
    );
    await Promise.resolve();
    expect(overlappingSettled).toBe(false);
    expect(loadDeliveryQueueEntry(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(
      loadDeliveryQueueEntry(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir()),
    ).toMatchObject({
      legacyPreparationState: "modifiers_started",
      payloads: [{ text: "first" }],
    });
    releaseHook?.({ content: "first-prepared" });

    await expect(migration).resolves.toEqual({ moved: 1, skipped: 0 });
    await expect(overlappingMigration).resolves.toEqual({ moved: 1, skipped: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(loadDeliveryQueueEntry(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toMatchObject({
      preparedBatch: {
        entries: [expect.objectContaining({ payload: { text: "first-prepared" } })],
      },
    });
  });

  it("fences modifier preparation when lease renewal throws", async () => {
    vi.useFakeTimers();
    try {
      const id = "legacy-renewal-failure";
      upsertDeliveryQueueEntry({
        queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
        entry: legacyEntry(id, "must not replay"),
        stateDir: tmpDir(),
      });
      let releaseHook: ((value: { content: string }) => void) | undefined;
      hookMocks.runMessageSending.mockImplementationOnce(
        async () =>
          await new Promise<{ content: string }>((resolve) => {
            releaseHook = resolve;
          }),
      );
      namespaceMocks.throwOnReplaceCall = 2;

      const migration = migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      releaseHook?.({ content: "must not replay-prepared" });

      await expect(migration).resolves.toEqual({ moved: 0, skipped: 1 });
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir()),
      ).toBe("failed");
      expect(
        readQueueEntryJson(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir()),
      ).not.toContain("must not replay");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters interrupted modifier preparation without invoking hooks again", async () => {
    const id = "interrupted-legacy-preparation";
    const interrupted = {
      ...legacyEntry(id, "must not be reconsidered"),
      legacyPreparationState: "modifiers_started",
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "interrupted-operation",
      },
    } satisfies LegacyQueuedDeliveryPreparation;
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      entry: interrupted,
      stateDir: tmpDir(),
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 0, skipped: 1 });

    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(completionMocks.failDurableDelivery).toHaveBeenCalledWith(
      interrupted.deliveryCompletion,
    );
    expect(getDeliveryQueueEntryStatus(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).toBe(
      "failed",
    );
    const failedFence = readQueueEntryJson(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir());
    expect(failedFence).toBeDefined();
    expect(failedFence).not.toContain("must not be reconsidered");
    expect(JSON.parse(failedFence ?? "{}")).toMatchObject({
      id,
      enqueuedAt: 100,
      retryCount: 0,
      attemptCount: 0,
    });
    expect(JSON.parse(failedFence ?? "{}")).not.toHaveProperty("payloads");
    expect(JSON.parse(failedFence ?? "{}")).not.toHaveProperty("deliveryCompletion");
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeNull();
  });

  it("does not dead-letter an actively leased modifier preparation", async () => {
    const id = "active-legacy-preparation";
    const active = {
      ...legacyEntry(id, "active raw input"),
      legacyPreparationState: "modifiers_started",
      legacyPreparationOwnerId: "other-process",
      legacyPreparationLeaseExpiresAt: Date.now() + 60_000,
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "active-operation",
      },
    } satisfies LegacyQueuedDeliveryPreparation;
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      entry: active,
      stateDir: tmpDir(),
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 0, skipped: 1 });

    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(completionMocks.failDurableDelivery).not.toHaveBeenCalled();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).toBe(
      "pending",
    );
    expect(loadDeliveryQueueEntry(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).toEqual(
      active,
    );
  });

  it("retries setup failures that occur before the first modifier invocation", async () => {
    const id = "legacy-pre-modifier-setup-failure";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: legacyEntry(id, "retry after setup"),
      stateDir: tmpDir(),
    });
    hookMocks.hasHooks.mockImplementationOnce(() => {
      throw new Error("transient hook registry failure");
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 0, skipped: 1 });
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(
      loadDeliveryQueueEntry(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir()),
    ).toMatchObject({ legacyPreparationState: "claimed" });

    hookMocks.hasHooks.mockImplementation(
      (name?: string) => name === "message_sending" || name === "message_sent",
    );
    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 1, skipped: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toMatchObject({
      preparedBatch: {
        entries: [expect.objectContaining({ payload: { text: "retry after setup-prepared" } })],
      },
    });
  });

  it("checkpoints prepared policy before retrying failed media staging", async () => {
    const id = "legacy-staging-retry";
    const source = path.join(
      tmpDir(),
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000091.png",
    );
    const sourceEntry = {
      ...legacyEntry(id, "caption"),
      payloads: [{ text: "caption", mediaUrl: source }],
    };
    const warnings: string[] = [];
    const log = {
      info: vi.fn(),
      warn: (message: string) => warnings.push(message),
      error: vi.fn(),
    };
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: sourceEntry,
      stateDir: tmpDir(),
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log,
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 0, skipped: 1 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(loadDeliveryQueueEntry(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(
      loadDeliveryQueueEntry(OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, id, tmpDir()),
    ).toMatchObject({
      preparedBatch: {
        entries: [
          expect.objectContaining({
            status: "accepted",
            payload: { text: "caption-prepared", mediaUrl: source },
          }),
        ],
      },
    });

    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(
      source,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZKJkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    warnings.length = 0;
    const secondMigration = await migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      log,
      stateDir: tmpDir(),
    });
    expect({ secondMigration, warnings }).toEqual({
      secondMigration: { moved: 1, skipped: 0 },
      warnings: [],
    });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toMatchObject({
      preparedBatch: {
        entries: [
          expect.objectContaining({
            status: "accepted",
            payload: expect.objectContaining({ text: "caption-prepared" }),
          }),
        ],
      },
      renderedBatchPlan: {
        items: [expect.objectContaining({ mediaUrls: [source] })],
      },
    });
  });

  it("reconciles a legacy unknown send before modifiers and prepares only when not sent", async () => {
    const id = "legacy-pre-send-reconcile";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: {
        ...legacyEntry(id, "original"),
        recoveryState: "send_attempt_started",
        platformSendAttemptId: "attempt-1",
        platformSendStartedAt: 200,
      },
      stateDir: tmpDir(),
    });
    let settleReconciliation: ((value: { status: "not_sent" }) => void) | undefined;
    const reconcileUnknownSend = vi.fn(
      async () =>
        await new Promise<{ status: "not_sent" }>((resolve) => {
          settleReconciliation = resolve;
        }),
    );
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
    });

    const migration = migrateLegacyPendingOutboundDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
    });
    await vi.waitFor(() => expect(reconcileUnknownSend).toHaveBeenCalledOnce());
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    settleReconciliation?.({ status: "not_sent" });

    await expect(migration).resolves.toEqual({ moved: 1, skipped: 0 });
    expect(hookMocks.runMessageSending).toHaveBeenCalledOnce();
    const queued = loadDeliveryQueueEntry(
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      tmpDir(),
    ) as QueuedDelivery;
    expect(queued.legacyUnknownSendReconciliation).toBeUndefined();
    expect(queued.recoveryState).toBeUndefined();
    expect(queued.platformSendAttemptId).toBeUndefined();
    expect(queued.platformSendStartedAt).toBeUndefined();
    expect(
      acceptedPreparedOutboundEntries(queued.preparedBatch).map((entry) => entry.payload),
    ).toEqual([{ text: "original-prepared" }]);

    const deliver = vi.fn().mockResolvedValue([{ channel: "matrix", messageId: "mx-new-attempt" }]);
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver,
    });
    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("settles a reconciled-sent legacy row without rerunning modifiers or provider I/O", async () => {
    const id = "legacy-already-sent";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: {
        ...legacyEntry(id, "pre-policy"),
        recoveryState: "unknown_after_send",
        platformSendAttemptId: "attempt-sent",
        platformSendStartedAt: 200,
      },
      stateDir: tmpDir(),
    });
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId: "mx-existing" }],
      kind: "text",
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "sent",
      messageId: "mx-existing",
      receipt,
    });
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 1, skipped: 0 });
    const migrated = loadDeliveryQueueEntry(
      OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      tmpDir(),
    ) as QueuedDelivery;
    expect(migrated.preparedBatch).toMatchObject({ sourcePayloadCount: 1, entries: [] });
    expect(readQueueEntryJson(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).not.toContain(
      "pre-policy",
    );

    const sendMatrix = vi.fn();
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver: async (deliveryParams) =>
        await deliverOutboundPayloadsInternal({
          ...deliveryParams,
          deps: { matrix: sendMatrix },
        }),
    });

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runMessageSent).not.toHaveBeenCalled();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeUndefined();
  });

  it("emits one terminal observer event for every payload in a reconciled batch", async () => {
    const id = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [{ text: "first prepared" }, { text: "second prepared" }],
      },
      tmpDir(),
    );
    await reserveDeliveryAttempt(id, 1, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "matrix", messageId: "mx-first" },
        { channel: "matrix", messageId: "mx-second" },
      ],
      kind: "text",
    });
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({
          status: "sent",
          messageId: "mx-first",
          receipt,
        }),
      },
    });

    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver: vi.fn(),
    });

    expect(hookMocks.runMessageSent).toHaveBeenCalledTimes(2);
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "first prepared",
        messageId: "mx-first",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: "second prepared",
        messageId: "mx-second",
        success: true,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("fills the unattempted observer suffix when recovery dead-letters a batch", async () => {
    await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [{ text: "sent" }, { text: "failed" }, { text: "unattempted" }],
      },
      tmpDir(),
    );
    const deliver = vi.fn(async (params: Parameters<typeof deliverOutboundPayloadsInternal>[0]) => {
      params.onMessageSentEvent?.(
        {
          success: true,
          content: "sent",
          messageId: "mx-sent",
        },
        0,
      );
      params.onMessageSentEvent?.(
        {
          success: false,
          content: "failed",
          error: "chat not found",
        },
        1,
      );
      throw new Error("chat not found");
    });

    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver,
    });

    expect(hookMocks.runMessageSent).toHaveBeenCalledTimes(3);
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: "sent", messageId: "mx-sent", success: true }),
      expect.any(Object),
    );
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: "failed", success: false }),
      expect.any(Object),
    );
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ content: "unattempted", success: false }),
      expect.any(Object),
    );
  });

  it("fills a suppressed observer gap by source index without duplicating a later failure", async () => {
    await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "required",
        payloads: [{ text: "render-suppressed" }, { text: "failed" }],
      },
      tmpDir(),
    );
    const deliver = vi.fn(async (params: Parameters<typeof deliverOutboundPayloadsInternal>[0]) => {
      params.onMessageSentEvent?.(
        { success: false, content: "failed", error: "chat not found" },
        1,
      );
      throw new Error("chat not found");
    });

    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver,
    });

    expect(hookMocks.runMessageSent).toHaveBeenCalledTimes(2);
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: "render-suppressed", success: false }),
      expect.any(Object),
    );
    expect(hookMocks.runMessageSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ content: "failed", success: false }),
      expect.any(Object),
    );
  });

  it("dead-letters a partially-sent legacy row even when reconciliation reports not sent", async () => {
    const id = "legacy-partial-not-sent";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: {
        ...legacyEntry(id, "pre-policy"),
        recoveryState: "unknown_after_send",
        platformSendAttemptId: "attempt-partial",
        platformSendStartedAt: 200,
      },
      stateDir: tmpDir(),
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
    });
    const sendMatrix = vi.fn();

    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: tmpDir(),
      deliver: async (deliveryParams) =>
        await deliverOutboundPayloadsInternal({
          ...deliveryParams,
          deps: { matrix: sendMatrix },
        }),
    });

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runMessageSent).not.toHaveBeenCalled();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBe("failed");
    expect(readQueueEntryJson(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).not.toContain(
      "pre-policy",
    );
  });

  it("fails unresolved legacy custody payload-free without running modifiers", async () => {
    const id = "legacy-unresolved";
    upsertDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      entry: {
        ...legacyEntry(id, "pre-policy"),
        recoveryState: "send_attempt_started",
        platformSendAttemptId: "attempt-unresolved",
      },
      stateDir: tmpDir(),
    });
    channelMocks.resolveOutboundChannelMessageAdapter.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({
          status: "unresolved",
          error: "provider unavailable",
          retryable: true,
        }),
      },
    });

    await expect(
      migrateLegacyPendingOutboundDeliveries({
        cfg: {},
        log: createRecoveryLog(),
        stateDir: tmpDir(),
      }),
    ).resolves.toEqual({ moved: 0, skipped: 1 });
    expect(hookMocks.runMessageSending).not.toHaveBeenCalled();
    expect(loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(loadDeliveryQueueEntry(LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir())).toBeNull();
    expect(getDeliveryQueueEntryStatus(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).toBe(
      "failed",
    );
    expect(readQueueEntryJson(OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME, id, tmpDir())).not.toContain(
      "pre-policy",
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
});
