import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("models cli lazy runtime boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./models-cli.runtime.js");
    vi.doUnmock("../commands/models/list.status-command.js");
    vi.resetModules();
  });

  it("renders help without importing the models runtime", async () => {
    const runtimeLoaded = vi.fn();
    vi.doMock("./models-cli.runtime.js", () => {
      runtimeLoaded();
      return {
        defaultRuntime: {},
        rejectAgentScopedModelWrite: vi.fn(),
        resolveModelAgentOption: vi.fn(),
        runModelsCommand: vi.fn(),
      };
    });

    const { registerModelsCli } = await import("./models-cli.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    });
    registerModelsCli(program);

    await expect(program.parseAsync(["models", "--help"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });
    expect(runtimeLoaded).not.toHaveBeenCalled();
  });

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
        rejectAgentScopedModelWrite: vi.fn(),
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
});
