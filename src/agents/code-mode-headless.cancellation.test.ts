import { afterEach, describe, expect, it } from "vitest";
import { runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";

describe("headless Code Mode cancellation", () => {
  afterEach(() => {
    try {
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      resetCodeModeTestState();
    }
  });

  it("completes after canceling a guest timer across two resumes", async () => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: `
        const timer = setTimeout(() => {}, 60_000);
        await new Promise((resolve) => setTimeout(resolve, 1));
        clearTimeout(timer);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "done";
      `,
      wallClockMs: 5_000,
    });

    expect(result).toEqual({
      status: "completed",
      value: "done",
      output: [],
      toolCallCount: 0,
    });
  });

  it("terminates an in-flight worker leg when aborted", async () => {
    const ctx = createHeadlessCodeModeHarness();
    const config = testing.resolveCodeModeHeadlessConfig(ctx);
    const controller = new AbortController();
    const resultPromise = testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "while (true) {}",
        config,
        catalog: [],
        apiFiles: [],
        namespaces: [],
      },
      5000,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
  });

  it("classifies caller aborts before the worker leg as aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: "return true;",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
  });
});
