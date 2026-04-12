import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSubCliByName, registerSubCliCommands } from "./register.subclis.js";

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

const { isQaLabCliAvailable, registerQaLabCli } = vi.hoisted(() => ({
  isQaLabCliAvailable: vi.fn(() => true),
  registerQaLabCli: vi.fn((program: Command) => {
    const qa = program.command("qa");
    qa.command("run").action(() => undefined);
  }),
}));

const { inferAction, registerCapabilityCli } = vi.hoisted(() => {
  const action = vi.fn();
  const register = vi.fn((program: Command) => {
    program.command("infer").alias("capability").action(action);
  });
  return { inferAction: action, registerCapabilityCli: register };
});

vi.mock("../acp-cli.js", () => ({ registerAcpCli }));
vi.mock("../nodes-cli.js", () => ({ registerNodesCli }));
vi.mock("../capability-cli.js", () => ({ registerCapabilityCli }));
vi.mock("../../plugin-sdk/qa-lab.js", () => ({ isQaLabCliAvailable, registerQaLabCli }));

describe("registerSubCliCommands", () => {
  const originalArgv = process.argv;
  const originalDisableLazySubcommands = process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;

  const createRegisteredProgram = (argv: string[], name?: string) => {
    process.argv = argv;
    const program = new Command();
    if (name) {
      program.name(name);
    }
    registerSubCliCommands(program, process.argv);
    return program;
  };

  beforeEach(() => {
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
    registerAcpCli.mockClear();
    acpAction.mockClear();
    registerNodesCli.mockClear();
    nodesAction.mockClear();
    isQaLabCliAvailable.mockReset().mockReturnValue(true);
    registerQaLabCli.mockClear();
    registerCapabilityCli.mockClear();
    inferAction.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalDisableLazySubcommands === undefined) {
      delete process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS;
    } else {
      process.env.OPENCLAW_DISABLE_LAZY_SUBCOMMANDS = originalDisableLazySubcommands;
    }
  });

  it("registers the primary placeholder plus completion and dispatches", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "acp"]);

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["acp", "completion"]);

    await program.parseAsync(["acp"], { from: "user" });

    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });

  it("registers placeholders for all subcommands when no primary", () => {
    const program = createRegisteredProgram(["node", "openclaw"]);

    const names = program.commands.map((cmd) => cmd.name());
    expect(names).toContain("acp");
    expect(names).toContain("gateway");
    expect(names).toContain("clawbot");
    expect(names).toContain("qa");
    expect(registerAcpCli).not.toHaveBeenCalled();
  });

  it("omits the qa placeholder when the private qa bundle is unavailable", () => {
    isQaLabCliAvailable.mockReturnValue(false);

    const program = createRegisteredProgram(["node", "openclaw"]);

    expect(program.commands.map((cmd) => cmd.name())).not.toContain("qa");
  });

  it("re-parses argv for lazy subcommands", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "nodes", "list"], "openclaw");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["nodes", "completion"]);

    await program.parseAsync(["nodes", "list"], { from: "user" });

    expect(registerNodesCli).toHaveBeenCalledTimes(1);
    expect(nodesAction).toHaveBeenCalledTimes(1);
  });

  it("registers the infer placeholder and dispatches through the capability registrar", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "infer"], "openclaw");

    expect(program.commands.map((cmd) => cmd.name())).toEqual(["infer", "completion"]);

    await program.parseAsync(["infer"], { from: "user" });

    expect(registerCapabilityCli).toHaveBeenCalledTimes(1);
    expect(inferAction).toHaveBeenCalledTimes(1);
  });

  it("replaces placeholder when registering a subcommand by name", async () => {
    const program = createRegisteredProgram(["node", "openclaw", "acp", "--help"], "openclaw");

    await registerSubCliByName(program, "acp");

    const names = program.commands.map((cmd) => cmd.name());
    expect(names.filter((name) => name === "acp")).toHaveLength(1);

    await program.parseAsync(["acp"], { from: "user" });
    expect(registerAcpCli).toHaveBeenCalledTimes(1);
    expect(acpAction).toHaveBeenCalledTimes(1);
  });
});
