// Models CLI lazy tests cover lazy model command imports and registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("models cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./models-cli.runtime.js");
    vi.doUnmock("../commands/models/list.status-command.js");
    vi.doUnmock("../commands/models/accounts.js");
    vi.resetModules();
  });

  it.each([{ args: [] }, { args: ["accounts"] }, { args: ["accounts", "login"] }])(
    "renders $args help without importing the models runtime",
    async ({ args }) => {
      const runtimeLoaded = vi.fn();
      vi.doMock("./models-cli.runtime.js", () => {
        runtimeLoaded();
        return {
          defaultRuntime: {},
          rejectAgentScopedModelCommand: vi.fn(),
          resolveModelAgentOption: vi.fn(),
          runModelsCommand: vi.fn(),
        };
      });

      const { registerModelsCli } = await import("./models-cli.js");
      const program = new Command();
      const writeOut = vi.fn();
      program.exitOverride();
      program.configureOutput({
        writeErr: () => {},
        writeOut,
      });
      registerModelsCli(program);

      await expect(
        program.parseAsync(["models", ...args, "--help"], { from: "user" }),
      ).rejects.toMatchObject({
        exitCode: 0,
      });
      expect(runtimeLoaded).not.toHaveBeenCalled();
      if (args.length === 1 && args[0] === "accounts") {
        const help = writeOut.mock.calls.map(([text]) => String(text)).join("");
        expect(help).toContain("login");
        expect(help).not.toContain("connect <provider>");
      }
    },
  );

  it("loads the models runtime for command actions", async () => {
    const defaultRuntime = {};
    const modelsStatusCommand = vi.fn().mockResolvedValue(undefined);
    const runModelsCommand = vi.fn(async (action: () => Promise<void>) => {
      await action();
    });
    const resolveModelAgentOption = vi.fn(() => "poe");
    const runtimeLoaded = vi.fn();

    vi.doMock("./models-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        defaultRuntime,
        rejectAgentScopedModelCommand: vi.fn(),
        resolveModelAgentOption,
        runModelsCommand,
      };
    });
    vi.doMock("../commands/models/list.status-command.js", () => ({
      modelsStatusCommand,
    }));

    const { registerModelsCli } = await import("./models-cli.js");
    const program = new Command();
    registerModelsCli(program);

    await program.parseAsync(["models", "status", "--json"], { from: "user" });

    expect(runtimeLoaded).toHaveBeenCalledTimes(1);
    expect(runModelsCommand).toHaveBeenCalledTimes(1);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe", json: true }),
      defaultRuntime,
    );
  });

  it.each([
    { args: [], selection: { provider: undefined, method: undefined } },
    { args: ["xai", "--method", "api-key"], selection: { provider: "xai", method: "api-key" } },
  ])(
    "dispatches catalog-based personal login $args without the retired connect spelling",
    async ({ args, selection }) => {
      const defaultRuntime = {};
      const modelsAccountsLoginCommand = vi.fn().mockResolvedValue(undefined);
      vi.doMock("./models-cli.runtime.js", () => ({
        defaultRuntime,
        resolveModelAgentOption: () => undefined,
        runModelsCommand: async (action: () => Promise<void>) => await action(),
      }));
      vi.doMock("../commands/models/accounts.js", () => ({ modelsAccountsLoginCommand }));

      const { registerModelsCli } = await import("./models-cli.js");
      const program = new Command()
        .enablePositionalOptions()
        .exitOverride()
        .configureOutput({ writeErr: () => {}, writeOut: () => {} });
      registerModelsCli(program);

      await program.parseAsync(
        ["models", "accounts", "login", ...args, "--url", "wss://personal.example", "--json"],
        { from: "user" },
      );
      expect(modelsAccountsLoginCommand).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ ...selection, url: "wss://personal.example", json: true }),
        defaultRuntime,
      );
      await expect(
        program.parseAsync(["models", "accounts", "connect", "openai"], { from: "user" }),
      ).rejects.toMatchObject({ exitCode: 1 });
    },
  );
});
