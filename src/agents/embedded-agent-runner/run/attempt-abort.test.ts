import { describe, expect, it, vi } from "vitest";
import { releaseEmbeddedAttemptSessionLockForAbort } from "./attempt-abort.js";

describe("releaseEmbeddedAttemptSessionLockForAbort", () => {
  it("releases the retained session lock for manual aborts", async () => {
    const releaseHeldLockForAbort = vi.fn(async () => {});
    const warn = vi.fn();

    releaseEmbeddedAttemptSessionLockForAbort({
      sessionLockController: { releaseHeldLockForAbort },
      log: { warn },
      runId: "run-manual",
      abortKind: "abort",
    });

    await Promise.resolve();

    expect(releaseHeldLockForAbort).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs release failures without throwing from the abort path", async () => {
    const releaseError = new Error("locked");
    const releaseHeldLockForAbort = vi.fn(async () => {
      throw releaseError;
    });
    const warn = vi.fn();

    releaseEmbeddedAttemptSessionLockForAbort({
      sessionLockController: { releaseHeldLockForAbort },
      log: { warn },
      runId: "run-timeout",
      abortKind: "timeout abort",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(releaseHeldLockForAbort).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "failed to release session lock on timeout abort: runId=run-timeout Error: locked",
    );
  });
});
