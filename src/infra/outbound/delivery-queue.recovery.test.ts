import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import {
  enqueueDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  MAX_RETRIES,
  recoverPendingDeliveries,
} from "./delivery-queue.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0];
}

function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  const messages = mock.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}

describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};

  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
  });

  const enqueueCrashRecoveryEntries = async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    await enqueueDelivery(
      { channel: "demo-channel-b", to: "2", payloads: [{ text: "b" }] },
      tmpDir(),
    );
  };

  const runRecovery = async ({
    deliver,
    log = createRecoveryLog(),
    maxRecoveryMs,
  }: {
    deliver: ReturnType<typeof vi.fn>;
    log?: ReturnType<typeof createRecoveryLog>;
    maxRecoveryMs?: number;
  }) => {
    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log,
      cfg: baseCfg,
      stateDir: tmpDir(),
      ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
    });
    return { result, log };
  };

  it("recovers entries from a simulated crash", async () => {
    await enqueueCrashRecoveryEntries();
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      recovered: 2,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });

    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
  });

  it("increments retryCount on failed recovery attempt", async () => {
    await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
  });

  it("moves entries abandoned after platform send may have started to failed without reconciliation", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "maybe sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "unknown_after_send");
  });

  it("moves started entries without reconciliation to failed instead of blindly replaying", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "not yet sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("replays started entries only after adapter proves they were not sent", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "not yet sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({ status: "not_sent" }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(resolveOutboundChannelMessageAdapterMock).toHaveBeenCalledWith({
      channel: "demo-channel-a",
      cfg: baseCfg,
      allowBootstrap: true,
    });
    const deliverInput = mockCallArg(deliver) as {
      channel?: string;
      to?: string;
      skipQueue?: boolean;
    };
    expect(deliverInput.channel).toBe("demo-channel-a");
    expect(deliverInput.to).toBe("+1");
    expect(deliverInput.skipQueue).toBe(true);
    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("acks unknown-after-send entries reconciled as already sent before commit hooks", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        accountId: "acct-1",
        payloads: [{ text: "maybe sent" }],
        replyToId: "root-message",
        threadId: "thread-1",
        silent: true,
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    const order: string[] = [];
    const afterCommit = vi.fn(() => {
      order.push("afterCommit");
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "sent",
      messageId: "platform-1",
      receipt: {
        primaryPlatformMessageId: "platform-1",
        platformMessageIds: ["platform-1"],
        parts: [{ platformMessageId: "platform-1", kind: "text", index: 0 }],
        sentAt: 1,
      },
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
      send: {
        lifecycle: {
          afterCommit,
        },
      },
    });

    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
      order.push("ack");
      return await rename(...args);
    });

    try {
      const deliver = vi.fn().mockResolvedValue([]);
      const { result } = await runRecovery({ deliver });

      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual({
        recovered: 1,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      const reconcileInput = mockCallArg(reconcileUnknownSend) as {
        cfg?: unknown;
        queueId?: string;
        channel?: string;
        to?: string;
        accountId?: string;
        payloads?: unknown;
        replyToId?: string;
        threadId?: string;
        silent?: boolean;
        retryCount?: number;
      };
      expect(reconcileInput.cfg).toBe(baseCfg);
      expect(reconcileInput.queueId).toBe(id);
      expect(reconcileInput.channel).toBe("demo-channel-a");
      expect(reconcileInput.to).toBe("+1");
      expect(reconcileInput.accountId).toBe("acct-1");
      expect(reconcileInput.payloads).toEqual([{ text: "maybe sent" }]);
      expect(reconcileInput.replyToId).toBe("root-message");
      expect(reconcileInput.threadId).toBe("thread-1");
      expect(reconcileInput.silent).toBe(true);
      expect(reconcileInput.retryCount).toBe(0);

      const afterCommitInput = mockCallArg(afterCommit) as {
        kind?: string;
        to?: string;
        accountId?: string;
        replyToId?: string;
        threadId?: string;
        silent?: boolean;
        result?: { messageId?: string };
      };
      expect(afterCommitInput.kind).toBe("text");
      expect(afterCommitInput.to).toBe("+1");
      expect(afterCommitInput.accountId).toBe("acct-1");
      expect(afterCommitInput.replyToId).toBe("root-message");
      expect(afterCommitInput.threadId).toBe("thread-1");
      expect(afterCommitInput.silent).toBe(true);
      expect(afterCommitInput.result?.messageId).toBe("platform-1");
      expect(order).toEqual(["ack", "afterCommit"]);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("records retry state when acking a reconciled sent entry fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "maybe sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({
          status: "sent",
          messageId: "platform-1",
          receipt: {
            primaryPlatformMessageId: "platform-1",
            platformMessageIds: ["platform-1"],
            parts: [{ platformMessageId: "platform-1", kind: "text", index: 0 }],
            sentAt: 1,
          },
        }),
      },
    });
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("ack denied"), { code: "EACCES" }));

    try {
      const deliver = vi.fn().mockResolvedValue([]);
      const log = createRecoveryLog();
      const { result } = await runRecovery({ deliver, log });

      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual({
        recovered: 0,
        failed: 1,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      const entries = await loadPendingDeliveries(tmpDir());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe(id);
      expect(entries[0]?.retryCount).toBe(1);
      expect(entries[0]?.lastError).toContain("failed to ack reconciled sent delivery");
      expect(entries[0]?.lastError).toContain("ack denied");
      expectMockMessageContaining(log.warn, "failed to ack reconciled sent delivery");
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("replays unknown-after-send entries only after adapter proves they were not sent", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "not sent" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({ status: "not_sent" }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverInput = mockCallArg(deliver) as {
      channel?: string;
      to?: string;
      skipQueue?: boolean;
    };
    expect(deliverInput.channel).toBe("demo-channel-a");
    expect(deliverInput.to).toBe("+1");
    expect(deliverInput.skipQueue).toBe(true);
    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("keeps retryable unresolved unknown-after-send entries on the queue without replaying", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "unknown" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend: vi.fn().mockResolvedValue({
          status: "unresolved",
          error: "provider lookup timed out",
          retryable: true,
        }),
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.lastError).toContain("provider lookup timed out");
  });

  it("does not reconcile unknown-after-send entries unless the adapter declares the capability", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "hidden method" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        reconcileUnknownSend,
      },
    });

    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("moves entries to failed/ immediately on permanent delivery errors", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel", to: "user:abc", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(new Error("No conversation reference found for user:abc"));
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("treats Matrix 'User not in room' as a permanent error", async () => {
    const id = await enqueueDelivery(
      { channel: "matrix", to: "!lowercased:matrix.example.com", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "MatrixError: [403] User @bot:matrix.example.com not in room !lowercased:matrix.example.com",
        ),
      );
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    const deliverInput = mockCallArg(deliver) as {
      deliveryQueueId?: string;
      deliveryQueueStateDir?: string;
      skipQueue?: boolean;
    };
    expect(deliverInput.deliveryQueueId).toBe(id);
    expect(deliverInput.deliveryQueueStateDir).toBe(tmpDir());
    expect(deliverInput.skipQueue).toBe(true);
  });

  it("moves unknown-after-send entries to failed without replaying", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "failed", `${id}.json`))).toBe(true);
    expectMockMessageContaining(log.warn, "refusing blind replay without adapter reconciliation");
  });

  it("runs recovered send commit hooks only after the queue entry is acked", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    const order: string[] = [];
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        order.push(
          fs.existsSync(path.join(tmpDir(), "delivery-queue", "pending", `${id}.json`))
            ? "commit-before-ack"
            : "commit-after-ack",
        );
      },
    );
    const deliver = vi.fn(async () => {
      order.push("deliver");
      return [result];
    });

    await runRecovery({ deliver });

    expect(order).toEqual(["deliver", "commit-after-ack"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir(), "delivery-queue", "pending", `${id}.json`))).toBe(
      false,
    );
  });

  it("replays stored delivery options during recovery", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        replyToId: "root-message",
        replyToMode: "first",
        formatting: {
          textLimit: 1234,
          maxLinesPerMessage: 7,
          tableMode: "off",
          chunkMode: "newline",
        },
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        gatewayClientScopes: ["operator.write"],
        mirror: {
          sessionKey: "agent:main:main",
          text: "a",
          mediaUrls: ["https://example.com/a.png"],
        },
        session: {
          key: "agent:main:main",
          agentId: "agent-main",
          requesterAccountId: "acct-1",
          requesterSenderId: "sender-1",
          requesterSenderName: "Sender One",
          requesterSenderUsername: "sender.one",
          requesterSenderE164: "+15551234567",
        },
      },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    const deliverInput = mockCallArg(deliver) as {
      bestEffort?: boolean;
      gifPlayback?: boolean;
      silent?: boolean;
      replyToId?: string;
      replyToMode?: string;
      formatting?: unknown;
      gatewayClientScopes?: string[];
      mirror?: unknown;
      session?: unknown;
    };
    expect(deliverInput.bestEffort).toBe(true);
    expect(deliverInput.gifPlayback).toBe(true);
    expect(deliverInput.silent).toBe(true);
    expect(deliverInput.replyToId).toBe("root-message");
    expect(deliverInput.replyToMode).toBe("first");
    expect(deliverInput.formatting).toEqual({
      textLimit: 1234,
      maxLinesPerMessage: 7,
      tableMode: "off",
      chunkMode: "newline",
    });
    expect(deliverInput.gatewayClientScopes).toEqual(["operator.write"]);
    expect(deliverInput.mirror).toEqual({
      sessionKey: "agent:main:main",
      text: "a",
      mediaUrls: ["https://example.com/a.png"],
    });
    expect(deliverInput.session).toEqual({
      key: "agent:main:main",
      agentId: "agent-main",
      requesterAccountId: "acct-1",
      requesterSenderId: "sender-1",
      requesterSenderName: "Sender One",
      requesterSenderUsername: "sender.one",
      requesterSenderE164: "+15551234567",
    });
  });

  it("respects maxRecoveryMs time budget and bumps deferred retries", async () => {
    await enqueueCrashRecoveryEntries();
    await enqueueDelivery(
      { channel: "demo-channel-c", to: "#c", payloads: [{ text: "c" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 0,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(3);
    const entriesWithUnexpectedRetryCount = remaining.filter((entry) => entry.retryCount !== 1);
    expect(entriesWithUnexpectedRetryCount).toStrictEqual([]);
    expectMockMessageContaining(log.warn, "deferred to next startup");
  });

  it("defers entries until backoff becomes eligible", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: Date.now() });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 60_000,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    expectMockMessageContaining(log.info, "not ready for retry yet");
  });

  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "blocked" }] },
      tmpDir(),
    );
    const readyId = await enqueueDelivery(
      { channel: "demo-channel-b", to: "2", payloads: [{ text: "ready" }] },
      tmpDir(),
    );

    setQueuedEntryState(tmpDir(), blockedId, {
      retryCount: 3,
      lastAttemptAt: now,
      enqueuedAt: now - 30_000,
    });
    setQueuedEntryState(tmpDir(), readyId, { retryCount: 0, enqueuedAt: now - 10_000 });

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });

    expect(result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverInput = mockCallArg(deliver) as {
      channel?: string;
      to?: string;
      skipQueue?: boolean;
    };
    expect(deliverInput.channel).toBe("demo-channel-b");
    expect(deliverInput.to).toBe("2");
    expect(deliverInput.skipQueue).toBe(true);

    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });

  it("recovers deferred entries on a later restart once backoff elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "later" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: start.getTime() });

    const firstDeliver = vi.fn().mockResolvedValue([]);
    const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
    expect(firstRun.result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 1,
    });
    expect(firstDeliver).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
    const secondDeliver = vi.fn().mockResolvedValue([]);
    const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
    expect(secondRun.result).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);

    vi.useRealTimers();
  });

  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });

    expect(result).toEqual({
      recovered: 0,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
