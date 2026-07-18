// Qa Lab tests cover suite plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { CRABLINE_SERVER_CHANNELS } from "@openclaw/crabline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME, QA_EVIDENCE_SUMMARY_KIND } from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import { qaSuiteProgressTesting, runQaFlowSuite } from "./suite.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const tempDirs = createTempDirHarness();

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
  await tempDirs.cleanup();
});

function makeQaSuiteTestLabHandle(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: {} as QaLabServerHandle["state"],
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(async () => ({}) as Awaited<ReturnType<QaLabServerHandle["runSelfCheck"]>>),
    stop: vi.fn(async () => {}),
  };
}

describe("qa suite", () => {
  it("runs the production cleanup plan in dependency order after a failure", async () => {
    const calls: string[] = [];
    const failure = new Error("transport close failed");
    const step = (name: string, error?: Error) => async () => {
      calls.push(name);
      if (error) {
        throw error;
      }
    };

    const errors = await qaSuiteProgressTesting.runQaFlowSuiteCleanupPlan({
      closeWebSessions: step("web sessions"),
      cleanupTransportBeforeGatewayStop: step("transport before gateway", failure),
      cleanupTransportAfterGatewayStop: step("transport after gateway"),
      stopGateway: step("gateway"),
      disposeAgentHarnesses: step("agent harnesses"),
      stopProvider: step("provider"),
      finishLab: step("lab"),
    });

    expect(calls).toEqual([
      "web sessions",
      "transport before gateway",
      "gateway",
      "transport after gateway",
      "agent harnesses",
      "provider",
      "lab",
    ]);
    expect(errors).toEqual([failure]);
  });

  it("keeps the primary suite error as the cause of aggregated cleanup failures", () => {
    const runError = new Error("gateway infrastructure failed");

    expect(() =>
      qaSuiteProgressTesting.throwQaSuiteCleanupErrors({
        cleanupErrors: [new Error("transport cleanup failed")],
        runFailed: true,
        runError,
      }),
    ).toThrow(expect.objectContaining({ cause: runError }));
  });

  it("does not release transport credentials when gateway teardown fails", async () => {
    const calls: string[] = [];
    const gatewayFailure = new Error("gateway remained alive");
    const step = (name: string, error?: Error) => async () => {
      calls.push(name);
      if (error) {
        throw error;
      }
    };

    const errors = await qaSuiteProgressTesting.runQaFlowSuiteCleanupPlan({
      cleanupTransportBeforeGatewayStop: step("transport before gateway"),
      cleanupTransportAfterGatewayStop: step("transport after gateway"),
      stopGateway: step("gateway", gatewayFailure),
      disposeAgentHarnesses: step("agent harnesses"),
      finishLab: step("lab"),
    });

    expect(calls).toEqual(["transport before gateway", "gateway", "agent harnesses", "lab"]);
    expect(errors).toEqual([gatewayFailure]);
  });

  it("rejects unsupported transport ids before starting the lab", async () => {
    const startLab = vi.fn();

    await expect(
      runQaFlowSuite({
        transportId: "qa-nope" as unknown as "qa-channel",
        startLab,
      }),
    ).rejects.toThrow("unsupported QA transport: qa-nope");

    expect(startLab).not.toHaveBeenCalled();
  });

  it("keeps metadata-only live channel drivers on the shared QA transport", async () => {
    const create = vi.fn();

    await expect(
      qaSuiteProgressTesting.createQaSuiteTransportAdapter({
        adapterFactories: [{ id: "telegram", matches: () => true, create }],
        channelDriver: "live",
        outputDir: "/tmp/qa-output",
        state: {} as QaLabServerHandle["state"],
        transportId: "qa-channel",
      }),
    ).resolves.toMatchObject({ adapter: { id: "qa-channel" } });

    expect(create).not.toHaveBeenCalled();
  });

  it("records live transport preparation as the first shared flow step", async () => {
    const prepareFlow = vi.fn(async () => {
      throw new Error("setup failed");
    });
    const scenario = makeQaSuiteTestScenario("matrix-preparation-failure", {
      channel: "matrix",
      config: { expected: "value" },
    });
    if (scenario.execution.kind !== "flow") {
      throw new Error("expected flow scenario");
    }
    scenario.execution.timeoutMs = 45_000;
    const env = {
      gateway: { baseUrl: "http://127.0.0.1:18789" },
      outputDir: "/tmp/qa-output",
      transport: { label: "Matrix live", prepareFlow },
    } as unknown as Parameters<typeof qaSuiteProgressTesting.createScenarioStepRunner>[0];
    const run = qaSuiteProgressTesting.createScenarioStepRunner(env, scenario, {});
    const scenarioStep = vi.fn(async () => "not reached");

    await expect(
      run("Matrix preparation", [{ name: "Scenario", run: scenarioStep }]),
    ).resolves.toEqual({
      name: "Matrix preparation",
      status: "fail",
      steps: [{ name: "Prepare Matrix live", status: "fail", details: "setup failed" }],
      details: "setup failed",
    });

    expect(prepareFlow).toHaveBeenCalledWith({
      config: { expected: "value" },
      gateway: env.gateway,
      outputDir: "/tmp/qa-output",
      timeoutMs: 45_000,
      waitForConfigRestartSettle: expect.any(Function),
    });
    expect(scenarioStep).not.toHaveBeenCalled();
  });

  it("uses a contributed live adapter when its channel is selected", async () => {
    const adapter = { id: "telegram" } as QaTransportAdapter;
    const create = vi.fn(async () => adapter);

    await expect(
      qaSuiteProgressTesting.createQaSuiteTransportAdapter({
        adapterFactories: [{ id: "telegram", matches: () => true, create }],
        channelDriver: "live",
        channelId: "telegram",
        outputDir: "/tmp/qa-output",
        transportPolicy: { requireGroupMention: true },
        state: {} as QaLabServerHandle["state"],
        transportId: "qa-channel",
      }),
    ).resolves.toMatchObject({ adapter });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterOptions: expect.objectContaining({
          transportPolicy: { requireGroupMention: true },
        }),
      }),
    );
  });

  it("preserves caller-supplied transport policy without scenario metadata", async () => {
    const adapter = { id: "telegram" } as QaTransportAdapter;
    const create = vi.fn(async () => adapter);

    await qaSuiteProgressTesting.createQaSuiteTransportAdapter({
      adapterFactories: [{ id: "telegram", matches: () => true, create }],
      adapterOptions: { transportPolicy: { topLevelReplies: true } },
      channelDriver: "live",
      channelId: "telegram",
      outputDir: "/tmp/qa-output",
      state: {} as QaLabServerHandle["state"],
      transportId: "qa-channel",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterOptions: { transportPolicy: { topLevelReplies: true } },
      }),
    );
  });

  it("parses progress env booleans", () => {
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("true")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("on")).toBe(true);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("false")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("off")).toBe(false);
    expect(qaSuiteProgressTesting.parseQaSuiteBooleanEnv("maybe")).toBeUndefined();
  });

  it("stops an owned lab when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      qaSuiteProgressTesting.waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: true,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung lab readiness request by the remaining startup deadline", async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ timeoutMs }: { timeoutMs: number }) =>
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("request timed out")), timeoutMs);
        }),
    );

    const readiness = qaSuiteProgressTesting.waitForQaLabReadyOrStopOwned({
      lab: {
        listenUrl: "http://127.0.0.1:43123",
        stop,
      },
      ownsLab: true,
      timeoutMs: 1_000,
    });
    const rejection = expect(readiness).rejects.toThrow(
      "timed out after 1000ms waiting for qa-lab ready",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves caller-owned labs running when readiness never becomes healthy", async () => {
    const stop = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: false },
      release: vi.fn(async () => {}),
    });

    await expect(
      qaSuiteProgressTesting.waitForQaLabReadyOrStopOwned({
        lab: {
          listenUrl: "http://127.0.0.1:43123",
          stop,
        },
        ownsLab: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out after 1ms waiting for qa-lab ready");
    expect(stop).not.toHaveBeenCalled();
  });

  it("defaults progress logging from CI when no override is set", () => {
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "true" })).toBe(true);
    expect(qaSuiteProgressTesting.shouldLogQaSuiteProgress({ CI: "false" })).toBe(false);
  });

  it("resolves transport-ready timeout from params and env", () => {
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {})).toBe(
      120_000,
    );
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "bad",
      }),
    ).toBe(120_000);
    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(undefined, {
          OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: value,
        }),
      ).toBe(120_000);
    }
    expect(qaSuiteProgressTesting.resolveQaSuiteTransportReadyTimeoutMs(90_000, {})).toBe(90_000);
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override and falls back on invalid values", () => {
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "true",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "false",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "on",
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "off",
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldLogQaSuiteProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "definitely",
      }),
    ).toBe(true);
  });

  it("sanitizes scenario ids for progress logs", () => {
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario-id")).toBe("scenario-id");
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("scenario\nid\tvalue")).toBe(
      "scenario id value",
    );
    expect(qaSuiteProgressTesting.sanitizeQaSuiteProgressValue("\u0000\u0001")).toBe("<empty>");
  });

  it("includes effective channel driver in run start progress logs", () => {
    expect(
      qaSuiteProgressTesting.formatQaSuiteRunStartProgress({
        selectedScenarioCount: 80,
        concurrency: 8,
        transportId: "qa-channel",
      }),
    ).toBe("run start: scenarios=80 concurrency=8 transport=qa-channel");

    expect(
      qaSuiteProgressTesting.formatQaSuiteRunStartProgress({
        selectedScenarioCount: 80,
        concurrency: 1,
        transportId: "qa-channel",
        channelDriverSelection: {
          capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          smokeArtifactPath: "crabline-fake-provider-smoke.json",
        },
      }),
    ).toBe(
      "run start: scenarios=80 concurrency=1 transport=qa-channel channelDriver=crabline channel=telegram",
    );
  });

  it("records gateway RSS peak and trace samples", () => {
    expect(
      qaSuiteProgressTesting.buildQaSuiteRuntimeMetrics({
        startedAt: new Date("2026-04-22T12:00:00.000Z"),
        finishedAt: new Date("2026-04-22T12:00:12.000Z"),
        gatewayProcessCpuStartMs: 1_000,
        gatewayProcessCpuEndMs: 4_000,
        gatewayProcessRssStartBytes: 100_000_000,
        gatewayProcessRssEndBytes: 125_000_000,
        gatewayProcessRssSamples: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:00.000Z",
            gatewayProcessRssBytes: 100_000_000,
          },
          {
            label: "scenario:canary:finish",
            at: "2026-04-22T12:00:10.000Z",
            gatewayProcessRssBytes: 140_000_000,
          },
        ],
        gatewayHeapSnapshots: [
          {
            label: "suite-start",
            at: "2026-04-22T12:00:01.000Z",
            path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
            bytes: 12_345,
          },
        ],
      }),
    ).toEqual({
      wallMs: 12_000,
      gatewayProcessCpuMs: 3_000,
      gatewayCpuCoreRatio: 0.25,
      gatewayProcessRssStartBytes: 100_000_000,
      gatewayProcessRssEndBytes: 125_000_000,
      gatewayProcessRssDeltaBytes: 25_000_000,
      gatewayProcessRssPeakBytes: 140_000_000,
      gatewayProcessRssPeakDeltaBytes: 40_000_000,
      gatewayProcessRssSamples: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:00.000Z",
          gatewayProcessRssBytes: 100_000_000,
        },
        {
          label: "scenario:canary:finish",
          at: "2026-04-22T12:00:10.000Z",
          gatewayProcessRssBytes: 140_000_000,
        },
      ],
      gatewayHeapSnapshots: [
        {
          label: "suite-start",
          at: "2026-04-22T12:00:01.000Z",
          path: "artifacts/gateway-heap-snapshots/suite-start.heapsnapshot",
          bytes: 12_345,
        },
      ],
    });
  });

  it("writes standalone evidence while keeping suite summary evidence-free", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-artifacts-");
    try {
      const artifacts = await qaSuiteProgressTesting.writeQaSuiteArtifacts({
        outputDir,
        startedAt: new Date("2026-04-11T00:00:00.000Z"),
        finishedAt: new Date("2026-04-11T00:01:00.000Z"),
        scenarios: [{ name: "Baseline", status: "pass", steps: [] }],
        scenarioDefinitions: [
          {
            ...makeQaSuiteTestScenario("baseline", {
              surface: "channel",
            }),
            coverage: {
              primary: ["channels.messages"],
            },
          },
        ],
        transport: {
          id: "qa-channel",
          createReportNotes: () => [],
        } as unknown as QaTransportAdapter,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        concurrency: 1,
      });

      expect(artifacts.evidencePath).toBe(path.join(outputDir, QA_EVIDENCE_FILENAME));
      const evidence = JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")) as {
        kind?: string;
        entries?: unknown[];
      };
      expect(evidence.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
      expect(evidence.entries).toHaveLength(1);
      const summary = JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8")) as {
        evidence?: unknown;
      };
      expect(summary.evidence).toBeUndefined();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("can return evidence without writing duplicate child evidence files", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-artifacts-memory-evidence-");
    try {
      const artifacts = await qaSuiteProgressTesting.writeQaSuiteArtifacts({
        outputDir,
        startedAt: new Date("2026-04-11T00:00:00.000Z"),
        finishedAt: new Date("2026-04-11T00:01:00.000Z"),
        scenarios: [{ name: "Baseline", status: "pass", steps: [] }],
        scenarioDefinitions: [makeQaSuiteTestScenario("baseline")],
        transport: {
          id: "qa-channel",
          createReportNotes: () => [],
        } as unknown as QaTransportAdapter,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        concurrency: 1,
        writeEvidenceFile: false,
      });

      expect(artifacts.evidence?.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
      await expect(fs.access(artifacts.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(artifacts.reportPath)).resolves.toBeUndefined();
      await expect(fs.access(artifacts.summaryPath)).resolves.toBeUndefined();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes the selected Crabline driver with an honest failed result", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-crabline-");
    try {
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: {
          ok: true,
          json: vi.fn(async () => ({
            ok: true,
            result: {
              is_bot: true,
              username: "crabline_bot",
            },
          })),
        },
        release: vi.fn(async () => {}),
      });

      const artifacts = await qaSuiteProgressTesting.writeQaSuiteArtifacts({
        outputDir,
        startedAt: new Date("2026-04-11T00:00:00.000Z"),
        finishedAt: new Date("2026-04-11T00:01:00.000Z"),
        scenarios: [
          {
            name: "Telegram DM",
            status: "fail",
            details: "active transport does not implement this scenario",
            steps: [],
          },
        ],
        scenarioDefinitions: [
          {
            ...makeQaSuiteTestScenario("telegram-dm", {
              surface: "channel",
            }),
            coverage: {
              primary: ["channels.dm"],
            },
          },
        ],
        transport: {
          id: "qa-channel",
          createReportNotes: () => [],
        } as unknown as QaTransportAdapter,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        concurrency: 1,
        channelDriverSelection: {
          capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          smokeArtifactPath: "crabline-fake-provider-smoke.json",
        },
      });

      const summary = JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8")) as {
        run?: {
          channelCapabilityMatrixPath?: string;
          channelDriverSmokePath?: string;
        };
      };
      const capabilityMatrixPath = summary.run?.channelCapabilityMatrixPath;
      const smokeArtifactPath = summary.run?.channelDriverSmokePath;
      if (typeof capabilityMatrixPath !== "string" || typeof smokeArtifactPath !== "string") {
        throw new Error("Crabline generation artifact paths missing from QA summary.");
      }
      const artifactGenerationDirectory = path.dirname(capabilityMatrixPath);
      expect(path.dirname(artifactGenerationDirectory)).toBe(".crabline-smoke-artifacts");
      expect(path.basename(artifactGenerationDirectory)).toMatch(/^generation-[^/\\]+$/u);
      expect(path.basename(capabilityMatrixPath)).toBe("crabline-fake-provider-capabilities.json");
      expect(path.dirname(smokeArtifactPath)).toBe(artifactGenerationDirectory);
      expect(path.basename(smokeArtifactPath)).toBe("crabline-fake-provider-smoke.json");
      const matrix = JSON.parse(
        await fs.readFile(path.resolve(outputDir, capabilityMatrixPath), "utf8"),
      ) as {
        report?: { result?: { selectedChannel?: string; supportedChannels?: string[] } };
      };
      expect(matrix.report?.result?.selectedChannel).toBe("telegram");
      expect(matrix.report?.result?.supportedChannels?.toSorted()).toEqual(
        [...CRABLINE_SERVER_CHANNELS].toSorted(),
      );
      const smoke = JSON.parse(
        await fs.readFile(path.resolve(outputDir, smokeArtifactPath), "utf8"),
      ) as { smoke?: { result?: { ok?: boolean; provider?: string } } };
      expect(smoke.smoke?.result).toMatchObject({ ok: true, provider: "telegram" });
      const evidence = JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")) as {
        entries?: Array<{
          execution?: { channel?: { driver?: string; id?: string } };
          result?: { failure?: { reason?: string }; status?: string };
        }>;
      };
      expect(evidence.entries?.[0]?.execution?.channel).toMatchObject({
        driver: "crabline",
        id: "telegram",
      });
      expect(evidence.entries?.[0]?.result).toMatchObject({
        failure: { reason: "active transport does not implement this scenario" },
        status: "fail",
      });
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses Crabline generation artifact paths without rewriting them", async () => {
    const outputDir = await tempDirs.makeTempDir("qa-suite-crabline-generation-");
    const capabilityMatrixPath = path.join(
      outputDir,
      ".crabline-smoke-artifacts",
      "generation-11111111-1111-4111-8111-111111111111",
      "capabilities.json",
    );
    const smokeArtifactPath = path.join(
      outputDir,
      ".crabline-smoke-artifacts",
      "generation-11111111-1111-4111-8111-111111111111",
      "smoke.json",
    );
    const providerReadinessArtifactPath = path.join(
      path.dirname(smokeArtifactPath),
      "provider-readiness.json",
    );
    await fs.mkdir(path.dirname(capabilityMatrixPath), { recursive: true });
    await fs.writeFile(capabilityMatrixPath, "authoritative capabilities\n", "utf8");
    await fs.writeFile(smokeArtifactPath, "authoritative smoke\n", "utf8");
    await fs.writeFile(providerReadinessArtifactPath, "authoritative provider readiness\n", "utf8");

    const artifacts = await qaSuiteProgressTesting.writeQaSuiteArtifacts({
      outputDir,
      startedAt: new Date("2026-07-12T00:00:00.000Z"),
      finishedAt: new Date("2026-07-12T00:01:00.000Z"),
      scenarios: [{ name: "Telegram DM", status: "pass", steps: [] }],
      scenarioDefinitions: [
        {
          ...makeQaSuiteTestScenario("telegram-dm", {
            surface: "channel",
          }),
          coverage: {
            primary: ["channels.dm"],
          },
        },
      ],
      transport: {
        id: "qa-channel",
        createReportNotes: () => [],
      } as unknown as QaTransportAdapter,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: true,
      concurrency: 1,
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-fake-provider-smoke.json",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      runCrablineChannelDriverSmoke: vi.fn(async () => ({
        artifactPointerPath: path.join(outputDir, ".crabline-smoke-artifacts", "current.json"),
        capabilityMatrixPath,
        capabilityReport: {},
        generation: "generation-11111111-1111-4111-8111-111111111111",
        manifestPath: path.join(
          outputDir,
          ".crabline-smoke-artifacts",
          "generation-11111111-1111-4111-8111-111111111111",
          "manifest.json",
        ),
        providerReadiness: {},
        providerReadinessArtifactPath,
        smoke: {},
        smokeArtifactPath,
      })),
    });

    await expect(fs.readFile(capabilityMatrixPath, "utf8")).resolves.toBe(
      "authoritative capabilities\n",
    );
    await expect(fs.readFile(smokeArtifactPath, "utf8")).resolves.toBe("authoritative smoke\n");
    await expect(fs.readFile(providerReadinessArtifactPath, "utf8")).resolves.toBe(
      "authoritative provider readiness\n",
    );
    await expect(
      fs.access(path.join(outputDir, "crabline-fake-provider-capabilities.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(outputDir, "crabline-fake-provider-smoke.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const evidence = JSON.parse(await fs.readFile(artifacts.evidencePath, "utf8")) as {
      entries?: Array<{ execution?: { artifacts?: Array<{ kind?: string; path?: string }> } }>;
    };
    expect(evidence.entries?.[0]?.execution?.artifacts).toEqual(
      expect.arrayContaining([
        { kind: "channel-capability-matrix", path: capabilityMatrixPath, source: "qa-suite" },
        { kind: "channel-driver-smoke", path: smokeArtifactPath, source: "qa-suite" },
      ]),
    );
    const summary = JSON.parse(await fs.readFile(artifacts.summaryPath, "utf8")) as {
      run?: {
        channelCapabilityMatrixPath?: string;
        channelDriverSmokePath?: string;
      };
    };
    expect(summary.run).toMatchObject({
      channelCapabilityMatrixPath: capabilityMatrixPath,
      channelDriverSmokePath: smokeArtifactPath,
    });
    expect(artifacts.report).toContain(`Generation capability filename: ${capabilityMatrixPath}.`);
    expect(artifacts.report).toContain(
      `Generation provider-readiness filename: ${providerReadinessArtifactPath}.`,
    );
    expect(artifacts.report).not.toContain("crabline-fake-provider-capabilities.json");
    expect(artifacts.report).not.toContain("crabline-fake-provider-smoke.json");
  });

  it("arms gateway heap checkpoint env only when requested", () => {
    expect(
      qaSuiteProgressTesting.buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "0",
      }),
    ).toBeUndefined();
    expect(
      qaSuiteProgressTesting.buildQaGatewayHeapCheckpointRuntimeEnvPatch({
        OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS: "1",
        NODE_OPTIONS: "--max-old-space-size=4096",
      }),
    ).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096 --heapsnapshot-signal=SIGUSR2",
    });
    expect(
      qaSuiteProgressTesting.mergeQaRuntimeEnvPatches(
        { OPENAI_API_KEY: "mock" },
        { NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2" },
      ),
    ).toEqual({
      OPENAI_API_KEY: "mock",
      NODE_OPTIONS: "--heapsnapshot-signal=SIGUSR2",
    });
  });

  it("builds a codex mock runtime env patch that stays on the QA mock provider", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "codex",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "codex",
      OPENCLAW_CODEX_APP_SERVER_ARGS:
        "app-server -c openai_base_url=http://127.0.0.1:44080/v1 --listen stdio://",
      OPENAI_API_KEY: "qa-mock-openai-key",
      CODEX_API_KEY: "qa-mock-openai-key",
    });
  });

  it("omits mock OpenAI rewiring for non-codex runtime overrides", () => {
    expect(
      qaSuiteProgressTesting.buildQaRuntimeEnvPatch({
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
        mockBaseUrl: "http://127.0.0.1:44080",
      }),
    ).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_QA_FORCE_RUNTIME: "openclaw",
    });
  });

  it("forwards run options into isolated scenario worker params", () => {
    const startLab = vi.fn();
    const adapterFactory = {
      id: "telegram",
      matches: vi.fn(() => true),
      create: vi.fn(),
    };
    const scenario = makeQaSuiteTestScenario("patched-control-ui", {
      surface: "control-ui",
      gatewayConfigPatch: {
        messages: {
          groupChat: {
            visibleReplies: "message_tool",
          },
        },
      },
    });
    const sutOpenClawCommand = {
      executablePath: "/usr/local/bin/openclaw-telegram-sut-launcher",
      usePackagedPlugins: true,
    };

    expect(
      qaSuiteProgressTesting.buildQaIsolatedScenarioWorkerParams({
        repoRoot: "/repo",
        outputDir: "/repo/.artifacts/qa-e2e/scenarios/patched-control-ui",
        providerMode: "mock-openai",
        transportId: "qa-channel",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        fastMode: true,
        scenario,
        startLab,
        input: {
          adapterFactories: [adapterFactory],
          channelId: "telegram",
          adapterOptions: { repoRoot: "/repo" },
          sutOpenClawCommand,
          thinkingDefault: "minimal",
          claudeCliAuthMode: "subscription",
          enabledPluginIds: ["acpx"],
          transportReadyTimeoutMs: 180_000,
          forcedRuntime: "codex",
          writeEvidenceFile: false,
        },
      }),
    ).toMatchObject({
      scenarioIds: ["patched-control-ui"],
      adapterFactories: [adapterFactory],
      channelId: "telegram",
      adapterOptions: { repoRoot: "/repo" },
      sutOpenClawCommand,
      concurrency: 1,
      startLab,
      controlUiEnabled: true,
      thinkingDefault: "minimal",
      claudeCliAuthMode: "subscription",
      enabledPluginIds: ["acpx"],
      transportReadyTimeoutMs: 180_000,
      forcedRuntime: "codex",
      writeEvidenceFile: false,
    });
  });

  it("enables Control UI only for Control UI scenarios unless explicitly overridden", () => {
    const channelScenario = makeQaSuiteTestScenario("channel-baseline", { surface: "channel" });
    const controlUiScenario = makeQaSuiteTestScenario("control-ui-roundtrip", {
      surface: "control-ui",
    });

    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        scenarios: [channelScenario],
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        scenarios: [channelScenario, controlUiScenario],
      }),
    ).toBe(true);
    expect(
      qaSuiteProgressTesting.resolveQaSuiteControlUiEnabled({
        explicit: true,
        scenarios: [channelScenario],
      }),
    ).toBe(true);
  });

  it("keeps caller-owned serial labs on shared workers without a launcher", () => {
    const scenarios = [
      makeQaSuiteTestScenario("baseline"),
      makeQaSuiteTestScenario("message-tool-mode", {
        gatewayConfigPatch: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
            },
          },
        },
      }),
    ];
    const lab = makeQaSuiteTestLabHandle();
    const startLab = vi.fn();

    expect(
      qaSuiteProgressTesting.shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
      }),
    ).toBe(false);
    expect(
      qaSuiteProgressTesting.shouldRunQaSuiteWithIsolatedScenarioWorkers({
        scenarios,
        concurrency: 1,
        lab,
        startLab,
      }),
    ).toBe(true);
  });

  it("remaps mock-openai model refs onto the app-server OpenAI provider for codex cells only", () => {
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        forcedRuntime: "codex",
      }),
    ).toBe("openai/gpt-5.6-luna");
    expect(
      qaSuiteProgressTesting.remapModelRefForForcedRuntime({
        modelRef: "mock-openai/gpt-5.6-luna",
        providerMode: "mock-openai",
        forcedRuntime: "openclaw",
      }),
    ).toBe("mock-openai/gpt-5.6-luna");
  });
});
