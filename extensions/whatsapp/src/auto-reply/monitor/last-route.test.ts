import { afterEach, describe, expect, it } from "vitest";
import { trackBackgroundTask } from "./last-route.js";

const waitForTaskCleanup = async (task: Promise<unknown>) => {
  await Promise.allSettled([task]);
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("trackBackgroundTask", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("does not leak unhandled rejections when a tracked task fails", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const backgroundTasks = new Set<Promise<unknown>>();
    let rejectTask: ((reason?: unknown) => void) | undefined;
    const task = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });

    trackBackgroundTask(backgroundTasks, task);
    expect(backgroundTasks.size).toBe(1);

    if (!rejectTask) {
      throw new Error("Expected tracked task reject callback to be initialized");
    }
    rejectTask(new Error("boom"));
    await waitForTaskCleanup(task);

    expect(backgroundTasks.size).toBe(0);
    expect(unhandledRejections).toStrictEqual([]);
  });
});
