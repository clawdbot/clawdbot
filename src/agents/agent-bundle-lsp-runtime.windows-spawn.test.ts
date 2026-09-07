/** Tests LSP server spawning with Windows shim and sanitized env handling. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
  type WindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess } from "../process/owned-stdio.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";

const resolveWindowsSpawnProgramMock = vi.fn<typeof resolveWindowsSpawnProgram>();
const sanitizeHostExecEnvMock = vi.fn<typeof sanitizeHostExecEnv>();
const spawnMock = vi.fn<typeof createOwnedStdioProcess>();
const { spawnWithFallbackMock } = vi.hoisted(() => ({ spawnWithFallbackMock: vi.fn() }));

vi.mock("../process/spawn-utils.js", () => ({ spawnWithFallback: spawnWithFallbackMock }));

describe("spawnLspServerProcess Windows .cmd shim handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockRejectedValue(new Error("stop after spawn"));
    spawnWithFallbackMock.mockRejectedValue(new Error("captured Windows spawn"));
  });

  const directProgram: WindowsSpawnProgram = {
    command: "typescript-language-server",
    leadingArgv: [],
    resolution: "direct",
    shell: false,
    windowsHide: true,
  };

  it.each<{
    name: string;
    configEnv?: Record<string, string>;
    sanitizedEnv: Record<string, string>;
    program: WindowsSpawnProgram;
    expectedArgv: string[];
  }>([
    {
      name: "calls sanitizeHostExecEnv with baseEnv/overrides, not a flat merged object",
      configEnv: { MY_TOKEN: "secret", TOOL_PATH: "/custom" },
      sanitizedEnv: { PATH: "/usr/bin", MY_TOKEN: "secret", TOOL_PATH: "/custom" },
      program: directProgram,
      expectedArgv: ["typescript-language-server", "--stdio"],
    },
    {
      name: "passes sanitized env to resolveWindowsSpawnProgram",
      sanitizedEnv: { PATH: "C:\\Windows;C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      program: directProgram,
      expectedArgv: ["typescript-language-server", "--stdio"],
    },
    {
      name: "passes materialized invocation to spawn with the sanitized env",
      sanitizedEnv: { PATH: "/usr/bin" },
      program: {
        command: "cmd.exe",
        leadingArgv: ["/c", "typescript-language-server.cmd"],
        resolution: "shell-fallback",
        shell: true,
        windowsHide: true,
      },
      expectedArgv: ["cmd.exe", "/c", "typescript-language-server.cmd", "--stdio"],
    },
  ])("$name", async ({ configEnv, sanitizedEnv, program, expectedArgv }) => {
    sanitizeHostExecEnvMock.mockReturnValue(sanitizedEnv);
    resolveWindowsSpawnProgramMock.mockReturnValue(program);

    await expect(
      spawnLspServerProcess(
        {
          command: "typescript-language-server",
          args: ["--stdio"],
          ...(configEnv ? { env: configEnv } : {}),
        },
        {
          resolveWindowsSpawnProgram: resolveWindowsSpawnProgramMock,
          materializeWindowsSpawnProgram,
          sanitizeHostExecEnv: sanitizeHostExecEnvMock,
          spawn: spawnMock,
        },
      ),
    ).rejects.toThrow("stop after spawn");

    const sanitizeParams = sanitizeHostExecEnvMock.mock.calls[0]?.[0];
    expect(sanitizeParams?.baseEnv).toBe(process.env);
    if (configEnv) {
      expect(sanitizeParams?.overrides).toStrictEqual(configEnv);
    }
    const resolveParams = resolveWindowsSpawnProgramMock.mock.calls[0]?.[0];
    expect(resolveParams?.env).toBe(sanitizedEnv);
    expect(resolveParams?.allowShellFallback).toBe(true);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith({
      argv: expectedArgv,
      env: sanitizedEnv,
      exactEnv: true,
      cwd: undefined,
      ...(program.shell ? { windowsShell: true } : {}),
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
