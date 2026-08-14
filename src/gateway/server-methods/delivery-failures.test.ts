import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDeliveryQueueEntryStatus,
  upsertDeliveryQueueEntry,
} from "../../infra/delivery-queue-sqlite.js";
import type { DeliveryQueueEntryState } from "../../infra/delivery-queue-sqlite.types.js";
import {
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "../../infra/outbound/delivery-queue-media-staging.js";
import {
  enqueueDelivery,
  failDeliveryBeforePlatformSend,
  moveToFailed,
} from "../../infra/outbound/delivery-queue-storage.js";
import {
  schedulePendingSessionDeliveries,
  startSessionDeliveryRuntime,
} from "../../infra/session-delivery-queue-runtime.js";
import { testing } from "../../infra/session-delivery-queue-runtime.test-support.js";
import { moveSessionDeliveryToFailed } from "../../infra/session-delivery-queue-storage.js";
import {
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
} from "../../infra/session-delivery-queue.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { deliveryFailureHandlers } from "./delivery-failures.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  testing.reset();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function seedSafeSessionFailure() {
  const id = await enqueueSessionDelivery({
    kind: "systemEvent",
    sessionKey: "agent:main:main",
    text: "retry after restart",
  });
  await moveSessionDeliveryToFailed(id);
  return id;
}

describe("delivery.failures.resubmit", () => {
  it("revives and immediately schedules the exact session delivery", async () => {
    vi.useFakeTimers();
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await seedSafeSessionFailure();
        const reloadPending = vi
          .fn<typeof loadPendingSessionDelivery>()
          .mockImplementation((entryId) => loadPendingSessionDelivery(entryId));
        const stop = startSessionDeliveryRuntime({
          deliver: vi.fn(async () => {}),
          drain: vi.fn(async () => {}),
          log: logger,
          reloadPending,
        });

        const response = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          {
            id,
            queueName: "session",
          },
        );

        expect(response).toEqual({
          ok: true,
          response: {
            ok: true,
            queueName: "session",
            disposition: "scheduled",
          },
          error: undefined,
        });
        expect(reloadPending).toHaveBeenCalledWith(id);
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("pending");
        stop();
      });
    });
  });

  it("truthfully queues for startup when the live scheduler is unavailable", async () => {
    vi.useFakeTimers();
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await seedSafeSessionFailure();
        const response = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          {
            id,
            queueName: "session",
          },
        );

        expect(response.response).toMatchObject({
          ok: true,
          disposition: "queued_for_startup",
        });
        expect(JSON.stringify(response.response)).not.toContain("delivered");
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("pending");

        const deliver = vi.fn(async () => {});
        startSessionDeliveryRuntime({ deliver, log: logger });
        await schedulePendingSessionDeliveries();
        await vi.advanceTimersByTimeAsync(0);

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries()).toStrictEqual([]);
      });
    });
  });

  it("reports durable recovery when immediate session scheduling throws", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await seedSafeSessionFailure();
        const stop = startSessionDeliveryRuntime({
          deliver: vi.fn(async () => {}),
          log: logger,
        });
        const timer = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(() => {
          throw new Error("scheduler unavailable");
        });
        try {
          const response = await callGatewayHandler(
            deliveryFailureHandlers,
            "delivery.failures.resubmit",
            { id, queueName: "session" },
          );

          expect(response).toEqual({
            ok: true,
            response: {
              ok: true,
              queueName: "session",
              disposition: "queued_for_startup",
            },
            error: undefined,
          });
          expect(getDeliveryQueueEntryStatus("session", id)).toBe("pending");

          const retry = await callGatewayHandler(
            deliveryFailureHandlers,
            "delivery.failures.resubmit",
            { id, queueName: "session" },
          );
          expect(retry.response).toMatchObject({ ok: false, reason: "not_failed" });
        } finally {
          timer.mockRestore();
          stop();
        }
      });
    });
  });

  it("leaves refused ownership failed and rejects non-schema params", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await seedSafeSessionFailure();
        const invalid = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id, queueName: "session", payload: "not allowed" },
        );
        expect(invalid).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("failed");

        const claimed = await enqueueClaimedSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "claimed retry",
            idempotencyKey: "claimed-rpc-refusal",
          },
          0,
        );
        await moveSessionDeliveryToFailed(claimed.id);
        const refused = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id: claimed.id, queueName: "session" },
        );
        expect(refused.response).toEqual({
          ok: false,
          queueName: "session",
          reason: "fenced",
        });
        expect(getDeliveryQueueEntryStatus("session", claimed.id)).toBe("failed");
      });
    });
  });

  it("queues outbound success for its existing recovery owner", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await enqueueDelivery({
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "retry me" }],
        });
        await failDeliveryBeforePlatformSend(id, "connection refused");
        await moveToFailed(id);

        const response = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id },
        );

        expect(response.response).toEqual({
          ok: true,
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          disposition: "queued_for_recovery",
        });
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id)).toBe("pending");
      });
    });
  });

  it("refuses canonical resubmit while any retired outbound namespace also owns the ID", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await enqueueDelivery({
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "canonical collision" }],
        });
        await failDeliveryBeforePlatformSend(id, "connection refused");
        await moveToFailed(id);
        upsertDeliveryQueueEntry({
          queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
          entry: { id, enqueuedAt: 1, retryCount: 0 },
        });

        for (const params of [{ id }, { id, queueName: OUTBOUND_DELIVERY_QUEUE_NAME }]) {
          const response = await callGatewayHandler(
            deliveryFailureHandlers,
            "delivery.failures.resubmit",
            params,
          );
          expect(response.response).toMatchObject({
            ok: false,
            reason: "ambiguous_queue",
          });
          expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id)).toBe("failed");
          expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, id)).toBe(
            "pending",
          );
        }
      });
    });
  });

  it("refuses multiple retired outbound namespace owners", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = "multiple-retired-owners";
        for (const queueName of [
          OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
        ]) {
          upsertDeliveryQueueEntry({
            queueName,
            entry: { id, enqueuedAt: 1, retryCount: 0 },
          });
        }

        const response = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id },
        );

        expect(response.response).toMatchObject({ ok: false, reason: "ambiguous_queue" });
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, id)).toBe(
          "pending",
        );
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, id)).toBe(
          "pending",
        );
      });
    });
  });

  it("refuses an unqualified cross-queue ID and lets exact queues choose independently", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const id = await enqueueDelivery({
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "outbound collision" }],
        });
        await failDeliveryBeforePlatformSend(id, "connection refused");
        await moveToFailed(id);
        upsertDeliveryQueueEntry({
          queueName: "session",
          entry: {
            id,
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "session collision",
            enqueuedAt: Date.now(),
            retryCount: 0,
          } as DeliveryQueueEntryState & {
            kind: "systemEvent";
            sessionKey: string;
            text: string;
          },
        });
        await moveSessionDeliveryToFailed(id);

        const ambiguous = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id },
        );
        expect(ambiguous.response).toEqual({
          ok: false,
          reason: "ambiguous_queue",
        });
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("failed");
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id)).toBe("failed");

        const session = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id, queueName: "session" },
        );
        expect(session.response).toMatchObject({ ok: true, queueName: "session" });
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("pending");
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id)).toBe("failed");

        const outbound = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id, queueName: OUTBOUND_DELIVERY_QUEUE_NAME },
        );
        expect(outbound.response).toMatchObject({
          ok: true,
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        });
        expect(getDeliveryQueueEntryStatus("session", id)).toBe("pending");
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id)).toBe("pending");
      });
    });
  });

  it("keeps an explicitly selected retired outbound namespace migration-owned", async () => {
    await withTestDir({ prefix: "openclaw-delivery-rpc-" }, async (stateDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        upsertDeliveryQueueEntry({
          queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
          entry: { id: "retired-id", enqueuedAt: 1, retryCount: 0 },
        });

        const response = await callGatewayHandler(
          deliveryFailureHandlers,
          "delivery.failures.resubmit",
          { id: "retired-id", queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME },
        );

        expect(response.response).toMatchObject({
          ok: false,
          queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
          reason: "migration_namespace",
        });
        expect(
          getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, "retired-id"),
        ).toBe("pending");
      });
    });
  });
});
