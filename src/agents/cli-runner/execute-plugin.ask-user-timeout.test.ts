import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

async function startBlockedRun(options: {
  timeoutMs: number;
  getDeadline: () => number | undefined;
  onChange?: (listener: () => void) => () => void;
}) {
  const { context } = await createExecution({ timeoutMs: options.timeoutMs });
  const started = createDeferred();
  const run = runPlugin(
    context,
    async function* ({ abortSignal }) {
      if (!abortSignal) {
        throw new Error("Host execution did not expose its abort signal.");
      }
      started.resolve();
      await new Promise<never>((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      yield SUCCESS_RESULT;
    },
    {
      noOutputTimeoutMs: 100,
      activeToolCount: () => 1,
      getActiveLoopbackAskUserDeadline: options.getDeadline,
      onActiveLoopbackAskUserDeadlineChange: options.onChange ?? (() => () => {}),
    },
  );
  await started.promise;
  return { run };
}

afterEach(() => {
  closePluginTestAdmissions();
  vi.useRealTimers();
});

describe("plugin-owned CLI ask_user timeout", () => {
  it.each([
    ["uses the exact question deadline", 4_000_000, 3_610_000, "no-output-timeout"],
    ["keeps the earlier overall deadline authoritative", 150, 150, "overall-timeout"],
  ] as const)("%s", async (_name, timeoutMs, advanceMs, reason) => {
    vi.useFakeTimers();
    const deadline = Date.now() + 3_610_000;
    const { run } = await startBlockedRun({ timeoutMs, getDeadline: () => deadline });
    let completed = false;
    void run.then(() => {
      completed = true;
    });
    if (reason === "no-output-timeout") {
      await vi.advanceTimersByTimeAsync(900_000);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(advanceMs - 900_000);
    } else {
      await vi.advanceTimersByTimeAsync(advanceMs);
    }
    await expect(run).resolves.toMatchObject({
      reason,
      timedOut: true,
      noOutputTimedOut: reason === "no-output-timeout",
    });
  });

  it("does not let a short question shrink the blocked-tool watchdog floor", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 40_000;
    const { run } = await startBlockedRun({
      timeoutMs: 2_000_000,
      getDeadline: () => deadline,
    });
    let completed = false;
    void run.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(899_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });

  it("restores the remaining ordinary watchdog when ask_user clears early", async () => {
    vi.useFakeTimers();
    let deadline: number | undefined = Date.now() + 3_610_000;
    const listeners = new Set<() => void>();
    const { run } = await startBlockedRun({
      timeoutMs: 2_000_000,
      getDeadline: () => deadline,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    await vi.advanceTimersByTimeAsync(200);
    deadline = undefined;
    listeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(899_799);
    let completed = false;
    void run.then(() => {
      completed = true;
    });
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });
});
