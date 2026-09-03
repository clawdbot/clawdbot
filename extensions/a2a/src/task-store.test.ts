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
    store.completeNext("ctx-alice", "hello back");

    await expect(waiting).resolves.toMatchObject({
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [{ parts: [{ text: "hello back" }] }],
    });
  });

  it("correlates concurrent replies by conversation FIFO without cross-talk", () => {
    const store = createTaskStore();
    const aliceFirst = store.create("ctx-alice");
    const bobOnly = store.create("ctx-bob");
    const aliceSecond = store.create("ctx-alice");
    for (const task of [aliceFirst, bobOnly, aliceSecond]) {
      store.start(task.id);
    }

    expect(store.completeNext("ctx-alice", "first")?.id).toBe(aliceFirst.id);
    expect(store.completeNext("ctx-bob", "bob")?.id).toBe(bobOnly.id);
    expect(store.completeNext("ctx-alice", "second")?.id).toBe(aliceSecond.id);
    expect(aliceFirst.artifacts[0]?.parts).toEqual([{ text: "first" }]);
    expect(aliceSecond.artifacts[0]?.parts).toEqual([{ text: "second" }]);
  });

  it("isolates same-context tasks and task access between authenticated peers", () => {
    const store = createTaskStore();
    const alice = store.create("ctx-shared", "alice");
    const bob = store.create("ctx-shared", "bob");

    expect(store.get(alice.id, "bob")).toBeUndefined();
    expect(store.get(bob.id, "alice")).toBeUndefined();
    expect(store.completeNext("ctx-shared", "bob only", "bob")?.id).toBe(bob.id);
    expect(alice.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(store.completeNext("ctx-shared", "alice only", "alice")?.id).toBe(alice.id);
    expect(alice.artifacts[0]?.parts).toEqual([{ text: "alice only" }]);
  });

  it("completes empty replies without inventing an artifact", () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");

    expect(store.completeNext(task.contextId, undefined)).toMatchObject({
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
    expect(store.completeNext("ctx-alice", "active reply")?.id).toBe(active.id);
  });

  it("does not split surrogate pairs when bounding status messages", () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");

    expect(store.fail(task.id, new Error(`${"x".repeat(511)}😀tail`))).toMatchObject({
      status: { message: { parts: [{ text: "x".repeat(511) }] } },
    });
  });

  it("returns working tasks after timeout and accepts the eventual final reply", async () => {
    const store = createTaskStore();
    const task = store.create("ctx-alice");
    store.start(task.id);

    await expect(store.wait(task.id, 0)).resolves.toMatchObject({
      status: { state: "TASK_STATE_WORKING" },
    });
    expect(store.completeNext("ctx-alice", "late reply")).toMatchObject({
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
      store.completeNext(contextId, "done");
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
    store.completeNext(completed.contextId, "done");
    const active = store.create("ctx-active");

    clock.mockReturnValue(currentTime + 24 * 60 * 60 * 1000);

    expect(store.get(completed.id)).toBeUndefined();
    expect(store.get(active.id)).toBe(active);
  });
});
