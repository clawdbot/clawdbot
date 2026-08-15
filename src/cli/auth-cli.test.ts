// Auth CLI tests cover top-level model auth shortcuts.
import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerAuthCli } from "./auth-cli.js";

const mocks = vi.hoisted(() => ({
  defaultRuntime: { id: "test-runtime" },
  modelsAuthListCommand: vi.fn().mockResolvedValue(undefined),
  runModelsCommand: vi.fn(async (action: () => Promise<void>) => action()),
  resolveModelAgentOption: vi.fn((command?: Command, opts?: { agent?: unknown }) => {
    for (let current: Command | null | undefined = command; current; current = current.parent) {
      const value = current.opts<{ agent?: unknown }>().agent;
      if (typeof value === "string") {
        return value;
      }
    }
    return typeof opts?.agent === "string" ? opts.agent : undefined;
  }),
}));

const { defaultRuntime, modelsAuthListCommand, resolveModelAgentOption, runModelsCommand } = mocks;

vi.mock("./models-cli.runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
  runModelsCommand: mocks.runModelsCommand,
  resolveModelAgentOption: mocks.resolveModelAgentOption,
}));

vi.mock("../commands/models/auth-list.js", () => ({
  modelsAuthListCommand: mocks.modelsAuthListCommand,
}));

describe("auth cli", () => {
  beforeEach(() => {
    modelsAuthListCommand.mockClear();
    resolveModelAgentOption.mockClear();
    runModelsCommand.mockClear();
  });

  async function runAuthCommand(args: string[]) {
    await runRegisteredCli({
      register: registerAuthCli as (program: Command) => void,
      argv: args,
    });
  }

  it("routes auth list to the model auth list command", async () => {
    await runAuthCommand(["auth", "list", "--provider", "openai", "--json"]);

    expect(runModelsCommand).toHaveBeenCalledTimes(1);
    expect(modelsAuthListCommand).toHaveBeenCalledWith(
      { provider: "openai", agent: undefined, json: true },
      defaultRuntime,
    );
  });

  it.each([
    {
      label: "parent",
      args: ["auth", "--agent", "poe", "list", "--provider", "openai"],
    },
    {
      label: "list",
      args: ["auth", "list", "--agent", "poe", "--provider", "openai"],
    },
  ])("passes $label --agent to auth list", async ({ args }) => {
    await runAuthCommand(args);

    expect(resolveModelAgentOption).toHaveBeenCalledTimes(1);
    expect(modelsAuthListCommand).toHaveBeenCalledWith(
      { provider: "openai", agent: "poe", json: false },
      defaultRuntime,
    );
  });
});
