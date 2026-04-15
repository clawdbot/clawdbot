import { afterEach, describe, expect, it } from "vitest";
import { trackBackgroundTask } from "./last-route.js";

const waitForAsyncCallbacks = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    let rejectTask!: (reason?: unknown) => void;
    const task = new Promise<void>((_resolve, reject) => {
      rejectTask = reject;
    });

    trackBackgroundTask(backgroundTasks, task);
    expect(backgroundTasks.size).toBe(1);

    rejectTask(new Error("boom"));
    await waitForAsyncCallbacks();

    expect(backgroundTasks.size).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });
});
