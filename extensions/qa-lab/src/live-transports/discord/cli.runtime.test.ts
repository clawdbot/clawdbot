// QA Lab Discord tests cover CLI delegation into the shared suite host.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));
vi.mock("../shared/live-transport-cli.runtime.js", () => ({
  resolveLiveTransportQaRunOptions: (opts: Record<string, unknown>) => ({
    ...opts,
    repoRoot: "/resolved-repo",
    outputDir: "/resolved-repo/.artifacts/resolved",
    providerMode: opts.providerMode ?? "mock-openai",
  }),
}));

import { runQaDiscordCommand } from "./cli.runtime.js";
import { DISCORD_QA_DEFAULT_SCENARIO_IDS } from "./profiles.js";

describe("QA Lab Discord CLI runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the default profile into the Discord adapter host", async () => {
    await runQaDiscordCommand({
      repoRoot: "/repo",
      outputDir: ".artifacts/discord",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      credentialSource: "convex",
      credentialRole: "ci",
      sutAccountId: "discord-sut",
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/discord",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      channelDriver: "live",
      channel: "discord",
      concurrency: 1,
      scenarioIds: [...DISCORD_QA_DEFAULT_SCENARIO_IDS],
      sutAccountId: "discord-sut",
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("lets explicit scenarios override profile selection", async () => {
    await runQaDiscordCommand({ scenarioIds: ["discord-voice-autojoin"] });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitScenarioSelection: true,
        scenarioIds: ["discord-voice-autojoin"],
      }),
    );
  });
});
