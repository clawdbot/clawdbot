// Browser tests cover pw tools core.interactions click hold-delay abort behavior.
import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.interactions.js");

describe("clickViaPlaywright (hold-delay abort)", () => {
  it("unwinds the hold-delay action chain promptly when aborted mid-delay", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ hover, click });
      setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.test/hold") });

      const ctrl = new AbortController();
      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
        ssrfPolicy: { allowPrivateNetwork: false },
        signal: ctrl.signal,
      });
      const settled = task.then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      // Enter the click-and-hold delay, then abort 100ms into the 5s hold.
      await vi.advanceTimersByTimeAsync(100);
      expect(hover).toHaveBeenCalledTimes(1);
      ctrl.abort(new Error("aborted by test"));

      const outcome = await settled;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        expect((outcome.reason as Error).message).toContain("aborted by test");
      }
      expect(click).not.toHaveBeenCalled();
      expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ssrfPolicy: { allowPrivateNetwork: false },
        reason: "click aborted",
      });

      // The aborted action chain must unwind right away: the post-action
      // navigation recheck runs after the 250ms delayed-navigation observation
      // plus the 250ms grace, not after the remaining 4900ms of the hold.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        getPwToolsCoreSessionMocks().assertPageNavigationCompletedSafely,
      ).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits the full hold delay before clicking when not aborted", async () => {
    vi.useFakeTimers();
    try {
      const hover = vi.fn(async () => {});
      const click = vi.fn(async () => {});
      setPwToolsCoreCurrentRefLocator({ hover, click });
      setPwToolsCoreCurrentPage({ url: vi.fn(() => "https://example.test/hold") });

      const task = mod.clickViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        ref: "1",
        delayMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(hover).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await task;
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
