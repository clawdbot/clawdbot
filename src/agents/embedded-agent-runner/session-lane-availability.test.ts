// Coverage for the session-lane availability read and its release edge. These
// are the two primitives behind deferring a subagent announce instead of
// dispatching it into a requester that is holding its own turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  isCommandLaneAdmissible,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveSessionLane } from "./lanes.js";
import {
  isSessionLaneBusy,
  readSessionLaneAvailability,
  subscribeSessionLaneRelease,
} from "./session-lane-availability.js";

vi.mock("../../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const REQUESTER = "agent:tank:canary-b1";

describe("session lane availability", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("resolves the same lane name the gateway serializes a session turn on", () => {
    expect(readSessionLaneAvailability(REQUESTER).lane).toBe(`session:${REQUESTER}`);
    expect(resolveSessionLane(REQUESTER)).toBe(`session:${REQUESTER}`);
  });

  it("reads an untouched session lane as free", () => {
    expect(isSessionLaneBusy(REQUESTER)).toBe(false);
    expect(readSessionLaneAvailability(REQUESTER)).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
      busy: false,
    });
  });

  it("reads a session holding its own turn as busy, and free again once it ends", async () => {
    const holding = createDeferred();
    const held = enqueueCommandInLane(resolveSessionLane(REQUESTER), async () => {
      await holding.promise;
      return "turn-done";
    });

    expect(isSessionLaneBusy(REQUESTER)).toBe(true);
    expect(readSessionLaneAvailability(REQUESTER)).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
      busy: true,
      blockedBy: "lane",
    });

    holding.resolve(undefined);
    await expect(held).resolves.toBe("turn-done");
    expect(isSessionLaneBusy(REQUESTER)).toBe(false);
  });

  it("notifies a release waiter when the requester's turn ends", async () => {
    const holding = createDeferred();
    const released = createDeferred();
    const busyAtNotify: boolean[] = [];
    const held = enqueueCommandInLane(resolveSessionLane(REQUESTER), async () => {
      await holding.promise;
    });
    const unsubscribe = subscribeSessionLaneRelease(REQUESTER, () => {
      busyAtNotify.push(isSessionLaneBusy(REQUESTER));
      released.resolve(undefined);
    });

    expect(busyAtNotify).toEqual([]);
    holding.resolve(undefined);
    await held;
    await released.promise;
    unsubscribe();

    // The waiter is only useful if the lane is genuinely takeable when it fires.
    expect(busyAtNotify).toEqual([false]);
  });

  it("does not notify while a queued turn takes the freed slot", async () => {
    const firstHolding = createDeferred();
    const secondHolding = createDeferred();
    const notifications: number[] = [];
    const lane = resolveSessionLane(REQUESTER);
    const first = enqueueCommandInLane(lane, async () => {
      await firstHolding.promise;
    });
    const second = enqueueCommandInLane(lane, async () => {
      await secondHolding.promise;
    });
    const unsubscribe = subscribeSessionLaneRelease(REQUESTER, () => {
      notifications.push(notifications.length);
    });

    firstHolding.resolve(undefined);
    await first;
    // The lane handed its slot straight to the queued turn: still not takeable.
    expect(notifications).toEqual([]);
    expect(isSessionLaneBusy(REQUESTER)).toBe(true);

    secondHolding.resolve(undefined);
    await second;
    expect(notifications).toEqual([0]);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", async () => {
    const notifications: string[] = [];
    const unsubscribe = subscribeSessionLaneRelease(REQUESTER, () => {
      notifications.push("fired");
    });
    unsubscribe();
    // A second call must be a no-op rather than removing someone else's waiter.
    unsubscribe();

    await enqueueCommandInLane(resolveSessionLane(REQUESTER), async () => "done");
    expect(notifications).toEqual([]);
  });

  it("reports a suspended lane as busy", () => {
    setCommandLaneConcurrency(resolveSessionLane(REQUESTER), 0);
    expect(isSessionLaneBusy(REQUESTER)).toBe(true);
    expect(isCommandLaneAdmissible(resolveSessionLane(REQUESTER))).toBe(false);
  });
});
