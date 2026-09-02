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

  it("updates imsg when its Homebrew formula is installed", async () => {
    setProcessPlatform("darwin");
    await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
      const cellar = path.join(brewPrefix, "Cellar");
      const formulaCliPath = path.join(cellar, "imsg", "0.13.1", "bin", "imsg");
      const cliPath = path.join(brewPrefix, "bin", "imsg");
      await fs.mkdir(path.dirname(formulaCliPath), { recursive: true });
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.writeFile(formulaCliPath, "");
      await fs.symlink(formulaCliPath, cliPath);
      resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
      runPluginCommandWithTimeoutMock
        .mockResolvedValueOnce({
          code: 0,
          stdout: "steipete/tap/imsg\n",
          stderr: "",
        })
        .mockResolvedValueOnce({ code: 0, stdout: `${cliPath}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `${cellar}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `${brewPrefix}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "0.13.1\n", stderr: "" });

      const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv, {
        upgrade: true,
      });

      expect(result).toEqual({
        ok: true,
        cliPath,
        version: "0.13.1",
      });
      expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(4, {
        argv: ["/opt/homebrew/bin/brew", "update"],
        timeoutMs: 5 * 60_000,
      });
      expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(5, {
        argv: ["/opt/homebrew/bin/brew", "upgrade", "imsg"],
        timeoutMs: 15 * 60_000,
      });
    });
  });

  it("preserves detected imsg when Homebrew does not own it", async () => {
    setProcessPlatform("darwin");
    resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
    runPluginCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "wget\n",
      stderr: "",
    });

    const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv, {
      upgrade: true,
    });

    expect(result).toEqual({ ok: true });
    expect(runPluginCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(runPluginCommandWithTimeoutMock).toHaveBeenCalledWith({
      argv: ["/opt/homebrew/bin/brew", "list", "--formula", "--full-name"],
      timeoutMs: 10_000,
    });
  });

  it("preserves a PATH imsg that shadows an installed Homebrew formula", async () => {
    setProcessPlatform("darwin");
    await withTempDir("openclaw-imsg-shadow-", async (tmpDir) => {
      const cliPath = path.join(tmpDir, "local", "bin", "imsg");
      const cellar = path.join(tmpDir, "Cellar");
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.writeFile(cliPath, "");
      await fs.mkdir(path.join(cellar, "imsg"), { recursive: true });
      resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
      runPluginCommandWithTimeoutMock
        .mockResolvedValueOnce({
          code: 0,
          stdout: "steipete/tap/imsg\n",
          stderr: "",
        })
        .mockResolvedValueOnce({ code: 0, stdout: `${cliPath}\n`, stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: `${cellar}\n`, stderr: "" });

      const result = await installIMessageCli({ log: vi.fn() } as unknown as RuntimeEnv, {
        upgrade: true,
      });

      expect(result).toEqual({ ok: true });
      expect(runPluginCommandWithTimeoutMock.mock.calls).not.toContainEqual([
        { argv: ["/opt/homebrew/bin/brew", "update"], timeoutMs: 5 * 60_000 },
      ]);
      expect(runPluginCommandWithTimeoutMock.mock.calls).not.toContainEqual([
        { argv: ["/opt/homebrew/bin/brew", "upgrade", "imsg"], timeoutMs: 15 * 60_000 },
      ]);
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
