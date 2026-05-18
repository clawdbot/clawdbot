import { describe, expect, it, vi } from "vitest";
import {
  installQaParentWatchdog,
  QA_PARENT_PID_ENV,
  QA_STAGED_RUNTIME_ROOT_ENV,
  QA_TEMP_ROOT_ENV,
} from "./qa-parent-watchdog.js";

describe("installQaParentWatchdog", () => {
  it("does not install without a QA parent pid", () => {
    expect(installQaParentWatchdog({ env: {}, ownPid: 10 })).toBeNull();
    expect(installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "10" }, ownPid: 10 })).toBeNull();
    expect(
      installQaParentWatchdog({ env: { [QA_PARENT_PID_ENV]: "not-a-pid" }, ownPid: 10 }),
    ).toBeNull();
  });

  it("exits when the QA parent process disappears", async () => {
    let tick: () => void = () => {
      throw new Error("watchdog interval was not installed");
    };
    const timer = { unref: vi.fn() };
    const chdir = vi.fn();
    const clearIntervalMock = vi.fn();
    const exit = vi.fn();
    const rm = vi.fn(async () => {});
    const logger = { warn: vi.fn() };
    const kill = vi.fn(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    const handle = installQaParentWatchdog({
      chdir,
      clearInterval: clearIntervalMock,
      cwd: () => "/tmp/openclaw-qa-suite-test",
      env: {
        [QA_PARENT_PID_ENV]: "12345",
        [QA_STAGED_RUNTIME_ROOT_ENV]: "/repo/.artifacts/qa-runtime/openclaw-qa-suite-test",
        [QA_TEMP_ROOT_ENV]: "/tmp/openclaw-qa-suite-test",
      },
      exit,
      kill,
      logger,
      ownPid: 10,
      rm,
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
    await vi.waitFor(() => {
      expect(chdir).toHaveBeenCalledWith("/tmp");
      expect(rm).toHaveBeenCalledWith("/tmp/openclaw-qa-suite-test");
      expect(rm).toHaveBeenCalledWith("/repo/.artifacts/qa-runtime/openclaw-qa-suite-test");
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("ignores unsafe QA temp root cleanup paths", async () => {
    let tick: () => void = () => {
      throw new Error("watchdog interval was not installed");
    };
    const exit = vi.fn();
    const rm = vi.fn(async () => {});
    const kill = vi.fn(() => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    installQaParentWatchdog({
      env: {
        [QA_PARENT_PID_ENV]: "12345",
        [QA_STAGED_RUNTIME_ROOT_ENV]: "/repo/.artifacts/qa-runtime/not-qa-suite",
        [QA_TEMP_ROOT_ENV]: "/tmp/not-qa-suite",
      },
      exit,
      kill,
      logger: { warn: vi.fn() },
      ownPid: 10,
      rm,
      setInterval: (callback) => {
        tick = callback;
        return { unref: vi.fn() };
      },
    });

    tick();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(rm).not.toHaveBeenCalled();
  });
});
