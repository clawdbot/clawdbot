import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import type { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteRunner,
  QaSuiteScenarioRunner,
} from "./suite-types.js";

const mocks = vi.hoisted(() => ({
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
  writeQaSuiteArtifacts: vi.fn<typeof writeQaSuiteArtifacts>(async () => ({
    evidence: undefined,
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => mocks.startQaGatewayChild(params),
    stop: async () => ({ process: "confirmed-stopped", errors: [] }),
  }),
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
vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer: vi.fn(async () => undefined),
}));
vi.mock("./suite-artifacts.js", () => ({
  writeQaSuiteArtifacts: mocks.writeQaSuiteArtifacts,
}));
vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: vi.fn(async () => {}),
  waitForTransportReady: vi.fn(async () => {}),
}));
vi.mock("./web-runtime.js", () => ({
  closeQaWebSessions: vi.fn(async () => {}),
}));

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

function createCleanupTestContext(): QaSuiteResolvedRunContext {
  return {
    startedAt: new Date("2026-08-04T00:00:00.000Z"),
    repoRoot: "/qa-repo",
    outputDir: "/qa-output",
    transportId: "qa-channel",
    selectedScenarios: [makeQaSuiteTestScenario("leased-channel-scenario")],
    providerMode: "mock-openai",
    primaryModel: "mock-openai/test-model",
    alternateModel: "mock-openai/test-model-alt",
    fastMode: true,
    channelDriver: "live",
    enabledPluginIds: [],
    gatewayConfigPatches: [],
    gatewayRuntimeOptions: undefined,
    concurrency: 1,
    progressEnabled: false,
    gatewayHeapCheckpointsEnabled: false,
  };
}

describe("isolated QA suite transport cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disposeRegisteredAgentHarnesses.mockResolvedValue(undefined);
  });

  it("records a rejected dispatched worker and leaves the fail-fast tail unstarted", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.selectedScenarios.push(makeQaSuiteTestScenario("never-started"));
    const runChild = vi
      .fn<QaSuiteRunner>()
      .mockRejectedValueOnce(new Error("isolated worker gateway failed"));

    const result = await runQaFlowSuiteIsolated(
      { failFast: true, lab, startLab: async () => lab },
      context,
      runChild,
    );

    expect(runChild).toHaveBeenCalledOnce();
    expect(result.startedScenarioIds).toEqual(["leased-channel-scenario"]);
    expect(result.scenarios).toEqual([
      expect.objectContaining({
        name: "leased-channel-scenario",
        status: "fail",
        details: "isolated worker gateway failed",
      }),
    ]);
    expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        scenarios: [
          expect.objectContaining({ id: "leased-channel-scenario", status: "fail" }),
          expect.objectContaining({ id: "never-started", status: "pending" }),
        ],
      }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ scenarios: result.scenarios }),
    );
  });

  it("leaves only running progress when parent cleanup fails after worker completion", async () => {
    const lab = createCleanupTestLab();
    const release = vi.fn(async () => {});
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
          cleanup: release,
        };
      },
    };
    const cleanupError = new Error("agent harness disposal failed");
    mocks.disposeRegisteredAgentHarnesses.mockRejectedValueOnce(cleanupError);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi.fn<QaSuiteRunner>().mockResolvedValue({
      outputDir: "/qa-child",
      evidencePath: "/qa-child/qa-evidence.json",
      reportPath: "/qa-child/qa-suite-report.md",
      summaryPath: "/qa-child/qa-suite-summary.json",
      report: "",
      scenarios: [{ name: "leased-channel-scenario", status: "pass", steps: [] }],
      startedScenarioIds: ["leased-channel-scenario"],
      watchUrl: lab.baseUrl,
    });
    const context = createCleanupTestContext();
    context.progressEnabled = true;

    const thrown = await runQaFlowSuiteIsolated(
      {
        adapterFactories: [factory],
        channelDriver: "live",
        channelId: "leased",
        startLab: async () => lab,
      },
      context,
      runChild,
    ).catch((error: unknown) => error);

    expect(release).toHaveBeenCalledOnce();
    expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
    expect(lab.setLatestReport).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: "/qa-output/qa-suite-report.md" }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "running" }),
    );
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", writeEvidenceFile: false }),
    );
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: agent harnesses: agent harness disposal failed",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
    stderrWrite.mockRestore();
  });

  it("keeps Crabline workers concurrent while publishing readiness only from the final aggregate", async () => {
    const lab = createCleanupTestLab();
    const selection = {
      capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
      channel: "telegram",
      channelDriver: "crabline",
      providerReadinessArtifactPath: "crabline-provider-readiness.json",
    } as const;
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let releaseWorkers!: () => void;
    const bothWorkersStarted = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    let releaseFirstScenario!: () => void;
    const firstScenarioStarted = new Promise<void>((resolve) => {
      releaseFirstScenario = resolve;
    });
    let releaseScenarioExecutions!: () => void;
    const bothScenarioExecutionsStarted = new Promise<void>((resolve) => {
      releaseScenarioExecutions = resolve;
    });
    const context = createCleanupTestContext();
    context.channelDriver = "crabline";
    context.concurrency = 2;
    context.selectedScenarios = [
      makeQaSuiteTestScenario("first-crabline-scenario"),
      makeQaSuiteTestScenario("second-crabline-scenario"),
    ];
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockImplementation(async (_env, scenario) => {
        if (scenario.id === "first-crabline-scenario") {
          releaseFirstScenario();
          await bothScenarioExecutionsStarted;
        } else {
          releaseScenarioExecutions();
        }
        return {
          name: scenario.title,
          status: "pass",
          steps: [],
        };
      });
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(async (params) => {
      if (!params) {
        throw new Error("expected nested standard run params");
      }
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      if (activeWorkers === 2) {
        releaseWorkers();
      }
      await bothWorkersStarted;
      const scenarioId = params?.scenarioIds?.[0] ?? "missing-scenario";
      if (scenarioId === "second-crabline-scenario") {
        await firstScenarioStarted;
      }
      const scenario = context.selectedScenarios.find((candidate) => candidate.id === scenarioId);
      if (!scenario) {
        throw new Error(`missing scenario ${scenarioId}`);
      }
      try {
        return await runQaFlowSuiteStandard(
          params,
          {
            ...context,
            startedAt: new Date("2026-08-04T00:00:01.000Z"),
            outputDir: params.outputDir ?? `/qa-child/${scenarioId}`,
            selectedScenarios: [scenario],
            concurrency: 1,
          },
          runScenario,
        );
      } finally {
        activeWorkers -= 1;
      }
    });

    const result = await runQaFlowSuiteIsolated(
      {
        channelDriverSelection: selection,
        channelId: "telegram",
        lab,
        startLab: async () => createCleanupTestLab(),
      },
      context,
      runChild,
    );

    expect(maxActiveWorkers).toBe(2);
    expect(result.scenarios).toEqual([
      expect.objectContaining({ name: "first-crabline-scenario", status: "pass" }),
      expect.objectContaining({ name: "second-crabline-scenario", status: "pass" }),
    ]);
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(5);
    for (const [nonFinalArtifacts] of mocks.writeQaSuiteArtifacts.mock.calls.slice(0, -1)) {
      expect(nonFinalArtifacts).toMatchObject({ channel: "telegram", channelDriver: "crabline" });
      expect(nonFinalArtifacts.channelDriverSelection).toBeUndefined();
    }
    const finalArtifacts = mocks.writeQaSuiteArtifacts.mock.calls.at(-1)?.[0];
    expect(finalArtifacts).toMatchObject({
      channel: "telegram",
      channelDriver: "crabline",
      channelDriverSelection: selection,
    });
  });

  it("prints one generic completion after a real nested standard run and parent cleanup", async () => {
    const parentLab = createCleanupTestLab();
    const childLab = createCleanupTestLab();
    const startLab = vi
      .fn<() => Promise<QaLabServerHandle>>()
      .mockResolvedValueOnce(parentLab)
      .mockResolvedValueOnce(childLab);
    const context = createCleanupTestContext();
    context.channelDriver = undefined;
    context.progressEnabled = true;
    const runScenario = vi
      .fn<QaSuiteScenarioRunner>()
      .mockResolvedValue({ name: "leased-channel-scenario", status: "pass", steps: [] });
    const runChild: QaSuiteRunner = async (childParams) => {
      if (!childParams) {
        throw new Error("expected nested standard run params");
      }
      return await runQaFlowSuiteStandard(
        childParams,
        {
          ...context,
          startedAt: new Date("2026-08-04T00:00:01.000Z"),
          outputDir: childParams.outputDir ?? "/qa-output/scenarios/leased-channel-scenario",
          concurrency: 1,
        },
        runScenario,
      );
    };
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runQaFlowSuiteIsolated({ startLab }, context, runChild);

      const completionLines = stderrWrite.mock.calls
        .flat()
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("[qa-suite] run complete"));
      expect(completionLines).toEqual(["[qa-suite] run complete"]);
      expect(runScenario).toHaveBeenCalledOnce();
      expect(childLab.stop).toHaveBeenCalledOnce();
      expect(parentLab.stop).toHaveBeenCalledOnce();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it.each(["cleanup", "cleanupAfterGatewayStop"] as const)(
    "retries a failed parent %s phase before disposing its owned lab",
    async (cleanupPhase) => {
      const lab = createCleanupTestLab();
      const releaseError = new Error("credential release failed");
      const release = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(releaseError)
        .mockResolvedValueOnce(undefined);
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
            [cleanupPhase]: release,
          };
        },
      };
      const runChild = vi.fn<QaSuiteRunner>();

      await expect(
        runQaFlowSuiteIsolated(
          {
            adapterFactories: [factory],
            channelDriver: "live",
            channelId: "leased",
            startLab: async () => lab,
          },
          createCleanupTestContext(),
          runChild,
        ),
      ).rejects.toBe(releaseError);

      expect(release).toHaveBeenCalledTimes(2);
      expect(runChild).not.toHaveBeenCalled();
      expect(lab.stop).toHaveBeenCalledOnce();
    },
  );
});
