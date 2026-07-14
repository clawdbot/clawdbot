// Covers reconnect-triggered queue drain selection, active claims, backoff
// bypass, and concurrent drain suppression.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import {
  type DeliverFn,
  drainPendingDeliveries,
  enqueueDelivery,
  failDelivery,
  markDeliveryPlatformOutcomeUnknown,
  type RecoveryLogger,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const RECOVERY_REPLAY_SPACING_MS = 250;
const MAX_RETRIES = 5;
const stubCfg = {} as OpenClawConfig;
const NO_LISTENER_ERROR = "No active DirectChat listener";

function normalizeReconnectAccountIdForTest(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
}

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return requireRecord(arg);
}

function expectLogMessageWith(logFn: ReturnType<typeof vi.fn>, text: string): void {
  expect(logFn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

function readOutboundQueueStatus(tmpDir: string, id: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
  });
  const row = db
    .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?")
    .get(id) as { status?: string } | undefined;
  return row?.status;
}

async function drainDirectChatReconnectPending(opts: {
  accountId: string;
  deliver: DeliverFn;
  log: RecoveryLogger;
  stateDir: string;
}) {
  const normalizedAccountId = normalizeReconnectAccountIdForTest(opts.accountId);
  await drainPendingDeliveries({
    drainKey: `directchat:${normalizedAccountId}`,
    logLabel: "DirectChat reconnect drain",
    cfg: stubCfg,
    log: opts.log,
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({
      match:
        entry.channel === "directchat" &&
        normalizeReconnectAccountIdForTest(entry.accountId) === normalizedAccountId,
      bypassBackoff:
        typeof entry.lastError === "string" && entry.lastError.includes(NO_LISTENER_ERROR),
    }),
  });
}

async function drainAcct1DirectChatReconnect(params: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  stateDir: string;
}) {
  await drainDirectChatReconnectPending({
    accountId: "acct1",
    deliver: params.deliver,
    log: params.log,
    stateDir: params.stateDir,
  });
}

function createTransientFailureDeliver(): DeliverFn {
  return vi.fn<DeliverFn>(async () => {
    throw new Error("transient failure");
  });
}

async function enqueueFailedDirectChatDelivery(params: {
  accountId: string;
  stateDir: string;
  error?: string;
}): Promise<string> {
  const id = await enqueueDelivery(
    {
      channel: "directchat",
      to: "+1555",
      payloads: [{ text: "hi" }],
      accountId: params.accountId,
    },
    params.stateDir,
  );
  await failDelivery(id, params.error ?? NO_LISTENER_ERROR, params.stateDir);
  return id;
}

describe("drainPendingDeliveries for reconnect", () => {
  let tmpDir: string;
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
  });

  it("drains entries that failed with 'no listener' error", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    const delivery = firstMockArg(deliver, "delivery");
    expect(delivery.channel).toBe("directchat");
    expect(delivery.to).toBe("+1555");
    expect(delivery.skipQueue).toBe(true);
  });

  it("skips entries from other accounts", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueFailedDirectChatDelivery({ accountId: "other", stateDir: tmpDir });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    // deliver should not be called since no eligible entries for acct1
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retries immediately without resetting retry history", async () => {
    const log = createRecoveryLog();
    const deliver = createTransientFailureDeliver();

    const id = await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });
    const before = readQueuedEntry(tmpDir, id);

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);

    const after = readQueuedEntry(tmpDir, id);
    expect(after.retryCount).toBe(Number(before.retryCount) + 1);
    expect(after.lastAttemptAt).toBeTypeOf("number");
    expect(after.lastAttemptAt).toBeGreaterThanOrEqual(Number(before.lastAttemptAt ?? 0));
    expect(after.lastError).toBe("transient failure");
  });

  it("records retry state if delivery fails during drain", async () => {
    const log = createRecoveryLog();
    const deliver = createTransientFailureDeliver();

    await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });

    await expect(
      drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir }),
    ).resolves.toBeUndefined();
  });

  it("moves unknown-after-send entries to failed without replaying during reconnect drain", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});
    const id = await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir);

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir, id)).toBe("failed");
    expectLogMessageWith(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("skips entries where retryCount >= MAX_RETRIES", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    // Bump retryCount to MAX_RETRIES
    for (let i = 0; i < MAX_RETRIES; i++) {
      await failDelivery(id, NO_LISTENER_ERROR, tmpDir);
    }

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    // Should have moved to failed, not delivered
    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir, id)).toBe("failed");
  });

  it("second concurrent call is skipped (concurrency guard)", async () => {
    const log = createRecoveryLog();
    let resolveDeliver: () => void;
    const deliverPromise = new Promise<void>((resolve) => {
      resolveDeliver = resolve;
    });
    const deliver = vi.fn<DeliverFn>(async () => {
      await deliverPromise;
    });

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    setQueuedEntryState(tmpDir, id, { retryCount: 0, lastError: NO_LISTENER_ERROR });

    const opts = { accountId: "acct1", log, stateDir: tmpDir, deliver };

    // Start first drain (will block on deliver)
    const first = drainDirectChatReconnectPending(opts);
    // Start second drain immediately — should be skipped
    const second = drainDirectChatReconnectPending(opts);
    await second;

    expectLogMessageWith(log.info, "already in progress");

    // Unblock first drain
    resolveDeliver!();
    await first;
  });

  it("does not re-deliver an entry already being recovered at startup", async () => {
    const log = createRecoveryLog();
    const startupLog = createRecoveryLog();
    let resolveDeliver: () => void;
    const deliverPromise = new Promise<void>((resolve) => {
      resolveDeliver = resolve;
    });
    const deliver = vi.fn<DeliverFn>(async () => {
      await deliverPromise;
    });

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    setQueuedEntryState(tmpDir, id, { retryCount: 0, lastError: NO_LISTENER_ERROR });

    const startupRecovery = recoverPendingDeliveries({
      cfg: stubCfg,
      deliver,
      log: startupLog,
      stateDir: tmpDir,
    });

    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();

    resolveDeliver!();
    await startupRecovery;
  });

  it("shares replay pacing between reconnect and startup drains", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const log = createRecoveryLog();
      const startupLog = createRecoveryLog();
      let firstStarted!: () => void;
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const deliveryTimes: number[] = [];
      const deliver = vi.fn<DeliverFn>(async () => {
        deliveryTimes.push(Date.now());
        if (deliveryTimes.length === 1) {
          firstStarted();
          await firstBlocked;
        }
      });

      for (const to of ["+1000", "+2000"]) {
        await enqueueDelivery(
          { channel: "directchat", to, payloads: [{ text: "hi" }], accountId: "acct1" },
          tmpDir,
        );
      }

      const reconnectDrain = drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
      await firstStartedPromise;
      const startupRecovery = recoverPendingDeliveries({
        cfg: stubCfg,
        deliver,
        log: startupLog,
        stateDir: tmpDir,
      });
      releaseFirst();

      await vi.advanceTimersByTimeAsync(RECOVERY_REPLAY_SPACING_MS - 1);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([reconnectDrain, startupRecovery]);

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliveryTimes).toEqual([
        startedAt.getTime(),
        startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-deliver a stale startup snapshot after reconnect already acked it", async () => {
    const log = createRecoveryLog();
    const startupLog = createRecoveryLog();
    let releaseBlocker: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const deliveredTargets: string[] = [];
    const deliver = vi.fn<DeliverFn>(async ({ to }) => {
      deliveredTargets.push(to);
      if (to === "+1000") {
        await blocker;
      }
    });

    const blockerId = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1000", payloads: [{ text: "blocker" }] },
      tmpDir,
    );
    const directChatId = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    setQueuedEntryState(tmpDir, blockerId, { retryCount: 0, enqueuedAt: 1 });
    setQueuedEntryState(tmpDir, directChatId, { retryCount: 0, enqueuedAt: 2 });

    const startupRecovery = recoverPendingDeliveries({
      cfg: stubCfg,
      deliver,
      log: startupLog,
      stateDir: tmpDir,
    });

    await vi.waitFor(() => {
      const deliveries = deliver.mock.calls.map(([delivery]) => requireRecord(delivery));
      expect(
        deliveries.some(
          (delivery) => delivery.channel === "demo-channel-a" && delivery.to === "+1000",
        ),
      ).toBe(true);
    });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    releaseBlocker!();
    await startupRecovery;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(countMatching(deliveredTargets, (target) => target === "+1555")).toBe(1);
    expectLogMessageWith(startupLog.info, "Recovery skipped for delivery");
  });
  it("drains fresh pending entries for the reconnecting account", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir)).toStrictEqual([]);
  });

  it("drains backoff-eligible retries on reconnect", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "network down", tmpDir);
    setQueuedEntryState(tmpDir, id, {
      retryCount: 1,
      lastAttemptAt: Date.now() - 30_000,
    });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not bypass backoff for ordinary transient errors on reconnect", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "network down", tmpDir);

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
    expectLogMessageWith(log.info, "not ready for retry yet");
  });

  it("still bypasses backoff for no-listener failures on reconnect", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("ignores other channels even when reconnect drain runs", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueDelivery(
      { channel: "forum", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("recomputes backoff bypass after rereading the claimed entry", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});
    const id = await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });
    let mutated = false;

    await drainPendingDeliveries({
      drainKey: "directchat:acct1",
      logLabel: "DirectChat reconnect drain",
      cfg: stubCfg,
      log,
      stateDir: tmpDir,
      deliver,
      selectEntry: (entry) => {
        if (entry.id === id && !mutated) {
          mutated = true;
          setQueuedEntryState(tmpDir, id, {
            retryCount: entry.retryCount,
            lastAttemptAt: entry.lastAttemptAt,
            lastError: "network down",
          });
        }
        return {
          match:
            entry.channel === "directchat" &&
            normalizeReconnectAccountIdForTest(entry.accountId) === "acct1",
          bypassBackoff:
            typeof entry.lastError === "string" && entry.lastError.includes(NO_LISTENER_ERROR),
        };
      },
    });

    expect(deliver).not.toHaveBeenCalled();
    expectLogMessageWith(log.info, "not ready for retry yet");
  });

  it("skips entries that an in-flight live delivery has actively claimed", async () => {
    // Regression for openclaw/openclaw#70386: a reconnect drain that runs
    // while the live send is still writing to the adapter must not re-drive
    // the same entry. The live delivery path holds an in-memory active claim
    // for `queueId` across its send; drain honors that claim via the same
    // `entriesInProgress` set used for startup recovery.
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    const claimResult = await withActiveDeliveryClaim(id, async () => {
      await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
      await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
      expect(deliver).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    });
    expect(claimResult.status).toBe("claimed");

    // Once the live delivery path releases its claim (success or failure), a
    // later reconnect drain is free to pick the entry up again.
    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
