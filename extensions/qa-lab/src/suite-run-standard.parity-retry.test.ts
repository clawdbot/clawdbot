import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteScenarioResult,
  QaSuiteScenarioRunner,
} from "./suite-types.js";
import type { runQaFlowSuiteCleanupPlan } from "./suite.js";

const mocks = vi.hoisted(() => ({
  captureRuntimeParityCell: vi.fn(async (params: { runtime: "codex"; wallClockMs: number }) => ({
    runtime: params.runtime,
    transcriptBytes: "",
    toolCalls: [],
    finalText: "",
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
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
  })),
  startQaGatewayChild: vi.fn(async (_params: unknown) => ({
    baseUrl: "http://127.0.0.1:18789",
    token: "qa-test-token",
    cfg: {},
    getProcessCpuMs: () => null,
    getProcessRssBytes: () => null,
    stop: vi.fn(async () => {}),
  })),
  writeQaSuiteArtifacts: vi.fn(async () => ({
    evidence: undefined,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  })),
  waitForGatewayHealthy: vi.fn(async () => {}),
  waitForTransportReady: vi.fn(async () => {}),
  runQaFlowSuiteCleanupPlan: vi.fn<typeof runQaFlowSuiteCleanupPlan>(async () => []),
  writeQaSuiteProgress: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
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
vi.mock("./runtime-parity.js", () => ({
  captureRuntimeParityCell: mocks.captureRuntimeParityCell,
}));
vi.mock("./suite-artifacts.js", () => ({
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));
vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: mocks.waitForGatewayHealthy,
  waitForTransportReady: mocks.waitForTransportReady,
}));
vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  buildQaSuiteRuntimeMetrics: vi.fn(() => ({ wallMs: 1 })),
  captureGatewayHeapSnapshotCheckpoint: vi.fn(async () => undefined),
  createQaSuiteTransportAdapter: vi.fn(async () => ({
    adapter: { id: "qa-channel" },
    cleanupBeforeGatewayStop: vi.fn(async () => {}),
    cleanupAfterGatewayStop: vi.fn(async () => {}),
  })),
  requireQaSuiteStartLab: vi.fn(),
  resolveQaSuiteTransportReadyTimeoutMs: vi.fn(() => 1_000),
  runQaFlowSuiteCleanupPlan: mocks.runQaFlowSuiteCleanupPlan,
  waitForQaLabReadyOrStopOwned: vi.fn(async () => {}),
  writeQaSuiteProgress: mocks.writeQaSuiteProgress,
}));
vi.mock("./web-runtime.js", () => ({
  closeQaWebSessions: vi.fn(async () => {}),
}));

function makeRetryTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: {} as QaLabServerHandle["state"],
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

function makeRetryTestContext(): QaSuiteResolvedRunContext {
  return {
    startedAt: new Date(),
    repoRoot: "/qa-repo",
    outputDir: "/qa-output",
    transportId: "qa-channel",
    selectedScenarios: [makeQaSuiteTestScenario("runtime-soak-100-turn")],
    providerMode: "live-frontier",
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna",
    fastMode: true,
    enabledPluginIds: [],
    gatewayConfigPatches: [],
    gatewayRuntimeOptions: undefined,
    concurrency: 1,
    progressEnabled: false,
    gatewayHeapCheckpointsEnabled: false,
  };
}

function makeRetryTestResult(status: "pass" | "fail"): QaSuiteScenarioResult {
  return {
    name: "runtime-soak-100-turn",
    status,
    details: status === "fail" ? "expected 100 persisted user turns, got 101" : "passed",
    steps: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runQaFlowSuiteCleanupPlan.mockResolvedValue([]);
});

describe("QA suite Control UI ownership", () => {
  it.each([
    {
      label: "a non-Control UI scenario by default",
      surface: "channel",
      explicit: undefined,
      enabled: false,
    },
    {
      label: "an explicitly disabled non-Control UI scenario",
      surface: "channel",
      explicit: false,
      enabled: false,
    },
    {
      label: "an explicitly enabled non-Control UI scenario",
      surface: "channel",
      explicit: true,
      enabled: true,
    },
    {
      label: "a Control UI scenario by default",
      surface: "control-ui",
      explicit: undefined,
      enabled: true,
    },
    {
      label: "an explicitly disabled Control UI scenario",
      surface: "control-ui",
      explicit: false,
      enabled: false,
    },
  ])("only starts and publishes the gateway Control UI for $label", async (testCase) => {
    const lab = makeRetryTestLab();
    const context = makeRetryTestContext();
    context.selectedScenarios = [
      makeQaSuiteTestScenario("control-ui-ownership", { surface: testCase.surface }),
    ];
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValue(makeRetryTestResult("pass"));

    await runQaFlowSuiteStandard(
      {
        lab,
        ...(testCase.explicit === undefined ? {} : { controlUiEnabled: testCase.explicit }),
      },
      context,
      runScenario,
    );

    expect(mocks.startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({ controlUiEnabled: testCase.enabled }),
    );
    if (testCase.enabled) {
      expect(lab.setControlUi).toHaveBeenCalledWith({
        controlUiProxyTarget: "http://127.0.0.1:18789",
        controlUiProxyToken: "qa-test-token",
      });
    } else {
      expect(lab.setControlUi).not.toHaveBeenCalled();
    }
  });
});

describe("QA runtime parity scenario retry isolation", () => {
  it("does not publish terminal artifacts when cleanup fails", async () => {
    const lab = makeRetryTestLab();
    const cleanupError = Object.assign(new Error("gateway shutdown socket reset"), {
      code: "ECONNRESET",
    });
    mocks.runQaFlowSuiteCleanupPlan.mockResolvedValueOnce([
      { phase: "gateway stop", error: cleanupError },
    ]);

    const thrown = await runQaFlowSuiteStandard(
      { lab },
      makeRetryTestContext(),
      vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(makeRetryTestResult("pass")),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "scenario counts: passed=1 failed=0 skipped=0 total=1",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: gateway stop: gateway shutdown socket reset",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
    expect(lab.setLatestReport).not.toHaveBeenCalled();
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect(
      mocks.writeQaSuiteProgress.mock.calls.filter(([, message]) =>
        String(message).startsWith("run complete"),
      ),
    ).toHaveLength(0);
  });

  it.each([
    { forcedRuntime: undefined, expectedRuntime: "openclaw" },
    { forcedRuntime: "codex" as const, expectedRuntime: "codex" },
  ])(
    "records $expectedRuntime as the selected runtime fact",
    async ({ forcedRuntime, expectedRuntime }) => {
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async (env) => {
        expect(env.runtimeId).toBe(expectedRuntime);
        return makeRetryTestResult("pass");
      });

      await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab(), ...(forcedRuntime ? { forcedRuntime } : {}) },
        makeRetryTestContext(),
        runScenario,
      );

      expect(runScenario).toHaveBeenCalledOnce();
    },
  );

  it("skips connected-transport readiness for intentionally unhealthy startup", async () => {
    const context = makeRetryTestContext();
    context.gatewayRuntimeOptions = { allowUnhealthyStartup: true };
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValue(makeRetryTestResult("pass"));

    await runQaFlowSuiteStandard({ lab: makeRetryTestLab() }, context, runScenario);

    expect(mocks.startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnhealthyStartup: true }),
    );
    expect(mocks.waitForGatewayHealthy).not.toHaveBeenCalled();
    expect(mocks.waitForTransportReady).not.toHaveBeenCalled();
    expect(runScenario).toHaveBeenCalledOnce();
  });

  it("captures one failed parity attempt without replaying its transcript or usage", async () => {
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValueOnce(makeRetryTestResult("fail"))
      .mockResolvedValueOnce(makeRetryTestResult("pass"));

    const result = await runQaFlowSuiteStandard(
      { lab: makeRetryTestLab(), forcedRuntime: "codex", captureRuntimeParityCell: true },
      makeRetryTestContext(),
      runScenario,
    );

    expect(runScenario).toHaveBeenCalledOnce();
    expect(result.scenarios[0]).toMatchObject({ status: "fail" });
    expect(mocks.captureRuntimeParityCell).toHaveBeenCalledOnce();
    expect(mocks.captureRuntimeParityCell).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "codex",
        scenarioResult: expect.objectContaining({ status: "fail" }),
        wallClockMs: expect.any(Number),
      }),
    );
    expect(result.runtimeParityCell).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      cacheDiagnostics: { assistantTurns: 1 },
      wallClockMs: expect.any(Number),
    });
  });

  it("preserves the existing single flake retry outside runtime parity", async () => {
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValueOnce(makeRetryTestResult("fail"))
      .mockResolvedValueOnce(makeRetryTestResult("pass"));

    const result = await runQaFlowSuiteStandard(
      { lab: makeRetryTestLab() },
      makeRetryTestContext(),
      runScenario,
    );

    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(result.scenarios[0]).toMatchObject({ status: "pass" });
    expect(mocks.captureRuntimeParityCell).not.toHaveBeenCalled();
  });
});
