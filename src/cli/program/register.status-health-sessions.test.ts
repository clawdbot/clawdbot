import { Command } from "commander";
// Register status/health/session tests cover status-related command registration.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  statusCommand: vi.fn(),
  healthCommand: vi.fn(),
  sessionsCommand: vi.fn(),
  sessionsCleanupCommand: vi.fn(),
  sessionsTailCommand: vi.fn(),
  sessionsCompactCommand: vi.fn(),
  sessionsArchiveCommand: vi.fn(),
  sessionsDeleteCommand: vi.fn(),
  exportTrajectoryCommand: vi.fn(),
  setVerbose: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const statusCommand = mocks.statusCommand;
const healthCommand = mocks.healthCommand;
const sessionsCommand = mocks.sessionsCommand;
const sessionsCleanupCommand = mocks.sessionsCleanupCommand;
const sessionsTailCommand = mocks.sessionsTailCommand;
const sessionsCompactCommand = mocks.sessionsCompactCommand;
const sessionsArchiveCommand = mocks.sessionsArchiveCommand;
const sessionsDeleteCommand = mocks.sessionsDeleteCommand;
const exportTrajectoryCommand = mocks.exportTrajectoryCommand;
const setVerbose = mocks.setVerbose;
const runtime = mocks.runtime;

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");

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

vi.mock("../../commands/sessions-lifecycle.js", () => ({
  sessionsArchiveCommand: mocks.sessionsArchiveCommand,
  sessionsDeleteCommand: mocks.sessionsDeleteCommand,
}));

vi.mock("../../commands/export-trajectory.js", () => ({
  exportTrajectoryCommand: mocks.exportTrajectoryCommand,
}));

vi.mock("../../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerStatusHealthSessionsCommands", () => {
  function createProgram() {
    const program = new Command();
    registerStatusHealthSessionsCommands(program);
    return program;
  }

  async function runCli(args: string[]) {
    await createProgram().parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runtime.exit.mockImplementation(() => {});
    statusCommand.mockResolvedValue(undefined);
    healthCommand.mockResolvedValue(undefined);
    sessionsCommand.mockResolvedValue(undefined);
    sessionsCleanupCommand.mockResolvedValue(undefined);
    sessionsTailCommand.mockResolvedValue(undefined);
    sessionsCompactCommand.mockResolvedValue(undefined);
    sessionsArchiveCommand.mockResolvedValue(undefined);
    sessionsDeleteCommand.mockResolvedValue(undefined);
    exportTrajectoryCommand.mockResolvedValue(undefined);
  });

  it("runs status command with timeout and debug-derived verbose", async () => {
    await runCli([
      "status",
      "--json",
      "--all",
      "--deep",
      "--usage",
      "--agent",
      "beta",
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
      agent: "beta",
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

  it("documents explicit selection for multi-agent session-store commands", () => {
    const sessions = createProgram().commands.find((command) => command.name() === "sessions");
    const list = sessions?.commands.find((command) => command.name() === "list");
    const cleanup = sessions?.commands.find((command) => command.name() === "cleanup");

    expect(list?.options.find((option) => option.long === "--agent")?.description).toBe(
      "Agent id to inspect (required for multiple explicit agents)",
    );
    expect(cleanup?.options.find((option) => option.long === "--agent")?.description).toBe(
      "Agent id to maintain (required for multiple explicit agents)",
    );
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

  it("forwards multi-key archive options and inherits parent sessions output options", async () => {
    await runCli([
      "sessions",
      "--agent",
      "work",
      "--json",
      "archive",
      "agent:work:scratch-1",
      "agent:work:scratch-2",
      "--dry-run",
      "--url",
      "ws://gateway.test",
      "--token",
      "test-token",
      "--password",
      "test-password",
      "--timeout",
      "45000",
    ]);

    expectCommandOptions(sessionsArchiveCommand, {
      keys: ["agent:work:scratch-1", "agent:work:scratch-2"],
      agent: "work",
      dryRun: true,
      url: "ws://gateway.test",
      token: "test-token",
      password: "test-password",
      timeout: "45000",
      json: true,
    });
  });

  it("forwards multi-key delete options and prefers the subcommand agent", async () => {
    await runCli([
      "sessions",
      "--agent",
      "main",
      "delete",
      "agent:work:scratch-1",
      "agent:work:scratch-2",
      "--agent",
      "work",
      "--yes",
      "--json",
    ]);

    expectCommandOptions(sessionsDeleteCommand, {
      keys: ["agent:work:scratch-1", "agent:work:scratch-2"],
      agent: "work",
      dryRun: false,
      yes: true,
      json: true,
    });
  });

  it("rejects inherited session-list filters for lifecycle mutations", async () => {
    await runCli([
      "sessions",
      "--store",
      "/tmp/other-sessions.json",
      "--all-agents",
      "archive",
      "agent:main:scratch-1",
    ]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--store"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--all-agents"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsArchiveCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid lifecycle RPC timeouts", async () => {
    await runCli(["sessions", "delete", "agent:main:scratch-1", "--timeout", "0", "--yes"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "--timeout must be a positive integer (milliseconds).",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsDeleteCommand).not.toHaveBeenCalled();
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

  it.each([
    { flag: "--active", value: "5" },
    { flag: "--limit", value: "1" },
  ])("rejects inherited $flag before running session cleanup", async ({ flag, value }) => {
    await runCli(["sessions", flag, value, "cleanup", "--enforce"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(flag));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsCleanupCommand).not.toHaveBeenCalled();
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

  it("rejects inherited JSON mode for human-readable session tail", async () => {
    await runCli(["sessions", "--json", "tail"]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--json"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(sessionsTailCommand).not.toHaveBeenCalled();
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

  it("rejects inherited all-agent scope for single-session trajectory exports", async () => {
    await runCli([
      "sessions",
      "--all-agents",
      "export-trajectory",
      "--session-key",
      "agent:main:main",
    ]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--all-agents"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(exportTrajectoryCommand).not.toHaveBeenCalled();
  });
});
