import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));

import { matrixQaCliRegistration } from "../matrix/cli.js";
import { runLiveTransportQaSuiteCommand } from "./live-transport-suite.runtime.js";

describe("live transport suite runtime", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", "");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, 1, 2])(
    "forwards the dedicated Matrix concurrency %s through parsing and the live suite host",
    async (concurrency) => {
      vi.stubEnv("OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT", "1");
      const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      matrixQaCliRegistration.register(qa);

      await qa.parseAsync([
        "node",
        "openclaw",
        "matrix",
        "--provider-mode",
        "mock-openai",
        "--scenario",
        "matrix-allowlist-hot-reload",
        ...(concurrency === undefined ? [] : ["--concurrency", String(concurrency)]),
      ]);

      expect(runQaSuiteCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          channelDriver: "live",
          channel: "matrix",
          scenarioIds: ["matrix-allowlist-hot-reload"],
          ...(concurrency === undefined ? {} : { concurrency }),
        }),
      );
      if (concurrency === undefined) {
        expect(runQaSuiteCommand.mock.calls[0]?.[0]).not.toHaveProperty("concurrency");
      }
    },
  );

  it.each(["0", "1.5", "2junk"])(
    "rejects invalid dedicated Matrix concurrency %s before suite dispatch",
    async (concurrency) => {
      vi.stubEnv("OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT", "1");
      const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
      matrixQaCliRegistration.register(qa);

      await expect(
        qa.parseAsync(["node", "openclaw", "matrix", "--concurrency", concurrency]),
      ).rejects.toThrow("--concurrency must be a positive integer.");
      expect(runQaSuiteCommand).not.toHaveBeenCalled();
    },
  );

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
