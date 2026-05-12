import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { doctorCommand, dashboardCommand, resetCommand, uninstallCommand, runtime } = mocks;

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand: mocks.dashboardCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand: mocks.resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand: mocks.uninstallCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerMaintenanceCommands doctor action", () => {
  async function runMaintenanceCli(args: string[]) {
    const program = new Command();
    registerMaintenanceCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = doctorCommand.mock.calls.at(0)! as unknown as [
      typeof runtime,
      Record<string, unknown>,
    ];
    expect(runtimeArg).toBe(runtime);
    expect(options.nonInteractive).toBe(true);
    expect(options.yes).toBe(true);
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when doctor fails", async () => {
    doctorCommand.mockRejectedValue(new Error("doctor failed"));

    await runMaintenanceCli(["doctor"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });

  it("maps --fix to repair=true", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--fix"]);

    expect(doctorCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = doctorCommand.mock.calls.at(0)! as unknown as [
      typeof runtime,
      Record<string, unknown>,
    ];
    expect(runtimeArg).toBe(runtime);
    expect(options.repair).toBe(true);
  });

  it("passes noOpen to dashboard command", async () => {
    dashboardCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["dashboard", "--no-open"]);

    expect(dashboardCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = dashboardCommand.mock.calls.at(0)! as unknown as [
      typeof runtime,
      Record<string, unknown>,
    ];
    expect(runtimeArg).toBe(runtime);
    expect(options.noOpen).toBe(true);
  });

  it("passes reset options to reset command", async () => {
    resetCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "reset",
      "--scope",
      "full",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(resetCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = resetCommand.mock.calls.at(0)! as unknown as [
      typeof runtime,
      Record<string, unknown>,
    ];
    expect(runtimeArg).toBe(runtime);
    expect(options.scope).toBe("full");
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("passes uninstall options to uninstall command", async () => {
    uninstallCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "uninstall",
      "--service",
      "--state",
      "--workspace",
      "--app",
      "--all",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(uninstallCommand).toHaveBeenCalledTimes(1);
    const [runtimeArg, options] = uninstallCommand.mock.calls.at(0)! as unknown as [
      typeof runtime,
      Record<string, unknown>,
    ];
    expect(runtimeArg).toBe(runtime);
    expect(options.service).toBe(true);
    expect(options.state).toBe(true);
    expect(options.workspace).toBe(true);
    expect(options.app).toBe(true);
    expect(options.all).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.nonInteractive).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it("exits with code 1 when dashboard fails", async () => {
    dashboardCommand.mockRejectedValue(new Error("dashboard failed"));

    await runMaintenanceCli(["dashboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: dashboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
