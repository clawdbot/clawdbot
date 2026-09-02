import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createCommandTerminationController } from "./exec-termination.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("command termination after root exit", () => {
  it.each([
    { name: "an absent group", probeError: "ESRCH", needsGrace: false },
    { name: "surviving descendants", probeError: undefined, needsGrace: true },
    { name: "a permission-denied group", probeError: "EPERM", needsGrace: true },
  ])("settles $name without losing cleanup ownership", async ({ probeError, needsGrace }) => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (probeError) {
        throw Object.assign(new Error(probeError), { code: probeError });
      }
      return true;
    });
    const child = { pid: 4242, exitCode: 7, signalCode: null, kill: vi.fn(() => true) };
    const cancelController = new AbortController();

    await withMockedPlatform("linux", async () => {
      const controller = createCommandTerminationController({
        child,
        cancelController,
        processTree: { mode: "graceful" },
        killGraceMs: 300,
        isChildExited: () => true,
        isCommandSettled: () => true,
      });
      controller.terminate();
      let settled = false;
      const completion = controller.settle().then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(!needsGrace);
      expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");

      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(!needsGrace);
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");

      await vi.advanceTimersByTimeAsync(1);
      await completion;
      if (needsGrace) {
        expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
      } else {
        expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
      }
      expect(kill.mock.calls.every(([pid]) => pid === -4242)).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      expect(cancelController.signal.aborted).toBe(false);
    });
  });
});
