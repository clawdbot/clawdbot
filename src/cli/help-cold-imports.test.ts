import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    mark(name: string) {
      modules.add(name);
    },
  };
});

vi.mock("./gateway-cli/run.js", () => {
  loaded.mark("gateway-run-runtime");
  return {
    resolveGatewayRunOptions: vi.fn((opts) => opts),
    runGatewayCommand: vi.fn(async () => {}),
  };
});

vi.mock("./gateway-cli/call.js", () => {
  loaded.mark("gateway-call-runtime");
  return {
    callGatewayCli: vi.fn(async () => ({})),
  };
});

vi.mock("../gateway/call.js", () => {
  loaded.mark("gateway-transport-runtime");
  return {
    formatGatewayTransportErrorJson: vi.fn(() => null),
  };
});

vi.mock("./progress.js", () => {
  loaded.mark("cli-progress-runtime");
  return {
    withProgress: vi.fn(async (_opts, run) => await run({})),
  };
});

vi.mock("../commands/doctor.js", () => {
  loaded.mark("doctor-command");
  return { doctorCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/dashboard.js", () => {
  loaded.mark("dashboard-command");
  return { dashboardCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/reset.js", () => {
  loaded.mark("reset-command");
  return { resetCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/uninstall.js", () => {
  loaded.mark("uninstall-command");
  return { uninstallCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/status.js", () => {
  loaded.mark("status-command");
  return { statusCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/health.js", () => {
  loaded.mark("health-command");
  return {
    formatHealthChannelLines: vi.fn(() => []),
    healthCommand: vi.fn(async () => {}),
  };
});

vi.mock("../commands/sessions.js", () => {
  loaded.mark("sessions-command");
  return { sessionsCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/sessions-cleanup.js", () => {
  loaded.mark("sessions-cleanup-command");
  return { sessionsCleanupCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/export-trajectory.js", () => {
  loaded.mark("export-trajectory-command");
  return { exportTrajectoryCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/commitments.js", () => {
  loaded.mark("commitments-command");
  return {
    commitmentsDismissCommand: vi.fn(async () => {}),
    commitmentsListCommand: vi.fn(async () => {}),
  };
});

vi.mock("../commands/tasks.js", () => {
  loaded.mark("tasks-command");
  return {
    tasksAuditCommand: vi.fn(async () => {}),
    tasksCancelCommand: vi.fn(async () => {}),
    tasksListCommand: vi.fn(async () => {}),
    tasksMaintenanceCommand: vi.fn(async () => {}),
    tasksNotifyCommand: vi.fn(async () => {}),
    tasksShowCommand: vi.fn(async () => {}),
  };
});

vi.mock("../commands/flows.js", () => {
  loaded.mark("flows-command");
  return {
    flowsCancelCommand: vi.fn(async () => {}),
    flowsListCommand: vi.fn(async () => {}),
    flowsShowCommand: vi.fn(async () => {}),
  };
});

function makeProgram(): Command {
  const program = new Command();
  program.name("openclaw");
  program.exitOverride();
  return program;
}

async function expectHelpExit(program: Command, argv: string[]): Promise<void> {
  await expect(program.parseAsync(argv, { from: "user" })).rejects.toMatchObject({
    exitCode: 0,
  });
}

describe("subcommand help cold imports", () => {
  beforeEach(() => {
    vi.resetModules();
    loaded.modules.clear();
  });

  it("keeps gateway help out of gateway action/runtime modules", async () => {
    const { registerGatewayCli } = await import("./gateway-cli/register.js");
    const program = makeProgram();

    registerGatewayCli(program);
    await expectHelpExit(program, ["gateway", "--help"]);

    expect(loaded.modules).not.toContain("gateway-run-runtime");
    expect(loaded.modules).not.toContain("gateway-call-runtime");
    expect(loaded.modules).not.toContain("gateway-transport-runtime");
    expect(loaded.modules).not.toContain("cli-progress-runtime");
  });

  it("keeps maintenance help out of command action modules", async () => {
    const { registerMaintenanceCommands } = await import("./program/register.maintenance.js");
    const program = makeProgram();

    registerMaintenanceCommands(program);
    await expectHelpExit(program, ["doctor", "--help"]);

    expect(loaded.modules).not.toContain("doctor-command");
    expect(loaded.modules).not.toContain("dashboard-command");
    expect(loaded.modules).not.toContain("reset-command");
    expect(loaded.modules).not.toContain("uninstall-command");
  });

  it("keeps status and health help out of command action modules", async () => {
    const { registerStatusHealthSessionsCommands } =
      await import("./program/register.status-health-sessions.js");
    const program = makeProgram();

    registerStatusHealthSessionsCommands(program);
    await expectHelpExit(program, ["status", "--help"]);
    await expectHelpExit(program, ["health", "--help"]);

    expect(loaded.modules).not.toContain("status-command");
    expect(loaded.modules).not.toContain("health-command");
    expect(loaded.modules).not.toContain("sessions-command");
    expect(loaded.modules).not.toContain("sessions-cleanup-command");
    expect(loaded.modules).not.toContain("export-trajectory-command");
    expect(loaded.modules).not.toContain("commitments-command");
    expect(loaded.modules).not.toContain("tasks-command");
    expect(loaded.modules).not.toContain("flows-command");
  });
});
