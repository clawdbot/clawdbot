/** Tests LSP server spawning with Windows shim and sanitized env handling. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess } from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

const resolveWindowsSpawnProgramMock = vi.fn();
const materializeWindowsSpawnProgramMock = vi.fn();
const sanitizeHostExecEnvMock = vi.fn();
const spawnMock = vi.fn();
const { spawnWithFallbackMock } = vi.hoisted(() => ({ spawnWithFallbackMock: vi.fn() }));

vi.mock("../process/spawn-utils.js", () => ({ spawnWithFallback: spawnWithFallbackMock }));

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

async function spawnServer(config: StdioMcpServerLaunchConfig): Promise<void> {
  try {
    await spawnLspServerProcess(config, {
      resolveWindowsSpawnProgram: resolveWindowsSpawnProgramMock,
      materializeWindowsSpawnProgram: materializeWindowsSpawnProgramMock,
      sanitizeHostExecEnv: sanitizeHostExecEnvMock,
      spawn: spawnMock,
    });
  } catch {
    // The injected spawn deliberately stops after argument capture.
  }
}

describe("spawnLspServerProcess Windows .cmd shim handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockImplementation(() => {
      throw new Error("stop after spawn");
    });
    spawnWithFallbackMock.mockRejectedValue(new Error("captured Windows spawn"));
  });

  it("calls sanitizeHostExecEnv with baseEnv/overrides, not a flat merged object", async () => {
    const configEnv = { MY_TOKEN: "secret", TOOL_PATH: "/custom" };
    const sanitizedEnv = { PATH: "/usr/bin", MY_TOKEN: "secret", TOOL_PATH: "/custom" };

    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);
    resolveWindowsSpawnProgramMock.mockReturnValue({ resolvedCommand: "tls", isShim: false });
    materializeWindowsSpawnProgramMock.mockReturnValue({
      command: "typescript-language-server",
      argv: ["--stdio"],
      shell: false,
      windowsHide: true,
    });

    await spawnServer({
      command: "typescript-language-server",
      args: ["--stdio"],
      env: configEnv,
    });

    // Must use structured params so config.env entries are not dropped
    const sanitizeParams = firstMockCall(sanitizeHostExecEnvMock, "host env sanitization")[0] as
      | { baseEnv?: NodeJS.ProcessEnv; overrides?: Record<string, string> }
      | undefined;
    expect(sanitizeParams?.baseEnv).toBe(process.env);
    expect(sanitizeParams?.overrides).toStrictEqual(configEnv);
  });

  it("passes sanitized env to resolveWindowsSpawnProgram", async () => {
    const sanitizedEnv = { PATH: "C:\\Windows;C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);
    resolveWindowsSpawnProgramMock.mockReturnValue({ resolvedCommand: "tls", isShim: false });
    materializeWindowsSpawnProgramMock.mockReturnValue({
      command: "typescript-language-server",
      argv: ["--stdio"],
      shell: false,
      windowsHide: true,
    });

    await spawnServer({ command: "typescript-language-server", args: ["--stdio"] });

    const resolveParams = firstMockCall(
      resolveWindowsSpawnProgramMock,
      "Windows spawn resolution",
    )[0] as { env?: Record<string, string>; allowShellFallback?: boolean } | undefined;
    expect(resolveParams?.env).toBe(sanitizedEnv);
    expect(resolveParams?.allowShellFallback).toBe(true);
  });

  it("passes materialized invocation to spawn with the sanitized env", async () => {
    const sanitizedEnv = { PATH: "/usr/bin" };

    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);
    resolveWindowsSpawnProgramMock.mockReturnValue({ resolvedCommand: "tls", isShim: true });
    materializeWindowsSpawnProgramMock.mockReturnValue({
      command: "cmd.exe",
      argv: ["/c", "typescript-language-server.cmd", "--stdio"],
      shell: true,
      windowsHide: true,
    });

    await spawnServer({ command: "typescript-language-server", args: ["--stdio"] });

    expect(spawnMock).toHaveBeenCalledExactlyOnceWith({
      argv: ["cmd.exe", "/c", "typescript-language-server.cmd", "--stdio"],
      env: sanitizedEnv,
      exactEnv: true,
      cwd: undefined,
      windowsShell: true,
    });
  });

  it("preserves the shipped Windows shell fallback through the owned adapter", async () => {
    const sanitizedEnv = { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" };
    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);

    await expect(
      withMockedWindowsPlatform(() =>
        spawnLspServerProcess(
          {
            command: "C:\\Program Files\\language-server.cmd",
            args: ["--stdio", "two words", "%LSP_ARGUMENT%", "echo ready & exit /b"],
          },
          {
            sanitizeHostExecEnv: sanitizeHostExecEnvMock,
            resolveWindowsSpawnProgram,
            materializeWindowsSpawnProgram,
            spawn: createOwnedStdioProcess,
          },
        ),
      ),
    ).rejects.toThrow("captured Windows spawn");

    expect(spawnWithFallbackMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        argv: [
          "C:\\Program Files\\language-server.cmd",
          "--stdio",
          "two words",
          "%LSP_ARGUMENT%",
          "echo ready & exit /b",
        ],
        options: expect.objectContaining({
          env: sanitizedEnv,
          shell: true,
          windowsHide: true,
        }),
      }),
    );
  });
});
