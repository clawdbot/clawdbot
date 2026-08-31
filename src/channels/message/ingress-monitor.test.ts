import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { sleep } from "../../utils/sleep.js";
import { createChannelIngressError } from "./ingress-errors.js";
import {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  createChannelIngressMonitor,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";
import type { IngressRetryPolicyConfig } from "./ingress-retry-policy.js";
import {
  ChannelIngressUnavailableError,
  isChannelIngressUnavailableError,
} from "./ingress-unavailable.js";

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
  queue: ChannelIngressQueue<StoredEvent> | (() => ChannelIngressQueue<StoredEvent>),
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
        deferredClaims?: "wait-on-stop" | "settle-on-abort" | "manual";
        inspect?: (raw: RawEvent) => { eventId: string; laneKey: string } | null;
        retention?:
          | "standard"
          | Partial<{
              pruneIntervalMs: number;
              completedTtlMs: number;
              completedMaxEntries: number;
              failedTtlMs: number;
              failedMaxEntries: number;
            }>;
        now?: () => number;
        waitForDeliveryIdleBeforeRepump?: boolean;
        waitForDeliveryIdleOnStop?: boolean;
        retryPolicy?: IngressRetryPolicyConfig;
        deferredLaneOccupancy?: "hold" | "release";
        runPumpTask?: (work: () => Promise<void>) => Promise<void>;
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
  const { inspect, retryPolicy, deferredLaneOccupancy, ...baseMonitorOptions } = monitorOptions;
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: inspect ?? ((raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` })),
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
    ...baseMonitorOptions,
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: retryPolicy ?? { baseMs: retryBaseMs, maxMs: retryBaseMs },
      ...(deferredLaneOccupancy ? { deferredLaneOccupancy } : {}),
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

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

afterEach(() => {
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channel ingress monitor", () => {
  it("creates named plain and reasoned ingress errors", () => {
    const PayloadError = createChannelIngressError("TestIngressPayloadError");
    const PermanentError = createChannelIngressError<"invalid-event">("TestIngressPermanentError", {
      withReason: true,
    });

    expect(PayloadError.name).toBe("TestIngressPayloadError");
    const payloadError = new PayloadError("invalid");
    expect(payloadError).toMatchObject({
      name: "TestIngressPayloadError",
      message: "invalid",
    });
    expect(payloadError).toBeInstanceOf(PayloadError);
    expect("reason" in payloadError).toBe(false);
    expect(new PermanentError("invalid-event", "invalid")).toMatchObject({
      name: "TestIngressPermanentError",
      reason: "invalid-event",
      message: "invalid",
    });
  });

  it("applies standard retention with explicit per-channel overrides", async () => {
    for (const [retention, completedMaxEntries] of [
      ["standard", 20_000],
      [{ completedMaxEntries: 1_000 }, 1_000],
    ] as const) {
      await withQueue(async (queue) => {
        let currentTime = CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        const prune = vi.spyOn(queue, "prune");
        const monitor = createMonitor(queue, vi.fn(), {
          retention,
          now: () => currentTime,
        });
        monitor.start();
        await monitor.waitForIdle();

        expect(prune).toHaveBeenCalledOnce();
        expect(prune).toHaveBeenCalledWith({
          completedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.completedTtlMs,
          completedMaxEntries,
          failedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedTtlMs,
          failedMaxEntries: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedMaxEntries,
          now: expect.any(Number),
        });

        currentTime += CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        monitor.requestDrain();
        await monitor.waitForPumpIdle();
        expect(prune).toHaveBeenCalledTimes(2);
        await monitor.stop();
      });
    }
  });

  it("does not prune zero-interval retention from startup or idle polls", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const monitor = createMonitor(queue, vi.fn(), {
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      monitor.start();
      await sleep(65);
      await monitor.stop();

      expect(prune).not.toHaveBeenCalled();
    });
  });

  it("skips ignored events and prunes once before one admission enqueue", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const enqueue = vi.spyOn(queue, "enqueue");
      const monitor = createMonitor(queue, vi.fn(), {
        inspect: (raw) =>
          raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      await expect(monitor.admit({ id: "ignored", lane: "a", text: "receipt" })).resolves.toEqual({
        kind: "ignored",
      });
      expect(prune).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();

      await monitor.admit({ id: "event-one", lane: "a", text: "hello" });
      expect(prune).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledOnce();
      expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...enqueue.mock.invocationCallOrder),
      );
      await monitor.stop();
    });
  });

  it("prunes zero-interval retention once before a multi-event batch", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const enqueue = vi.spyOn(queue, "enqueue");
      const monitor = createMonitor(queue, vi.fn(), {
        inspect: (raw) =>
          raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      await monitor.admitBatch([
        { id: "ignored", lane: "a", text: "receipt" },
        { id: "event-batch-1", lane: "a", text: "first" },
        { id: "event-batch-2", lane: "b", text: "second" },
        { id: "event-batch-3", lane: "c", text: "third" },
      ]);

      expect(prune).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...enqueue.mock.invocationCallOrder),
      );
      await monitor.stop();
    });
  });

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

  // Telegram and Slack release the ingress lane while a turn is deferred, so a
  // newer same-lane event can be claimed and fail while the older one is still
  // held. Cancelling that deferred owner reopens its row without consuming retry
  // budget, leaving an eligible lane head behind its own newer sibling's backoff.
  it("dispatches a reopened lane head while its newer sibling waits out backoff", async () => {
    await withQueue(async (queue) => {
      const delivered: string[] = [];
      let cancelHead: (() => Promise<void>) | undefined;
      const monitor = createMonitor(
        queue,
        async (raw, lifecycle) => {
          delivered.push(raw.id);
          if (raw.id !== "event-head") {
            return { kind: "failed-retryable", error: new Error("tail delivery failed") };
          }
          if (cancelHead) {
            return { kind: "completed" };
          }
          cancelHead = async () => await lifecycle.onCancelled?.();
          return { kind: "deferred" };
        },
        {
          deferredLaneOccupancy: "release",
          retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        },
      );
      monitor.start();
      await monitor.admit({ id: "event-head", lane: "a", text: "head" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head"]));
      await monitor.admit({ id: "event-tail", lane: "a", text: "tail" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail"]));
      // The failed tail is pending inside its backoff; the head is still claimed.
      await vi.waitFor(async () =>
        expect(
          (await queue.listPending({ limit: "all", orderBy: "received" })).map((event) => event.id),
        ).toEqual(["event-tail"]),
      );

      expect(cancelHead).toBeDefined();
      await cancelHead?.();

      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail", "event-head"]));
      await monitor.waitForIdle();
      // The tail still never starts early: it stays parked for its own backoff.
      expect(delivered).toEqual(["event-head", "event-tail", "event-head"]);

      await monitor.stop();
    });
  });

  it("defers a claimed event across restart drain without consuming retry budget", async () => {
    await withQueue(async (queue) => {
      const event = {
        id: "event-restart-drain",
        lane: "a",
        text: "recover me",
      } satisfies RawEvent;
      const storedEvent = {
        version: 1,
        rawEvent: JSON.stringify(event),
      } satisfies StoredEvent;
      const drainErrors: unknown[] = [];
      const oldDeliver = vi.fn(
        async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          try {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          } catch (error) {
            drainErrors.push(error);
            throw error;
          }
        },
      );
      const monitorOptions = {
        retryPolicy: {
          maxAttempts: 8,
          deadLetterMinAgeMs: 0,
          baseMs: 0,
          maxMs: 0,
        },
      } as const;
      const oldMonitor = createMonitor(
        queue,
        oldDeliver,
        monitorOptions,
        undefined,
        undefined,
        60_000,
      );
      let successorMonitor: ReturnType<typeof createMonitor> | undefined;
      oldMonitor.start();
      try {
        await oldMonitor.waitForIdle();

        let markPendingScanStarted = () => {};
        const pendingScanStarted = new Promise<void>((resolve) => {
          markPendingScanStarted = resolve;
        });
        let releasePendingScan = () => {};
        const pendingScanGate = new Promise<void>((resolve) => {
          releasePendingScan = resolve;
        });
        const listPending = queue.listPending.bind(queue);
        let gateNextPendingScan = true;
        queue.listPending = async (...args) => {
          if (gateNextPendingScan) {
            gateNextPendingScan = false;
            markPendingScanStarted();
            await pendingScanGate;
          }
          return await listPending(...args);
        };

        oldMonitor.requestDrain();
        await pendingScanStarted;
        markGatewayRestartDraining();
        await queue.enqueue(event.id, storedEvent, { laneKey: "lane:a" });
        releasePendingScan();
        await vi.waitFor(() => expect(drainErrors.length).toBeGreaterThan(0));

        for (let cycle = 0; cycle < 8; cycle += 1) {
          oldMonitor.requestDrain();
          await oldMonitor.waitForIdle();
        }

        expect(drainErrors[0]).toBeInstanceOf(GatewayDrainingError);
        expect(drainErrors).toHaveLength(1);
        expect(oldDeliver).toHaveBeenCalledOnce();
        await expect(queue.listClaims()).resolves.toEqual([]);
        await expect(queue.listPending()).resolves.toEqual([
          expect.objectContaining({ id: event.id, attempts: 0 }),
        ]);
        await expect(queue.listFailed?.()).resolves.toEqual([]);

        await oldMonitor.stop();
        resetGatewayWorkAdmission();
        const successorDeliver = vi.fn(
          async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          },
        );
        successorMonitor = createMonitor(
          queue,
          successorDeliver,
          monitorOptions,
          undefined,
          undefined,
          60_000,
        );
        successorMonitor.start();
        await successorMonitor.waitForIdle();

        expect(successorDeliver).toHaveBeenCalledOnce();
        expect(oldDeliver).toHaveBeenCalledOnce();
        await expect(
          queue.enqueue(event.id, { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await successorMonitor?.stop();
        await oldMonitor.stop();
        resetGatewayWorkAdmission();
      }
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
        await waitForAbort(lifecycle.abortSignal);
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

  it("keeps a started delivery admissible after its detached pump root releases", async () => {
    await withQueue(async (queue) => {
      let releaseDeliver = () => {};
      const deliverGate = new Promise<void>((resolve) => {
        releaseDeliver = resolve;
      });
      let admissionClosedDuringDelivery: boolean | undefined;
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await deliverGate;
        admissionClosedDuringDelivery = isGatewaySubordinateWorkAdmissionClosed();
        await lifecycle.onAdopted();
      });
      let markPumpTaskSettled = () => {};
      const pumpTaskSettled = new Promise<void>((resolve) => {
        markPumpTaskSettled = resolve;
      });
      // Mirror the production webhook-spool combination: the pump runs on its
      // own detached root and does not wait for deliveries before returning.
      const monitor = createMonitor(queue, deliver, {
        waitForDeliveryIdleBeforeRepump: false,
        runPumpTask: (work) =>
          runWithGatewayIndependentRootWorkContinuation(work).finally(() => markPumpTaskSettled()),
      });
      monitor.start();
      try {
        // Admit inside its own root and let it release right away, the way an
        // ack-first webhook request root releases once the 200 is written.
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await monitor.admit({ id: "event-detached-root", lane: "a", text: "hello" });
        });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        // The pump returns while the delivery is still in flight; every root
        // the dispatch could have inherited is released at this point.
        await pumpTaskSettled;
        releaseDeliver();

        await vi.waitFor(() => expect(admissionClosedDuringDelivery).toBeDefined());
        expect(admissionClosedDuringDelivery).toBe(false);
        await monitor.waitForIdle();
        await expect(queue.listPending()).resolves.toEqual([]);
        await expect(queue.listClaims()).resolves.toEqual([]);
      } finally {
        releaseDeliver();
        await monitor.stop();
      }
    });
  });

  it("dispatches outside an already-released inherited root instead of refusing", async () => {
    await withQueue(async (queue) => {
      let releaseDeliver = () => {};
      const deliverGate = new Promise<void>((resolve) => {
        releaseDeliver = resolve;
      });
      let admissionClosedDuringDelivery: boolean | undefined;
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await deliverGate;
        admissionClosedDuringDelivery = isGatewaySubordinateWorkAdmissionClosed();
        await lifecycle.onAdopted();
      });
      // No runPumpTask: the pump chain inherits the admitting caller's context,
      // the way a transport request that enqueues an event does.
      const monitor = createMonitor(queue, deliver, {}, undefined, undefined, 60_000);
      let markPendingScanStarted = () => {};
      const pendingScanStarted = new Promise<void>((resolve) => {
        markPendingScanStarted = resolve;
      });
      let releasePendingScan = () => {};
      const pendingScanGate = new Promise<void>((resolve) => {
        releasePendingScan = resolve;
      });
      const listPending = queue.listPending.bind(queue);
      let gateNextPendingScan = true;
      queue.listPending = async (...args) => {
        if (gateNextPendingScan) {
          gateNextPendingScan = false;
          markPendingScanStarted();
          await pendingScanGate;
        }
        return await listPending(...args);
      };
      monitor.start();
      try {
        // Admit inside a root that releases as soon as the enqueue returns;
        // the gated scan keeps the claim from happening until after that.
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await monitor.admit({ id: "event-released-root", lane: "a", text: "hello" });
          await pendingScanStarted;
        });
        releasePendingScan();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        releaseDeliver();

        await vi.waitFor(() => expect(admissionClosedDuringDelivery).toBeDefined());
        expect(admissionClosedDuringDelivery).toBe(false);
        await monitor.waitForIdle();
        await expect(queue.listClaims()).resolves.toEqual([]);
      } finally {
        releaseDeliver();
        releasePendingScan();
        await monitor.stop();
      }
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

  it("completes deliveries whose terminal result races a stop abort", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "completed" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-completed", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // Side effects finished and the channel reported completed; settling the
      // claim for retry would replay already-delivered work on restart.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toEqual([]);
    });
  });

  it("keeps deferred handoffs with their owner when a stop abort races the return", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onDeferred();
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "deferred" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-deferred-race", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // The deferred owner still owns the claim; releasing it for retry would
      // replay work the owner is completing.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
    });
  });

  it("keeps a deferred handoff when stop abort races a conflicting completed return", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onDeferred();
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "completed" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-deferred-then-completed", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // A recorded handoff owns the claim, so stop cannot rewrite the
      // conflicting terminal return and release the row for replay.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
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

  it("waits for tracked deferred claims to settle after drain disposal", async () => {
    await withQueue(async (queue) => {
      let deferredLifecycle: ChannelIngressMonitorLifecycle | undefined;
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          deferredLifecycle = lifecycle;
          lifecycle.onDeferred();
        },
        { deferredClaims: "wait-on-stop" },
      );
      monitor.start();
      await monitor.admit({ id: "event-tracked-deferred", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deferredLifecycle).toBeDefined());

      let stopped = false;
      const stopping = monitor.stop().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => expect(deferredLifecycle?.abortSignal.aborted).toBe(true));
      expect(stopped).toBe(false);

      await deferredLifecycle?.onAbandoned();
      await stopping;
      expect(stopped).toBe(true);
    });
  });

  it("can settle tracked deferred bookkeeping on abort", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          lifecycle.onDeferred();
        },
        { deferredClaims: "settle-on-abort" },
      );
      monitor.start();
      await monitor.admit({ id: "event-abort-deferred", lane: "a", text: "hello" });

      await expect(monitor.stop()).resolves.toBeUndefined();
      await expect(monitor.waitForDeferredClaims()).resolves.toBeUndefined();
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

  it("can prepare the durable queue before starting the drain", async () => {
    await withQueue(async (queue) => {
      const queueFactory = vi.fn(() => queue);
      const monitor = createMonitor(queueFactory, vi.fn());

      monitor.ensureQueueAvailable();
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(monitor.isRunning()).toBe(false);

      monitor.start();
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(monitor.isRunning()).toBe(true);
      await monitor.stop();
    });
  });

  it("fails start once when the durable queue cannot be opened", async () => {
    const denial = new Error(
      'openChannelIngressQueue is only available for trusted plugins in this release. Plugin "slack" loaded with origin "config"',
    );
    const queueFactory = vi.fn((): ChannelIngressQueue<StoredEvent> => {
      throw denial;
    });
    const onError = vi.fn();
    const monitor = createMonitor(queueFactory, vi.fn(), undefined, onError, undefined, 1);

    // The typed rethrow is the gateway's only way to tell dead inbound apart from
    // an ordinary channel crash; the denial stays reachable as the cause.
    const startError = (() => {
      try {
        monitor.start();
        return expect.unreachable("start must fail while the durable queue is denied");
      } catch (error) {
        return error;
      }
    })();
    expect(startError).toBeInstanceOf(ChannelIngressUnavailableError);
    expect((startError as Error).cause).toBe(denial);
    expect(isChannelIngressUnavailableError(startError)).toBe(true);
    // A channel plugin is free to wrap the start failure in its own error.
    expect(
      isChannelIngressUnavailableError(new Error("slack start failed", { cause: startError })),
    ).toBe(true);
    expect(isChannelIngressUnavailableError(denial)).toBe(false);
    expect(monitor.isRunning()).toBe(false);
    // An armed poll timer would have retried the denied factory many times over this window.
    await sleep(25);
    expect(queueFactory).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();

    // Accepted transport input still fails closed rather than being silently dropped.
    await expect(monitor.admit({ id: "event-denied", lane: "a", text: "hello" })).rejects.toBe(
      denial,
    );
    await monitor.stop();
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
