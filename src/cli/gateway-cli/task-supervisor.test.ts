import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
  WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE,
} from "../../daemon/windows-task-supervisor-contract.js";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));

describe("Windows Gateway task supervisor", () => {
  const argv = [...process.argv];
  const execArgv = [...process.execArgv];

  afterEach(() => {
    process.argv = [...argv];
    process.execArgv = [...execArgv];
    vi.restoreAllMocks();
    spawn.mockReset();
  });

  it("runs the Gateway child through the anchored Job Object and waits for its tree", async () => {
    const waitForExtinction = vi.fn(async () => {});
    spawn.mockResolvedValue({
      cancel: vi.fn(),
      wait: async () => ({ exitCode: 0, exitSignal: null }),
      waitForExtinction,
    });
    process.argv = [
      process.execPath,
      "C:\\OpenClaw\\dist\\entry.js",
      "gateway",
      "--task-supervisor",
    ];
    process.execArgv = ["--import", "tsx"];
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "anchored-shell",
        command: expect.stringContaining("gateway"),
        scopeKey: `gateway-task-supervisor:${process.pid}`,
        captureOutput: false,
      }),
    );
    expect(spawn.mock.calls[0]?.[0].command).not.toMatch(/"--task-supervisor"(?:\s|$)/u);
    expect(spawn.mock.calls[0]?.[0].command).toContain(WINDOWS_TASK_SUPERVISOR_CHILD_FLAG);
    expect(spawn.mock.calls[0]?.[0].command).toContain("--import");
    expect(spawn.mock.calls[0]?.[0].command).toContain("tsx");
    expect(waitForExtinction).toHaveBeenCalledOnce();
  });

  it("replaces only a child that requests an ordinary Gateway restart", async () => {
    const firstExtinction = vi.fn(async () => {});
    const secondExtinction = vi.fn(async () => {});
    spawn
      .mockResolvedValueOnce({
        cancel: vi.fn(),
        wait: async () => ({
          exitCode: WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE,
          exitSignal: null,
        }),
        waitForExtinction: firstExtinction,
      })
      .mockResolvedValueOnce({
        cancel: vi.fn(),
        wait: async () => ({ exitCode: 0, exitSignal: null }),
        waitForExtinction: secondExtinction,
      });
    process.argv = [
      process.execPath,
      "C:\\OpenClaw\\dist\\entry.js",
      "gateway",
      "--task-supervisor",
    ];
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    await runWindowsGatewayTaskSupervisor();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstExtinction).toHaveBeenCalledOnce();
    expect(secondExtinction).toHaveBeenCalledOnce();
    expect(process.exitCode).not.toBe(WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE);
  });

  it("cancels a child when shutdown arrives while spawn is pending", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const pendingSpawn = new Promise((resolve) => {
      resolveSpawn = resolve;
    });
    const cancel = vi.fn();
    let shutdown: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGTERM") {
        shutdown = listener;
      }
      return process;
    }) as typeof process.once);
    spawn.mockReturnValue(pendingSpawn);
    process.argv = [
      process.execPath,
      "C:\\OpenClaw\\dist\\entry.js",
      "gateway",
      "--task-supervisor",
    ];
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const { runWindowsGatewayTaskSupervisor } = await import("./task-supervisor.js");
    const running = runWindowsGatewayTaskSupervisor();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    shutdown?.();
    resolveSpawn?.({
      cancel,
      wait: async () => ({ exitCode: 0, exitSignal: null }),
      waitForExtinction: vi.fn(async () => {}),
    });
    await running;

    expect(cancel).toHaveBeenCalledOnce();
  });
});
