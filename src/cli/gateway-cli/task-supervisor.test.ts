import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(spawn.mock.calls[0]?.[0].command).not.toContain("--task-supervisor");
    expect(spawn.mock.calls[0]?.[0].command).toContain("--import");
    expect(spawn.mock.calls[0]?.[0].command).toContain("tsx");
    expect(waitForExtinction).toHaveBeenCalledOnce();
  });
});
