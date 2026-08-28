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
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { buildConversationRef } from "../../routing/conversation-ref.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "./delivery-commit-hooks.js";
import { pruneOrphanedDeliveryQueueMedia } from "./delivery-queue-media-spool.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { recoverPendingDeliveries, type DeliverFn } from "./delivery-queue-recovery.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  reserveDeliveryAttempt,
} from "./delivery-queue-storage.js";
import {
  loadPendingDeliveries,
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";
const RECOVERY_REPLAY_SPACING_MS = 250;
const MAX_RETRIES = 5;
const BLIND_REPLAY_LOG = "refusing blind replay without adapter reconciliation";
const BOUNDED_COMPLETION_RETENTION = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;
const RECOVERY_SUMMARY = {
  deferred: { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 1 },
  empty: { recovered: 0, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 },
  failed: { recovered: 0, failed: 1, skippedMaxRetries: 0, deferredBackoff: 0 },
  recovered: { recovered: 1, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 },
  recoveredWithDeferred: { recovered: 1, failed: 0, skippedMaxRetries: 0, deferredBackoff: 1 },
  twoRecovered: { recovered: 2, failed: 0, skippedMaxRetries: 0, deferredBackoff: 0 },
} as const;
const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));
vi.mock("../../utils/sleep.js", () => ({ sleep: sleepMock }));
function mockCallRecord(mock: { mock: { calls: unknown[][] } }, index = 0) {
  const value = mock.mock.calls[index]?.[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected mock call ${index} argument to be a record`);
  }
  return value as Record<string, unknown>;
}
function expectMockMessageContaining(mock: { mock: { calls: unknown[][] } }, expected: string) {
  const messages = mock.mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}
function captureAuditEvents() {
  const auditEvents: TrustedMessageAuditEvent[] = [];
  return {
    auditEvents,
    unsubscribe: onTrustedMessageAuditEvent((event) => auditEvents.push(event)),
  };
}
function expectPayloadAudits(
  auditEvents: TrustedMessageAuditEvent[],
  queueId: string,
  expected: Array<Record<string, unknown>>,
) {
  expect(auditEvents).toHaveLength(expected.length);
  expected.forEach((event, index) =>
    expect(auditEvents[index]).toMatchObject({
      sourceId: `message:outbound:queue:${queueId}:payload:${index}`,
      ...event,
    }),
  );
}
type PayloadOutcomeSink = Pick<Parameters<DeliverFn>[0], "onPayloadDeliveryOutcome">;
function reportPayloadFailure(
  params: PayloadOutcomeSink,
  error: Error,
  overrides: Partial<OutboundPayloadDeliveryOutcome> = {},
) {
  params.onPayloadDeliveryOutcome?.({
    index: 0,
    status: "failed",
    error,
    sentBeforeError: false,
    stage: "platform_send",
    ...overrides,
  } as OutboundPayloadDeliveryOutcome);
}
function reconciledSent(messageId: string, sentAt = Date.now()) {
  return {
    status: "sent",
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt,
    },
  };
}
async function runIf(condition: unknown, action: () => unknown) {
  if (condition) {
    await action();
  }
}
function readOutboundQueueStatus(tmpDir: string, id: string): string | undefined {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir },
  });
  const row = db
    .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
  return row?.status;
}
describe("delivery-queue recovery", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const baseCfg = {};
  function enqueueRecoveryDelivery(params: Partial<Parameters<typeof enqueueDelivery>[0]> = {}) {
    return enqueueDelivery(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "a" }],
        ...params,
      },
      tmpDir(),
    );
  }
  function enqueueDemoRecoveryDelivery(
    texts: string[] = ["x"],
    params: Partial<Parameters<typeof enqueueDelivery>[0]> = {},
  ) {
    return enqueueRecoveryDelivery({
      channel: "demo-channel-c",
      to: "#ch",
      payloads: texts.map((text) => ({ text })),
      ...params,
    });
  }
  function installUnknownSendAdapter(
    reconcileUnknownSend: ReturnType<typeof vi.fn>,
    durableFinal: Record<string, unknown> = {},
    adapter: Record<string, unknown> = {},
  ) {
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      ...adapter,
      durableFinal: {
        capabilities: { reconcileUnknownSend: true },
        reconcileUnknownSend,
        ...durableFinal,
      },
    });
  }
  function installUnknownSendResult(
    result: Record<string, unknown>,
    durableFinal: Record<string, unknown> = {},
  ) {
    const reconcileUnknownSend = vi.fn().mockResolvedValue(result);
    installUnknownSendAdapter(reconcileUnknownSend, durableFinal);
    return reconcileUnknownSend;
  }
  async function enqueueUnknownRecovery(params: {
    text: string;
    state?: "send_attempt_started" | "unknown_after_send";
    delivery?: Partial<Parameters<typeof enqueueDelivery>[0]>;
    queue?: Record<string, unknown>;
  }) {
    const id = await enqueueRecoveryDelivery({
      payloads: [{ text: params.text }],
      ...params.delivery,
    });
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: params.state ?? "unknown_after_send",
      ...params.queue,
    });
    return id;
  }
  async function expectFailedQueue(id: string) {
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  }
  async function expectPendingEntry(expected: Record<string, unknown>) {
    const entries = await loadPendingDeliveries(tmpDir());
    expect(entries).toHaveLength(1);
    const entry = entries[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(entry[key]).toEqual(value);
    }
    return entries[0];
  }
  async function enqueueClaimedRecoveryDelivery(
    id: string,
    delivery: Partial<Parameters<typeof enqueueDeliveryOnce>[0]>,
    route?: { replyToId: string | null },
  ) {
    await enqueueDeliveryOnce(
      {
        channel: "demo-channel-a",
        to: "+1",
        payloads: [{ text: "stable delivery" }],
        queuePolicy: "required",
        ...delivery,
      },
      id,
      tmpDir(),
    );
    const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
    if (!claimId) {
      throw new Error("test invariant: stable delivery must own its platform attempt");
    }
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), route, claimId);
    return claimId;
  }
  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });
  const enqueueCrashRecoveryEntries = async () => {
    await enqueueRecoveryDelivery({
      preparedMessageId: "prepared-message-a",
    });
    await enqueueRecoveryDelivery({
      channel: "demo-channel-b",
      to: "2",
      payloads: [{ text: "b" }],
      queuePolicy: "required",
      requireUnknownSendReconciliation: true,
    });
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
  type StorageModule = typeof import("./delivery-queue-storage.js");
  async function runRecoveryWithStorageOverrides(params: {
    overrides: (actual: StorageModule) => Partial<StorageModule>;
    deliver?: ReturnType<typeof vi.fn>;
    createDeliver?: () => Promise<ReturnType<typeof vi.fn>>;
  }) {
    vi.resetModules();
    vi.doMock("./delivery-queue-storage.js", async () => {
      const actual = await vi.importActual<StorageModule>("./delivery-queue-storage.js");
      return { ...actual, ...params.overrides(actual) };
    });
    try {
      const { recoverPendingDeliveries: recoverWithFailures } =
        await import("./delivery-queue-recovery.js");
      const log = createRecoveryLog();
      const deliver = params.deliver ?? (await params.createDeliver?.());
      if (!deliver) {
        throw new Error("Storage override recovery requires a delivery function");
      }
      const summary = await recoverWithFailures({
        deliver: asDeliverFn(deliver),
        log,
        cfg: baseCfg,
        stateDir: tmpDir(),
      });
      return { summary, log };
    } finally {
      vi.doUnmock("./delivery-queue-storage.js");
      vi.resetModules();
    }
  }
  async function createConversationRecoveryFixture(operationId: string) {
    const storePath = path.join(tmpDir(), "agent-sessions.json");
    const scope = { agentId: "main", storePath };
    const conversationRef = buildConversationRef({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "peer-agent",
    });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:reef:direct:peer-agent" },
      {
        sessionId: "reef-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "reef", accountId: "default", to: "reef:peer-agent" },
          origin: {
            provider: "reef",
            accountId: "default",
            nativeDirectUserId: "peer-agent",
          },
        }),
      },
    );
    beginConversationDeliveryOperation(scope, {
      operationId,
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
          operationId,
          storePath,
          routeFingerprint: "route-recovery",
        },
      },
      operationId,
      tmpDir(),
    );
    return scope;
  }
  async function createPendingFinalRecoveryFixture(deliveryId: string) {
    const sessionKey = "agent:main:demo-channel-a:direct:pending-final";
    const storePath = path.join(tmpDir(), "pending-final-sessions.json");
    const completion = {
      kind: "pending-final" as const,
      deliveryId,
      intentId: "pending-final-recovery-intent",
      sessionId: "pending-final-recovery-session",
      sessionKey,
      storePath,
    };
    const context = { channel: "demo-channel-a", to: "+1" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        status: "running",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "recovered delivery identity may have been lost",
          context,
          createdAt: Date.now(),
          intentId: completion.intentId,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
      },
    );
    await enqueueDeliveryOnce(
      {
        channel: "demo-channel-a",
        to: "+1",
        queuePolicy: "required",
        maxRetries: 1,
        payloads: [{ text: "recovered delivery identity may have been lost" }],
        deliveryCompletion: completion,
      },
      deliveryId,
      tmpDir(),
    );
    return { completion, context };
  }
  it("recovers entries from a simulated crash", async () => {
    await enqueueCrashRecoveryEntries();
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(
      deliver.mock.calls.map(([params]) => [
        params.queuePolicy,
        params.requireUnknownSendReconciliation,
        params.preparedMessageId,
      ]),
    ).toEqual([
      [undefined, undefined, "prepared-message-a"],
      ["required", true, undefined],
    ]);
    expect(result).toEqual(RECOVERY_SUMMARY.twoRecovered);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("finalizes a persisted conversation operation during queue recovery", async () => {
    const scope = await createConversationRecoveryFixture("operation-recovery");
    const deliveryResult = { channel: "reef" as const, messageId: "reef-platform" };
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      expect(params.deliveryCompletion).toBeUndefined();
      expect(params.conversationDeliveryAttemptAuthority).toEqual({
        agentId: "main",
        operationId: "operation-recovery",
        storePath: scope.storePath,
        routeFingerprint: "route-recovery",
      });
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
  it("keeps an uncertainty notice owed when recovery returns no delivery identity", async () => {
    const deliveryId = "pending-final-unknown-recovery";
    const { completion, context } = await createPendingFinalRecoveryFixture(deliveryId);
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      expect(params.deliveryCompletion).toBeUndefined();
      await markDeliveryPlatformSendAttemptStarted(deliveryId, tmpDir());
      await params.onPlatformSendStart?.({});
      return [];
    });

    const { result } = await runRecovery({ deliver });

    expect(
      loadSessionEntry({ sessionKey: completion.sessionKey, storePath: completion.storePath }),
    ).toMatchObject({
      pendingFinalDelivery: {
        deliveries: [{ id: deliveryId, state: "unknown" }],
      },
      pendingDeliveryNotice: {
        intentId: completion.intentId,
        state: "owed",
        context,
      },
    });
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    await expectPendingEntry({
      id: deliveryId,
      recoveryState: "unknown_after_send",
      retryCount: 1,
    });
    expect(auditEvents).not.toContainEqual(
      expect.objectContaining({ action: "message.outbound.finished" }),
    );

    setQueuedEntryState(tmpDir(), deliveryId, {
      retryCount: 1,
      enqueuedAt: 0,
      lastAttemptAt: 0,
      availableAt: 0,
    });
    const second = await runRecovery({ deliver });
    unsubscribe();

    expect(second.result).toEqual(RECOVERY_SUMMARY.failed);
    expect(deliver).toHaveBeenCalledOnce();
    expect(auditEvents.filter((event) => event.action === "message.outbound.finished")).toEqual([
      expect.objectContaining({
        sourceId: `message:outbound:queue:${deliveryId}:payload:0`,
        outcome: "unknown",
      }),
    ]);
  });
  it.each([
    "acks a persisted suppressed conversation operation without replaying it",
    "acks a persisted rejected conversation operation without replaying it",
  ])("%s", async (name) => {
    const rejected = name.includes("rejected");
    const operationId = rejected ? "operation-rejected" : "operation-suppressed";
    const scope = await createConversationRecoveryFixture(operationId);
    await runIf(rejected, () =>
      markConversationDeliveryRejected(scope, operationId, "atomic message limit"),
    );
    await runIf(!rejected, () => markConversationDeliverySuppressed(scope, operationId));
    const deliver = vi.fn();
    try {
      const { result } = await runRecovery({ deliver });
      expect(result).toMatchObject(rejected ? { failed: 1 } : { recovered: 1 });
      expect(deliver).not.toHaveBeenCalled();
      expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject(
        rejected
          ? { status: "rejected", rejectionError: "atomic message limit" }
          : { status: "suppressed" },
      );
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
  it.each([
    ["permanently rejects provider-blocked rows before backoff or reconciliation", false],
    ["checks bounded provider admission before replaying a reconciliable platform attempt", true],
  ])("%s", async (_, stableAttempt) => {
    const capture = stableAttempt ? undefined : captureAuditEvents();
    const id = stableAttempt
      ? "cron-direct-delivery:v1:blocked-reconciled-admission"
      : await enqueueRecoveryDelivery({
          channel: "slack",
          to: "C123",
          accountId: "enterprise",
          payloads: [{ text: "blocked" }],
        });
    if (stableAttempt) {
      await enqueueClaimedRecoveryDelivery(id, {
        channel: "slack",
        to: "C123",
        accountId: "enterprise",
        payloads: [{ text: "disabled account must never be replayed" }],
        completionRetention: BOUNDED_COMPLETION_RETENTION,
      });
    }
    if (!stableAttempt) {
      setQueuedEntryState(tmpDir(), id, {
        retryCount: MAX_RETRIES,
        lastAttemptAt: Date.now(),
        recoveryState: "unknown_after_send",
        platformSendStartedAt: Date.now(),
      });
    }
    const admitDeferredDelivery = vi.fn(() => ({
      status: "permanent_rejection" as const,
      reason: "unsupported_enterprise_slack_delivery",
    }));
    const reconcileUnknownSend = stableAttempt
      ? vi.fn().mockResolvedValue({ status: "not_sent" })
      : vi.fn();
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: {
        ...(stableAttempt ? { capabilities: { reconcileUnknownSend: true } } : {}),
        admitDeferredDelivery,
        reconcileUnknownSend,
      },
    });
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    capture?.unsubscribe();
    expect(admitDeferredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "enterprise",
        channel: "slack",
        phase: "recovery",
        ...(stableAttempt ? {} : { to: "C123" }),
      }),
    );
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    if (stableAttempt) {
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
    } else {
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectPayloadAudits(capture?.auditEvents ?? [], id, [
        { status: "unknown", outcome: "unknown", failureStage: "queue" },
      ]);
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: { admitDeferredDelivery: () => ({ status: "allowed" }) },
      });
      await runRecovery({ deliver });
      expect(deliver).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["paces startup replay instead of draining eligible entries back-to-back", 60_000],
    ["counts replay pacing against the recovery budget and defers the backlog tail", 1],
  ])("%s", async (_, maxRecoveryMs) => {
    const addBacklogTail = maxRecoveryMs === 1;
    const expectedCalls = addBacklogTail ? 1 : 2;
    const expectedSleep = addBacklogTail ? 1 : RECOVERY_REPLAY_SPACING_MS;
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await enqueueCrashRecoveryEntries();
      await runIf(addBacklogTail, () => enqueueDemoRecoveryDelivery(["c"], { to: "#c" }));
      const deliveryTimes: number[] = [];
      const deliver = vi.fn(async () => {
        deliveryTimes.push(Date.now());
        return [];
      });
      const recovery = runRecovery({ deliver, maxRecoveryMs });
      await expect(controlledSleep.started).resolves.toBe(expectedSleep);
      expect(deliver).toHaveBeenCalledTimes(1);
      controlledSleep.release();
      const { result } = await recovery;
      expect(deliver).toHaveBeenCalledTimes(expectedCalls);
      const observedTimes = expectedCalls === 1 ? deliveryTimes : deliveryTimes.slice(1);
      const expectedTimes = [
        startedAt.getTime() + (expectedCalls === 1 ? 0 : RECOVERY_REPLAY_SPACING_MS),
      ];
      expect(observedTimes).toEqual(expectedTimes);
      expect(result).toMatchObject({ recovered: expectedCalls, deferredBackoff: 0 });
      await runIf(addBacklogTail, async () =>
        expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("moves entries that exceeded max retries to failed/", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery();
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(deliver).not.toHaveBeenCalled();
    expect(result.skippedMaxRetries).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
    expectPayloadAudits(auditEvents, id, [{ outcome: "failed", failureStage: "queue" }]);
  });
  it.each([
    ["honors a producer-specific retry budget", 45, MAX_RETRIES, false, true, true],
    ["dead-letters an atomically exhausted attempt budget before replay", 1, 0, true, false, true],
    ["ignores an invalid producer retry budget", 0.5, 0, false, true, false],
  ])("%s", async (_, maxRetries, retryCount, reserve, shouldDeliver, checkStatus) => {
    const id = await enqueueRecoveryDelivery({ maxRetries });
    if (retryCount) {
      setQueuedEntryState(tmpDir(), id, {
        retryCount,
        lastAttemptAt: Date.now() - 10_000_000,
      });
    }
    await runIf(reserve, () => reserveDeliveryAttempt(id, 1, tmpDir()));
    const deliver = shouldDeliver ? vi.fn().mockResolvedValue([]) : vi.fn();
    const { result } = await runRecovery({ deliver });
    expect(deliver).toHaveBeenCalledTimes(shouldDeliver ? 1 : 0);
    expect(result).toMatchObject(
      shouldDeliver ? { recovered: 1, skippedMaxRetries: 0 } : { skippedMaxRetries: 1 },
    );
    if (checkStatus) {
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
    }
  });
  it("dead-letters max-retry entries even when conversation owner state is missing", async () => {
    const storePath = path.join(tmpDir(), "missing-owner-sessions.json");
    const id = await enqueueRecoveryDelivery({
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "missing-operation",
        storePath,
      },
    });
    setQueuedEntryState(tmpDir(), id, { retryCount: MAX_RETRIES });
    const log = createRecoveryLog();
    try {
      const { result } = await runRecovery({ deliver: vi.fn(), log });
      expect(result.skippedMaxRetries).toBe(1);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("settlement");
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
  it("audits max-retry deadletters as unknown when platform send may have started", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery();
    setQueuedEntryState(tmpDir(), id, {
      retryCount: MAX_RETRIES,
      lastAttemptAt: Date.now() - 10_000_000,
      platformSendStartedAt: Date.now(),
      recoveryState: "send_attempt_started",
    });
    const { result } = await runRecovery({ deliver: vi.fn() });
    unsubscribe();
    expect(result).toMatchObject({ failed: 1, skippedMaxRetries: 0 });
    expectPayloadAudits(auditEvents, id, [{ outcome: "unknown", failureStage: "queue" }]);
  });
  it("increments retryCount on failed recovery attempt", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    await enqueueDemoRecoveryDelivery();
    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    await expectPendingEntry({ retryCount: 1, attemptCount: 1, lastError: "network down" });
    expect(auditEvents).toEqual([]);
  });
  it.each([
    {
      name: "keeps a repeated pre-connect recovery failure replayable",
      error: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
        syscall: "connect",
      }),
    },
    {
      name: "keeps a repeated provider-not-dispatched recovery failure replayable",
      error: new PlatformMessageNotDispatchedError("upload stopped before finalization", {
        cause: new Error("request timed out"),
      }),
    },
  ])("$name", async ({ error }) => {
    const id = await enqueueDemoRecoveryDelivery();
    const deliver = vi.fn(async () => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      throw error;
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({
      retryCount: 1,
      recoveryState: undefined,
      platformSendStartedAt: undefined,
    });
  });
  it("does not replay a recovery batch that rejected after an earlier send succeeded", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"]);
    const partialFailure = new OutboundDeliveryError("second send failed", {
      cause: new Error("network down"),
      results: [{ channel: "demo-channel-c", messageId: "m1" }],
    });
    const { result } = await runRecovery({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it("keeps a partially sent batch unknown when a later send has a permanent rejection", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"]);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack outbound delivery rejected: messages_tab_disabled",
      { cause: new Error("messages_tab_disabled"), retryable: false },
    );
    const partialFailure = new OutboundDeliveryError("second send failed", {
      cause: rejection,
      results: [{ channel: "demo-channel-c", messageId: "m1" }],
      payloadOutcomes: [
        { index: 0, status: "sent", results: [{ channel: "demo-channel-c", messageId: "m1" }] },
        {
          index: 1,
          status: "failed",
          error: rejection,
          sentBeforeError: false,
          stage: "platform_send",
        },
      ],
      stage: "platform_send",
    });

    const { result } = await runRecovery({
      deliver: vi.fn().mockRejectedValue(partialFailure),
    });

    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("pending");
  });
  it("keeps a best-effort recovery failure retryable when no payload was sent", async () => {
    await enqueueDemoRecoveryDelivery(["first"], { bestEffort: true });
    const deliver = vi.fn(async (params: PayloadOutcomeSink) => {
      reportPayloadFailure(params, new Error("network down"));
      return [];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({
      recoveryState: undefined,
      retryCount: 1,
      lastError: "network down",
    });
  });
  it.each([
    {
      name: "clears send evidence for an all-pre-connect best-effort recovery failure",
      error: Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
      }),
    },
    {
      name: "clears send evidence for an all-not-dispatched best-effort recovery failure",
      error: new PlatformMessageNotDispatchedError("upload timed out before completion dispatch", {
        cause: new Error("request timed out"),
      }),
    },
  ])("$name", async ({ error }) => {
    const id = await enqueueDemoRecoveryDelivery(["first"], { bestEffort: true });
    const deliver = vi.fn(async (params: PayloadOutcomeSink) => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      reportPayloadFailure(params, error);
      return [];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({
      retryCount: 1,
      recoveryState: undefined,
      platformSendStartedAt: undefined,
    });
  });
  it("preserves send evidence when a marked recovery batch has an ambiguous failure", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"], { bestEffort: true });
    const deliver = vi.fn(async (params: PayloadOutcomeSink) => {
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      reportPayloadFailure(
        params,
        new PlatformMessageNotDispatchedError("upload timed out before completion dispatch", {
          cause: new Error("request timed out"),
        }),
      );
      reportPayloadFailure(
        params,
        Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
          syscall: "read",
        }),
        { index: 1 },
      );
      return [];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    const entry = await expectPendingEntry({
      retryCount: 1,
      recoveryState: "send_attempt_started",
    });
    expect(typeof entry?.platformSendStartedAt).toBe("number");
  });
  it("does not ack a partially sent best-effort recovery batch", async () => {
    const id = await enqueueDemoRecoveryDelivery(["first", "second"], { bestEffort: true });
    const deliver = vi.fn(async (params: PayloadOutcomeSink) => {
      reportPayloadFailure(params, new Error("second send failed"), {
        index: 1,
        sentBeforeError: true,
      });
      return [{ channel: "demo-channel-c", messageId: "m1" }];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    await expectPendingEntry({ id, recoveryState: "unknown_after_send", retryCount: 0 });
    const replay = vi.fn();
    await runRecovery({ deliver: replay });
    expect(replay).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it.each([
    [
      "moves entries abandoned after platform send may have started to failed without reconciliation",
      0,
    ],
    ["moves started entries without reconciliation to failed instead of blindly replaying", 1],
    ["moves unknown-after-send entries to failed without replaying", 2],
    ["does not reconcile unknown-after-send entries unless the adapter declares the capability", 3],
  ])("%s", async (_, mode) => {
    const text = ["maybe sent", "not yet sent", "a", "hidden method"][mode] ?? "a";
    const state = mode === 1 ? "send_attempt_started" : "unknown_after_send";
    const markUnknown = mode === 2;
    const hiddenReconciler = mode === 3;
    const logText = mode === 0 ? "unknown_after_send" : BLIND_REPLAY_LOG;
    const audit = mode === 0;
    const capture = audit ? captureAuditEvents() : undefined;
    const id = markUnknown
      ? await enqueueRecoveryDelivery({ payloads: [{ text }] })
      : await enqueueUnknownRecovery({ text, state });
    await runIf(markUnknown, () => markDeliveryPlatformOutcomeUnknown(id, tmpDir()));
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    if (hiddenReconciler) {
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: { reconcileUnknownSend },
      });
    }
    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({ deliver });
    capture?.unsubscribe();
    await runIf(hiddenReconciler, () => expect(reconcileUnknownSend).not.toHaveBeenCalled());
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    await expectFailedQueue(id);
    expectMockMessageContaining(log.warn, logText);
    if (capture) {
      expectPayloadAudits(capture.auditEvents, id, [
        { status: "unknown", outcome: "unknown", failureStage: "queue" },
      ]);
    }
  });
  it("reports every payload unknown when a multi-payload send is crash-ambiguous", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      payloads: [{ text: "sent" }, { text: "hidden" }],
    });
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    await runRecovery({ deliver: vi.fn() });
    unsubscribe();
    expectPayloadAudits(auditEvents, id, [
      { status: "unknown", outcome: "unknown", resultCount: 0 },
      { status: "unknown", outcome: "unknown", resultCount: 0 },
    ]);
  });
  it("replays started entries only after adapter proves they were not sent", async () => {
    await enqueueUnknownRecovery({
      text: "not yet sent",
      state: "send_attempt_started",
    });
    installUnknownSendResult({ status: "not_sent" });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    expect(resolveOutboundChannelMessageAdapterMock).toHaveBeenCalledWith({
      channel: "demo-channel-a",
      cfg: baseCfg,
      allowBootstrap: true,
    });
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput.channel).toBe("demo-channel-a");
    expect(deliverInput.to).toBe("+1");
    expect(deliverInput.skipQueue).toBe(true);
    expect(result).toEqual(RECOVERY_SUMMARY.recovered);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("keeps an in-flight stable platform send fenced across recovery", async () => {
    const id = "cron-direct-delivery:v1:in-flight-producer-lease";
    const producerClaimId = await enqueueClaimedRecoveryDelivery(id, {
      payloads: [{ text: "the original platform send is still in flight" }],
      completionRetention: BOUNDED_COMPLETION_RETENTION,
      requiresProducerClaim: true,
    });
    await markDeliveryPlatformSendDispatched(id, tmpDir(), undefined, producerClaimId);
    const reconcileUnknownSend = vi.fn().mockResolvedValue({ status: "not_sent" });
    installUnknownSendAdapter(reconcileUnknownSend);
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 0, failed: 0 });
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir()))[0]).toMatchObject({
      id,
      recoveryState: "send_attempt_started",
      platformSendAttemptId: producerClaimId,
      availableAt: expect.any(Number),
    });

    await markDeliveryPlatformOutcomeUnknown(id, tmpDir(), producerClaimId);
    const unknownResult = await runRecovery({ deliver });

    expect(unknownResult.result).toMatchObject({ recovered: 0, failed: 0 });
    expect(reconcileUnknownSend).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect((await loadPendingDeliveries(tmpDir()))[0]).toMatchObject({
      id,
      recoveryState: "unknown_after_send",
      platformSendAttemptId: producerClaimId,
      availableAt: expect.any(Number),
    });
  });

  it("reconciles an unknown stable send after restart recovery waits for its lease expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
    try {
      const id = "cron-direct-delivery:v1:restart-before-producer-lease-expiry";
      await enqueueDeliveryOnce(
        {
          channel: "demo-channel-a",
          to: "+1",
          payloads: [{ text: "reconcile after the crashed producer lease expires" }],
          queuePolicy: "required",
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2_000,
          },
          requiresProducerClaim: true,
        },
        id,
        tmpDir(),
      );
      const originalClaimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      if (!originalClaimId) {
        throw new Error("test invariant: the crashed producer must own a stable claim");
      }
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), undefined, originalClaimId);
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir(), originalClaimId);
      const leaseExpiry = (await loadPendingDeliveries(tmpDir()))[0]?.availableAt;
      if (leaseExpiry === undefined) {
        throw new Error("test invariant: the stable producer claim must have an expiry");
      }

      const reconcileUnknownSend = vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "reconciled-after-expiry",
        receipt: {
          primaryPlatformMessageId: "reconciled-after-expiry",
          platformMessageIds: ["reconciled-after-expiry"],
          parts: [{ platformMessageId: "reconciled-after-expiry", kind: "text", index: 0 }],
          sentAt: leaseExpiry,
        },
      });
      resolveOutboundChannelMessageAdapterMock.mockReturnValue({
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend,
        },
      });
      const deliver = vi.fn();

      const firstRun = await runRecovery({ deliver });
      expect(firstRun.result).toMatchObject({
        recovered: 0,
        failed: 0,
      });
      expect(reconcileUnknownSend).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();

      vi.setSystemTime(leaseExpiry + 1);
      const secondRun = await runRecovery({ deliver });

      expect(secondRun.result).toMatchObject({ recovered: 1, failed: 0 });
      expect(reconcileUnknownSend).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("atomically fences stable recovery after an adapter proves an ambiguous send was not sent", async () => {
    const id = "cron-direct-delivery:v1:reconciled-stable-recovery";
    await enqueueClaimedRecoveryDelivery(
      id,
      {
        payloads: [{ text: "recover exactly once after reconciliation" }],
        completionRetention: BOUNDED_COMPLETION_RETENTION,
      },
      { replyToId: null },
    );
    installUnknownSendResult({ status: "not_sent" });
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      if (!params.deliveryProducerClaimId) {
        throw new Error("recovered provider send must own a fenced producer lease");
      }
      await markDeliveryPlatformSendAttemptStarted(
        id,
        tmpDir(),
        { replyToId: null },
        params.deliveryProducerClaimId,
      );
      return [{ channel: "demo-channel-a", messageId: "fenced-reconciled-message" }];
    });
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    expect(mockCallRecord(deliver)).toMatchObject({
      deliveryQueueId: id,
      deliveryProducerClaimId: expect.any(String),
    });
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
  });
  it("acknowledges a permanently fenced send reconciled as already sent", async () => {
    const id = "permanent-reconciled-platform-delivery";
    const platformSendAttemptId = await enqueueClaimedRecoveryDelivery(id, {
      payloads: [{ text: "the platform already delivered this permanent intent" }],
      completionRetention: "permanent",
      requiresProducerClaim: true,
    });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir(), platformSendAttemptId);
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      availableAt: Date.now() - 1,
    });
    const reconcileUnknownSend = vi
      .fn()
      .mockResolvedValue(reconciledSent("reconciled-permanent-message"));
    installUnknownSendAdapter(reconcileUnknownSend);
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(readOutboundQueueStatus(tmpDir(), id)).toBe("completed");
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("acks unknown-after-send entries reconciled as already sent before commit hooks", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      accountId: "acct-1",
      payloads: [{ text: "maybe sent" }],
      reply: { source: "implicit", replyToId: "root-message", mode: "all" },
      threadId: "thread-1",
      silent: true,
      maxRetries: 1,
    });
    await reserveDeliveryAttempt(id, 1, tmpDir());
    await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
      replyToId: "hooked-root-message",
    });
    await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
    const order: string[] = [];
    const afterCommit = vi.fn(() => {
      order.push("afterCommit");
    });
    const reconcileUnknownSend = vi.fn().mockResolvedValue(reconciledSent("platform-1", 1));
    installUnknownSendAdapter(
      reconcileUnknownSend,
      {},
      {
        send: {
          lifecycle: {
            afterCommit,
          },
        },
      },
    );
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.recovered);
    const reconcileInput = mockCallRecord(reconcileUnknownSend);
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
    const afterCommitInput = mockCallRecord(afterCommit);
    expect(afterCommitInput.deliveryQueueId).toBe(id);
    expect(afterCommitInput.kind).toBe("text");
    expect(afterCommitInput.to).toBe("+1");
    expect(afterCommitInput.accountId).toBe("acct-1");
    expect(afterCommitInput.replyToId).toBe("hooked-root-message");
    expect(afterCommitInput.threadId).toBe("thread-1");
    expect(afterCommitInput.silent).toBe(true);
    expect((afterCommitInput.result as { messageId?: string })?.messageId).toBe("platform-1");
    expect(order).toEqual(["afterCommit"]);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [
      { status: "succeeded", outcome: "sent", messageId: "platform-1", resultCount: 1 },
    ]);
  });
  it("moves unknown-after-send entries to failed when adapter reports not sent", async () => {
    const id = await enqueueUnknownRecovery({ text: "not sent" });
    installUnknownSendResult({ status: "not_sent" });
    const deliver = vi.fn().mockResolvedValue([]);
    const log = createRecoveryLog();
    const { result } = await runRecovery({ deliver, log });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.failed);
    await expectFailedQueue(id);
    expectMockMessageContaining(log.warn, "refusing full replay after post-send evidence");
  });
  it("keeps retryable unresolved unknown-after-send entries on the queue without replaying", async () => {
    const id = await enqueueUnknownRecovery({ text: "unknown" });
    installUnknownSendResult({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const entry = await expectPendingEntry({
      id,
      retryCount: 1,
      recoveryState: "unknown_after_send",
    });
    expect(entry?.lastError).toContain("provider lookup timed out");
  });
  it("dead-letters an exhausted unknown send after retryable reconciliation fails", async () => {
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      "00000000-0000-4000-8000-000000000099.ogg",
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "private media");
    const oldArtifactTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await fs.utimes(artifact, oldArtifactTime, oldArtifactTime);
    const id = await enqueueUnknownRecovery({
      text: "unknown final attempt",
      delivery: {
        maxRetries: 1,
        payloads: [{ text: "unknown final attempt", mediaUrl: artifact }],
      },
      queue: { lastAttemptAt: Date.now() - 10_000_000 },
    });
    await reserveDeliveryAttempt(id, 1, tmpDir());
    const reconcileUnknownSend = vi.fn().mockResolvedValue({
      status: "unresolved",
      error: "provider lookup timed out",
      retryable: true,
    });
    const cleanupStarted = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const afterUnknownSendTerminal = vi.fn(async (ctx: { queueId: string }) => {
      expect(ctx.queueId).toBe(id);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      await expect(fs.stat(artifact)).resolves.toBeDefined();
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });
    installUnknownSendAdapter(reconcileUnknownSend, { afterUnknownSendTerminal });
    const deliver = vi.fn().mockResolvedValue([]);
    const recovery = runRecovery({ deliver });
    await cleanupStarted.promise;
    await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
    const survivedPausedCleanup = await fs.stat(artifact).then(
      () => true,
      () => false,
    );
    releaseCleanup.resolve();
    const { result } = await recovery;
    expect(survivedPausedCleanup).toBe(true);
    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1, skippedMaxRetries: 0 });
    await expectFailedQueue(id);
    expect(afterUnknownSendTerminal).toHaveBeenCalledOnce();
    await expect(fs.stat(artifact)).rejects.toThrow();
  });
  it.each([
    [
      "moves entries to failed/ immediately on permanent delivery errors",
      "demo-channel",
      "user:abc",
      new Error("No conversation reference found for user:abc"),
    ],
    [
      "moves typed permanent platform rejections to failed without retry backoff",
      "demo-channel",
      "user:abc",
      new PlatformMessageNotDispatchedError("atomic message limit", {
        cause: new Error("rendered text is too large"),
        retryable: false,
      }),
    ],
    [
      "treats Matrix 'User not in room' as a permanent error",
      "matrix",
      "!lowercased:matrix.example.com",
      new Error(
        "MatrixError: [403] User @bot:matrix.example.com not in room !lowercased:matrix.example.com",
      ),
    ],
  ])("%s", async (_, channel, to, error) => {
    const id = await enqueueRecoveryDelivery({ channel, to, payloads: [{ text: "hi" }] });
    const deliver = vi.fn().mockRejectedValue(error);
    const { result, log } = await runRecovery({ deliver });
    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);
    await expectFailedQueue(id);
    const typedRejection = error instanceof PlatformMessageNotDispatchedError;
    await runIf(typedRejection, () => expect(deliver).toHaveBeenCalledOnce());
    await runIf(!typedRejection, () => expectMockMessageContaining(log.warn, "permanent error"));
  });
  it("persists a nested channel rejection as the only terminal across recovery restart", async () => {
    const operationId = "operation-channel-permanent-rejection";
    const scope = await createConversationRecoveryFixture(operationId);
    const rejection = new PlatformMessageNotDispatchedError(
      "Slack chat.postMessage rejected: messages_tab_disabled",
      {
        cause: new Error("messages_tab_disabled"),
        retryable: false,
      },
    );
    const deliver = vi.fn().mockRejectedValue(
      new OutboundDeliveryError("Slack delivery failed", {
        cause: rejection,
        payloadOutcomes: [
          {
            index: 0,
            status: "failed",
            error: rejection,
            sentBeforeError: false,
            stage: "platform_send",
          },
        ],
        stage: "platform_send",
      }),
    );

    try {
      const first = await runRecovery({ deliver });
      expect(first.result).toEqual(RECOVERY_SUMMARY.failed);
      expect(deliver).toHaveBeenCalledOnce();
      expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject({
        status: "rejected",
        rejectionError: "Slack chat.postMessage rejected: messages_tab_disabled",
      });
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readOutboundQueueStatus(tmpDir(), operationId)).toBe("failed");

      closeOpenClawAgentDatabasesForTest();
      const replay = vi.fn();
      const second = await runRecovery({ deliver: replay });
      expect(second.result).toEqual(RECOVERY_SUMMARY.empty);
      expect(replay).not.toHaveBeenCalled();
      expect(getConversationDeliveryOperation(scope, operationId)).toMatchObject({
        status: "rejected",
        rejectionError: "Slack chat.postMessage rejected: messages_tab_disabled",
      });
      expect(readOutboundQueueStatus(tmpDir(), operationId)).toBe("failed");
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });
  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueRecoveryDelivery();
    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput.skipQueue).toBe(true);
  });
  it("runs recovered send commit hooks only after the queue entry is acked", async () => {
    const id = await enqueueRecoveryDelivery();
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
    const id = await enqueueRecoveryDelivery();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "demo-channel-a", messageId: "m1" },
      async () => {
        throw new Error("commit hook offline");
      },
    );
    const deliver = vi.fn().mockResolvedValue([result]);
    const { result: summary } = await runRecovery({ deliver });
    expect(summary).toEqual(RECOVERY_SUMMARY.recovered);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
  });
  it.each([
    ["marks a recovered send unknown before ack so ack failure cannot make it replayable", "ack"],
    ["keeps a recovered zero-result delivery retryable when ack fails", "zero-result-ack"],
    ["directly acks a recovered send when its post-send marker fails", "marker"],
    ["retains unknown-after-send when recovered-send marking and ack both fail", "marker-and-ack"],
  ])("%s", async (_, mode) => {
    const id = await enqueueRecoveryDelivery();
    const markerFails = mode === "marker" || mode === "marker-and-ack";
    const ackFails = mode === "ack" || mode === "zero-result-ack" || mode === "marker-and-ack";
    let recoveryStateAtAck: string | undefined;
    const { summary, log } = await runRecoveryWithStorageOverrides({
      overrides: (actual) => ({
        ...(markerFails
          ? {
              markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
                throw new Error("post-send state db locked");
              }),
            }
          : {}),
        ...(ackFails
          ? {
              ackDelivery: vi.fn(async (entryId: string, stateDir?: string) => {
                if (mode === "ack") {
                  recoveryStateAtAck = (await actual.loadPendingDelivery(entryId, stateDir))
                    ?.recoveryState;
                }
                throw new Error("ack state db locked");
              }),
            }
          : {}),
      }),
      deliver: vi
        .fn()
        .mockResolvedValue(
          mode === "zero-result-ack" ? [] : [{ channel: "demo-channel-a", messageId: "m1" }],
        ),
    });
    if (mode === "marker") {
      expect(summary).toEqual(RECOVERY_SUMMARY.recovered);
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readOutboundQueueStatus(tmpDir(), id)).toBeUndefined();
      expectMockMessageContaining(log.warn, "falling back to direct ack");
      return;
    }
    if (mode === "ack") {
      expect(summary).toEqual(RECOVERY_SUMMARY.failed);
      expect(recoveryStateAtAck).toBe("unknown_after_send");
    } else {
      expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    }
    const pending = await expectPendingEntry({
      id,
      recoveryState: mode === "zero-result-ack" ? undefined : "unknown_after_send",
      ...(mode === "ack" ? {} : { retryCount: 1 }),
    });
    await runIf(markerFails, () =>
      expect(pending?.lastError).toContain("marker=post-send state db locked"),
    );
    expect(pending?.lastError).toContain(
      mode === "marker-and-ack" ? "ack=ack state db locked" : "ack state db locked",
    );
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
    await enqueueRecoveryDelivery({
      payloads: [{ mediaUrl: firstArtifact }, { mediaUrl: secondArtifact }],
    });
    const firstResult = { channel: "demo-channel-a", messageId: "m1" };
    const secondResult = { channel: "demo-channel-a", messageId: "m2" };
    const deliver = vi.fn(async (params: Parameters<DeliverFn>[0]) => {
      await params.onDeliveryResult?.(firstResult);
      await pruneOrphanedDeliveryQueueMedia({ stateDir: tmpDir() });
      expect(await fs.readFile(secondArtifact, "utf8")).toBe("second-audio");
      await params.onDeliveryResult?.(secondResult);
      return [firstResult, secondResult];
    });
    const { summary } = await runRecoveryWithStorageOverrides({
      overrides: () => ({
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      }),
      deliver,
    });
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    await expect(fs.stat(firstArtifact)).rejects.toThrow();
    await expect(fs.stat(secondArtifact)).rejects.toThrow();
  });
  it("owns the stable terminal when recovery fallback ack precedes provider rejection", async () => {
    const { auditEvents, unsubscribe } = captureAuditEvents();
    const id = await enqueueRecoveryDelivery({
      queuePolicy: "best_effort",
      payloads: [{ text: "secret" }],
    });
    const deliver = vi.fn(async (params: PayloadOutcomeSink) => {
      await ackDelivery(id, tmpDir());
      reportPayloadFailure(params, new Error("provider rejected send"));
      throw new Error("provider rejected send");
    });
    const { result } = await runRecovery({ deliver });
    unsubscribe();
    expect(result).toMatchObject({ recovered: 0, failed: 1 });
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    expectPayloadAudits(auditEvents, id, [{ outcome: "failed", failureStage: "platform_send" }]);
    expect(JSON.stringify(auditEvents)).not.toContain("secret");
    expect(JSON.stringify(auditEvents)).not.toContain("provider rejected send");
  });
  it("runs recovered commit hooks when marker fallback ack precedes a partial failure", async () => {
    await enqueueRecoveryDelivery({
      payloads: [{ text: "first" }, { text: "second" }],
      bestEffort: true,
    });
    const afterCommit = vi.fn();
    const { summary } = await runRecoveryWithStorageOverrides({
      overrides: () => ({
        markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {
          throw new Error("post-send state db locked");
        }),
      }),
      createDeliver: async () => {
        const { attachOutboundDeliveryCommitHook: attachHookAfterReset } =
          await import("./delivery-commit-hooks.js");
        const result = attachHookAfterReset(
          { channel: "demo-channel-a", messageId: "m1" },
          afterCommit,
        );
        return vi.fn(
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
        );
      },
    });
    expect(summary).toMatchObject({ recovered: 0, failed: 1 });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
  });
  it("replays stored delivery options during recovery", async () => {
    const storedOptions = {
      reply: { replyToId: "root-message", source: "implicit", mode: "first" } as const,
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
    } satisfies Partial<Parameters<typeof enqueueDelivery>[0]>;
    await enqueueRecoveryDelivery(storedOptions);
    const deliver = vi.fn().mockResolvedValue([]);
    await runRecovery({ deliver });
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput).toEqual(expect.objectContaining(storedOptions));
  });
  it.each([
    ["respects maxRecoveryMs time budget without bumping deferred retries", 0, true, 3, false],
    [
      "defers recovery when the recovery deadline would exceed the Date timestamp range",
      1,
      false,
      2,
      true,
    ],
  ])("%s", async (_, maxRecoveryMs, addBacklogTail, remainingCount, useMaxDate) => {
    if (useMaxDate) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));
    }
    try {
      await enqueueCrashRecoveryEntries();
      await runIf(addBacklogTail, () => enqueueDemoRecoveryDelivery(["c"], { to: "#c" }));
      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({ deliver, maxRecoveryMs });
      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual(RECOVERY_SUMMARY.empty);
      const remaining = await loadPendingDeliveries(tmpDir());
      expect(remaining).toHaveLength(remainingCount);
      if (addBacklogTail) {
        expect(remaining.map((entry) => entry.retryCount)).toStrictEqual([0, 0, 0]);
      }
      expectMockMessageContaining(log.warn, "deferred to next startup");
    } finally {
      await runIf(useMaxDate, () => vi.useRealTimers());
    }
  });
  it("defers entries until backoff becomes eligible", async () => {
    const id = await enqueueRecoveryDelivery();
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: Date.now() });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result, log } = await runRecovery({
      deliver,
      maxRecoveryMs: 60_000,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual(RECOVERY_SUMMARY.deferred);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    expectMockMessageContaining(log.info, "not ready for retry yet");
  });
  it("continues past high-backoff entries and recovers ready entries behind them", async () => {
    const now = Date.now();
    const blockedId = await enqueueRecoveryDelivery({ payloads: [{ text: "blocked" }] });
    const readyId = await enqueueRecoveryDelivery({
      channel: "demo-channel-b",
      to: "2",
      payloads: [{ text: "ready" }],
    });
    setQueuedEntryState(tmpDir(), blockedId, {
      retryCount: 3,
      lastAttemptAt: now,
      enqueuedAt: now - 30_000,
    });
    setQueuedEntryState(tmpDir(), readyId, { retryCount: 0, enqueuedAt: now - 10_000 });
    const deliver = vi.fn().mockResolvedValue([]);
    const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });
    expect(result).toEqual(RECOVERY_SUMMARY.recoveredWithDeferred);
    expect(deliver).toHaveBeenCalledTimes(1);
    const deliverInput = mockCallRecord(deliver);
    expect(deliverInput).toMatchObject({ channel: "demo-channel-b", to: "2", skipQueue: true });
    const remaining = await loadPendingDeliveries(tmpDir());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(blockedId);
  });
  it("recovers deferred entries on a later restart once backoff elapsed", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const id = await enqueueRecoveryDelivery({ payloads: [{ text: "later" }] });
    setQueuedEntryState(tmpDir(), id, { retryCount: 3, lastAttemptAt: start.getTime() });
    const firstDeliver = vi.fn().mockResolvedValue([]);
    const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
    expect(firstRun.result).toEqual(RECOVERY_SUMMARY.deferred);
    expect(firstDeliver).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(start.getTime() + 120_000 + 1));
    const secondDeliver = vi.fn().mockResolvedValue([]);
    const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
    expect(secondRun.result).toEqual(RECOVERY_SUMMARY.recovered);
    expect(secondDeliver).toHaveBeenCalledTimes(1);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    vi.useRealTimers();
  });
  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const { result } = await runRecovery({ deliver });
    expect(result).toEqual(RECOVERY_SUMMARY.empty);
    expect(deliver).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
