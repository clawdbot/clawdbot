// Telegram ingress drain adapter: dispatch result propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import { telegramSpooledUpdateLaneKey } from "./telegram-ingress-spool.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["111"],
      dmPolicy: "allowlist",
    },
  },
} as OpenClawConfig;

function updatePayload(updateId: number): TelegramSpooledUpdatePayload {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: {
        text: "hello",
        from: { id: 111 },
        chat: { id: 111, type: "private" },
      },
    },
  };
}

describe("createTelegramIngressMonitor", () => {
  it("propagates failed-retryable dispatch results as claim release (not tombstone)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "1".padStart(16, "0");
      const payload = updatePayload(1);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const retryError = new Error("provider blip");
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => ({ kind: "failed-retryable", error: retryError }),
      });

      monitor.start();
      await monitor.waitForIdle();

      // Failed-retryable must release, not complete — re-enqueue is pending, not tombstone.
      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).not.toBe("completed");
      expect(status.kind === "accepted" || status.kind === "pending").toBe(true);

      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === eventId)).toBe(true);

      await monitor.stop();
    });
  });

  it("tombstones completed dispatch results", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "2".padStart(16, "0");
      const payload = updatePayload(2);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).toBe("completed");
      await monitor.stop();
    });
  });

  it("logs a diagnostic when dispatch records no outcome and defers no participant", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      const eventId = "3".padStart(16, "0");
      const payload = updatePayload(3);
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });

      const logs: string[] = [];
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => {},
        onLog: (message) => logs.push(message),
      });

      monitor.start();
      await monitor.waitForIdle();

      // Silent consumption still completes (skip semantics), but must leave a trace.
      const status = await queue.enqueue(eventId, payload, { laneKey });
      expect(status.kind).toBe("completed");
      expect(
        logs.some((line) => line.includes("completed without a recorded processing outcome")),
      ).toBe(true);
      await monitor.stop();
    });
  });

  it("deferred buffered work does not block later same-lane updates (media_group album)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      // Two album members share one chat lane, like updates with one media_group_id.
      const eventIdA = "10".padStart(16, "0");
      const eventIdB = "11".padStart(16, "0");
      const payloadA = updatePayload(10);
      const payloadB = updatePayload(11);
      const laneA = telegramSpooledUpdateLaneKey(payloadA.update);
      const laneB = telegramSpooledUpdateLaneKey(payloadB.update);
      expect(laneA).toBe(laneB);
      await queue.enqueue(eventIdA, payloadA, { laneKey: laneA });
      await queue.enqueue(eventIdB, payloadB, { laneKey: laneB });

      const dispatched: number[] = [];
      let deferredParticipant:
        | ReturnType<typeof createTelegramSpooledReplayDeferredParticipant>
        | undefined;
      const monitor = createTelegramIngressMonitor({
        queue,
        cfg,
        accountId: "default",
        pollIntervalMs: 10,
        dispatch: async (update, lifecycle) => {
          const updateId = (update as { update_id: number }).update_id;
          dispatched.push(updateId);
          if (updateId === 10) {
            // First album member buffers and defers; the spool claim must stay
            // held without serializing the lane behind the open buffer.
            deferredParticipant = createTelegramSpooledReplayDeferredParticipant(
              `test:${updateId}`,
            );
            expect(deferredParticipant).not.toBeNull();
            return undefined;
          }
          await lifecycle.onAdopted();
          return { kind: "completed" as const };
        },
      });

      monitor.start();
      // The second album member drains while the first member's buffer is open.
      await vi.waitFor(
        () => {
          expect(dispatched).toContain(11);
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(dispatched[0]).toBe(10);

      // Buffer flushes: the deferred work completes and both claims tombstone.
      deferredParticipant?.settle({ kind: "completed" });
      await monitor.waitForIdle();
      const statusA = await queue.enqueue(eventIdA, payloadA, { laneKey: laneA });
      expect(statusA.kind).toBe("completed");
      const statusB = await queue.enqueue(eventIdB, payloadB, { laneKey: laneB });
      expect(statusB.kind).toBe("completed");
      await monitor.stop();
    });
  });
});
