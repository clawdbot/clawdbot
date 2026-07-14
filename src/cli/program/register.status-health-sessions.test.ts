// Register status/health/session tests cover status-related command registration.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  statusCommand: vi.fn(),
  healthCommand: vi.fn(),
  readyCommand: vi.fn(),
  sessionsCommand: vi.fn(),
  sessionsCleanupCommand: vi.fn(),
  sessionsTailCommand: vi.fn(),
  sessionsCompactCommand: vi.fn(),
  exportTrajectoryCommand: vi.fn(),
  commitmentsListCommand: vi.fn(),
  commitmentsDismissCommand: vi.fn(),
  tasksListCommand: vi.fn(),
  tasksAuditCommand: vi.fn(),
  tasksMaintenanceCommand: vi.fn(),
  tasksShowCommand: vi.fn(),
  tasksNotifyCommand: vi.fn(),
  tasksCancelCommand: vi.fn(),
  flowsListCommand: vi.fn(),
  flowsShowCommand: vi.fn(),
  flowsCancelCommand: vi.fn(),
  setVerbose: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const statusCommand = mocks.statusCommand;
const healthCommand = mocks.healthCommand;
const readyCommand = mocks.readyCommand;
const sessionsCommand = mocks.sessionsCommand;
const sessionsCleanupCommand = mocks.sessionsCleanupCommand;
const sessionsTailCommand = mocks.sessionsTailCommand;
const sessionsCompactCommand = mocks.sessionsCompactCommand;
const exportTrajectoryCommand = mocks.exportTrajectoryCommand;
const commitmentsListCommand = mocks.commitmentsListCommand;
const commitmentsDismissCommand = mocks.commitmentsDismissCommand;
const tasksListCommand = mocks.tasksListCommand;
const tasksAuditCommand = mocks.tasksAuditCommand;
const tasksMaintenanceCommand = mocks.tasksMaintenanceCommand;
const tasksShowCommand = mocks.tasksShowCommand;
const tasksNotifyCommand = mocks.tasksNotifyCommand;
const tasksCancelCommand = mocks.tasksCancelCommand;
const flowsListCommand = mocks.flowsListCommand;
const flowsShowCommand = mocks.flowsShowCommand;
const flowsCancelCommand = mocks.flowsCancelCommand;
const setVerbose = mocks.setVerbose;
const runtime = mocks.runtime;

type MockCalls = {
  mock: { calls: unknown[][] };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectCommandOptions(command: MockCalls, expected: Record<string, unknown>) {
  expect(command.mock.calls).toHaveLength(1);
  const call = command.mock.calls[0];
  if (!call) {
    throw new Error("expected command call");
  }
  const [options, actualRuntime] = call;
  expect(actualRuntime).toBe(runtime);
  const optionsRecord = requireRecord(options, "command options");
  for (const [key, value] of Object.entries(expected)) {
    expect(optionsRecord[key], key).toEqual(value);
  }
  return optionsRecord;
}

vi.mock("../../commands/status.js", () => ({
  statusCommand: mocks.statusCommand,
}));

vi.mock("../../commands/health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

vi.mock("../../commands/ready.js", () => ({
  readyCommand: mocks.readyCommand,
}));

vi.mock("../../commands/sessions.js", () => ({
  sessionsCommand: mocks.sessionsCommand,
}));

vi.mock("../../commands/sessions-cleanup.js", () => ({
  sessionsCleanupCommand: mocks.sessionsCleanupCommand,
}));

vi.mock("../../commands/sessions-tail.js", () => ({
  sessionsTailCommand: mocks.sessionsTailCommand,
}));

vi.mock("../../commands/sessions-compact.js", () => ({
  sessionsCompactCommand: mocks.sessionsCompactCommand,
}));

vi.mock("../../commands/export-trajectory.js", () => ({
  exportTrajectoryCommand: mocks.exportTrajectoryCommand,
}));

vi.mock("../../commands/commitments.js", () => ({
  commitmentsListCommand: mocks.commitmentsListCommand,
  commitmentsDismissCommand: mocks.commitmentsDismissCommand,
}));

vi.mock("../../commands/tasks.js", () => ({
  tasksListCommand: mocks.tasksListCommand,
  tasksAuditCommand: mocks.tasksAuditCommand,
  tasksMaintenanceCommand: mocks.tasksMaintenanceCommand,
  tasksShowCommand: mocks.tasksShowCommand,
  tasksNotifyCommand: mocks.tasksNotifyCommand,
  tasksCancelCommand: mocks.tasksCancelCommand,
}));

vi.mock("../../commands/flows.js", () => ({
  flowsListCommand: mocks.flowsListCommand,
  flowsShowCommand: mocks.flowsShowCommand,
  flowsCancelCommand: mocks.flowsCancelCommand,
}));

vi.mock("../../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerStatusHealthSessionsCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    statusCommand.mockResolvedValue(undefined);
    healthCommand.mockResolvedValue(undefined);
    readyCommand.mockResolvedValue(undefined);
    sessionsCommand.mockResolvedValue(undefined);
    sessionsCleanupCommand.mockResolvedValue(undefined);
    sessionsTailCommand.mockResolvedValue(undefined);
    sessionsCompactCommand.mockResolvedValue(undefined);
    exportTrajectoryCommand.mockResolvedValue(undefined);
    commitmentsListCommand.mockResolvedValue(undefined);
    commitmentsDismissCommand.mockResolvedValue(undefined);
    tasksListCommand.mockResolvedValue(undefined);
    tasksAuditCommand.mockResolvedValue(undefined);
    tasksMaintenanceCommand.mockResolvedValue(undefined);
    tasksShowCommand.mockResolvedValue(undefined);
    tasksNotifyCommand.mockResolvedValue(undefined);
    tasksCancelCommand.mockResolvedValue(undefined);
    flowsListCommand.mockResolvedValue(undefined);
    flowsShowCommand.mockResolvedValue(undefined);
    flowsCancelCommand.mockResolvedValue(undefined);
  });

  it("runs status command with timeout and debug-derived verbose", async () => {
    await runCli([
      "status",
      "--json",
      "--all",
      "--deep",
      "--usage",
      "--debug",
      "--timeout",
      "5000",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expectCommandOptions(statusCommand, {
      json: true,
      all: true,
      deep: true,
      usage: true,
      timeoutMs: 5000,
      verbose: true,
    });
  });

  it("rejects invalid status timeout without calling status command", async () => {
    await runCli(["status", "--timeout", "nope"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(statusCommand).not.toHaveBeenCalled();
  });

  it("runs health command with parsed timeout", async () => {
    await runCli(["health", "--json", "--timeout", "2500", "--verbose"]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expectCommandOptions(healthCommand, {
      json: true,
      timeoutMs: 2500,
      verbose: true,
    });
  });

  it("rejects invalid health timeout without calling health command", async () => {
    await runCli(["health", "--timeout", "0"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(healthCommand).not.toHaveBeenCalled();
  });

  it("runs ready command with JSON and parsed timeout", async () => {
    await runCli(["ready", "--json", "--timeout", "2500"]);
    expectCommandOptions(readyCommand, { json: true, timeoutMs: 2500 });
  });

  it("rejects invalid ready timeout without calling ready command", async () => {
    await runCli(["ready", "--timeout", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds)",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(readyCommand).not.toHaveBeenCalled();
  });

  it("runs sessions command with forwarded options", async () => {
    await runCli([
      "sessions",
      "--json",
      "--verbose",
      "--store",
      "/tmp/sessions.json",
      "--active",
      "120",
      "--limit",
      "25",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expectCommandOptions(sessionsCommand, {
      json: true,
      store: "/tmp/sessions.json",
      active: "120",
      limit: "25",
    });
  });

  it("runs sessions command with --agent forwarding", async () => {
    await runCli(["sessions", "--agent", "work"]);

    expectCommandOptions(sessionsCommand, {
      agent: "work",
      allAgents: false,
    });
  });

  it("runs sessions command with --all-agents forwarding", async () => {
    await runCli(["sessions", "--all-agents"]);

    expectCommandOptions(sessionsCommand, {
      allAgents: true,
    });
  });

  it("dispatches sessions list as an alias for bare sessions (regression for #81139)", async () => {
    await runCli(["sessions", "list"]);

    expect(sessionsCommand).toHaveBeenCalledTimes(1);
    expectCommandOptions(sessionsCommand, {
      json: false,
      allAgents: false,
      agent: undefined,
      store: undefined,
    });
  });

  it("forwards sessions parent options through the list alias", async () => {
    await runCli([
      "sessions",
      "--json",
      "--verbose",
      "--store",
      "/tmp/sessions.json",
      "--agent",
      "work",
      "--all-agents",
      "--active",
      "120",
      "--limit",
      "25",
      "list",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expectCommandOptions(sessionsCommand, {
      json: true,
      store: "/tmp/sessions.json",
      agent: "work",
      allAgents: true,
      active: "120",
      limit: "25",
    });
  });

  it("inherits the parent sessions --agent for compact (regression #91378: wrong-agent compaction)", async () => {
    await runCli(["sessions", "--agent", "work", "compact", "agent:work:main"]);

    expectCommandOptions(sessionsCompactCommand, {
      key: "agent:work:main",
      agent: "work",
    });
  });

  it("inherits the parent sessions --json for compact", async () => {
    await runCli(["sessions", "--json", "compact", "agent:work:main"]);

    expectCommandOptions(sessionsCompactCommand, {
      key: "agent:work:main",
      json: true,
    });
  });

  it("prefers the compact-level --agent over the parent sessions --agent", async () => {
    await runCli(["sessions", "--agent", "main", "compact", "agent:work:main", "--agent", "work"]);

    expectCommandOptions(sessionsCompactCommand, {
      key: "agent:work:main",
      agent: "work",
    });
  });

  it("rejects an inherited parent --store for compact instead of mutating a different store (regression #91378)", async () => {
    await runCli(["sessions", "--store", "/tmp/other-sessions.json", "compact", "agent:work:main"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--store"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsCompactCommand).not.toHaveBeenCalled();
  });

  it("rejects other unsupported inherited parent list options for compact", async () => {
    await runCli([
      "sessions",
      "--all-agents",
      "--limit",
      "25",
      "--verbose",
      "compact",
      "agent:work:main",
    ]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--all-agents"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--verbose"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsCompactCommand).not.toHaveBeenCalled();
  });

  it("forwards sessions list-side options", async () => {
    await runCli([
      "sessions",
      "list",
      "--json",
      "--verbose",
      "--store",
      "/tmp/sessions.json",
      "--agent",
      "work",
      "--all-agents",
      "--active",
      "120",
      "--limit",
      "25",
    ]);

    expect(setVerbose).toHaveBeenCalledWith(true);
    expectCommandOptions(sessionsCommand, {
      json: true,
      store: "/tmp/sessions.json",
      agent: "work",
      allAgents: true,
      active: "120",
      limit: "25",
    });
  });

  it("runs sessions cleanup subcommand with forwarded options", async () => {
    await runCli([
      "sessions",
      "cleanup",
      "--store",
      "/tmp/sessions.json",
      "--dry-run",
      "--enforce",
      "--fix-missing",
      "--fix-dm-scope",
      "--active-key",
      "agent:main:main",
      "--json",
    ]);

    expectCommandOptions(sessionsCleanupCommand, {
      store: "/tmp/sessions.json",
      agent: undefined,
      allAgents: false,
      dryRun: true,
      enforce: true,
      fixMissing: true,
      fixDmScope: true,
      activeKey: "agent:main:main",
      json: true,
    });
  });

  it("forwards parent-level all-agents to cleanup subcommand", async () => {
    await runCli(["sessions", "--all-agents", "cleanup", "--dry-run"]);

    expectCommandOptions(sessionsCleanupCommand, {
      allAgents: true,
    });
  });

  it("runs sessions tail with forwarded progress options", async () => {
    await runCli([
      "sessions",
      "--store",
      "/tmp/sessions.json",
      "--agent",
      "work",
      "tail",
      "--session-key",
      "agent:main:telegram:direct:owner",
      "--tail",
      "5",
      "--follow",
    ]);

    expectCommandOptions(sessionsTailCommand, {
      sessionKey: "agent:main:telegram:direct:owner",
      store: "/tmp/sessions.json",
      agent: "work",
      allAgents: false,
      follow: true,
      tail: "5",
    });
  });

  it("runs sessions export-trajectory with owner-routable export options", async () => {
    await runCli([
      "sessions",
      "--store",
      "/tmp/sessions.json",
      "export-trajectory",
      "--session-key",
      "agent:main:telegram:direct:owner",
      "--workspace",
      "/workspace",
      "--output",
      "bug-123",
      "--json",
    ]);

    expectCommandOptions(exportTrajectoryCommand, {
      sessionKey: "agent:main:telegram:direct:owner",
      output: "bug-123",
      workspace: "/workspace",
      store: "/tmp/sessions.json",
      json: true,
    });
  });

  it("forwards encoded sessions export-trajectory requests", async () => {
    await runCli([
      "sessions",
      "export-trajectory",
      "--request-json-base64",
      "eyJzZXNzaW9uS2V5IjoiYWdlbnQ6bWFpbjp0ZWxlZ3JhbTpkaXJlY3Q6b3duZXIifQ",
      "--json",
    ]);

    expectCommandOptions(exportTrajectoryCommand, {
      requestJsonBase64: "eyJzZXNzaW9uS2V5IjoiYWdlbnQ6bWFpbjp0ZWxlZ3JhbTpkaXJlY3Q6b3duZXIifQ",
      json: true,
    });
  });

  it("runs tasks list from the parent command", async () => {
    await runCli(["tasks", "--json", "--runtime", "acp", "--status", "running"]);

    expectCommandOptions(tasksListCommand, {
      json: true,
      runtime: "acp",
      status: "running",
    });
  });

  it("runs tasks show subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "show", "run-123", "--json"]);

    expectCommandOptions(tasksShowCommand, {
      lookup: "run-123",
      json: true,
    });
  });

  it("runs tasks maintenance subcommand with apply forwarding", async () => {
    await runCli(["tasks", "--json", "maintenance", "--apply"]);

    expectCommandOptions(tasksMaintenanceCommand, {
      json: true,
      apply: true,
    });
  });

  it("runs tasks audit subcommand with filters", async () => {
    await runCli([
      "tasks",
      "--json",
      "audit",
      "--severity",
      "error",
      "--code",
      "stale_running",
      "--limit",
      "5",
    ]);

    expectCommandOptions(tasksAuditCommand, {
      json: true,
      severity: "error",
      code: "stale_running",
      limit: 5,
    });
  });

  it("rejects partially numeric tasks audit limits", async () => {
    await runCli(["tasks", "--json", "audit", "--limit", "5abc"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--limit must be a positive integer, for example --limit 25.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(tasksAuditCommand).not.toHaveBeenCalled();
  });

  it("routes tasks flow commands through the TaskFlow handlers", async () => {
    await runCli(["tasks", "flow", "list", "--json", "--status", "blocked"]);
    expectCommandOptions(flowsListCommand, {});

    await runCli(["tasks", "flow", "show", "flow-123", "--json"]);
    expectCommandOptions(flowsShowCommand, {
      lookup: "flow-123",
    });

    await runCli(["tasks", "flow", "cancel", "flow-123"]);
    expectCommandOptions(flowsCancelCommand, {
      lookup: "flow-123",
    });
  });

  it("runs tasks notify subcommand with lookup and policy forwarding", async () => {
    await runCli(["tasks", "notify", "run-123", "state_changes"]);

    expectCommandOptions(tasksNotifyCommand, {
      lookup: "run-123",
      notify: "state_changes",
    });
  });

  it("runs tasks cancel subcommand with lookup forwarding", async () => {
    await runCli(["tasks", "cancel", "run-123"]);

    expectCommandOptions(tasksCancelCommand, {
      lookup: "run-123",
    });
  });

  it("runs commitments list with filters", async () => {
    await runCli(["commitments", "--json", "--agent", "work", "--status", "snoozed"]);

    expectCommandOptions(commitmentsListCommand, {
      json: true,
      agent: "work",
      status: "snoozed",
      all: false,
    });
  });

  it("runs commitments dismiss with id forwarding", async () => {
    await runCli(["commitments", "dismiss", "cm_1", "cm_2"]);

    expectCommandOptions(commitmentsDismissCommand, {
      ids: ["cm_1", "cm_2"],
    });
  });

  it("does not register the legacy top-level flows command", () => {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);

    expect(program.commands.find((command) => command.name() === "flows")).toBeUndefined();
  });
});
