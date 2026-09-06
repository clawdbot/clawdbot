import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoalContinuationDriver,
  type GoalDriverConfig,
  type GoalDriverGoalSnapshot,
  type GoalDriverTarget,
} from "./driver.js";

const target: GoalDriverTarget = {
  agentId: "main",
  sessionKey: "agent:main:main",
  storePath: "/tmp/openclaw-main/sessions.json",
};

function activeGoal(
  overrides: Partial<GoalDriverGoalSnapshot> = {},
): GoalDriverGoalSnapshot {
  return {
    id: "goal-1",
    objective: "Land deterministic goal continuation",
    status: "active",
    continuationTurns: 0,
    ...overrides,
  };
}

function createHarness(overrides: {
  config?: Partial<GoalDriverConfig>;
  goal?: GoalDriverGoalSnapshot | undefined;
  activeRun?: boolean;
  queuedTurns?: boolean;
  systemEvents?: boolean;
} = {}) {
  let config: GoalDriverConfig = {
    enabled: true,
    idleDelayMs: 1_000,
    maxContinuationTurns: 3,
    ...overrides.config,
  };
  let goal = Object.hasOwn(overrides, "goal") ? overrides.goal : activeGoal();
  let activeRun = overrides.activeRun ?? false;
  let queuedTurns = overrides.queuedTurns ?? false;
  let systemEvents = overrides.systemEvents ?? false;

  const readGoal = vi.fn(() => goal);
  const recordContinuation = vi.fn(async () => {
    if (!goal || goal.status !== "active") {
      return undefined;
    }
    goal = { ...goal, continuationTurns: goal.continuationTurns + 1 };
    return goal;
  });
  const rollbackContinuation = vi.fn(async () => true);
  const pauseGoal = vi.fn(async () => undefined);
  const enqueueContinuation = vi.fn(() => true);
  const requestWake = vi.fn();

  const driver = createGoalContinuationDriver({
    getConfig: () => config,
    readGoal,
    hasActiveRun: () => activeRun,
    hasQueuedTurns: () => queuedTurns,
    hasSystemEvents: () => systemEvents,
    recordContinuation,
    rollbackContinuation,
    pauseGoal,
    enqueueContinuation,
    requestWake,
  });

  return {
    driver,
    readGoal,
    recordContinuation,
    rollbackContinuation,
    pauseGoal,
    enqueueContinuation,
    requestWake,
    setConfig: (next: Partial<GoalDriverConfig>) => {
      config = { ...config, ...next };
    },
    setActiveRun: (value: boolean) => {
      activeRun = value;
    },
    setQueuedTurns: (value: boolean) => {
      queuedTurns = value;
    },
    setSystemEvents: (value: boolean) => {
      systemEvents = value;
    },
  };
}

describe("goal continuation driver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a zero-effect no-op while the experiment is disabled", async () => {
    const harness = createHarness({ config: { enabled: false } });

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.driver.pendingCount()).toBe(0);
    expect(harness.readGoal).not.toHaveBeenCalled();
    expect(harness.recordContinuation).not.toHaveBeenCalled();
    expect(harness.requestWake).not.toHaveBeenCalled();
  });

  it("uses the exact configured delay and keeps one timer per durable target", async () => {
    const harness = createHarness();

    harness.driver.arm(target);
    harness.driver.arm({ ...target });
    expect(harness.driver.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.recordContinuation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.recordContinuation).toHaveBeenCalledOnce();
    expect(harness.requestWake).toHaveBeenCalledOnce();
    expect(harness.driver.pendingCount()).toBe(0);
  });

  it.each([
    ["an active run", { activeRun: true }],
    ["queued user work", { queuedTurns: true }],
    ["a queued system event", { systemEvents: true }],
  ])("lets %s win without polling or self-rearming", async (_label, state) => {
    const harness = createHarness(state);

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.recordContinuation).not.toHaveBeenCalled();
    expect(harness.requestWake).not.toHaveBeenCalled();
    expect(harness.driver.pendingCount()).toBe(0);
  });

  it.each(["paused", "blocked", "usage_limited", "budget_limited", "complete"] as const)(
    "disarms when the durable goal is %s",
    async (status) => {
      const harness = createHarness({ goal: activeGoal({ status }) });

      harness.driver.arm(target);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(harness.recordContinuation).not.toHaveBeenCalled();
      expect(harness.requestWake).not.toHaveBeenCalled();
      expect(harness.driver.pendingCount()).toBe(0);
    },
  );

  it("auto-pauses at the persisted continuation ceiling without enqueueing", async () => {
    const harness = createHarness({ goal: activeGoal({ continuationTurns: 3 }) });

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.pauseGoal).toHaveBeenCalledWith(
      target,
      expect.stringContaining("continuation"),
    );
    expect(harness.recordContinuation).not.toHaveBeenCalled();
    expect(harness.enqueueContinuation).not.toHaveBeenCalled();
    expect(harness.requestWake).not.toHaveBeenCalled();
  });

  it("does not enqueue or wake when the durable reservation fails", async () => {
    const harness = createHarness();
    harness.recordContinuation.mockRejectedValueOnce(new Error("store unavailable"));

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.enqueueContinuation).not.toHaveBeenCalled();
    expect(harness.requestWake).not.toHaveBeenCalled();
  });

  it("rolls back when user work wins the race after the durable reservation", async () => {
    const harness = createHarness();
    harness.recordContinuation.mockImplementationOnce(async () => {
      harness.setQueuedTurns(true);
      return activeGoal({ continuationTurns: 1 });
    });

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.rollbackContinuation).toHaveBeenCalledWith(target, {
      goalId: "goal-1",
      expectedContinuationTurns: 1,
    });
    expect(harness.enqueueContinuation).not.toHaveBeenCalled();
    expect(harness.requestWake).not.toHaveBeenCalled();
  });

  it("rolls back a rejected enqueue and wakes only after enqueue succeeds", async () => {
    const harness = createHarness();
    harness.enqueueContinuation.mockReturnValueOnce(false);

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.rollbackContinuation).toHaveBeenCalledWith(target, {
      goalId: "goal-1",
      expectedContinuationTurns: 1,
    });
    expect(harness.requestWake).not.toHaveBeenCalled();

    harness.driver.arm(target);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.requestWake).toHaveBeenCalledOnce();
    expect(harness.driver.pendingCount()).toBe(0);
  });

  it("disarms a pending timer when config is disabled and stop cancels all targets", async () => {
    const harness = createHarness();
    const otherTarget = {
      ...target,
      sessionKey: "agent:main:telegram:direct:123",
    };

    harness.driver.rearm([target, otherTarget]);
    expect(harness.driver.pendingCount()).toBe(2);
    harness.setConfig({ enabled: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.recordContinuation).not.toHaveBeenCalled();
    expect(harness.driver.pendingCount()).toBe(0);

    harness.setConfig({ enabled: true });
    harness.driver.rearm([target, otherTarget]);
    harness.driver.stop();
    expect(harness.driver.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.recordContinuation).not.toHaveBeenCalled();
  });
});
