// Nodes CLI plugin registration tests cover node command plugin registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";

const registerPluginCliCommandsFromValidatedConfig = vi.fn(async () => ({}));
const registerNodesCameraCommands = vi.fn();
const registerNodesInvokeCommands = vi.fn();
const registerNodesLocationCommands = vi.fn();
const registerNodesNotifyCommand = vi.fn();
const registerNodesPairingCommands = vi.fn();
const registerNodesPushCommand = vi.fn();
const registerNodesScreenCommands = vi.fn();
const registerNodesStatusCommands = vi.fn();

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig,
}));

vi.mock("./nodes-cli/register.camera.js", () => ({ registerNodesCameraCommands }));
vi.mock("./nodes-cli/register.invoke.js", () => ({ registerNodesInvokeCommands }));
vi.mock("./nodes-cli/register.location.js", () => ({ registerNodesLocationCommands }));
vi.mock("./nodes-cli/register.notify.js", () => ({ registerNodesNotifyCommand }));
vi.mock("./nodes-cli/register.pairing.js", () => ({ registerNodesPairingCommands }));
vi.mock("./nodes-cli/register.push.js", () => ({ registerNodesPushCommand }));
vi.mock("./nodes-cli/register.screen.js", () => ({ registerNodesScreenCommands }));
vi.mock("./nodes-cli/register.status.js", () => ({ registerNodesStatusCommands }));

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

  it("routes plugin registration logs to stderr for nodes --json commands", async () => {
    let forceStderrDuringRegistration = false;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

    const program = await registerWithArgv(["node", "openclaw", "nodes", "list", "--json"]);

    expect(registerPluginCliCommandsFromValidatedConfig).toHaveBeenCalledWith(
      program,
      undefined,
      undefined,
      { mode: "lazy", primary: "nodes" },
    );
    expect(forceStderrDuringRegistration).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not route pass-through --json after the terminator", async () => {
    let forceStderrDuringRegistration = true;
    registerPluginCliCommandsFromValidatedConfig.mockImplementationOnce(async () => {
      forceStderrDuringRegistration = loggingState.forceConsoleToStderr;
      return {};
    });

    await registerWithArgv(["node", "openclaw", "nodes", "invoke", "--", "--json"]);

    expect(forceStderrDuringRegistration).toBe(false);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });
});
