// Shared command runner tests cover update helper command execution and error capture.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  createGlobalCommandRunner,
  ensureGitCheckout,
  parseTimeoutMsOrExit,
  resolveUpdateRoot,
} from "./shared.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout,
}));

const successfulCommandResult = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit" as const,
};

function cloneTarget(argv: string[]): string {
  const target = argv.at(-1);
  if (!target) {
    throw new Error("git clone target missing from command");
  }
  return target;
}

describe("update CLI shared helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockResolvedValue(successfulCommandResult);
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
      expect(parseTimeoutMsOrExit("")).toBeNull();
      expect(parseTimeoutMsOrExit("1.5")).toBeNull();
      expect(parseTimeoutMsOrExit("10abc")).toBeNull();
      expect(parseTimeoutMsOrExit("0x10")).toBeNull();
      expect(parseTimeoutMsOrExit("0")).toBeNull();
      expect(parseTimeoutMsOrExit("-1")).toBeNull();
      expect(parseTimeoutMsOrExit("   ")).toBeNull();
      expect(parseTimeoutMsOrExit(String(Number.MAX_SAFE_INTEGER))).toBeNull();

      expect(error).toHaveBeenCalledTimes(8);
      expect(error).toHaveBeenCalledWith("--timeout must be a positive integer (seconds)");
      expect(exit).toHaveBeenCalledTimes(8);
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
      await withTestDir({ prefix: "openclaw-update-root-" }, async (base) => {
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

  it("publishes a successful fresh clone only after the clone completes", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-success-" }, async (base) => {
      const checkoutDir = path.join(base, "nested", "openclaw");
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        expect(stagingDir).toMatch(/[/\\]\.openclaw-clone-[^/\\]+$/u);
        expect(stagingDir).not.toBe(checkoutDir);
        await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        await fs.writeFile(path.join(stagingDir, "checkout.marker"), "complete\n");
        return successfulCommandResult;
      });

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).resolves.toMatchObject({ exitCode: 0 });

      await expect(fs.readFile(path.join(checkoutDir, "checkout.marker"), "utf8")).resolves.toBe(
        "complete\n",
      );
      await expect(fs.readdir(path.dirname(checkoutDir))).resolves.toEqual(["openclaw"]);
      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        [
          "git",
          "clone",
          "--filter=blob:none",
          "https://github.com/openclaw/openclaw.git",
          expect.stringMatching(/[/\\]\.openclaw-clone-[^/\\]+$/u),
        ],
        expect.objectContaining({ env: process.env, timeoutMs: 1_000 }),
      );
    });
  });

  it("removes a failed fresh clone without publishing the destination", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-failure-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        return {
          ...successfulCommandResult,
          stderr: "clone interrupted",
          code: 42,
        };
      });

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).resolves.toMatchObject({ exitCode: 42 });

      await expect(fs.stat(checkoutDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(base)).resolves.toEqual([]);
    });
  });

  it("preserves a destination created while a fresh clone is running", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-race-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      runCommandWithTimeout.mockImplementationOnce(async (argv: string[]) => {
        const stagingDir = cloneTarget(argv);
        await fs.mkdir(path.join(stagingDir, ".git"), { recursive: true });
        await fs.mkdir(checkoutDir);
        await fs.writeFile(path.join(checkoutDir, "user.marker"), "keep\n");
        return successfulCommandResult;
      });

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).rejects.toThrow("appeared while cloning");

      await expect(fs.readFile(path.join(checkoutDir, "user.marker"), "utf8")).resolves.toBe(
        "keep\n",
      );
      await expect(fs.readdir(base)).resolves.toEqual(["openclaw"]);
    });
  });

  it("keeps the existing empty-directory clone path in place", async () => {
    await withTestDir({ prefix: "openclaw-update-clone-existing-" }, async (base) => {
      const checkoutDir = path.join(base, "openclaw");
      await fs.mkdir(checkoutDir);

      await expect(
        ensureGitCheckout({ dir: checkoutDir, timeoutMs: 1_000, env: process.env }),
      ).resolves.toMatchObject({ exitCode: 0 });

      expect(runCommandWithTimeout).toHaveBeenCalledWith(
        [
          "git",
          "clone",
          "--filter=blob:none",
          "https://github.com/openclaw/openclaw.git",
          checkoutDir,
        ],
        expect.objectContaining({ cwd: checkoutDir, env: process.env, timeoutMs: 1_000 }),
      );
    });
  });
});
