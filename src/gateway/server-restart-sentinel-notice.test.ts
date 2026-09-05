// Exercises restart-notice retries against the real SQLite outbound queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { runOutboundDeliveryInternal } from "../infra/outbound/deliver-queue.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { attachOutboundDeliveryCommitHook } from "../infra/outbound/delivery-commit-hooks.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import * as deliveryQueueStorage from "../infra/outbound/delivery-queue-storage.js";
import {
  loadPendingDelivery,
  markDeliveryPlatformSendAttemptStarted,
} from "../infra/outbound/delivery-queue-storage.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(),
  recoveryDeliver: vi.fn(),
  resolveOutboundChannelMessageAdapter: vi.fn(() => undefined),
  sleep: vi.fn(async () => {}),
  hookRunner: {
    hasHooks: vi.fn((name?: string) => name === "message_sent"),
    runMessageSending: vi.fn(async () => undefined),
    runMessageSent: vi.fn(async () => undefined),
  },
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatch,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: mocks.recoveryDeliver,
}));

vi.mock("../infra/outbound/channel-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/channel-resolution.js")>()),
  resolveOutboundChannelMessageAdapter: mocks.resolveOutboundChannelMessageAdapter,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { deliverRestartSentinelNotice, enqueueRestartSentinelNotice, sendGatewayLifecycleNotice } =
  await import("./server-restart-sentinel-notice.js");

type DeliveryRequest = {
  deliveryQueueId?: string;
  deliveryQueueStateDir?: string;
  onMessageSentEvent?: (
    event: { success: boolean; content: string; messageId?: string },
    sourceIndex: number,
  ) => void;
};

describe("restart sentinel notice recovery", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let stateDir = "";
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetGatewayWorkAdmission();
      resetPluginRuntimeStateForTest();
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  beforeEach(() => {
    closeOpenClawStateDatabaseForTest();
    stateDir = tempDirs.make("openclaw-restart-notice-");
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    mocks.sendDurableMessageBatch.mockReset();
    mocks.recoveryDeliver.mockReset();
    mocks.resolveOutboundChannelMessageAdapter.mockClear();
    mocks.sleep.mockClear();
    mocks.hookRunner.hasHooks.mockClear();
    mocks.hookRunner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    mocks.hookRunner.runMessageSending.mockReset();
    mocks.hookRunner.runMessageSending.mockResolvedValue(undefined);
    mocks.hookRunner.runMessageSent.mockClear();
  });

  async function enqueueNotice(): Promise<string> {
    const queued = await enqueueRestartSentinelNotice({
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    });
    return queued.id;
  }

  async function deliverNotice(queueId: string): Promise<void> {
    await deliverRestartSentinelNotice({
      deps: {} as never,
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      summary: "restart summary",
      queueId,
    });
  }

  async function markAttempt(request: unknown): Promise<void> {
    const { deliveryQueueId, deliveryQueueStateDir } = request as DeliveryRequest;
    if (!deliveryQueueId) {
      throw new Error("expected durable delivery queue id");
    }
    await markDeliveryPlatformSendAttemptStarted(deliveryQueueId, deliveryQueueStateDir);
  }

  function queueStatus(queueId: string): string | undefined {
    return getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir);
  }

  function sendLifecycleNotice(deliveryIntentId: string) {
    return sendGatewayLifecycleNotice({
      cfg: {},
      deps: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "update starting",
      sessionKey: "agent:main:main",
      deliveryIntentId,
    });
  }

  it("sends only the four update milestones across repeated phases and successor startup", async () => {
    const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async () => ({ channel: "matrix", messageId: "notice" }),
            },
          }),
        },
      ]),
    );
    mocks.sendDurableMessageBatch.mockImplementation(async (request) => {
      await markAttempt(request);
      return { status: "sent", results: [{ channel: "matrix", messageId: "notice" }] };
    });
    let run = createUpdateRun({
      trigger: "chat",
      before: { version: "2026.9.1" },
      target: { version: "2026.9.2" },
      origin: { deliveryContext: { channel: "matrix", to: "room:update" } },
    });
    const notify = createUpdateRunNotifier(run, {}, {});
    await notify(run, "ack");
    await notify(run, "ack");
    for (const phase of ["staging", "validating", "activating"] as const) {
      run = recordUpdateRunPhase(run.runId, phase);
      await notify(run, "activating");
    }
    await notify(run, "activating");
    run = recordUpdateRunPhase(run.runId, "verifying");
    run = recordUpdateRunVerification(run.runId, { booted: true, runningVersion: "2026.9.2" });
    const successor = createUpdateRunNotifier(run, {}, {});
    await successor(run, "verifying");
    await successor(run, "verifying");
    run = finishUpdateRun(run.runId, { status: "succeeded", after: { version: "2026.9.2" } });
    await successor(run, "finished");
    await notify(run, "finished");
    expect(
      mocks.sendDurableMessageBatch.mock.calls.map(([request]) => request.payloads[0].text),
    ).toEqual([
      "⬆️ Updating OpenClaw 2026.9.1 → 2026.9.2. You'll get a message here before the gateway restarts and when verification finishes.",
      "⏳ Restarting the gateway now (v2026.9.1 → v2026.9.2)…",
      "🔁 Back on v2026.9.2, verifying…",
      renderUpdateRunReport(run).markdown,
    ]);
    expect(getUpdateRun(run.runId)?.verification.noticeDelivered).toBe(true);
    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
  });

  it.each(["sent", "suppressed", "failed", "throw"] as const)(
    "reports %s lifecycle delivery without starting inline recovery",
    async (outcome) => {
      const queueId = `update-run-ack:${outcome}`;
      mocks.sendDurableMessageBatch.mockImplementationOnce(async () => {
        if (outcome === "throw") {
          throw new Error("transport unavailable");
        }
        return outcome === "failed"
          ? { status: outcome, error: new Error("transport unavailable") }
          : {
              status: outcome,
              results: outcome === "sent" ? [{ channel: "whatsapp", messageId: "ack-1" }] : [],
            };
      });

      await expect(sendLifecycleNotice(queueId)).resolves.toBe(outcome === "sent");

      expect(mocks.sendDurableMessageBatch).toHaveBeenCalledOnce();
      expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
      expect(queueStatus(queueId)).toBe(
        outcome === "sent" || outcome === "suppressed" ? "completed" : "pending",
      );
    },
  );

  it("reports observed delivery even when queue acknowledgement fails", async () => {
    const queueId = "update-run-ack:commit-failed";
    vi.spyOn(deliveryQueueStorage, "ackDelivery").mockRejectedValueOnce(
      new Error("queue acknowledgement unavailable"),
    );
    mocks.sendDurableMessageBatch.mockResolvedValueOnce({
      status: "sent",
      results: [{ channel: "whatsapp", messageId: "ack-before-commit-failed" }],
    });

    await expect(sendLifecycleNotice(queueId)).resolves.toBe(true);

    expect(await loadPendingDelivery(queueId)).toMatchObject({
      recoveryState: "unknown_after_send",
    });
    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
  });

  it("bounds a blocked lifecycle send to ten seconds and preserves queued recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const queueId = "update-run-ack:timeout";
    const started = createDeferredCore();
    const finish = createDeferredCore();
    mocks.sendDurableMessageBatch.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return { status: "sent", results: [{ channel: "whatsapp", messageId: "late-ack" }] };
    });
    let settled = false;
    const send = sendLifecycleNotice(queueId).finally(() => {
      settled = true;
    });
    await started.promise;

    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(send).resolves.toBe(false);
      expect(queueStatus(queueId)).toBe("pending");
    } finally {
      finish.resolve();
      await vi.waitFor(() => expect(queueStatus(queueId)).toBe("completed"));
    }
    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
  });

  it("preserves observed delivery when an after-commit hook exceeds the notice deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const queueId = "update-run-ack:commit-timeout";
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const completed = createDeferredCore();
    const result = attachOutboundDeliveryCommitHook(
      { channel: "whatsapp", messageId: "ack-before-hook-timeout" },
      async () => {
        started.resolve();
        await finish.promise;
        completed.resolve();
      },
    );
    mocks.sendDurableMessageBatch.mockResolvedValueOnce({ status: "sent", results: [result] });
    const send = sendLifecycleNotice(queueId);
    await started.promise;

    try {
      expect(queueStatus(queueId)).toBe("completed");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(send).resolves.toBe(true);
    } finally {
      finish.resolve();
      await completed.promise;
    }
    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
  });

  it("finishes a real durable send under the admitted RPC root after restart admission closes", async () => {
    const { sendDurableMessageBatchCore } = await import("../channels/message/send.js");
    mocks.sendDurableMessageBatch.mockImplementation(sendDurableMessageBatchCore);
    mocks.recoveryDeliver.mockImplementation(runOutboundDeliveryInternal);
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const sendText = vi.fn(async () => {
      started.resolve();
      await finish.promise;
      return { channel: "matrix" as const, messageId: "ack-during-drain" };
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const root = tryBeginGatewayRootWorkAdmission("ws:update.run");
    if (!root) {
      throw new Error("expected update RPC root admission");
    }
    const queueId = "update-run-ack:admitted-root";
    const send = root
      .run(async () => {
        markGatewayRestartDraining();
        return await sendGatewayLifecycleNotice({
          cfg: {},
          deps: {},
          channel: "matrix",
          to: "!operator:example",
          message: "update starting",
          deliveryIntentId: queueId,
        });
      })
      .finally(root.release);
    try {
      await started.promise;
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission("unrelated")).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(await loadPendingDelivery(queueId)).not.toBeNull();
    } finally {
      finish.resolve();
    }

    await expect(send).resolves.toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
    expect(await loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("completed");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("serializes stable notice preparation before modifiers can run twice", async () => {
    mocks.hookRunner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    let releaseModifier: (() => void) | undefined;
    mocks.hookRunner.runMessageSending.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseModifier = () => resolve(undefined);
        }),
    );
    const request = {
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    };

    const first = enqueueRestartSentinelNotice(request);
    await vi.waitFor(() => expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce());
    let secondSettled = false;
    const second = enqueueRestartSentinelNotice(request).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    releaseModifier?.();
    await expect(first).resolves.toEqual({
      id: "restart-sentinel-notice:agent:main:main:123",
      created: true,
    });
    await expect(second).resolves.toEqual({
      id: "restart-sentinel-notice:agent:main:main:123",
      created: false,
    });
    await expect(enqueueRestartSentinelNotice(request)).resolves.toEqual(await second);
    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
  });

  it("emits message_sent only after the durable notice terminal is committed", async () => {
    const queueId = await enqueueNotice();
    const statusesAtHook: Array<string | undefined> = [];
    mocks.hookRunner.runMessageSent.mockImplementationOnce(async () => {
      statusesAtHook.push(queueStatus(queueId));
    });
    mocks.sendDurableMessageBatch.mockImplementationOnce(async (request: DeliveryRequest) => {
      await markAttempt(request);
      request.onMessageSentEvent?.(
        {
          success: true,
          content: "restart complete",
          messageId: "notice-1",
        },
        0,
      );
      return {
        status: "sent",
        results: [{ channel: "whatsapp", messageId: "notice-1" }],
      };
    });

    await deliverNotice(queueId);
    await vi.waitFor(() => expect(mocks.hookRunner.runMessageSent).toHaveBeenCalledOnce());

    expect(statusesAtHook).toEqual(["completed"]);
    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
  });

  it("replays a retryable provider-not-dispatched failure after the startup scan", async () => {
    const queueId = await enqueueNotice();
    mocks.sendDurableMessageBatch.mockImplementationOnce(async (request) => {
      await markAttempt(request);
      return {
        status: "failed",
        error: new PlatformMessageNotDispatchedError("connect failed before dispatch", {
          cause: new Error("connect failed"),
        }),
      };
    });
    mocks.recoveryDeliver.mockResolvedValueOnce([
      { channel: "whatsapp", messageId: "recovered-1" },
    ]);

    await deliverNotice(queueId);

    expect(mocks.recoveryDeliver).toHaveBeenCalledOnce();
    expect(await loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("completed");
  });

  it("does not blindly resend an ambiguous platform attempt", async () => {
    const queueId = await enqueueNotice();
    mocks.sendDurableMessageBatch.mockImplementationOnce(async (request) => {
      await markAttempt(request);
      return { status: "failed", error: new Error("platform outcome unknown") };
    });

    await deliverNotice(queueId);

    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
    expect(await loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("failed");
  });

  it("dead-letters a permanent provider rejection without replay", async () => {
    const queueId = await enqueueNotice();
    mocks.sendDurableMessageBatch.mockImplementationOnce(async (request) => {
      await markAttempt(request);
      return {
        status: "failed",
        error: new PlatformMessageNotDispatchedError("payload rejected", {
          cause: new Error("invalid payload"),
          retryable: false,
        }),
      };
    });

    await deliverNotice(queueId);

    expect(mocks.recoveryDeliver).not.toHaveBeenCalled();
    expect(await loadPendingDelivery(queueId)).toBeNull();
    expect(queueStatus(queueId)).toBe("failed");
  });

  it("preserves the shipped 45-attempt budget before dead-lettering", async () => {
    const queueId = await enqueueNotice();
    const retryableFailure = () =>
      new PlatformMessageNotDispatchedError("transport unavailable before dispatch", {
        cause: new Error("transport unavailable"),
      });
    mocks.sendDurableMessageBatch.mockImplementationOnce(async (request) => {
      await markAttempt(request);
      return { status: "failed", error: retryableFailure() };
    });
    mocks.recoveryDeliver.mockImplementation(async (request) => {
      await markAttempt(request);
      throw retryableFailure();
    });

    await deliverNotice(queueId);

    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledOnce();
    expect(mocks.recoveryDeliver).toHaveBeenCalledTimes(44);
    expect(queueStatus(queueId)).toBe("failed");
  });
});
