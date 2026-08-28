import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import {
  PlatformMessageNotDispatchedError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  drainMatrixReconnect,
  matrixOutboundForQueueTest,
} from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { DeliverFn } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

beforeAll(async () => {
  ({ deliverOutboundPayloads } = await import("./deliver.js"));
});

describe.each(["live", "recovery"] as const)("ordinary %s batch custody", (entryPoint) => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry());
    vi.unstubAllEnvs();
  });

  it.each(["identified", "identityless-tail", "not-dispatched"] as const)(
    "settles a %s batch from the same platform evidence",
    async (outcome) => {
      const stateDir = fixtures.tmpDir();
      const payloads = [{ text: "first" }, { text: "second" }];
      const sendMatrix = vi.fn(async (_to: string, text: string) => {
        if (outcome === "not-dispatched") {
          throw new PlatformMessageNotDispatchedError("transport rejected before dispatch", {
            cause: undefined,
          });
        }
        return { messageId: outcome === "identityless-tail" && text === "second" ? "" : text };
      });
      const outcomes: OutboundPayloadDeliveryOutcome[] = [];
      const platformStarted = vi.fn();
      let results: OutboundDeliveryResult[] = [];
      const deliver = vi.fn<DeliverFn>(async (params) => {
        results = await deliverOutboundPayloads({
          ...params,
          deps: { matrix: sendMatrix },
          onPlatformSendStart: async (route, sourceIndex) => {
            platformStarted();
            await params.onPlatformSendStart?.(route, sourceIndex);
          },
          onPayloadDeliveryOutcome: (payloadOutcome) => {
            outcomes.push(payloadOutcome);
            params.onPayloadDeliveryOutcome?.(payloadOutcome);
          },
        });
        return results;
      });
      const delivery = {
        channel: "matrix" as const,
        to: "!room:example",
        payloads,
        queuePolicy: "required" as const,
        bestEffort: outcome === "not-dispatched",
      };
      let queueId: string | undefined;
      if (entryPoint === "live") {
        const sending = deliver({
          ...delivery,
          cfg: {},
          onDeliveryIntent: ({ id }) => {
            queueId = id;
          },
        });
        if (outcome === "identityless-tail") {
          await expect(sending).rejects.toMatchObject({
            name: "OutboundDeliveryError",
            sentBeforeError: true,
            results: [{ channel: "matrix", messageId: "first" }],
          });
        } else {
          await sending;
        }
      } else {
        queueId = await enqueueDelivery({ ...delivery, requiresProducerClaim: true }, stateDir);
        await drainMatrixReconnect({ deliver, stateDir });
      }

      const id = expectDefined(queueId, "ordinary batch must acquire queue custody");
      expect(sendMatrix.mock.calls.map((call) => call[1])).toEqual(["first", "second"]);
      // Real nested recovery must receive send-start even when the transport
      // later proves no dispatch; a DB-only marker fixture misses this branch.
      expect(platformStarted).toHaveBeenCalledTimes(2);
      if (outcome === "identified") {
        expect(results.map((result) => result.messageId)).toEqual(["first", "second"]);
        expect(outcomes.map((result) => result.status)).toEqual(["sent", "sent"]);
        expect(await loadPendingDeliveries(stateDir)).toEqual([]);
        expect(
          getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
        ).toBeUndefined();
        return;
      }

      const pending = await loadPendingDeliveries(stateDir);
      expect(pending).toEqual([expect.objectContaining({ id, retryCount: 1 })]);
      expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir)).toBe(
        "pending",
      );
      if (outcome === "identityless-tail") {
        expect(pending[0]?.recoveryState).toBe("unknown_after_send");
        expect(outcomes).toEqual([
          expect.objectContaining({ index: 0, status: "sent" }),
          { index: 1, status: "suppressed", reason: "adapter_returned_no_identity" },
        ]);
        await drainMatrixReconnect({ deliver, stateDir });
        expect(sendMatrix).toHaveBeenCalledTimes(2);
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir)).not.toBe(
          "completed",
        );
        return;
      }

      expect(results).toEqual([]);
      expect(pending[0]?.recoveryState).toBeUndefined();
      expect(pending[0]?.platformSendStartedAt).toBeUndefined();
      expect(outcomes).toEqual([
        expect.objectContaining({ index: 0, status: "failed", sentBeforeError: false }),
        expect.objectContaining({ index: 1, status: "failed", sentBeforeError: false }),
      ]);
      sendMatrix.mockImplementation(async (_to, text) => ({ messageId: text }));
      await drainMatrixReconnect({ deliver, stateDir });
      expect(sendMatrix.mock.calls.map((call) => call[1])).toEqual([
        "first",
        "second",
        "first",
        "second",
      ]);
      expect(results.map((result) => result.messageId)).toEqual(["first", "second"]);
      expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      expect(
        getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir),
      ).toBeUndefined();
    },
  );
});
