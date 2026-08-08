import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../../sessions/input-provenance.js";
import {
  EMBEDDED_RUN_LANE_HEARTBEAT_MS,
  resolveEmbeddedRunSessionQueuePriority,
  withEmbeddedRunLaneProgressHeartbeat,
} from "./lane-runtime.js";

afterEach(() => {
  vi.useRealTimers();
  resetCommandQueueStateForTest();
});

describe("embedded run lane priority", () => {
  it("runs a foreground user turn before queued restart recovery", async () => {
    const lane = "test:restart-recovery-priority";
    setCommandLaneConcurrency(lane, 1);
    let releaseBlocker: () => void = () => {};
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = enqueueCommandInLane(lane, async () => {
      await blockerGate;
    });
    const order: string[] = [];
    const restartRecovery = enqueueCommandInLane(
      lane,
      async () => {
        order.push("restart-recovery");
      },
      {
        priority: resolveEmbeddedRunSessionQueuePriority("user", {
          kind: "internal_system",
          sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
        }),
      },
    );
    const foreground = enqueueCommandInLane(
      lane,
      async () => {
        order.push("foreground-user");
      },
      { priority: resolveEmbeddedRunSessionQueuePriority("user") },
    );

    releaseBlocker();
    await Promise.all([blocker, foreground, restartRecovery]);

    expect(order).toEqual(["foreground-user", "restart-recovery"]);
  });
});

describe("embedded run lane progress heartbeat", () => {
  it("notes progress immediately and at the heartbeat cadence", async () => {
    vi.useFakeTimers();
    const noteLaneTaskProgress = vi.fn();
    let finish: ((value: string) => void) | undefined;
    const task = withEmbeddedRunLaneProgressHeartbeat(
      noteLaneTaskProgress,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS - 1);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2 + 1);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(4);

    finish?.("done");
    await expect(task).resolves.toBe("done");
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(5);
  });

  it("clears the heartbeat after rejection and propagates the error", async () => {
    vi.useFakeTimers();
    const noteLaneTaskProgress = vi.fn();
    const expectedError = new Error("runtime acquisition failed");
    let fail: ((error: Error) => void) | undefined;
    const task = withEmbeddedRunLaneProgressHeartbeat(
      noteLaneTaskProgress,
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject;
        }),
    );

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(2);
    fail?.(expectedError);
    await expect(task).rejects.toBe(expectedError);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_HEARTBEAT_MS * 2);
    expect(noteLaneTaskProgress).toHaveBeenCalledTimes(3);
  });

  it("keeps a slow lane task alive while runtime acquisition makes progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    const lane = `test:embedded-run-runtime-heartbeat:${Date.now()}`;
    setCommandLaneConcurrency(lane, 1);
    let progressAtMs = Date.now();

    const task = enqueueCommandInLane(
      lane,
      () =>
        withEmbeddedRunLaneProgressHeartbeat(
          () => {
            progressAtMs = Date.now();
          },
          () =>
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("completed"), 52_000);
            }),
        ),
      {
        taskTimeoutMs: 25_000,
        taskTimeoutProgressAtMs: () => progressAtMs,
      },
    );

    await vi.advanceTimersByTimeAsync(52_000);
    await expect(task).resolves.toBe("completed");
  });
});
