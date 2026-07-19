import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

class PermanentIngressError extends Error {}

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(
  queue: ChannelIngressQueue<StoredEvent>,
  deliver: (raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => Promise<void> | void,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new PermanentIngressError(kind),
    },
    deliver,
    pollIntervalMs: 10,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      resolveNonRetryableFailure: (error) =>
        error instanceof PermanentIngressError
          ? { reason: "invalid-event", message: error.message }
          : null,
    },
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channel ingress monitor", () => {
  it("adopts terminal no-dispatch events", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, vi.fn());
      monitor.start();
      await monitor.admit({ id: "event-terminal", lane: "a", text: "ignored" });
      await monitor.waitForIdle();

      await expect(
        queue.enqueue("event-terminal", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("fans adoption finalization through before completing the claim", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onAdoptionFinalizing();
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-finalizing", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await expect(
        queue.enqueue("event-finalizing", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("dead-letters a claim whose decoded lane identity changed", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "event-original",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "event-original", lane: "changed", text: "hello" }),
        },
        { laneKey: "lane:original" },
      );
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      await expect(
        queue.enqueue("event-original", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "failed", record: { reason: "invalid-event" } });
      await monitor.stop();
    });
  });
});
