import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnInput } from "../../process/supervisor/types.js";

const { spawn, log, flushLogger, bindWindowsTaskLauncher } = vi.hoisted(() => ({
  spawn: vi.fn(),
  log: { info: vi.fn(), error: vi.fn() },
  flushLogger: vi.fn(async () => {}),
  bindWindowsTaskLauncher: vi.fn(),
}));

vi.mock("koffi", () => ({ default: {} }));
vi.mock("../../process/supervisor/service-child-windows-task-launcher.js", () => ({
  bindWindowsTaskLauncher,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => log,
}));

vi.mock("../../logging/logger.js", () => ({ flushLogger }));

vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));

describe("Windows Gateway task supervisor", () => {
  const argv = [...process.argv];
  const execArgv = [...process.execArgv];
  const exitCode = process.exitCode;
  const launcherMarker = process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;

  beforeEach(() => {
    process.argv = [
      process.execPath,
      "C:\\OpenClaw\\dist\\entry.js",
      "gateway",
      "--task-supervisor",
    ];
    process.execArgv = ["--import", "tsx"];
    process.exitCode = undefined;
    delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    process.argv = [...argv];
    process.execArgv = [...execArgv];
    process.exitCode = exitCode;
    if (launcherMarker === undefined) {
      delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
    } else {
      process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = launcherMarker;
    }
    vi.restoreAllMocks();
    vi.clearAllMocks();
    spawn.mockReset();
    bindWindowsTaskLauncher.mockReset();
  });

  it("binds launcher ownership before admitting a child and consumes the launcher marker", async () => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "wscript";
    bindWindowsTaskLauncher.mockImplementation(() => {
      expect(spawn).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
    });
    spawn.mockImplementation(async () => {
      expect(bindWindowsTaskLauncher).toHaveBeenCalledOnce();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
      return { cancel: vi.fn(), wait: async () => ({ exitCode: 0, exitSignal: null }) };
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();
    expect(spawn).toHaveBeenCalledOnce();
    expect(bindWindowsTaskLauncher).toHaveBeenCalledOnce();
  });

  it("does not admit a Gateway after its task launcher has exited", async () => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "wscript";
    spawn.mockResolvedValue({
      cancel: vi.fn(),
      wait: async () => ({ exitCode: 0, exitSignal: null }),
    });
    bindWindowsTaskLauncher.mockImplementation(() => {
      throw new Error("Windows task WScript launcher is no longer live");
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("WScript launcher is no longer live");
    expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
  });

  it("runs the Gateway child through the anchored Job Object and waits for its tree", async () => {
    // A direct Startup fallback inherits the install preference, without a live WScript owner.
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "1";
    const waitForExtinction = vi.fn(async () => {});
    spawn.mockResolvedValue({
      cancel: vi.fn(),
      wait: async () => ({ exitCode: 0, exitSignal: null }),
      waitForExtinction,
    });
    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(bindWindowsTaskLauncher).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anchored-shell",
        command: expect.stringContaining("gateway"),
        scopeKey: `gateway-task-supervisor:${process.pid}`,
        captureOutput: false,
      }),
    );
    expect(spawn.mock.calls[0]?.[0].command).not.toContain("--task-supervisor");
    expect(spawn.mock.calls[0]?.[0].command).toContain("--import");
    expect(spawn.mock.calls[0]?.[0].command).toContain("tsx");
    expect(waitForExtinction).toHaveBeenCalledOnce();
  });

  it.each([
    { exitCode: 23, exitSignal: null, reason: "exit", expectedCode: 23 },
    { exitCode: null, exitSignal: "SIGTERM", reason: "signal", expectedCode: 1 },
    { exitCode: 0, exitSignal: null, reason: "exit", expectedCode: 0 },
  ])("records child result $exitCode/$exitSignal and preserves its task result", async (result) => {
    const stderr = "Gateway failed to bind its configured port\n";
    spawn.mockImplementation(async (input: SpawnInput) => {
      input.onStderr?.(stderr);
      return {
        cancel: vi.fn(),
        wait: async () => result,
        waitForExtinction: async () => {},
      };
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(process.exitCode ?? 0).toBe(result.expectedCode);
    const diagnostic = result.exitCode === 0 ? log.info : log.error;
    expect(diagnostic).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        reason: result.reason,
        stderr,
      }),
    );
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it("retains only a bounded stderr tail and discards stdout", async () => {
    const lastReason = "final startup failure";
    spawn.mockImplementation(async (input: SpawnInput) => {
      expect(input.captureOutput).toBe(false);
      input.onStdout?.("unretained stdout");
      input.onStderr?.("old stderr diagnostic\n");
      input.onStderr?.("x".repeat(8192));
      input.onStderr?.(lastReason);
      return {
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 1, exitSignal: null, reason: "exit" }),
        waitForExtinction: async () => {},
      };
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stderr: expect.stringContaining(lastReason) }),
    );
    const stderr: string = log.error.mock.calls[0]?.[1].stderr;
    expect(stderr.length).toBeLessThanOrEqual(8192);
    expect(stderr).not.toContain("old stderr diagnostic");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("unretained stdout");
  });

  it("records a spawn failure and fails the task", async () => {
    spawn.mockRejectedValue(new Error("synthetic Job Object spawn failure"));

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("synthetic Job Object spawn failure");
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it("preserves the child diagnostic when its tree cleanup fails", async () => {
    const stderr = "synthetic child startup failure";
    spawn.mockImplementation(async (input: SpawnInput) => {
      input.onStderr?.(stderr);
      return {
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 23, exitSignal: null, reason: "exit" }),
        waitForExtinction: async () => {
          expect(log.error).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ exitCode: 23, stderr }),
          );
          throw new Error("synthetic Job Object cleanup failure");
        },
      };
    });

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("synthetic Job Object cleanup failure");
    expect(flushLogger).toHaveBeenCalledOnce();
  });
});
