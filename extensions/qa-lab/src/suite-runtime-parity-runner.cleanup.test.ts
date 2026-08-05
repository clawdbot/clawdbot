import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner } from "./suite-types.js";

function createCleanupTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: createQaBusState(),
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

describe("runtime parity suite transport cleanup", () => {
  it("stops its owned lab and preserves the scenario error when transport cleanup fails", async () => {
    const lab = createCleanupTestLab();
    const scenarioError = new Error("runtime scenario failed");
    const cleanupError = new Error("credential release failed");
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    const factory: QaTransportAdapterFactory = {
      id: "leased",
      matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
      async create() {
        return {
          id: "leased",
          label: "Leased channel",
          accountId: "sut",
          requiredPluginIds: [],
          supportedActions: [],
          sendInbound: async (input) => lab.state.addInboundMessage(input),
          createGatewayConfig: () => ({}),
          async waitReady() {},
          buildAgentDelivery: ({ target }) => ({
            channel: "leased",
            to: target,
            replyChannel: "leased",
            replyTo: target,
          }),
          async handleAction() {},
          createReportNotes: () => [],
          cleanup,
        };
      },
    };
    const runChild = vi.fn<QaSuiteRunner>().mockRejectedValueOnce(scenarioError);

    await expect(
      runQaRuntimeParitySuite({
        runQaFlowSuite: runChild,
        adapterFactories: [factory],
        channelDriver: "live",
        channelId: "leased",
        repoRoot: "/qa-repo",
        outputDir: "/qa-output",
        startedAt: new Date("2026-08-04T00:00:00.000Z"),
        providerMode: "mock-openai",
        transportId: "qa-channel",
        primaryModel: "mock-openai/test-model",
        alternateModel: "mock-openai/test-model-alt",
        fastMode: true,
        concurrency: 1,
        selectedScenarios: [makeQaSuiteTestScenario("runtime-cleanup")],
        startLab: async () => lab,
        progressEnabled: false,
        runtimePair: ["openclaw", "codex"],
      }),
    ).rejects.toMatchObject({
      message: "QA suite and cleanup failed",
      cause: scenarioError,
      errors: [scenarioError, cleanupError],
    });

    expect(runChild).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
  });
});
