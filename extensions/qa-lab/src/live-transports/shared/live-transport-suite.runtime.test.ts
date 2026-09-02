import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());
const loadMatrixQaE2eeRuntime = vi.hoisted(() => vi.fn());
const resolveLiveTransportQaScenarioIds = vi.hoisted(() => vi.fn());
const runFlowWorkers = vi.hoisted(() => vi.fn());

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));
vi.mock("../matrix/substrate/e2ee-client.js", () => ({ loadMatrixQaE2eeRuntime }));
vi.mock("../../suite-run-standard.js", () => ({ runQaFlowSuiteStandard: runFlowWorkers }));
vi.mock("../../suite-run-isolated.js", () => ({ runQaFlowSuiteIsolated: runFlowWorkers }));
vi.mock("./scenario-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-selection.js")>()),
  resolveLiveTransportQaScenarioIds,
}));

import { runQaSuite } from "../../suite-launch.runtime.js";
import type { QaSuiteResolvedRunContext } from "../../suite-types.js";
import type { QaSuiteRunParams } from "../../suite.js";
import { matrixQaCliRegistration } from "../matrix/cli.js";
import {
  runLiveTransportQaSuiteCommand,
  runStandardLiveTransportQaSuiteCommand,
} from "./live-transport-suite.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("live transport suite runtime", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", "");
    vi.clearAllMocks();
    runQaSuiteCommand.mockReset();
    loadMatrixQaE2eeRuntime.mockReset();
    resolveLiveTransportQaScenarioIds.mockReset();
    runFlowWorkers.mockReset();
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

  it.each([
    ["dedicated", "ready"],
    ["dedicated", "failed"],
    ["generic", "ready"],
    ["generic", "failed"],
    ["default selection", "ready"],
    ["default selection", "failed"],
    ["plain selection", "ready"],
  ] as const)("prepares %s Matrix flows before workers start (%s)", async (caller, outcome) => {
    vi.stubEnv("OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT", "1");
    const outputDir = tempDirs.make("matrix-suite-preparation-");
    const initialization = createDeferred<void>();
    const initializationStarted = createDeferred<void>();
    const workersStarted = createDeferred<void>();
    const failure = new Error("crypto initialization failed");
    const priorArtifacts = ["qa-suite-summary.json", "qa-evidence.json", "qa-suite-report.md"];
    if (outcome === "failed") {
      await fs.mkdir(path.join(outputDir, "proof"));
      await Promise.all(
        priorArtifacts.map((name) =>
          fs.writeFile(path.join(outputDir, "proof", name), "prior successful generation"),
        ),
      );
    }
    loadMatrixQaE2eeRuntime.mockImplementation(() => {
      initializationStarted.resolve();
      return initialization.promise;
    });
    runFlowWorkers.mockImplementation((_params, context: QaSuiteResolvedRunContext) => {
      workersStarted.resolve();
      const scenarioIds = context.selectedScenarios.map((scenario) => scenario.id);
      return {
        evidence: {
          kind: "openclaw.qa.evidence-summary",
          schemaVersion: 2,
          generatedAt: new Date().toISOString(),
          evidenceMode: "full",
          entries: [],
        },
        outputDir: context.outputDir,
        evidencePath: path.join(context.outputDir, "qa-evidence.json"),
        reportPath: path.join(context.outputDir, "qa-suite-report.md"),
        summaryPath: path.join(context.outputDir, "qa-suite-summary.json"),
        report: "# QA Suite Report\n",
        scenarios: scenarioIds.map((name) => ({ name, status: "pass", steps: [] })),
        startedScenarioIds: scenarioIds,
        watchUrl: "http://127.0.0.1:43124",
      };
    });
    const scenarioIds = [
      "matrix-allowbots-default-block",
      "matrix-e2ee-cli-account-add-enable-e2ee",
      "matrix-approval-channel-target-both",
    ];
    const params: QaSuiteRunParams = {
      repoRoot: outputDir,
      outputDir: path.join(outputDir, "proof"),
      providerMode: "mock-openai",
      channelDriver: "live",
      channelId: "matrix",
      adapterFactories: [matrixQaCliRegistration.adapterFactory!],
      concurrency: 4,
      scenarioIds:
        caller === "default selection"
          ? undefined
          : caller === "plain selection"
            ? ["matrix-allowbots-default-block"]
            : scenarioIds,
    };
    runQaSuiteCommand.mockImplementation((options) =>
      runQaSuite({ ...params, scenarioIds: options.scenarioIds }),
    );
    const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    matrixQaCliRegistration.register(qa);
    const run =
      caller === "dedicated"
        ? qa.parseAsync([
            "node",
            "openclaw",
            "matrix",
            "--provider-mode",
            "mock-openai",
            ...scenarioIds.flatMap((id) => ["--scenario", id]),
          ])
        : runQaSuite(params);
    const settled = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const first = await Promise.race([
        initializationStarted.promise.then(() => "initialization"),
        workersStarted.promise.then(() => "workers"),
        settled.then((error) => {
          if (error instanceof Error) {
            throw error;
          }
          expect(error).toBeUndefined();
          return "settled";
        }),
      ]);
      if (caller === "plain selection") {
        expect(first).toBe("workers");
        expect(await settled).toBeUndefined();
        expect(loadMatrixQaE2eeRuntime).not.toHaveBeenCalled();
      } else {
        expect(first).toBe("initialization");
        expect(runFlowWorkers).not.toHaveBeenCalled();
        if (outcome === "failed") {
          initialization.reject(failure);
          expect(await settled).toBe(failure);
          expect(runFlowWorkers).not.toHaveBeenCalled();
          for (const name of priorArtifacts) {
            await expect(fs.stat(path.join(outputDir, "proof", name))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        } else {
          initialization.resolve();
          expect(await settled).toBeUndefined();
          expect(runFlowWorkers).toHaveBeenCalled();
          expect(loadMatrixQaE2eeRuntime).toHaveBeenCalledOnce();
        }
      }
    } finally {
      initialization.resolve();
      await settled;
    }
  });

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

  it.each([
    { channelId: "discord", scenarioId: "discord-canary" },
    { channelId: "slack", scenarioId: "slack-canary" },
    { channelId: "whatsapp", scenarioId: "whatsapp-canary" },
  ])(
    "propagates the exact $channelId selection context through the standard suite owner",
    async ({ channelId, scenarioId }) => {
      resolveLiveTransportQaScenarioIds.mockReturnValueOnce([scenarioId]);

      await runStandardLiveTransportQaSuiteCommand({
        channelId,
        options: {
          primaryModel: "openai/custom-selection-model",
          profile: "all",
          providerMode: "mock-openai",
          scenarioIds: [scenarioId, scenarioId],
        },
      });

      expect(resolveLiveTransportQaScenarioIds).toHaveBeenLastCalledWith({
        channelId,
        primaryModel: "openai/custom-selection-model",
        profile: "all",
        providerMode: "mock-openai",
        scenarioIds: [scenarioId, scenarioId],
        supportsModuleFlows: true,
      });
      expect(runQaSuiteCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          channel: channelId,
          primaryModel: "openai/custom-selection-model",
          providerMode: "mock-openai",
          scenarioIds: [scenarioId],
        }),
      );
    },
  );

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
