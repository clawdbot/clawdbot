// Models CLI tests cover model listing command registration and provider output.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";
import { isCommandJsonOutputMode } from "./program/json-mode.js";

const mocks = vi.hoisted(() => ({
  modelsListCommand: vi.fn().mockResolvedValue(undefined),
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetImageCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  // The global-only subcommands get their own spies rather than sharing
  // `noopAsync`: a shared one stays called from the previous table row, so a
  // later row asserting "the leaf ran" passes even when its leaf never runs.
  modelsAliasesAddCommand: vi.fn(async () => undefined),
  modelsAliasesListCommand: vi.fn(async () => undefined),
  modelsAliasesRemoveCommand: vi.fn(async () => undefined),
  modelsScanCommand: vi.fn(async () => undefined),
  modelsAuthAddCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLogoutCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderClearCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderGetCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthOrderSetCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthPasteApiKeyCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthPasteTokenCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthSetupTokenCommand: vi.fn().mockResolvedValue(undefined),
}));

const {
  modelsAuthAddCommand,
  modelsAuthListCommand,
  modelsAuthLoginCommand,
  modelsAuthLogoutCommand,
  modelsAuthOrderClearCommand,
  modelsAuthOrderGetCommand,
  modelsAuthOrderSetCommand,
  modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  modelsAliasesAddCommand,
  modelsAliasesListCommand,
  modelsAliasesRemoveCommand,
  modelsScanCommand,
  modelsSetCommand,
  modelsSetImageCommand,
  modelsStatusCommand,
} = mocks;

vi.mock("../commands/models/list.list-command.js", () => ({
  modelsListCommand: mocks.modelsListCommand,
}));
vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.modelsStatusCommand,
}));
vi.mock("../commands/models/auth.js", () => ({
  modelsAuthAddCommand: mocks.modelsAuthAddCommand,
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
  modelsAuthPasteApiKeyCommand: mocks.modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand: mocks.modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand: mocks.modelsAuthSetupTokenCommand,
}));
vi.mock("../commands/models/auth-list.js", () => ({
  modelsAuthListCommand: mocks.modelsAuthListCommand,
}));
vi.mock("../commands/models/auth-logout.js", () => ({
  modelsAuthLogoutCommand: mocks.modelsAuthLogoutCommand,
}));
vi.mock("../commands/models/auth-order.js", () => ({
  modelsAuthOrderClearCommand: mocks.modelsAuthOrderClearCommand,
  modelsAuthOrderGetCommand: mocks.modelsAuthOrderGetCommand,
  modelsAuthOrderSetCommand: mocks.modelsAuthOrderSetCommand,
}));
vi.mock("../commands/models/aliases.js", () => ({
  modelsAliasesAddCommand: mocks.modelsAliasesAddCommand,
  modelsAliasesListCommand: mocks.modelsAliasesListCommand,
  modelsAliasesRemoveCommand: mocks.modelsAliasesRemoveCommand,
}));
vi.mock("../commands/models/fallbacks.js", () => ({
  modelsFallbacksAddCommand: mocks.noopAsync,
  modelsFallbacksClearCommand: mocks.noopAsync,
  modelsFallbacksListCommand: mocks.noopAsync,
  modelsFallbacksRemoveCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/image-fallbacks.js", () => ({
  modelsImageFallbacksAddCommand: mocks.noopAsync,
  modelsImageFallbacksClearCommand: mocks.noopAsync,
  modelsImageFallbacksListCommand: mocks.noopAsync,
  modelsImageFallbacksRemoveCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/scan.js", () => ({
  modelsScanCommand: mocks.modelsScanCommand,
}));
vi.mock("../commands/models/set.js", () => ({
  modelsSetCommand: mocks.modelsSetCommand,
}));
vi.mock("../commands/models/set-image.js", () => ({
  modelsSetImageCommand: mocks.modelsSetImageCommand,
}));

describe("models cli", () => {
  beforeEach(() => {
    mocks.modelsListCommand.mockClear();
    modelsAuthAddCommand.mockClear();
    modelsAuthListCommand.mockClear();
    modelsAuthLoginCommand.mockClear();
    modelsAuthLogoutCommand.mockClear();
    modelsAuthOrderClearCommand.mockClear();
    modelsAuthOrderGetCommand.mockClear();
    modelsAuthOrderSetCommand.mockClear();
    modelsAuthPasteApiKeyCommand.mockClear();
    modelsAuthPasteTokenCommand.mockClear();
    modelsAuthSetupTokenCommand.mockClear();
    modelsAliasesAddCommand.mockClear();
    modelsAliasesListCommand.mockClear();
    modelsAliasesRemoveCommand.mockClear();
    modelsScanCommand.mockClear();
    modelsSetCommand.mockClear();
    modelsSetImageCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    return program;
  }

  // `defaultRuntime.error` routes through console.error (src/runtime.ts), not a
  // direct process.stderr write.
  function captureRuntimeErrors() {
    const writes: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      writes.push(args.map((arg) => String(arg)).join(" "));
    });
    return writes;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: (program: Command) => {
        program.enablePositionalOptions();
        registerModelsCli(program);
      },
      argv: args,
    });
  }

  function requireCommand(parent: Command, name: string): Command {
    const command = parent.commands.find((cmd) => cmd.name() === name);
    if (!command) {
      throw new Error(`expected ${name} command`);
    }
    return command;
  }

  function expectCommandOptions(
    command: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(command).toHaveBeenCalledTimes(1);
    const [options, context] = command.mock.calls[0] ?? [];
    const optionRecord = options as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(expected)) {
      expect(optionRecord?.[key]).toEqual(value);
    }
    if (!context || typeof context !== "object") {
      throw new Error("expected command context");
    }
  }

  it.each(["--json", "--status-json"])("declares %s as machine output", async (flag) => {
    const program = createProgram();
    let detected = false;
    program.hook("preAction", (_command, actionCommand) => {
      detected = isCommandJsonOutputMode(actionCommand, process.argv);
    });

    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "models", flag];
    try {
      await program.parseAsync(["models", flag], { from: "user" });
    } finally {
      process.argv = originalArgv;
    }

    expect(detected).toBe(true);
  });

  it("does not apply the parent status alias to a child action", async () => {
    const program = createProgram();
    let detected = true;
    program.hook("preAction", (_command, actionCommand) => {
      detected = isCommandJsonOutputMode(actionCommand, process.argv);
    });

    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "models", "--status-json", "list"];
    try {
      await program.parseAsync(["models", "--status-json", "list"], { from: "user" });
    } finally {
      process.argv = originalArgv;
    }

    expect(detected).toBe(false);
  });

  it("forwards bare --json to the default status report", async () => {
    await runModelsCommand(["models", "--json"]);

    expectCommandOptions(modelsStatusCommand, { json: true });
  });

  it("registers github-copilot login command", async () => {
    const program = createProgram();
    const models = requireCommand(program, "models");
    const auth = requireCommand(models, "auth");
    expect(requireCommand(auth, "login-github-copilot").name()).toBe("login-github-copilot");

    await program.parseAsync(
      ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      { from: "user" },
    );

    expect(modelsAuthLoginCommand).toHaveBeenCalledTimes(1);
    expectCommandOptions(modelsAuthLoginCommand, {
      provider: "github-copilot",
      method: "device",
      yes: true,
      agent: "poe",
    });
  });

  it("declares --agent on every agent-aware auth leaf command", () => {
    const models = requireCommand(createProgram(), "models");
    const auth = requireCommand(models, "auth");
    const order = requireCommand(auth, "order");
    const authLeaves = auth.commands.filter((command) => command !== order);

    for (const command of [...authLeaves, ...order.commands]) {
      expect(command.options.some((option) => option.long === "--agent")).toBe(true);
    }
  });

  it.each([
    { label: "status flag", args: ["models", "status", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "status"] },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expectCommandOptions(modelsStatusCommand, { agent: "poe" });
  });

  it.each([
    { label: "list flag", args: ["models", "list", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "list"] },
  ])("passes --agent to models list ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expectCommandOptions(mocks.modelsListCommand, { agent: "poe" });
  });

  it.each([
    {
      label: "add",
      args: ["models", "auth", "--agent", "poe", "add"],
      command: modelsAuthAddCommand,
      expected: { agent: "poe" },
    },
    {
      label: "list",
      args: ["models", "auth", "--agent", "poe", "list", "--provider", "openai"],
      command: modelsAuthListCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "login",
      args: ["models", "auth", "--agent", "poe", "login", "--provider", "openai"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "logout",
      args: ["models", "auth", "--agent", "poe", "logout", "openai:manual", "--yes"],
      command: modelsAuthLogoutCommand,
      expected: { agent: "poe", profileId: "openai:manual", yes: true },
    },
    {
      label: "setup-token",
      args: ["models", "auth", "--agent", "poe", "setup-token", "--provider", "anthropic"],
      command: modelsAuthSetupTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-token",
      args: ["models", "auth", "--agent", "poe", "paste-token", "--provider", "anthropic"],
      command: modelsAuthPasteTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-api-key",
      args: ["models", "auth", "--agent", "poe", "paste-api-key", "--provider", "openai"],
      command: modelsAuthPasteApiKeyCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "login-github-copilot",
      args: ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "github-copilot", method: "device", yes: true },
    },
  ])("passes parent --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it.each([
    {
      label: "add",
      args: ["models", "auth", "add", "--agent", "poe"],
      command: modelsAuthAddCommand,
      expected: { agent: "poe" },
    },
    {
      label: "list",
      args: ["models", "auth", "list", "--provider", "openai", "--agent", "poe"],
      command: modelsAuthListCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "login",
      args: ["models", "auth", "login", "--provider", "openai", "--agent", "poe"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "logout",
      args: ["models", "auth", "logout", "openai:manual", "--yes", "--agent", "poe"],
      command: modelsAuthLogoutCommand,
      expected: { agent: "poe", profileId: "openai:manual", yes: true },
    },
    {
      label: "setup-token",
      args: ["models", "auth", "setup-token", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthSetupTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-token",
      args: ["models", "auth", "paste-token", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthPasteTokenCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "paste-api-key",
      args: ["models", "auth", "paste-api-key", "--provider", "openai", "--agent", "poe"],
      command: modelsAuthPasteApiKeyCommand,
      expected: { agent: "poe", provider: "openai" },
    },
    {
      label: "login-github-copilot",
      args: ["models", "auth", "login-github-copilot", "--agent", "poe", "--yes"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "github-copilot", method: "device", yes: true },
    },
    {
      label: "order get",
      args: ["models", "auth", "order", "get", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthOrderGetCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
    {
      label: "order set",
      args: [
        "models",
        "auth",
        "order",
        "set",
        "--provider",
        "anthropic",
        "anthropic:first",
        "anthropic:second",
        "--agent",
        "poe",
      ],
      command: modelsAuthOrderSetCommand,
      expected: {
        agent: "poe",
        provider: "anthropic",
        order: ["anthropic:first", "anthropic:second"],
      },
    },
    {
      label: "order clear",
      args: ["models", "auth", "order", "clear", "--provider", "anthropic", "--agent", "poe"],
      command: modelsAuthOrderClearCommand,
      expected: { agent: "poe", provider: "anthropic" },
    },
  ])("passes leaf --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expectCommandOptions(command, expected);
  });

  it("prefers leaf --agent when both models auth forms are present", async () => {
    await runModelsCommand([
      "models",
      "auth",
      "--agent",
      "parent",
      "login",
      "--agent",
      "leaf",
      "--provider",
      "openai",
    ]);

    expectCommandOptions(modelsAuthLoginCommand, {
      agent: "leaf",
      provider: "openai",
    });
  });

  it("passes --method through models auth login", async () => {
    await runModelsCommand([
      "models",
      "auth",
      "login",
      "--provider",
      "openai",
      "--method",
      "api-key",
    ]);

    expectCommandOptions(modelsAuthLoginCommand, {
      provider: "openai",
      method: "api-key",
    });
  });

  it("maps --device-code to the provider device-code auth method", async () => {
    await runModelsCommand(["models", "auth", "login", "--provider", "openai", "--device-code"]);

    expectCommandOptions(modelsAuthLoginCommand, {
      provider: "openai",
      method: "device-code",
    });
  });

  it("passes list-specific --agent and --json to models auth list", async () => {
    await runModelsCommand(["models", "auth", "list", "--agent", "poe", "--json"]);

    expectCommandOptions(modelsAuthListCommand, { agent: "poe", json: true });
  });

  it.each([
    {
      label: "set",
      args: ["models", "--agent", "poe", "set", "anthropic/claude-sonnet-4-6"],
      command: modelsSetCommand,
    },
    {
      label: "set-image",
      args: ["models", "--agent", "poe", "set-image", "openai/gpt-image-1"],
      command: modelsSetImageCommand,
    },
  ])("rejects parent --agent for models $label", async ({ args, command }) => {
    await expect(runModelsCommand(args)).rejects.toThrow("does not support --agent");

    expect(command).not.toHaveBeenCalled();
  });

  // `aliases` and `scan` only ever touch `agents.defaults`, so --agent was accepted
  // and ignored here -- including an id that does not exist -- while every other
  // --agent-aware models subcommand validated it (#126597). Unlike `set`, these run
  // inside the CLI error wrapper, so the guard surfaces as a formatted operator
  // error rather than an unhandled throw.
  //
  // One row per subcommand, carrying its own leaf spy, so the rejected case and
  // the unscoped case can never end up describing different commands.
  const globalOnlyModelsCommands = [
    { label: "aliases list", leaf: modelsAliasesListCommand, args: ["aliases", "list"] },
    {
      label: "aliases add",
      leaf: modelsAliasesAddCommand,
      args: ["aliases", "add", "zzz", "soraka/grok-4.6"],
    },
    {
      label: "aliases remove",
      leaf: modelsAliasesRemoveCommand,
      args: ["aliases", "remove", "zzz"],
    },
    { label: "scan", leaf: modelsScanCommand, args: ["scan", "--no-probe", "--no-input"] },
  ];

  it.each(globalOnlyModelsCommands)(
    "reports parent --agent as an operator error for models $label",
    async ({ label, leaf, args }) => {
      const errorWrites = captureRuntimeErrors();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      // `defaultRuntime.exit` calls process.exit and then throws a sentinel so the
      // path stays unreachable when process.exit is mocked (src/runtime.ts).
      await expect(runModelsCommand(["models", "--agent", "poe", ...args])).rejects.toThrow(
        "unreachable",
      );

      const stderr = errorWrites.join(" ");
      expect(stderr).toContain("does not support --agent");
      // The message has to name the subcommand it rejected, or a copy-paste that
      // guards `scan` while reporting `set` reads as correct.
      expect(stderr).toContain(`openclaw models ${label}`);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(leaf).not.toHaveBeenCalled();
    },
  );

  it.each(globalOnlyModelsCommands)(
    "still runs models $label without --agent",
    async ({ leaf, args }) => {
      await runModelsCommand(["models", ...args]);

      // Exactly once, on this row's own leaf: a shared spy would already be
      // called from an earlier row, and the guard must not grow into a blanket
      // refusal or a double dispatch.
      expect(leaf).toHaveBeenCalledTimes(1);
    },
  );

  it("shows help for models auth without error exit", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    registerModelsCli(program);

    try {
      await program.parseAsync(["models", "auth"], { from: "user" });
      expect.fail("expected help to exit");
    } catch (err) {
      const error = err as { exitCode?: number };
      expect(error.exitCode).toBe(0);
    }
  });
});
