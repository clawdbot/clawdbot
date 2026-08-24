import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";

const mocks = vi.hoisted(() => ({
  readQaBootstrapScenarioCatalog: vi.fn(),
  runQaFlowSuiteStandard: vi.fn(),
  writeQaSuiteArtifacts: vi.fn(),
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-catalog.js")>()),
  readQaBootstrapScenarioCatalog: mocks.readQaBootstrapScenarioCatalog,
}));

vi.mock("./suite-planning.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-planning.js")>()),
  resolveQaSuiteOutputDir: vi.fn(
    async (_repoRoot: string, outputDir?: string) => outputDir ?? "/qa-output",
  ),
}));

vi.mock("./suite-run-standard.js", () => ({
  runQaFlowSuiteStandard: mocks.runQaFlowSuiteStandard,
}));

vi.mock("./suite-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite-artifacts.js")>()),
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));

function createControlUiTestLab(): QaLabServerHandle {
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readQaBootstrapScenarioCatalog.mockReturnValue({
    scenarios: [
      makeQaSuiteTestScenario("runtime-channel", { surface: "channel" }),
      makeQaSuiteTestScenario("runtime-control-ui", { surface: "control-ui" }),
    ],
  });
  mocks.runQaFlowSuiteStandard.mockImplementation(
    async (
      params: QaSuiteRunParams | undefined,
      context: QaSuiteResolvedRunContext,
    ): Promise<QaSuiteResult> => ({
      outputDir: context.outputDir,
      evidencePath: "/qa-output/qa-evidence.json",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
      report: "",
      scenarios: context.selectedScenarios.map((scenario) => ({
        name: scenario.title,
        status: "pass",
        steps: [],
      })),
      startedScenarioIds: context.selectedScenarios.map((scenario) => scenario.id),
      watchUrl: "http://127.0.0.1:43123",
      runtimeParityCell: {
        runtime: params?.forcedRuntime ?? "openclaw",
        transcriptBytes: "",
        toolCalls: [],
        finalText: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        wallClockMs: 1,
        bootStateLines: [],
      },
    }),
  );
  mocks.writeQaSuiteArtifacts.mockResolvedValue({
    evidence: undefined,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  });
});

describe("runtime parity Control UI ownership", () => {
  it.each([
    {
      label: "a non-Control UI scenario by default",
      scenarioId: "runtime-channel",
      explicit: undefined,
      enabled: false,
    },
    {
      label: "an interactive non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: true,
      enabled: true,
    },
    {
      label: "an explicitly disabled non-Control UI scenario",
      scenarioId: "runtime-channel",
      explicit: false,
      enabled: false,
    },
    {
      label: "a Control UI scenario by default",
      scenarioId: "runtime-control-ui",
      explicit: undefined,
      enabled: true,
    },
    {
      label: "an explicitly disabled Control UI scenario",
      scenarioId: "runtime-control-ui",
      explicit: false,
      enabled: false,
    },
  ])("preserves Control UI policy in both runtime cells for $label", async (testCase) => {
    const lab = createControlUiTestLab();

    const result = await runQaFlowSuiteFromRuntime({
      repoRoot: "/qa-repo",
      outputDir: "/qa-output",
      providerMode: "mock-openai",
      scenarioIds: [testCase.scenarioId],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      ...(testCase.explicit === undefined ? {} : { controlUiEnabled: testCase.explicit }),
    });

    expect(
      mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => ({
        runtime: params.forcedRuntime,
        controlUiEnabled: params.controlUiEnabled,
      })),
    ).toEqual([
      { runtime: "openclaw", controlUiEnabled: testCase.enabled },
      { runtime: "codex", controlUiEnabled: testCase.enabled },
    ]);
    expect(result.startedScenarioIds).toEqual([testCase.scenarioId]);
  });

  it("forwards config mutation to both runtime cells", async () => {
    const lab = createControlUiTestLab();
    const mutateConfig = vi.fn((config: OpenClawConfig) => config);

    await runQaFlowSuiteFromRuntime({
      repoRoot: "/qa-repo",
      outputDir: "/qa-output",
      providerMode: "mock-openai",
      scenarioIds: ["runtime-channel"],
      runtimePair: ["openclaw", "codex"],
      lab,
      startLab: async () => lab,
      mutateConfig,
    });

    expect(mocks.runQaFlowSuiteStandard.mock.calls.map(([params]) => params.mutateConfig)).toEqual([
      mutateConfig,
      mutateConfig,
    ]);
  });
});
