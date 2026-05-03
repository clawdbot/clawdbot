import { describe, expect, it, vi } from "vitest";
import { installQaParentWatchdog, QA_PARENT_PID_ENV } from "./qa-parent-watchdog.js";

describe("installQaParentWatchdog", () => {
  it("does not install without a QA parent pid", () => {
    expect(installQaParentWatchdog({ env: {}, ownPid: 10 })).toBeNull();
    expect(installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "10" }, ownPid: 10 })).toBeNull();
    expect(
      installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "not-a-pid" }, ownPid: 10 }),
    ).toBeNull();
  });

  it("exits when the QA parent process disappears", () => {
    let tick: () => void = () => {
      throw new Error("watchdog interval was not installed");
    };
    const timer = { unref: vi.fn() };
    const clearIntervalMock = vi.fn();
    const exit = vi.fn();
    const logger = { warn: vi.fn() };
    const kill = vi.fn(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    const handle = installQaParentWatchdog({
      clearInterval: clearIntervalMock,
      env: { [QA_PARENT_PID_ENV]: "12345" },
      exit,
      kill,
      logger,
      ownPid: 10,
      setInterval: (callback) => {
        tick = callback;
        return timer;
      },
    });

    expect(handle?.parentPid).toBe(12345);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    tick();
    expect(kill).toHaveBeenCalledWith(12345, 0);
    expect(logger.warn).toHaveBeenCalledWith(
      "QA gateway parent pid 12345 exited; shutting down orphaned QA gateway",
    );
    expect(clearIntervalMock).toHaveBeenCalledWith(timer);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
