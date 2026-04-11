import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaMatrixCommand, runQaTelegramCommand } = vi.hoisted(() => ({
  runQaMatrixCommand: vi.fn(),
  runQaTelegramCommand: vi.fn(),
}));

vi.mock("./live-transports/matrix/cli.runtime.js", () => ({
  runQaMatrixCommand,
}));

vi.mock("./live-transports/telegram/cli.runtime.js", () => ({
  runQaTelegramCommand,
}));

import { registerQaLabCli } from "./cli.js";

describe("qa cli registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    registerQaLabCli(program);
    runQaMatrixCommand.mockReset();
    runQaTelegramCommand.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers the matrix and telegram live transport subcommands", () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    expect(qa).toBeDefined();
    expect(qa?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["matrix", "telegram"]),
    );
  });

  it("routes matrix CLI flags into the lane runtime", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "matrix",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output-dir",
      ".artifacts/qa/matrix",
      "--provider-mode",
      "mock-openai",
      "--model",
      "mock-openai/gpt-5.4",
      "--alt-model",
      "mock-openai/gpt-5.4-alt",
      "--scenario",
      "matrix-thread-follow-up",
      "--scenario",
      "matrix-thread-isolation",
      "--fast",
      "--sut-account",
      "sut-live",
    ]);

    expect(runQaMatrixCommand).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/matrix",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      fastMode: true,
      scenarioIds: ["matrix-thread-follow-up", "matrix-thread-isolation"],
      sutAccountId: "sut-live",
    });
  });

  it("routes telegram CLI defaults into the lane runtime", async () => {
    await program.parseAsync(["node", "openclaw", "qa", "telegram"]);

    expect(runQaTelegramCommand).toHaveBeenCalledWith({
      repoRoot: undefined,
      outputDir: undefined,
      providerMode: "live-frontier",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: false,
      scenarioIds: [],
      sutAccountId: "sut",
    });
  });
});
