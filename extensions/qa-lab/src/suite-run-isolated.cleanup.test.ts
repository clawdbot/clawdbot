import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext, QaSuiteScenarioRunner } from "./suite-types.js";

const mocks = vi.hoisted(() => ({
  disposeRegisteredAgentHarnesses: vi.fn(async () => {}),
  fetchWithSsrFGuard: vi.fn(async () => ({
    response: new Response(null, { status: 204 }),
    release: vi.fn(async () => {}),
  })),
  startQaGatewayChild: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:18789",
    token: "qa-test-token",
    cfg: {},
    getProcessCpuMs: () => null,
    getProcessRssBytes: () => null,
    stop: vi.fn(async () => {}),
  })),
  writeQaSuiteArtifacts: vi.fn(async () => ({
    evidence: { kind: "test" },
    evidencePath: "/qa-output/qa-evidence.json",
    report: "",
    reportPath: "/qa-output/qa-suite-report.md",
    summaryPath: "/qa-output/qa-suite-summary.json",
  })),
}));
const tempRoots: string[] = [];

vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeRegisteredAgentHarnesses,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./gateway-child.js", () => ({
  startQaGatewayChild: mocks.startQaGatewayChild,
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
    gatewayConfigPatch: undefined,
    gatewayRuntimeOptions: undefined,
    concurrency: 1,
    progressEnabled: false,
    gatewayHeapCheckpointsEnabled: false,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })),
  );
});

describe("isolated QA suite transport cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disposeRegisteredAgentHarnesses.mockResolvedValue(undefined);
  });

  it("retains passing artifacts and finishes owned cleanup before reporting teardown failure", async () => {
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
    const runChild = vi.fn().mockResolvedValue(
      Object.freeze({
        evidence: { kind: "test" },
        complete: vi.fn(),
        result: {
          outputDir: "/qa-child",
          evidence: { kind: "test" },
          evidencePath: "/qa-child/qa-evidence.json",
          reportPath: "/qa-child/qa-suite-report.md",
          summaryPath: "/qa-child/qa-suite-summary.json",
          report: "",
          scenarios: [{ name: "leased-channel-scenario", status: "pass", steps: [] }],
          startedScenarioIds: ["leased-channel-scenario"],
          watchUrl: lab.baseUrl,
        },
      }),
    );
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
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: agent harnesses: agent harness disposal failed",
    );
    expect((thrown as Error).message).toContain(
      "retained artifacts: output=/qa-output report=/qa-output/qa-suite-report.md summary=/qa-output/qa-suite-summary.json",
    );
    expect((thrown as Error).message).not.toContain(" evidence=");
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(stderrWrite.mock.calls.flat().join("")).not.toContain("run complete");
    stderrWrite.mockRestore();
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
    const runChild = async (childParams: Parameters<typeof runQaFlowSuiteStandard>[0]) => {
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
      const completion = await runQaFlowSuiteIsolated({ startLab }, context, runChild);
      await completion.complete();

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

  it("leaves isolated publication state untouched when evidence writing is disabled", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-isolated-no-evidence-"));
    tempRoots.push(repoRoot);
    const outputDir = path.join(repoRoot, "output");
    const canonicalPath = path.join(outputDir, "qa-evidence.json");
    const lockPath = `${canonicalPath}.lock`;
    const stagedPath = path.join(outputDir, ".qa-evidence.json.preseed.staged");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(canonicalPath, "canonical\n", "utf8");
    await fs.writeFile(lockPath, "lock\n", "utf8");
    await fs.writeFile(stagedPath, "staged\n", "utf8");
    const lab = createCleanupTestLab();
    const context = createCleanupTestContext();
    context.repoRoot = repoRoot;
    context.outputDir = outputDir;
    context.channelDriver = undefined;
    const runChild = vi.fn().mockResolvedValue(
      Object.freeze({
        evidence: { kind: "test" },
        complete: vi.fn(),
        result: {
          outputDir: path.join(outputDir, "child"),
          evidence: { kind: "test" },
          evidencePath: path.join(outputDir, "child", "qa-evidence.json"),
          reportPath: path.join(outputDir, "child", "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "child", "qa-suite-summary.json"),
          report: "",
          scenarios: [{ name: "leased-channel-scenario", status: "pass", steps: [] }],
          startedScenarioIds: ["leased-channel-scenario"],
          watchUrl: lab.baseUrl,
        },
      }),
    );

    const completion = await runQaFlowSuiteIsolated(
      { startLab: async () => lab, writeEvidenceFile: false },
      context,
      runChild,
    );
    await completion.complete();

    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("canonical\n");
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("lock\n");
    await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("staged\n");
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
      const runChild = vi.fn();

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
