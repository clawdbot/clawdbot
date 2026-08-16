// Exercises restart-notice retries against the real SQLite outbound queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../infra/outbound/delivery-queue-media-staging.js";
import {
  loadPendingDelivery,
  markDeliveryPlatformSendAttemptStarted,
} from "../infra/outbound/delivery-queue-storage.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

vi.mock("../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: mocks.resolveOutboundChannelMessageAdapter,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { deliverRestartSentinelNotice, enqueueRestartSentinelNotice } =
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

  it("reuses an existing stable notice without preparing another owner", async () => {
    const first = await enqueueRestartSentinelNotice({
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    });
    const second = await enqueueRestartSentinelNotice({
      cfg: {},
      channel: "whatsapp",
      to: "+15550002",
      message: "restart complete",
      sessionKey: "agent:main:main",
      revision: 123,
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
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
