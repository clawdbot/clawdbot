/** Tests LSP server spawning with Windows shim and sanitized env handling. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

const resolveWindowsSpawnProgramMock = vi.fn();
const materializeWindowsSpawnProgramMock = vi.fn();
const sanitizeHostExecEnvMock = vi.fn();
const spawnMock = vi.fn();

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function spawnServer(config: StdioMcpServerLaunchConfig): void {
  try {
    spawnLspServerProcess(config, {
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

    spawnServer({
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

    spawnServer({ command: "typescript-language-server", args: ["--stdio"] });

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

    spawnServer({ command: "typescript-language-server", args: ["--stdio"] });

    const spawnCall = firstMockCall(spawnMock, "child process spawn");
    expect(spawnCall?.[0]).toBe("cmd.exe");
    expect(spawnCall?.[1]).toEqual(["/c", "typescript-language-server.cmd", "--stdio"]);
    const spawnOptions = spawnCall?.[2] as
      | {
          env?: Record<string, string>;
          stdio?: string[];
          detached?: boolean;
          shell?: boolean;
          windowsHide?: boolean;
        }
      | undefined;
    expect(spawnOptions?.env).toBe(sanitizedEnv);
    expect(spawnOptions?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnOptions?.detached).toBe(process.platform !== "win32");
    expect(spawnOptions?.shell).toBe(true);
    expect(spawnOptions?.windowsHide).toBe(true);
  });
});
