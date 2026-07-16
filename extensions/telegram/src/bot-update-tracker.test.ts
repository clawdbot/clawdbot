// Telegram tests cover bot update tracker plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";

// Mirrors the tracker-internal retention bound; update together with bot-update-tracker.ts.
const ACCEPTED_UPDATE_ID_RETENTION = 10_000;

type TelegramUpdateTrackerState = ReturnType<
  ReturnType<typeof createTelegramUpdateTracker>["getState"]
>;

const updateCtx = (updateId: number): TelegramUpdateKeyContext => ({
  update: { update_id: updateId },
});

async function flushTrackerMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error("Expected tracker deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function expectTrackerState(
  state: TelegramUpdateTrackerState,
  expected: Partial<TelegramUpdateTrackerState>,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(state[key as keyof TelegramUpdateTrackerState]).toEqual(value);
  }
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
    expectTrackerState(tracker.getState(), {
      highestAcceptedUpdateId: 102,
      highestPersistedAcceptedUpdateId: 102,
      highestCompletedUpdateId: 102,
      safeCompletedUpdateId: 100,
      pendingUpdateIds: [101],
      failedUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);

    tracker.finishUpdate(update101.update, { completed: true });
    expectTrackerState(tracker.getState(), {
      highestCompletedUpdateId: 102,
      safeCompletedUpdateId: 102,
      pendingUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("can persist offsets only after successful agent dispatch", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      ackPolicy: "after_agent_dispatch",
      onAcceptedUpdateId,
    });

    const update101 = tracker.beginUpdate(updateCtx(101));
    if (!update101.accepted) {
      throw new Error("expected update 101 to be accepted");
    }
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    tracker.finishUpdate(update101.update, { completed: false });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();
    expectTrackerState(tracker.getState(), {
      failedUpdateIds: [101],
      highestPersistedAcceptedUpdateId: 100,
    } satisfies Partial<TelegramUpdateTrackerState>);

    const retry = tracker.beginUpdate(updateCtx(101));
    if (!retry.accepted) {
      throw new Error("expected update 101 retry to be accepted");
    }
    tracker.finishUpdate(retry.update, { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId).toHaveBeenCalledWith(101);
    expectTrackerState(tracker.getState(), {
      failedUpdateIds: [],
      highestPersistedAcceptedUpdateId: 101,
      safeCompletedUpdateId: 101,
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

  it("can keep a persistence floor while replaying older spooled updates", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 42,
      ackPolicy: "after_agent_dispatch",
      onAcceptedUpdateId,
    });

    const oldPending = tracker.beginUpdate(updateCtx(42));
    if (!oldPending.accepted) {
      throw new Error("expected old spooled update to be accepted");
    }
    tracker.finishUpdate(oldPending.update, { completed: false });

    const newer = tracker.beginUpdate(updateCtx(43));
    if (!newer.accepted) {
      throw new Error("expected newer update to be accepted");
    }
    tracker.finishUpdate(newer.update, { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId).toHaveBeenCalledWith(43);
    expectTrackerState(tracker.getState(), {
      highestAcceptedUpdateId: 43,
      highestPersistedAcceptedUpdateId: 43,
      highestCompletedUpdateId: 43,
      safeCompletedUpdateId: 43,
      failedUpdateIds: [42],
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("keeps below-floor spool replays dispatchable after newer updates advance", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 42,
      ackPolicy: "after_agent_dispatch",
    });

    const newer = tracker.beginUpdate(updateCtx(43));
    if (!newer.accepted) {
      throw new Error("expected newer update to be accepted");
    }
    tracker.finishUpdate(newer.update, { completed: true });

    const oldReplay = tracker.beginUpdate(updateCtx(42));
    if (!oldReplay.accepted) {
      throw new Error("expected below-floor replay to remain accepted");
    }
    tracker.finishUpdate(oldReplay.update, { completed: true });

    // Second begin is rejected (numeric set and/or semantic key). After persist
    // advances, the numeric id may already be pruned below the persisted floor.
    expect(tracker.beginUpdate(updateCtx(42)).accepted).toBe(false);
    expectTrackerState(tracker.getState(), {
      highestAcceptedUpdateId: 43,
      highestCompletedUpdateId: 43,
      safeCompletedUpdateId: 43,
      pendingUpdateIds: [],
      failedUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("dispatches a delayed lower update id after newer cross-lane ids complete", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 100,
      ackPolicy: "after_agent_dispatch",
    });

    // Lane B finishes newer global update ids while lane A still holds N+1.
    const laterA = tracker.beginUpdate(updateCtx(102));
    const laterB = tracker.beginUpdate(updateCtx(103));
    if (!laterA.accepted || !laterB.accepted) {
      throw new Error("expected later cross-lane updates to be accepted");
    }
    tracker.finishUpdate(laterA.update, { completed: true });
    tracker.finishUpdate(laterB.update, { completed: true });

    // Delayed durable-spool replay of N+1 must still dispatch exactly once.
    const delayed = tracker.beginUpdate(updateCtx(101));
    if (!delayed.accepted) {
      throw new Error("expected delayed cross-lane spool replay to be accepted");
    }
    tracker.finishUpdate(delayed.update, { completed: true });

    expect(tracker.beginUpdate(updateCtx(101))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
    expectTrackerState(tracker.getState(), {
      highestAcceptedUpdateId: 103,
      highestCompletedUpdateId: 103,
      pendingUpdateIds: [],
      failedUpdateIds: [],
    } satisfies Partial<TelegramUpdateTrackerState>);
  });

  it("accepts a delayed group mention after newer cross-lane ids so routing can run", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 200,
      ackPolicy: "after_agent_dispatch",
    });

    const later = tracker.beginUpdate(updateCtx(202));
    if (!later.accepted) {
      throw new Error("expected later update to be accepted");
    }
    tracker.finishUpdate(later.update, { completed: true });

    // Mention-shaped payload uses the same beginUpdate gate as any other update;
    // watermark must not drop it before normal user_request mention routing.
    const mention = tracker.beginUpdate({
      update: {
        update_id: 201,
        message: {
          message_id: 10,
          text: "@bot hello",
          entities: [{ type: "mention", offset: 0, length: 4 }],
          chat: { id: -100, type: "supergroup", title: "group" },
          date: 1,
        },
      },
    });
    if (!mention.accepted) {
      throw new Error("expected delayed mention update to be accepted for user_request routing");
    }
    tracker.finishUpdate(mention.update, { completed: true });
    expect(tracker.beginUpdate(updateCtx(201))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
  });

  it("bounds accepted-id memory without a persist callback via retention window", () => {
    // No onAcceptedUpdateId: persisted floor never advances past the option floor.
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 0,
      ackPolicy: "after_agent_dispatch",
    });
    const firstId = 1;
    const lastId = ACCEPTED_UPDATE_ID_RETENTION + 50;
    for (let updateId = firstId; updateId <= lastId; updateId += 1) {
      const begun = tracker.beginUpdate(updateCtx(updateId));
      if (!begun.accepted) {
        throw new Error(`expected update ${updateId} to be accepted`);
      }
      tracker.finishUpdate(begun.update, { completed: true });
    }
    // Ids far below the retention window may be pruned; recent ids stay suppressed.
    expect(tracker.beginUpdate(updateCtx(firstId)).accepted).toBe(true);
    expect(tracker.beginUpdate(updateCtx(lastId))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
  });

  it("does not prune pending or failed accepted ids from the retention window", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 0,
      ackPolicy: "after_agent_dispatch",
    });
    const pendingId = 1;
    const failedId = 2;
    const pending = tracker.beginUpdate(updateCtx(pendingId));
    const failed = tracker.beginUpdate(updateCtx(failedId));
    if (!pending.accepted || !failed.accepted) {
      throw new Error("expected seed updates to be accepted");
    }
    tracker.finishUpdate(failed.update, { completed: false });

    const lastId = ACCEPTED_UPDATE_ID_RETENTION + 50;
    for (let updateId = 3; updateId <= lastId; updateId += 1) {
      const begun = tracker.beginUpdate(updateCtx(updateId));
      if (!begun.accepted) {
        throw new Error(`expected update ${updateId} to be accepted`);
      }
      tracker.finishUpdate(begun.update, { completed: true });
    }

    // Pending ids stay in the numeric set (never pruned) so re-begin is rejected
    // as accepted-watermark, not re-dispatched.
    expect(tracker.beginUpdate(updateCtx(pendingId))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
    const failedRetry = tracker.beginUpdate(updateCtx(failedId));
    if (!failedRetry.accepted) {
      throw new Error("expected failed update retry to be accepted");
    }
    tracker.finishUpdate(failedRetry.update, { completed: true });
    // After success, re-begin is rejected (numeric and/or semantic).
    expect(tracker.beginUpdate(updateCtx(failedId)).accepted).toBe(false);
  });

  it("prunes accepted ids at or below the persisted Bot API offset", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });
    const early = tracker.beginUpdate(updateCtx(101));
    if (!early.accepted) {
      throw new Error("expected early update to be accepted");
    }
    tracker.finishUpdate(early.update, { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).toHaveBeenCalledWith(101);

    const later = tracker.beginUpdate(updateCtx(102));
    if (!later.accepted) {
      throw new Error("expected later update to be accepted");
    }
    tracker.finishUpdate(later.update, { completed: true });
    await flushTrackerMicrotasks();

    // Recent completed id stays suppressed; early completed id is eligible for
    // numeric prune once <= highestPersisted (semantic/spool still guard dups).
    expect(tracker.beginUpdate(updateCtx(102)).accepted).toBe(false);
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
    expectTrackerState(tracker.getState(), {
      highestAcceptedUpdateId: 103,
      highestPersistedAcceptedUpdateId: 100,
    } satisfies Partial<TelegramUpdateTrackerState>);

    firstWrite.resolve();
    await flushTrackerMicrotasks();
    expect(writes).toEqual([101, 103]);
    expect(onAcceptedUpdateId).not.toHaveBeenCalledWith(102);

    secondWrite.resolve();
    await flushTrackerMicrotasks();
    expectTrackerState(tracker.getState(), {
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

    expectTrackerState(tracker.getState(), {
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

    expectTrackerState(tracker.getState(), {
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
