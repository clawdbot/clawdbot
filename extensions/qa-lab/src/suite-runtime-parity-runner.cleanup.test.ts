import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
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

type CleanupPhases = {
  cleanup?: () => Promise<void>;
  cleanupAfterGatewayStop?: () => Promise<void>;
};

function createCleanupTestFactory(
  lab: QaLabServerHandle,
  createCleanupPhases: () => CleanupPhases | Promise<CleanupPhases>,
): QaTransportAdapterFactory {
  return {
    id: "leased",
    matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
    async create() {
      const cleanupPhases = await createCleanupPhases();
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
        ...cleanupPhases,
      };
    },
  };
}

function runCleanupTestSuite(params: {
  factory: QaTransportAdapterFactory;
  lab: QaLabServerHandle;
  runChild: QaSuiteRunner;
}) {
  return runQaRuntimeParitySuite({
    runQaFlowSuite: params.runChild,
    adapterFactories: [params.factory],
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
    startLab: async () => params.lab,
    progressEnabled: false,
    runtimePair: ["openclaw", "codex"],
  });
}

describe("runtime parity suite transport cleanup", () => {
  it("preserves the scenario error when its owned lab cleanup fails", async () => {
    const lab = createCleanupTestLab();
    const scenarioError = new Error("runtime scenario failed");
    const cleanupError = new Error("owned lab shutdown failed");
    lab.stop = vi.fn(async () => {
      throw cleanupError;
    });
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const runChild = vi.fn<QaSuiteRunner>().mockRejectedValueOnce(scenarioError);

    await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toMatchObject({
      message: "QA suite and cleanup failed",
      cause: scenarioError,
      errors: [scenarioError, cleanupError],
    });

    expect(runChild).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
  });

  it("releases an exclusive parent lease before its first runtime child acquires it", async () => {
    const lab = createCleanupTestLab();
    const events: string[] = [];
    const childError = new Error("first runtime child completed");
    let activeOwner: "parent" | "child" | undefined;
    let leaseCount = 0;
    lab.stop = vi.fn(async () => {
      events.push("lab:stop");
    });
    const factory = createCleanupTestFactory(lab, () => {
      if (activeOwner) {
        throw new Error("exclusive credential pool exhausted");
      }
      const owner = leaseCount++ === 0 ? "parent" : "child";
      activeOwner = owner;
      events.push(`${owner}:acquire`);
      return {
        cleanup: async () => {
          events.push(`${owner}:cleanup-before`);
        },
        cleanupAfterGatewayStop: async () => {
          events.push(`${owner}:cleanup-after`);
          activeOwner = undefined;
        },
      };
    });
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async () => {
      const childTransport = await createQaTransportAdapter(
        {
          channelId: "leased",
          driver: "live",
          outputDir: "/qa-child",
          state: createQaBusState(),
        },
        [factory],
      );
      await childTransport.cleanupWithoutGateway();
      throw childError;
    });

    await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toBe(childError);

    expect(runChild).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "parent:acquire",
      "parent:cleanup-before",
      "parent:cleanup-after",
      "child:acquire",
      "child:cleanup-before",
      "child:cleanup-after",
      "lab:stop",
    ]);
    expect(activeOwner).toBeUndefined();
  });

  it.each(["cleanup", "cleanupAfterGatewayStop"] as const)(
    "retries failed parent %s before stopping its owned lab",
    async (cleanupPhase) => {
      const lab = createCleanupTestLab();
      const cleanupError = new Error("credential release failed");
      const cleanup = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(cleanupError)
        .mockResolvedValueOnce(undefined);
      const factory = createCleanupTestFactory(lab, () => ({ [cleanupPhase]: cleanup }));
      const runChild = vi.fn<QaSuiteRunner>();

      await expect(runCleanupTestSuite({ factory, lab, runChild })).rejects.toBe(cleanupError);

      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(runChild).not.toHaveBeenCalled();
      expect(lab.stop).toHaveBeenCalledOnce();
    },
  );
});
