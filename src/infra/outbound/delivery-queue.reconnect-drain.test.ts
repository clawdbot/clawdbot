import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  type DeliverFn,
  drainPendingDeliveries,
  enqueueDelivery,
  failDelivery,
  MAX_RETRIES,
  type RecoveryLogger,
  recoverPendingDeliveries,
} from "./delivery-queue.js";

function createMockLogger(): RecoveryLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const stubCfg = {} as OpenClawConfig;
const NO_LISTENER_ERROR = "No active WhatsApp Web listener";

function normalizeReconnectAccountIdForTest(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
}

async function drainWhatsAppReconnectPending(opts: {
  accountId: string;
  deliver: DeliverFn;
  log: RecoveryLogger;
  stateDir: string;
}) {
  const normalizedAccountId = normalizeReconnectAccountIdForTest(opts.accountId);
  await drainPendingDeliveries({
    drainKey: `whatsapp:${normalizedAccountId}`,
    logLabel: "WhatsApp reconnect drain",
    cfg: stubCfg,
    log: opts.log,
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({
      match:
        entry.channel === "whatsapp" &&
        normalizeReconnectAccountIdForTest(entry.accountId) === normalizedAccountId,
      bypassBackoff:
        typeof entry.lastError === "string" && entry.lastError.includes(NO_LISTENER_ERROR),
    }),
  });
}

describe("drainPendingDeliveries for WhatsApp reconnect", () => {
  let fixtureRoot = "";
  let tmpDir: string;
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-drain-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  it("drains entries that failed with 'no listener' error", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "No active WhatsApp Web listener", tmpDir);

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", to: "+1555", skipQueue: true }),
    );
  });

  it("skips entries from other accounts", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "other" },
      tmpDir,
    );
    await failDelivery(id, "No active WhatsApp Web listener", tmpDir);

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    // deliver should not be called since no eligible entries for acct1
    expect(deliver).not.toHaveBeenCalled();
  });

  it("retries immediately without resetting retry history", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {
      throw new Error("transient failure");
    });

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "No active WhatsApp Web listener", tmpDir);
    const queueDir = path.join(tmpDir, "delivery-queue");
    const filePath = path.join(queueDir, `${id}.json`);
    const before = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      retryCount: number;
      lastAttemptAt?: number;
      lastError?: string;
    };

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

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
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {
      throw new Error("transient failure");
    });

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "No active WhatsApp Web listener", tmpDir);

    // Should not throw
    await expect(
      drainWhatsAppReconnectPending({
        accountId: "acct1",
        deliver,
        log,
        stateDir: tmpDir,
      }),
    ).resolves.toBeUndefined();
  });

  it("skips entries where retryCount >= MAX_RETRIES", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    // Bump retryCount to MAX_RETRIES
    for (let i = 0; i < MAX_RETRIES; i++) {
      await failDelivery(id, "No active WhatsApp Web listener", tmpDir);
    }

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    // Should have moved to failed, not delivered
    expect(deliver).not.toHaveBeenCalled();
    const failedDir = path.join(tmpDir, "delivery-queue", "failed");
    const failedFiles = fs.readdirSync(failedDir).filter((f) => f.endsWith(".json"));
    expect(failedFiles).toHaveLength(1);
  });

  it("second concurrent call is skipped (concurrency guard)", async () => {
    const log = createMockLogger();
    let resolveDeliver: () => void;
    const deliverPromise = new Promise<void>((resolve) => {
      resolveDeliver = resolve;
    });
    const deliver = vi.fn<DeliverFn>(async () => {
      await deliverPromise;
    });

    await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
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
    entry.lastError = "No active WhatsApp Web listener";
    entry.retryCount = 1;
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

    const opts = { accountId: "acct1", log, stateDir: tmpDir, deliver };

    // Start first drain (will block on deliver)
    const first = drainWhatsAppReconnectPending(opts);
    // Start second drain immediately — should be skipped
    const second = drainWhatsAppReconnectPending(opts);
    await second;

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already in progress"));

    // Unblock first drain
    resolveDeliver!();
    await first;
  });

  it("does not re-deliver an entry already being recovered at startup", async () => {
    const log = createMockLogger();
    const startupLog = createMockLogger();
    let resolveDeliver: () => void;
    const deliverPromise = new Promise<void>((resolve) => {
      resolveDeliver = resolve;
    });
    const deliver = vi.fn<DeliverFn>(async () => {
      await deliverPromise;
    });

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
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
    entry.lastError = "No active WhatsApp Web listener";
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

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(`entry ${id} is already being recovered`),
    );

    resolveDeliver!();
    await startupRecovery;
  });

  it("does not re-deliver a stale startup snapshot after reconnect already acked it", async () => {
    const log = createMockLogger();
    const startupLog = createMockLogger();
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
    const whatsappId = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    const queueDir = path.join(tmpDir, "delivery-queue");
    const blockerPath = path.join(queueDir, `${blockerId}.json`);
    const whatsappPath = path.join(queueDir, `${whatsappId}.json`);
    const blockerEntry = JSON.parse(fs.readFileSync(blockerPath, "utf-8")) as {
      enqueuedAt: number;
    };
    const whatsappEntry = JSON.parse(fs.readFileSync(whatsappPath, "utf-8")) as {
      enqueuedAt: number;
    };
    blockerEntry.enqueuedAt = 1;
    whatsappEntry.enqueuedAt = 2;
    fs.writeFileSync(blockerPath, JSON.stringify(blockerEntry, null, 2));
    fs.writeFileSync(whatsappPath, JSON.stringify(whatsappEntry, null, 2));

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

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    releaseBlocker!();
    await startupRecovery;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveredTargets.filter((target) => target === "+1555")).toHaveLength(1);
    expect(startupLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Recovery skipped for delivery"),
    );
  });
  it("drains fresh pending WhatsApp entries for the reconnecting account", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      fs.readdirSync(path.join(tmpDir, "delivery-queue")).filter((f) => f.endsWith(".json")),
    ).toEqual([]);
  });

  it("drains backoff-eligible WhatsApp retries on reconnect", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "network down", tmpDir);
    const entryPath = path.join(tmpDir, "delivery-queue", `${id}.json`);
    const entry = JSON.parse(fs.readFileSync(entryPath, "utf-8")) as {
      lastAttemptAt?: number;
    };
    entry.lastAttemptAt = Date.now() - 30_000;
    fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not bypass backoff for ordinary transient errors on reconnect", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, "network down", tmpDir);

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
  });

  it("still bypasses backoff for no-listener failures on reconnect", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );
    await failDelivery(id, NO_LISTENER_ERROR, tmpDir);

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("ignores non-WhatsApp entries even when reconnect drain runs", async () => {
    const log = createMockLogger();
    const deliver = vi.fn<DeliverFn>(async () => {});

    await enqueueDelivery(
      { channel: "telegram", to: "+1555", payloads: [{ text: "hi" }], accountId: "acct1" },
      tmpDir,
    );

    await drainWhatsAppReconnectPending({
      accountId: "acct1",
      deliver,
      log,
      stateDir: tmpDir,
    });

    expect(deliver).not.toHaveBeenCalled();
  });
});
