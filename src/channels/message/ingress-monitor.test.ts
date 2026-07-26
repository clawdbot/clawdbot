import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorDeliveryResult,
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
  deliver: (
    raw: RawEvent,
    lifecycle: ChannelIngressMonitorLifecycle,
  ) =>
    | Promise<ChannelIngressMonitorDeliveryResult | void>
    | ChannelIngressMonitorDeliveryResult
    | void,
  activityOrMonitorOptions?:
    | ((active: boolean) => void)
    | {
        admissionMode?: "durable-after-stop";
        waitForDeliveryIdleBeforeRepump?: boolean;
        waitForDeliveryIdleOnStop?: boolean;
      },
  onError?: (error: unknown) => void,
  abortSignal?: AbortSignal,
  pollIntervalMs = 10,
  retryBaseMs = 1_000,
) {
  const onActivityChange =
    typeof activityOrMonitorOptions === "function" ? activityOrMonitorOptions : undefined;
  const monitorOptions =
    typeof activityOrMonitorOptions === "object" ? activityOrMonitorOptions : {};
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
    pollIntervalMs,
    retention: { pruneIntervalMs: 60_000 },
    ...monitorOptions,
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: retryBaseMs, maxMs: retryBaseMs },
      resolveNonRetryableFailure: (error) =>
        error instanceof PermanentIngressError
          ? { reason: "invalid-event", message: error.message }
          : null,
    },
    ...(onActivityChange ? { onActivityChange } : {}),
    ...(onError ? { onError } : {}),
    ...(abortSignal ? { abortSignal } : {}),
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
      await expect(
        monitor.admit({ id: "event-terminal", lane: "a", text: "ignored" }),
      ).resolves.toMatchObject({ kind: "durable" });
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
  it("rechecks identity against a derived lane for legacy rows", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue("event-derived", {
        version: 1,
        rawEvent: JSON.stringify({ id: "event-derived", lane: "a", text: "hello" }),
      });
      const deliver = vi.fn();
      const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
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
          deriveLaneKey: () => "lane:a",
          resolveNonRetryableFailure: (error) =>
            error instanceof PermanentIngressError
              ? { reason: "invalid-event", message: error.message }
              : null,
        },
      });
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });
  it("drains a newly admitted unrelated lane while another delivery is active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        if (raw.id === "event-first") {
          await firstDone;
        }
        await lifecycle.onAdopted();
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "b", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("can await claim startup without waiting for active delivery", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const deliver = vi.fn(async () => {
        await deliveryGate;
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();

      await monitor.admit({ id: "event-started", lane: "a", text: "hello" });
      await monitor.waitForPumpIdle();

      expect(deliver).toHaveBeenCalledOnce();
      releaseDelivery();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("drains the next same-lane event after adoption while delivery remains active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        await lifecycle.onAdopted();
        if (raw.id === "event-first") {
          await firstDone;
        }
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "a", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("re-arms a coalesced idle wake for a later retryable delivery", async () => {
    await withQueue(async (queue) => {
      let releaseFirst = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseRetry = () => {};
      const retryGate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      const delivered: string[] = [];
      let retryAttempts = 0;
      const monitor = createMonitor(
        queue,
        async (raw) => {
          delivered.push(raw.id);
          if (raw.id === "event-first") {
            await firstGate;
          } else if (retryAttempts++ === 0) {
            await retryGate;
            return { kind: "failed-retryable", error: new Error("retry") };
          }
          return { kind: "completed" };
        },
        undefined,
        undefined,
        undefined,
        60_000,
        0,
      );
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "first", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));
      await monitor.admit({ id: "event-retry", lane: "retry", text: "retry" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-retry"]));

      releaseFirst();
      await vi.waitFor(async () =>
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["event-retry"]),
      );
      releaseRetry();
      await vi.waitFor(() =>
        expect(delivered).toEqual(["event-first", "event-retry", "event-retry"]),
      );
      await monitor.waitForIdle();

      await monitor.stop();
    });
  });

  it("reports active delivery work until the channel callback settles", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery: (() => void) | undefined;
      const deliveryDone = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const activity: boolean[] = [];
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          await lifecycle.onAdopted();
          await deliveryDone;
        },
        (active) => activity.push(active),
      );
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;

      await monitor.admit({ id: "event-active", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(activity).toContain(true));
      expect(activity.at(-1)).toBe(true);

      releaseDelivery?.();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
      await monitor.stop();
    });
  });

  it("isolates activity observer failures from delivery bookkeeping", async () => {
    await withQueue(async (queue) => {
      const observerError = new Error("observer failed");
      const onError = vi.fn();
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(
        queue,
        deliver,
        () => {
          throw observerError;
        },
        onError,
      );
      monitor.start();

      await monitor.admit({ id: "event-observer", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(observerError);
      await monitor.stop();
    });
  });

  it("releases a pre-adoption delivery for retry before disposing on stop", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await new Promise<void>((resolve) => {
          if (lifecycle.abortSignal.aborted) {
            resolve();
            return;
          }
          lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-retry", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      await expect(queue.listClaims()).resolves.toEqual([]);
      await expect(queue.listPending()).resolves.toEqual([
        expect.objectContaining({ id: "event-stop-retry", lastError: expect.any(String) }),
      ]);
      await expect(monitor.waitForIdle()).resolves.toBeUndefined();
    });
  });

  it("does not let a blocked settlement write wedge stop", async () => {
    await withQueue(async (queue) => {
      let markReleaseStarted = () => {};
      const releaseStarted = new Promise<void>((resolve) => {
        markReleaseStarted = resolve;
      });
      let releaseSettlement = () => {};
      const settlementGate = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      const release = queue.release.bind(queue);
      const blockedRelease: typeof queue.release = async (idOrClaim, releaseOptions) => {
        markReleaseStarted();
        await settlementGate;
        return await release(idOrClaim, releaseOptions);
      };
      queue.release = vi.fn(blockedRelease);
      const monitor = createMonitor(queue, async () => ({
        kind: "failed-retryable",
        error: new Error("retry later"),
      }));
      monitor.start();
      await monitor.admit({ id: "event-stop-settlement", lane: "a", text: "hello" });
      await releaseStarted;

      const stopping = monitor.stop();
      let stopped = false;
      void stopping.then(() => {
        stopped = true;
      });
      try {
        await vi.waitFor(() => expect(stopped).toBe(true));
      } finally {
        releaseSettlement();
        await stopping;
      }
    });
  });

  it("clears a queued drain request when abort wins an active pump", async () => {
    await withQueue(async (queue) => {
      let markPruneStarted = () => {};
      const pruneStarted = new Promise<void>((resolve) => {
        markPruneStarted = resolve;
      });
      let releasePrune = () => {};
      const pruneGate = new Promise<void>((resolve) => {
        releasePrune = resolve;
      });
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        markPruneStarted();
        await pruneGate;
        return await prune(...args);
      };
      const abortController = new AbortController();
      const monitor = createMonitor(queue, vi.fn(), undefined, undefined, abortController.signal);
      monitor.start();
      await pruneStarted;

      await monitor.admit({ id: "event-abort-requested", lane: "a", text: "hello" });
      abortController.abort();
      releasePrune();

      await expect(monitor.waitForIdle()).resolves.toBeUndefined();
      await monitor.stop();
    });
  });

  it("stops with an outstanding deferred claim without waiting for adoption", async () => {
    await withQueue(async (queue) => {
      let deferredSignal: AbortSignal | undefined;
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        deferredSignal = lifecycle.abortSignal;
        lifecycle.onDeferred();
      });
      monitor.start();
      await monitor.admit({ id: "event-stop-deferred", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deferredSignal).toBeDefined());

      await expect(monitor.stop()).resolves.toBeUndefined();

      expect(deferredSignal?.aborted).toBe(true);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
    });
  });
  it("keeps append-only admission available after stop when explicitly requested", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn();
      const retired = createMonitor(queue, deliver, { admissionMode: "durable-after-stop" });
      retired.start();
      await retired.stop();

      await expect(
        retired.admit({ id: "event-late", lane: "a", text: "after unregister" }),
      ).resolves.toMatchObject({ kind: "durable" });
      expect(deliver).not.toHaveBeenCalled();

      const recovered = createMonitor(queue, deliver);
      recovered.start();
      await recovered.waitForIdle();
      expect(deliver).toHaveBeenCalledOnce();
      await recovered.stop();
    });
  });

  it("can defer delivery-idle waiting to a channel-owned shutdown grace", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery!: () => void;
      let markDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => {
        markDeliveryStarted = resolve;
      });
      const monitor = createMonitor(
        queue,
        async () => {
          markDeliveryStarted();
          await new Promise<void>((resolve) => {
            releaseDelivery = resolve;
          });
        },
        { waitForDeliveryIdleBeforeRepump: false, waitForDeliveryIdleOnStop: false },
      );
      monitor.start();
      await monitor.admit({ id: "event-active", lane: "a", text: "hello" });
      await deliveryStarted;

      await monitor.stop();
      releaseDelivery();
      await monitor.waitForIdle();
    });
  });
});
