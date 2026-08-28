import { afterEach, describe, expect, it } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
  registerReplyOperationSuccessorBarrier,
  resolveActiveReplyRunSessionId,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { acquireSessionReplyLane } from "./reply-run-lane.js";

const SESSION_KEY = "agent:test:reply-run-lane";

describe("acquireSessionReplyLane", () => {
  const openOperations: ReplyOperation[] = [];

  const track = <T extends ReplyOperation>(operation: T): T => {
    openOperations.push(operation);
    return operation;
  };

  afterEach(() => {
    for (const operation of openOperations.splice(0)) {
      operation.complete();
    }
  });

  it("registers an operation the channel-side busy check can see", async () => {
    const operation = track(await acquireSessionReplyLane(SESSION_KEY, "lane-1"));
    expect(operation.sessionId).toBe("lane-1");
    expect(resolveActiveReplyRunSessionId(SESSION_KEY)).toBe("lane-1");
    expect(isReplyRunActiveForSessionId("lane-1")).toBe(true);
  });

  it("waits for a live channel run instead of racing it", async () => {
    const channelRun = track(
      createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "channel-1",
        resetTriggered: false,
      }),
    );
    let acquired = false;
    const pending = acquireSessionReplyLane(SESSION_KEY, "lane-2").then((operation) => {
      acquired = true;
      return track(operation);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(acquired).toBe(false);
    channelRun.complete();
    const operation = await pending;
    expect(acquired).toBe(true);
    expect(resolveActiveReplyRunSessionId(SESSION_KEY)).toBe("lane-2");
    operation.complete();
  });

  it("fails with a busy error when the active run outlives the timeout", async () => {
    track(
      createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "channel-2",
        resetTriggered: false,
      }),
    );
    await expect(acquireSessionReplyLane(SESSION_KEY, "lane-3", { timeoutMs: 50 })).rejects.toThrow(
      /still has an active reply run after waiting/,
    );
  });

  it("rejects promptly when aborted while waiting", async () => {
    track(
      createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "channel-3",
        resetTriggered: false,
      }),
    );
    const controller = new AbortController();
    const pending = acquireSessionReplyLane(SESSION_KEY, "lane-4", {
      abortSignal: controller.signal,
    });
    const abortReason = new Error("caller gave up");
    setTimeout(() => controller.abort(abortReason), 10);
    await expect(pending).rejects.toBe(abortReason);
  });

  it("carries the routed thread identity onto the operation", async () => {
    const operation = track(
      await acquireSessionReplyLane(SESSION_KEY, "lane-7", { routeThreadId: "thread-42" }),
    );
    expect(operation.routeThreadId).toBe("thread-42");
  });

  it("waits through a successor barrier and adopts the rotated session id", async () => {
    const predecessor = track(
      createReplyOperation({
        sessionKey: SESSION_KEY,
        sessionId: "channel-4",
        resetTriggered: false,
      }),
    );
    let releaseHandoff: (() => void) | undefined;
    registerReplyOperationSuccessorBarrier({
      operation: predecessor,
      sessionId: "channel-4-rotated",
      sessionKeys: [SESSION_KEY],
      start: () =>
        new Promise<void>((resolve) => {
          releaseHandoff = resolve;
        }),
    });
    predecessor.complete();
    let acquired = false;
    const pending = acquireSessionReplyLane(SESSION_KEY, "lane-8").then((operation) => {
      acquired = true;
      return track(operation);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(acquired).toBe(false);
    releaseHandoff?.();
    const operation = await pending;
    expect(operation.sessionId).toBe("channel-4-rotated");
  });

  it("serializes two concurrent lane acquisitions", async () => {
    const first = track(await acquireSessionReplyLane(SESSION_KEY, "lane-5"));
    const order: string[] = [];
    const second = acquireSessionReplyLane(SESSION_KEY, "lane-6").then((operation) => {
      order.push("second-acquired");
      return track(operation);
    });
    order.push("first-completing");
    first.complete();
    await second;
    expect(order).toEqual(["first-completing", "second-acquired"]);
  });
});
