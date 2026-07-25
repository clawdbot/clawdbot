// Shared command runner tests cover update helper command execution and error capture.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { createGlobalCommandRunner, parseTimeoutMsOrExit, resolveUpdateRoot } from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

describe("createGlobalCommandRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("forwards argv/options and maps exec result shape", async () => {
    runCommandWithTimeout.mockResolvedValueOnce({
      stdout: "out",
      stderr: "err",
      code: 17,
      signal: null,
      killed: false,
      termination: "exit",
    });
    const runCommand = createGlobalCommandRunner();

    const result = await runCommand(["npm", "root", "-g"], {
      timeoutMs: 1200,
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
    });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(["npm", "root", "-g"], {
      timeoutMs: 1200,
      cwd: "/tmp/openclaw",
      env: { OPENCLAW_TEST: "1" },
    });
    expect(result).toEqual({
      stdout: "out",
      stderr: "err",
      code: 17,
    });
  });

  it("requires timeout values to be complete positive integer seconds", () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);

    try {
      expect(parseTimeoutMsOrExit("1.5")).toBeNull();
      expect(parseTimeoutMsOrExit("10abc")).toBeNull();
      expect(parseTimeoutMsOrExit("0x10")).toBeNull();
      expect(parseTimeoutMsOrExit("0")).toBeNull();
      expect(parseTimeoutMsOrExit("-1")).toBeNull();
      expect(parseTimeoutMsOrExit("   ")).toBeNull();
      expect(parseTimeoutMsOrExit(String(Number.MAX_SAFE_INTEGER))).toBeNull();

      expect(error).toHaveBeenCalledTimes(7);
      expect(error).toHaveBeenCalledWith("--timeout must be a positive integer (seconds)");
      expect(exit).toHaveBeenCalledTimes(7);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("parses complete positive integer timeout values as milliseconds", () => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);

    try {
      expect(parseTimeoutMsOrExit(" 10 ")).toBe(10_000);
      expect(parseTimeoutMsOrExit("+10")).toBe(10_000);
      expect(parseTimeoutMsOrExit("001")).toBe(1_000);
      expect(parseTimeoutMsOrExit()).toBeUndefined();
      expect(error).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "resolves update ownership from the lexical invocation path",
    async () => {
      await withTempDir({ prefix: "openclaw-update-root-" }, async (base) => {
        const storeRoot = path.join(base, "store", "openclaw");
        const packageRoot = path.join(base, "global", "v11", "install", "node_modules", "openclaw");
        await fs.mkdir(path.dirname(packageRoot), { recursive: true });
        await fs.mkdir(storeRoot, { recursive: true });
        await fs.writeFile(
          path.join(storeRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.0" }),
          "utf8",
        );
        await fs.symlink(storeRoot, packageRoot, "dir");

        const previousArgv = [...process.argv];
        process.argv[1] = path.join(packageRoot, "openclaw.mjs");
        try {
          await expect(resolveUpdateRoot()).resolves.toBe(packageRoot);
        } finally {
          process.argv.splice(0, process.argv.length, ...previousArgv);
        }
      });
    },
  );
});
