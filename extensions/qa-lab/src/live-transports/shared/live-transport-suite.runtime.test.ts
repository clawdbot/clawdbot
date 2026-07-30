import { beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));

import { runLiveTransportQaSuiteCommand } from "./live-transport-suite.runtime.js";

describe("live transport suite runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes one live command into the shared suite host", async () => {
    await runLiveTransportQaSuiteCommand({
      channelId: "slack",
      defaultProviderMode: "live-frontier",
      options: {
        repoRoot: "/repo",
        outputDir: ".artifacts/slack",
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5-alt",
        fastMode: true,
        allowFailures: true,
        failFast: true,
        credentialSource: " convex ",
        credentialRole: " ci ",
        sutAccountId: "slack-sut",
      },
      selectScenarioIds: ({ providerMode, scenarioIds }) => {
        expect(providerMode).toBe("live-frontier");
        expect(scenarioIds).toBeUndefined();
        return ["slack-canary"];
      },
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      repoRoot: "/repo",
      outputDir: ".artifacts/slack",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      channelDriver: "live",
      channel: "slack",
      concurrency: 1,
      scenarioIds: ["slack-canary"],
      sutAccountId: "slack-sut",
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("preserves explicit scenario selection after resolving defaults", async () => {
    await runLiveTransportQaSuiteCommand({
      channelId: "whatsapp",
      defaultProviderMode: "live-frontier",
      options: { scenarioIds: ["whatsapp-help-command"] },
      selectScenarioIds: ({ scenarioIds }) => [...(scenarioIds ?? [])],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitScenarioSelection: true,
        scenarioIds: ["whatsapp-help-command"],
      }),
    );
  });

  it("rejects shared credentials for disposable transports", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        envCredentialReason: "its homeserver is disposable and local.",
        laneLabel: "Matrix",
        options: { credentialSource: "convex" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow(
      "QA Lab Matrix supports only --credential-source env because its homeserver is disposable and local.",
    );
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        laneLabel: "Matrix",
        options: { credentialRole: "ci" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("QA Lab Matrix does not use credential roles.");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "discord",
        defaultProviderMode: "live-frontier",
        options: { providerMode: "unknown" },
        selectScenarioIds: () => ["discord-canary"],
      }),
    ).rejects.toThrow("unknown QA provider mode: unknown");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
