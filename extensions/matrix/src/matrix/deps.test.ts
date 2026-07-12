// Matrix tests cover deps plugin behavior.
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  ensureMatrixCryptoRuntime,
  ensureMatrixSdkInstalled,
  MATRIX_COMMAND_OUTPUT_TAIL_BYTES,
  runFixedCommandWithTimeout,
} from "./deps.js";

const logStub = vi.fn();

type ChildKill = (signal?: NodeJS.Signals | number) => boolean;

async function importDepsWithSpawnMock(
  spawnMock: ReturnType<typeof vi.fn>,
): Promise<typeof import("./deps.js")> {
  vi.resetModules();
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return {
      ...actual,
      spawn: spawnMock,
    };
  });
  return await import("./deps.js");
}

function waitForChildClose(proc: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for matrix command child close"));
    }, 5_000);
    timer.unref?.();
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForReadableData(stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve, reject) => {
    let cleanup = () => {};
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for matrix command child output"));
    }, 5_000);
    timer.unref?.();
    cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
    };
    const onData = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once("data", onData);
    stream.once("error", onError);
  });
}

function waitForReadableErrorDispatch() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
});

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
    const requireFn = vi.fn(() => ({}));

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      resolveFn: () => "/tmp/download-lib.js",
    });

    expect(requireFn).toHaveBeenCalledTimes(1);
  });

  it("bootstraps missing crypto runtime and retries matrix SDK load", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-crypto-bootstrap-"));
    const scriptPath = path.join(tmpDir, "download-lib.js");
    const markerPath = path.join(tmpDir, "bootstrapped");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        `if (fs.realpathSync(process.cwd()) !== ${JSON.stringify(fs.realpathSync(tmpDir))}) process.exit(2);`,
        'if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT !== "0") process.exit(3);',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "ok");`,
      ].join("\n"),
    );
    const requireFn = vi.fn(() => {
      if (!fs.existsSync(markerPath)) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });

    try {
      await ensureMatrixCryptoRuntime({
        log: logStub,
        requireFn,
        resolveFn: () => scriptPath,
      });

      expect(fs.readFileSync(markerPath, "utf8")).toBe("ok");
      expect(requireFn).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rethrows non-crypto module errors without bootstrapping", async () => {
    const requireFn = vi.fn(() => {
      throw new Error("Cannot find module 'not-the-matrix-crypto-runtime'");
    });

    await expect(
      ensureMatrixCryptoRuntime({
        log: logStub,
        requireFn,
        resolveFn: () => "/tmp/download-lib.js",
      }),
    ).rejects.toThrow("Cannot find module 'not-the-matrix-crypto-runtime'");

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
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(nativeBindingPath)}, Buffer.alloc(1_000_000));`,
      ].join("\n"),
    );
    fs.writeFileSync(nativeBindingPath, Buffer.alloc(16));

    const requireFn = vi.fn(() => {
      if (!fs.existsSync(nativeBindingPath) || fs.statSync(nativeBindingPath).size < 1_000_000) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });

    try {
      await ensureMatrixCryptoRuntime({
        log: logStub,
        requireFn,
        resolveFn: () => scriptPath,
      });

      expect(requireFn).toHaveBeenCalledTimes(2);
      expect(fs.statSync(nativeBindingPath).size).toBe(1_000_000);
      expect(logStub).toHaveBeenCalledWith(
        "matrix: removed incomplete native crypto runtime (16 bytes); it will be downloaded again",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runFixedCommandWithTimeout", () => {
  it("retains bounded tails from noisy bootstrap commands", async () => {
    const result = await runFixedCommandWithTimeout({
      argv: [
        process.execPath,
        "-e",
        [
          `process.stdout.write("a".repeat(${MATRIX_COMMAND_OUTPUT_TAIL_BYTES + 1}));`,
          `process.stderr.write("b".repeat(${MATRIX_COMMAND_OUTPUT_TAIL_BYTES + 1}));`,
        ].join(""),
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(MATRIX_COMMAND_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBe(MATRIX_COMMAND_OUTPUT_TAIL_BYTES);
    expect(result.stdout).toBe("a".repeat(MATRIX_COMMAND_OUTPUT_TAIL_BYTES));
    expect(result.stderr).toBe("b".repeat(MATRIX_COMMAND_OUTPUT_TAIL_BYTES));
  });

  it("keeps bounded stdout and stderr tails on UTF-8 character boundaries", async () => {
    const suffix = "z".repeat(MATRIX_COMMAND_OUTPUT_TAIL_BYTES - 2);
    const result = await runFixedCommandWithTimeout({
      argv: [
        process.execPath,
        "-e",
        [
          'const prefix = "a".repeat(10);',
          `const suffix = "z".repeat(${MATRIX_COMMAND_OUTPUT_TAIL_BYTES - 2});`,
          "const payload = `${prefix}🙂${suffix}`;",
          "process.stdout.write(payload);",
          "process.stderr.write(payload);",
        ].join(""),
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      MATRIX_COMMAND_OUTPUT_TAIL_BYTES,
    );
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(
      MATRIX_COMMAND_OUTPUT_TAIL_BYTES,
    );
    expect(result.stdout).toBe(suffix);
    expect(result.stderr).toBe(suffix);
    expect(result.stdout).not.toContain("\uFFFD");
    expect(result.stderr).not.toContain("\uFFFD");
  });

  it("settles real child stream errors after child close and terminates once", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

    for (const streamName of ["stdout", "stderr"] as const) {
      let proc: ChildProcessWithoutNullStreams | undefined;
      let killSpy: MockInstance<ChildKill> | undefined;
      try {
        const spawnMock = vi.fn(
          (command: string, args: string[] | undefined, options: SpawnOptions) => {
            proc = actual.spawn(command, args ?? [], options) as ChildProcessWithoutNullStreams;
            return proc;
          },
        );
        const { runFixedCommandWithTimeout: runWithMockedSpawn } =
          await importDepsWithSpawnMock(spawnMock);
        const exitListenersBefore = process.listenerCount("exit");

        const resultPromise = runWithMockedSpawn({
          argv: [
            process.execPath,
            "-e",
            [
              "process.stdin.resume();",
              'process.on("SIGTERM", () => {});',
              'process.stdout.write("stdout ready\\n");',
              'process.stderr.write("stderr ready\\n");',
              "setInterval(() => {}, 1000);",
            ].join(""),
          ],
          cwd: process.cwd(),
          timeoutMs: 10_000,
        });
        if (!proc) {
          throw new Error("expected matrix command helper to spawn a child process");
        }
        killSpy = vi.spyOn(proc, "kill");
        const closePromise = waitForChildClose(proc);
        await Promise.all([waitForReadableData(proc.stdout), waitForReadableData(proc.stderr)]);
        let settled = false;
        void resultPromise.then(() => {
          settled = true;
        });
        const message = `synthetic parent ${streamName} read failure`;

        proc[streamName].destroy(new Error(message));
        await waitForReadableErrorDispatch();
        expect(settled).toBe(false);
        expect(process.listenerCount("exit")).toBe(exitListenersBefore + 1);
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith("SIGTERM");

        const duplicateStreamName = streamName === "stdout" ? "stderr" : "stdout";
        proc[duplicateStreamName].destroy(new Error("duplicate parent readable failure"));
        await waitForReadableErrorDispatch();
        expect(killSpy).toHaveBeenCalledTimes(1);

        const result = await resultPromise;
        const close = await closePromise;

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${streamName} stream failed: ${message}`);
        expect(result.stderr).not.toContain("duplicate parent readable failure");
        expect(close).toStrictEqual({ code: null, signal: "SIGKILL" });
        expect(killSpy).toHaveBeenLastCalledWith("SIGKILL");
        expect(process.listenerCount("exit")).toBe(exitListenersBefore);
      } finally {
        killSpy?.mockRestore();
        if (proc && proc.exitCode === null && !proc.killed) {
          proc.kill("SIGKILL");
        }
      }
    }
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
