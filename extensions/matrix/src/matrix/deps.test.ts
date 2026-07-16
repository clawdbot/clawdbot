import { describe, expect, it, vi } from "vitest";
import { ensureMatrixCryptoRuntime } from "./deps.js";

const logStub = vi.fn();

describe("ensureMatrixCryptoRuntime", () => {
  it("returns immediately when matrix SDK loads", async () => {
    const runCommand = vi.fn();
    const requireFn = vi.fn(() => ({}));

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      runCommand,
      resolveFn: () => "/tmp/download-lib.js",
      nodeExecutable: "/usr/bin/node",
    });

    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("bootstraps missing crypto runtime and retries matrix SDK load", async () => {
    let bootstrapped = false;
    const requireFn = vi.fn(() => {
      if (!bootstrapped) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });
    const runCommand = vi.fn(async () => {
      bootstrapped = true;
      return { code: 0, stdout: "", stderr: "" };
    });

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      runCommand,
      resolveFn: () => "/tmp/download-lib.js",
      nodeExecutable: "/usr/bin/node",
    });

    expect(runCommand).toHaveBeenCalledWith({
      argv: ["/usr/bin/node", "/tmp/download-lib.js"],
      cwd: "/tmp",
      timeoutMs: 300_000,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    expect(requireFn).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-crypto module errors without bootstrapping", async () => {
    const runCommand = vi.fn();
    const requireFn = vi.fn(() => {
      throw new Error("Cannot find module 'not-the-matrix-crypto-runtime'");
    });

    await expect(
      ensureMatrixCryptoRuntime({
        log: logStub,
        requireFn,
        runCommand,
        resolveFn: () => "/tmp/download-lib.js",
        nodeExecutable: "/usr/bin/node",
      }),
    ).rejects.toThrow("Cannot find module 'not-the-matrix-crypto-runtime'");

    expect(runCommand).not.toHaveBeenCalled();
    expect(requireFn).toHaveBeenCalledTimes(1);
  });
});
