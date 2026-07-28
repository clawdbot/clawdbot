// Tests race-safe process cleanup helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { killPidIfAlive } from "./process-tree.js";

describe("killPidIfAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores ESRCH when a live process exits before SIGKILL", () => {
    const killError = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const kill = vi
      .spyOn(process, "kill")
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw killError;
      });

    expect(() => killPidIfAlive(123)).not.toThrow();
    expect(kill).toHaveBeenNthCalledWith(1, 123, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 123, "SIGKILL");
  });

  it("rethrows other SIGKILL failures", () => {
    const killError = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    vi.spyOn(process, "kill")
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw killError;
      });

    expect(() => killPidIfAlive(123)).toThrow(killError);
  });
});
