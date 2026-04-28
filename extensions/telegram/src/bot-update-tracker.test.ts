import { describe, expect, it, vi } from "vitest";
import {
  createTelegramUpdateTracker,
  type TelegramUpdateTrackerState,
} from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";

const updateCtx = (updateId: number): TelegramUpdateKeyContext => ({
  update: { update_id: updateId },
});

async function flushTrackerMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createTelegramUpdateTracker", () => {
  it("persists accepted offsets before earlier pending updates complete", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    const update101 = tracker.beginUpdate(updateCtx(101));
    if (!update101.accepted) {
      throw new Error("expected update 101 to be accepted");
    }
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).toHaveBeenCalledWith(101);

    const update102 = tracker.beginUpdate(updateCtx(102));
    if (!update102.accepted) {
      throw new Error("expected update 102 to be accepted");
    }
    tracker.finishUpdate(update102.update, { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId.mock.calls.map((call) => Number(call[0]))).toEqual([101, 102]);
    expect(tracker.getState()).toMatchObject({
      highestAcceptedUpdateId: 102,
      highestPersistedAcceptedUpdateId: 102,
      highestCompletedUpdateId: 102,
      safeCompletedUpdateId: 100,
      pendingUpdateIds: [101],
      failedUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);

    tracker.finishUpdate(update101.update, { completed: true });
    expect(tracker.getState()).toMatchObject({
      highestCompletedUpdateId: 102,
      safeCompletedUpdateId: 102,
      pendingUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("skips restart replays once the accepted offset is restored", async () => {
    const onAcceptedUpdateId = vi.fn();
    const firstProcess = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    const accepted = firstProcess.beginUpdate(updateCtx(101));
    expect(accepted.accepted).toBe(true);
    await flushTrackerMicrotasks();

    const restartedProcess = createTelegramUpdateTracker({
      initialUpdateId: Number(onAcceptedUpdateId.mock.calls.at(-1)?.[0]),
    });

    expect(restartedProcess.beginUpdate(updateCtx(101))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
  });

  it("serializes and coalesces accepted offset persistence", async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const writes: number[] = [];
    const onAcceptedUpdateId = vi.fn((updateId: number) => {
      writes.push(updateId);
      if (updateId === 101) {
        return firstWrite.promise;
      }
      return secondWrite.promise;
    });
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    const update101 = tracker.beginUpdate(updateCtx(101));
    const update102 = tracker.beginUpdate(updateCtx(102));
    const update103 = tracker.beginUpdate(updateCtx(103));
    expect(update101.accepted).toBe(true);
    expect(update102.accepted).toBe(true);
    expect(update103.accepted).toBe(true);

    await flushTrackerMicrotasks();
    expect(writes).toEqual([101]);
    expect(tracker.getState()).toMatchObject({
      highestAcceptedUpdateId: 103,
      highestPersistedAcceptedUpdateId: 100,
    } satisfies Partial<TelegramUpdateTrackerState>);

    firstWrite.resolve();
    await flushTrackerMicrotasks();
    expect(writes).toEqual([101, 103]);
    expect(onAcceptedUpdateId).not.toHaveBeenCalledWith(102);

    secondWrite.resolve();
    await flushTrackerMicrotasks();
    expect(tracker.getState()).toMatchObject({
      highestPersistedAcceptedUpdateId: 103,
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("keeps failed accepted updates retryable in the same process", () => {
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 200 });
    const first = tracker.beginUpdate(updateCtx(201));
    if (!first.accepted) {
      throw new Error("expected first update to be accepted");
    }
    tracker.finishUpdate(first.update, { completed: false });

    expect(tracker.getState()).toMatchObject({
      highestAcceptedUpdateId: 201,
      highestCompletedUpdateId: 200,
      safeCompletedUpdateId: 200,
      failedUpdateIds: [201],
    } satisfies Partial<TelegramUpdateTrackerState>);

    const retry = tracker.beginUpdate(updateCtx(201));
    if (!retry.accepted) {
      throw new Error("expected failed update retry to be accepted");
    }
    tracker.finishUpdate(retry.update, { completed: true });

    expect(tracker.getState()).toMatchObject({
      highestAcceptedUpdateId: 201,
      highestCompletedUpdateId: 201,
      safeCompletedUpdateId: 201,
      failedUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);
    expect(tracker.beginUpdate(updateCtx(201))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
  });

  it("dedupes handler dispatch separately from the accepted watermark", () => {
    const onSkip = vi.fn();
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 300, onSkip });
    const accepted = tracker.beginUpdate(updateCtx(301));
    if (!accepted.accepted) {
      throw new Error("expected update to be accepted");
    }

    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
    expect(onSkip).toHaveBeenCalledWith("update:301");

    tracker.finishUpdate(accepted.update, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
  });
});
