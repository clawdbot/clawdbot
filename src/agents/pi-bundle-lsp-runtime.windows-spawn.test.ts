import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawnLspServerProcess } from "./pi-bundle-lsp-runtime.js";

const resolveWindowsSpawnProgramMock = vi.hoisted(() => vi.fn());
const materializeWindowsSpawnProgramMock = vi.hoisted(() => vi.fn());
const sanitizeHostExecEnvMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/windows-spawn.js", () => ({
  resolveWindowsSpawnProgram: resolveWindowsSpawnProgramMock,
  materializeWindowsSpawnProgram: materializeWindowsSpawnProgramMock,
}));

vi.mock("../infra/host-env-security.js", () => ({
  sanitizeHostExecEnv: sanitizeHostExecEnvMock,
}));

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

vi.mock("../logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: vi.fn(),
}));

vi.mock("./embedded-pi-lsp.js", () => ({
  loadEmbeddedPiLspConfig: vi.fn().mockReturnValue({ lspServers: {}, diagnostics: [] }),
}));

const FAKE_CHILD = {
  stdout: { setEncoding: vi.fn(), on: vi.fn() },
  stderr: { setEncoding: vi.fn(), on: vi.fn() },
  on: vi.fn(),
  pid: 1234,
} as unknown as import("node:child_process").ChildProcess;

describe("spawnLspServerProcess Windows .cmd shim handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReturnValue(FAKE_CHILD);
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

    spawnLspServerProcess({
      command: "typescript-language-server",
      args: ["--stdio"],
      env: configEnv,
    });

    // Must use structured params so config.env entries are not dropped
    const sanitizeParams = sanitizeHostExecEnvMock.mock.calls.at(0)?.[0] as
      | { baseEnv?: NodeJS.ProcessEnv; overrides?: Record<string, string> }
      | undefined;
    expect(sanitizeParams?.baseEnv).toBe(process.env);
    expect(sanitizeParams?.overrides).toBe(configEnv);
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

    spawnLspServerProcess({ command: "typescript-language-server", args: ["--stdio"] });

    const resolveParams = resolveWindowsSpawnProgramMock.mock.calls.at(0)?.[0] as
      | { env?: Record<string, string>; allowShellFallback?: boolean }
      | undefined;
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

    spawnLspServerProcess({ command: "typescript-language-server", args: ["--stdio"] });

    const spawnCall = spawnMock.mock.calls.at(0);
    expect(spawnCall?.[0]).toBe("cmd.exe");
    expect(spawnCall?.[1]).toEqual(["/c", "typescript-language-server.cmd", "--stdio"]);
    const spawnOptions = spawnCall?.[2] as
      | { env?: Record<string, string>; shell?: boolean; windowsHide?: boolean }
      | undefined;
    expect(spawnOptions?.env).toBe(sanitizedEnv);
    expect(spawnOptions?.shell).toBe(true);
    expect(spawnOptions?.windowsHide).toBe(true);
  });
});
