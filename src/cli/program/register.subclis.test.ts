import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acpAction, registerAcpCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("acp").action(action);
  });
  return { acpAction: action, registerAcpCli: register };
});

const { nodesAction, registerNodesCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    const nodes = program.command("nodes");
    nodes.command("list").action(action);
  });
  return { nodesAction: action, registerNodesCli: register };
});

vi.mock("../acp-cli.js", () => ({ registerAcpCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));

const { registerSubCliByName, registerSubCliCommands } = await import("./register.subclis.js");

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAWDBOT_DISABLE_LAZY_SUBCOMMANDS;
    registerAcpCli.mockClear();
    acpAction.mockClear();
    registerNodesCli.mockClear();
    nodesAction.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  it("registers only the primary placeholder and dispatches", async () => {
    process.argv = ["node", "moltbot", "acp"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["acp"]);

    await program.parseAsync(process.argv);

    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    process.argv = ["node", "moltbot"];
    const program = new Command();
    registerSubCliCommands(program, process.argv);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("acp");
    expect(names).toContain("gateway");
    expect(registerAcpCli).not.toHaveBeenCalled();
  });

  it("re-parses argv for lazy subcommands", async () => {
    process.argv = ["node", "moltbot", "nodes", "list"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    process.argv = ["node", "moltbot", "acp", "--help"];
    const program = new Command();
    program.name("moltbot");
    registerSubCliCommands(program, process.argv);

    await registerSubCliByName(program, "acp");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "acp")).toHaveLength(1);

    await program.parseAsync(["node", "moltbot", "acp"], { from: "user" });
    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });
});
