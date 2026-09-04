import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import type { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteRunner,
  QaSuiteScenarioResult,
  QaSuiteScenarioRunner,
} from "./suite-types.js";
import * as suite from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

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

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await tempDirs.cleanup();
  });

  it.each(["running", "pass", "fail"])(
    "preserves the %s progress publication exception boundary",
    async (status) => {
      const lab = createCleanupTestLab();
      const publicationError = new Error("progress publication rejected");
      vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
        if (next?.scenarios[0]?.status === status) {
          throw publicationError;
        }
      });
      const runChild = vi.fn<QaSuiteRunner>().mockResolvedValue({
        outputDir: "/qa-child",
        evidencePath: "/qa-child/qa-evidence.json",
        reportPath: "/qa-child/qa-suite-report.md",
        summaryPath: "/qa-child/qa-suite-summary.json",
        report: "",
        scenarios: [{ name: "worker result", status: "pass", steps: [] }],
        startedScenarioIds: ["leased-channel-scenario"],
        watchUrl: lab.baseUrl,
      });
      if (status === "fail") {
        runChild.mockRejectedValueOnce(new Error("worker failed"));
      }
      const run = runQaFlowSuiteIsolated(
        { lab, startLab: async () => lab },
        createCleanupTestContext(),
        runChild,
      );
      if (status === "pass") {
        await expect(run).resolves.toMatchObject({
          scenarios: [{ status: "fail", details: publicationError.message }],
        });
      } else {
        await expect(run).rejects.toBe(publicationError);
        expect(mocks.writeQaSuiteArtifacts).not.toHaveBeenCalled();
      }
      expect(runChild).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
      expect(mocks.disposeRegisteredAgentHarnesses).toHaveBeenCalledOnce();
    },
  );

  it("keeps out-of-order progress times while draining partial artifacts before cleanup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
    vi.setSystemTime(at(0));
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.concurrency = 2;
    context.selectedScenarios = ["first", "second"].map((id) => {
      const scenario = makeQaSuiteTestScenario(id);
      scenario.title = `Catalog ${id}`;
      return scenario;
    });
    const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
    const completed = [createDeferred<void>(), createDeferred<void>()];
    vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
      snapshots.push(structuredClone(next));
      next?.scenarios.forEach((scenario, index) => {
        if (scenario.status === "pass") {
          completed[index]!.resolve();
        }
      });
    });
    const workers = [
      createDeferred<Awaited<ReturnType<QaSuiteRunner>>>(),
      createDeferred<Awaited<ReturnType<QaSuiteRunner>>>(),
    ];
    const allStarted = createDeferred<void>();
    const runChild = vi.fn<QaSuiteRunner>().mockImplementation(() => {
      if (runChild.mock.calls.length === 2) {
        allStarted.resolve();
      }
      return workers[runChild.mock.calls.length - 1]!.promise;
    });
    const partialWrite = createDeferred<void>();
    const artifacts = {
      evidence: undefined,
      evidencePath: "/qa-output/qa-evidence.json",
      report: "",
      reportPath: "/qa-output/qa-suite-report.md",
      summaryPath: "/qa-output/qa-suite-summary.json",
    };
    mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
      await partialWrite.promise;
      return artifacts;
    });
    mocks.disposeRegisteredAgentHarnesses.mockImplementationOnce(async () => {
      expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledTimes(2);
      expect(snapshots.at(-1)?.status).toBe("running");
      vi.setSystemTime(at(10));
    });
    const results: QaSuiteScenarioResult[] = [
      { name: "result first", status: "pass", steps: [] },
      {
        name: "result second",
        status: "pass",
        details: "",
        steps: [{ name: "check", status: "pass" }],
      },
    ];
    const run = runQaFlowSuiteIsolated(
      { lab, startLab: async () => lab, workerStartStaggerMs: 0 },
      context,
      runChild,
    );
    await allStarted.promise;
    for (const index of [1, 0]) {
      vi.setSystemTime(at(2 - index));
      workers[index]!.resolve({
        ...artifacts,
        outputDir: "/qa-child",
        scenarios: [results[index]!],
        startedScenarioIds: [context.selectedScenarios[index]!.id],
        watchUrl: lab.baseUrl,
      });
      await completed[index]!.promise;
    }
    expect(mocks.writeQaSuiteArtifacts).toHaveBeenCalledOnce();
    expect(mocks.disposeRegisteredAgentHarnesses).not.toHaveBeenCalled();
    partialWrite.resolve();
    const result = await run;

    expect(result.scenarios).toEqual(results);
    expect(
      snapshots.map((snapshot) => snapshot?.scenarios.map((scenario) => scenario.status)),
    ).toEqual([
      ["pending", "pending"],
      ["running", "pending"],
      ["running", "running"],
      ["running", "pass"],
      ["pass", "pass"],
      ["pass", "pass"],
    ]);
    expect(snapshots.at(-1)).toStrictEqual({
      kind: "suite",
      status: "completed",
      startedAt: at(0).toISOString(),
      finishedAt: at(10).toISOString(),
      scenarios: context.selectedScenarios.map((scenario, index) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pass",
        details: results[index]!.details,
        steps: results[index]!.steps,
        startedAt: at(0).toISOString(),
        finishedAt: at(2 - index).toISOString(),
      })),
    });
    expect(
      mocks.writeQaSuiteArtifacts.mock.calls.map(([params]) => [params.status, params.scenarios]),
    ).toEqual([
      ["running", [results[1]]],
      ["running", results],
      [undefined, results],
    ]);
    expect(mocks.disposeRegisteredAgentHarnesses.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeQaSuiteArtifacts.mock.invocationCallOrder[2]!,
    );
    expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
    );
  });

  it("records a rejected dispatched worker and leaves the fail-fast tail unstarted", async () => {
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.progressEnabled = true;
    context.selectedScenarios.push(makeQaSuiteTestScenario("never-started"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi
      .fn<QaSuiteRunner>()
      .mockRejectedValueOnce(new Error("isolated worker gateway failed"));

    let result: Awaited<ReturnType<typeof runQaFlowSuiteIsolated>>;
    try {
      result = await runQaFlowSuiteIsolated(
        { failFast: true, lab, startLab: async () => lab },
        context,
        runChild,
      );
      expect(stderrWrite.mock.calls.flat().join("")).toContain(
        "scenario fail (1/2): leased-channel-scenario — isolated scenario worker: isolated worker gateway failed",
      );
    } finally {
      stderrWrite.mockRestore();
    }

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

  it("preserves nested publication ownership through concurrent worker runtime preparation", async () => {
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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
    context.repoRoot = await tempDirs.makeTempDir("qa-nested-workers-");
    context.outputDir = path.join(context.repoRoot, "output");
    context.channelDriver = "crabline";
    context.concurrency = 2;
    context.progressEnabled = true;
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
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
      agentIdentityMarkdown: "test",
      kickoffTask: "test",
      scenarios: context.selectedScenarios,
    });
    vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
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
      try {
        return await runQaFlowSuiteFromRuntime(params);
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
    expect(
      stderrWrite.mock.calls
        .flat()
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("[qa-suite] run complete")),
    ).toEqual(["[qa-suite] run complete"]);
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

  it.each(["pass", "skip", "failed step", "failure details"] as const)(
    "prints bounded failure progress before artifacts for a nested standard %s result",
    async (outcome) => {
      const parentLab = createCleanupTestLab();
      const childLab = createCleanupTestLab();
      const startLab = vi
        .fn<() => Promise<QaLabServerHandle>>()
        .mockResolvedValueOnce(parentLab)
        .mockResolvedValueOnce(childLab);
      const context = createCleanupTestContext();
      context.channelDriver = undefined;
      context.progressEnabled = true;
      const scenario = context.selectedScenarios[0]!;
      if (scenario.execution.kind === "flow") {
        scenario.execution.retryCount = 0;
      }
      const scenarioStatus = outcome === "pass" || outcome === "skip" ? outcome : "fail";
      const secret = "synthetic-secret-".repeat(60);
      const details = `verification refused\napiKey="${secret}"\r::error::fixture\n${"🦞".repeat(400)}`;
      const scenarioResult = {
        name: "leased-channel-scenario",
        status: scenarioStatus,
        details: outcome === "failed step" ? "unrelated scenario metadata" : details,
        steps:
          outcome === "failed step"
            ? [{ name: "Verify\nrequest", status: "fail" as const, details }]
            : [],
      } satisfies QaSuiteScenarioResult;
      const runScenario = vi.fn<QaSuiteScenarioRunner>().mockResolvedValue(scenarioResult);
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
      const assertScenarioProgress = (expectedCount: number) => {
        const lines = stderrWrite.mock.calls
          .flat()
          .join("")
          .split("\n")
          .filter((line) => line.startsWith(`[qa-suite] scenario ${scenarioStatus} (`));
        expect(lines).toHaveLength(expectedCount);
        for (const line of lines) {
          const prefix = `[qa-suite] scenario ${scenarioStatus} (1/1): leased-channel-scenario`;
          if (scenarioStatus !== "fail") {
            expect(line).toBe(prefix);
            continue;
          }
          expect(line).toContain(
            outcome === "failed step"
              ? "Verify request: verification refused"
              : "verification refused",
          );
          expect(line).toContain("apiKey=<redacted>");
          expect(line).toContain(": :error::fixture");
          expect(line).not.toContain("synthetic-secret");
          expect(line).not.toContain("unrelated scenario metadata");
          expect(line).not.toMatch(/[\r\n]/u);
          expect(line.slice(prefix.length)).toMatch(/^ — /u);
          expect(line.slice(prefix.length + " — ".length).length).toBeLessThanOrEqual(512);
          expect(line.endsWith("…")).toBe(true);
          expect(Buffer.from(line).toString("utf8")).toBe(line);
        }
      };
      mocks.writeQaSuiteArtifacts.mockImplementationOnce(async () => {
        assertScenarioProgress(1);
        return {
          evidence: undefined,
          evidencePath: "/qa-output/qa-evidence.json",
          report: "",
          reportPath: "/qa-output/qa-suite-report.md",
          summaryPath: "/qa-output/qa-suite-summary.json",
        };
      });

      try {
        const result = await runQaFlowSuiteIsolated({ startLab }, context, runChild);
        assertScenarioProgress(2);
        expect(result.scenarios).toEqual([scenarioResult]);

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
    },
  );

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
