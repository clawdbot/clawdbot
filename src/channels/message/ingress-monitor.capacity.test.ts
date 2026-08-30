// Ingress monitor tests covering how deferred deliveries occupy start capacity.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("channel ingress monitor start capacity", () => {
  // A delivery that defers has already released its lane and handed off its
  // claim, so the drain no longer serializes it. Counting it against startLimit
  // lets a handful of waiting deliveries stall every other lane until they
  // finish - the shape LINE's forming image sets hit, and reachable from any of
  // the six channels that defer (feishu, irc, line, slack, telegram, twitch).
  it("keeps claiming other lanes while deferred deliveries wait", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-capacity-"),
    });
    const started: string[] = [];
    let releaseParked = () => {};
    const parked = new Promise<void>((resolve) => {
      releaseParked = resolve;
    });
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: async (raw, lifecycle) => {
        started.push(raw.id);
        if (raw.id === "event-unrelated") {
          return { kind: "completed" };
        }
        // Park like a forming batch: lane released, claim still held.
        lifecycle.onDeferred();
        await parked;
        return { kind: "completed" };
      },
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        deferredLaneOccupancy: "release",
        startLimit: 2,
      },
    });

    monitor.start();
    try {
      await monitor.admit({ id: "event-parked-a", lane: "a", text: "a" });
      await monitor.admit({ id: "event-parked-b", lane: "b", text: "b" });
      await vi.waitFor(() => expect(started).toEqual(["event-parked-a", "event-parked-b"]));

      await monitor.admit({ id: "event-unrelated", lane: "c", text: "c" });
      // Both start slots are held by parked deliveries. An unrelated lane must
      // still be claimed rather than waiting for them to settle.
      await vi.waitFor(() => expect(started).toContain("event-unrelated"));
    } finally {
      releaseParked();
      await monitor.stop();
    }
  });

  // The discount cannot be unbounded: parked callbacks still hold memory and a
  // durable claim each. Past startLimit deferrals the discount stops, so the
  // drain waits instead of starting an unbounded number of parked deliveries.
  it("stops starting work once the deferred budget is spent, and recovers", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-budget-"),
    });
    const started: string[] = [];
    let releaseParked = () => {};
    const parked = new Promise<void>((resolve) => {
      releaseParked = resolve;
    });
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: async (raw, lifecycle) => {
        started.push(raw.id);
        if (raw.id === "event-after-budget") {
          return { kind: "completed" };
        }
        lifecycle.onDeferred();
        await parked;
        return { kind: "completed" };
      },
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        deferredLaneOccupancy: "release",
        startLimit: 2,
      },
    });

    monitor.start();
    try {
      // Two slots plus a two-deferral budget: four parked deliveries saturate it.
      for (const lane of ["a", "b", "c", "d"]) {
        await monitor.admit({ id: `event-parked-${lane}`, lane, text: lane });
      }
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 10_000 });

      await monitor.admit({ id: "event-after-budget", lane: "e", text: "e" });
      // Nothing left to spend: the fifth lane waits rather than parking too.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(started).not.toContain("event-after-budget");

      releaseParked();
      // Recovery: the budget frees as the parked deliveries settle.
      await vi.waitFor(() => expect(started).toContain("event-after-budget"), { timeout: 10_000 });
    } finally {
      releaseParked();
      await monitor.stop();
    }
  });
});
