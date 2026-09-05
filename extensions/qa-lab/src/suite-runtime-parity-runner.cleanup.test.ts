import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
} from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunner, QaSuiteScenarioRunner } from "./suite-types.js";
import * as suite from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

const mocks = vi.hoisted(() => ({
  captureRuntimeParityCell: vi.fn(
    async (params: { runtime: "openclaw" | "codex"; wallClockMs: number }) => ({
      runtime: params.runtime,
      transcriptBytes: "",
      toolCalls: [],
      finalText: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      cacheDiagnostics: {
        assistantTurns: 1,
        cacheTelemetryTurns: 1,
        cacheHitTurns: 0,
        cacheWriteTurns: 0,
        cacheMisses: [],
        cacheMissInputTokens: 0,
        unmeasuredPostWarmTurns: [],
      },
      wallClockMs: params.wallClockMs,
      bootStateLines: [],
    }),
  ),
  disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
  fetchWithSsrFGuard: vi.fn(async () => ({
    response: new Response(null, { status: 204 }),
    release: vi.fn(async () => {}),
  })),
  startQaGatewayChild: vi.fn(async (_params: unknown) => ({
    baseUrl: "http://127.0.0.1:18789",
    token: "qa-test-token",
    cfg: {},
    getProcessCpuMs: () => null,
    getProcessRssBytes: () => null,
    stop: vi.fn(async () => {}),
  })),
  writeQaSuiteArtifacts: vi.fn(
    async (_params: {
      channel?: string | null;
      channelDriver?: string | null;
      channelDriverSelection?: unknown;
    }) => ({
      evidence: { kind: "test" },
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./crabline-transport.js", () => ({
  createQaCrablineTransportAdapter: vi.fn(async () => ({
    id: "telegram",
    label: "Crabline Telegram",
    accountId: "sut",
    requiredPluginIds: [],
    supportedActions: [],
    sendInbound: vi.fn(async () => {}),
    createGatewayConfig: () => ({}),
    waitReady: vi.fn(async () => {}),
    buildAgentDelivery: ({ target }: { target: string }) => ({
      channel: "telegram",
      to: target,
      replyChannel: "telegram",
      replyTo: target,
    }),
    handleAction: vi.fn(async () => {}),
    createReportNotes: () => [],
    cleanup: vi.fn(async () => {}),
  })),
}));
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => mocks.startQaGatewayChild(params),
    stop: async () => ({ process: "confirmed-stopped", errors: [] }),
  }),
}));
vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer: vi.fn(async () => undefined),
}));
vi.mock("./runtime-parity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-parity.js")>()),
  captureRuntimeParityCell: mocks.captureRuntimeParityCell,
}));
vi.mock("./suite-artifacts.js", () => ({
  invalidateQaSuiteArtifactGeneration: vi.fn(async () => {}),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));
vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: vi.fn(async () => {}),
  waitForTransportReady: vi.fn(async () => {}),
}));
vi.mock("./web-runtime.js", () => ({
  closeQaWebSessions: vi.fn(async () => {}),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

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
  progressEnabled?: boolean;
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
    progressEnabled: params.progressEnabled ?? false,
    runtimePair: ["openclaw", "codex"],
  });
}

describe("runtime parity suite transport cleanup", () => {
  it("does not publish parent artifacts when owned lab cleanup fails", async () => {
    const cleanupError = Object.assign(new Error("owned lab shutdown reset"), {
      code: "ECONNRESET",
    });
    const setLatestReport = vi.fn<QaLabServerHandle["setLatestReport"]>();
    const stopLab = vi.fn<QaLabServerHandle["stop"]>(async () => {
      throw cleanupError;
    });
    const lab = createCleanupTestLab();
    lab.setLatestReport = setLatestReport;
    lab.stop = stopLab;
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: "runtime-cleanup", status: "pass", steps: [] }],
      startedScenarioIds: ["runtime-cleanup"],
      watchUrl: lab.baseUrl,
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }));

    try {
      const thrown = await runCleanupTestSuite({
        factory,
        lab,
        progressEnabled: true,
        runChild,
      }).catch((error: unknown) => error);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      expect(setLatestReport).not.toHaveBeenCalled();
      expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "completed" }),
      );
      expect((thrown as Error).message.split("\n")[0]).toBe(
        "QA scenarios passed, but cleanup failed",
      );
      expect((thrown as Error).message).toContain(
        "failed cleanup phases: lab stop: owned lab shutdown reset",
      );
      expect((thrown as Error).cause).toBe(cleanupError);
      expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("reports a parity scenario only after a nested producer starts it", async () => {
    const lab = createCleanupTestLab();
    const cleanup = vi.fn(async () => {});
    const factory = createCleanupTestFactory(lab, () => ({ cleanup }));
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => ({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: "runtime-cleanup", status: "pass", steps: [] }],
      startedScenarioIds: [],
      watchUrl: lab.baseUrl,
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }));

    const result = await runCleanupTestSuite({ factory, lab, runChild });

    expect(result.startedScenarioIds).toEqual([]);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    "preserves runtime preparation publication ownership with parity=%s",
    async (parity) => {
      vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
      mocks.writeQaSuiteArtifacts.mockClear();
      const repoRoot = await tempDirs.makeTempDir("qa-runtime-publication-");
      const scenario = makeQaSuiteTestScenario("runtime-cleanup");
      const selection = {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
      } as const;
      const labs = Array.from({ length: parity ? 3 : 1 }, createCleanupTestLab);
      const startLab = vi.fn<() => Promise<QaLabServerHandle>>();
      for (const lab of labs) {
        startLab.mockResolvedValueOnce(lab);
      }
      const runScenario = vi
        .fn<QaSuiteScenarioRunner>()
        .mockResolvedValue({ name: scenario.title, status: "pass", steps: [] });
      vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
        agentIdentityMarkdown: "test",
        kickoffTask: "test",
        scenarios: [scenario],
      });
      vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      try {
        const result = await runQaFlowSuiteFromRuntime({
          repoRoot,
          outputDir: path.join(repoRoot, "output"),
          providerMode: "mock-openai",
          transportId: "qa-channel",
          channelId: "telegram",
          channelDriverSelection: selection,
          primaryModel: "mock-openai/test-model",
          alternateModel: "mock-openai/test-model-alt",
          fastMode: true,
          concurrency: 1,
          scenarioIds: [scenario.id],
          startLab,
          ...(parity ? { runtimePair: ["openclaw", "codex"] } : {}),
        });

        const completionLines = stderrWrite.mock.calls
          .flat()
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("[qa-suite] run complete"));
        expect(result.scenarios).toEqual([expect.objectContaining({ status: "pass" })]);
        expect(completionLines).toEqual([
          parity
            ? "[qa-suite] run complete"
            : "[qa-suite] run complete: passed=1 failed=0 skipped=0 total=1",
        ]);
        expect(runScenario).toHaveBeenCalledTimes(parity ? 2 : 1);
        expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(labs.length);
        for (const [cellArtifacts] of mocks.writeQaSuiteArtifacts.mock.calls.slice(0, -1)) {
          expect(cellArtifacts.channelDriverSelection).toBeUndefined();
        }
        expect(mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0]).toMatchObject({
          channel: "telegram",
          channelDriver: "crabline",
          channelDriverSelection: selection,
        });
        for (const lab of labs) {
          expect(lab.stop).toHaveBeenCalledOnce();
        }
      } finally {
        stderrWrite.mockRestore();
      }
    },
  );

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
      message: expect.stringContaining(
        "failed cleanup phases: lab stop: owned lab shutdown failed",
      ),
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
