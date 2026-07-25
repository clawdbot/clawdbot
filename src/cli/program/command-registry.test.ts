// Command registry tests cover CLI command descriptor registry behavior.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { ProgramContext } from "./context.js";

// Perf: `registerCoreCliByName(...)` dynamically imports registrar modules.
// Mock the heavy registrars so this suite stays focused on command-registry wiring.
vi.mock("./register.agent.js", () => ({
  registerAgentsCommands: (program: Command) => {
    program.command("agents");
  },
}));

vi.mock("./register.agent-turn.js", () => ({
  registerAgentTurnCommand: (program: Command) => {
    program.command("agent");
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

vi.mock("./register.setup.js", () => ({
  registerSetupCommand: (program: Command) => {
    program.command("setup");
    program.command("crestodian", { hidden: true }); // hidden alias
  },
}));

import {
  getCoreCliCommandNames,
  registerCoreCliByName,
  registerCoreCliCommands,
} from "./command-registry-core.js";
import { getCoreCliCommandsWithSubcommands } from "./core-command-descriptors.js";

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
    expect(names).toContain("setup");
    expect(names).toContain("crestodian"); // hidden alias
    expect(names).toContain("mcp");
    expect(names).toContain("agent");
    expect(names).toContain("agents");
  });

  it("only exposes Claws after an explicit process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    expect(getCoreCliCommandNames()).not.toContain("claws");
    expect(getCoreCliCommandsWithSubcommands()).not.toContain("claws");

    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    expect(getCoreCliCommandNames()).toContain("claws");
    expect(getCoreCliCommandsWithSubcommands()).toContain("claws");

    vi.unstubAllEnvs();
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
    expect(names).not.toContain("setup");
    expect(names).not.toContain("status");
    expect(names).not.toContain("doctor");
  });

  it("registerCoreCliByName resolves agent and agents separately", async () => {
    const program = createProgram();
    const found = await registerCoreCliByName(program, testProgramContext, "agents");
    expect(found).toBe(true);
    expect(program.commands.map((command) => command.name())).toEqual(["agents"]);

    const agentProgram = createProgram();
    await expect(registerCoreCliByName(agentProgram, testProgramContext, "agent")).resolves.toBe(
      true,
    );
    expect(agentProgram.commands.map((command) => command.name())).toEqual(["agent"]);
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
    const countName = (target: string) =>
      names.reduce((count, name) => count + (name === target ? 1 : 0), 0);
    expect(countName("commitments")).toBe(1);
    expect(countName("tasks")).toBe(1);
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
