import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { scheduleTimedOutMainSessionRecovery } from "./main-session-timeout-recovery.js";

const transcriptReaderMocks = vi.hoisted(() => ({
  readSessionMessagesAsync: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async ({ params }: { params: { idempotencyKey: string } }) => ({
    runId: params.idempotencyKey,
    status: "accepted",
  })),
}));

vi.mock("../gateway/session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/session-transcript-readers.js")>();
  transcriptReaderMocks.readSessionMessagesAsync.mockImplementation(
    actual.readSessionMessagesAsync,
  );
  return {
    ...actual,
    readSessionMessagesAsync: transcriptReaderMocks.readSessionMessagesAsync,
  };
});

const cfg = {} as OpenClawConfig;
const sessionKey = "agent:main:slack:channel:c0bly1apgh5";
const sessionId = "slack-session";
const runId = "req_27a0924bb52678eefb17de80c8816ede";
let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-timeout-recovery-"));
  storePath = path.join(tmpDir, "sessions.json");
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeEntry(entry: Partial<SessionEntry> = {}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId,
      updatedAt: Date.now(),
      status: "timeout",
      abortedLastRun: true,
      restartRecoveryDeliveryContext: {
        channel: "slack",
        to: "C0BLY1APGH5",
        threadId: "1785613439.266819",
      },
      restartRecoveryDeliveryRunId: runId,
      ...entry,
    },
  );
  await appendTranscriptMessage(
    { sessionId, sessionKey, storePath },
    { cwd: tmpDir, message: { role: "user", content: "finish the Ceto research" } },
  );
}

describe("scheduleTimedOutMainSessionRecovery", () => {
  it("hands the exact timed-out Slack claim to transcript recovery", async () => {
    await writeEntry({ abortedLastRun: false });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    expect(vi.mocked(callGateway).mock.calls.map(([call]) => call.method)).toEqual([
      "agent",
      "agent.wait",
    ]);
    const firstCall = vi.mocked(callGateway).mock.calls[0]?.[0] as {
      params: Record<string, unknown>;
    };
    const recoveryRunId = firstCall.params.idempotencyKey;
    expect(recoveryRunId).toEqual(expect.any(String));
    expect(recoveryRunId).not.toBe(runId);
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "agent",
      params: {
        channel: "slack",
        deliver: true,
        expectedExistingSessionId: sessionId,
        idempotencyKey: recoveryRunId,
        message: expect.stringContaining("exceeded the gateway run deadline"),
        sessionKey,
        threadId: "1785613439.266819",
        to: "C0BLY1APGH5",
      },
    });
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).not.toMatchObject({
      params: { message: expect.stringContaining("gateway restart") },
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: recoveryRunId,
      restartRecoveryInterruptionReason: "gateway_timeout",
      restartRecoveryTimeoutAttemptCount: 1,
      sessionId,
      status: "running",
    });
  });

  it("does not adopt a queue-owned source claim", async () => {
    await writeEntry({ restartRecoveryDeliverySourceRunId: runId });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      restartRecoveryDeliverySourceRunId: runId,
      status: "timeout",
    });
  });

  it("does not mutate a timeout row that is not eligible for recovery", async () => {
    const endedAt = Date.now() - 1_000;
    await writeEntry({
      abortedLastRun: false,
      endedAt,
      initializationPending: true,
      runtimeMs: 10_000,
    });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: false,
      endedAt,
      initializationPending: true,
      restartRecoveryDeliveryRunId: runId,
      runtimeMs: 10_000,
      status: "timeout",
    });
  });

  it("reuses the rotated recovery id after an ambiguous dispatch failure", async () => {
    await writeEntry({ abortedLastRun: false });
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("transport unavailable"));

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 2,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    const calls = vi.mocked(callGateway).mock.calls.map(
      ([call]) =>
        call as never as {
          method: string;
          params: Record<string, unknown>;
        },
    );
    expect(calls.map((call) => call.method)).toEqual(["agent", "agent", "agent.wait"]);
    expect(calls[0]?.params.idempotencyKey).toEqual(expect.any(String));
    expect(calls[0]?.params.idempotencyKey).not.toBe(runId);
    expect(calls[1]?.params.idempotencyKey).toBe(calls[0]?.params.idempotencyKey);
    expect(calls[2]?.params.runId).toBe(calls[0]?.params.idempotencyKey);
  });

  it("reuses the durably rotated id after a failure before dispatch", async () => {
    await writeEntry({ abortedLastRun: false });
    transcriptReaderMocks.readSessionMessagesAsync.mockRejectedValueOnce(
      new Error("transcript still settling"),
    );

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 2,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    expect(vi.mocked(callGateway).mock.calls.map(([call]) => call.method)).toEqual([
      "agent",
      "agent.wait",
    ]);
    const firstCall = vi.mocked(callGateway).mock.calls[0]?.[0];
    expect(firstCall).toBeDefined();
    const recoveryRunId = (firstCall!.params as { idempotencyKey?: unknown }).idempotencyKey;
    expect(recoveryRunId).toEqual(expect.any(String));
    expect(recoveryRunId).not.toBe(runId);
    expect(loadSessionEntry({ sessionKey, storePath })?.restartRecoveryDeliveryRunId).toBe(
      recoveryRunId,
    );
  });

  it("leaves a still-owned run durable instead of dispatching concurrently", async () => {
    await writeEntry({ abortedLastRun: false, status: "running" });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: runId,
      status: "running",
    });
  });

  it("does not reuse the terminalized id from a concurrent restart marker", async () => {
    await writeEntry({ abortedLastRun: true, status: "running" });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: runId,
      status: "running",
    });
  });

  it("posts one terminal failure after the durable timeout budget is exhausted", async () => {
    await writeEntry({ restartRecoveryTimeoutAttemptCount: 3 });

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: runId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    expect(callGateway).toHaveBeenCalledOnce();
    expect(vi.mocked(callGateway).mock.calls[0]?.[0]).toMatchObject({
      method: "message.action",
      params: {
        action: "send",
        channel: "slack",
        params: {
          message: expect.stringContaining("exceeded the gateway run deadline"),
          threadId: "1785613439.266819",
          to: "C0BLY1APGH5",
        },
        sessionId,
        sessionKey,
      },
    });
    const failedEntry = loadSessionEntry({ sessionKey, storePath });
    expect(failedEntry).toMatchObject({
      abortedLastRun: true,
      status: "failed",
    });
    expect(failedEntry?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(failedEntry?.restartRecoveryInterruptionReason).toBeUndefined();
    expect(failedEntry?.restartRecoveryTimeoutAttemptCount).toBeUndefined();
    expect(failedEntry?.restartRecoveryTimeoutExhausted).toBeUndefined();
  });

  it("accrues the timeout budget across fresh continuation run ids", async () => {
    await writeEntry({ abortedLastRun: false });
    let timedOutRunId = runId;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        scheduleTimedOutMainSessionRecovery({
          canonicalSessionKey: sessionKey,
          cfg,
          delayMs: 0,
          expectedRunId: timedOutRunId,
          expectedSessionId: sessionId,
          maxRetries: 1,
          sessionKeys: [sessionKey],
          storePath,
        }),
      ).resolves.toBe(true);
      const entry = loadSessionEntry({ sessionKey, storePath });
      expect(entry?.restartRecoveryTimeoutAttemptCount).toBe(attempt);
      timedOutRunId = entry?.restartRecoveryDeliveryRunId ?? "";
      expect(timedOutRunId).not.toBe(runId);
      await replaceSessionEntry(
        { sessionKey, storePath },
        { ...entry!, abortedLastRun: true, status: "timeout", updatedAt: Date.now() },
      );
    }

    await expect(
      scheduleTimedOutMainSessionRecovery({
        canonicalSessionKey: sessionKey,
        cfg,
        delayMs: 0,
        expectedRunId: timedOutRunId,
        expectedSessionId: sessionId,
        maxRetries: 1,
        sessionKeys: [sessionKey],
        storePath,
      }),
    ).resolves.toBe(true);

    const methods = vi.mocked(callGateway).mock.calls.map(([call]) => call.method);
    expect(methods).toEqual([
      "agent",
      "agent.wait",
      "agent",
      "agent.wait",
      "agent",
      "agent.wait",
      "message.action",
    ]);
    expect(loadSessionEntry({ sessionKey, storePath })?.status).toBe("failed");
  });
});
