import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientHarness } from "./test-support.js";

describe("Codex app-server child exit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["clean", 0, null],
    ["error", 1, null],
    ["signal", null, "SIGTERM"],
  ] as const)("settles repeated shutdown after %s exit", async (mode, code, signal) => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    const exited = vi.fn();
    harness.process.on("exit", exited);
    if (mode === "clean") {
      harness.client.close();
    } else {
      // A manual exit can arrive before the queued clean exit from stdin destruction.
      harness.process.stdin.destroy();
      harness.process.emit("exit", code, signal);
    }
    await vi.advanceTimersByTimeAsync(0);

    const settled = vi.fn();
    const closing = harness.client.closeAndWait().then(settled);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ exited: true, cleanup: "uncertain" });
      await expect(harness.client.closeAndWait()).resolves.toEqual({
        exited: true,
        cleanup: "uncertain",
      });
      expect(exited).toHaveBeenCalledExactlyOnceWith(code, signal);
      expect(harness.process).toMatchObject({ exitCode: code, signalCode: signal });
      expect(harness.stdinDestroyed).toBe(true);
      expect(harness.process.stdout.destroyed).toBe(true);
      expect(harness.process.stderr.destroyed).toBe(true);
      expect(harness.process.kill).not.toHaveBeenCalled();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      await closing;
      harness.process.stdout.destroy();
      harness.process.stderr.destroy();
    }
  });
});
