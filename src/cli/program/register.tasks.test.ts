// Task registration tests exercise the real Commander hierarchy and option sources.
import { Command } from "commander";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../failure-output.js";
import { registerTasksCommand } from "./register.tasks.js";

const mocks = vi.hoisted(() => ({
  tasksListCommand: vi.fn(),
  tasksAuditCommand: vi.fn(),
  tasksMaintenanceCommand: vi.fn(),
  tasksShowCommand: vi.fn(),
  tasksNotifyCommand: vi.fn(),
  tasksCancelCommand: vi.fn(),
  tasksRetryCommand: vi.fn(),
  tasksDismissCommand: vi.fn(),
  flowsListCommand: vi.fn(),
  flowsShowCommand: vi.fn(),
  flowsCancelCommand: vi.fn(),
  tasksModuleLoaded: vi.fn(),
  flowsModuleLoaded: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/tasks.js", () => {
  mocks.tasksModuleLoaded();
  return {
    tasksListCommand: mocks.tasksListCommand,
    tasksAuditCommand: mocks.tasksAuditCommand,
    tasksMaintenanceCommand: mocks.tasksMaintenanceCommand,
    tasksShowCommand: mocks.tasksShowCommand,
    tasksNotifyCommand: mocks.tasksNotifyCommand,
    tasksCancelCommand: mocks.tasksCancelCommand,
    tasksRetryCommand: mocks.tasksRetryCommand,
    tasksDismissCommand: mocks.tasksDismissCommand,
  };
});
vi.mock("../../commands/flows.js", () => {
  mocks.flowsModuleLoaded();
  return {
    flowsListCommand: mocks.flowsListCommand,
    flowsShowCommand: mocks.flowsShowCommand,
    flowsCancelCommand: mocks.flowsCancelCommand,
  };
});
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const ownerHandlers = [
  mocks.tasksListCommand,
  mocks.tasksAuditCommand,
  mocks.tasksMaintenanceCommand,
  mocks.tasksShowCommand,
  mocks.tasksNotifyCommand,
  mocks.tasksCancelCommand,
  mocks.tasksRetryCommand,
  mocks.tasksDismissCommand,
  mocks.flowsListCommand,
  mocks.flowsShowCommand,
  mocks.flowsCancelCommand,
];
const requireRecord = createRequireRecord("object", "expected-label");

function expectCommandOptions(handler: (typeof ownerHandlers)[number], expected: object) {
  expect(handler).toHaveBeenCalledTimes(1);
  const [options, runtime] = handler.mock.calls[0] ?? [];
  expect(runtime).toBe(mocks.runtime);
  expect(requireRecord(options, "command options")).toMatchObject(expected);
}

describe("registerTasksCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command().enablePositionalOptions();
    registerTasksCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    for (const handler of ownerHandlers) {
      handler.mockResolvedValue(undefined);
    }
  });

  it("rejects inherited mutation options before loading task or flow owners", async () => {
    await expect(runCli(["tasks", "--json", "cancel", "task-123"])).rejects.toBeInstanceOf(
      ExpectedCliError,
    );
    expect(mocks.tasksModuleLoaded).not.toHaveBeenCalled();

    await expect(runCli(["tasks", "--json", "flow", "cancel", "flow-123"])).rejects.toBeInstanceOf(
      ExpectedCliError,
    );
    expect(mocks.flowsModuleLoaded).not.toHaveBeenCalled();
  });

  it("runs the bare tasks list with root options", async () => {
    await runCli(["tasks", "--json", "--runtime", "acp", "--status", "running"]);

    expectCommandOptions(mocks.tasksListCommand, {
      json: true,
      runtime: "acp",
      status: "running",
    });
  });

  it("advertises the displayed blocked status on the root and list commands", () => {
    const program = new Command();
    registerTasksCommand(program);
    const tasks = program.commands.find((command) => command.name() === "tasks");
    const list = tasks?.commands.find((command) => command.name() === "list");

    for (const command of [tasks, list]) {
      expect(command?.options.find((option) => option.long === "--status")?.description).toContain(
        "blocked",
      );
    }
  });

  it.each([
    {
      label: "blocked status on the bare task list",
      args: ["tasks", "--status", "blocked"],
      handler: mocks.tasksListCommand,
      expected: { json: false, status: "blocked" },
    },
    {
      label: "blocked status before the task list leaf",
      args: ["tasks", "--status", "blocked", "list"],
      handler: mocks.tasksListCommand,
      expected: { json: false, status: "blocked" },
    },
    {
      label: "blocked status after the task list leaf",
      args: ["tasks", "list", "--status", "blocked"],
      handler: mocks.tasksListCommand,
      expected: { json: false, status: "blocked" },
    },
    {
      label: "task list options before the leaf",
      args: ["tasks", "--json", "--runtime", "acp", "--status", "running", "list"],
      handler: mocks.tasksListCommand,
      expected: { json: true, runtime: "acp", status: "running" },
    },
    {
      label: "task list options after the leaf",
      args: ["tasks", "list", "--json", "--runtime", "acp", "--status", "running"],
      handler: mocks.tasksListCommand,
      expected: { json: true, runtime: "acp", status: "running" },
    },
    {
      label: "task audit JSON before the leaf",
      args: ["tasks", "--json", "audit"],
      handler: mocks.tasksAuditCommand,
      expected: { json: true },
    },
    {
      label: "task audit JSON after the leaf",
      args: ["tasks", "audit", "--json"],
      handler: mocks.tasksAuditCommand,
      expected: { json: true },
    },
    {
      label: "task maintenance JSON before the leaf",
      args: ["tasks", "--json", "maintenance", "--apply"],
      handler: mocks.tasksMaintenanceCommand,
      expected: { json: true, apply: true },
    },
    {
      label: "task maintenance JSON after the leaf",
      args: ["tasks", "maintenance", "--apply", "--json"],
      handler: mocks.tasksMaintenanceCommand,
      expected: { json: true, apply: true },
    },
    {
      label: "task show JSON before the leaf",
      args: ["tasks", "--json", "show", "run-123"],
      handler: mocks.tasksShowCommand,
      expected: { lookup: "run-123", json: true },
    },
    {
      label: "task show JSON after the leaf",
      args: ["tasks", "show", "run-123", "--json"],
      handler: mocks.tasksShowCommand,
      expected: { lookup: "run-123", json: true },
    },
    {
      label: "flow list JSON before flow",
      args: ["tasks", "--json", "flow", "list"],
      handler: mocks.flowsListCommand,
      expected: { json: true, status: undefined },
    },
    {
      label: "flow list JSON before the leaf",
      args: ["tasks", "flow", "--json", "list"],
      handler: mocks.flowsListCommand,
      expected: { json: true, status: undefined },
    },
    {
      label: "flow list JSON after the leaf",
      args: ["tasks", "flow", "list", "--json"],
      handler: mocks.flowsListCommand,
      expected: { json: true, status: undefined },
    },
    {
      label: "flow list status after the leaf",
      args: ["tasks", "flow", "list", "--status", "blocked"],
      handler: mocks.flowsListCommand,
      expected: { json: false, status: "blocked" },
    },
    {
      label: "flow show JSON before flow",
      args: ["tasks", "--json", "flow", "show", "flow-123"],
      handler: mocks.flowsShowCommand,
      expected: { lookup: "flow-123", json: true },
    },
    {
      label: "flow show JSON before the leaf",
      args: ["tasks", "flow", "--json", "show", "flow-123"],
      handler: mocks.flowsShowCommand,
      expected: { lookup: "flow-123", json: true },
    },
    {
      label: "flow show JSON after the leaf",
      args: ["tasks", "flow", "show", "flow-123", "--json"],
      handler: mocks.flowsShowCommand,
      expected: { lookup: "flow-123", json: true },
    },
  ])("routes $label", async ({ args, handler, expected }) => {
    await runCli(args);
    expectCommandOptions(handler, expected);
  });

  it("runs task audit filters and validates the limit", async () => {
    await runCli([
      "tasks",
      "audit",
      "--severity",
      "error",
      "--code",
      "stale_running",
      "--limit",
      "5",
    ]);
    expectCommandOptions(mocks.tasksAuditCommand, {
      severity: "error",
      code: "stale_running",
      limit: 5,
    });
  });

  it("rejects partially numeric task audit limits before owner action", async () => {
    const execution = runCli(["tasks", "audit", "--limit", "5abc"]);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toThrow(
      "--limit must be a positive integer, for example --limit 25.",
    );
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.tasksAuditCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ["tasks", "audit", "--severity", "fatal"],
      error: "--severity must be warn or error.",
    },
    {
      args: ["tasks", "audit", "--code", "unknown"],
      error: expect.stringContaining("--code must be"),
    },
  ])("narrows invalid audit filters before owner action", async ({ args, error }) => {
    await runCli(args);

    expect(mocks.runtime.error).toHaveBeenCalledWith(error);
    expect(mocks.tasksAuditCommand).not.toHaveBeenCalled();
  });

  const rootOptionArgs = {
    json: ["--json"],
    runtime: ["--runtime", "cron"],
    status: ["--status", "running"],
  } as const;
  const directUnsupported = [
    { leaf: ["audit"], options: ["runtime", "status"] },
    { leaf: ["maintenance", "--apply"], options: ["runtime", "status"] },
    { leaf: ["show", "task-123"], options: ["runtime", "status"] },
    { leaf: ["notify", "task-123", "silent"], options: ["json", "runtime", "status"] },
    { leaf: ["cancel", "task-123"], options: ["json", "runtime", "status"] },
    { leaf: ["retry", "task-123"], options: ["json", "runtime", "status"] },
    { leaf: ["dismiss", "task-123"], options: ["json", "runtime", "status"] },
  ].flatMap(({ leaf, options }) =>
    options.map((option) => ({
      label: `tasks ${leaf[0]} with root --${option}`,
      args: ["tasks", ...rootOptionArgs[option as keyof typeof rootOptionArgs], ...leaf],
      flag: `--${option}`,
    })),
  );
  const flowRootUnsupported = [
    { leaf: ["list"], options: ["runtime", "status"] },
    { leaf: ["show", "flow-123"], options: ["runtime", "status"] },
    { leaf: ["cancel", "flow-123"], options: ["json", "runtime", "status"] },
  ].flatMap(({ leaf, options }) =>
    options.map((option) => ({
      label: `tasks flow ${leaf[0]} with tasks root --${option}`,
      args: ["tasks", ...rootOptionArgs[option as keyof typeof rootOptionArgs], "flow", ...leaf],
      flag: `--${option}`,
    })),
  );

  it.each([
    ...directUnsupported,
    ...flowRootUnsupported,
    {
      label: "tasks flow cancel with flow parent --json",
      args: ["tasks", "flow", "--json", "cancel", "flow-123"],
      flag: "--json",
    },
  ])("rejects $label before owner action", async ({ args, flag }) => {
    const execution = runCli(args);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({ message: expect.stringContaining(flag) });
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    for (const handler of ownerHandlers) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      args: ["tasks", "--runtime", "cron", "--status", "running", "maintenance", "--apply"],
      error: "`tasks maintenance` does not support inherited options --runtime, --status.",
    },
    {
      args: ["tasks", "--json", "--runtime", "cron", "cancel", "task-123"],
      error: "`tasks cancel` does not support inherited options --json, --runtime.",
    },
  ])("lists only explicitly supplied unsupported flags", async ({ args, error }) => {
    await expect(runCli(args)).rejects.toThrow(error);

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    for (const handler of ownerHandlers) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("forwards notify and cancel arguments without root options", async () => {
    await runCli(["tasks", "notify", "run-123", "state_changes"]);
    expectCommandOptions(mocks.tasksNotifyCommand, {
      lookup: "run-123",
      notify: "state_changes",
    });

    vi.clearAllMocks();
    await runCli(["tasks", "cancel", "run-123"]);
    expectCommandOptions(mocks.tasksCancelCommand, { lookup: "run-123" });
  });

  it("rejects an invalid notify policy before owner action", async () => {
    const execution = runCli(["tasks", "notify", "run-123", "sometimes"]);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toThrow(
      "Notify policy must be done_only, state_changes, or silent.",
    );
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(mocks.tasksNotifyCommand).not.toHaveBeenCalled();
  });

  it("does not register the legacy top-level flows command", () => {
    const program = new Command();
    registerTasksCommand(program);
    expect(program.commands.find((command) => command.name() === "flows")).toBeUndefined();
  });
});
