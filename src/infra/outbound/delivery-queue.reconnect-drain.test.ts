import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  type DeliverFn,
  drainPendingDeliveries,
  enqueueDelivery,
  failDelivery,
  MAX_RETRIES,
  type RecoveryLogger,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

const stubCfg = {} as OpenClawConfig;
const NO_LISTENER_ERROR = "No active DirectChat listener";

function normalizeReconnectAccountIdForTest(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
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
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "directchat", to: "+1555", skipQueue: true }),
    );
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
    const queueDir = path.join(tmpDir, "delivery-queue");
    const filePath = path.join(queueDir, `${id}.json`);
    const before = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      retryCount: number;
      lastAttemptAt?: number;
      lastError?: string;
    };

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);

    const after = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      retryCount: number;
      lastAttemptAt?: number;
      lastError?: string;
    };
    expect(after.retryCount).toBe(before.retryCount + 1);
    expect(after.lastAttemptAt).toBeTypeOf("number");
    expect(after.lastAttemptAt).toBeGreaterThanOrEqual(before.lastAttemptAt ?? 0);
    expect(after.lastError).toBe("transient failure");
  });

  it("does not throw if delivery fails during drain", async () => {
    const log = createRecoveryLog();
    const deliver = createTransientFailureDeliver();

    await enqueueFailedDirectChatDelivery({ accountId: "acct1", stateDir: tmpDir });

    // Should not throw
    await expect(
      drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir }),
    ).resolves.toBeUndefined();
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
    const failedDir = path.join(tmpDir, "delivery-queue", "failed");
    const failedFiles = fs.readdirSync(failedDir).filter((f) => f.endsWith(".json"));
    expect(failedFiles).toHaveLength(1);
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

    await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    // Fail it so it matches the "no listener" filter
    const pending = fs
      .readdirSync(path.join(tmpDir, "delivery-queue"))
      .find((f) => f.endsWith(".json"));
    if (!pending) {
      throw new Error("Missing pending delivery entry");
    }
    const entryPath = path.join(tmpDir, "delivery-queue", pending);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8"));
    entry.lastError = NO_LISTENER_ERROR;
    entry.retryCount = 1;
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

    const opts = { accountId: "acct1", log, stateDir: tmpDir, deliver };

    // Start first drain (will block on deliver)
    const first = drainDirectChatReconnectPending(opts);
    // Start second drain immediately — should be skipped
    const second = drainDirectChatReconnectPending(opts);
    await second;

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already in progress"));

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
    const queuePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
    const entry = JSON.parse(fs.readFileSync(queuePath, "utf-8")) as {
      id: string;
      enqueuedAt: number;
      channel: string;
      to: string;
      accountId?: string;
      payloads: Array<{ text: string }>;
      retryCount: number;
      lastError?: string;
    };
    entry.lastError = NO_LISTENER_ERROR;
    fs.writeFileSync(queuePath, JSON.stringify(entry, null, 2));

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

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`entry ${id} is already being recovered`),
    );

    resolveDeliver!();
    await startupRecovery;
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
    const queueDir = path.join(tmpDir, "delivery-queue");
    const blockerPath = path.join(queueDir, `${blockerId}.json`);
    const directChatPath = path.join(queueDir, `${directChatId}.json`);
    const blockerEntry = JSON.parse(fs.readFileSync(blockerPath, "utf-8")) as {
      enqueuedAt: number;
    };
    const directChatEntry = JSON.parse(fs.readFileSync(directChatPath, "utf-8")) as {
      enqueuedAt: number;
    };
    blockerEntry.enqueuedAt = 1;
    directChatEntry.enqueuedAt = 2;
    fs.writeFileSync(blockerPath, JSON.stringify(blockerEntry, null, 2));
    fs.writeFileSync(directChatPath, JSON.stringify(directChatEntry, null, 2));

    const startupRecovery = recoverPendingDeliveries({
      cfg: stubCfg,
      deliver,
      log: startupLog,
      stateDir: tmpDir,
    });

    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "demo-channel-a", to: "+1000" }),
      );
    });

    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });

    releaseBlocker!();
    await startupRecovery;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveredTargets.filter((target) => target === "+1555")).toHaveLength(1);
    expect(startupLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Recovery skipped for delivery"),
    );
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
    expect(
      fs.readdirSync(path.join(tmpDir, "delivery-queue")).filter((f) => f.endsWith(".json")),
    ).toEqual([]);
  });

  it("drains backoff-eligible retries on reconnect", async () => {
    const log = createRecoveryLog();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "directchat", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "network down", tmpDir);
    const entryPath = path.join(tmpDir, "delivery-queue", `${id}.json`);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as {
      lastAttemptAt?: number;
    };
    entry.lastAttemptAt = Date.now() - 30_000;
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

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
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
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
    const entryPath = path.join(tmpDir, "delivery-queue", `${id}.json`);
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
          const nextEntry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as {
            lastError?: string;
          };
          nextEntry.lastError = "network down";
          fs.writeFileSync(entryPath, JSON.stringify(nextEntry, null, 2));
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
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
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
      expect(deliver).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining(`entry ${id} is already being recovered`),
      );
    });
    expect(claimResult.status).toBe("claimed");

    // Once the live delivery path releases its claim (success or failure), a
    // later reconnect drain is free to pick the entry up again.
    await drainAcct1DirectChatReconnect({ deliver, log, stateDir: tmpDir });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
