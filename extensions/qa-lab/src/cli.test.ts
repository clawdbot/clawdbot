import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
  runQaMatrixCommand,
  runQaTelegramCommand,
} = vi.hoisted(() => ({
  runQaCredentialsAddCommand: vi.fn(),
  runQaCredentialsListCommand: vi.fn(),
  runQaCredentialsRemoveCommand: vi.fn(),
  runQaMatrixCommand: vi.fn(),
  runQaTelegramCommand: vi.fn(),
}));

vi.mock("./live-transports/matrix/cli.runtime.js", () => ({
  runQaMatrixCommand,
}));

vi.mock("./live-transports/telegram/cli.runtime.js", () => ({
  runQaTelegramCommand,
}));

vi.mock("./cli.runtime.js", () => ({
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
}));

import { registerQaLabCli } from "./cli.js";

describe("qa cli registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    registerQaLabCli(program);
    runQaCredentialsAddCommand.mockReset();
    runQaCredentialsListCommand.mockReset();
    runQaCredentialsRemoveCommand.mockReset();
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
      expect.arrayContaining(["matrix", "telegram", "credentials"]),
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
      credentialSource: undefined,
      credentialRole: undefined,
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
      credentialSource: undefined,
      credentialRole: undefined,
    });
  });

  it("routes credential add flags into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "add",
      "--kind",
      "telegram",
      "--payload-file",
      "qa/payload.json",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--note",
      "shared lane",
      "--site-url",
      "https://first-schnauzer-821.convex.site",
      "--endpoint-prefix",
      "/qa-credentials/v1",
      "--actor-id",
      "maintainer-local",
      "--json",
    ]);

    expect(runQaCredentialsAddCommand).toHaveBeenCalledWith({
      kind: "telegram",
      payloadFile: "qa/payload.json",
      repoRoot: "/tmp/openclaw-repo",
      note: "shared lane",
      siteUrl: "https://first-schnauzer-821.convex.site",
      endpointPrefix: "/qa-credentials/v1",
      actorId: "maintainer-local",
      json: true,
    });
  });

  it("routes credential remove flags into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "remove",
      "--credential-id",
      "j57b8k419ba7bcsfw99rg05c9184p8br",
      "--site-url",
      "https://first-schnauzer-821.convex.site",
      "--actor-id",
      "maintainer-local",
      "--json",
    ]);

    expect(runQaCredentialsRemoveCommand).toHaveBeenCalledWith({
      credentialId: "j57b8k419ba7bcsfw99rg05c9184p8br",
      siteUrl: "https://first-schnauzer-821.convex.site",
      actorId: "maintainer-local",
      endpointPrefix: undefined,
      json: true,
    });
  });

  it("routes credential list defaults into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "credentials",
      "list",
      "--kind",
      "telegram",
    ]);

    expect(runQaCredentialsListCommand).toHaveBeenCalledWith({
      kind: "telegram",
      status: "all",
      limit: undefined,
      showSecrets: false,
      siteUrl: undefined,
      endpointPrefix: undefined,
      actorId: undefined,
      json: false,
    });
  });
});
