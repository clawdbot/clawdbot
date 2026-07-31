import { describe, expect, it, vi } from "vitest";
import { runGhCommand } from "../../scripts/lib/ghsa-patch-subprocess.mjs";

describe("GHSA patch subprocess", () => {
  it("bounds each GitHub lookup with a timeout and SIGKILL", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "result",
      stderr: "",
    }));

    expect(runGhCommand(["api", "rate_limit"], { spawnSyncImpl })).toBe("result");
    expect(spawnSyncImpl).toHaveBeenCalledWith("gh", ["api", "rate_limit"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 60_000,
    });
  });

  it("throws the GitHub CLI error when a lookup exits non-zero", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "gh api failed",
    }));

    expect(() => runGhCommand(["api", "rate_limit"], { spawnSyncImpl })).toThrow("gh api failed");
  });

  it("propagates the timeout error from a stalled GitHub CLI process", () => {
    const timeout = Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" });
    const spawnSyncImpl = vi.fn(() => ({
      error: timeout,
      status: null,
      stdout: "",
      stderr: "",
    }));

    expect(() => runGhCommand(["api", "rate_limit"], { spawnSyncImpl })).toThrow(timeout);
  });
});
