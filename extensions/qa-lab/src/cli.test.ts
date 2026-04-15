import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_QA_RUNNER = {
  pluginId: "qa-runner-test",
  commandName: "runner-test",
  description: "Run the test live QA lane",
} as const;

function createAvailableQaRunnerContribution() {
  return {
    pluginId: TEST_QA_RUNNER.pluginId,
    commandName: TEST_QA_RUNNER.commandName,
    status: "available" as const,
    registration: {
      commandName: TEST_QA_RUNNER.commandName,
      register: vi.fn((qa: Command) => {
        qa.command(TEST_QA_RUNNER.commandName).action(() => undefined);
      }),
    },
  } satisfies QaRunnerCliContribution;
}

function createBlockedQaRunnerContribution(): QaRunnerCliContribution {
  return {
    pluginId: TEST_QA_RUNNER.pluginId,
    commandName: TEST_QA_RUNNER.commandName,
    description: TEST_QA_RUNNER.description,
    status: "blocked",
  };
}

function createConflictingQaRunnerContribution(commandName: string): QaRunnerCliContribution {
  return {
    pluginId: TEST_QA_RUNNER.pluginId,
    commandName,
    description: TEST_QA_RUNNER.description,
    status: "blocked",
  };
}

const {
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
  runQaTelegramCommand,
} = vi.hoisted(() => ({
  runQaCredentialsAddCommand: vi.fn(),
  runQaCredentialsListCommand: vi.fn(),
  runQaCredentialsRemoveCommand: vi.fn(),
  runQaTelegramCommand: vi.fn(),
}));

const { listQaRunnerCliContributions } = vi.hoisted(() => ({
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(() => [
    createAvailableQaRunnerContribution(),
  ]),
}));

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  listQaRunnerCliContributions,
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
    runQaCredentialsAddCommand.mockReset();
    runQaCredentialsListCommand.mockReset();
    runQaCredentialsRemoveCommand.mockReset();
    runQaTelegramCommand.mockReset();
    listQaRunnerCliContributions
      .mockReset()
      .mockReturnValue([createAvailableQaRunnerContribution()]);
    registerQaLabCli(program);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers discovered and built-in live transport subcommands", () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    expect(qa).toBeDefined();
    expect(qa?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([TEST_QA_RUNNER.commandName, "telegram", "credentials"]),
    );
  });

  it("delegates discovered qa runner registration through the generic host seam", () => {
    const [{ registration }] = listQaRunnerCliContributions.mock.results[0]?.value;
    expect(registration.register).toHaveBeenCalledTimes(1);
  });

  it("keeps Telegram credential flags on the shared host CLI", () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    const telegram = qa?.commands.find((command) => command.name() === "telegram");
    const optionNames = telegram?.options.map((option) => option.long) ?? [];

    expect(optionNames).toEqual(
      expect.arrayContaining(["--credential-source", "--credential-role"]),
    );
  });

  it("shows an enable hint when a discovered runner plugin is installed but blocked", async () => {
    listQaRunnerCliContributions.mockReset().mockReturnValue([createBlockedQaRunnerContribution()]);
    const blockedProgram = new Command();
    registerQaLabCli(blockedProgram);

    await expect(
      blockedProgram.parseAsync(["node", "openclaw", "qa", TEST_QA_RUNNER.commandName]),
    ).rejects.toThrow(`Enable or allow plugin "${TEST_QA_RUNNER.pluginId}"`);
  });

  it("rejects discovered runners that collide with built-in qa subcommands", () => {
    listQaRunnerCliContributions
      .mockReset()
      .mockReturnValue([createConflictingQaRunnerContribution("manual")]);

    expect(() => registerQaLabCli(new Command())).toThrow(
      'QA runner command "manual" conflicts with an existing qa subcommand',
    );
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
