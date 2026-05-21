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

vi.mock("../runtime.js", () => {
  loaded.mark("default-runtime");
  return {
    defaultRuntime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
      writeJson: vi.fn(),
      writeStdout: vi.fn(),
    },
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

vi.mock("../commands/configure.commands.js", () => {
  loaded.mark("configure-command");
  return { configureCommandFromSectionsArg: vi.fn(async () => {}) };
});

vi.mock("../commands/configure.wizard.js", () => {
  loaded.mark("configure-wizard");
  return { runConfigureWizard: vi.fn(async () => {}) };
});

vi.mock("../commands/onboard.js", () => {
  loaded.mark("onboard-command");
  return { setupWizardCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/setup.js", () => {
  loaded.mark("setup-command");
  return { setupCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/agent-via-gateway.js", () => {
  loaded.mark("agent-via-gateway-command");
  return { agentCliCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/agents.commands.add.js", () => {
  loaded.mark("agents-add-command");
  return { agentsAddCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/agents.commands.bind.js", () => {
  loaded.mark("agents-bind-command");
  return {
    agentsBindingsCommand: vi.fn(async () => {}),
    agentsBindCommand: vi.fn(async () => {}),
    agentsUnbindCommand: vi.fn(async () => {}),
  };
});

vi.mock("../commands/agents.commands.delete.js", () => {
  loaded.mark("agents-delete-command");
  return { agentsDeleteCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/agents.commands.identity.js", () => {
  loaded.mark("agents-identity-command");
  return { agentsSetIdentityCommand: vi.fn(async () => {}) };
});

vi.mock("../commands/agents.commands.list.js", () => {
  loaded.mark("agents-list-command");
  return { agentsListCommand: vi.fn(async () => {}) };
});

vi.mock("@clack/prompts", () => {
  loaded.mark("clack-prompts");
  return {
    confirm: vi.fn(async () => true),
  };
});

vi.mock("../secrets/apply.js", () => {
  loaded.mark("secrets-apply-runtime");
  return {
    runSecretsApply: vi.fn(async () => ({})),
  };
});

vi.mock("../secrets/audit.js", () => {
  loaded.mark("secrets-audit-runtime");
  return {
    resolveSecretsAuditExitCode: vi.fn(() => 0),
    runSecretsAudit: vi.fn(async () => ({})),
  };
});

vi.mock("../secrets/configure.js", () => {
  loaded.mark("secrets-configure-runtime");
  return {
    runSecretsConfigureInteractive: vi.fn(async () => ({})),
  };
});

vi.mock("../secrets/plan.js", () => {
  loaded.mark("secrets-plan-runtime");
  return {
    isSecretsApplyPlan: vi.fn(() => true),
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

  it("keeps configure help out of configure action/wizard modules", async () => {
    const { registerConfigureCommand } = await import("./program/register.configure.js");
    const program = makeProgram();

    registerConfigureCommand(program);
    await expectHelpExit(program, ["configure", "--help"]);

    expect(loaded.modules).not.toContain("configure-command");
    expect(loaded.modules).not.toContain("configure-wizard");
    expect(loaded.modules).not.toContain("default-runtime");
  });

  it("keeps setup help out of setup and onboard action modules", async () => {
    const { registerSetupCommand } = await import("./program/register.setup.js");
    const program = makeProgram();

    registerSetupCommand(program);
    await expectHelpExit(program, ["setup", "--help"]);

    expect(loaded.modules).not.toContain("setup-command");
    expect(loaded.modules).not.toContain("onboard-command");
    expect(loaded.modules).not.toContain("default-runtime");
  });

  it("keeps onboard help out of onboard action modules", async () => {
    const { registerOnboardCommand } = await import("./program/register.onboard.js");
    const program = makeProgram();

    registerOnboardCommand(program);
    await expectHelpExit(program, ["onboard", "--help"]);

    expect(loaded.modules).not.toContain("onboard-command");
    expect(loaded.modules).not.toContain("default-runtime");
  });

  it("keeps agents help out of agent action modules", async () => {
    const { registerAgentCommands } = await import("./program/register.agent.js");
    const program = makeProgram();

    registerAgentCommands(program, { agentChannelOptions: "last|telegram|discord" });
    await expectHelpExit(program, ["agents", "--help"]);

    expect(loaded.modules).not.toContain("agent-via-gateway-command");
    expect(loaded.modules).not.toContain("agents-add-command");
    expect(loaded.modules).not.toContain("agents-bind-command");
    expect(loaded.modules).not.toContain("agents-delete-command");
    expect(loaded.modules).not.toContain("agents-identity-command");
    expect(loaded.modules).not.toContain("agents-list-command");
  });

  it("keeps secrets help out of secrets action modules", async () => {
    const { registerSecretsCli } = await import("./secrets-cli.js");
    const program = makeProgram();

    registerSecretsCli(program);
    await expectHelpExit(program, ["secrets", "--help"]);

    expect(loaded.modules).not.toContain("clack-prompts");
    expect(loaded.modules).not.toContain("secrets-apply-runtime");
    expect(loaded.modules).not.toContain("secrets-audit-runtime");
    expect(loaded.modules).not.toContain("secrets-configure-runtime");
    expect(loaded.modules).not.toContain("secrets-plan-runtime");
  });
});
