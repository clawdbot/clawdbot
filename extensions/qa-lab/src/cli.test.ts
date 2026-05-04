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
  runQaCoverageReportCommand,
  runQaProviderServerCommand,
  runQaSuiteCommand,
  runQaTelegramCommand,
  runMantisBeforeAfterCommand,
  runMantisDesktopBrowserSmokeCommand,
  runMantisDiscordSmokeCommand,
  runMantisSlackDesktopSmokeCommand,
} = vi.hoisted(() => ({
  runQaCredentialsAddCommand: vi.fn(),
  runQaCredentialsListCommand: vi.fn(),
  runQaCredentialsRemoveCommand: vi.fn(),
  runQaCoverageReportCommand: vi.fn(),
  runQaProviderServerCommand: vi.fn(),
  runQaSuiteCommand: vi.fn(),
  runQaTelegramCommand: vi.fn(),
  runMantisBeforeAfterCommand: vi.fn(),
  runMantisDesktopBrowserSmokeCommand: vi.fn(),
  runMantisDiscordSmokeCommand: vi.fn(),
  runMantisSlackDesktopSmokeCommand: vi.fn(),
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

vi.mock("./mantis/cli.runtime.js", () => ({
  runMantisBeforeAfterCommand,
  runMantisDesktopBrowserSmokeCommand,
  runMantisDiscordSmokeCommand,
  runMantisSlackDesktopSmokeCommand,
}));

vi.mock("./cli.runtime.js", () => ({
  runQaCredentialsAddCommand,
  runQaCredentialsListCommand,
  runQaCredentialsRemoveCommand,
  runQaCoverageReportCommand,
  runQaProviderServerCommand,
  runQaSuiteCommand,
}));

import { registerQaLabCli } from "./cli.js";

describe("qa cli registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    runQaCredentialsAddCommand.mockReset();
    runQaCredentialsListCommand.mockReset();
    runQaCredentialsRemoveCommand.mockReset();
    runQaCoverageReportCommand.mockReset();
    runQaProviderServerCommand.mockReset();
    runQaSuiteCommand.mockReset();
    runQaTelegramCommand.mockReset();
    runMantisBeforeAfterCommand.mockReset();
    runMantisDesktopBrowserSmokeCommand.mockReset();
    runMantisDiscordSmokeCommand.mockReset();
    runMantisSlackDesktopSmokeCommand.mockReset();
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
      expect.arrayContaining([
        TEST_QA_RUNNER.commandName,
        "telegram",
        "mantis",
        "credentials",
        "coverage",
      ]),
    );
  });

  it("routes mantis discord-smoke flags into the mantis runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "mantis",
      "discord-smoke",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output-dir",
      ".artifacts/qa-e2e/mantis/discord-smoke",
      "--guild-id",
      "123456789012345678",
      "--channel-id",
      "223456789012345678",
      "--token-file",
      "/tmp/mantis-token",
      "--message",
      "hello from mantis",
      "--skip-post",
    ]);

    expect(runMantisDiscordSmokeCommand).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-e2e/mantis/discord-smoke",
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      tokenEnv: undefined,
      tokenFile: "/tmp/mantis-token",
      tokenFileEnv: undefined,
      message: "hello from mantis",
      skipPost: true,
    });
  });

  it("routes mantis before/after flags into the mantis runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "mantis",
      "run",
      "--transport",
      "discord",
      "--scenario",
      "discord-status-reactions-tool-only",
      "--baseline",
      "origin/main",
      "--candidate",
      "HEAD",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output-dir",
      ".artifacts/qa-e2e/mantis/local-discord-status-reactions",
      "--credential-source",
      "convex",
      "--credential-role",
      "maintainer",
      "--skip-install",
      "--skip-build",
    ]);

    expect(runMantisBeforeAfterCommand).toHaveBeenCalledWith({
      baseline: "origin/main",
      candidate: "HEAD",
      credentialRole: "maintainer",
      credentialSource: "convex",
      fastMode: true,
      outputDir: ".artifacts/qa-e2e/mantis/local-discord-status-reactions",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      scenario: "discord-status-reactions-tool-only",
      skipBuild: true,
      skipInstall: true,
      transport: "discord",
    });
  });

  it("routes mantis desktop browser smoke flags into the mantis runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "mantis",
      "desktop-browser-smoke",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output-dir",
      ".artifacts/qa-e2e/mantis/desktop-browser",
      "--browser-url",
      "https://openclaw.ai/docs",
      "--html-file",
      "qa-artifacts/timeline.html",
      "--crabbox-bin",
      "/tmp/crabbox",
      "--provider",
      "hetzner",
      "--class",
      "beast",
      "--lease-id",
      "cbx_123abc",
      "--idle-timeout",
      "30m",
      "--ttl",
      "90m",
      "--keep-lease",
    ]);

    expect(runMantisDesktopBrowserSmokeCommand).toHaveBeenCalledWith({
      browserUrl: "https://openclaw.ai/docs",
      crabboxBin: "/tmp/crabbox",
      htmlFile: "qa-artifacts/timeline.html",
      idleTimeout: "30m",
      keepLease: true,
      leaseId: "cbx_123abc",
      machineClass: "beast",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser",
      provider: "hetzner",
      repoRoot: "/tmp/openclaw-repo",
      ttl: "90m",
    });
  });

  it("does not shadow mantis desktop browser runtime env defaults", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "mantis",
      "desktop-browser-smoke",
      "--repo-root",
      "/tmp/openclaw-repo",
    ]);

    expect(runMantisDesktopBrowserSmokeCommand).toHaveBeenCalledWith({
      browserUrl: undefined,
      crabboxBin: undefined,
      htmlFile: undefined,
      idleTimeout: undefined,
      keepLease: undefined,
      leaseId: undefined,
      machineClass: undefined,
      outputDir: undefined,
      provider: undefined,
      repoRoot: "/tmp/openclaw-repo",
      ttl: undefined,
    });
  });

  it("routes mantis Slack desktop smoke flags into the mantis runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "mantis",
      "slack-desktop-smoke",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output-dir",
      ".artifacts/qa-e2e/mantis/slack-desktop",
      "--crabbox-bin",
      "/tmp/crabbox",
      "--provider",
      "hetzner",
      "--machine-class",
      "beast",
      "--lease-id",
      "cbx_123abc",
      "--idle-timeout",
      "45m",
      "--ttl",
      "120m",
      "--slack-url",
      "https://app.slack.com/client/T123/C123",
      "--provider-mode",
      "live-frontier",
      "--model",
      "openai/gpt-5.4",
      "--alt-model",
      "openai/gpt-5.4",
      "--scenario",
      "slack-canary",
      "--credential-source",
      "env",
      "--credential-role",
      "maintainer",
      "--fast",
      "--keep-lease",
    ]);

    expect(runMantisSlackDesktopSmokeCommand).toHaveBeenCalledWith({
      alternateModel: "openai/gpt-5.4",
      crabboxBin: "/tmp/crabbox",
      credentialRole: "maintainer",
      credentialSource: "env",
      fastMode: true,
      gatewaySetup: undefined,
      idleTimeout: "45m",
      keepLease: true,
      leaseId: "cbx_123abc",
      machineClass: "beast",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop",
      primaryModel: "openai/gpt-5.4",
      provider: "hetzner",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["slack-canary"],
      slackChannelId: undefined,
      slackUrl: "https://app.slack.com/client/T123/C123",
      ttl: "120m",
    });
  });

  it("routes coverage report flags into the qa runtime command", async () => {
    await program.parseAsync([
      "node",
      "openclaw",
      "qa",
      "coverage",
      "--repo-root",
      "/tmp/openclaw-repo",
      "--output",
      ".artifacts/qa-coverage.md",
      "--json",
    ]);

    expect(runQaCoverageReportCommand).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      output: ".artifacts/qa-coverage.md",
      json: true,
    });
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

  it("registers standalone provider server commands from the provider registry", async () => {
    const qa = program.commands.find((command) => command.name() === "qa");
    expect(qa?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["mock-openai", "aimock"]),
    );

    await program.parseAsync(["node", "openclaw", "qa", "aimock", "--port", "44080"]);

    expect(runQaProviderServerCommand).toHaveBeenCalledWith("aimock", {
      host: "127.0.0.1",
      port: 44080,
    });
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
      allowFailures: false,
      scenarioIds: [],
      sutAccountId: "sut",
      credentialSource: undefined,
      credentialRole: undefined,
    });
  });

  it("forwards --allow-failures for telegram runs", async () => {
    await program.parseAsync(["node", "openclaw", "qa", "telegram", "--allow-failures"]);

    expect(runQaTelegramCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailures: true,
      }),
    );
  });

  it("forwards --allow-failures for suite runs", async () => {
    await program.parseAsync(["node", "openclaw", "qa", "suite", "--allow-failures"]);

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailures: true,
      }),
    );
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
