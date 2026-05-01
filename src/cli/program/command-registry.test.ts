import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

// Perf: `registerCoreCliByName(...)` dynamically imports registrar modules.
// Mock the heavy registrars so this suite stays focused on command-registry wiring.
vi.mock("./register.agent.js", () => ({
  registerAgentCommands: (program: Command) => {
    program.command("agent");
    program.command("agents");
  },
}));

vi.mock("./register.backup.js", () => ({
  registerBackupCommand: (program: Command) => {
    const backup = program.command("backup");
    backup.command("create");
  },
}));

vi.mock("./register.maintenance.js", () => ({
  registerMaintenanceCommands: (program: Command) => {
    program.command("doctor");
    program.command("dashboard");
    program.command("reset");
    program.command("uninstall");
  },
}));

vi.mock("./register.status-health-sessions.js", () => ({
  registerStatusHealthSessionsCommands: (program: Command) => {
    program.command("status");
    program.command("health");
    program.command("sessions");
    program.command("commitments");
    const tasks = program.command("tasks");
    tasks.command("show");
  },
}));

vi.mock("./register.crestodian.js", () => ({
  registerCrestodianCommand: (program: Command) => {
    program.command("crestodian");
  },
}));

import {
  getCoreCliCommandNames,
  getCoreCliCommandsWithSubcommands,
  registerCoreCliByName,
  registerCoreCliCommands,
} from "./command-registry.js";

const testProgramContext: ProgramContext = {
  programVersion: "0.0.0-test",
  channelOptions: [],
  messageChannelOptions: "",
  agentChannelOptions: "web",
};

describe("command-registry", () => {
  const createProgram = () => new Command();
  const namesOf = (program: Command) => program.commands.map((command) => command.name());

  const withProcessArgv = async (argv: string[], run: () => Promise<void>) => {
    const prevArgv = process.argv;
    process.argv = argv;
    try {
      await run();
    } finally {
      process.argv = prevArgv;
    }
  };

  it("includes both agent and agents in core CLI command names", () => {
    const names = getCoreCliCommandNames();
    expect(names).toContain("crestodian");
    expect(names).toContain("mcp");
    expect(names).toContain("agent");
    expect(names).toContain("agents");
  });

  it("returns only commands that support subcommands", () => {
    const names = getCoreCliCommandsWithSubcommands();
    expect(names).toContain("config");
    expect(names).toContain("agents");
    expect(names).toContain("backup");
    expect(names).toContain("mcp");
    expect(names).toContain("sessions");
    expect(names).toContain("commitments");
    expect(names).toContain("tasks");
    expect(names).not.toContain("agent");
    expect(names).not.toContain("crestodian");
    expect(names).not.toContain("status");
    expect(names).not.toContain("doctor");
  });

  it("registerCoreCliByName resolves agents to the agent entry", async () => {
    const program = createProgram();
    const found = await registerCoreCliByName(program, testProgramContext, "agents");
    expect(found).toBe(true);
    const agentsCmd = program.commands.find((c) => c.name() === "agents");
    expect(agentsCmd).toBeDefined();
    // The registrar also installs the singular "agent" command from the same entry.
    const agentCmd = program.commands.find((c) => c.name() === "agent");
    expect(agentCmd).toBeDefined();
  });

  it("registerCoreCliByName returns false for unknown commands", async () => {
    const program = createProgram();
    const found = await registerCoreCliByName(program, testProgramContext, "nonexistent");
    expect(found).toBe(false);
  });

  it("registers doctor placeholder for doctor primary command", () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor"]);

    expect(namesOf(program)).toEqual(["doctor"]);
  });

  it("narrows to the primary command when command help is requested", () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor", "--help"]);

    expect(namesOf(program)).toEqual(["doctor"]);
  });

  it("keeps all placeholders for root help", () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "--help"]);

    const names = namesOf(program);
    expect(names).toContain("doctor");
    expect(names).toContain("status");
    expect(names.length).toBeGreaterThan(1);
  });

  it("treats maintenance commands as top-level builtins", async () => {
    const program = createProgram();

    expect(await registerCoreCliByName(program, testProgramContext, "doctor")).toBe(true);

    const names = getCoreCliCommandNames();
    expect(names).toContain("doctor");
    expect(names).toContain("dashboard");
    expect(names).toContain("reset");
    expect(names).toContain("uninstall");
    expect(names).not.toContain("maintenance");
  });

  it("registers grouped core entry placeholders without duplicate command errors", async () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "vitest"]);
    program.exitOverride();
    await withProcessArgv(["node", "openclaw", "status"], async () => {
      await program.parseAsync(["node", "openclaw", "status"]);
    });

    const names = namesOf(program);
    expect(names).toContain("status");
    expect(names).toContain("health");
    expect(names).toContain("sessions");
    expect(names).toContain("commitments");
    expect(names).toContain("tasks");
  });

  it("can eagerly register the status/session command group repeatedly for completion", async () => {
    const program = createProgram();

    for (const name of ["status", "health", "sessions", "commitments", "tasks"]) {
      await expect(registerCoreCliByName(program, testProgramContext, name)).resolves.toBe(true);
    }

    const names = namesOf(program);
    expect(names.filter((name) => name === "commitments")).toHaveLength(1);
    expect(names.filter((name) => name === "tasks")).toHaveLength(1);
  });

  it("replaces placeholders when loading a grouped entry by secondary command name", async () => {
    const program = createProgram();
    registerCoreCliCommands(program, testProgramContext, ["node", "openclaw", "doctor"]);
    expect(namesOf(program)).toEqual(["doctor"]);

    const found = await registerCoreCliByName(program, testProgramContext, "dashboard");
    expect(found).toBe(true);
    expect(namesOf(program)).toEqual(["doctor", "dashboard", "reset", "uninstall"]);
  });
});
