import { describe, expect, it, vi } from "vitest";
import {
  inspectFaceTimeDriver,
  installFaceTimeDriver,
  uninstallFaceTimeDriver,
} from "../src/driver-setup.js";

describe("FaceTime driver setup", () => {
  it("reads the idempotent installer status", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "current\n",
      stderr: "",
    });

    await expect(
      inspectFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
      }),
    ).resolves.toBe("current");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--status"],
      { timeoutMs: 10_000 },
    );
  });

  it("does not prompt or restart CoreAudio when the driver is current", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "current\n",
      stderr: "",
    });

    await expect(
      installFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        callActive: false,
      }),
    ).resolves.toEqual({ changed: false, status: "current" });
    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("rejects installation while a call is active", async () => {
    const runCommandWithTimeout = vi.fn();

    await expect(
      installFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        callActive: true,
      }),
    ).rejects.toThrow("during an active or pending call");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("installs and verifies a missing driver", async () => {
    const abortController = new AbortController();
    const runCommandWithTimeout = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: "missing\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "Installed\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "current\n", stderr: "" });

    await expect(
      installFaceTimeDriver({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        callActive: false,
        signal: abortController.signal,
      }),
    ).resolves.toEqual({ changed: true, status: "current" });
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      2,
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--ensure"],
      { killProcessTree: true, signal: abortController.signal },
    );
  });

  it("runs the explicit process-tree-bound uninstall contract", async () => {
    const abortController = new AbortController();
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "Removed\n",
      stderr: "",
    });

    await uninstallFaceTimeDriver({
      pluginRoot: "/tmp/facetime",
      runCommandWithTimeout: runCommandWithTimeout as never,
      signal: abortController.signal,
    });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/sh", "/tmp/facetime/scripts/install-driver.sh", "--uninstall"],
      { killProcessTree: true, signal: abortController.signal },
    );
  });
});
