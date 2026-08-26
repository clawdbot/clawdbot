// Models CLI tests cover model listing command registration and provider output.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";
import { isModelsPlainMachineOutput, isModelsStatusJsonOutput } from "./models-output-mode.js";
import { isCommandJsonOutputMode } from "./program/json-mode.js";

const mocks = vi.hoisted(() => ({
  modelsListCommand: vi.fn().mockResolvedValue(undefined),
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetImageCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  modelsAliasesAddCommand: vi.fn().mockResolvedValue(undefined),
  modelsAliasesListCommand: vi.fn().mockResolvedValue(undefined),
  modelsAliasesRemoveCommand: vi.fn().mockResolvedValue(undefined),
  modelsScanCommand: vi.fn().mockResolvedValue(undefined),
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
  modelsAliasesAddCommand,
  modelsAliasesListCommand,
  modelsAliasesRemoveCommand,
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
    modelsAliasesAddCommand.mockClear();
    modelsAliasesListCommand.mockClear();
    modelsAliasesRemoveCommand.mockClear();
    modelsScanCommand.mockClear();
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
    modelsSetCommand.mockClear();
    modelsSetImageCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    return program;
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

  it.each([
    ["aliases list --plain", ["models", "aliases", "list", "--plain"]],
    ["fallbacks list --plain", ["models", "fallbacks", "list", "--plain"]],
    ["image-fallbacks list --plain", ["models", "image-fallbacks", "list", "--plain"]],
    ["list --plain", ["models", "list", "--plain"]],
    ["status --plain", ["models", "status", "--plain"]],
    ["parent --status-plain", ["models", "--status-plain"]],
  ])("declares %s as plain machine output owning stdout", (_label, args) => {
    const argv = ["node", "openclaw", ...args];
    expect(isModelsPlainMachineOutput(argv)).toBe(true);
  });

  it.each([
    ["list (no flag)", ["models", "list"]],
    ["status --json", ["models", "status", "--json"]],
    ["parent --status-json", ["models", "--status-json"]],
    ["aliases list", ["models", "aliases", "list"]],
    ["logs --plain", ["logs", "--plain"]],
    ["secrets store list --plain", ["secrets", "store", "list", "--plain"]],
    ["secrets store get --plain", ["secrets", "store", "get", "EXAMPLE", "--plain"]],
    ["plain after argv terminator", ["models", "list", "--", "--plain"]],
  ])("does not declare %s as plain machine output", (_label, args) => {
    const argv = ["node", "openclaw", ...args];
    expect(isModelsPlainMachineOutput(argv)).toBe(false);
  });

  it("does not turn plain output into JSON failure envelope", async () => {
    const program = createProgram();
    let jsonMode = true;
    program.hook("preAction", (_command, actionCommand) => {
      jsonMode = isCommandJsonOutputMode(actionCommand, process.argv);
    });

    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "models", "aliases", "list", "--plain"];
    try {
      await program.parseAsync(["models", "aliases", "list", "--plain"], { from: "user" });
    } finally {
      process.argv = originalArgv;
    }

    // Plain owns stdout for log routing but must not activate the JSON failure envelope.
    expect(jsonMode).toBe(false);
    expect(isModelsStatusJsonOutput(process.argv)).toBe(false);
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
    {
      label: "aliases list",
      args: ["models", "--agent", "poe", "aliases", "list"],
      command: modelsAliasesListCommand,
    },
    {
      label: "aliases add",
      args: ["models", "--agent", "poe", "aliases", "add", "zzz", "soraka/grok-4.6"],
      command: modelsAliasesAddCommand,
    },
    {
      label: "aliases remove",
      args: ["models", "--agent", "poe", "aliases", "remove", "zzz"],
      command: modelsAliasesRemoveCommand,
    },
    {
      label: "scan",
      args: ["models", "--agent", "poe", "scan", "--no-probe", "--no-input"],
      command: modelsScanCommand,
    },
  ])("rejects parent --agent for models $label", async ({ args, command }) => {
    await expect(runModelsCommand(args)).rejects.toThrow("does not support --agent");

    expect(command).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "aliases list",
      args: ["models", "aliases", "list"],
      command: modelsAliasesListCommand,
    },
    {
      label: "scan",
      args: ["models", "scan", "--no-probe", "--no-input"],
      command: modelsScanCommand,
    },
  ])("still runs models $label without --agent", async ({ args, command }) => {
    await runModelsCommand(args);

    expect(command).toHaveBeenCalled();
  });

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
