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
  // finish - the shape LINE's forming image sets hit. The discount reaches the
  // drains that declare `deferredLaneOccupancy: "release"` (line, slack,
  // telegram); a drain that holds its lane keeps the plain startLimit.
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
  it("returns a settled deferral's slot, so the ceiling still holds afterwards", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-giveback-"),
    });
    const started: string[] = [];
    let releaseHolding = () => {};
    const holding = new Promise<void>((resolve) => {
      releaseHolding = resolve;
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
        if (raw.id.startsWith("event-deferred-")) {
          // Borrows a start slot and settles immediately, so the borrow is over.
          lifecycle.onDeferred();
          return { kind: "completed" };
        }
        await holding;
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
      for (const lane of ["a", "b"]) {
        await monitor.admit({ id: `event-deferred-${lane}`, lane, text: lane });
      }
      await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 10_000 });

      // Both real slots now held by deliveries that never defer.
      for (const lane of ["c", "d"]) {
        await monitor.admit({ id: `event-holding-${lane}`, lane, text: lane });
      }
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 10_000 });

      await monitor.admit({ id: "event-over-ceiling", lane: "e", text: "e" });
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      // A borrowed slot that is never given back would still be discounting here,
      // and this lane would start above startLimit for the rest of the process.
      expect(started).not.toContain("event-over-ceiling");

      releaseHolding();
      await vi.waitFor(() => expect(started).toContain("event-over-ceiling"), { timeout: 10_000 });
    } finally {
      releaseHolding();
      await monitor.stop();
    }
  });
  it("gives no start-slot discount to a drain that holds its lane on deferral", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-hold-"),
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
        lifecycle.onDeferred();
        await parked;
        return { kind: "completed" };
      },
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      // No deferredLaneOccupancy: the default holds the lane, so the deferral has
      // not freed anything and must keep counting against startLimit.
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        startLimit: 1,
      },
    });

    monitor.start();
    try {
      await monitor.admit({ id: "event-parked", lane: "a", text: "a" });
      await vi.waitFor(() => expect(started).toContain("event-parked"), { timeout: 10_000 });

      await monitor.admit({ id: "event-second-lane", lane: "b", text: "b" });
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      expect(started).not.toContain("event-second-lane");

      releaseParked();
      await vi.waitFor(() => expect(started).toContain("event-second-lane"), { timeout: 10_000 });
    } finally {
      releaseParked();
      await monitor.stop();
    }
  });
});
