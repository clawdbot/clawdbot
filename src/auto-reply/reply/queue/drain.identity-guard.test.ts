// Regression: drain IIFE finally (drain.ts:263-271) previously performed an
// unconditional `FOLLOWUP_QUEUES.delete(key)` + `clearFollowupDrainCallback(key)`
// based on the queue key alone, without checking whether its captured `queue`
// reference still matched the map entry. Under the `/stop` + immediate followup
// sequence, a late-returning D1 finally would delete the map entry belonging to
// a fresh Q2 and orphan it.
//
// production trigger:
//   T0 enqueueFollowupRun(msg1) + scheduleFollowupDrain → Q1 + D1 start
//   T1 clearSessionQueues([key])                         (e.g. /stop command)
//   T2 enqueueFollowupRun(msg2)                          → Q2 map.set
//   T3 D1 awaited branch returns → finally
//      L265 items=0 && dropped=0 → L266 FOLLOWUP_QUEUES.delete(key)
//      ← current map entry (Q2) is removed → Q2 orphaned.
//
// Deterministic design:
//   T2 uses `restartIfIdle=false` so D2 is NOT kicked. Q2 stays registered and
//   no second drain runs, so D1's finally is the only mutator that can touch
//   the map. D1 is parked on a Deferred gate inside runFollowup until T3.
//
//     pre-fix : D1 finally deletes the map entry → get(key)===undefined,
//               getFollowupQueueDepth === 0.
//     post-fix: identity guard sees get(key) !== Q1, skips delete →
//               get(key)===Q2, getFollowupQueueDepth === 1.
//
// CAL-003 / R-7: no module mocks. Real clearSessionQueues, enqueueFollowupRun,
// scheduleFollowupDrain, and FOLLOWUP_QUEUES are imported. The Deferred gate
// mirrors the pattern in queue.drain-restart.test.ts:207-234.

import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "../queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "../queue.test-helpers.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

installQueueRuntimeErrorSilencer();

describe("drain finally identity guard — late D1 must not orphan Q2", () => {
  const keysToCleanup: string[] = [];

  afterEach(() => {
    if (keysToCleanup.length > 0) {
      clearSessionQueues(keysToCleanup.splice(0));
    }
  });

  it("preserves Q2 map entry after /stop when D1 finally runs late", async () => {
    const key = `test-drain-identity-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const calls: FollowupRun[] = [];

    const gate = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      if (calls.length === 0) {
        firstEntered.resolve();
        await gate.promise;
      }
      calls.push(run);
    };

    enqueueFollowupRun(key, createRun({ prompt: "msg1" }), settings, "message-id", runFollowup);
    scheduleFollowupDrain(key, runFollowup);
    await firstEntered.promise;

    const q1 = FOLLOWUP_QUEUES.get(key);
    if (!q1) {
      throw new Error("Q1 should be registered pre-/stop");
    }
    expect(q1.draining).toBe(true);

    clearSessionQueues([key]);
    expect(FOLLOWUP_QUEUES.has(key)).toBe(false);

    enqueueFollowupRun(
      key,
      createRun({ prompt: "msg2" }),
      settings,
      "message-id",
      runFollowup,
      false,
    );

    const q2 = FOLLOWUP_QUEUES.get(key);
    if (!q2) {
      throw new Error("Q2 must be registered in map after T2 enqueue");
    }
    expect(q2).not.toBe(q1);
    expect(q2.items.length).toBe(1);
    expect(q2.draining).toBe(false);
    expect(getFollowupQueueDepth(key)).toBe(1);

    gate.resolve();

    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(
      FOLLOWUP_QUEUES.get(key),
      "current map entry must still be Q2 after late D1 finally",
    ).toBe(q2);
    expect(getFollowupQueueDepth(key)).toBe(1);
    expect(q2?.items[0]?.prompt).toBe("msg2");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("msg1");
  });
});
