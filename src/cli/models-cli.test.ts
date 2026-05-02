import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";

const mocks = vi.hoisted(() => ({
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetCommand: vi.fn().mockResolvedValue(undefined),
  modelsSetImageCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  modelsAuthAddCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthPasteTokenCommand: vi.fn().mockResolvedValue(undefined),
  modelsAuthSetupTokenCommand: vi.fn().mockResolvedValue(undefined),
}));

const {
  modelsAuthAddCommand,
  modelsAuthLoginCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  modelsSetCommand,
  modelsSetImageCommand,
  modelsStatusCommand,
} = mocks;

vi.mock("../commands/models/list.list-command.js", () => ({
  modelsListCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/list.status-command.js", () => ({
  modelsStatusCommand: mocks.modelsStatusCommand,
}));
vi.mock("../commands/models/auth.js", () => ({
  modelsAuthAddCommand: mocks.modelsAuthAddCommand,
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
  modelsAuthPasteTokenCommand: mocks.modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand: mocks.modelsAuthSetupTokenCommand,
}));
vi.mock("../commands/models/auth-order.js", () => ({
  modelsAuthOrderClearCommand: mocks.noopAsync,
  modelsAuthOrderGetCommand: mocks.noopAsync,
  modelsAuthOrderSetCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/aliases.js", () => ({
  modelsAliasesAddCommand: mocks.noopAsync,
  modelsAliasesListCommand: mocks.noopAsync,
  modelsAliasesRemoveCommand: mocks.noopAsync,
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
  modelsScanCommand: mocks.noopAsync,
}));
vi.mock("../commands/models/set.js", () => ({
  modelsSetCommand: mocks.modelsSetCommand,
}));
vi.mock("../commands/models/set-image.js", () => ({
  modelsSetImageCommand: mocks.modelsSetImageCommand,
}));

describe("models cli", () => {
  beforeEach(() => {
    modelsAuthAddCommand.mockClear();
    modelsAuthLoginCommand.mockClear();
    modelsAuthPasteTokenCommand.mockClear();
    modelsAuthSetupTokenCommand.mockClear();
    modelsSetCommand.mockClear();
    modelsSetImageCommand.mockClear();
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: registerModelsCli as (program: Command) => void,
      argv: args,
    });
  }

  it("registers github-copilot login command", async () => {
    const program = createProgram();
    const models = program.commands.find((cmd) => cmd.name() === "models");
    expect(models).toBeTruthy();

    const auth = models?.commands.find((cmd) => cmd.name() === "auth");
    expect(auth).toBeTruthy();

    const login = auth?.commands.find((cmd) => cmd.name() === "login-github-copilot");
    expect(login).toBeTruthy();

    await program.parseAsync(
      ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      { from: "user" },
    );

    expect(modelsAuthLoginCommand).toHaveBeenCalledTimes(1);
    expect(modelsAuthLoginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        method: "device",
        yes: true,
        agent: "poe",
      }),
      expect.any(Object),
    );
  });

  it.each([
    { label: "status flag", args: ["models", "status", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "status"] },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });

  it.each([
    {
      label: "add",
      args: ["models", "auth", "--agent", "poe", "add"],
      command: modelsAuthAddCommand,
      expected: { agent: "poe" },
    },
    {
      label: "login",
      args: ["models", "auth", "--agent", "poe", "login", "--provider", "openai-codex"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "openai-codex" },
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
      label: "login-github-copilot",
      args: ["models", "auth", "--agent", "poe", "login-github-copilot", "--yes"],
      command: modelsAuthLoginCommand,
      expected: { agent: "poe", provider: "github-copilot", method: "device", yes: true },
    },
  ])("passes parent --agent to models auth $label", async ({ args, command, expected }) => {
    await runModelsCommand(args);

    expect(command).toHaveBeenCalledWith(expect.objectContaining(expected), expect.any(Object));
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
    await expect(runModelsCommand(args)).rejects.toThrow("does not support `--agent`");

    expect(command).not.toHaveBeenCalled();
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
