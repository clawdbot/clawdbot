// Qa Lab tests cover node exec plugin behavior.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runExecMock } = vi.hoisted(() => ({ runExecMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));

import { resolveQaNodeExecPath } from "./node-exec.js";

describe("resolveQaNodeExecPath", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the current exec path when already running under Node", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/node",
        platform: "darwin",
        versions: { ...process.versions, bun: undefined },
      }),
    ).resolves.toBe("/opt/homebrew/bin/node");
  });

  it("reuses nodejs as a valid current Node executable", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/usr/bin/nodejs",
        platform: "linux",
        versions: { ...process.versions, bun: undefined },
        execFileImpl: async () => {
          throw new Error("should not search PATH");
        },
      }),
    ).resolves.toBe("/usr/bin/nodejs");
  });

  it("resolves node from PATH when the parent runtime is bun", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
        execFileImpl: async () => ({
          stdout: "/usr/local/bin/node\n",
          stderr: "",
        }),
      }),
    ).resolves.toBe("/usr/local/bin/node");
  });

  it("uses a supplied environment as the exact base for the default PATH probe", async () => {
    const env = { PATH: "/qa/bin" };
    runExecMock.mockResolvedValueOnce({ stdout: "/qa/bin/node\n", stderr: "" });

    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
        env,
      }),
    ).resolves.toBe("/qa/bin/node");

    expect(runExecMock).toHaveBeenCalledWith("which", ["node"], {
      baseEnv: env,
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("uses trusted Windows where.exe when resolving node from PATH", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: String.raw`D:\Tools\bun.exe`,
        platform: "win32",
        versions: { ...process.versions, bun: "1.2.3" },
        env: { SystemRoot: String.raw`D:\Windows` },
        execFileImpl: async (file, args, options) => {
          expect(file).toBe(path.win32.join(String.raw`D:\Windows`, "System32", "where.exe"));
          expect(args).toEqual(["node"]);
          expect(options).toEqual({
            encoding: "utf8",
            env: { SystemRoot: String.raw`D:\Windows` },
            timeoutMs: 5_000,
          });
          return {
            stdout: String.raw`D:\nodejs\node.exe` + "\r\n",
            stderr: "",
          };
        },
      }),
    ).resolves.toBe(String.raw`D:\nodejs\node.exe`);
  });

  it("fails after the lookup timeout when the PATH probe stalls", async () => {
    vi.useFakeTimers();
    runExecMock.mockImplementationOnce(
      (_file: string, _args: string[], options: { timeoutMs: number }): Promise<never> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("timed out")), options.timeoutMs);
        }),
    );

    const lookup = resolveQaNodeExecPath({
      execPath: "/opt/homebrew/bin/bun",
      platform: "darwin",
      versions: { ...process.versions, bun: "1.2.3" },
    });
    const rejection = lookup.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(rejection).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("Node not found in PATH") }),
    );
    expect(runExecMock).toHaveBeenCalledWith("which", ["node"], {
      baseEnv: undefined,
      logOutput: false,
      timeoutMs: 5_000,
    });
  });

  it("throws a clear error when node is unavailable", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
        execFileImpl: async () => {
          throw new Error("missing");
        },
      }),
    ).rejects.toThrow("Node not found in PATH");
  });
});
