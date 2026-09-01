// A parked announce is only safe if it is impossible to lose. The requester's
// lane release is the primary wake — that is the whole point, since the blind
// retry clock is what a busy requester outlives — but the row must still settle
// when that edge never arrives, and the park must stay distinguishable from a
// transport attempt that actually failed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { CommandLane } from "../../../process/lanes.js";
import { resolveSessionLane } from "../../embedded-agent-runner/lanes.js";
import {
  hasParkedAnnounceOutlivedExpiry,
  parkAnnounceForRequesterLane,
  PARKED_FOR_REQUESTER_LANE_ERROR,
  REQUESTER_LANE_BUSY_BACKSTOP_MS,
} from "./subagent-registry-lane-park.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { markPendingFinalDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const REQUESTER = "agent:tank:direct:eddie";
const REQUESTER_LANE = resolveSessionLane(REQUESTER);
const RUN_ID = "run-child";

function makeParkedRun(overrides?: Partial<SubagentRunRecord>): SubagentRunRecord {
  return {
    runId: RUN_ID,
    childSessionKey: "agent:tank:subagent:child",
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "eddie",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: Date.now() },
    expectsCompletionMessage: true,
    cleanupHandled: true,
    delivery: { status: "pending" },
    ...overrides,
  };
}

function createParkContext(entry: SubagentRunRecord) {
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const waiters = new Map<string, () => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Captured at call time, not read afterwards: the invariant is that the row
  // is already ungated when the resumer receives it, and a later read cannot
  // tell an in-order clear from a clear that happened too late.
  const deadlineAtResume: Array<number | undefined> = [];
  const persistedBeforeResume: string[] = [];
  const persist = vi.fn((runId: string) => void persistedBeforeResume.push(runId));
  const resumeSubagentRun = vi.fn(() => {
    deadlineAtResume.push(entry.delivery?.nextAttemptAt);
  });
  const context = {
    options: {
      runs,
      resumedRuns: new Set<string>(),
      persist,
      resumeSubagentRun,
    },
    addScheduledResumeTimer: (timer: ReturnType<typeof setTimeout>) => void timers.add(timer),
    deleteScheduledResumeTimer: (timer: ReturnType<typeof setTimeout>) => void timers.delete(timer),
    setRequesterLaneReleaseWaiter: (runId: string, unsubscribe: () => void) => {
      waiters.get(runId)?.();
      waiters.set(runId, unsubscribe);
    },
    takeRequesterLaneReleaseWaiter: (runId: string) => {
      const unsubscribe = waiters.get(runId);
      waiters.delete(runId);
      return unsubscribe;
    },
  } as unknown as SubagentLifecycleAnnounceCleanupContext;
  return {
    context,
    resumeSubagentRun,
    persist,
    waiters,
    timers,
    deadlineAtResume,
    persistedBeforeResume,
  };
}

function holdRequesterLane() {
  const holding = createDeferred();
  const turn = enqueueCommandInLane(REQUESTER_LANE, async () => {
    await holding.promise;
  });
  return {
    async release() {
      holding.resolve(undefined);
      await turn;
    },
  };
}

describe("parkAnnounceForRequesterLane", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  it("re-drives the row as soon as the requester's turn releases the lane", async () => {
    const entry = makeParkedRun();
    const { context, resumeSubagentRun, waiters } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });

    // Parked, not attempted, and waiting on the turn boundary rather than a clock.
    expect(resumeSubagentRun).not.toHaveBeenCalled();
    expect(waiters.has(RUN_ID)).toBe(true);
    expect(entry.delivery?.status).toBe("pending");
    expect(entry.cleanupHandled).toBe(false);

    await requesterTurn.release();

    // Promptly: no timer was advanced, so this is the lane edge and not the backstop.
    expect(resumeSubagentRun).toHaveBeenCalledWith(RUN_ID);
    expect(waiters.has(RUN_ID)).toBe(false);
  });

  it("re-drives immediately when the lane frees between the busy read and the subscription", () => {
    const entry = makeParkedRun();
    const { context, resumeSubagentRun } = createParkContext(entry);

    // The caller decided to park on a busy read; by the time the park runs the
    // lane is already free. Losing that release would strand the row until the
    // backstop, so the park re-reads once its listener is armed.
    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });

    expect(resumeSubagentRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("still re-drives the row from the timer backstop when the lane release never fires", async () => {
    vi.useFakeTimers();
    const entry = makeParkedRun();
    const { context, resumeSubagentRun } = createParkContext(entry);
    const holding = createDeferred();
    const requesterTurn = enqueueCommandInLane(REQUESTER_LANE, async () => {
      await holding.promise;
    });

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });
    expect(resumeSubagentRun).not.toHaveBeenCalled();
    expect(entry.delivery?.nextAttemptAt).toBeGreaterThan(Date.now());

    // The requester never finishes. The row must not be silently lost.
    await vi.advanceTimersByTimeAsync(REQUESTER_LANE_BUSY_BACKSTOP_MS + 1);

    expect(resumeSubagentRun).toHaveBeenCalledWith(RUN_ID);
    // The delivery obligation itself survives: payload retained, still pending.
    expect(entry.delivery?.status).toBe("pending");
    expect(entry.delivery?.payload).toBeDefined();

    holding.resolve(undefined);
    await requesterTurn;
  });

  it("does not consume a retry rung, unlike a real transport attempt", () => {
    const parked = makeParkedRun();
    const attempted = makeParkedRun();
    const { context } = createParkContext(parked);
    const requesterTurn = holdRequesterLane();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry: parked, now: Date.now() });
    markPendingFinalDelivery({ entry: attempted, error: "gateway request timeout for agent" });

    // This is the discriminator the retry ladder reads. A park that counted as
    // an attempt would let the ladder expire a requester that is merely busy.
    expect(parked.delivery?.attemptCount).toBeUndefined();
    expect(attempted.delivery?.attemptCount).toBe(1);

    void requesterTurn.release();
  });

  it("labels the park distinguishably from a failed attempt and from an overran run", () => {
    const entry = makeParkedRun();
    const { context } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });

    // Not "retryable" (an attempt happened and did not land) and not a gateway
    // timeout string (an admitted announce turn that overran its own budget).
    expect(entry.delivery?.lastError).toBe(PARKED_FOR_REQUESTER_LANE_ERROR);
    expect(entry.delivery?.lastError).not.toMatch(/gateway request timeout/);
    expect(entry.delivery?.lastDropReason).toBeUndefined();

    void requesterTurn.release();
  });

  it("arms a deadline so a park is bounded even while it keeps re-parking", () => {
    const entry = makeParkedRun();
    const { context } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();
    const now = Date.now();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now });

    expect(entry.delivery?.windowStartedAt).toBe(entry.execution.endedAt);
    expect(entry.delivery?.deadlineAt).toBeGreaterThan(now);

    void requesterTurn.release();
  });

  it("replaces a prior waiter instead of stacking one per re-park", async () => {
    const entry = makeParkedRun();
    const { context, resumeSubagentRun } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });
    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });

    await requesterTurn.release();

    expect(resumeSubagentRun).toHaveBeenCalledTimes(1);
  });

  it("hands the resumer an ungated row, because the real resumer honours nextAttemptAt", async () => {
    // The park writes a 60s backstop deadline. `resumeSubagentRun` treats that
    // value as a hard not-before gate for required completions, so a release
    // wake that leaves it set only re-schedules the remaining delay — the exact
    // wait the park exists to remove. This pins the clear, and pins that it
    // happens BEFORE the resumer sees the row.
    const entry = makeParkedRun();
    const { context, resumeSubagentRun, deadlineAtResume } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();
    const now = Date.now();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now });
    expect(entry.delivery?.nextAttemptAt).toBe(now + REQUESTER_LANE_BUSY_BACKSTOP_MS);

    await requesterTurn.release();

    expect(resumeSubagentRun).toHaveBeenCalledWith(RUN_ID);
    expect(deadlineAtResume).toEqual([undefined]);
    expect(entry.delivery?.nextAttemptAt).toBeUndefined();
  });

  it("persists the retired deadline, so a restart mid-release cannot re-gate the row", async () => {
    // The clear has to survive the process. A restore that reads a row still
    // carrying the deadline would wait it out even though the lane is free.
    const entry = makeParkedRun();
    const { context, persist, persistedBeforeResume } = createParkContext(entry);
    const requesterTurn = holdRequesterLane();

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });
    const persistsAtPark = persist.mock.calls.length;

    await requesterTurn.release();

    expect(persist.mock.calls.length).toBeGreaterThan(persistsAtPark);
    expect(persistedBeforeResume).toContain(RUN_ID);
  });

  it("still lets the timer backstop re-drive a row whose deadline is intact", async () => {
    // The edge retires the deadline; the timer path must not be collateral.
    // A park whose listener never fires keeps its deadline and its wake.
    vi.useFakeTimers();
    const entry = makeParkedRun();
    const { context, resumeSubagentRun } = createParkContext(entry);
    const holding = createDeferred();
    const requesterTurn = enqueueCommandInLane(REQUESTER_LANE, async () => {
      await holding.promise;
    });

    parkAnnounceForRequesterLane(context, { runId: RUN_ID, entry, now: Date.now() });
    expect(entry.delivery?.nextAttemptAt).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(REQUESTER_LANE_BUSY_BACKSTOP_MS + 1);

    expect(resumeSubagentRun).toHaveBeenCalledWith(RUN_ID);
    // Untouched by the timer path: only the lane-release edge retires it.
    expect(entry.delivery?.nextAttemptAt).toBeGreaterThan(0);

    holding.resolve(undefined);
    await requesterTurn;
  });

  it("reports a park that outlived the announce window", () => {
    const now = Date.now();
    const completion = makeParkedRun({ execution: { status: "terminal", endedAt: now } });
    expect(hasParkedAnnounceOutlivedExpiry(completion, now + 60_000)).toBe(false);
    expect(hasParkedAnnounceOutlivedExpiry(completion, now + 31 * 60_000)).toBe(true);

    const nonCompletion = makeParkedRun({
      expectsCompletionMessage: false,
      execution: { status: "terminal", endedAt: now },
    });
    expect(hasParkedAnnounceOutlivedExpiry(nonCompletion, now + 6 * 60_000)).toBe(true);
  });
});
