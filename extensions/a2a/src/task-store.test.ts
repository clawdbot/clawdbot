import { afterEach, describe, expect, it, vi } from "vitest";
import { A2aTaskStore } from "./task-store.js";

describe("A2A task store", () => {
  const stores: A2aTaskStore[] = [];

  function createTaskStore(): A2aTaskStore {
    const store = new A2aTaskStore();
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.stop();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns protocol-shaped submitted, working, and completed task snapshots", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");

    expect(task).toMatchObject({
      contextId: "ctx-alice",
      status: { state: "TASK_STATE_SUBMITTED" },
      artifacts: [],
      history: [],
    });
    expect(task.status.timestamp).toMatch(/\.\d{3}Z$/);
    expect(store.start(task.id)?.status.state).toBe("TASK_STATE_WORKING");

    const waiting = store.wait(task.id, 10_000);
    store.completeTask(task.id, "hello back");

    await expect(waiting).resolves.toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "hello back" }] }],
    });
  });

  it("correlates concurrent replies to their originating task without cross-talk", () => {
    const store = createTaskStore();
    const aliceFirst = store.create("ctx-alice");
    const bobOnly = store.create("ctx-bob");
    const aliceSecond = store.create("ctx-alice");
    for (const task of [aliceFirst, bobOnly, aliceSecond]) {
      store.start(task.id);
    }

    expect(store.completeTask(aliceSecond.id, "second")?.id).toBe(aliceSecond.id);
    expect(store.completeTask(bobOnly.id, "bob")?.id).toBe(bobOnly.id);
    expect(store.completeTask(aliceFirst.id, "first")?.id).toBe(aliceFirst.id);
    expect(aliceFirst.artifacts[0]?.parts).toEqual([{ text: "first" }]);
    expect(aliceSecond.artifacts[0]?.parts).toEqual([{ text: "second" }]);
  });

  it("isolates same-context tasks and task access between authenticated peers", () => {
    const store = createTaskStore();
    const alice = store.create("ctx-shared", "alice");
    const bob = store.create("ctx-shared", "bob");

    expect(store.get(alice.id, "bob")).toBeUndefined();
    expect(store.get(bob.id, "alice")).toBeUndefined();
    expect(store.completeTask(bob.id, "bob only")?.id).toBe(bob.id);
    expect(alice.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(store.completeTask(alice.id, "alice only")?.id).toBe(alice.id);
    expect(alice.artifacts[0]?.parts).toEqual([{ text: "alice only" }]);
  });

  it("completes empty replies without inventing an artifact", () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");

    expect(store.completeTask(task.id, undefined)).toMatchObject({
      status: {
        state: "TASK_STATE_COMPLETED",
        message: { role: "ROLE_AGENT", parts: [{ text: "Agent completed without reply text" }] },
      },
      artifacts: [],
    });
  });

  it("records bounded failures and policy rejections without consuming sibling replies", () => {
    const store = createTaskStore();
    const failed = store.create("ctx-alice");
    const rejected = store.create("ctx-alice");
    const active = store.create("ctx-alice");

    expect(store.fail(failed.id, new Error("x".repeat(1000)))).toMatchObject({
      status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "x".repeat(512) }] } },
    });
    expect(store.reject(rejected.id, "peer blocked")).toMatchObject({
      status: { state: "TASK_STATE_REJECTED", message: { parts: [{ text: "peer blocked" }] } },
    });
    expect(store.completeTask(failed.id, "late reply")).toBeUndefined();
    expect(store.completeTask(rejected.id, "late reply")).toBeUndefined();
    expect(store.completeTask(active.id, "active reply")?.id).toBe(active.id);
  });

  it("returns working tasks after timeout and accepts the eventual final reply", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");
    store.start(task.id);

    await expect(store.wait(task.id, 0)).resolves.toMatchObject({
      status: { state: "TASK_STATE_WORKING" },
    });
    expect(store.completeTask(task.id, "late reply")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "late reply" }] }],
    });
  });

  it("resolves outstanding HTTP waits with their working snapshot on shutdown", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");
    store.start(task.id);
    const waiting = store.wait(task.id, 120_000);

    store.stop();

    await expect(waiting).resolves.toMatchObject({ status: { state: "TASK_STATE_WORKING" } });
    expect(store.get(task.id)).toBeUndefined();
  });

  it("evicts the oldest completed tasks after the 500-entry retention cap", () => {
    const store = createTaskStore();
    const completedIds: string[] = [];
    for (let index = 0; index <= 500; index += 1) {
      const contextId = `ctx-${index}`;
      const task = store.create(contextId);
      completedIds.push(task.id);
      store.completeTask(task.id, "done");
    }

    expect(store.get(completedIds[0]!)).toBeUndefined();
    expect(store.get(completedIds[1]!)).toBeDefined();
    expect(store.get(completedIds[500]!)).toBeDefined();
  });

  it("expires completed tasks after 24 hours without evicting active tasks", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const completed = store.create("ctx-completed");
    store.completeTask(completed.id, "done");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);
    const active = store.create("ctx-active");

    expect(store.get(completed.id)).toBeUndefined();
    expect(store.get(active.id)).toBe(active);
  });

  it("fails tasks whose turn never settles instead of growing without bound", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const stuck = store.create("ctx-stuck");
    store.start(stuck.id);

    clock.mockReturnValue(currentTime + 61 * 60 * 1000);
    const fresh = store.create("ctx-fresh");

    const stuckStatus = store.get(stuck.id)?.status;
    expect(stuckStatus?.state).toBe("TASK_STATE_FAILED");
    if (stuckStatus?.state === "TASK_STATE_FAILED") {
      expect(stuckStatus.message?.parts[0]).toMatchObject({
        text: expect.stringContaining("expired"),
      });
    }
    expect(store.get(fresh.id)).toMatchObject({
      status: { state: "TASK_STATE_SUBMITTED" },
    });
    // The swept task is terminal, so its late reply is dropped instead of
    // touching any other task.
    expect(store.completeTask(stuck.id, "late reply")).toBeUndefined();
    expect(store.completeTask(fresh.id, "reply")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
    });
  });

  it("drops a swept task's late reply without completing the newer same-context task", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const delayed = store.create("ctx-same", "peer-a");
    store.start(delayed.id);

    // Creating the follow-up task after the deadline sweeps the expired one.
    clock.mockReturnValue(currentTime + 61 * 60 * 1000);
    const newer = store.create("ctx-same", "peer-a");

    const delayedStatus = store.get(delayed.id, "peer-a")?.status;
    expect(delayedStatus?.state).toBe("TASK_STATE_FAILED");
    if (delayedStatus?.state === "TASK_STATE_FAILED") {
      expect(delayedStatus.message?.parts[0]).toMatchObject({
        text: expect.stringContaining("expired"),
      });
    }

    // The delayed turn's final reply arrives after the sweep: it must neither
    // resurrect the swept task nor complete the newer same-context task.
    expect(store.completeTask(delayed.id, "old reply")).toBeUndefined();
    expect(store.get(delayed.id, "peer-a")).toMatchObject({
      status: { state: "TASK_STATE_FAILED" },
      artifacts: [],
    });
    expect(store.get(newer.id, "peer-a")?.status.state).toBe("TASK_STATE_SUBMITTED");

    expect(store.completeTask(newer.id, "new reply")).toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "new reply" }] }],
    });
  });

  it("drops a final delivery that is the first operation after the stale deadline", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const stuck = store.create("ctx-stuck");
    store.start(stuck.id);

    clock.mockReturnValue(currentTime + 61 * 60 * 1000);
    // No create/get crosses the deadline: the delivery itself must enforce it.
    expect(store.completeTask(stuck.id, "late reply")).toBeUndefined();
    expect(stuck.status.state).toBe("TASK_STATE_FAILED");
    expect(stuck.artifacts).toEqual([]);
  });

  it("fails idle tasks on their own expiry timers without any store access", () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    const stuck = store.create("ctx-stuck");

    vi.advanceTimersByTime(30 * 60 * 1000);
    store.start(stuck.id);
    // 75 minutes since create but only 45 since the last status change.
    vi.advanceTimersByTime(45 * 60 * 1000);
    expect(stuck.status.state).toBe("TASK_STATE_WORKING");

    // 61 minutes since the last status change: the timer fails the task on its
    // own, mutating this record without any store call.
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(stuck.status.state).toBe("TASK_STATE_FAILED");
    if (stuck.status.state === "TASK_STATE_FAILED") {
      expect(stuck.status.message?.parts[0]).toMatchObject({
        text: expect.stringContaining("expired"),
      });
    }
  });

  it("disarms task expiry timers on stop", () => {
    vi.useFakeTimers();
    const store = createTaskStore();
    store.create("ctx-a");
    store.create("ctx-b");
    expect(vi.getTimerCount()).toBe(2);

    store.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("ages out failed stale tasks under terminal retention", () => {
    const store = createTaskStore();
    const currentTime = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(currentTime);
    const stuck = store.create("ctx-stuck");

    clock.mockReturnValue(currentTime + 61 * 60 * 1000);
    expect(store.get(stuck.id)?.status.state).toBe("TASK_STATE_FAILED");

    clock.mockReturnValue(currentTime + 61 * 60 * 1000 + 24 * 60 * 60 * 1000);
    expect(store.get(stuck.id)).toBeUndefined();
  });
});
