import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteScenarioResult,
  QaSuiteScenarioRunner,
} from "./suite-types.js";
import type { runQaFlowSuiteCleanupPlan } from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

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
  stopQaGatewayChild: vi.fn<QaGatewayChildLifecycle["stop"]>(),
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
    stop: mocks.stopQaGatewayChild,
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

const tempDirs = createTempDirHarness();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopQaGatewayChild.mockReset().mockResolvedValue({
    process: "confirmed-stopped",
    errors: [],
  });
  mocks.runQaFlowSuiteCleanupPlan.mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
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
  it.each([false, true])(
    "preserves runner progress through cleanup (failFast=%s)",
    async (failFast) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
      vi.setSystemTime(at(0));
      const lab = makeRetryTestLab();
      const context = makeRetryTestContext();
      context.selectedScenarios = ["first", "second", "tail"].map((id) => {
        const scenario = makeQaSuiteTestScenario(id);
        scenario.title = `Catalog ${id}`;
        if (scenario.execution.kind === "flow") {
          scenario.execution.retryCount = 0;
        }
        return scenario;
      });
      const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
      vi.mocked(lab.setScenarioRun).mockImplementation((next) =>
        snapshots.push(structuredClone(next)),
      );
      const results: QaSuiteScenarioResult[] = [
        {
          name: "result first",
          status: "pass",
          details: "",
          steps: [{ name: "check", status: "pass" }],
        },
        { name: "result second", status: "fail", steps: [] },
        { name: "result tail", status: "skip", details: "not applicable", steps: [] },
      ];
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async () => {
        const index = runScenario.mock.calls.length - 1;
        vi.setSystemTime(at(index + 1));
        return results[index]!;
      });
      mocks.runQaFlowSuiteCleanupPlan.mockImplementationOnce(async () => {
        expect(snapshots.every((snapshot) => snapshot?.status === "running")).toBe(true);
        expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
        vi.setSystemTime(at(10));
        return [];
      });

      await runQaFlowSuiteStandard({ lab, failFast }, context, runScenario);

      const finishedCount = failFast ? 2 : 3;
      const finalStatuses = failFast ? ["pass", "fail", "pending"] : ["pass", "fail", "skip"];
      expect(
        snapshots.map((snapshot) => snapshot?.scenarios.map((scenario) => scenario.status)),
      ).toEqual([
        ["pending", "pending", "pending"],
        ["running", "pending", "pending"],
        ["pass", "pending", "pending"],
        ["pass", "running", "pending"],
        ["pass", "fail", "pending"],
        ...(failFast
          ? []
          : [
              ["pass", "fail", "running"],
              ["pass", "fail", "skip"],
            ]),
        finalStatuses,
      ]);
      expect(snapshots.at(-1)).toStrictEqual({
        kind: "suite",
        status: "completed",
        startedAt: at(0).toISOString(),
        finishedAt: at(10).toISOString(),
        scenarios: context.selectedScenarios.map((scenario, index) =>
          Object.assign(
            { id: scenario.id, name: scenario.title, status: finalStatuses[index] },
            index < finishedCount
              ? {
                  details: results[index]!.details,
                  steps: results[index]!.steps,
                  startedAt: at(index).toISOString(),
                  finishedAt: at(index + 1).toISOString(),
                }
              : {},
          ),
        ),
      });
      expect(runScenario).toHaveBeenCalledTimes(finishedCount);
      expect(mocks.writeQaSuiteArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]!,
      );
      expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
      );
    },
  );

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

  it.each(["pass", "fail"] as const)(
    "retains sanitized logs after an initial %s only when the scenario retried",
    async (firstStatus) => {
      vi.stubEnv("OPENCLAW_QA_KEEP_TEMP", undefined);
      const root = await tempDirs.makeTempDir("qa-retry-artifacts-");
      const tempRoot = path.join(root, "runtime");
      await fs.mkdir(tempRoot);
      const stderrPath = path.join(tempRoot, "gateway.stderr.log");
      const gateway = new QaGatewayChildLifecycle();
      gateway.repoRoot = root;
      gateway.tempRoot = tempRoot;
      mocks.stopQaGatewayChild.mockImplementation((options) => gateway.stop(options));
      mocks.runQaFlowSuiteCleanupPlan.mockImplementation(async ({ stopGateway }) => {
        const stopped = await stopGateway();
        return stopped.errors.map((error) => ({ phase: "gateway stop", error }));
      });
      let attempts = 0;
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockImplementation(async () => {
        attempts += 1;
        await fs.appendFile(
          stderrPath,
          attempts === 1
            ? "FIRST_ATTEMPT apiKey=synthetic-fixture-secret\n"
            : "SECOND_ATTEMPT_PASS\n",
        );
        return makeRetryTestResult(attempts === 1 ? firstStatus : "pass");
      });
      const context = {
        ...makeRetryTestContext(),
        repoRoot: root,
        outputDir: path.join(root, "output"),
      };

      const result = await runQaFlowSuiteStandard(
        { lab: makeRetryTestLab() },
        context,
        runScenario,
      );

      expect(runScenario).toHaveBeenCalledTimes(firstStatus === "fail" ? 2 : 1);
      expect(result.scenarios[0]).toMatchObject({ status: "pass" });
      expect(mocks.captureRuntimeParityCell).not.toHaveBeenCalled();
      await expect(fs.stat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const artifactDir = path.join(context.outputDir, "artifacts", "gateway-runtime");
      if (firstStatus === "fail") {
        expect(result.scenarios[0]?.details).toContain(
          "passed on retry; first attempt: expected 100 persisted user turns, got 101",
        );
        const log = await fs.readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8");
        expect(log).toContain("FIRST_ATTEMPT apiKey=<redacted>");
        expect(log).toContain("SECOND_ATTEMPT_PASS");
        expect(log).not.toContain("synthetic-fixture-secret");
      } else {
        await expect(fs.stat(artifactDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
