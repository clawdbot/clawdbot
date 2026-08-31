// Nodes CLI plugin registration tests cover node command plugin registration.
// Built-in node command registration runs for real so the guard is exercised against the actual
// registered subcommand names; only the plugin-loader boundary is stubbed.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

const registerPluginCliCommandsFromValidatedConfig = vi.fn(async () => ({}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig,
}));

const { registerNodesCli } = await import("./nodes-cli/register.js");

describe("registerNodesCli plugin registration", () => {
  const originalArgv = process.argv;
  let originalForceConsoleToStderr = false;

  beforeEach(() => {
    originalForceConsoleToStderr = loggingState.forceConsoleToStderr;
    loggingState.forceConsoleToStderr = false;
    registerPluginCliCommandsFromValidatedConfig.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    loggingState.forceConsoleToStderr = originalForceConsoleToStderr;
  });

  async function registerWithArgv(argv: string[]) {
    process.argv = argv;
    const program = new Command();
    await registerNodesCli(program);
    return program;
  }

  it("skips plugin CLI/runtime registration for built-in nodes subcommands", async () => {
    for (const subcommand of ["status", "list", "describe", "invoke", "pending", "camera"]) {
      registerPluginCliCommandsFromValidatedConfig.mockClear();
      await registerWithArgv(["node", "openclaw", "nodes", subcommand, "--json"]);
      expect(registerPluginCliCommandsFromValidatedConfig).not.toHaveBeenCalled();
    }
  });

  it("registers plugin-provided node subcommands lazily and routes their logs to stderr", async () => {
    let forceStderrDuringRegistration = false;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

    const program = await registerWithArgv([
      "node",
      "openclaw",
      "nodes",
      "canvas",
      "snapshot",
      "--json",
    ]);

    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
    expect(forceStderrDuringRegistration).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("surfaces plugin subcommands for bare `nodes` listing", async () => {
    const program = await registerWithArgv(["node", "openclaw", "nodes"]);
    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
  });

  it("documents the supported system.which parameter shape", async () => {
    const program = await registerWithArgv(["node", "openclaw", "nodes", "--help"]);
    const nodesCommand = program.commands.find((command) => command.name() === "nodes");
    const output: string[] = [];

    nodesCommand?.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    nodesCommand?.outputHelp();
    const help = output.join("");

    expect(help).toContain(`--params '{"bins":["uname"]}'`);
    expect(help).not.toContain(`--params '{"name":"uname"}'`);
  });

  it("does not route pass-through --json after the terminator", async () => {
    let forceStderrDuringRegistration = true;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

    await registerWithArgv(["node", "openclaw", "nodes", "canvas", "--", "--json"]);

    expect(forceStderrDuringRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
