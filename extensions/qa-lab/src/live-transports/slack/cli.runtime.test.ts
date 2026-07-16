// QA Lab Slack tests cover CLI delegation into the shared suite host.
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

import { runQaSlackCommand } from "./cli.runtime.js";
import { SLACK_QA_DEFAULT_SCENARIO_IDS } from "./profiles.js";

describe("QA Lab Slack CLI runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates the default profile into the Slack adapter host", async () => {
    await runQaSlackCommand({
      repoRoot: "/repo",
      outputDir: ".artifacts/slack",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      credentialSource: "convex",
      credentialRole: "ci",
      sutAccountId: "slack-sut",
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/slack",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      channelDriver: "live",
      channel: "slack",
      concurrency: 1,
      scenarioIds: [...SLACK_QA_DEFAULT_SCENARIO_IDS],
      sutAccountId: "slack-sut",
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("lets explicit scenarios override profile selection", async () => {
    await runQaSlackCommand({ scenarioIds: ["slack-codex-approval-exec-native"] });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitScenarioSelection: true,
        scenarioIds: ["slack-codex-approval-exec-native"],
      }),
    );
  });
});
