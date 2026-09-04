// Official monitor-owner proof for ingress timeout handoff. Lives beside
// ingress-monitor.test.ts so that suite stays under the test max-lines cap.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";
import { markIngressBoundedProcessingStarted } from "./ingress-processing-handoff.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };
type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-handoff-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(queue: MonitorOptions["queue"], deliver: MonitorOptions["deliver"]) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver,
    pollIntervalMs: 10,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
    },
  });
}

describe("channel ingress monitor watchdog handoff", () => {
  it("retries when delivery never enters bounded processing and the ingress watchdog fires", async () => {
    vi.useFakeTimers();
    await withQueue(async (queue) => {
      let releaseDelivery!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let adopted = 0;
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        await held;
        await lifecycle.onAdopted();
        adopted += 1;
      });
      try {
        monitor.start();
        await monitor.admit({ id: "event-watchdog-retry", lane: "a", text: "hello" });
        await vi.advanceTimersByTimeAsync(20);
        expect(await queue.listClaims()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: "event-watchdog-retry",
            attempts: 1,
            lastError: expect.stringContaining("handler-timeout"),
          },
        ]);
        expect(adopted).toBe(0);
      } finally {
        releaseDelivery();
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("retains one claim through bounded processing longer than the ingress watchdog", async () => {
    vi.useFakeTimers();
    await withQueue(async (queue) => {
      let releaseDelivery!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let adopted = 0;
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        markIngressBoundedProcessingStarted(lifecycle.abortSignal);
        await held;
        await lifecycle.onAdopted();
        adopted += 1;
      });
      try {
        monitor.start();
        await monitor.admit({ id: "event-processing-hold", lane: "a", text: "hello" });
        await vi.advanceTimersByTimeAsync(20);
        expect(await queue.listClaims()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await queue.listClaims()).toHaveLength(1);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

        releaseDelivery();
        await vi.advanceTimersByTimeAsync(0);
        await monitor.waitForIdle();
        expect(adopted).toBe(1);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        await expect(
          queue.enqueue("event-processing-hold", { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });
});
