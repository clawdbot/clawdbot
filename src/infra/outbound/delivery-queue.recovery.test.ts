// Covers startup delivery recovery, backoff, permanent failures, unknown-send
// reconciliation, commit hooks, and retry budget deferral.
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../../test/helpers/infra/delivery-recovery.js";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import {
  beginConversationDeliveryOperation,
  getConversationDeliveryOperation,
  markConversationDeliveryRejected,
  markConversationDeliverySuppressed,
} from "../../config/sessions/conversation-delivery-store.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
import { loadPendingDeliveries, reserveDeliveryAttempt } from "./delivery-queue-storage.js";
import {
  ackDelivery,
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  recoverPendingDeliveries,
  type DeliverFn,
} from "./delivery-queue.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const RECOVERY_REPLAY_SPACING_MS = 250;
const MAX_RETRIES = 5;
const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));
vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));

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

function readOutboundQueueStatus(tmpDir: string, id: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
  });
  const row = db
    .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?")
    .get(id) as { status?: string } | undefined;
  return row?.status;
}

describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};

  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  const enqueueCrashRecoveryEntries = async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        preparedMessageId: "prepared-message-a",
      },
      tmpDir(),
    );
    await enqueueDelivery(
      {
        channel: "demo-channel-b",
        to: "2",
        payloads: [{ text: "b" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      },
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
    expect(deliver.mock.calls.map(([params]) => params.queuePolicy)).toEqual([
      undefined,
      "required",
    ]);
    expect(deliver.mock.calls.map(([params]) => params.requireUnknownSendReconciliation)).toEqual([
      undefined,
      true,
    ]);
    expect(deliver.mock.calls.map(([params]) => params.preparedMessageId)).toEqual([
      "prepared-message-a",
      undefined,
    ]);
    expect(result).toEqual({
      recovered: 2,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });

    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });

  it("finalizes a persisted conversation operation during queue recovery", async () => {
    const storePath = path.join(tmpDir(), "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    await upsertSessionEntry(
      { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
      {
        sessionId: "reef-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    beginConversationDeliveryOperation(scope, {
      operationId: "operation-recovery",
      operationKind: "send",
      conversationRef,
      message: "hello",
      preparedMessageId: "reef-prepared",
    });
    await enqueueDeliveryOnce(
      {
        channel: "reef",
        to: "reef:peer-agent",
        queuePolicy: "required",
        payloads: [{ text: "hello" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-recovery",
          storePath,
        },
      },
      "operation-recovery",
      tmpDir(),
    );
    const deliveryResult = { channel: "reef" as const, messageId: "reef-platform" };
    const deliver = vi.fn(async (params: { onDeliveryResult?: (result: unknown) => unknown }) => {
      await params.onDeliveryResult?.(deliveryResult);
      return [deliveryResult];
    });

    try {
      const { result } = await runRecovery({ deliver });

      expect(result.recovered).toBe(1);
      expect(getConversationDeliveryOperation(scope, "operation-recovery")).toMatchObject({
        status: "sent",
        queueId: "operation-recovery",
        platformMessageId: "reef-platform",
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("acks a persisted suppressed conversation operation without replaying it", async () => {
    const storePath = path.join(tmpDir(), "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    await upsertSessionEntry(
      { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
      {
        sessionId: "reef-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    beginConversationDeliveryOperation(scope, {
      operationId: "operation-suppressed",
      operationKind: "send",
      conversationRef,
      message: "hello",
      preparedMessageId: "reef-prepared",
    });
    await enqueueDeliveryOnce(
      {
        channel: "reef",
        to: "reef:peer-agent",
        queuePolicy: "required",
        payloads: [{ text: "hello" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-suppressed",
          storePath,
        },
      },
      "operation-suppressed",
      tmpDir(),
    );
    markConversationDeliverySuppressed(scope, "operation-suppressed");
    const deliver = vi.fn();

    try {
      const { result } = await runRecovery({ deliver });

      expect(result.recovered).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(getConversationDeliveryOperation(scope, "operation-suppressed")?.status).toBe(
        "suppressed",
      );
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("acks a persisted rejected conversation operation without replaying it", async () => {
    const storePath = path.join(tmpDir(), "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    await upsertSessionEntry(
      { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
      {
        sessionId: "reef-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
        origin: {
          provider: "reef",
          accountId: "default",
          nativeDirectUserId: "peer-agent",
        },
      },
    );
    beginConversationDeliveryOperation(scope, {
      operationId: "operation-rejected",
      operationKind: "send",
      conversationRef,
      message: "hello",
      preparedMessageId: "reef-prepared",
    });
    await enqueueDeliveryOnce(
      {
        channel: "reef",
        to: "reef:peer-agent",
        queuePolicy: "required",
        payloads: [{ text: "hello" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-rejected",
          storePath,
        },
      },
      "operation-rejected",
      tmpDir(),
    );
    markConversationDeliveryRejected(scope, "operation-rejected", "atomic message limit");
    const deliver = vi.fn();

    try {
      const { result } = await runRecovery({ deliver });

      expect(result.failed).toBe(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(getConversationDeliveryOperation(scope, "operation-rejected")).toMatchObject({
        status: "rejected",
        rejectionError: "atomic message limit",
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("permanently rejects provider-blocked rows before backoff or reconciliation", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "slack",
        to: "C123",
        accountId: "enterprise",
        payloads: [{ text: "blocked" }],
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now(),
      recoveryState: "unknown_after_send",
      platformSendStartedAt: Date.now(),
    });
    const admitDeferredDelivery = vi.fn(() => ({
      status: "permanent_rejection" as const,
      reason: "unsupported_enterprise_slack_delivery",
    }));
    const reconcileUnknownSend = vi.fn();
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { admitDeferredDelivery, reconcileUnknownSend },
    });
    const deliver = vi.fn();

    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(admitDeferredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "enterprise",
        channel: "slack",
        phase: "recovery",
        to: "C123",
      }),
    );
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(readQueuedEntry(tmpDir(), id).lastError).toBe("unsupported_enterprise_slack_delivery");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      failureStage: "queue",
    });

    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { admitDeferredDelivery: () => ({ status: "allowed" }) },
    });
    await runRecovery({ deliver });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("paces startup replay instead of draining eligible entries back-to-back", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueCrashRecoveryEntries();
      const deliveryTimes: number[] = [];
      const deliver = vi.fn(async () => {
        deliveryTimes.push(Date.now());
        return [];
      });

      const recovery = runRecovery({ deliver, maxRecoveryMs: 60_000 });

      await expect(controlledSleep.started).resolves.toBe(RECOVERY_REPLAY_SPACING_MS);
      expect(deliver).toHaveBeenCalledTimes(1);
      controlledSleep.release();
      const { result } = await recovery;

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(deliveryTimes[1]).toBe(startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS);
      expect(result).toMatchObject({ recovered: 2, deferredBackoff: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts replay pacing against the recovery budget and defers the backlog tail", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueCrashRecoveryEntries();
      await enqueueDelivery(
        { channel: "demo-channel-c", to: "#c", payloads: [{ text: "c" }] },
        tmpDir(),
      );
      const deliveryTimes: number[] = [];
      const deliver = vi.fn(async () => {
        deliveryTimes.push(Date.now());
        return [];
      });

      const recovery = runRecovery({ deliver, maxRecoveryMs: 1 });

      await expect(controlledSleep.started).resolves.toBe(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      controlledSleep.release();
      const { result } = await recovery;

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliveryTimes).toEqual([startedAt.getTime()]);
      expect(result).toMatchObject({ recovered: 1, deferredBackoff: 0 });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });

    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "failed",
      failureStage: "queue",
    });
  });

  it("honors a producer-specific retry budget", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        maxRetries: 45,
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now() - 10_000_000,
    });
    const deliver = vi.fn().mockResolvedValue([]);

    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ recovered: 1, skippedMaxRetries: 0 });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });

  it("dead-letters an atomically exhausted attempt budget before replay", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        maxRetries: 1,
      },
      tmpDir(),
    );
    await reserveDeliveryAttempt(id, 1, tmpDir());
    const deliver = vi.fn();

    const { result } = await runRecovery({ deliver });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
  });

  it("ignores an invalid producer retry budget", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        maxRetries: 0.5,
      },
      tmpDir(),
    );
    const deliver = vi.fn().mockResolvedValue([]);

    const { result } = await runRecovery({ deliver });

    expect(deliver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ recovered: 1, skippedMaxRetries: 0 });
  });

  it("dead-letters max-retry entries even when conversation owner state is missing", async () => {
    const storePath = path.join(tmpDir(), "missing-owner-sessions.json");
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "missing-operation",
          storePath,
        },
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });
    const log = createRecoveryLog();

    try {
      const { result } = await runRecovery({ deliver: vi.fn(), log });

      expect(result.skippedMaxRetries).toBe(1);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
      expectMockMessageContaining(log.warn, "owner state could not be marked unknown");
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("audits max-retry deadletters as unknown when platform send may have started", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now() - 10_000_000,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });

    const { result } = await runRecovery({ deliver: vi.fn() });
    unsubscribe();

    expect(result).toMatchObject({ failed: 1, skippedMaxRetries: 0 });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "unknown",
      failureStage: "queue",
    });
  });

  it("increments retryCount on failed recovery attempt", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.attemptCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
    expect(auditEvents).toEqual([]);
  });

  it("keeps a repeated pre-connect recovery failure replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );
    const connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw connectError;
    });

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("keeps a repeated provider-not-dispatched recovery failure replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-c", to: "#ch", payloads: [{ text: "x" }] },
      tmpDir(),
    );
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw new PlatformMessageNotDispatchedError("upload stopped before finalization", {
        cause: new Error("request timed out"),
      });
    });

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("does not replay a recovery batch that rejected after an earlier send succeeded", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
      },
      tmpDir(),
    );
    const partialFailure = new OutboundDeliveryError("second send failed", {
      cause: new Error("network down"),
      results: [{ channel: "demo-channel-c", messageId: "m1" }],
    });

    const { result } = await runRecovery({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.retryCount).toBe(0);

    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
  });

  it("keeps a best-effort recovery failure retryable when no payload was sent", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new Error("network down"),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.lastError).toBe("network down");
  });

  it("clears send evidence for an all-pre-connect best-effort recovery failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
            code: "EAI_AGAIN",
            syscall: "getaddrinfo",
          }),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("clears send evidence for an all-not-dispatched best-effort recovery failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new PlatformMessageNotDispatchedError(
            "upload timed out before completion dispatch",
            { cause: new Error("request timed out") },
          ),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBeUndefined();
    expect(entries[0]?.platformSendStartedAt).toBeUndefined();
  });

  it("preserves send evidence when a marked recovery batch has an ambiguous failure", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new PlatformMessageNotDispatchedError(
            "upload timed out before completion dispatch",
            { cause: new Error("request timed out") },
          ),
          sentBeforeError: false,
          stage: "platform_send",
        });
        params.onPayloadDeliveryOutcome?.({
          index: 1,
          status: "failed",
          error: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
            syscall: "read",
          }),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.retryCount).toBe(1);
    expect(entries[0]?.recoveryState).toBe("send_attempt_started");
    expect(typeof entries[0]?.platformSendStartedAt).toBe("number");
  });

  it("does not ack a partially sent best-effort recovery batch", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-c",
        to: "#ch",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        params.onPayloadDeliveryOutcome?.({
          index: 1,
          status: "failed",
          error: new Error("second send failed"),
          sentBeforeError: true,
          stage: "platform_send",
        });
        return [{ channel: "demo-channel-c", messageId: "m1" }];
      },
    );

    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.recoveryState).toBe("unknown_after_send");
    expect(entries[0]?.retryCount).toBe(0);

    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
  });

  it("moves entries abandoned after platform send may have started to failed without reconciliation", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
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
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({
      recovered: 0,
      failed: 1,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "unknown_after_send");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      failureStage: "queue",
    });
  });

  it("reports every payload unknown when a multi-payload send is crash-ambiguous", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "sent" }, { text: "hidden" }],
      },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });

    await runRecovery({ deliver: vi.fn() });
    unsubscribe();

    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "unknown",
      outcome: "unknown",
      resultCount: 0,
    });
    expect(auditEvents[1]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:1`,
      status: "unknown",
      outcome: "unknown",
      resultCount: 0,
    });
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
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
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        accountId: "acct-1",
        payloads: [{ text: "maybe sent" }],
        replyToId: "root-message",
        threadId: "thread-1",
        silent: true,
        maxRetries: 1,
      },
      tmpDir(),
    );
    await reserveDeliveryAttempt(id, 1, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
      replyToId: "hooked-root-message",
    });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
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

    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    unsubscribe();

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
      effectiveReplyToId?: string;
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
    expect(reconcileInput.effectiveReplyToId).toBe("hooked-root-message");
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
    expect(afterCommitInput.replyToId).toBe("hooked-root-message");
    expect(afterCommitInput.threadId).toBe("thread-1");
    expect(afterCommitInput.silent).toBe(true);
    expect(afterCommitInput.result?.messageId).toBe("platform-1");
    expect(order).toEqual(["afterCommit"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      status: "succeeded",
      outcome: "sent",
      messageId: "platform-1",
      resultCount: 1,
    });
  });

  it("moves unknown-after-send entries to failed when adapter reports not sent", async () => {
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "refusing full replay after post-send evidence");
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

  it("dead-letters an exhausted unknown send after retryable reconciliation fails", async () => {
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "unknown final attempt" }],
        maxRetries: 1,
      },
      tmpDir(),
    );
    await reserveDeliveryAttempt(id, 1, tmpDir());
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      lastAttemptAt: Date.now() - 10_000_000,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
      },
    });
    const deliver = vi.fn().mockResolvedValue([]);

    const { result } = await runRecovery({ deliver });

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, skippedMaxRetries: 0 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("moves typed permanent platform rejections to failed without retry backoff", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel", to: "user:abc", payloads: [{ text: "hi" }] },
      tmpDir(),
    );
    const deliver = vi.fn().mockRejectedValue(
      new PlatformMessageNotDispatchedError("atomic message limit", {
        cause: new Error("rendered text is too large"),
        retryable: false,
      }),
    );
    const { result } = await runRecovery({ deliver });

    expect(result).toMatchObject({ failed: 1, recovered: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    expectMockMessageContaining(log.warn, "permanent error");
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );

    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });

    const deliverInput = mockCallArg(deliver) as { skipQueue?: boolean };
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
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
        const pending = await loadPendingDeliveries(tmpDir());
        order.push(
          pending.some((entry) => entry.id === id) ? "commit-before-ack" : "commit-after-ack",
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
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });

  it("does not restore an acked entry when a recovered send commit hook fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        throw new Error("commit hook offline");
      },
    );
    const deliver = vi.fn().mockResolvedValue([result]);

    const { result: summary } = await runRecovery({ deliver });

    expect(summary).toEqual({
      recovered: 1,
      failed: 0,
      skippedMaxRetries: 0,
      deferredBackoff: 0,
    });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });

  it("marks a recovered send unknown before ack so ack failure cannot make it replayable", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    let recoveryStateAtAck: string | undefined;
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        ackDelivery: vi.fn(async (entryId: string, stateDir?: string) => {
          recoveryStateAtAck = (await actual.loadPendingDelivery(entryId, stateDir))?.recoveryState;
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithAckFailure } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithAckFailure({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        log: createRecoveryLog(),
        cfg: baseCfg,
        stateDir: tmpDir(),
      });

      expect(summary).toEqual({
        recovered: 0,
        failed: 1,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(recoveryStateAtAck).toBe("unknown_after_send");
      const pending = await loadPendingDeliveries(tmpDir());
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(id);
      expect(pending[0]?.recoveryState).toBe("unknown_after_send");
      expect(pending[0]?.lastError).toContain("ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("keeps a recovered zero-result delivery retryable when ack fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        ackDelivery: vi.fn(async () => {
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithAckFailure } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithAckFailure({
        deliver: asDeliverFn(vi.fn().mockResolvedValue([])),
        log: createRecoveryLog(),
        cfg: baseCfg,
        stateDir: tmpDir(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      const pending = await loadPendingDeliveries(tmpDir());
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(id);
      expect(pending[0]?.recoveryState).toBeUndefined();
      expect(pending[0]?.retryCount).toBe(1);
      expect(pending[0]?.lastError).toContain("ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("directly acks a recovered send when its post-send marker fails", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const log = createRecoveryLog();
      const summary = await recoverWithMarkFailure({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log,
      });

      expect(summary).toEqual({
        recovered: 1,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectMockMessageContaining(log.warn, "falling back to direct ack");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("retains later media until an early recovery ack finishes the batch", async () => {
    const spoolDir = path.join(tmpDir(), "delivery-queue-media");
    const firstArtifact = path.join(spoolDir, "00000000-0000-4000-8000-000000000001.ogg");
    const secondArtifact = path.join(spoolDir, "00000000-0000-4000-8000-000000000002.ogg");
    await fs.mkdir(spoolDir, { recursive: true });
    await fs.writeFile(firstArtifact, "first-audio");
    await fs.writeFile(secondArtifact, "second-audio");
    const oldArtifactTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await fs.utimes(firstArtifact, oldArtifactTime, oldArtifactTime);
    await fs.utimes(secondArtifact, oldArtifactTime, oldArtifactTime);
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ mediaUrl: firstArtifact }, { mediaUrl: secondArtifact }],
      },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const firstResult = { channel: "demo-channel-a", messageId: "m1" };
      const secondResult = { channel: "demo-channel-a", messageId: "m2" };
      const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
        await params.onDeliveryResult?.(firstResult);
        await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
        expect(await fs.readFile(secondArtifact, "utf8")).toBe("second-audio");
        await params.onDeliveryResult?.(secondResult);
        return [firstResult, secondResult];
      });

      const summary = await recoverWithMarkFailure({
        deliver,
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 1, failed: 0 });
      await expect(fs.stat(firstArtifact)).rejects.toThrow();
      await expect(fs.stat(secondArtifact)).rejects.toThrow();
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("owns the stable terminal when recovery fallback ack precedes provider rejection", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const id = await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        queuePolicy: "best_effort",
        payloads: [{ text: "secret" }],
      },
      tmpDir(),
    );
    const deliver = vi.fn(
      async (params: {
        onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      }) => {
        await ackDelivery(id, tmpDir());
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new Error("provider rejected send"),
          sentBeforeError: false,
          stage: "platform_send",
        });
        throw new Error("provider rejected send");
      },
    );

    const { result } = await runRecovery({ deliver });
    unsubscribe();

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      sourceId: `message:outbound:queue:${id}:payload:0`,
      outcome: "failed",
      failureStage: "platform_send",
    });
    expect(JSON.stringify(auditEvents)).not.toContain("secret");
    expect(JSON.stringify(auditEvents)).not.toContain("provider rejected send");
  });

  it("runs recovered commit hooks when marker fallback ack precedes a partial failure", async () => {
    await enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "first" }, { text: "second" }],
        bestEffort: true,
      },
      tmpDir(),
    );
    const afterCommit = vi.fn();
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithMarkFailure } =
        await import("./delivery-queue-recovery.js");
      const { attachOutboundDeliveryCommitHook: attachHookAfterReset } =
        await import("./delivery-commit-hooks.js");
      const result = attachHookAfterReset(
        { channel: "demo-channel-a", messageId: "m1" },
        afterCommit,
      );
      const summary = await recoverWithMarkFailure({
        deliver: asDeliverFn(
          vi.fn(
            async (params: {
              onDeliveryResult?: (deliveryResult: typeof result) => Promise<void> | void;
              onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
            }) => {
              await params.onDeliveryResult?.(result);
              params.onPayloadDeliveryOutcome?.({
                index: 1,
                status: "failed",
                error: new Error("second send failed"),
                sentBeforeError: false,
                stage: "platform_send",
              });
              return [result];
            },
          ),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  });

  it("retains unknown-after-send when recovered-send marking and ack both fail", async () => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "a" }] },
      tmpDir(),
    );
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<typeof import("./delivery-queue-storage.js")>(
        "./delivery-queue-storage.js",
      );
      return {
        ...actual,
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
        ackDelivery: vi.fn(async () => {
          throw new Error("ack state db locked");
        }),
      };
    });

    try {
      const { recoverPendingDeliveries: recoverWithStateFailures } =
        await import("./delivery-queue-recovery.js");
      const summary = await recoverWithStateFailures({
        deliver: asDeliverFn(
          vi.fn().mockResolvedValue([{ channel: "demo-channel-a", messageId: "m1" }]),
        ),
        cfg: baseCfg,
        stateDir: tmpDir(),
        log: createRecoveryLog(),
      });

      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
      const entries = await loadPendingDeliveries(tmpDir());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.id).toBe(id);
      expect(entries[0]?.recoveryState).toBe("unknown_after_send");
      expect(entries[0]?.retryCount).toBe(1);
      expect(entries[0]?.lastError).toContain("marker=post-send state db locked");
      expect(entries[0]?.lastError).toContain("ack=ack state db locked");
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
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
          expectedSessionId: "session-main",
          text: "a",
          mediaUrls: ["https://example.com/a.png"],
          idempotencyKey: "channel-final:message-1",
          deliveryMirror: {
            kind: "channel-final",
            sourceMessageId: "message-1",
          },
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
      expectedSessionId: "session-main",
      text: "a",
      mediaUrls: ["https://example.com/a.png"],
      idempotencyKey: "channel-final:message-1",
      deliveryMirror: {
        kind: "channel-final",
        sourceMessageId: "message-1",
      },
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

  it("respects maxRecoveryMs time budget without bumping deferred retries", async () => {
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
    expect(remaining.map((entry) => entry.retryCount)).toStrictEqual([0, 0, 0]);
    expectMockMessageContaining(log.warn, "deferred to next startup");
  });

  it("defers recovery when the recovery deadline would exceed the Date timestamp range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    try {
      await enqueueCrashRecoveryEntries();
      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({
        deliver,
        maxRecoveryMs: 1,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual({
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
      expectMockMessageContaining(log.warn, "deferred to next startup");
    } finally {
      vi.useRealTimers();
    }
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
