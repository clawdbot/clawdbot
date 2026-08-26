import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));

import { runLiveTransportQaSuiteCommand } from "./live-transport-suite.runtime.js";

describe("live transport suite runtime", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", "");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
        credentialFile: "/secure/slack-qa.json",
        credentialSource: " convex ",
        credentialRole: " ci ",
        sutAccountId: "slack-sut",
      },
      selectScenarioIds: ({ primaryModel, providerMode, scenarioIds }) => {
        expect(primaryModel).toBe("openai/gpt-5.5");
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
      credentialFile: "/secure/slack-qa.json",
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

  it("normalizes the shared credential source environment override", async () => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", " convex ");

    await runLiveTransportQaSuiteCommand({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options: {},
      selectScenarioIds: () => ["channel-canary"],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "convex" }),
    );
  });

  it.each([undefined, "live"] as const)(
    "keeps the Discord live driver identical when selected as %s",
    async (channelDriver) => {
      const selectScenarioIds = vi.fn(() => ["discord-canary"]);

      await runLiveTransportQaSuiteCommand({
        channelId: "discord",
        defaultProviderMode: "live-frontier",
        options: { channelDriver },
        selectScenarioIds,
      });

      expect(selectScenarioIds).toHaveBeenCalledWith(
        expect.objectContaining({ channelDriver: "live" }),
      );
      expect(runQaSuiteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "discord",
          channelDriver: "live",
          scenarioIds: ["discord-canary"],
        }),
      );
    },
  );

  it("selects Discord Crabline without forwarding credential lease options", async () => {
    const selectScenarioIds = vi.fn(() => ["discord-crabline-roundtrip"]);

    await runLiveTransportQaSuiteCommand({
      channelId: "discord",
      defaultProviderMode: "live-frontier",
      options: {
        channelDriver: "crabline",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/custom",
      },
      selectScenarioIds,
    });

    expect(selectScenarioIds).toHaveBeenCalledWith({
      channelDriver: "crabline",
      profile: undefined,
      primaryModel: "mock-openai/custom",
      providerMode: "mock-openai",
      scenarioIds: undefined,
    });
    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        channelDriver: "crabline",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/custom",
        scenarioIds: ["discord-crabline-roundtrip"],
      }),
    );
    expect(runQaSuiteCommand.mock.calls[0]?.[0]).not.toHaveProperty("credentialSource");
    expect(runQaSuiteCommand.mock.calls[0]?.[0]).not.toHaveProperty("credentialRole");
  });

  it("uses the same Discord selection for listing and execution", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const selectScenarioIds = vi.fn((_selection: unknown) => [
      "channel-canary",
      "thread-follow-up",
    ]);
    const base = {
      channelId: "discord",
      defaultProviderMode: "mock-openai" as const,
      selectScenarioIds,
    };

    try {
      await runLiveTransportQaSuiteCommand({
        ...base,
        options: { channelDriver: "crabline", listScenarios: true },
      });
      await runLiveTransportQaSuiteCommand({
        ...base,
        options: { channelDriver: "crabline" },
      });
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(selectScenarioIds).toHaveBeenCalledTimes(2);
    expect(selectScenarioIds.mock.calls[0]?.[0]).toEqual(selectScenarioIds.mock.calls[1]?.[0]);
    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: ["channel-canary", "thread-follow-up"] }),
    );
  });

  it.each(["credentialSource", "credentialRole"] as const)(
    "rejects Discord Crabline with %s",
    async (option) => {
      await expect(
        runLiveTransportQaSuiteCommand({
          channelId: "discord",
          defaultProviderMode: "mock-openai",
          options: { channelDriver: "crabline", [option]: "ci" },
          selectScenarioIds: () => ["channel-canary"],
        }),
      ).rejects.toThrow(
        `do not use --${option === "credentialSource" ? "credential-source" : "credential-role"}`,
      );
      expect(runQaSuiteCommand).not.toHaveBeenCalled();
    },
  );

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
