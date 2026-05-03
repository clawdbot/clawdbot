import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const detachMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../process/child-process-bridge.js", () => ({
  attachChildProcessBridge: vi.fn(() => ({ detach: detachMock })),
}));

import { launchTuiCli } from "./tui-launch.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];

function createChildProcess(): ChildProcess {
  return new EventEmitter() as ChildProcess;
}

describe("launchTuiCli", () => {
  beforeEach(() => {
    process.argv = [...originalArgv];
    process.argv[1] = "/repo/openclaw.mjs";
    process.execArgv.length = 0;
    spawnMock.mockReset();
    detachMock.mockReset();
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "isPaused").mockReturnValue(false);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.execArgv.length = 0;
    process.execArgv.push(...originalExecArgv);
    vi.restoreAllMocks();
  });

  it("filters inherited inspector flags when relaunching TUI", async () => {
    process.execArgv.push(
      "--import",
      "tsx",
      "--inspect",
      "127.0.0.1:9231",
      "--inspect=127.0.0.1:9229",
      "--inspect-brk",
      "--inspect-wait=0",
      "--inspect-port",
      "9230",
      "--no-warnings",
    );
    const child = createChildProcess();
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await launchTuiCli({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      password: "test-password",
      deliver: false,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        "--import",
        "tsx",
        "--no-warnings",
        "/repo/openclaw.mjs",
        "tui",
        "--url",
        "ws://127.0.0.1:18789",
        "--token",
        "test-token",
        "--password",
        "test-password",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("passes local mode through to the relaunched TUI", async () => {
    const child = createChildProcess();
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await launchTuiCli({ local: true, deliver: false });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/openclaw.mjs", "tui", "--local"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("passes initial message and timeout through to the relaunched TUI", async () => {
    const child = createChildProcess();
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await launchTuiCli({
      local: true,
      deliver: false,
      message: "Wake up, my friend!",
      timeoutMs: 300_000,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        "/repo/openclaw.mjs",
        "tui",
        "--local",
        "--message",
        "Wake up, my friend!",
        "--timeout-ms",
        "300000",
      ],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("launches compiled CLI shapes without repeating the current command", async () => {
    process.argv[1] = "setup";
    const child = createChildProcess();
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await launchTuiCli({ deliver: false });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["tui"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("pins the child gateway URL and config auth source through env without adding url argv", async () => {
    const child = createChildProcess();
    spawnMock.mockImplementation((_cmd: string, _args: string[], _opts: SpawnOptions) => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });

    await launchTuiCli(
      { deliver: false },
      { authSource: "config", gatewayUrl: "ws://127.0.0.1:18789" },
    );

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/openclaw.mjs", "tui"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_TUI_SETUP_AUTH_SOURCE: "config",
        }),
      }),
    );
  });
});
