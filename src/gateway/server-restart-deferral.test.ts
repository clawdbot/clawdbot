import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllDispatchers,
  getTotalPendingReplies,
} from "../auto-reply/reply/dispatcher-registry.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import {
  getActiveChatSendRunCount,
  registerChatAbortControllersForRestartDeferral,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";

async function flushMicrotasks(count = 10): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("gateway restart deferral", () => {
  let replyErrors: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    replyErrors = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await flushMicrotasks();
    clearAllDispatchers();
    registerChatAbortControllersForRestartDeferral(new Map());
  });

  it("defers restart while reply delivery is in flight", async () => {
    let rpcConnected = true;
    const deliveredReplies: string[] = [];
    const deliveryStarted = createDeferred();
    const allowDelivery = createDeferred();

    // Hold delivery open so restart checks run while reply is in-flight.
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (!rpcConnected) {
          const error = "Error: imsg rpc not running";
          replyErrors.push(error);
          throw new Error(error);
        }
        deliveryStarted.resolve();
        await allowDelivery.promise;
        deliveredReplies.push(payload.text ?? "");
      },
      onError: () => {
        // Swallow delivery errors so the test can assert on replyErrors.
      },
    });

    // Enqueue reply and immediately clear the reservation.
    // This is the critical sequence: after markComplete(), the ONLY thing
    // keeping pending > 0 is the in-flight delivery itself.
    dispatcher.sendFinalReply({ text: "Configuration updated!" });
    dispatcher.markComplete();
    await deliveryStarted.promise;

    // At this point: delivery is in flight; pending > 0 prevents restart.
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    let restartTriggered = false;
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      const pending = getTotalPendingReplies();
      if (pending === 0) {
        restartTriggered = true;
        rpcConnected = false;
        break;
      }
    }

    allowDelivery.resolve();
    await dispatcher.waitForIdle();

    expect(getTotalPendingReplies()).toBe(0);
    expect(restartTriggered).toBe(false);
    expect(replyErrors).toEqual([]);
    expect(deliveredReplies).toEqual(["Configuration updated!"]);
  });

  it("keeps pending > 0 until the reply is actually enqueued", async () => {
    const allowDelivery = createDeferred();

    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        await allowDelivery.promise;
      },
    });

    expect(getTotalPendingReplies()).toBe(1);

    await Promise.resolve();
    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.sendFinalReply({ text: "Reply" });
    expect(getTotalPendingReplies()).toBe(2);

    dispatcher.markComplete();
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    allowDelivery.resolve();
    await dispatcher.waitForIdle();
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("defers restart until reply dispatcher completes", async () => {
    const deliveredReplies: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        await Promise.resolve();
        deliveredReplies.push(payload.text ?? "");
      },
      onError: (err) => {
        throw err;
      },
    });

    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.sendFinalReply({ text: "Configuration updated successfully!" });
    expect(getTotalPendingReplies()).toBe(2);

    dispatcher.markComplete();
    expect(getTotalPendingReplies()).toBeGreaterThan(0);

    await dispatcher.waitForIdle();

    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Configuration updated successfully!"]);
    expect(getTotalQueueSize()).toBe(0);
  });

  it("clears dispatcher reservation when no replies were sent", async () => {
    let deliverCalled = false;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        deliverCalled = true;
      },
    });

    expect(getTotalPendingReplies()).toBe(1);

    dispatcher.markComplete();
    await flushMicrotasks();

    expect(getTotalPendingReplies()).toBe(0);
    await dispatcher.waitForIdle();

    expect(deliverCalled).toBe(false);
    expect(getTotalPendingReplies()).toBe(0);
  });

  // Regression test for OpenClawBot #1689: a webapp/Control UI chat.send run's
  // reply-dispatcher reservation (getTotalPendingReplies) is released as soon as
  // reply delivery finishes -- but server-methods/chat.ts still has to persist the
  // combined reply to session history and broadcast "chat.final" *after* that point
  // (see the .then() block following dispatchInboundMessage in chat.ts). Before this
  // fix, a restart-deferral check sampled in that window would see pendingReplies==0
  // and let the restart fire immediately, killing the process before the reply was
  // ever written to disk. getActiveChatSendRunCount() (backed by chat.ts's
  // chatAbortControllers map, which the run only leaves in its own .finally()) must
  // stay > 0 for the run's true full lifetime, closing that gap.
  it("keeps the run active via chatAbortControllers after the reply dispatcher goes idle but before persistence completes", async () => {
    const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
    registerChatAbortControllersForRestartDeferral(chatAbortControllers);

    const deliveredReplies: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveredReplies.push(payload.text ?? "");
      },
    });

    // Mirrors chat.ts: the run is registered in chatAbortControllers *before* the
    // agent turn starts, and only removed in the outer .finally() once the combined
    // reply has been persisted and broadcast.
    const runId = "run-1";
    chatAbortControllers.set(runId, {
      controller: new AbortController(),
      sessionId: "sess-1",
      sessionKey: "main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });

    const totalActive = () => getTotalPendingReplies() + getActiveChatSendRunCount();
    expect(totalActive()).toBeGreaterThan(0);

    // Reply generation completes: dispatcher.enqueue -> markComplete -> waitForIdle,
    // exactly as withReplyDispatcher() does in dispatch-dispatcher.ts's finally block.
    dispatcher.sendFinalReply({ text: "Configuration updated!" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The old, buggy signal alone now reads idle -- this is the exact moment a
    // restart used to fire and drop the reply.
    expect(getTotalPendingReplies()).toBe(0);
    expect(deliveredReplies).toEqual(["Configuration updated!"]);

    // But the run is not actually done: chat.ts hasn't appended the combined reply
    // to session history yet (that only happens in its post-dispatch .then()).
    // getActiveChatSendRunCount() must still report it active.
    expect(getActiveChatSendRunCount()).toBe(1);
    expect(totalActive()).toBeGreaterThan(0);

    // Simulate chat.ts's post-dispatch .then(): persist to session history, then
    // finally() removes the run from chatAbortControllers.
    const persisted: string[] = [...deliveredReplies];
    chatAbortControllers.delete(runId);

    expect(persisted).toEqual(["Configuration updated!"]);
    expect(getActiveChatSendRunCount()).toBe(0);
    expect(totalActive()).toBe(0);
  });
});
