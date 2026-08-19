// Regression coverage: provably-not-sent send failures retry on the backoff
// rails instead of dead-lettering, and terminal rows keep failure evidence.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery, loadPendingDeliveries } from "./delivery-queue-storage.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

type TerminalRow = {
  status: string;
  channel: string | null;
  target: string | null;
  last_error: string | null;
  entry_json: string;
};

function readTerminalRow(tmpDir: string, id: string): TerminalRow {
  const { db } = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir } });
  const row = db
    .prepare(
      `SELECT status, channel, target, last_error, entry_json
         FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
    )
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as TerminalRow | undefined;
  if (!row) {
    throw new Error(`Missing delivery queue row ${id}`);
  }
  return row;
}

function connectRefusedError(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
}

describe("outbound delivery provably-not-sent retry", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a provably-not-sent failure with backoff and delivers later", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-25T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    const stateDir = tmpDir();
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "retry me" }] },
      stateDir,
    );
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("429: Too Many Requests: retry after 7"), {
          error_code: 429,
          description: "Too Many Requests: retry after 7",
          parameters: { retry_after: 7 },
        }),
      )
      .mockResolvedValue([]);
    const recover = () =>
      recoverPendingDeliveries({
        deliver: asDeliverFn(deliver),
        log: createRecoveryLog(),
        cfg: {},
        stateDir,
        maxRecoveryMs: 60_000,
      });

    await expect(recover()).resolves.toMatchObject({ recovered: 0, failed: 1 });
    const failedEntry = readQueuedEntry(stateDir, id);
    expect(failedEntry.retryCount).toBe(1);
    expect(failedEntry.lastError).toContain("Too Many Requests");
    // Platform retry-after floors the next attempt via the availableAt rail.
    expect(failedEntry.availableAt).toBe(startedAt.getTime() + 7_000);
    expect(failedEntry.recoveryState).toBeUndefined();
    expect(failedEntry.platformSendAttemptId).toBeUndefined();

    // Before the retry-after floor the entry must stay deferred, not buried.
    vi.setSystemTime(startedAt.getTime() + 6_000);
    await expect(recover()).resolves.toMatchObject({ recovered: 0, deferredBackoff: 1 });

    vi.setSystemTime(startedAt.getTime() + 7_000);
    await expect(recover()).resolves.toMatchObject({ recovered: 1, deferredBackoff: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    await expect(loadPendingDeliveries(stateDir)).resolves.toEqual([]);
  });

  it("keeps provably-not-sent connect failures pending instead of dead-lettering", async () => {
    const stateDir = tmpDir();
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "connect refused" }] },
      stateDir,
    );
    const deliver = vi.fn().mockRejectedValue(connectRefusedError());

    await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log: createRecoveryLog(),
      cfg: {},
      stateDir,
      maxRecoveryMs: 60_000,
    });

    const entry = readQueuedEntry(stateDir, id);
    expect(entry.retryCount).toBe(1);
    expect(entry.lastError).toContain("ECONNREFUSED");
    const pending = await loadPendingDeliveries(stateDir);
    expect(pending.map((pendingEntry) => pendingEntry.id)).toEqual([id]);
  });

  it("terminalizes with lastError, channel, and target after budget exhaustion", async () => {
    const stateDir = tmpDir();
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "exhausted" }],
        completionRetention: "permanent",
      },
      stateDir,
    );
    setQueuedEntryState(stateDir, id, {
      retryCount: 5,
      lastAttemptAt: Date.now() - 1_000,
      lastError: "connect ECONNREFUSED 10.0.0.1:443",
    });
    const deliver = vi.fn();

    await expect(
      recoverPendingDeliveries({
        deliver: asDeliverFn(deliver),
        log: createRecoveryLog(),
        cfg: {},
        stateDir,
        maxRecoveryMs: 60_000,
      }),
    ).resolves.toMatchObject({ skippedMaxRetries: 1 });

    expect(deliver).not.toHaveBeenCalled();
    const row = readTerminalRow(stateDir, id);
    expect(row.status).toBe("failed");
    expect(row.channel).toBe("demo-channel-a");
    expect(row.target).toBe("+1");
    expect(row.last_error).toBe("connect ECONNREFUSED 10.0.0.1:443");
    expect(JSON.parse(row.entry_json)).toMatchObject({
      channel: "demo-channel-a",
      to: "+1",
      lastError: "connect ECONNREFUSED 10.0.0.1:443",
      retryCount: 5,
    });
  });

  it("does not retry an ambiguous send and buries it with preserved evidence", async () => {
    const stateDir = tmpDir();
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "ambiguous" }],
        completionRetention: "permanent",
      },
      stateDir,
    );
    setQueuedEntryState(stateDir, id, {
      retryCount: 1,
      // Past the retry backoff window so recovery reaches reconciliation.
      lastAttemptAt: Date.now() - 60_000,
      lastError: "socket hang up",
      platformSendStartedAt: Date.now() - 61_000,
      recoveryState: "send_attempt_started",
    });
    const log = createRecoveryLog();
    const deliver = vi.fn();

    await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: {},
      stateDir,
      maxRecoveryMs: 60_000,
    });

    // Ambiguity is never blind-replayed: no provider call, conservative burial.
    expect(deliver).not.toHaveBeenCalled();
    const row = readTerminalRow(stateDir, id);
    expect(row.status).toBe("failed");
    expect(row.channel).toBe("demo-channel-a");
    expect(row.target).toBe("+1");
    expect(row.last_error).toBe("socket hang up");
    expect(
      log.error.mock.calls.some(([message]) => message.includes("dead-lettered as ambiguous")),
    ).toBe(true);
  });
});
