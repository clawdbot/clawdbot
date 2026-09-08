import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../../logging/state.js";

const mocks = vi.hoisted(() => ({
  ensureConfigReady: vi.fn(async () => {}),
  routeLogsToStderr: vi.fn(),
}));

vi.mock("../../globals.js", () => ({ setVerbose: vi.fn() }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
}));
vi.mock("../../logging/console.js", () => ({
  routeLogsToStderr: mocks.routeLogsToStderr,
}));
vi.mock("../banner.js", () => ({ emitCliBanner: vi.fn() }));
vi.mock("../cli-name.js", () => ({ resolveCliName: () => "openclaw" }));
vi.mock("./config-guard.js", () => ({ ensureConfigReady: mocks.ensureConfigReady }));
vi.mock("../plugin-registry.js", () => ({ ensurePluginRegistryLoaded: vi.fn() }));

const originalArgv = [...process.argv];
const originalTitle = process.title;
const originalForceStderr = loggingState.forceConsoleToStderr;
const originalEarlyConsoleRoutingRestore = loggingState.earlyConsoleRoutingRestore;

describe("preaction model output owner", () => {
  afterEach(() => {
    vi.clearAllMocks();
    process.argv = originalArgv;
    process.title = originalTitle;
    loggingState.forceConsoleToStderr = originalForceStderr;
    loggingState.earlyConsoleRoutingRestore = originalEarlyConsoleRoutingRestore;
  });

  it.each([
    {
      name: "plain-looking provider value",
      args: ["models", "auth", "list", "--provider", "--plain"],
    },
    {
      name: "ignored parent plain alias and plain-looking provider value",
      args: ["models", "--status-plain", "auth", "list", "--provider", "--plain"],
    },
  ])("restores human stdout for $name", async ({ args }) => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    program
      .command("models")
      .option("--status-plain")
      .command("auth")
      .command("list")
      .option("--provider <id>")
      .action(() => {});

    const { registerPreActionHooks } = await import("./preaction.js");
    registerPreActionHooks(program, "test");
    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;
    process.argv = ["node", "openclaw", ...args];

    await program.parseAsync(process.argv);

    expect(loggingState.forceConsoleToStderr).toBe(false);
    expect(mocks.routeLogsToStderr).not.toHaveBeenCalled();
  });
});
