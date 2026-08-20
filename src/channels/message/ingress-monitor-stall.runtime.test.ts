// Real-time ingress boundary proof: a transport admission that stalls before
// adoption remains durably owned, is released only after quiescence, and then
// completes on retry. Deliberately avoids fake timers and mocked queue methods.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RuntimeEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress monitor: stalled transport runtime proof", () => {
  it("holds the live lease through the cancellation fence, then retries to completion", async () => {
    const stateDir = tempDirs.make("openclaw-ingress-stall-runtime-");
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "runtime-proof",
      accountId: "default",
      stateDir,
    });
    const logs: string[] = [];
    const dispatchStartedAt: number[] = [];
    let abortObserved = false;
    let releaseFirstDispatch!: () => void;
    const firstDispatchGate = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });

    const monitor = createChannelIngressMonitor<RuntimeEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RuntimeEvent,
        createClaimError: (kind) => new Error(kind),
      },
      pollIntervalMs: 20,
      retention: { pruneIntervalMs: 60_000 },
      drain: {
        adoptionStallTimeoutMs: 100,
        retryPolicy: {
          baseMs: 25,
          maxMs: 25,
          maxAttempts: 3,
          deadLetterMinAgeMs: 60_000,
        },
        onLog: (message) => logs.push(message),
      },
      deliver: async (_raw, lifecycle) => {
        dispatchStartedAt.push(Date.now());
        let result: { kind: "completed" } | undefined;
        if (dispatchStartedAt.length === 1) {
          // Model an abort-ignoring transport handoff. It exits only when the
          // external participant eventually returns, after the real 10s fence.
          lifecycle.abortSignal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
            },
            { once: true },
          );
          await firstDispatchGate;
        } else {
          await lifecycle.onAdopted();
          result = { kind: "completed" };
        }
        return result;
      },
    });

    monitor.start();
    const admission = await monitor.admit({
      id: "runtime-stall-message",
      lane: "conversation-1",
      text: "preserve this inbound message",
    });
    expect(admission.kind).toBe("durable");
    await expect.poll(() => dispatchStartedAt.length, { timeout: 2_000 }).toBe(1);

    // Exercise the private production cancellation fence with wall-clock
    // timers. The claim must remain held and refreshed throughout.
    await expect
      .poll(() => logs.some((line) => line.includes("holding ownership instead of releasing")), {
        timeout: 12_000,
        interval: 25,
      })
      .toBe(true);
    expect(abortObserved).toBe(true);
    expect(dispatchStartedAt).toHaveLength(1);
    const dispatchesBeforeQuiescence = dispatchStartedAt.length;
    expect(await queue.listClaims()).toHaveLength(1);
    const deadLettersBeforeRelease = (await queue.listFailed?.()) ?? [];
    expect(deadLettersBeforeRelease).toEqual([]);
    const heldClaims = await queue.listClaims();
    expect(heldClaims).toHaveLength(1);

    releaseFirstDispatch();
    await expect.poll(() => dispatchStartedAt.length, { timeout: 3_000, interval: 20 }).toBe(2);
    await monitor.waitForIdle();
    const terminalRecord = await queue.enqueue("runtime-stall-message", {
      version: 1,
      rawEvent: "duplicate",
    });
    expect(terminalRecord).toMatchObject({ kind: "completed" });
    const deadLettersAfterRetry = (await queue.listFailed?.()) ?? [];
    expect(deadLettersAfterRetry).toEqual([]);

    const verdict = {
      verdict: "PASS",
      boundary: "real channel ingress monitor + transport admission + SQLite queue",
      timers: "wall-clock",
      transportAdmission: admission.kind,
      abortObserved,
      claimHeldPastFence: heldClaims.length === 1,
      concurrentRedispatchPrevented: dispatchesBeforeQuiescence === 1,
      delayedQuiescenceObserved: logs.some((line) => line.includes("eventually quiesced")),
      retryDispatches: dispatchStartedAt.length,
      terminalState: terminalRecord.kind,
      deadLetters: deadLettersAfterRetry.length,
    };
    console.log(`INGRESS_STALL_RUNTIME_VERDICT ${JSON.stringify(verdict)}`);

    await monitor.stop();
  }, 20_000);

  // The pre-existing short-lease coverage in ingress-drain-stall.test.ts runs on
  // fake timers. This drives the same claim-heartbeat contract on a wall clock,
  // through the drain seam that actually accepts a claimLeaseMs override.
  it("refreshes a guillotined held claim past a short lease on a real clock", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-real-held-lease", { text: "user message" }, { laneKey: "l1" });

      let releaseDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const claimLeaseMs = 300;
      const drain = createChannelIngressDrain<IngressDrainTestPayload>({
        queue,
        claimLeaseMs,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: async () => {
          await dispatchGate;
        },
      });

      await drain.drainOnce();

      // Outlive several real lease windows while the dispatch is still held.
      await expect
        .poll(
          async () =>
            await queue.recoverStaleClaims({
              staleMs: claimLeaseMs,
              now: Date.now(),
              shouldRecover: () => true,
            }),
          { timeout: 4_000, interval: 100 },
        )
        .toBe(0);
      expect(await queue.listClaims()).toHaveLength(1);

      releaseDispatch();
      await drain.waitForIdle();
      drain.dispose();
    });
  }, 20_000);
});
