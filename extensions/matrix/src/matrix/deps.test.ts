import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureMatrixCryptoRuntime, ensureMatrixSdkInstalled } from "./deps.js";

const logStub = vi.fn();

function resolveTestNativeBindingFilename(): string | null {
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64"
        ? "matrix-sdk-crypto.darwin-arm64.node"
        : process.arch === "x64"
          ? "matrix-sdk-crypto.darwin-x64.node"
          : null;
    case "linux": {
      const report = process.report?.getReport?.() as
        | { header?: { glibcVersionRuntime?: string } }
        | undefined;
      const isMusl = !report?.header?.glibcVersionRuntime;
      if (process.arch === "x64") {
        return isMusl
          ? "matrix-sdk-crypto.linux-x64-musl.node"
          : "matrix-sdk-crypto.linux-x64-gnu.node";
      }
      if (process.arch === "arm64" && !isMusl) {
        return "matrix-sdk-crypto.linux-arm64-gnu.node";
      }
      if (process.arch === "arm") {
        return "matrix-sdk-crypto.linux-arm-gnueabihf.node";
      }
      if (process.arch === "s390x") {
        return "matrix-sdk-crypto.linux-s390x-gnu.node";
      }
      return null;
    }
    case "win32":
      return process.arch === "x64"
        ? "matrix-sdk-crypto.win32-x64-msvc.node"
        : process.arch === "ia32"
          ? "matrix-sdk-crypto.win32-ia32-msvc.node"
          : process.arch === "arm64"
            ? "matrix-sdk-crypto.win32-arm64-msvc.node"
            : null;
    default:
      return null;
  }
}

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

  it("removes an incomplete native binding before loading the matrix SDK", async () => {
    const nativeBindingFilename = resolveTestNativeBindingFilename();
    if (!nativeBindingFilename) {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-crypto-runtime-"));
    const scriptPath = path.join(tmpDir, "download-lib.js");
    const nativeBindingPath = path.join(tmpDir, nativeBindingFilename);
    fs.writeFileSync(scriptPath, "");
    fs.writeFileSync(nativeBindingPath, Buffer.alloc(16));

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
      fs.writeFileSync(nativeBindingPath, Buffer.alloc(1_000_000));
      return { code: 0, stdout: "", stderr: "" };
    });

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      runCommand,
      resolveFn: () => scriptPath,
      nodeExecutable: "/usr/bin/node",
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledTimes(2);
    expect(fs.statSync(nativeBindingPath).size).toBe(1_000_000);
    expect(logStub).toHaveBeenCalledWith(
      "matrix: removed incomplete native crypto runtime (16 bytes); it will be downloaded again",
    );
  });
});

describe("ensureMatrixSdkInstalled", () => {
  it("returns without error when all required packages resolve", async () => {
    const resolveFn = vi.fn((_id: string) => "/fake/path");
    await expect(ensureMatrixSdkInstalled({ resolveFn })).resolves.toBeUndefined();
    expect(resolveFn).toHaveBeenCalled();
  });

  it("throws actionable repair error listing every missing package", async () => {
    const resolveFn = vi.fn((_id: string) => {
      throw new Error("Cannot find module");
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn })).rejects.toThrow(
      /Matrix plugin dependencies are missing: matrix-js-sdk, @matrix-org\/matrix-sdk-crypto-nodejs, @matrix-org\/matrix-sdk-crypto-wasm\. Repair this plugin with `openclaw plugins update matrix` or run `openclaw doctor --fix`\./,
    );
  });

  it("lists only the packages that fail to resolve", async () => {
    const resolveFn = vi.fn((id: string) => {
      if (id === "@matrix-org/matrix-sdk-crypto-wasm") {
        throw new Error("Cannot find module");
      }
      return "/fake/path";
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn })).rejects.toThrow(
      /Matrix plugin dependencies are missing: @matrix-org\/matrix-sdk-crypto-wasm\./,
    );
  });

  it("does not invoke the install confirm prompt when packages are missing (regression: #80758)", async () => {
    const confirm = vi.fn(async () => true);
    const resolveFn = vi.fn((_id: string) => {
      throw new Error("Cannot find module");
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn, confirm })).rejects.toThrow(
      /Matrix plugin dependencies are missing/,
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
