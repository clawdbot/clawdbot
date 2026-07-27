// Exercises restart-notice retries against the real SQLite outbound queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { loadPendingDelivery } from "../infra/outbound/delivery-queue-storage.js";
import { markDeliveryPlatformSendAttemptStarted } from "../infra/outbound/delivery-queue.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(),
  recoveryDeliver: vi.fn(),
  resolveOutboundChannelMessageAdapter: vi.fn(() => undefined),
  sleep: vi.fn(async () => {}),
}));

vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: mocks.sendDurableMessageBatch,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloadsInternal: mocks.recoveryDeliver,
}));

vi.mock("../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: mocks.resolveOutboundChannelMessageAdapter,
}));

vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));

const { deliverRestartSentinelNotice, enqueueRestartSentinelNotice } =
  await import("./server-restart-sentinel-notice.js");

type DeliveryRequest = { deliveryQueueId?: string; deliveryQueueStateDir?: string };

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
  });

  async function enqueueNotice(): Promise<string> {
    const queued = await enqueueRestartSentinelNotice({
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
    return getDeliveryQueueEntryStatus("outbound", queueId, stateDir);
  }

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
