// iMessage tests cover imsg CLI install behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveBrewExecutableMock, runPluginCommandWithTimeoutMock } = vi.hoisted(() => ({
  resolveBrewExecutableMock: vi.fn(),
  runPluginCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return {
    ...actual,
    resolveBrewExecutable: resolveBrewExecutableMock,
  };
});

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runPluginCommandWithTimeoutMock,
}));

const { installIMessageCli } = await import("./install-imsg.js");

describe("installIMessageCli", () => {
  const originalPlatform = process.platform;

  function setProcessPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    vi.clearAllMocks();
  });

  it("installs imsg through Homebrew on macOS", async () => {
    setProcessPlatform("darwin");
    await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
      await fs.mkdir(path.join(brewPrefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(brewPrefix, "bin", "imsg"), "");
      resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
      runPluginCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `${brewPrefix}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "0.13.0\n", stderr: "" });

      const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv);

      expect(result).toEqual({
        ok: true,
        cliPath: path.join(brewPrefix, "bin", "imsg"),
        version: "0.13.0",
      });
      expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(1, {
        argv: ["/opt/homebrew/bin/brew", "install", "steipete/tap/imsg"],
        timeoutMs: 15 * 60_000,
      });
    });
  });

  it("updates imsg through Homebrew when requested", async () => {
    setProcessPlatform("darwin");
    await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
      await fs.mkdir(path.join(brewPrefix, "bin"), { recursive: true });
      await fs.writeFile(path.join(brewPrefix, "bin", "imsg"), "");
      resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
      runPluginCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `${brewPrefix}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "0.13.1\n", stderr: "" });

      const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv, {
        upgrade: true,
      });

      expect(result).toEqual({
        ok: true,
        cliPath: path.join(brewPrefix, "bin", "imsg"),
        version: "0.13.1",
      });
      expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(1, {
        argv: ["/opt/homebrew/bin/brew", "update"],
        timeoutMs: 5 * 60_000,
      });
      expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(2, {
        argv: ["/opt/homebrew/bin/brew", "upgrade", "imsg"],
        timeoutMs: 15 * 60_000,
      });
    });
  });

  it("explains that Homebrew is required when brew is missing", async () => {
    setProcessPlatform("darwin");
    resolveBrewExecutableMock.mockReturnValue(null);

    const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Homebrew is required for imsg setup");
    expect(runPluginCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("does not auto-install imsg on non-macOS hosts", async () => {
    setProcessPlatform("linux");

    const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv);

    expect(result).toEqual({
      ok: false,
      error: "imsg auto-install is supported only on macOS.",
    });
    expect(resolveBrewExecutableMock).not.toHaveBeenCalled();
  });
});
